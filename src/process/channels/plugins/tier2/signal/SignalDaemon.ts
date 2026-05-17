/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * SignalDaemon — long-lived signal-cli subprocess with JSON-RPC over stdio,
 * auto-restart on unexpected exit (5s → 60s backoff, max 5 attempts).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { execFileNoThrow } from '@/utils/execFileNoThrow';

// ── Types ────────────────────────────────────────────────────────────────────

export type SignalDaemonStatus = 'stopped' | 'starting' | 'running' | 'error';

export type SignalDaemonOpts = {
  /** E.164 phone number registered with Signal, e.g. "+14155551234". */
  phoneNumber: string;
  /** signal-cli data directory (default: <userData>/signal). */
  configDir?: string;
  /** signal-cli binary path. Falls back to bundled runtime, then PATH. */
  cliPath?: string;
  /** HTTP host for the JSON-RPC daemon endpoint (default: 127.0.0.1). */
  httpHost?: string;
  /** HTTP port for the JSON-RPC daemon endpoint (default: 8080). */
  httpPort?: number;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcFrame = JsonRpcResponse | JsonRpcNotification;

/** Emitted for every inbound Signal message. */
export type SignalInboundMessage = {
  envelope: {
    source?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      timestamp?: number;
      groupInfo?: { groupId?: string; type?: string };
      reaction?: { emoji?: string; targetSentTimestamp?: number; targetAuthorUuid?: string; isRemove?: boolean };
    };
    receiptMessage?: unknown;
    typingMessage?: unknown;
  };
};

export type SignalMessageHandler = (msg: SignalInboundMessage) => void;

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_FACTOR = 2;
const MAX_RESTART_ATTEMPTS = 5;

// ── Binary resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the signal-cli binary path.
 *
 * Priority:
 *  1. Explicit cliPath from opts.
 *  2. Bundled runtime in packaged Electron build (extraResources).
 *  3. Bundled runtime relative to source tree (dev).
 *  4. "signal-cli" on PATH (fallback — fails gracefully if absent).
 */
export function resolveSignalCliPath(cliPath?: string): string {
  if (cliPath?.trim()) return cliPath.trim();

  const isPackaged = (() => {
    try {
      return Boolean(app?.isPackaged);
    } catch {
      return false;
    }
  })();

  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'signal-cli-runtime', 'bin', 'signal-cli');
    if (fs.existsSync(bundled)) return bundled;
  }

  // Dev: resolve relative to this file's location in the source tree.
  const devCandidates = [
    path.resolve(__dirname, '../../../signal-cli-runtime/bin/signal-cli'),
    (() => {
      try {
        return path.resolve(app.getAppPath(), 'src/process/channels/signal-cli-runtime/bin/signal-cli');
      } catch {
        return '';
      }
    })(),
  ].filter((p): p is string => p.length > 0);

  for (const candidate of devCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }

  // PATH fallback
  return 'signal-cli';
}

/**
 * Probe whether signal-cli is accessible by running `signal-cli --version`.
 * Returns the version string on success or null on failure.
 */
