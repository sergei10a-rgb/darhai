/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Email AI Triage service (Odysseus assimilation "email pollers").
 *
 * For each inbound email that arrives at the plugin boundary, and only when the
 * per-account flags are on, this runs a small set of cheap LLM passes (a single
 * combined classify call for urgency/tags/spam, plus optional summary and reply
 * draft), then persists an {@link EmailTriageEntry} and emits an update event.
 *
 * SAFETY CONTRACT (draft-only, structurally enforced):
 *   - This module has NO reference to any send API. It never imports
 *     EmailImapPlugin, EmailImapConnection, or the worker's sendEmail, and its
 *     injected deps are limited to `complete` (an LLM call), `modelName`, and
 *     `now`. A drafted reply is written to the DB and NOTHING sends it.
 *   - It is invoked BEFORE `emitMessage` at the plugin ingress, so a triaged
 *     email never becomes an agent turn (which is the only path that would
 *     auto-reply over SMTP). Sending a draft is a separate, explicit human
 *     action routed through the existing sendMessage SMTP path.
 */

import { buildClassifyPrompt, buildDraftPrompt, buildSummaryPrompt } from './triagePrompts';
import { normalizeTags, normalizeUrgency } from './triageNormalize';
import type { IEmailTriageRepository } from './IEmailTriageRepository';
import type { IEmailTriageEventEmitter } from './IEmailTriageEventEmitter';
import type { IUnifiedIncomingMessage } from '@process/channels/types';
import { type EmailTag, type EmailTriageEntry, type EmailUrgency, type TriageConfig } from '@/common/types/emailTriage';

/** Per-call token caps - cheap classify, terse summary, a real reply draft. */
const CLASSIFY_MAX_TOKENS = 400;
const SUMMARY_MAX_TOKENS = 400;
const DRAFT_MAX_TOKENS = 1_024;

/** Context the plugin supplies about the account this email arrived at. */
export type TriageContext = {
  pluginId: string;
  account: string;
  config: TriageConfig;
};

/**
 * Injected side-effect deps. Deliberately does NOT include any send function -
 * that omission is the structural half of the draft-only guarantee.
 */
export type TriageDeps = {
  /** A cheap one-shot LLM completion. Returns the model's text. */
  complete: (prompt: string, maxTokens: number) => Promise<string>;
  /** The model id used, for provenance (empty when none is configured). */
  modelName: () => Promise<string>;
  now: () => number;
};

type ClassifyParsed = {
  urgency: EmailUrgency;
  tags: EmailTag[];
  spam: boolean;
  reason: string;
};

/** Extract the first balanced-looking JSON object from a model response. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Parse the combined classify JSON defensively; anything off degrades safely. */
function parseClassifyResult(raw: string): ClassifyParsed {
  const fallback: ClassifyParsed = { urgency: 'none', tags: [], spam: false, reason: '' };
  const json = extractJsonObject(raw);
  if (!json) return fallback;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      urgency: normalizeUrgency(obj.urgency),
      tags: normalizeTags(obj.tags),
      spam: obj.spam === true,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '',
    };
  } catch {
    return fallback;
  }
}

export class TriageService {
  constructor(
    private readonly repo: IEmailTriageRepository,
    private readonly emitter: IEmailTriageEventEmitter,
    private readonly deps: TriageDeps
  ) {}

  /**
   * Triage one inbound email. Returns the persisted entry, the pre-existing
   * entry when the email was already triaged (cache-skip), or null when the
   * message has no usable id. Never sends anything.
   */
  async triageInbound(message: IUnifiedIncomingMessage, ctx: TriageContext): Promise<EmailTriageEntry | null> {
    const messageId = (message.email?.messageId ?? message.id ?? '').trim();
    if (!messageId) return null;

    // Cache-skip: an already-triaged Message-ID is not reprocessed (mirrors the
    // Odysseus `message_id in _existing` guard).
    const existing = await this.repo.getByMessageId(messageId);
    if (existing) return existing;

    const cfg = ctx.config;
    const fromAddr = (message.email?.from ?? message.user.id ?? '').trim();
    const subject = message.email?.subject ?? '';
    const body = message.content?.text ?? '';

    const modelUsed = await this.deps.modelName();

    let urgency: EmailUrgency = 'none';
    let tags: EmailTag[] = [];
    let spamVerdict = false;
    let spamReason = '';

    // ONE combined call covers urgency + tags + spam; only run it if at least
    // one of those three flags is on, and only keep the fields that were asked for.
    if (cfg.triageUrgent || cfg.triageTag || cfg.triageSpam) {
      const parsed = parseClassifyResult(
        await this.safeComplete(buildClassifyPrompt(fromAddr, subject, body), CLASSIFY_MAX_TOKENS)
      );
      if (cfg.triageUrgent) urgency = parsed.urgency;
      if (cfg.triageTag) tags = parsed.tags;
      if (cfg.triageSpam) {
        spamVerdict = parsed.spam;
        spamReason = parsed.reason;
      }
    }

    let summary = '';
    if (cfg.triageSummary) {
      summary = (await this.safeComplete(buildSummaryPrompt(fromAddr, subject, body), SUMMARY_MAX_TOKENS)).trim();
    }

    // The draft is STORED only. There is no send call anywhere in this method.
    let draftReply = '';
    if (cfg.triageDraft) {
      draftReply = (await this.safeComplete(buildDraftPrompt(fromAddr, subject, body), DRAFT_MAX_TOKENS)).trim();
    }

    const entry: EmailTriageEntry = {
      messageId,
      pluginId: ctx.pluginId,
      account: ctx.account,
      fromAddr,
      subject,
      urgency,
      tags,
      spamVerdict,
      spamReason,
      summary,
      draftReply,
      modelUsed,
      triagedAtMs: this.deps.now(),
    };

    await this.repo.upsert(entry);
    this.emitter.emitUpdated({ pluginId: ctx.pluginId, messageId });
    return entry;
  }

  /** A completion pass that degrades to '' on failure so one bad pass never aborts triage. */
  private async safeComplete(prompt: string, maxTokens: number): Promise<string> {
    try {
      return await this.deps.complete(prompt, maxTokens);
    } catch (err) {
      console.warn('[emailTriage] completion pass failed:', err);
      return '';
    }
  }
}

/**
 * Read the six triage flags off a plugin's persisted runtime config
 * (`assistant_plugins.config`). Everything defaults to false, so an account
 * with no triage config behaves exactly like the legacy (pre-triage) path.
 */
export function readTriageConfig(config: Record<string, unknown> | null | undefined): TriageConfig {
  const c = config ?? {};
  const flag = (key: string): boolean => c[key] === true;
  return {
    triageEnabled: flag('triageEnabled'),
    triageSummary: flag('triageSummary'),
    triageTag: flag('triageTag'),
    triageDraft: flag('triageDraft'),
    triageSpam: flag('triageSpam'),
    triageUrgent: flag('triageUrgent'),
  };
}
