/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DocumentEntity, DocumentVersion } from '@/common/types/documents';

export interface IDocumentRepository {
  insert(document: DocumentEntity): Promise<void>;
  replace(document: DocumentEntity): Promise<void>;
  delete(documentId: string): Promise<void>;
  getById(documentId: string): Promise<DocumentEntity | null>;
  /** A user's documents, newest-updated first; archived rows excluded unless requested. */
  listByUser(userId: string, includeArchived: boolean): Promise<DocumentEntity[]>;
  /** Persist a new immutable version row. */
  insertVersion(version: DocumentVersion): Promise<void>;
  /** The highest-numbered version of a document, or null when none exist yet. */
  getLatestVersion(documentId: string): Promise<DocumentVersion | null>;
  /**
   * Coalesce a save into an existing version row: overwrite its content, summary
   * and timestamp in place (used inside the 60s edit window so rapid manual saves
   * don't mint a version per keystroke).
   */
  updateVersionContent(versionId: string, content: string, summary: string, createdAtMs: number): Promise<void>;
}
