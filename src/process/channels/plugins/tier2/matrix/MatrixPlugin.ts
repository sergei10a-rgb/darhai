/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * MatrixPlugin — federated, decentralized messaging via matrix-js-sdk.
 *
 * Transport: long-polling /sync against the configured homeserver. We do not
 * accept inbound webhooks; matrix-js-sdk owns the sync loop and emits
 * Room.timeline events for every new m.room.message in joined rooms.
 *
 * Capabilities: text + edits (via m.replace), reactions (m.annotation), and
 * typing indicators (PUT /typing). No native streaming — large responses are
 * chunked by splitMatrixMessage.
 */

import * as sdk from 'matrix-js-sdk';

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import {
  MATRIX_MESSAGE_LIMIT,
  splitMatrixMessage,
  toUnifiedIncomingFromMatrix,
  type MatrixEventLike,
} from './MatrixAdapter';

// Matrix has no built-in typing-indicator timeout. Servers expect a millisecond
// timeout on PUT /typing; clients should poll if they want to keep typing alive
// longer than this window. 30 seconds matches Element's default.
const MATRIX_TYPING_TIMEOUT_MS = 30_000;

// Minimal sync config — pull a small recent backlog so the room timeline
// hydrates without flooding the IPC bus on first connect.
const INITIAL_SYNC_LIMIT = 20;

/**
 * Subset of matrix-js-sdk MatrixClient we touch. Declared here so unit tests
 * can mock the SDK with a hand-rolled emitter without depending on the SDK's
 * internal types.
 */
type MatrixClientLike = {
  startClient: (opts: { initialSyncLimit: number }) => Promise<void>;
  stopClient: () => void;
  sendTextMessage: (roomId: string, body: string) => Promise<{ event_id: string }>;
  sendEvent: (
    roomId: string,
    eventType: string,
    content: object
  ) => Promise<{ event_id: string }>;
  sendTyping: (roomId: string, isTyping: boolean, timeoutMs: number) => Promise<unknown>;
  sendEmoteMessage?: (roomId: string, body: string) => Promise<{ event_id: string }>;
  whoami: () => Promise<{ user_id: string }>;
  getUser: (userId: string) => { displayName?: string } | null;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
  removeAllListeners: () => void;
};

export class MatrixPlugin extends BasePlugin {
  readonly type: PluginType = 'matrix';

  readonly capabilities: IPluginCapabilities = {
    canEdit: true,
    canStream: false,
    canReact: true,
    canTypingIndicator: true,
  };

  private client: MatrixClientLike | null = null;
  private selfUserId: string | null = null;
  private readonly activeUsers: Set<string> = new Set();

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const creds = config.credentials ?? {};
    const homeserverUrl = typeof creds.homeserverUrl === 'string' ? creds.homeserverUrl.trim() : '';
    const accessToken = typeof creds.accessToken === 'string' ? creds.accessToken.trim() : '';
    const userId = typeof creds.userId === 'string' ? creds.userId.trim() : '';

    if (!homeserverUrl) throw new Error('Matrix homeserver URL is required');
    if (!accessToken) throw new Error('Matrix access token is required');
    if (!userId) throw new Error('Matrix user ID (mxid) is required');
    if (!userId.startsWith('@') || !userId.includes(':')) {
      throw new Error('Matrix user ID must be a full mxid (e.g. @bot:matrix.org)');
    }

