/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * IRC channel plugin via irc-framework. Connects to an IRC server with optional
 * SASL PLAIN auth, joins configured channels, listens for PRIVMSG, and emits
 * unified messages. Outbound sends via PRIVMSG with 400-char chunking.
 *
 * Reconnect backoff: 5s → 60s, max 5 attempts then status='error'.
 * Capabilities: text only, no edit, no reactions.
 */

import IrcFramework from 'irc-framework';

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import {
  fromUnifiedOutgoingToIrc,
  toUnifiedIncomingFromIrc,
  type IrcPrivmsgEvent,
} from './IrcAdapter';

// Reconnect backoff constants — mirrors EmailImapPlugin and MatrixPlugin.
const RECONNECT_BACKOFF_START_MS = 5_000;
const RECONNECT_BACKOFF_CAP_MS = 60_000;
const RECONNECT_BACKOFF_MAX_ATTEMPTS = 5;

// testConnection timeout: wait up to 10s for RPL_WELCOME (001).
const TEST_CONNECT_TIMEOUT_MS = 10_000;

type IrcCreds = {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  password: string;
  channels: string[];
  saslMechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'none';
};

/**
 * Minimal subset of the irc-framework IrcClient we touch. Declared here so
 * unit tests can mock it with a hand-rolled EventEmitter without depending on
 * irc-framework internals.
 */
export type IrcClientLike = {
  connect(opts?: Record<string, unknown>): void;
  quit(reason?: string): void;
  join(channel: string): void;
  say(target: string, message: string): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  removeAllListeners(): void;
  user: { nick: string };
  connected: boolean;
};

