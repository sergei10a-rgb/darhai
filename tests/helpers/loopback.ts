/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loopback connect helpers for tests that talk to a server they just started.
 *
 * The retry itself is NOT defined here any more. It used to be a test-only
 * copy, which meant production shipped without the guard the test lane needed:
 * the same host conditions that made these tests fail (see `loopbackConnect.ts`
 * for the full diagnosis - a Windows ephemeral port range starting at 1024, so
 * client and server pools overlap and a TIME_WAIT 4-tuple reuse is refused)
 * apply verbatim to the app's own loopback MCP bridges.
 *
 * `connectLoopback` is therefore re-exported from `src/`, so tests exercise the
 * exact code the product runs. Only connection *establishment* is retried - the
 * request, the response and every assertion still happen exactly once, so a
 * genuinely broken server still fails (its ECONNREFUSED is not retryable).
 */
import * as http from 'node:http';
import {
  connectLoopback,
  LOOPBACK_HOST,
  type ConnectLoopbackOptions,
} from '../../src/process/team/mcp/loopbackConnect';

export { connectLoopback, LOOPBACK_HOST };
export type { ConnectLoopbackOptions };

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
