/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Documents feature (Odysseus assimilation "documents").
 *
 * Named `documentsBridge` (plural) - `documentBridge` is TAKEN by the doc-format
 * convert bridge, which is left untouched. Every mutating verb is remote-denied
 * (see bridgeAllowlist REMOTE_DENIED_KEYS); the AI verbs are denied too because
 * they spend model tokens + make outbound calls. The local renderer contract is
 * still untrusted input crossing a process boundary, so every field is validated /
 * clamped here (mirroring calendarBridge) before it reaches the service.
 */

import { ipcBridge } from '@/common';
import { documentService } from '@process/services/documents/documentServiceSingleton';
import type {
  AiEditResult,
  AiSuggestion,
  CreateDocumentParams,
  DocumentEntity,
  DocumentLanguage,
  UpdateDocumentParams,
} from '@/common/types/documents';

// --- Boundary validation ---------------------------------------------------

/** Cap on id strings (chars). */
const MAX_ID_LEN = 512;
/** Cap on the document title (chars). */
const MAX_TITLE_LEN = 512;
/** Cap on the document body (chars) - generous, but bounds a hostile payload. */
const MAX_CONTENT_LEN = 2_000_000;
/** Cap on the AI instruction (chars). */
const MAX_INSTRUCTION_LEN = 10_000;

/** The closed set of accepted document languages. */
const VALID_LANGUAGES: ReadonlySet<string> = new Set<DocumentLanguage>(['markdown', 'html', 'csv', 'code']);

function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** A valid language token, or undefined when absent / unrecognized. */
function safeLanguage(value: unknown): DocumentLanguage | undefined {
  return typeof value === 'string' && VALID_LANGUAGES.has(value) ? (value as DocumentLanguage) : undefined;
}

function toCreateParams(params: unknown): CreateDocumentParams | null {
  const raw = (params && typeof params === 'object' ? params : {}) as Partial<CreateDocumentParams>;
  const userId = safeString(raw.userId, MAX_ID_LEN);
  if (!userId) return null;

  const out: CreateDocumentParams = { userId };
  const title = safeString(raw.title, MAX_TITLE_LEN);
  if (title) out.title = title;
  const language = safeLanguage(raw.language);
  if (language) out.language = language;
  if (typeof raw.content === 'string') out.content = raw.content.slice(0, MAX_CONTENT_LEN);
  return out;
}

function toUpdateParams(raw: unknown): UpdateDocumentParams {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: UpdateDocumentParams = {};
  if ('title' in source) out.title = safeString(source.title, MAX_TITLE_LEN);
  if ('language' in source) {
    const language = safeLanguage(source.language);
    if (language) out.language = language;
  }
  if ('content' in source && typeof source.content === 'string') {
    out.content = source.content.slice(0, MAX_CONTENT_LEN);
  }
  if ('archived' in source) out.archived = source.archived === true;
  return out;
}

/** Initialize the documents IPC bridge handlers. */
export function initDocumentsBridge(): void {
  ipcBridge.documents.list.provider(async ({ userId, includeArchived }): Promise<DocumentEntity[]> => {
    const id = safeString(userId, MAX_ID_LEN);
    if (!id) return [];
    return documentService.list(id, includeArchived === true);
  });

  ipcBridge.documents.get.provider(async ({ documentId }): Promise<DocumentEntity | null> => {
    const id = safeString(documentId, MAX_ID_LEN);
    if (!id) return null;
    return documentService.get(id);
  });

  ipcBridge.documents.create.provider(async (params): Promise<DocumentEntity> => {
    const createParams = toCreateParams(params);
    if (!createParams) {
      throw new Error('documents.create: userId is required');
    }
    return documentService.create(createParams);
  });

  ipcBridge.documents.update.provider(async ({ documentId, updates }): Promise<DocumentEntity> => {
    const id = safeString(documentId, MAX_ID_LEN);
    if (!id) throw new Error('documents.update: documentId is required');
    return documentService.update(id, toUpdateParams(updates));
  });

  ipcBridge.documents.delete.provider(async ({ documentId }): Promise<void> => {
    const id = safeString(documentId, MAX_ID_LEN);
    if (!id) return;
    await documentService.delete(id);
  });

  ipcBridge.documents.aiEdit.provider(async ({ documentId, instruction }): Promise<AiEditResult> => {
    const id = safeString(documentId, MAX_ID_LEN);
    const text = safeString(instruction, MAX_INSTRUCTION_LEN).trim();
    if (!id || !text) return { applied: false };
    return documentService.aiEdit(id, text);
  });

  ipcBridge.documents.aiSuggest.provider(async ({ documentId, instruction }): Promise<AiSuggestion[]> => {
    const id = safeString(documentId, MAX_ID_LEN);
    const text = safeString(instruction, MAX_INSTRUCTION_LEN).trim();
    if (!id || !text) return [];
    return documentService.aiSuggest(id, text);
  });
}
