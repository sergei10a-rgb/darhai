/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * Synology Chat (NAS-hosted) plugin — incoming webhook + outgoing REST.
 *
 * Synology Chat sends outgoing webhook events (form-encoded, `payload` JSON)
 * to our WebhookReceiver. The verifier checks the query-string token with
 * timing-safe comparison. We send replies back by POSTing form-encoded data to
 * the Synology-generated incoming webhook URL.
 *
 * Capabilities: text only (no edit, no reactions, no streaming, no typing).
 */

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import {
  parseSynologyChatBody,
  toSynologyChatSendBody,
  toUnifiedIncomingFromSynologyChat,
  type SynologyChatInboundPayload,
} from './SynologyChatAdapter';

type SynologyChatCreds = {
  /** Synology-generated incoming webhook URL we POST replies to */
  incomingUrl: string;
  /** Static token Synology sends in the inbound webhook query string */
  incomingToken: string;
};

export class SynologyChatPlugin extends BasePlugin {
  readonly type: PluginType = 'synology-chat';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: false,
    canTypingIndicator: false,
  };

  private incomingUrl: string | null = null;
  private readonly activeUsers: Set<string> = new Set();

  /**
   * Validate credentials. Both incomingUrl and incomingToken are required.
   * The token is held by the verifier (read from config.credentials at verify
   * time); the plugin itself stores incomingUrl for outbound sends.
   */
  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const creds = resolveCreds(config.credentials ?? {});
    this.incomingUrl = creds.incomingUrl;
  }

  /**
   * Webhook-driven plugin — nothing to connect. WebhookReceiver routes inbound
   * traffic here via handleWebhookPayload.
   */
  protected async onStart(): Promise<void> {
    // No-op: delivery is fully push-based via WebhookReceiver.
  }

  /**
   * Clean up references on stop.
   */
  protected async onStop(): Promise<void> {
    this.incomingUrl = null;
    this.activeUsers.clear();
  }

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    if (!this.incomingUrl) return null;
    return {
      id: 'wayland-bot',
      username: 'wayland-bot',
      displayName: 'Wayland Bot',
    };
  }

  /**
   * Send a message to Synology Chat via the incoming webhook URL.
   *
   * `chatId` is the Synology Chat user ID to target (numeric string).
   * Returns a synthetic message id — Synology Chat's webhook endpoint does not
   * return a message id in its response.
   */
  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.incomingUrl) {
      throw new Error('SynologyChat plugin not initialized');
    }

    const body = toSynologyChatSendBody(message, chatId);
    await doPost(this.incomingUrl, body);
    return `synology-chat:${chatId}:${Date.now()}`;
  }

  /**
   * Receive a webhook payload that has already been verified by the
   * synology-chat verifier. The payload is the parsed JSON object from the
   * `payload` form parameter; alternatively if the receiver hands us the raw
   * form body as a string we parse it here.
   *
   * Drops silently when required fields are absent (user_id or text).
   */
  async handleWebhookPayload(
    payload: object,
    _headers: Record<string, string | string[] | undefined>,
    _pluginInstanceId: string,
  ): Promise<void> {
    // The verifier hands us the parsed payload object. For Synology Chat the
    // verifier returns the parsed inner JSON (from the `payload` form field).
    const inbound = payload as SynologyChatInboundPayload;
    const unified = toUnifiedIncomingFromSynologyChat(inbound);
    if (!unified) {
      console.warn('[synology-chatPlugin] Dropping payload missing user_id or text');
      return;
    }
    this.activeUsers.add(unified.user.id);
    await this.emitMessage(unified);
  }

  // ── Static ──────────────────────────────────────────────────────────────────

  /**
   * Test connection by POSTing a test message to the incomingUrl.
   * Synology Chat returns `{"success":true}` on a valid delivery.
   * Token argument is JSON-encoded creds per the multi-credential contract.
   */
  static override async testConnection(
    tokenJson: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let creds: SynologyChatCreds;
    try {
      creds = resolveCreds(JSON.parse(tokenJson) as Record<string, unknown>);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const body = `payload=${encodeURIComponent(JSON.stringify({ text: 'Wayland test connection' }))}`;
      await doPost(creds.incomingUrl, body);
      return { success: true, botUsername: 'wayland-bot' };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ── Credential resolution ─────────────────────────────────────────────────────

function resolveCreds(raw: Record<string, unknown>): SynologyChatCreds {
  const incomingUrl = readString(raw['incomingUrl']);
  if (!incomingUrl) throw new Error('Synology Chat incoming webhook URL is required');

  const incomingToken = readString(raw['incomingToken']);
  if (!incomingToken) throw new Error('Synology Chat incoming token is required');

  return { incomingUrl, incomingToken };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * POST form-encoded body to the Synology Chat incoming webhook URL.
 * Throws on non-200 or network error.
 */
async function doPost(url: string, body: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`SynologyChat send failed (${response.status}): ${text}`);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

// Re-export for tests that need access to the parser side.
export { parseSynologyChatBody };
