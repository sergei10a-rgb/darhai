/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQLite persistence for email triage entries (migration v55, `email_triage`).
 * Thin, synchronous better-sqlite3 access wrapped in async methods (mirrors
 * ResearchStore / DocumentStore). JSON-typed `tags` and the 0/1 `spam_verdict`
 * are (de)serialized at the boundary so callers only ever see real arrays /
 * booleans. Keyed by Message-ID; `upsert` overwrites so a re-triage never
 * duplicates a row.
 */

import { getDatabase } from '@process/services/database';
import type { IEmailTriageRepository } from './IEmailTriageRepository';
import { normalizeUrgency, parseTagsJson } from './triageNormalize';
import type { EmailTriageEntry } from '@/common/types/emailTriage';

/** Row structure for the `email_triage` table. */
type EmailTriageRow = {
  message_id: string;
  plugin_id: string | null;
  account: string | null;
  from_addr: string | null;
  subject: string | null;
  urgency: string | null;
  tags: string | null;
  spam_verdict: number;
  spam_reason: string | null;
  summary: string | null;
  draft_reply: string | null;
  model_used: string | null;
  triaged_at_ms: number;
};

function rowToEntry(row: EmailTriageRow): EmailTriageEntry {
  return {
    messageId: row.message_id,
    pluginId: row.plugin_id ?? '',
    account: row.account ?? '',
    fromAddr: row.from_addr ?? '',
    subject: row.subject ?? '',
    urgency: normalizeUrgency(row.urgency),
    tags: parseTagsJson(row.tags),
    spamVerdict: row.spam_verdict === 1,
    spamReason: row.spam_reason ?? '',
    summary: row.summary ?? '',
    draftReply: row.draft_reply ?? '',
    modelUsed: row.model_used ?? '',
    triagedAtMs: row.triaged_at_ms,
  };
}

export class SqliteEmailTriageRepository implements IEmailTriageRepository {
  async getByMessageId(messageId: string): Promise<EmailTriageEntry | null> {
    const db = await getDatabase();
    const row = db.getDriver().prepare('SELECT * FROM email_triage WHERE message_id = ?').get(messageId) as
      | EmailTriageRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  async upsert(entry: EmailTriageEntry): Promise<void> {
    const db = await getDatabase();
    db.getDriver()
      .prepare(
        `
      INSERT INTO email_triage (
        message_id, plugin_id, account, from_addr, subject, urgency, tags,
        spam_verdict, spam_reason, summary, draft_reply, model_used, triaged_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        plugin_id = excluded.plugin_id,
        account = excluded.account,
        from_addr = excluded.from_addr,
        subject = excluded.subject,
        urgency = excluded.urgency,
        tags = excluded.tags,
        spam_verdict = excluded.spam_verdict,
        spam_reason = excluded.spam_reason,
        summary = excluded.summary,
        draft_reply = excluded.draft_reply,
        model_used = excluded.model_used,
        triaged_at_ms = excluded.triaged_at_ms
    `
      )
      .run(
        entry.messageId,
        entry.pluginId,
        entry.account,
        entry.fromAddr,
        entry.subject,
        entry.urgency,
        JSON.stringify(entry.tags),
        entry.spamVerdict ? 1 : 0,
        entry.spamReason,
        entry.summary,
        entry.draftReply,
        entry.modelUsed,
        entry.triagedAtMs
      );
  }

  async listByPlugin(pluginId: string, limit: number): Promise<EmailTriageEntry[]> {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare('SELECT * FROM email_triage WHERE plugin_id = ? ORDER BY triaged_at_ms DESC LIMIT ?')
      .all(pluginId, limit) as EmailTriageRow[];
    return rows.map(rowToEntry);
  }
}