export class IrcPlugin extends BasePlugin {
  readonly type: PluginType = 'irc';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: false,
    canTypingIndicator: false,
  };

  private client: IrcClientLike | null = null;
  private creds: IrcCreds | null = null;
  private selfNick = '';
  private reconnectFailureCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly activeUsers: Set<string> = new Set();

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    this.creds = resolveCreds(config.credentials ?? {});
  }

  protected async onStart(): Promise<void> {
    if (!this.creds) throw new Error('IRC plugin not initialized');
    this.stopped = false;
    this.reconnectFailureCount = 0;
    await this.connectAndListen();
  }

  protected async onStop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        this.client.quit('Wayland shutdown');
      } catch {
        // ignore quit errors during teardown
      }
      try {
        this.client.removeAllListeners();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.selfNick = '';
    this.activeUsers.clear();
    this.reconnectFailureCount = 0;
  }

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    if (!this.selfNick) return null;
    return {
      id: this.selfNick,
      username: this.selfNick,
      displayName: this.selfNick,
    };
  }

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.client || !this.client.connected) {
      throw new Error('IRC client not connected');
    }
    const { lines } = fromUnifiedOutgoingToIrc(message);
    if (lines.length === 0) return '';
    for (const line of lines) {
      this.client.say(chatId, line);
    }
    // IRC has no server-assigned message id — return a synthetic one.
    return `irc:${chatId}:${Date.now()}`;
  }

  async handleWebhookPayload(): Promise<void> {
    throw new Error('IRC uses a persistent TCP connection, not webhooks');
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Build and connect the irc-framework client. Resolves once the server sends
   * RPL_WELCOME (the 'registered' event from irc-framework) so onStart() can
   * verify a working connection before status transitions to 'running'.
   */
  private connectAndListen(): Promise<void> {
    if (!this.creds) return Promise.reject(new Error('IRC plugin not initialized'));
    const creds = this.creds;

    return new Promise<void>((resolve, reject) => {
      const client = new IrcFramework.Client() as IrcClientLike;

      // Wire disconnect listener BEFORE connect so a pre-welcome close fires.
      client.on('close', () => {
        if (this.stopped) return;
        if (this.client !== client) return;
        console.warn('[IrcPlugin] connection closed, scheduling reconnect');
        this.scheduleReconnect();
      });

      client.on('socket error', (err: unknown) => {
        if (this.stopped) return;
        if (this.client !== client) return;
        console.warn('[IrcPlugin] socket error, scheduling reconnect:', err);
        this.scheduleReconnect();
      });

      // 'registered' fires when the server sends RPL_WELCOME (001).
      client.on('registered', () => {
        // Successful registration — record the negotiated nick, reset backoff.
        this.selfNick = client.user.nick;
        this.reconnectFailureCount = 0;

        // Join configured channels.
        for (const ch of creds.channels) {
          const trimmed = ch.trim();
          if (trimmed) {
            try {
              client.join(trimmed);
            } catch (err) {
              console.warn(`[IrcPlugin] JOIN ${trimmed} failed:`, err);
            }
          }
        }

        this.client = client;
        resolve();
      });

      // irc-framework emits 'message' for privmsg/notice/action via the
      // command handler (see client.js line 246). Each event has: nick, ident,
      // hostname, target, message, type.
      client.on('privmsg', (event: unknown) => {
        const e = event as IrcPrivmsgEvent;
        const unified = toUnifiedIncomingFromIrc(e, this.selfNick);
        if (!unified) return;
        this.activeUsers.add(unified.user.id);
        void this.emitMessage(unified).catch((err) =>
          console.error('[IrcPlugin] emitMessage failed:', err),
        );
      });

      // Set up a one-time error listener for pre-welcome failures (bad creds,
      // nick collision, etc.) so connectAndListen() rejects cleanly.
      const onPreWelcomeError = (event: unknown) => {
        const e = event as { error?: string; reason?: string } | string;
        const msg =
          typeof e === 'string'
            ? e
            : (e as { error?: string; reason?: string }).error ??
              (e as { error?: string; reason?: string }).reason ??
              'IRC server error';
        reject(new Error(msg));
      };
      client.on('irc error', onPreWelcomeError);

      // Connect — irc-framework handles the SASL negotiation automatically
      // when `account` options are supplied.
      const connectOpts: Record<string, unknown> = {
        host: creds.server,
        port: creds.port,
        tls: creds.tls,
        nick: creds.nick,
        username: creds.username,
        gecos: 'Wayland IRC bot',
        auto_reconnect: false, // we own the reconnect state machine
      };

      if (creds.password && creds.saslMechanism !== 'none') {
        connectOpts['account'] = {
          account: creds.username,
          password: creds.password,
        };
      } else if (creds.password) {
        // NickServ-style: send PASS on connect.
        connectOpts['password'] = creds.password;
      }

      client.connect(connectOpts);
    });
  }

  /**
   * Schedule a reconnect with exponential backoff. After
   * RECONNECT_BACKOFF_MAX_ATTEMPTS failures, give up and set status='error'.
   * Mirrors EmailImapPlugin.scheduleReconnect() and MatrixPlugin.handleSyncError().
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // already scheduled

    // Tear down the dead client before building the next one.
    const dead = this.client;
    this.client = null;
    if (dead) {
      try {
        dead.quit('reconnecting');
      } catch {
        // ignore
      }
      try {
        dead.removeAllListeners();
      } catch {
        // ignore
      }
    }

    this.reconnectFailureCount += 1;
    if (this.reconnectFailureCount > RECONNECT_BACKOFF_MAX_ATTEMPTS) {
      const reason = `IRC disconnected after ${RECONNECT_BACKOFF_MAX_ATTEMPTS} reconnect attempts`;
      console.error(`[IrcPlugin] ${reason}; giving up`);
      this.setStatus('error', reason);
      return;
    }

    // Audit gemini MED1 2026-05-18: add jitter (0-1000ms) to backoff to avoid
    // thundering-herd reconnects when multiple bots see the same server
    // restart / network flap simultaneously.
    const delay = Math.min(
      RECONNECT_BACKOFF_START_MS * 2 ** (this.reconnectFailureCount - 1),
      RECONNECT_BACKOFF_CAP_MS,
    ) + Math.floor(Math.random() * 1000);
    console.warn(
      `[IrcPlugin] reconnect attempt ${this.reconnectFailureCount}/${RECONNECT_BACKOFF_MAX_ATTEMPTS} in ${delay}ms`,
    );
    this.setError(`IRC disconnected; retrying in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectAndListen().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[IrcPlugin] reconnect attempt failed:', message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Static ─────────────────────────────────────────────────────────────────

  /**
   * Validate credentials by opening a real TCP/TLS connection and waiting for
   * RPL_WELCOME (001) within TEST_CONNECT_TIMEOUT_MS, then disconnecting.
   * The token argument is a JSON-encoded IrcCreds blob from the renderer.
   */
  static override async testConnection(
    token: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(token) as Record<string, unknown>;
    } catch {
      return { success: false, error: 'Invalid testConnection token (expected JSON)' };
    }

    let creds: IrcCreds;
    try {
      creds = resolveCreds(parsed);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.quit('test done');
        } catch {
          // ignore
        }
        resolve({ success: false, error: `IRC connect timed out after ${TEST_CONNECT_TIMEOUT_MS}ms` });
      }, TEST_CONNECT_TIMEOUT_MS);

      const client = new IrcFramework.Client() as IrcClientLike;

      client.on('registered', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const nick = client.user.nick;
        try {
          client.quit('test done');
        } catch {
          // ignore
        }
        resolve({ success: true, botUsername: nick });
      });

      client.on('irc error', (event: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const e = event as { error?: string; reason?: string } | string;
        const msg =
          typeof e === 'string'
            ? e
            : (e as { error?: string; reason?: string }).error ??
              (e as { error?: string; reason?: string }).reason ??
              'IRC server error';
        resolve({ success: false, error: msg });
      });

      client.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: 'IRC connection closed before welcome' });
      });

      client.on('socket error', (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
      });

      const connectOpts: Record<string, unknown> = {
        host: creds.server,
        port: creds.port,
        tls: creds.tls,
        nick: creds.nick,
        username: creds.username,
        gecos: 'Wayland IRC test',
        auto_reconnect: false,
      };

      if (creds.password && creds.saslMechanism !== 'none') {
        connectOpts['account'] = {
          account: creds.username,
          password: creds.password,
        };
      } else if (creds.password) {
        connectOpts['password'] = creds.password;
      }

      try {
        client.connect(connectOpts);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}

