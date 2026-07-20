/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Email AI Triage feature (Odysseus assimilation "email
 * pollers").
 *
 * `list` / `get` are read-only. `sendDraft` is the ONLY verb that can send an
 * email, and it is a deliberate HUMAN action: it looks up the reviewed draft,
 * builds the exact same reply envelope the agent path uses (Re: subject +
 * In-Reply-To threading), and hands it to the EXISTING
 * `EmailImapPlugin.sendMessage` - the already-audited SMTP path. No new send
 * code is introduced anywhere, and the triage service itself never touches this.
 * `sendDraft` is remote-denied (see bridgeAllowlist REMOTE_DENIED_KEYS).
 *
 * The local renderer contract is still untrusted input crossing a process
 * boundary, so every field is validated / clamped here before it is used.
 */

import { ipcBridge } from '@/common';
import { getChannelManager } from '@process/channels/core/ChannelManager';
import { emailTriageRepository } from '@process/services/emailTriage/emailTriageServiceSingleton';
import type { BasePlugin } from '@process/channels/plugins/BasePlugin';
import type { IUnifiedOutgoingMessage } from '@process/channels/types';
import type { EmailTriageEntry, SendDraftParams } from '@/common/types/emailTriage';

/** Cap on id strings (chars). */
const MAX_ID_LEN = 512;
/** Cap on an edited draft body (chars) - generous, but bounds a hostile payload. */
const MAX_BODY_LEN = 50_000;
/** Ceiling on how many entries the triaged-inbox list returns. */
const LIST_LIMIT = 200;

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Resolve the running email-imap plugin. Darhai runs a single email-imap
 * account, so we prefer the requested plugin id but fall back to the sole
 * email-imap instance by type (robust to the exact instance id).
 */
function resolveEmailPlugin(pluginId: string): BasePlugin | null {
  const pm = getChannelManager().getPluginManager();
  if (!pm) return null;
  const byId = pluginId ? pm.getPlugin(pluginId) : undefined;
  if (byId && byId.type === 'email-imap') return byId;
  return pm.getAllPlugins().find((p) => p.type === 'email-imap') ?? null;
}

/** Build the "Re:" reply subject, avoiding a doubled prefix. */
function replySubject(subject: string): string {
  const base = subject.trim();
  if (!base) return 'Re:';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** Initialize the email-triage IPC bridge handlers. */
export function initEmailTriageBridge(): void {
  ipcBridge.emailTriage.list.provider(async ({ pluginId }): Promise<EmailTriageEntry[]> => {
    const id = safeString(pluginId, MAX_ID_LEN);
    if (!id) return [];
    return emailTriageRepository.listByPlugin(id, LIST_LIMIT);
  });

  ipcBridge.emailTriage.get.provider(async ({ messageId }): Promise<EmailTriageEntry | null> => {
    const id = safeString(messageId, MAX_ID_LEN);
    if (!id) return null;
    return emailTriageRepository.getByMessageId(id);
  });

  // Human-gated send. This is the single seam that turns a stored draft into a
  // real outbound email, and it only runs on an explicit user click.
  ipcBridge.emailTriage.sendDraft.provider(async (params: SendDraftParams): Promise<{ messageId: string }> => {
    const messageId = safeString(params?.messageId, MAX_ID_LEN);
    if (!messageId) throw new Error('emailTriage.sendDraft: messageId is required');

    const entry = await emailTriageRepository.getByMessageId(messageId);
    if (!entry) throw new Error('emailTriage.sendDraft: no triage entry for that message');

    const edited = safeString(params?.editedBody, MAX_BODY_LEN);
    const body = (edited || entry.draftReply).trim();
    if (!body) throw new Error('emailTriage.sendDraft: draft body is empty');

    const recipient = entry.fromAddr.trim();
    if (!recipient) throw new Error('emailTriage.sendDraft: no recipient address on the triage entry');

    const plugin = resolveEmailPlugin(safeString(params?.pluginId, MAX_ID_LEN));
    if (!plugin) throw new Error('emailTriage.sendDraft: email-imap plugin is not running');

    // Same reply envelope the agent path builds (see ActionExecutor email-imap
    // branch): a "Re:" subject + In-Reply-To threading. sendMessage is the
    // existing, already-audited SMTP path - no new send code.
    const message: IUnifiedOutgoingMessage = {
      type: 'text',
      text: body,
      subject: replySubject(entry.subject),
      replyToMessageId: entry.messageId,
    };
    const sentId = await plugin.sendMessage(recipient, message);
    return { messageId: sentId };
  });
}
