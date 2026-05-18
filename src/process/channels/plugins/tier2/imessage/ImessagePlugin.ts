/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * ImessagePlugin — macOS-only iMessage channel plugin.
 *
 * Inbound: polls ~/Library/Messages/chat.db (read-only, better-sqlite3) on a
 * configurable interval (default 2 s). Tracks a rowid cursor so each message
 * is processed exactly once.
 *
 * Outbound: AppleScript via execFileNoThrow('osascript', ['-e', script]).
 * All user-controlled values are passed through quoteAppleScriptString before
 * interpolation. NEVER use child_process exec — Wayland's pre-commit hook
 * blocks it and execFile is used here via the execFileNoThrow helper.
 *
 * Tapbacks (reactions): sent via AppleScript `perform action` on the message.
 *
 * Requires macOS + Full Disk Access for the running process to open chat.db,
 * AND macOS Automation consent (TCC) for Messages.app to send outbound.
 *
 * Limitations (v0): text-only. Inbound attachment-only rows (image, video,
 * audio) are silently dropped; outbound `mediaUrl` is not supported.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import { rowToUnifiedMessage, quoteAppleScriptString } from './ImessageAdapter';
import { execFileNoThrow } from '@/utils/execFileNoThrow';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 60_000;
const CHAT_DB_RELATIVE = path.join('Library', 'Messages', 'chat.db');

/**
 * AppleScript tapback action codes used by Messages.app.
 * 2000 = thumbs up, 2001 = thumbs down, 2002 = ha ha, 2003 = !!, 2004 = ?,
 * 2005 = heart. Negative values remove the tapback.
 */
