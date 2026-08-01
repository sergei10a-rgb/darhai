/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process host for the `darhai-personal-data` MCP tools.
 *
 * Why the tool bodies do NOT live in the spawned subprocess, unlike
 * `builtin-mcp-search-skills.js`:
 *
 *  1. **One SQLite connection.** Calendar, notes and documents live in
 *     `wayland.db`, which the main process holds open. A second process opening
 *     the same file would go through `DarhaiUIDatabase.create()`, which runs
 *     schema init, migrations, and - on an error it reads as corruption -
 *     RENAMES the database aside and starts fresh. Handing that code path to a
 *     short-lived child spawned once per agent session is a data-loss risk with
 *     no upside.
 *  2. **No reimplementation.** Running here lets the handlers call
 *     `calendarService.list` (recurrence expansion) and
 *     `IjfwArchiveService.listEntries` (memory search) verbatim, rather than
 *     growing a second, drifting copy of each.
 *  3. **Identity.** `getOrCreateSystemUser()` is main-process state; the child
 *     cannot resolve it without re-opening the database.
 *
 * So the child is a thin bridge. This class is the loopback TCP endpoint it
 * talks to - the same shape `TeamGuideMcpServer` already uses in production,
 * including its length-prefixed framing and per-boot bearer token.
 *
 * Local-only: bound to 127.0.0.1, on an ephemeral port, guarded by a random
 * per-boot token that reaches spawned children through their env. Nothing here
 * is reachable from a paired device or the WebUI - those speak the IPC bridge,
 * whose `local-user.get` is in `REMOTE_DENIED_KEYS` precisely so a remote
 * caller cannot act as the host profile.
 *
 * On the token's blast radius: it is persisted in `mcp.config` (the spawn env),
 * which `agent.config.storage.get` will hand a paired-device caller - the same
 * blob that already carries the web-search and image-generation API keys. That
 * disclosure grants no new capability here, because the token is only usable by
 * a process that can open a socket to this host's LOOPBACK interface, and any
 * such process can already read `wayland.db` off disk directly. A remote paired
 * device cannot reach 127.0.0.1 on the host at all. Do not "improve" this by
 * widening the bind address.
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { writeTcpMessage, createTcpMessageReader } from '@process/team/mcp/tcpHelpers';
import { callPersonalDataTool } from './personalDataHandlers';

/** Idle socket lifetime. Requests here are short reads; 60s is generous. */
const SOCKET_IDLE_TIMEOUT_MS = 60_000;

/** What a spawned bridge needs in its env to reach this server. */
export type PersonalDataMcpRuntime = {
  port: number;
  token: string;
};

type PersonalDataTcpRequest = {
  tool?: string;
  args?: Record<string, unknown>;
  auth_token?: string;
};

export class PersonalDataMcpServer {
  private tcpServer: net.Server | null = null;
  private port = 0;
  private readonly authToken = crypto.randomUUID();

  /** Start listening on an ephemeral loopback port. */
  async start(): Promise<PersonalDataMcpRuntime> {
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

  getRuntime(): PersonalDataMcpRuntime {
    return { port: this.port, token: this.authToken };
  }

  private handleConnection(socket: net.Socket): void {
    const reader = createTcpMessageReader(
      (msg) => {
        void this.handleMessage(socket, msg as PersonalDataTcpRequest);
      },
      {
        onError: (err) => {
          console.warn(`[PersonalDataMcpServer] TCP framing error: ${err.message}`);
          socket.destroy();
        },
      }
    );

    socket.on('data', reader);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
  }

  private async handleMessage(socket: net.Socket, request: PersonalDataTcpRequest): Promise<void> {
    // Constant-time compare: the token is a bearer secret and both sides are
    // fixed-length UUIDs, so an early-exit `!==` would leak it byte by byte to
    // any local process willing to probe the port.
    if (!this.tokenMatches(request.auth_token)) {
      writeTcpMessage(socket, { error: 'Unauthorized' });
      socket.end();
      return;
    }

    try {
      const result = await callPersonalDataTool(request.tool ?? '', request.args ?? {});
      writeTcpMessage(socket, { result: JSON.stringify(result, null, 2) });
    } catch (err) {
      writeTcpMessage(socket, { error: err instanceof Error ? err.message : String(err) });
    }
    socket.end();
  }

  private tokenMatches(candidate: string | undefined): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate, 'utf-8');
    const b = Buffer.from(this.authToken, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
