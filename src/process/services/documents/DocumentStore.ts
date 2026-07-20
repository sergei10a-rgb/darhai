/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import type {
  DocumentEntity,
  DocumentLanguage,
  DocumentVersion,
  DocumentVersionSource,
} from '@/common/types/documents';

/** Database row structure for the `documents` table (migration v53). */
type DocumentRow = {
  id: string;
  user_id: string;
  title: string | null;
  language: string | null;
  content: string | null;
  version_count: number;
  archived: number;
  created_at_ms: number;
  updated_at_ms: number;
};

/** Database row structure for the `document_versions` table (migration v53). */
type DocumentVersionRow = {
  id: string;
  document_id: string;
  version_number: number;
  content: string | null;
  summary: string | null;
  source: string | null;
  created_at_ms: number;
};

/** Coerce a raw stored language to the closed union, defaulting to markdown. */
function toLanguage(value: string | null): DocumentLanguage {
  return value === 'html' || value === 'csv' || value === 'code' ? value : 'markdown';
}

/** Coerce a raw stored source to the closed union, defaulting to user. */
function toSource(value: string | null): DocumentVersionSource {
  return value === 'ai' ? 'ai' : 'user';
}

function documentToRow(document: DocumentEntity): DocumentRow {
  return {
    id: document.id,
    user_id: document.userId,
    title: document.title,
    language: document.language,
    content: document.content,
    version_count: document.versionCount,
    archived: document.archived ? 1 : 0,
    created_at_ms: document.createdAtMs,
    updated_at_ms: document.updatedAtMs,
  };
}

function rowToDocument(row: DocumentRow): DocumentEntity {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title ?? '',
    language: toLanguage(row.language),
    content: row.content ?? '',
    versionCount: row.version_count,
    archived: row.archived === 1,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function rowToVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    content: row.content ?? '',
    summary: row.summary ?? undefined,
    source: toSource(row.source),
    createdAtMs: row.created_at_ms,
  };
}

/**
 * DocumentStore - persistence layer for documents + their versions. Thin,
 * synchronous better-sqlite3 access wrapped in async methods (mirrors NoteStore /
 * CalendarStore).
 */
class DocumentStore {
  async insert(document: DocumentEntity): Promise<void> {
    const db = await getDatabase();
    const row = documentToRow(document);
    db.getDriver()
      .prepare(
        `
      INSERT INTO documents (
        id, user_id, title, language, content, version_count, archived,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        row.id,
        row.user_id,
        row.title,
        row.language,
        row.content,
        row.version_count,
        row.archived,
        row.created_at_ms,
        row.updated_at_ms
      );
  }

  /** Full-row replace. The service always passes a fully-merged document. */
  async replace(document: DocumentEntity): Promise<void> {
    const db = await getDatabase();
    const row = documentToRow(document);
    db.getDriver()
      .prepare(
        `
      UPDATE documents SET
        user_id = ?, title = ?, language = ?, content = ?, version_count = ?,
        archived = ?, updated_at_ms = ?
      WHERE id = ?
    `
      )
      .run(
        row.user_id,
        row.title,
        row.language,
        row.content,
        row.version_count,
        row.archived,
        row.updated_at_ms,
        row.id
      );
  }

  async delete(documentId: string): Promise<void> {
    const db = await getDatabase();
    // document_versions cascade via the FK; delete the head row explicitly.
    db.getDriver().prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  }

  async getById(documentId: string): Promise<DocumentEntity | null> {
    const db = await getDatabase();
    const row = db.getDriver().prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as
      | DocumentRow
      | undefined;
    return row ? rowToDocument(row) : null;
  }

  async listByUser(userId: string, includeArchived: boolean): Promise<DocumentEntity[]> {
    const db = await getDatabase();
    const sql = includeArchived
      ? 'SELECT * FROM documents WHERE user_id = ? ORDER BY updated_at_ms DESC'
      : 'SELECT * FROM documents WHERE user_id = ? AND archived = 0 ORDER BY updated_at_ms DESC';
    const rows = db.getDriver().prepare(sql).all(userId) as DocumentRow[];
    return rows.map(rowToDocument);
  }

  async insertVersion(version: DocumentVersion): Promise<void> {
    const db = await getDatabase();
    db.getDriver()
      .prepare(
        `
      INSERT INTO document_versions (
        id, document_id, version_number, content, summary, source, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        version.id,
        version.documentId,
        version.versionNumber,
        version.content,
        version.summary ?? null,
        version.source,
        version.createdAtMs
      );
  }

  async getLatestVersion(documentId: string): Promise<DocumentVersion | null> {
    const db = await getDatabase();
    const row = db
      .getDriver()
      .prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(documentId) as DocumentVersionRow | undefined;
    return row ? rowToVersion(row) : null;
  }

  async updateVersionContent(versionId: string, content: string, summary: string, createdAtMs: number): Promise<void> {
    const db = await getDatabase();
    db.getDriver()
      .prepare('UPDATE document_versions SET content = ?, summary = ?, created_at_ms = ? WHERE id = ?')
      .run(content, summary, createdAtMs, versionId);
  }
}

// Singleton instance
export const documentStore = new DocumentStore();
