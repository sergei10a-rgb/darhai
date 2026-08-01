/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Loopback endpoint that lets a SPAWNED MCP subprocess reach the gate.
 *
 * Deliberately the same shape as `PersonalDataMcpServer`: 127.0.0.1 only, an
 * ephemeral port, length-prefixed framing from `tcpHelpers`, and a per-boot
 * bearer token compared in constant time. That server's module comment carries
 * the full reasoning for the design; the differences here are only these two:
 *
 *  1. **It answers slowly on purpose.** A personal-data read is a local SELECT;
 *     this call blocks until a human presses a button, so the socket has no
 *     idle timeout of its own. The service's own timeout is the only deadline,
 *     and it produces a DENIAL rather than a dropped socket.
 *  2. **A dropped socket is not an approval.** If the caller disappears
 *     mid-wait we still let the dialog settle normally and simply fail to
 *     write the answer anywhere. Nothing downstream can read consent out of a
 *     closed connection.
 *
 * On the token's blast radius: it is placed in `process.env` of the main
 * process (see `toolConfirmationSingleton.ts`) so every child inherits it. The
 * capability it grants is "make Дархай show the user a dialog and tell me what
 * they pressed" - it grants no ability to approve anything, and the answer is
 * always the human's. Do not widen the bind address, and do not add a bypass.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { createTcpMessageReader, writeTcpMessage } from '@process/team/mcp/tcpHelpers';
import type { ToolConfirmationService } from './ToolConfirmationService';
import { denied, type ToolConfirmationOutcome, type ToolConfirmationRequestInput } from './types';

/** What a spawned bridge needs in its env to reach this server. */
export type ToolConfirmationRuntime = { port: number; token: string };

type GateTcpRequest = {
  auth_token?: string;
  request?: Partial<ToolConfirmationRequestInput>;
};

export class ToolConfirmationTcpServer {
  private tcpServer: net.Server | null = null;
  private port = 0;
  private readonly authToken = crypto.randomUUID();
  private readonly service: ToolConfirmationService;

  constructor(service: ToolConfirmationService) {
    this.service = service;
  }

  async start(): Promise<ToolConfirmationRuntime> {
    if (this.tcpServer) return this.getRuntime();

    const server = net.createServer((socket) => this.handleConnection(socket));
    this.tcpServer = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.tcpServer = null;
        reject(err);
      };
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
        resolve();
      });
    });

    return this.getRuntime();
  }

  async stop(): Promise<void> {
    const server = this.tcpServer;
    this.tcpServer = null;
    this.port = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getRuntime(): ToolConfirmationRuntime {
    return { port: this.port, token: this.authToken };
  }

  private handleConnection(socket: net.Socket): void {
    const reader = createTcpMessageReader(
      (msg) => {
        void this.handleMessage(socket, msg as GateTcpRequest);
      },
      {
        onError: (err) => {
          console.warn(`[ToolConfirmationTcpServer] TCP framing error: ${err.message}`);
          socket.destroy();
        },
      }
    );

    socket.on('data', reader);
    socket.on('error', () => socket.destroy());
    // No socket.setTimeout here: the whole point of this call is to wait for a
    // person. The service owns the deadline and answers with a denial.
  }

  private async handleMessage(socket: net.Socket, message: GateTcpRequest): Promise<void> {
    if (!this.tokenMatches(message.auth_token)) {
      writeTcpMessage(socket, { error: 'Unauthorized' });
      socket.end();
      return;
    }

    const outcome = await this.confirm(message.request);
    // `writable` guards the case where the caller went away while the user was
    // still reading. Losing the answer is fine; inventing one is not.
    if (socket.writable) writeTcpMessage(socket, { outcome });
    socket.end();
  }

  private async confirm(raw: Partial<ToolConfirmationRequestInput> | undefined): Promise<ToolConfirmationOutcome> {
    if (!raw || typeof raw !== 'object') {
      return denied('', 'invalid-request', 'The confirmation request was empty, so nothing was done.');
    }
    return this.service.requestUserConfirmation({
      kind: String(raw.kind ?? ''),
      toolName: String(raw.toolName ?? ''),
      title: String(raw.title ?? ''),
      summary: String(raw.summary ?? ''),
      confirmLabel: String(raw.confirmLabel ?? ''),
      fingerprint: String(raw.fingerprint ?? ''),
      details: Array.isArray(raw.details)
        ? raw.details.map((detail) => ({ label: String(detail?.label ?? ''), value: String(detail?.value ?? '') }))
        : [],
    });
  }

  /**
   * Constant-time compare: the token is a bearer secret and both sides are
   * fixed-length UUIDs, so an early-exit `!==` would leak it byte by byte to
   * any local process willing to probe the port.
   */
  private tokenMatches(candidate: string | undefined): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate, 'utf-8');
    const b = Buffer.from(this.authToken, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
