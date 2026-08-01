/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loopback connect helpers for tests that talk to a server they just started.
 *
 * Why this exists
 * ---------------
 * Tests here bind an ephemeral port, connect to it, and assert on the answer.
 * That connect intermittently failed with `Error: connect ETIMEDOUT
 * 127.0.0.1:<port>` - every test in a file failing at once, then the same file
 * passing untouched on the next run. It was never the code under test: the
 * server was listening, and a standalone probe doing 600 listen/connect pairs
 * on the same host while the suite ran did not drop a single connection.
 *
 * Two things go wrong, and both are about the host rather than the server:
 *
 *  1. **4-tuple collisions.** This machine's Windows dynamic port range is
 *     configured as 1024-65534 (`netsh int ipv4 show dynamicport tcp`), so
 *     listeners and clients share one pool that a full run cycles through fast.
 *     Reusing a (127.0.0.1:client -> 127.0.0.1:server) tuple that is still in
 *     TIME_WAIT is refused outright - directly reproducible on this host, where
 *     a deliberate reuse returns EADDRINUSE and the very next attempt, on a
 *     fresh client port, connects.
 *  2. **A starved event loop.** A fork that does not get scheduled for several
 *     seconds cannot dispatch its own `connect` event either, so any tight
 *     deadline reports a connection that the kernel already completed as a
 *     timeout. Hence the deliberately generous per-attempt budget below.
 *
 * Only connection *establishment* is retried - the request, the response and
 * every assertion still happen exactly once, so a genuinely broken server still
 * fails (its ECONNREFUSED is not retryable).
 */
import * as http from 'node:http';
import * as net from 'node:net';

export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Per-attempt connect budget.
 *
 * Generous on purpose. This timer measures the *test process's event loop*, not
 * the network: a vitest worker that is starved for several seconds cannot
 * dispatch the socket's `connect` event either, so a tight budget reports a
 * connection that actually succeeded as ETIMEDOUT. Ten seconds is still half
 * the OS's own ~21 s SYN give-up, so a genuinely dropped SYN is retried with a
 * fresh client port well before the kernel would have surfaced it.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** Total attempts, including the first. */
const CONNECT_ATTEMPTS = 3;

/**
 * Failures that mean "the packet was lost / the tuple was refused by the
 * stack", not "nothing is listening there".
 *
 * `ECONNREFUSED` is deliberately absent: it is the answer a closed port gives,
 * and retrying it would turn a real "the server never started" bug into a
 * timeout several seconds later.
 */
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EADDRINUSE', 'ENETRESET']);

function connectOnce(port: number, host: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ port, host });
    let settled = false;

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onTimeout = (): void => {
      const err: NodeJS.ErrnoException = new Error(`connect ETIMEDOUT ${host}:${port} after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      onError(err);
    };
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Hand the caller a socket with no inactivity deadline of ours.
      socket.setTimeout(0);
      resolve(socket);
    };
    function cleanup(): void {
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('connect', onConnect);
    }

    socket.once('error', onError);
    socket.once('connect', onConnect);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

export type ConnectLoopbackOptions = {
  host?: string;
  attempts?: number;
  timeoutMs?: number;
};

/**
 * Connect to `port` on loopback, retrying a dropped SYN.
 *
 * Resolves an already-connected socket with none of this helper's listeners
 * still attached, so the caller wires up `data` / `error` / `end` exactly as it
 * would after a bare `net.connect`.
 */
export async function connectLoopback(port: number, options: ConnectLoopbackOptions = {}): Promise<net.Socket> {
  const host = options.host ?? LOOPBACK_HOST;
  const attempts = options.attempts ?? CONNECT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await connectOnce(port, host, timeoutMs);
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code)) throw err;
    }
  }
  throw lastError;
}

export type LoopbackHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type LoopbackHttpOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  port: number;
  headers?: Record<string, string | number>;
  body?: string;
  connect?: ConnectLoopbackOptions;
};

/**
 * Issue exactly one HTTP request over a loopback socket obtained through
 * {@link connectLoopback}.
 *
 * The retry lives in the socket, not the request: `createConnection` hands
 * `http` a socket that is already established, so a replay-detection test still
 * sees a single delivery of its payload no matter how many SYNs were dropped
 * getting there.
 */
export async function loopbackHttpRequest(options: LoopbackHttpOptions): Promise<LoopbackHttpResponse> {
  const socket = await connectLoopback(options.port, options.connect);

  return new Promise<LoopbackHttpResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: LOOPBACK_HOST,
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
        // `agent` must stay ABSENT, not `false`: `agent: false` makes
        // ClientRequest build a fresh Agent, and an Agent ignores
        // `options.createConnection` in favour of its own - the request then
        // dials a second socket and hangs waiting on the one we handed it.
        // With no agent at all, ClientRequest uses this socket directly and
        // sends `Connection: close`, so the server closes cleanly afterwards.
        createConnection: () => socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) headers[key] = value.join('; ');
            else if (typeof value === 'string') headers[key] = value;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