// ── Credential resolution ─────────────────────────────────────────────────────

function resolveCreds(raw: Record<string, unknown>): IrcCreds {
  const server = readString(raw['server'] ?? raw['ircServer']);
  if (!server) throw new Error('IRC server hostname is required');

  const nick = readString(raw['nick'] ?? raw['ircNick']);
  if (!nick) throw new Error('IRC nick is required');

  const port = readNumber(raw['port'] ?? raw['ircPort'], 6697);
  const tls = readBool(raw['tls'] ?? raw['ircTls'], true);
  const username = readString(raw['username'] ?? raw['ircUsername']) || nick;
  const password = readString(raw['password'] ?? raw['ircPassword']);

  const rawChannels = raw['channels'] ?? raw['ircChannels'];
  let channels: string[] = [];
  if (typeof rawChannels === 'string') {
    channels = rawChannels
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  } else if (Array.isArray(rawChannels)) {
    channels = (rawChannels as unknown[]).map(String).filter(Boolean);
  }

  const rawMechanism = readString(raw['saslMechanism'] ?? raw['ircSaslMechanism']);
  const saslMechanism: IrcCreds['saslMechanism'] =
    rawMechanism === 'SCRAM-SHA-256'
      ? 'SCRAM-SHA-256'
      : rawMechanism === 'none'
        ? 'none'
        : 'PLAIN';

  return { server, port, tls, nick, username, password, channels, saslMechanism };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
