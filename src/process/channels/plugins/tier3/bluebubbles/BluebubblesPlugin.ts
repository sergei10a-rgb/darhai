/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * BluebubblesPlugin — iMessage relay via a self-hosted BlueBubbles server.
 *
 * Transport: Socket.IO client connecting to the BB server (ws/wss).  Password
 * is passed as a query param.  Listens for `new-message` events; sends via
 * REST POST /api/v1/message/text.  Tapback reactions via POST
 * /api/v1/message/react.
 *
 * Capabilities: text + tapback reactions + typing indicator. No edits
 * (iMessage limitation).
 *
 * Reconnect backoff: 5 s → 60 s, max 5 attempts, then status='error'.
 */

import { io, type Socket } from 'socket.io-client';

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import { buildTapbackPayload, toUnifiedIncomingFromBluebubbles } from './BluebubblesAdapter';

// Reconnect backoff mirrors MattermostPlugin / MatrixPlugin.
const RECONNECT_BACKOFF_START_MS = 5_000;
const RECONNECT_BACKOFF_CAP_MS = 60_000;
const RECONNECT_BACKOFF_MAX_ATTEMPTS = 5;

type BluebubblesCreds = {
  serverUrl: string;
  password: string;
};

type BBServerInfoResponse = {
  status: number;
  data?: {
    server_address?: string;
    name?: string;
  };
};

type BBTextResponse = {
  status: number;
  data?: {
    guid?: string;
  };
};

