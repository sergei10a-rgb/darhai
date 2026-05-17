/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * Pure parse/format helpers for Google Chat ↔ Wayland unified message types.
 * No side effects, no network calls — suitable for direct unit testing.
 */

import type { IUnifiedIncomingMessage, IUnifiedOutgoingMessage } from '../../../types';

// ── Inbound types (subset of Google Chat API) ─────────────────────────────────

export type GoogleChatSpace = {
  name?: string;
  displayName?: string;
  type?: string;
};

export type GoogleChatUser = {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
};

export type GoogleChatThread = {
  name?: string;
  threadKey?: string;
};

export type GoogleChatMessage = {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: GoogleChatUser;
  thread?: GoogleChatThread;
};

export type GoogleChatEvent = {
  type?: string;
  eventType?: string;
  eventTime?: string;
  space?: GoogleChatSpace;
  user?: GoogleChatUser;
  message?: GoogleChatMessage;
};

// ── Inbound: Google Chat event → IUnifiedIncomingMessage ─────────────────────

/**
 * Convert a verified Google Chat event payload into a unified incoming message.
 * Returns null for event types that don't produce a user-visible message
 * (ADDED_TO_SPACE, REMOVED_FROM_SPACE, CARD_CLICKED, etc.).
 */
export function googleChatEventToUnified(
  event: GoogleChatEvent,
  pluginInstanceId: string,
): IUnifiedIncomingMessage | null {
  const eventType = (event.type ?? event.eventType ?? '').toUpperCase();

  if (eventType !== 'MESSAGE') {
    return null;
  }

  const msg = event.message;
  const text = msg?.text ?? msg?.argumentText ?? '';
  if (!text.trim() && !msg?.name) {
    return null;
  }

  const sender = event.user ?? msg?.sender;
  const senderId = sender?.name ?? 'unknown';
  const senderDisplay = sender?.displayName ?? sender?.email ?? senderId;

  // chatId = space name (e.g. "spaces/AAAA") — this is what sendMessage/editMessage receive
  const spaceId = event.space?.name ?? pluginInstanceId;

  // Message name is the stable ID for editing (e.g. "spaces/AAAA/messages/BBBB")
  const messageId = msg?.name ?? `${spaceId}/messages/${Date.now()}`;

  return {
    id: messageId,
    platform: 'google-chat',
    chatId: spaceId,
    user: {
      id: senderId,
      displayName: senderDisplay,
      username: sender?.email ?? senderDisplay,
    },
    content: {
      type: 'text',
      text: text.trim(),
    },
    timestamp: event.eventTime ? new Date(event.eventTime).getTime() : Date.now(),
    raw: event,
  };
}

// ── Outbound: IUnifiedOutgoingMessage → Google Chat REST body ─────────────────

/**
 * Convert a unified outgoing message to the body expected by the Google Chat
 * REST API (POST /v1/spaces/{space}/messages or PATCH /v1/{name}?updateMask=text).
 */
export function toGoogleChatMessageBody(message: IUnifiedOutgoingMessage): { text: string } {
  const text = message.text ?? '';
  return { text };
}
