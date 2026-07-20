/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { uuid } from '@/common/utils';
import { oneShotComplete, pickBestModel } from '@process/services/completion/oneShot';
import { applyEdits, buildEditPrompt, buildSuggestPrompt, parseEditBlocks, parseSuggestBlocks } from './editBlocks';
import type {
  AiSuggestion,
  AiEditResult,
  CreateDocumentParams,
  DocumentEntity,
  DocumentVersion,
  UpdateDocumentParams,
} from '@/common/types/documents';
import type { IDocumentRepository } from './IDocumentRepository';
import type { IDocumentEventEmitter } from './IDocumentEventEmitter';

/**
 * Version coalescing window. A manual save within this many ms of the last user
 * version updates that version in place (the user is still actively editing);
 * once the gap exceeds it, the next save mints a fresh version. Ported from
 * Odysseus's `VERSION_COALESCE_SECONDS = 60`.
 */
const VERSION_COALESCE_MS = 60_000;
/** Generous single-response cap - an edit / suggestion batch must not truncate. */
const AI_MAX_TOKENS = 4_000;
/** Per-call wall-clock ceiling - a stuck endpoint must not hang the workspace. */
const AI_TIMEOUT_MS = 60_000;

/**
 * DocumentService - CRUD + version history for the Documents surface (Odysseus
 * assimilation "documents"). Mirrors CalendarService's constructor-injection shape
 * (repo + emitter). Every mutation persists an immutably-rebuilt document and emits
 * a `documentChanged` event so any open surface refreshes.
 *
 * The AI half (`aiEdit` / `aiSuggest`) reuses the one-shot completion path the
 * Compare service uses (`oneShotComplete`), resolving the user's most capable
 * configured model. `aiEdit` persists a new `source='ai'` version; `aiSuggest`
 * returns non-destructive suggestions the UI accepts / rejects (no write).
 */
export class DocumentService {
  constructor(
    private readonly repo: IDocumentRepository,
    private readonly emitter: IDocumentEventEmitter
  ) {}

  async create(params: CreateDocumentParams): Promise<DocumentEntity> {
    const now = Date.now();
    const document: DocumentEntity = {
      id: `doc_${uuid()}`,
      userId: params.userId,
      title: params.title?.trim() ?? '',
      language: params.language ?? 'markdown',
      content: params.content ?? '',
      versionCount: 1,
      archived: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.repo.insert(document);
    await this.repo.insertVersion({
      id: `docv_${uuid()}`,
      documentId: document.id,
      versionNumber: 1,
      content: document.content,
      summary: 'Initial version',
      source: 'user',
      createdAtMs: now,
    });
    this.emitter.emitDocumentChanged({ documentId: document.id, action: 'created' });
    return document;
  }

  async update(documentId: string, updates: UpdateDocumentParams): Promise<DocumentEntity> {
    const existing = await this.repo.getById(documentId);
    if (!existing) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const now = Date.now();
    const next: DocumentEntity = { ...existing, updatedAtMs: now };
    if (updates.title !== undefined) next.title = updates.title.trim();
    if (updates.language !== undefined) next.language = updates.language;
    if (updates.archived !== undefined) next.archived = updates.archived;

    const contentChanged = updates.content !== undefined && updates.content !== existing.content;
    if (updates.content !== undefined) next.content = updates.content;

    if (contentChanged) {
      next.versionCount = await this.commitUserVersion(documentId, existing.versionCount, next.content, now);
    }

    await this.repo.replace(next);
    this.emitter.emitDocumentChanged({ documentId, action: 'updated' });
    return next;
  }

  async delete(documentId: string): Promise<void> {
    await this.repo.delete(documentId);
    this.emitter.emitDocumentChanged({ documentId, action: 'deleted' });
  }

  async get(documentId: string): Promise<DocumentEntity | null> {
    return this.repo.getById(documentId);
  }

  async list(userId: string, includeArchived = false): Promise<DocumentEntity[]> {
    return this.repo.listByUser(userId, includeArchived);
  }

  /**
   * Persist a manual-save version with the 60s coalescing window and return the
   * document's resulting version count. Coalesce only into a recent `user`
   * version - an `ai` version is a distinct, non-coalescible checkpoint.
   */
  private async commitUserVersion(
    documentId: string,
    currentVersionCount: number,
    content: string,
    now: number
  ): Promise<number> {
    const latest = await this.repo.getLatestVersion(documentId);
    if (latest && latest.source === 'user' && now - latest.createdAtMs < VERSION_COALESCE_MS) {
      await this.repo.updateVersionContent(latest.id, content, 'Manual edit', now);
      return currentVersionCount;
    }
    const newVersionNumber = currentVersionCount + 1;
    await this.repo.insertVersion({
      id: `docv_${uuid()}`,
      documentId,
      versionNumber: newVersionNumber,
      content,
      summary: 'Manual edit',
      source: 'user',
      createdAtMs: now,
    });
    return newVersionNumber;
  }

  /**
   * Rewrite a document from a natural-language instruction. Asks the model for
   * FIND/REPLACE blocks (reusing `oneShotComplete`), applies them, and persists
   * the result as a new `source='ai'` version. Returns `applied: false` (document
   * untouched) when the model returns no block or none of them match.
   */
  async aiEdit(documentId: string, instruction: string): Promise<AiEditResult> {
    const existing = await this.repo.getById(documentId);
    if (!existing) {
      throw new Error(`Document not found: ${documentId}`);
    }
    const prompt = buildEditPrompt(existing.language, existing.content, instruction);
    const reply = await this.complete(prompt);
    const edits = parseEditBlocks(reply);
    if (edits.length === 0) return { applied: false };

    const result = applyEdits(existing.content, edits);
    if (result.appliedCount === 0) return { applied: false };

    const now = Date.now();
    const newVersionNumber = existing.versionCount + 1;
    const version: DocumentVersion = {
      id: `docv_${uuid()}`,
      documentId,
      versionNumber: newVersionNumber,
      content: result.content,
      summary: `AI edit (${result.appliedCount})`,
      source: 'ai',
      createdAtMs: now,
    };
    await this.repo.insertVersion(version);
    await this.repo.replace({
      ...existing,
      content: result.content,
      versionCount: newVersionNumber,
      updatedAtMs: now,
    });
    this.emitter.emitDocumentChanged({ documentId, action: 'updated' });
    return { applied: true, newVersion: version };
  }

  /**
   * Propose non-destructive improvements. Asks the model for FIND/SUGGEST/REASON
   * blocks and returns only those whose FIND still matches the current content.
   * NOTHING is written - the UI accepts / rejects each suggestion.
   */
  async aiSuggest(documentId: string, instruction: string): Promise<AiSuggestion[]> {
    const existing = await this.repo.getById(documentId);
    if (!existing) {
      throw new Error(`Document not found: ${documentId}`);
    }
    const prompt = buildSuggestPrompt(existing.language, existing.content, instruction);
    const reply = await this.complete(prompt);
    return parseSuggestBlocks(reply).filter((suggestion) => existing.content.includes(suggestion.find));
  }

  /**
   * Single stateless completion, resolving the user's most capable configured
   * model (falling back to the one-shot path's own cheap/Google-auth selection
   * when no flagship key is present).
   */
  private async complete(prompt: string): Promise<string> {
    const model = await pickBestModel();
    return oneShotComplete(prompt, {
      model: model ?? undefined,
      maxTokens: AI_MAX_TOKENS,
      timeoutMs: AI_TIMEOUT_MS,
    });
  }
}