export async function probeSignalCli(cliPath: string): Promise<string | null> {
  try {
    const result = await execFileNoThrow(cliPath, ['--version'], { timeoutMs: 10_000 });
    if (result.exitCode === 0 && result.stdout) {
      // Output is typically "signal-cli 0.13.x"
      return result.stdout.replace(/^signal-cli\s+/i, '').trim() || result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// ── SignalDaemon class ────────────────────────────────────────────────────────

export class SignalDaemon {
  private child: ChildProcess | null = null;
  private rpcId = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private stdoutBuf = '';
  private _status: SignalDaemonStatus = 'stopped';
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private messageHandlers: SignalMessageHandler[] = [];
  private statusHandlers: Array<(status: SignalDaemonStatus) => void> = [];

  readonly opts: Required<Pick<SignalDaemonOpts, 'httpHost' | 'httpPort'>> & SignalDaemonOpts;

  constructor(opts: SignalDaemonOpts) {
    this.opts = {
      httpHost: '127.0.0.1',
      httpPort: 8080,
      ...opts,
    };
  }

  get status(): SignalDaemonStatus {
    return this._status;
  }

  get baseUrl(): string {
    return `http://${this.opts.httpHost}:${this.opts.httpPort}`;
  }

  onMessage(handler: SignalMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  offMessage(handler: SignalMessageHandler): void {
    this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
  }

  /**
   * Subscribe to daemon status changes. Audit fix HIGH7 2026-05-18: without
   * this hook the parent SignalPlugin couldn't observe restart-budget
   * exhaustion, so the Wayland channel kept showing 'running' after signal-cli
   * permanently died.
   */
  onStatusChange(handler: (status: SignalDaemonStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  offStatusChange(handler: (status: SignalDaemonStatus) => void): void {
    this.statusHandlers = this.statusHandlers.filter((h) => h !== handler);
  }

  private setStatus(next: SignalDaemonStatus): void {
    if (this._status === next) return;
    this._status = next;
    for (const h of this.statusHandlers) {
      try {
        h(next);
      } catch (err) {
        console.error('[SignalDaemon] status handler threw:', err);
      }
    }
  }

  /** Spawn signal-cli daemon and connect. Resolves when process is up. */
  async start(): Promise<void> {
    this.stopRequested = false;
    this.restartAttempts = 0;
    this.setStatus('starting');
    this.spawnChild();
  }

  /** Gracefully stop the daemon and cancel any pending restart. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.setStatus('stopped');
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.killChild();
    this.rejectPending('signal daemon stopped');
  }

  /**
   * Send a JSON-RPC request to the running daemon via stdin.
   * Throws if the daemon is not running or the RPC returns an error.
   */
  async rpc(method: string, params: Record<string, JsonValue>): Promise<unknown> {
    if (!this.child || !this.child.stdin) {
      throw new Error('signal-cli daemon is not running');
    }
    const id = ++this.rpcId;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  // ── Private spawn/restart logic ──────────────────────────────────────────

  private spawnChild(): void {
    const cliPath = resolveSignalCliPath(this.opts.cliPath);
    const configDir = this.opts.configDir ?? this.resolveDefaultConfigDir();

    const args: string[] = [
      '--config', configDir,
      '-a', this.opts.phoneNumber,
      'daemon',
      '--http', `${this.opts.httpHost}:${this.opts.httpPort}`,
      '--no-receive-stdout',
    ];

    const child = spawn(cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/\b(ERROR|WARN|FAILED|EXCEPTION)\b/i.test(trimmed)) {
            console.error('[SignalDaemon] signal-cli:', trimmed);
          } else {
            console.log('[SignalDaemon] signal-cli:', trimmed);
          }
        }
      });
    }

    child.once('error', (err) => {
      console.error('[SignalDaemon] spawn error:', err.message);
      this.handleUnexpectedExit('spawn-error');
    });

    child.once('exit', (code, signal) => {
      const why = signal ? `signal=${signal}` : `code=${code}`;
      console.warn(`[SignalDaemon] exited (${why})`);
      this.child = null;
      this.handleUnexpectedExit(why);
    });

    this.setStatus('running');
  }

  private handleUnexpectedExit(reason: string): void {
    this.rejectPending(`signal-cli exited: ${reason}`);
    this.child = null;

    if (this.stopRequested) return;

    this.restartAttempts += 1;
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      console.error(`[SignalDaemon] exceeded ${MAX_RESTART_ATTEMPTS} restart attempts — giving up`);
      this.setStatus('error');
      return;
    }

    // Audit gemini MED1 2026-05-18: jitter (0-1000ms) to avoid synchronized
    // signal-cli daemon restart storms across multiple bots.
    const delayMs = Math.min(
      BACKOFF_INITIAL_MS * Math.pow(BACKOFF_FACTOR, this.restartAttempts - 1),
      BACKOFF_MAX_MS,
    ) + Math.floor(Math.random() * 1000);
    console.log(`[SignalDaemon] restarting in ${delayMs / 1000}s (attempt ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS})…`);
    this.setStatus('starting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopRequested) this.spawnChild();
    }, delayMs);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line) this.handleFrame(line);
    }
  }

  private handleFrame(line: string): void {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch {
      console.warn('[SignalDaemon] invalid JSON from daemon:', line.slice(0, 200));
      return;
    }

    if ('id' in frame && typeof frame.id === 'number') {
      const slot = this.pending.get(frame.id);
      if (slot) {
        this.pending.delete(frame.id);
        if (frame.error) {
          slot.reject(new Error(`signal-cli RPC ${frame.error.code}: ${frame.error.message}`));
        } else {
          slot.resolve(frame.result);
        }
      }
      return;
    }

    if ('method' in frame) {
      this.handleNotification(frame.method, frame.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'receive') {
      const msg = params as unknown as SignalInboundMessage;
      for (const handler of this.messageHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error('[SignalDaemon] message handler threw:', err);
        }
      }
    }
  }

  private rejectPending(reason: string): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  private resolveDefaultConfigDir(): string {
    try {
      const { app: electronApp } = require('electron') as typeof import('electron');
      return path.join(electronApp.getPath('userData'), 'signal');
    } catch {
      return path.join(process.env.HOME ?? process.cwd(), '.local', 'share', 'signal-cli');
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
