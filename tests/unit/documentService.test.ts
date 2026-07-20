/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for DocumentService (Odysseus "documents"). Uses an in-memory repo +
 * a mock emitter, and mocks the one-shot completion module, so CRUD, the 60s
 * version-coalescing window, and the AI edit / suggest loop run in pure isolation -
 * no Electron / DB / network dependency.
 *
 * Lives in tests/unit/ (not co-located next to the service) because vitest.config
 * only includes `tests/unit/**` for the node project.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  oneShotComplete: vi.fn(),
  pickBestModel: vi.fn(),
}));

vi.mock('@process/services/completion/oneShot', () => ({
  oneShotComplete: mocks.oneShotComplete,
  pickBestModel: mocks.pickBestModel,
}));

import { DocumentService } from '@process/services/documents/DocumentService';
import type { IDocumentRepository } from '@process/services/documents/IDocumentRepository';
import type { IDocumentEventEmitter } from '@process/services/documents/IDocumentEventEmitter';
import type { DocumentEntity, DocumentVersion } from '@/common/types/documents';

class InMemoryDocumentRepository implements IDocumentRepository {
  documents = new Map<string, DocumentEntity>();
  versions: DocumentVersion[] = [];

  async insert(document: DocumentEntity): Promise<void> {
    this.documents.set(document.id, { ...document });
  }
  async replace(document: DocumentEntity): Promise<void> {
    this.documents.set(document.id, { ...document });
  }
  async delete(documentId: string): Promise<void> {
    this.documents.delete(documentId);
    this.versions = this.versions.filter((v) => v.documentId !== documentId);
  }
  async getById(documentId: string): Promise<DocumentEntity | null> {
    const d = this.documents.get(documentId);
    return d ? { ...d } : null;
  }
  async listByUser(userId: string, includeArchived: boolean): Promise<DocumentEntity[]> {
    return [...this.documents.values()]
      .filter((d) => d.userId === userId && (includeArchived || !d.archived))
      .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  async insertVersion(version: DocumentVersion): Promise<void> {
    this.versions.push({ ...version });
  }
  async getLatestVersion(documentId: string): Promise<DocumentVersion | null> {
    const forDoc = this.versions
      .filter((v) => v.documentId === documentId)
      .toSorted((a, b) => b.versionNumber - a.versionNumber);
    return forDoc[0] ? { ...forDoc[0] } : null;
  }
  async updateVersionContent(versionId: string, content: string, summary: string, createdAtMs: number): Promise<void> {
    const version = this.versions.find((v) => v.id === versionId);
    if (version) {
      version.content = content;
      version.summary = summary;
      version.createdAtMs = createdAtMs;
    }
  }
}

function makeEmitter(): IDocumentEventEmitter {
  return { emitDocumentChanged: vi.fn() };
}

const USER = 'user-1';

describe('DocumentService', () => {
  let repo: InMemoryDocumentRepository;
  let emitter: IDocumentEventEmitter;
  let service: DocumentService;
  let nowSpy: ReturnType<typeof vi.spyOn>;
  let clock: number;

  beforeEach(() => {
    repo = new InMemoryDocumentRepository();
    emitter = makeEmitter();
    service = new DocumentService(repo, emitter);
    clock = 1_700_000_000_000;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    mocks.oneShotComplete.mockReset();
    mocks.pickBestModel.mockReset();
    mocks.pickBestModel.mockResolvedValue(null);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('creates a document with an initial user version and emits created', async () => {
    const doc = await service.create({ userId: USER, title: '  Spec  ', language: 'markdown', content: '# Hi' });

    expect(doc.id).toMatch(/^doc_/);
    expect(doc.title).toBe('Spec'); // trimmed
    expect(doc.versionCount).toBe(1);
    expect(repo.versions).toHaveLength(1);
    expect(repo.versions[0]).toMatchObject({ versionNumber: 1, source: 'user', content: '# Hi' });
    expect(emitter.emitDocumentChanged).toHaveBeenCalledWith({ documentId: doc.id, action: 'created' });
  });

  it('coalesces a content save made within the 60s window into the same version', async () => {
    const doc = await service.create({ userId: USER, content: 'v1' });
    clock += 30_000; // still inside the window
    const updated = await service.update(doc.id, { content: 'v1-edited' });

    expect(updated.content).toBe('v1-edited');
    expect(updated.versionCount).toBe(1); // no new version minted
    expect(repo.versions).toHaveLength(1);
    expect(repo.versions[0].content).toBe('v1-edited'); // coalesced in place
  });

  it('mints a new user version for a content save after the 60s window', async () => {
    const doc = await service.create({ userId: USER, content: 'v1' });
    clock += 61_000; // past the window
    const updated = await service.update(doc.id, { content: 'v2' });

    expect(updated.versionCount).toBe(2);
    expect(repo.versions).toHaveLength(2);
    expect(repo.versions[1]).toMatchObject({ versionNumber: 2, source: 'user', content: 'v2' });
  });

  it('does not mint a version for a metadata-only update', async () => {
    const doc = await service.create({ userId: USER, content: 'body' });
    clock += 61_000;
    const updated = await service.update(doc.id, { title: 'Renamed', archived: true });

    expect(updated.title).toBe('Renamed');
    expect(updated.archived).toBe(true);
    expect(updated.versionCount).toBe(1);
    expect(repo.versions).toHaveLength(1);
  });

  it('applies FIND/REPLACE edits from the model and writes a new ai version', async () => {
    const doc = await service.create({ userId: USER, content: 'Hello world' });
    mocks.oneShotComplete.mockResolvedValue('<<<FIND>>>\nHello world\n<<<REPLACE>>>\nGoodbye world\n<<<END>>>');
    clock += 61_000;

    const result = await service.aiEdit(doc.id, 'make it a farewell');

    expect(result.applied).toBe(true);
    expect(result.newVersion?.source).toBe('ai');
    expect(result.newVersion?.content).toBe('Goodbye world');
    const stored = await service.get(doc.id);
    expect(stored?.content).toBe('Goodbye world');
    expect(stored?.versionCount).toBe(2);
    expect(repo.versions.some((v) => v.source === 'ai' && v.content === 'Goodbye world')).toBe(true);
    expect(emitter.emitDocumentChanged).toHaveBeenLastCalledWith({ documentId: doc.id, action: 'updated' });
  });

  it('returns applied:false and writes nothing when no FIND block matches', async () => {
    const doc = await service.create({ userId: USER, content: 'Hello world' });
    mocks.oneShotComplete.mockResolvedValue('<<<FIND>>>\nnot present\n<<<REPLACE>>>\nx\n<<<END>>>');

    const result = await service.aiEdit(doc.id, 'change something');

    expect(result.applied).toBe(false);
    expect(result.newVersion).toBeUndefined();
    expect(repo.versions).toHaveLength(1); // only the initial version
    const stored = await service.get(doc.id);
    expect(stored?.content).toBe('Hello world'); // untouched
  });

  it('returns AI suggestions non-destructively (no write) and filters non-matching finds', async () => {
    const doc = await service.create({ userId: USER, content: 'The quick brown fox' });
    mocks.oneShotComplete.mockResolvedValue(
      [
        '<<<FIND>>>\nquick\n<<<SUGGEST>>>\nswift\n<<<REASON>>>\nstronger word\n<<<END>>>',
        '<<<FIND>>>\nnot-in-doc\n<<<SUGGEST>>>\nx\n<<<REASON>>>\nirrelevant\n<<<END>>>',
      ].join('\n')
    );

    const suggestions = await service.aiSuggest(doc.id, 'tighten the prose');

    expect(suggestions).toHaveLength(1); // the non-matching find is dropped
    expect(suggestions[0]).toMatchObject({ find: 'quick', suggest: 'swift', reason: 'stronger word' });
    // Non-destructive: content unchanged, no extra version, no change event.
    const stored = await service.get(doc.id);
    expect(stored?.content).toBe('The quick brown fox');
    expect(repo.versions).toHaveLength(1);
    expect(emitter.emitDocumentChanged).toHaveBeenCalledTimes(1); // only the create
  });

  it('deletes a document and emits deleted', async () => {
    const doc = await service.create({ userId: USER, content: 'x' });
    await service.delete(doc.id);
    expect(await service.get(doc.id)).toBeNull();
    expect(emitter.emitDocumentChanged).toHaveBeenLastCalledWith({ documentId: doc.id, action: 'deleted' });
  });

  it("lists a user's documents newest-updated first, excluding archived by default", async () => {
    const a = await service.create({ userId: USER, title: 'A', content: 'a' });
    clock += 1_000;
    const b = await service.create({ userId: USER, title: 'B', content: 'b' });
    clock += 61_000;
    await service.update(a.id, { archived: true });

    const visible = await service.list(USER);
    expect(visible.map((d) => d.id)).toEqual([b.id]);
    const all = await service.list(USER, true);
    expect(all.map((d) => d.id).toSorted()).toEqual([a.id, b.id].toSorted());
  });
});