export class BluebubblesPlugin extends BasePlugin {
  readonly type: PluginType = 'bluebubbles';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: true,
    canTypingIndicator: true,
  };

  private creds: BluebubblesCreds | null = null;
  private socket: Socket | null = null;
  private serverAddress: string | null = null;
  private reconnectFailureCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const raw = config.credentials ?? {};
    const serverUrl = readString(raw['serverUrl']).replace(/\/$/, '');
    const password = readString(raw['password']);

    if (!serverUrl) throw new Error('BlueBubbles server URL is required');
    if (!password) throw new Error('BlueBubbles server password is required');

    this.creds = { serverUrl, password };
  }

  protected async onStart(): Promise<void> {
    if (!this.creds) throw new Error('BlueBubbles plugin not initialized');
    this.stopped = false;
    this.reconnectFailureCount = 0;

    // Verify credentials by fetching server info before opening the socket.
    const info = await this.fetchServerInfo(this.creds);
    this.serverAddress = info.data?.server_address ?? info.data?.name ?? 'bluebubbles-server';

    await this.connectSocket();
  }

  protected async onStop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.serverAddress = null;
    this.reconnectFailureCount = 0;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  getActiveUserCount(): number {
    return 0;
  }

  getBotInfo(): BotInfo | null {
    if (!this.serverAddress) return null;
    return {
      id: this.serverAddress,
      username: this.serverAddress,
      displayName: this.serverAddress,
    };
  }

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.creds) throw new Error('BlueBubbles client not initialized');
    const text = message.text ?? '';
    if (!text.trim()) return '';

    const url = `${this.creds.serverUrl}/api/v1/message/text?password=${encodeURIComponent(this.creds.password)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatGuid: chatId, message: text }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`BlueBubbles sendMessage failed ${resp.status}: ${errText}`);
    }

    const body = (await resp.json()) as BBTextResponse;
    return body.data?.guid ?? '';
  }

  /**
   * Send a tapback reaction. The `emoji` parameter must be one of the six
   * iMessage tapback emoji (❤️ 👍 👎 😂 ‼️ ❓). Throws if unsupported.
   * `chatId` is the chatGuid; `messageId` is the message guid to react to.
   */
  async sendReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.creds) throw new Error('BlueBubbles client not initialized');

    const payload = buildTapbackPayload(chatId, messageId, emoji);
    if (!payload) {
      throw new Error(`BlueBubbles: unsupported tapback emoji "${emoji}"`);
    }

    const url = `${this.creds.serverUrl}/api/v1/message/react?password=${encodeURIComponent(this.creds.password)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`BlueBubbles sendReaction failed ${resp.status}: ${errText}`);
    }
  }

  /**
   * Send a typing indicator via POST /api/v1/chat/{chatGuid}/typing.
   */
  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.creds) return;
    const url = `${this.creds.serverUrl}/api/v1/chat/${encodeURIComponent(chatId)}/typing?password=${encodeURIComponent(this.creds.password)}`;
    await fetch(url, { method: 'POST' }).catch((err: unknown) => {
      console.warn('[BluebubblesPlugin] typing indicator failed:', err);
    });
  }

  async handleWebhookPayload(): Promise<void> {
    throw new Error('BlueBubbles uses Socket.IO, not webhooks');
  }

  // ── Socket.IO ────────────────────────────────────────────────────────────────

  private connectSocket(): Promise<void> {
    if (!this.creds) return Promise.reject(new Error('BlueBubbles plugin not initialized'));
    const { serverUrl, password } = this.creds;

    return new Promise<void>((resolve, reject) => {
      const socket = io(serverUrl, {
        transports: ['websocket'],
        query: { password },
        reconnection: false, // We manage our own backoff.
        timeout: 10_000,
      });

      const onConnect = () => {
        this.socket = socket;
        this.reconnectFailureCount = 0;
        resolve();
      };

      const onConnectError = (err: Error) => {
        socket.removeAllListeners();
        socket.disconnect();
        reject(err);
      };

      const onDisconnect = (reason: string) => {
        if (this.stopped) return;
        if (this.socket !== socket && this.socket !== null) return;
        console.warn(`[BluebubblesPlugin] Socket disconnected: ${reason}, scheduling reconnect`);
        this.socket = null;
        this.scheduleReconnect();
      };

      socket.on('connect', onConnect);
      socket.on('connect_error', onConnectError);
      socket.on('disconnect', onDisconnect);

      socket.on('new-message', (data: unknown) => {
        const unified = toUnifiedIncomingFromBluebubbles(data, this.type);
        if (!unified) return;
        void this.emitMessage(unified).catch((err: unknown) =>
          console.error('[BluebubblesPlugin] emitMessage failed:', err),
        );
      });
    });
  }

  private teardownSocket(): void {
    const dead = this.socket;
    this.socket = null;
    if (dead) {
      try {
        dead.removeAllListeners();
        dead.disconnect();
      } catch {
        // ignore teardown errors
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    this.reconnectFailureCount += 1;
    if (this.reconnectFailureCount > RECONNECT_BACKOFF_MAX_ATTEMPTS) {
      const reason = `BlueBubbles socket disconnected after ${RECONNECT_BACKOFF_MAX_ATTEMPTS} reconnect attempts`;
      console.error(`[BluebubblesPlugin] ${reason}; giving up`);
      this.setStatus('error', reason);
      return;
    }

    const delay = Math.min(
      RECONNECT_BACKOFF_START_MS * 2 ** (this.reconnectFailureCount - 1),
      RECONNECT_BACKOFF_CAP_MS,
    );
    console.warn(
      `[BluebubblesPlugin] reconnect attempt ${this.reconnectFailureCount}/${RECONNECT_BACKOFF_MAX_ATTEMPTS} in ${delay}ms`,
    );
    this.setError(`BlueBubbles socket disconnected; retrying in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectSocket().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[BluebubblesPlugin] reconnect attempt failed:', message);
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  // ── REST helpers ─────────────────────────────────────────────────────────────

  private async fetchServerInfo(creds: BluebubblesCreds): Promise<BBServerInfoResponse> {
    const url = `${creds.serverUrl}/api/v1/server/info?password=${encodeURIComponent(creds.password)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new Error('Invalid BlueBubbles server password');
      }
      throw new Error(`BlueBubbles server/info failed ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<BBServerInfoResponse>;
  }

  // ── Static ───────────────────────────────────────────────────────────────────

  /**
   * Validate credentials by calling GET /api/v1/server/info.
   * tokenJson is JSON-encoded { serverUrl, password }.
   */
  static override async testConnection(
    tokenJson: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let creds: { serverUrl?: string; password?: string };
    try {
      creds = JSON.parse(tokenJson) as typeof creds;
    } catch {
      return { success: false, error: 'Invalid testConnection token (expected JSON)' };
    }

    const serverUrl = (creds.serverUrl ?? '').trim().replace(/\/$/, '');
    const password = (creds.password ?? '').trim();

    if (!serverUrl) return { success: false, error: 'Server URL is required' };
    if (!password) return { success: false, error: 'Password is required' };

    try {
      const url = `${serverUrl}/api/v1/server/info?password=${encodeURIComponent(password)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return { success: false, error: 'Invalid BlueBubbles server password' };
        }
        return { success: false, error: `Server returned ${resp.status}` };
      }
      const body = (await resp.json()) as BBServerInfoResponse;
      const serverAddress = body.data?.server_address ?? body.data?.name ?? 'bluebubbles-bot';
      return { success: true, botUsername: serverAddress };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}

// ── Credential helpers ────────────────────────────────────────────────────────

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