    this.selfUserId = userId;
    // matrix-js-sdk's createClient is synchronous — it only constructs the
    // client; no network IO until startClient(). Cast through the SDK module's
    // shape so the unit tests can swap it with a vi.hoisted mock.
    const createClient = (sdk as unknown as {
      createClient: (opts: { baseUrl: string; accessToken: string; userId: string }) => MatrixClientLike;
    }).createClient;
    this.client = createClient({
      baseUrl: homeserverUrl,
      accessToken,
      userId,
    });
  }

  protected async onStart(): Promise<void> {
    if (!this.client) throw new Error('Matrix client not initialized');
    this.setupHandlers();
    await this.client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
  }

  protected async onStop(): Promise<void> {
    if (!this.client) return;
    try {
      this.client.stopClient();
      this.client.removeAllListeners();
    } catch (error) {
      console.warn('[MatrixPlugin] Error during stopClient (ignored):', error);
    } finally {
      this.client = null;
      this.selfUserId = null;
      this.activeUsers.clear();
    }
  }

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    if (!this.selfUserId) return null;
    const user = this.client?.getUser(this.selfUserId);
    return {
      id: this.selfUserId,
      username: this.selfUserId,
      displayName: user?.displayName ?? this.selfUserId,
    };
  }

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.client) throw new Error('Matrix client not initialized');
    const body = message.text ?? '';
    if (!body.trim()) return '';

    const chunks = splitMatrixMessage(body, MATRIX_MESSAGE_LIMIT);
    let lastEventId = '';
    for (const chunk of chunks) {
      const resp = await this.client.sendTextMessage(chatId, chunk);
      lastEventId = resp.event_id;
    }
    return lastEventId;
  }

  /**
   * Edit a previously-sent message via the m.replace relation. Per MSC2676,
   * the wire format requires:
   *   - top-level body = " * <new>" (fallback for clients that don't render edits)
   *   - m.new_content = the canonical replacement content
   *   - m.relates_to = { rel_type: 'm.replace', event_id }
   */
  async editMessage(
    chatId: string,
    messageId: string,
    message: IUnifiedOutgoingMessage
  ): Promise<void> {
    if (!this.client) throw new Error('Matrix client not initialized');
    const body = message.text ?? '';
    if (!body.trim()) return;

    await this.client.sendEvent(chatId, 'm.room.message', {
      msgtype: 'm.text',
      body: ` * ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: messageId },
    });
  }

  /**
   * Add a reaction via the m.annotation relation (MSC2677). Matrix reactions
   * are first-class events; passing a unicode emoji as the key is canonical.
   */
  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not initialized');
    await this.client.sendEvent(chatId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: messageId,
        key: emoji,
      },
    });
  }

  /**
   * Send a typing indicator. Matrix expects a millisecond timeout the server
   * uses to auto-expire the indicator; pass a 30s default matching Element so
   * the indicator stays visible for the duration of a typical agent response.
   */
  async sendTypingIndicator(chatId: string): Promise<void> {
    if (!this.client) return;
    await this.client.sendTyping(chatId, true, MATRIX_TYPING_TIMEOUT_MS);
  }

  /**
   * Matrix is sync-driven, not webhook-driven. Override the base error message
   * with a specific, actionable explanation so an operator who points an HTTP
   * receiver at this plugin sees why nothing happens.
   */
  async handleWebhookPayload(): Promise<void> {
    throw new Error('Matrix uses sync (long-polling), not webhooks');
  }

  // ==================== Internal ====================

  private setupHandlers(): void {
    if (!this.client || !this.selfUserId) return;

    this.client.on('Room.timeline', (...args: unknown[]) => {
      const event = args[0] as MatrixEventLike | undefined;
      if (!event || typeof event.getType !== 'function') return;

      const unified = toUnifiedIncomingFromMatrix(event, this.selfUserId!);
      if (!unified) return;

      this.activeUsers.add(unified.user.id);
      void this.emitMessage(unified).catch((err) =>
        console.error('[MatrixPlugin] Room.timeline handler failed:', err)
      );
    });

    this.client.on('sync', (...args: unknown[]) => {
      const state = args[0] as string;
      if (state === 'ERROR') {
        this.setError('Matrix sync entered ERROR state');
      }
    });
  }

  // ==================== Static ====================

  /**
   * Validate credentials by calling /_matrix/client/r0/account/whoami. The
   * homeserver echoes back the user_id bound to the access token.
   *
   * Signature mirrors BasePlugin.testConnection (single `token` string) so
   * the static side stays assignment-compatible — see WhatsAppPlugin for the
   * same pattern. The form JSON-encodes `{homeserverUrl, accessToken}` as the
   * token. Returns success with `botUsername` set to the resolved user_id so
   * the renderer can persist it as credentials.userId.
   */
  static override async testConnection(
    token: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let parsed: { homeserverUrl?: string; accessToken?: string };
    try {
      parsed = JSON.parse(token) as typeof parsed;
    } catch {
      return { success: false, error: 'Invalid testConnection token (expected JSON)' };
    }
    const baseUrl = parsed.homeserverUrl?.trim() ?? '';
    const accessToken = parsed.accessToken?.trim() ?? '';
    if (!baseUrl) return { success: false, error: 'Homeserver URL is required' };
    if (!accessToken) return { success: false, error: 'Access token is required' };

    try {
      const createClient = (sdk as unknown as {
        createClient: (opts: { baseUrl: string; accessToken: string }) => MatrixClientLike;
      }).createClient;
      const probe = createClient({ baseUrl, accessToken });
      const me = await probe.whoami();
      // whoami() returns user_id on success; matrix-js-sdk does not require a
      // running sync for this REST call, so no startClient/stopClient pair.
      return { success: true, botUsername: me.user_id };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/m\.unknown_token|invalid token|401/i.test(message)) {
        return { success: false, error: 'Invalid Matrix access token' };
      }
      return { success: false, error: message };
    }
  }
}