const TAPBACK_CODES: Record<string, number> = {
  thumbsup: 2000,
  thumbsdown: 2001,
  haha: 2002,
  emphasis: 2003,
  question: 2004,
  heart: 2005,
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Fetch new inbound messages since a given rowid, joining handle for the
 * sender address and chat for the chat GUID.
 *
 * Columns returned match ChatDbRow in ImessageAdapter.ts.
 */
const SQL_NEW_MESSAGES = `
  SELECT
    m.rowid          AS rowid,
    m.text           AS text,
    m.is_from_me     AS is_from_me,
    m.date           AS date,
    c.guid           AS chat_guid,
    h.id             AS sender_handle,
    CASE WHEN c.style = 43 THEN 1 ELSE 0 END AS is_group
  FROM message m
  LEFT JOIN handle h ON h.rowid = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.rowid
  LEFT JOIN chat c ON c.rowid = cmj.chat_id
  WHERE m.rowid > ?
    AND m.is_from_me = 0
  ORDER BY m.rowid ASC
`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export class ImessagePlugin extends BasePlugin {
  readonly type: PluginType = 'imessage';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: true,
    canTypingIndicator: false,
  };

  private db: Database.Database | null = null;
  private stmt: Database.Statement | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private lastRowId = 0;
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  private allowedHandles: Set<string> | null = null;
  private stopped = false;

  // ── lifecycle ──────────────────────────────────────────────────────────────

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('iMessage plugin is macOS-only. Current platform: ' + process.platform);
    }

    const creds = config.credentials ?? {};

    const rawIntervalMs = typeof creds.pollIntervalMs === 'number' && creds.pollIntervalMs > 0
      ? creds.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
    // Clamp to [500ms, 60s] so a misconfigured 1ms cannot DOS the main process,
    // and an unreasonably high value cannot stall delivery for >1min.
    this.pollIntervalMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, rawIntervalMs));

    const rawHandles = Array.isArray(creds.allowedHandles)
      ? (creds.allowedHandles as unknown[]).filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : [];
    this.allowedHandles = rawHandles.length > 0 ? new Set(rawHandles.map((h) => h.toLowerCase())) : null;
  }

  protected async onStart(): Promise<void> {
    this.stopped = false;
    const dbPath = chatDbPath();

    // Attempt to open read-only. A permission error here means Full Disk Access
    // has not been granted; surface a clear message.
    try {
      this.db = new Database(dbPath, { readonly: true });
      this.stmt = this.db.prepare(SQL_NEW_MESSAGES);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint = msg.includes('EACCES') || msg.includes('permission')
        ? ' — grant Full Disk Access to this app in System Settings → Privacy & Security'
        : '';
      throw new Error(`iMessage: cannot open chat.db: ${msg}${hint}`, { cause: err });
    }

    // Seed the cursor to the current max rowid so we only deliver NEW messages.
    try {
      const seed = this.db.prepare('SELECT MAX(rowid) AS maxid FROM message').get() as { maxid: number | null } | undefined;
      this.lastRowId = seed?.maxid ?? 0;
    } catch {
      this.lastRowId = 0;
    }

    this.startPollLoop();
  }

  protected async onStop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      this.db = null;
      this.stmt = null;
    }
  }

  // ── outbound ───────────────────────────────────────────────────────────────

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    const text = (message.text ?? '').trim();
    if (!text) throw new Error('iMessage: cannot send empty message');

    const script = buildSendScript(chatId, text);
    const result = await execFileNoThrow('osascript', ['-e', script], { timeoutMs: 15_000 });

    if (result.exitCode !== 0) {
      if (isAutomationDeniedStderr(result.stderr)) {
        throw new Error(
          'iMessage Automation access denied. Grant in System Settings → Privacy & Security → Automation → <app name> → Messages.',
        );
      }
      throw new Error(`iMessage: osascript send failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    // iMessage has no server-assigned message ID at send time; return a
    // client-generated stable key so the caller has something to track.
    return `imessage-sent-${Date.now()}`;
  }

  // ── reactions (tapbacks) ───────────────────────────────────────────────────

  /**
   * Send an iMessage tapback on a previously-received message.
   *
   * @param chatId   Chat GUID or phone/email handle (same as sendMessage).
   * @param msgId    Wayland message ID (== chat.db rowid as string). Looked up
   *                 in chat.db to recover the original body text, which the
   *                 AppleScript then targets by body match. If lookup fails
   *                 the tapback is aborted rather than risk targeting the
   *                 wrong message.
   * @param reaction Tapback emoji key: 'heart', 'thumbsup', 'thumbsdown',
   *                 'haha', 'emphasis', 'question'.
   */
  async reactToMessage(chatId: string, msgId: string, reaction: string): Promise<void> {
    const code = TAPBACK_CODES[reaction.toLowerCase()];
    if (code == null) {
      throw new Error(`iMessage: unknown tapback reaction '${reaction}'. Valid: ${Object.keys(TAPBACK_CODES).join(', ')}`);
    }

    // Resolve the original message body from chat.db so we can target a
    // specific message instead of "last message of targetChat".
    if (!this.db) {
      throw new Error(`iMessage tapback: plugin not started; cannot look up message id ${msgId}`);
    }
    const rowidNum = Number(msgId);
    if (!Number.isFinite(rowidNum) || rowidNum <= 0) {
      throw new Error(`iMessage tapback: could not find original message with id ${msgId}; tapback aborted to avoid wrong-target race`);
    }
    let body: string | null = null;
    try {
      const lookup = this.db
        .prepare('SELECT text FROM message WHERE rowid = ?')
        .get(rowidNum) as { text: string | null } | undefined;
      body = lookup?.text?.trim() ?? null;
    } catch {
      body = null;
    }
    if (!body) {
      throw new Error(`iMessage tapback: could not find original message with id ${msgId}; tapback aborted to avoid wrong-target race`);
    }

    const script = buildTapbackScript(chatId, code, body);
    const result = await execFileNoThrow('osascript', ['-e', script], { timeoutMs: 15_000 });

    if (result.exitCode !== 0) {
      if (isAutomationDeniedStderr(result.stderr)) {
        throw new Error(
          'iMessage Automation access denied. Grant in System Settings → Privacy & Security → Automation → <app name> → Messages.',
        );
      }
      throw new Error(`iMessage: tapback failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  // ── introspection ──────────────────────────────────────────────────────────

  getActiveUserCount(): number {
    return 0;
  }

  getBotInfo(): BotInfo | null {
    if (this._status !== 'running') return null;
    return {
      id: 'imessage-bot',
      username: 'imessage-bot',
      displayName: 'iMessage',
    };
  }

  // ── poll loop ──────────────────────────────────────────────────────────────

  private startPollLoop(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) return;
      void this.poll().catch((err) => console.error('[imessagePlugin] poll error:', err));
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.stmt || !this.db) return;
    if (this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const rows = this.stmt.all(this.lastRowId) as import('./ImessageAdapter').ChatDbRow[];

      for (const row of rows) {
        if (row.rowid > this.lastRowId) this.lastRowId = row.rowid;

        const unified = rowToUnifiedMessage(row);
        if (!unified) continue;

        // Apply allowedHandles filter if configured.
        if (this.allowedHandles && !this.allowedHandles.has(unified.user.id.toLowerCase())) {
          continue;
        }

        try {
          await this.emitMessage(unified);
        } catch (err) {
          console.error('[imessagePlugin] emitMessage error:', err);
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  // ── static testConnection ─────────────────────────────────────────────────

  static override async testConnection(
    tokenJson: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    // 1. Platform check — fail fast on non-darwin.
    if (process.platform !== 'darwin') {
      return {
        success: false,
        error: `iMessage is macOS-only. Current platform: ${process.platform}`,
      };
    }

    // 2. Parse JSON creds (may be empty object — no required credentials).
    let _creds: { pollIntervalMs?: number; allowedHandles?: string[] };
    try {
      _creds = JSON.parse(tokenJson) as typeof _creds;
    } catch {
      return { success: false, error: 'iMessage: invalid JSON credentials' };
    }

    // 3. Check chat.db exists and is readable.
    const dbPath = chatDbPath();
    if (!fs.existsSync(dbPath)) {
      return {
        success: false,
        error: `chat.db not found at ${dbPath}. Ensure iMessage is set up on this Mac.`,
      };
    }

    try {
      fs.accessSync(dbPath, fs.constants.R_OK);
    } catch {
      return {
        success: false,
        error: `chat.db is not readable. Grant Full Disk Access to this app in System Settings → Privacy & Security.`,
      };
    }

    // 4. Check osascript exists.
    const which = await execFileNoThrow('which', ['osascript'], { timeoutMs: 5_000 });
    if (which.exitCode !== 0 || !which.stdout) {
      return { success: false, error: 'osascript not found in PATH — is this a standard macOS install?' };
    }

    // 5. Trivial osascript smoke-test.
    const probe = await execFileNoThrow('osascript', ['-e', 'return "ok"'], { timeoutMs: 5_000 });
    if (probe.exitCode !== 0) {
      return { success: false, error: `osascript smoke-test failed: ${probe.stderr}` };
    }

    return { success: true, botUsername: 'imessage-bot' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatDbPath(): string {
  return path.join(os.homedir(), CHAT_DB_RELATIVE);
}

/**
 * Build an osascript script to send a plain-text iMessage.
 *
 * For group chats the chatId is a GUID like "chat123456789abc"; for 1:1 it is
 * a phone number or email. We detect the format and use the appropriate
 * AppleScript idiom.
 *
 * Security: message text and handle are both passed through
 * quoteAppleScriptString before interpolation.
 */
function buildSendScript(chatId: string, text: string): string {
  const quotedText = quoteAppleScriptString(text);

  // Group chat GUIDs look like "chat" followed by hex digits.
  if (/^chat[0-9a-f]+$/i.test(chatId)) {
    const quotedGuid = quoteAppleScriptString(chatId);
    return [
      'tell application "Messages"',
      `  set targetChat to chat id ${quotedGuid}`,
      `  send ${quotedText} to targetChat`,
      'end tell',
    ].join('\n');
  }

  // 1:1 handle (phone or email).
  const quotedHandle = quoteAppleScriptString(chatId);
  return [
    'tell application "Messages"',
    `  set targetService to 1st service whose service type = iMessage`,
    `  set targetBuddy to buddy ${quotedHandle} of targetService`,
    `  send ${quotedText} to targetBuddy`,
    'end tell',
  ].join('\n');
}

/**
 * Build an osascript script to send a tapback on the message in `chatId`
 * whose body matches `bodyText`. AppleScript's Messages.app dictionary cannot
 * address messages by rowid/guid, so we match by body — exact equality on the
 * iMessage body text. The orchestrator MUST resolve `bodyText` from chat.db
 * via the Wayland message id before calling this; do not pass arbitrary text.
 */
function buildTapbackScript(chatId: string, actionCode: number, bodyText: string): string {
  const quotedChat = quoteAppleScriptString(chatId);
  const quotedBody = quoteAppleScriptString(bodyText);
  return [
    'tell application "Messages"',
    `  set targetChat to chat id ${quotedChat}`,
    `  set targetBody to ${quotedBody}`,
    `  set targetMsg to missing value`,
    `  repeat with m in (messages of targetChat)`,
    `    if (text of m) is targetBody then`,
    `      set targetMsg to m`,
    `      exit repeat`,
    `    end if`,
    `  end repeat`,
    `  if targetMsg is missing value then error "iMessage tapback: matching message not found in target chat"`,
    `  perform action ${actionCode} on targetMsg`,
    'end tell',
  ].join('\n');
}

/**
 * Detect macOS Automation (TCC) denial in osascript stderr. Apple does not
 * use a stable code, but these substrings reliably appear in the localized
 * error message when the user denies "control Messages" consent.
 */
function isAutomationDeniedStderr(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return (
    stderr.includes('not allowed to send Apple events') ||
    stderr.includes('-1743') ||
    stderr.includes('AppleScript')
  );
}
