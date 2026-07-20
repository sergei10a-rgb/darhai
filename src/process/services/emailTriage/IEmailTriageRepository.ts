/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EmailTriageEntry } from '@/common/types/emailTriage';

/**
 * Persistence port for triage entries. `upsert` is keyed by Message-ID so a
 * re-triage of the same email overwrites rather than duplicates; `getByMessageId`
 * backs the cache-skip that stops an already-triaged email from being reprocessed.
 */
export interface IEmailTriageRepository {
  getByMessageId(messageId: string): Promise<EmailTriageEntry | null>;
  upsert(entry: EmailTriageEntry): Promise<void>;
  /** A plugin's entries, newest-triaged first, capped at `limit`. */
  listByPlugin(pluginId: string, limit: number): Promise<EmailTriageEntry[]>;
}
