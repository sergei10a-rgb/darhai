/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * Twitch channel plugin via tmi.js (IRC-over-WebSocket).
 * Joins configured channels, listens for PRIVMSG, emits unified messages.
 * Outbound sends via client.say() with 500-char chunking.
 *
 * Reconnect backoff: 5s → 60s, max 5 attempts then status='error'.
 * Capabilities: text only — no edit, no reactions, no typing indicator.
 *
 * Adapted from openclaw/extensions/twitch/src/monitor.ts and probe.ts (MIT).
 */

// tmi.js v1 ships no bundled type declarations; we use our own TmiClientLike
// interface below and cast through `unknown` at the construction sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TmiOptions = any;

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import {
  fromUnifiedOutgoingToTwitch,
  normalizeTwitchChannel,
  normalizeTwitchToken,
  toUnifiedIncomingFromTwitch,
} from './TwitchAdapter';

// Reconnect backoff — mirrors IrcPlugin and MatrixPlugin.
const RECONNECT_BACKOFF_START_MS = 5_000;
const RECONNECT_BACKOFF_CAP_MS = 60_000;
const RECONNECT_BACKOFF_MAX_ATTEMPTS = 5;

// testConnection: wait up to 10s for GLOBALUSERSTATE (successful OAuth login).
const TEST_CONNECT_TIMEOUT_MS = 10_000;

type TwitchCreds = {
  botUsername: string;
  oauthToken: string; // bare token, no "oauth:" prefix required
  channels: string[]; // channel names to join (normalised on use)
};

/**
 * Minimal subset of the tmi.js Client we touch. Declared here so unit tests
 * can swap it with a hand-rolled EventEmitter without depending on tmi internals.
 */
export type TmiClientLike = {
  connect(): Promise<[string, number]>;
  disconnect(): Promise<[string, number]>;
  say(channel: string, message: string): Promise<[string]>;
  on(event: string, listener: (...args: unknown[]) => void): TmiClientLike;
  removeAllListeners(event?: string): void;
  readyState(): string;
};

