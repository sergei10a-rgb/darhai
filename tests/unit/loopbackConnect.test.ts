/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression guard for the loopback connect retry.
 *
 * The MCP stdio bridges open a fresh loopback connection per request. On a host
 * whose Windows ephemeral port range starts at 1024 (`netsh int ipv4 show
 * dynamicport tcp` on this machine: start 1024, 64511 ports, against a default
 * of 49152/16384) the client pool overlaps every server port, so a
 * `(127.0.0.1:client -> 127.0.0.1:server)` 4-tuple gets re-used while the
 * previous one is still live or in TIME_WAIT and the kernel refuses it. That is
 * a transport failure, not a server failure, and it used to surface as a hard
 * error from `sendTcpRequest`.
 *
 * These tests do NOT fake the failure. Every "failed attempt" below is a real
 * `EADDRINUSE` (or equivalent) produced by the operating system, by binding the
 * attempt to a local port that already forms the exact same 4-tuple as a
 * connection this test is holding open. The injected `createConnection` seam
 * only chooses the local port; the error comes from the kernel.
 *
 * The property that matters most is the last test: a retried CONNECT must never
 * become a retried REQUEST. Some peers on this transport do replay detection or
 * single-use token checks, so a second delivery would be a correctness bug that
 * is far worse than the transient failure being papered over.
 */
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import * as net from 'node:net';
import {
  connectLoopback,
  isRetryableConnectError,
  LOOPBACK_HOST,
  RETRYABLE_CONNECT_CODES,
} from '../../src/process/team/mcp/loopbackConnect';
import { createTcpMessageReader, sendTcpRequest, writeTcpMessage } from '../../src/process/team/mcp/tcpHelpers';

/** Everything this file opened, torn down after each test. */
const openSockets: net.Socket[] = [];
const openServers: net.Server[] = [];

function track<T extends net.Socket>(socket: T): T {
  openSockets.push(socket);
  return socket;
}

async function listen(handler?: (socket: net.Socket) => void): Promise<number> {
  const server = handler ? net.createServer(handler) : net.createServer();
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, () => resolve()));
  return (server.address() as net.AddressInfo).port;
}

/**
 * Open a connection and keep it open, so its `(localPort -> port)` 4-tuple is
 * occupied for as long as this test needs it. Returns the local port, which is
 * the one a later attempt must collide with.
 */
async function holdTuple(port: number): Promise<number> {
  const socket = track(net.connect({ port, host: LOOPBACK_HOST }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const localPort = socket.localPort;
  if (!localPort) throw new Error('held socket reported no local port');
  return localPort;
}

beforeEach(() => {
  // The helper logs every retry; keep the suite output readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('connectLoopback', () => {
  test('recovers from a REAL colliding-4-tuple connect failure on the next attempt', async () => {
    const port = await listen();
    const collidingLocalPort = await holdTuple(port);

    const attempts: number[] = [];
    const errors: string[] = [];
    const socket = track(
      await connectLoopback(port, {
        retryDelayMs: 0,
        createConnection: (options, attempt) => {
          attempts.push(attempt);
          // Attempt 1 asks the kernel for the exact tuple that is already in
          // use. Attempt 2 takes a fresh ephemeral port, like production does.
          const created =
            attempt === 1 ? net.connect({ ...options, localPort: collidingLocalPort }) : net.connect(options);
          created.once('error', (err: NodeJS.ErrnoException) => errors.push(err.code ?? err.message));
          return created;
        },
      })
    );

    expect(attempts, 'the first attempt must have failed and been retried').toEqual([1, 2]);
    expect(
      RETRYABLE_CONNECT_CODES.has(errors[0]),
      `attempt 1 failed with "${errors[0]}", which is not in the retryable set`
    ).toBe(true);
    expect(socket.remotePort).toBe(port);
    expect(socket.destroyed).toBe(false);
  });

  test('gives up after the configured number of attempts and reports the real error', async () => {
    const port = await listen();
    const collidingLocalPort = await holdTuple(port);

    const attempts: number[] = [];
    await expect(
      connectLoopback(port, {
        attempts: 2,
        retryDelayMs: 0,
        createConnection: (options, attempt) => {
          attempts.push(attempt);
          return net.connect({ ...options, localPort: collidingLocalPort });
        },
      })
    ).rejects.toMatchObject({ code: expect.any(String) });

    expect(attempts).toEqual([1, 2]);
  });

  test('does NOT retry ECONNREFUSED - a closed port is an answer, not a lost packet', async () => {
    // Bind then close, so the port is known-free rather than guessed at.
    const port = await listen();
    await new Promise<void>((resolve) => openServers[0].close(() => resolve()));
    openServers.length = 0;

    const attempts: number[] = [];
    await expect(
      connectLoopback(port, {
        retryDelayMs: 0,
        createConnection: (options, attempt) => {
          attempts.push(attempt);
          return net.connect(options);
        },
      })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    expect(attempts, 'ECONNREFUSED must fail immediately, not after three slow attempts').toEqual([1]);
  });

  test('classifies transport failures without treating a refusal as one', () => {
    expect(isRetryableConnectError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRetryableConnectError(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(isRetryableConnectError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isRetryableConnectError(new Error('no code at all'))).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
  });
});

describe('sendTcpRequest', () => {
  /** A framed-JSON echo server that records every request body it received. */
  async function echoServer(received: unknown[]): Promise<number> {
    return listen((socket) => {
      socket.on(
        'data',
        createTcpMessageReader((msg) => {
          received.push(msg);
          writeTcpMessage(socket, { result: 'ok' });
        })
      );
    });
  }

  test('survives a real connect failure and still delivers the request EXACTLY once', async () => {
    const received: unknown[] = [];
    const port = await echoServer(received);
    const collidingLocalPort = await holdTuple(port);

    const attempts: number[] = [];
    const response = await sendTcpRequest<{ result?: string }>(
      port,
      { tool: 'read_notes', args: {} },
      {
        timeoutMs: 5_000,
        connect: {
          retryDelayMs: 0,
          createConnection: (options, attempt) => {
            attempts.push(attempt);
            return attempt === 1 ? net.connect({ ...options, localPort: collidingLocalPort }) : net.connect(options);
          },
        },
      }
    );

    expect(attempts, 'the connect must have been retried for this test to mean anything').toEqual([1, 2]);
    expect(response.result).toBe('ok');
    expect(received, 'a retried CONNECT must never become a retried REQUEST').toEqual([
      { tool: 'read_notes', args: {} },
    ]);
  });

  test('delivers nothing when every connect attempt fails', async () => {
    const received: unknown[] = [];
    const port = await echoServer(received);
    const collidingLocalPort = await holdTuple(port);

    await expect(
      sendTcpRequest(
        port,
        { tool: 'read_notes', args: {} },
        {
          timeoutMs: 5_000,
          connect: {
            attempts: 2,
            retryDelayMs: 0,
            createConnection: (options) => net.connect({ ...options, localPort: collidingLocalPort }),
          },
        }
      )
    ).rejects.toBeInstanceOf(Error);

    expect(received).toEqual([]);
  });

  test('still answers a normal request when nothing goes wrong', async () => {
    const received: unknown[] = [];
    const port = await echoServer(received);

    await expect(sendTcpRequest<{ result?: string }>(port, { ping: true }, { timeoutMs: 5_000 })).resolves.toEqual({
      result: 'ok',
    });
    expect(received).toEqual([{ ping: true }]);
  });
});
