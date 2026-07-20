/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Email AI Triage feature (Odysseus assimilation
 * "email pollers"). Darhai already owns the full IMAP/SMTP transport (the
 * `email-imap` channel plugin) plus `oneShotComplete` for cheap background LLM
 * calls; the genuine gap is the TRIAGE layer that classifies, summarizes, and
 * drafts a reply for each inbound email.
 *
 * SAFETY CONTRACT: triage produces DRAFTS ONLY. Nothing in this feature ever
 * auto-sends. A stored `draftReply` becomes a real email only when a human
 * clicks "Send draft", which routes through the existing (already-audited)
 * `EmailImapPlugin.sendMessage` SMTP path.
 *
 * These shapes cross the IPC boundary. All timestamps follow Darhai's UTC
 * epoch-ms `*Ms` naming convention.
 */

/**
 * How urgent an inbound email is, mirroring Odysseus's urgency ladder.
 *  - `critical` action needed within 24h / financial-legal-security risk
 *  - `high`     action needed within a few days, a real person is waiting
 *  - `medium`   reply expected this week
 *  - `low`      routine communication
 *  - `none`     not actionable (promotional / automated / already handled)
 */
export type EmailUrgency = 'critical' | 'high' | 'medium' | 'low' | 'none';

/**
 * Fixed tag vocabulary. The classifier is constrained to this allow-list so a
 * hostile or hallucinated model response can never inject an arbitrary label.
 * Mirrors the Odysseus classify prompt's tag set.
 */
export const EMAIL_TRIAGE_TAGS = [
  'work',
  'personal',
  'finance',
  'bills',
  'receipt',
  'travel',
  'newsletter',
  'promo',
  'notification',
  'security',
  'social',
  'shopping',
  'calendar',
] as const;

export type EmailTag = (typeof EMAIL_TRIAGE_TAGS)[number];

/**
 * Per-account triage feature flags. Every flag defaults to OFF: triage is an
 * opt-in overlay on top of the mailbox connection, and while `triageEnabled`
 * is off the plugin behaves exactly as before (inbound emails flow to the
 * agent as usual). The five per-pass flags select which LLM passes run.
 */
export type TriageConfig = {
  /** Master switch. When off, no triage runs and the legacy path is unchanged. */
  triageEnabled: boolean;
  /** Produce a 1-3 bullet summary. */
  triageSummary: boolean;
  /** Assign allow-listed tags. */
  triageTag: boolean;
  /** Draft a reply body (STORED, never sent). */
  triageDraft: boolean;
  /** Flag spam / bulk mail. */
  triageSpam: boolean;
  /** Assign an urgency level. */
  triageUrgent: boolean;
};

/** All flags off - the safe default for a freshly-connected account. */
export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  triageEnabled: false,
  triageSummary: false,
  triageTag: false,
  triageDraft: false,
  triageSpam: false,
  triageUrgent: false,
};

/** A persisted triage result, keyed by the email's Message-ID. */
export type EmailTriageEntry = {
  /** RFC-822 Message-ID (primary key; the cache key that de-dupes re-triage). */
  messageId: string;
  /** The channel plugin instance that produced this (e.g. `email-imap_default`). */
  pluginId: string;
  /** The mailbox address this email arrived at. */
  account: string;
  /** The sender's address (the reply recipient for a drafted reply). */
  fromAddr: string;
  subject: string;
  urgency: EmailUrgency;
  tags: EmailTag[];
  /** True when the classifier flagged the email as spam / bulk. */
  spamVerdict: boolean;
  spamReason: string;
  /** 1-3 bullet summary (empty when the summary pass did not run). */
  summary: string;
  /** Drafted reply body. STORED ONLY - never auto-sent. */
  draftReply: string;
  /** Model id that produced the passes (for provenance / display). */
  modelUsed: string;
  triagedAtMs: number;
};

/**
 * The parsed output of the triage passes for one email, before it is folded
 * into an {@link EmailTriageEntry}. Kept separate so the service's pure parse +
 * allow-list logic is independently testable.
 */
export type TriageResult = {
  urgency: EmailUrgency;
  tags: EmailTag[];
  spam: boolean;
  reason: string;
  summary: string;
  draftReply: string;
};

/**
 * Parameters for the human-gated "Send draft" action. `editedBody` lets the
 * user tweak the drafted reply in the UI before sending; when omitted the
 * stored `draftReply` is sent verbatim.
 */
export type SendDraftParams = {
  pluginId: string;
  messageId: string;
  editedBody?: string;
};

/** Emitted whenever a triage entry is written, so open surfaces refresh. */
export type EmailTriageUpdatedEvent = {
  pluginId: string;
  messageId: string;
};
