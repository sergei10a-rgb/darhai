/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { documentStore } from './DocumentStore';
import type { IDocumentRepository } from './IDocumentRepository';
import type { DocumentEntity, DocumentVersion } from '@/common/types/documents';

/** Thin delegation wrapper around the DocumentStore singleton (mirrors SqliteCalendarRepository). */
export class SqliteDocumentRepository implements IDocumentRepository {
  async insert(document: DocumentEntity): Promise<void> {
    await documentStore.insert(document);
  }

  async replace(document: DocumentEntity): Promise<void> {
    await documentStore.replace(document);
  }

  async delete(documentId: string): Promise<void> {
    await documentStore.delete(documentId);
  }

  async getById(documentId: string): Promise<DocumentEntity | null> {
    return documentStore.getById(documentId);
  }

  async listByUser(userId: string, includeArchived: boolean): Promise<DocumentEntity[]> {
    return documentStore.listByUser(userId, includeArchived);
  }

  async insertVersion(version: DocumentVersion): Promise<void> {
    await documentStore.insertVersion(version);
  }

  async getLatestVersion(documentId: string): Promise<DocumentVersion | null> {
    return documentStore.getLatestVersion(documentId);
  }

  async updateVersionContent(versionId: string, content: string, summary: string, createdAtMs: number): Promise<void> {
    await documentStore.updateVersionContent(versionId, content, summary, createdAtMs);
  }
}
