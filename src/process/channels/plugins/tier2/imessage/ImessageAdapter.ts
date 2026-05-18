/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * Pure adapter functions: chat.db row → IUnifiedIncomingMessage, and the
 * quoteAppleScriptString helper used by all outbound osascript invocations.
 */

import type { IUnifiedIncomingMessage } from '../../../types';

// ---------------------------------------------------------------------------
// chat.db row shape
// ---------------------------------------------------------------------------

/**
 * Minimal projection of a chat.db `message` row joined with `handle`.
 * Only the columns we actually read are typed here.
 */
export type ChatDbRow = {
  /** Primary key from the `message` table */
  readonly rowid: number;
  /** Message body text (may be null for attachments) */
  readonly text: string | null;
  /** 1 if sent by this Mac's iCloud account, 0 if received */
  readonly is_from_me: number;
  /** Unix timestamp in nanoseconds (chat.db stores ns since 2001-01-01) */
  readonly date: number;
  /** GUID of the chat this message belongs to */
  readonly chat_guid: string;
  /** Sender handle string (e.g. "+15551234567" or "user@icloud.com") */
  readonly sender_handle: string | null;
  /** Whether the chat is a group chat (1) or 1:1 (0) */
  readonly is_group: number;
};

// ---------------------------------------------------------------------------
// Security helper — MUST be used for all AppleScript string interpolation
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding inside an AppleScript double-quoted
 * string literal. Two characters need escaping:
 *   - `\`  → `\\`   (AppleScript uses backslash escaping inside strings)
 *   - `"`  → `\"`   (would close the string literal prematurely)
 *
 * Call this on EVERY user-controlled value before interpolating into an
 * osascript script string. Failing to do so is a script-injection vector.
 *
 * Examples:
 *   quoteAppleScriptString('hello')        → '"hello"'
 *   quoteAppleScriptString('say "hi"')     → '"say \\"hi\\""'
 *   quoteAppleScriptString('back\\slash')  → '"back\\\\slash"'
 *   quoteAppleScriptString('line1\nline2') → '"line1\\nline2"'  (newlines literal in AS)
 */
export function quoteAppleScriptString(s: string): string {
  // 0. Strip NUL bytes — AppleScript can mis-handle them and they have no
  //    legitimate place in a user-visible message body.
  // 1. Escape backslashes first (must come before quote escaping).
  // 2. Escape double-quotes.
  // 3. Wrap in double-quotes to produce a valid AppleScript string literal.
  const escaped = s
    .replace(/\0/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// ROWID cursor helpers
// ---------------------------------------------------------------------------

/**
 * Apple's CoreData epoch is 2001-01-01 00:00:00 UTC in nanoseconds.
 * Convert a chat.db `date` column value to a JS millisecond timestamp.
 */
export function chatDbDateToMs(dateNs: number): number {
  // CoreData epoch offset: 978307200 seconds between Unix epoch and 2001-01-01
  const APPLE_EPOCH_OFFSET_S = 978_307_200;
  return Math.round(dateNs / 1_000_000) + APPLE_EPOCH_OFFSET_S * 1000;
}

// ---------------------------------------------------------------------------
// Row → IUnifiedIncomingMessage
// ---------------------------------------------------------------------------

/**
 * Convert a chat.db row (joined with handle) into Wayland's unified incoming
 * message format. Returns null for rows that should be ignored:
 *   - sent by this device (is_from_me === 1)
 *   - no usable text body
 *   - missing required fields
 */
export function rowToUnifiedMessage(row: ChatDbRow): IUnifiedIncomingMessage | null {
  // Ignore own messages to prevent echo loops.
  if (row.is_from_me === 1) return null;

  // Require a text body — attachment-only messages without text are skipped.
  const text = row.text?.trim() ?? '';
  if (!text) return null;

  // Require a sender handle.
  const senderId = row.sender_handle?.trim() ?? '';
  if (!senderId) return null;

  // chatId is the chat GUID for groups, or the normalized handle for 1:1.
  const chatId = row.is_group === 1 ? row.chat_guid : normalizeSenderId(senderId);

  return {
    id: String(row.rowid),
    platform: 'imessage',
    chatId,
    user: {
      id: normalizeSenderId(senderId),
      displayName: senderId,
    },
    content: {
      type: 'text',
      text,
    },
    timestamp: chatDbDateToMs(row.date),
    raw: row,
  };
}

// ---------------------------------------------------------------------------
// Handle normalization (adapted from openclaw/extensions/imessage/src/normalize.ts)
// ---------------------------------------------------------------------------

const SERVICE_PREFIX_RE = /^(imessage:|sms:|auto:)/i;

/**
 * Strip service prefix (imessage:, sms:, auto:) and lowercase email addresses.
 * Phone numbers are left in E.164 form if already normalized; otherwise trimmed.
 */
export function normalizeSenderId(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  for (const prefix of ['imessage:', 'sms:', 'auto:']) {
    if (lower.startsWith(prefix)) {
      return normalizeSenderId(trimmed.slice(prefix.length));
    }
  }

  if (SERVICE_PREFIX_RE.test(trimmed)) {
    return trimmed.replace(SERVICE_PREFIX_RE, '');
  }

  if (trimmed.includes('@')) {
    return lower;
  }

  return trimmed.replace(/\s+/g, '');
}
