/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Retry-on-connect for loopback TCP clients.
 *
 * Why this exists
 * ---------------
 * Every loopback client in this app (the team / team-guide / personal-data MCP
 * stdio bridges) opens a fresh connection per request. That `connect`
 * intermittently fails on a busy host with `ETIMEDOUT 127.0.0.1:<port>` or
 * `EADDRINUSE`, while the server is demonstrably listening and a standalone
 * probe doing hundreds of listen/connect pairs never drops one.
 *
 * Two host-level causes, neither of them the server's fault:
 *
 *  1. **4-tuple collisions.** Windows' dynamic port range is configurable, and
 *     on a machine where it starts at 1024 (`netsh int ipv4 show dynamicport
 *     tcp`) the ephemeral pool overlaps every server port and gets cycled
 *     through fast. Re-using a `(127.0.0.1:client -> 127.0.0.1:server)` tuple
 *     that is still in TIME_WAIT is refused outright - directly reproducible,
 *     and the very next attempt on a fresh client port connects.
 *  2. **A starved event loop.** A process that is not scheduled for several
 *     seconds cannot dispatch its own `connect` event either, so a tight
 *     deadline reports as a timeout a connection the kernel already completed.
 *     Hence the deliberately generous per-attempt budget.
 *
 * What is and is NOT retried
 * --------------------------
 * Only connection ESTABLISHMENT. The request, the response and every side
 * effect still happen exactly once on the socket this helper hands back, so a
 * caller whose peer does replay detection or single-use CSRF cannot double-
 * deliver no matter how many SYNs were dropped getting there. Callers must
 * never wrap a whole request in a retry loop built on this module.
 *
 * `ECONNREFUSED` is deliberately NOT retryable: it is the answer a closed port
 * gives, and retrying it would turn "the server never started" into a timeout
 * several seconds later instead of an immediate, accurate failure.
 */
import * as net from 'node:net';

/** The only host these bridges ever dial. */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Per-attempt connect budget.
 *
 * Generous on purpose: this timer measures the CALLING process's event loop,
 * not the network. Ten seconds is still half the OS's own ~21s SYN give-up, so
 * a genuinely dropped SYN is retried from a fresh client port well before the
 * kernel would have surfaced it.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Total connect attempts, including the first. */
export const CONNECT_ATTEMPTS = 3;

/**
 * Pause between attempts. Short - the failure mode is a stalled SYN or a
 * refused tuple, not load, and each retry picks a fresh ephemeral port anyway.
 */
export const CONNECT_RETRY_DELAY_MS = 250;

/**
 * Failures that mean "the packet was lost / the tuple was refused by the
 * stack", not "nothing is listening there".
 */
export const RETRYABLE_CONNECT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ENETRESET',
]);

/**
 * How one attempt opens its socket.
 *
 * An injectable seam (same pattern as `RuntimeProcessControlDeps` in the
 * OmniRoute runtime) so a test can force a REAL kernel-level connect failure -
 * e.g. by binding the attempt to a local port that already forms the same
 * 4-tuple - instead of faking the error. Production never passes it.
 */
export type LoopbackSocketFactory = (options: { host: string; port: number }, attempt: number) => net.Socket;

export type ConnectLoopbackOptions = {
  host?: string;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  createConnection?: LoopbackSocketFactory;
};

/** True when `error` is a transport-level connect failure worth retrying. */
export function isRetryableConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_CONNECT_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

const defaultFactory: LoopbackSocketFactory = (options) => net.connect(options);

/** One connect attempt. Resolves an established socket carrying none of our listeners. */
function connectOnce(
  port: number,
  host: string,
  timeoutMs: number,
  createConnection: LoopbackSocketFactory,
  attempt: number
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    let socket: net.Socket;
    try {
      socket = createConnection({ host, port }, attempt);
    } catch (err) {
      // A synchronous throw from bind()/connect() (EADDRINUSE surfaces this way
      // on some platforms) must be classified like an emitted error, not escape.
      reject(err);
      return;
    }

    let settled = false;

    const cleanup = (): void => {
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('connect', onConnect);
    };
    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }
    function onTimeout(): void {
      const err: NodeJS.ErrnoException = new Error(`connect ETIMEDOUT ${host}:${port} after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      onError(err);
    }
    function onConnect(): void {
      if (settled) return;
      settled = true;
      cleanup();
      // Hand the caller a socket with no inactivity deadline of ours; it owns
      // the request timeout from here.
      socket.setTimeout(0);
      resolve(socket);
    }

    socket.once('error', onError);
    socket.once('connect', onConnect);
    socket.setTimeout(timeoutMs, onTimeout);
  });
}

/**
 * Connect to `port` on loopback, retrying a dropped or refused SYN.
 *
 * Resolves an ALREADY-CONNECTED socket with none of this helper's listeners
 * attached, so the caller wires up `data` / `error` / `end` exactly as it would
 * after a bare `net.connect` - and sends its request exactly once.
 */
export async function connectLoopback(port: number, options: ConnectLoopbackOptions = {}): Promise<net.Socket> {
  const host = options.host ?? LOOPBACK_HOST;
  const attempts = options.attempts ?? CONNECT_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? CONNECT_RETRY_DELAY_MS;
  const createConnection = options.createConnection ?? defaultFactory;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await connectOnce(port, host, timeoutMs, createConnection, attempt);
    } catch (err) {
      lastError = err;
      if (!isRetryableConnectError(err)) throw err;
      console.warn(
        `[loopback] connect attempt ${attempt}/${attempts} to ${host}:${port} failed ` +
          `(${(err as NodeJS.ErrnoException).code}); retrying on a fresh client port`
      );
      // eslint-disable-next-line no-await-in-loop
      if (attempt < attempts && retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
  throw lastError;
}