export class TwitchPlugin extends BasePlugin {
  readonly type: PluginType = 'twitch';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: false,
    canTypingIndicator: false,
  };

  private client: TmiClientLike | null = null;
  private creds: TwitchCreds | null = null;
  private reconnectFailureCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    this.creds = resolveCreds(config.credentials ?? {});
  }

  protected async onStart(): Promise<void> {
    if (!this.creds) throw new Error('Twitch plugin not initialized');
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
        this.client.removeAllListeners();
        await this.client.disconnect();
      } catch {
        // ignore disconnect errors during teardown
      }
      this.client = null;
    }
    this.reconnectFailureCount = 0;
  }

  getActiveUserCount(): number {
    return 0;
  }

  getBotInfo(): BotInfo | null {
    if (!this.creds || !this.client) return null;
    return {
      id: this.creds.botUsername,
      username: this.creds.botUsername,
      displayName: this.creds.botUsername,
    };
  }

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.client) throw new Error('Twitch client not connected');
    const { lines } = fromUnifiedOutgoingToTwitch(message);
    if (lines.length === 0) return '';
    const channel = normalizeTwitchChannel(chatId);
    for (const line of lines) {
      await this.client.say(channel, line);
    }
    // tmi.js say() does not return a server-assigned message id.
    return `twitch:${channel}:${Date.now()}`;
  }

  async handleWebhookPayload(): Promise<void> {
    throw new Error('Twitch uses a persistent IRC/WebSocket connection, not webhooks');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async connectAndListen(): Promise<void> {
    if (!this.creds) throw new Error('Twitch plugin not initialized');
    const creds = this.creds;

    // Import tmi.js lazily so unit tests can mock it via vi.mock before the
    // module loads. tmi.js v1 is CJS with no bundled types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type TmiModule = { default: new (opts: TmiOptions) => any };
    // @ts-expect-error — tmi.js v1 ships no type declarations
    const tmi = (await import('tmi.js')) as TmiModule;
    const TmiClientCtor = tmi.default;

    const opts: TmiOptions = {
      identity: {
        username: creds.botUsername,
        password: normalizeTwitchToken(creds.oauthToken),
      },
      channels: creds.channels.map(normalizeTwitchChannel).filter(Boolean),
      connection: {
        reconnect: false, // we own the reconnect state machine
        secure: true,
      },
      logger: {
        info: (): void => undefined,
        warn: (msg: string): void => { console.warn('[TwitchPlugin:tmi]', msg); },
        error: (msg: string): void => { console.error('[TwitchPlugin:tmi]', msg); },
      },
    };

    const client = new TmiClientCtor(opts) as unknown as TmiClientLike;

    // Wire disconnect BEFORE connect so a pre-welcome close fires.
    client.on('disconnected', (reason: unknown) => {
      if (this.stopped) return;
      if (this.client !== client) return;
      console.warn('[TwitchPlugin] disconnected:', reason, '— scheduling reconnect');
      this.scheduleReconnect();
    });

    client.on('message', (channel: unknown, userstate: unknown, message: unknown, self: unknown) => {
      const unified = toUnifiedIncomingFromTwitch({
        channel: channel as string,
        userstate: userstate as Parameters<typeof toUnifiedIncomingFromTwitch>[0]['userstate'],
        message: message as string,
        self: self as boolean,
      });
      if (!unified) return;
      void this.emitMessage(unified).catch((err) =>
        console.error('[TwitchPlugin] emitMessage failed:', err),
      );
    });

    try {
      await client.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Twitch connect failed: ${message}`);
    }

    // Connected — reset backoff and store client reference.
    this.reconnectFailureCount = 0;
    this.client = client;
  }

  /**
   * Schedule a reconnect with exponential backoff. After
   * RECONNECT_BACKOFF_MAX_ATTEMPTS failures, give up and set status='error'.
   * Mirrors IrcPlugin.scheduleReconnect().
   */
  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return; // already scheduled

    // Tear down dead client.
    const dead = this.client;
    this.client = null;
    if (dead) {
      try {
        dead.removeAllListeners();
        void dead.disconnect();
      } catch {
        // ignore
      }
    }

    this.reconnectFailureCount += 1;
    if (this.reconnectFailureCount > RECONNECT_BACKOFF_MAX_ATTEMPTS) {
      const reason = `Twitch disconnected after ${RECONNECT_BACKOFF_MAX_ATTEMPTS} reconnect attempts`;
      console.error(`[TwitchPlugin] ${reason}; giving up`);
      this.setStatus('error', reason);
      return;
    }

    // Audit gemini MED1 2026-05-18: jitter (0-1000ms) to avoid synchronized
    // chat reconnects during Twitch IRC server hiccups.
    const delay = Math.min(
      RECONNECT_BACKOFF_START_MS * 2 ** (this.reconnectFailureCount - 1),
      RECONNECT_BACKOFF_CAP_MS,
    ) + Math.floor(Math.random() * 1000);
    console.warn(
      `[TwitchPlugin] reconnect attempt ${this.reconnectFailureCount}/${RECONNECT_BACKOFF_MAX_ATTEMPTS} in ${delay}ms`,
    );
    this.setError(`Twitch disconnected; retrying in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectAndListen().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[TwitchPlugin] reconnect attempt failed:', message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── Static ──────────────────────────────────────────────────────────────────

  /**
   * Validate credentials by connecting via tmi.js and waiting for the
   * GLOBALUSERSTATE event (indicates successful OAuth authentication) within
   * TEST_CONNECT_TIMEOUT_MS, then disconnecting.
   *
   * The token argument is a JSON-encoded TwitchCreds blob from the renderer.
   * Adapted from openclaw/extensions/twitch/src/probe.ts (MIT).
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

    let creds: TwitchCreds;
    try {
      creds = resolveCreds(parsed);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type TmiModule2 = { default: new (opts: TmiOptions) => any };
    // @ts-expect-error — tmi.js v1 ships no type declarations
    const tmi = (await import('tmi.js')) as TmiModule2;
    const TmiClientCtor = tmi.default;

    const opts: TmiOptions = {
      identity: {
        username: creds.botUsername,
        password: normalizeTwitchToken(creds.oauthToken),
      },
      channels: [],
      connection: {
        reconnect: false,
        secure: true,
      },
      logger: {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
      },
    };

    const client = new TmiClientCtor(opts) as unknown as TmiClientLike;

    return new Promise<{ success: boolean; botUsername?: string; error?: string }>((resolve) => {
      let settled = false;

      const settle = (result: { success: boolean; botUsername?: string; error?: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeAllListeners();
        void client.disconnect().catch((): undefined => undefined);
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle({ success: false, error: `Twitch connect timed out after ${TEST_CONNECT_TIMEOUT_MS}ms` });
      }, TEST_CONNECT_TIMEOUT_MS);

      // GLOBALUSERSTATE fires after successful OAuth login on Twitch IRC.
      client.on('globaluserstate', () => {
        settle({ success: true, botUsername: creds.botUsername });
      });

      // connected fires when the TCP/WebSocket link is up but before auth.
      // If globaluserstate follows, we resolve there. If auth fails, we get
      // 'disconnected' instead.
      client.on('disconnected', (reason: unknown) => {
        settle({ success: false, error: String(reason) });
      });

      client.connect().catch((err: unknown) => {
        settle({ success: false, error: err instanceof Error ? err.message : String(err) });
      });
    });
  }
}

// ── Credential resolution ─────────────────────────────────────────────────────

function resolveCreds(raw: Record<string, unknown>): TwitchCreds {
  const botUsername = readString(raw['botUsername'] ?? raw['username']);
  if (!botUsername) throw new Error('Twitch botUsername is required');

  const oauthToken = readString(raw['oauthToken'] ?? raw['accessToken'] ?? raw['token']);
  if (!oauthToken) throw new Error('Twitch OAuth token is required');

  const rawChannels = raw['channels'];
  let channels: string[] = [];
  if (typeof rawChannels === 'string') {
    channels = rawChannels
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  } else if (Array.isArray(rawChannels)) {
    channels = (rawChannels as unknown[]).map(String).filter(Boolean);
  }

  return { botUsername, oauthToken, channels };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
