/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Boundary-validation tests for documentsBridge - the main-process trust boundary
 * for the Documents feature (Odysseus "documents"). The local renderer contract is
 * untrusted input crossing a process boundary, so the bridge validates / clamps
 * every field before it reaches the service. These tests mock both the ipcBridge
 * provider registry (to capture the handlers) and the service singleton (to observe
 * what the validated payload becomes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => {
  const g = globalThis as Record<string, unknown>;
  const make = (key: string) => (g[key] ?? (g[key] = vi.fn())) as ReturnType<typeof vi.fn>;
  return {
    ipcBridge: {
      documents: {
        list: { provider: make('__docList') },
        get: { provider: make('__docGet') },
        create: { provider: make('__docCreate') },
        update: { provider: make('__docUpdate') },
        delete: { provider: make('__docDelete') },
        aiEdit: { provider: make('__docAiEdit') },
        aiSuggest: { provider: make('__docAiSuggest') },
      },
    },
  };
});

vi.mock('@process/services/documents/documentServiceSingleton', () => {
  const g = globalThis as Record<string, unknown>;
  const svc =
    g.__documentServiceMock ??
    (g.__documentServiceMock = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aiEdit: vi.fn(),
      aiSuggest: vi.fn(),
    });
  return { documentService: svc };
});

import { initDocumentsBridge } from '@process/bridge/knowledge/records/documentsBridge';

const g = globalThis as Record<string, unknown>;
const service = g.__documentServiceMock as Record<string, ReturnType<typeof vi.fn>>;

function handlerOf(providerKey: string): (raw: unknown) => Promise<unknown> {
  const providerMock = g[providerKey] as ReturnType<typeof vi.fn>;
  const last = providerMock.mock.calls.at(-1);
  if (!last) throw new Error(`${providerKey} provider was never registered`);
  return last[0] as (raw: unknown) => Promise<unknown>;
}

beforeEach(() => {
  for (const key of [
    '__docList',
    '__docGet',
    '__docCreate',
    '__docUpdate',
    '__docDelete',
    '__docAiEdit',
    '__docAiSuggest',
  ]) {
    (g[key] as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(service)) fn.mockReset();
  service.list.mockResolvedValue([]);
  service.create.mockImplementation(async (params: unknown) => params);
  service.update.mockImplementation(async () => ({}));
  service.aiEdit.mockResolvedValue({ applied: true });
  service.aiSuggest.mockResolvedValue([]);
  initDocumentsBridge();
});

afterEach(() => vi.clearAllMocks());

describe('documentsBridge.create - validation', () => {
  it('throws when userId is missing', async () => {
    const create = handlerOf('__docCreate');
    await expect(create({ title: 'x' })).rejects.toThrow(/userId is required/);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('clamps an oversized title and drops an unknown language', async () => {
    const create = handlerOf('__docCreate');
    await create({ userId: 'u1', title: 'a'.repeat(5000), language: 'pdf', content: 'body' });
    const params = service.create.mock.calls[0][0] as { title: string; language?: string; content: string };
    expect(params.title.length).toBe(512);
    expect(params.language).toBeUndefined(); // 'pdf' is not in the closed set
    expect(params.content).toBe('body');
  });

  it('keeps a valid language token', async () => {
    const create = handlerOf('__docCreate');
    await create({ userId: 'u1', language: 'html' });
    expect((service.create.mock.calls[0][0] as { language?: string }).language).toBe('html');
  });
});

describe('documentsBridge.update - validation', () => {
  it('throws when documentId is missing', async () => {
    const update = handlerOf('__docUpdate');
    await expect(update({ documentId: '', updates: {} })).rejects.toThrow(/documentId is required/);
  });

  it('drops an invalid language but keeps archived + content', async () => {
    const update = handlerOf('__docUpdate');
    await update({ documentId: 'doc_1', updates: { language: 'nope', archived: true, content: 'x' } });
    const [id, updates] = service.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('doc_1');
    expect(updates.language).toBeUndefined();
    expect(updates.archived).toBe(true);
    expect(updates.content).toBe('x');
  });
});

describe('documentsBridge AI verbs - validation', () => {
  it('short-circuits ai-edit with applied:false when the instruction is blank', async () => {
    const aiEdit = handlerOf('__docAiEdit');
    const result = await aiEdit({ documentId: 'doc_1', instruction: '   ' });
    expect(result).toEqual({ applied: false });
    expect(service.aiEdit).not.toHaveBeenCalled();
  });

  it('short-circuits ai-suggest with [] when the documentId is blank', async () => {
    const aiSuggest = handlerOf('__docAiSuggest');
    const result = await aiSuggest({ documentId: '', instruction: 'improve' });
    expect(result).toEqual([]);
    expect(service.aiSuggest).not.toHaveBeenCalled();
  });

  it('forwards a valid ai-edit request to the service', async () => {
    const aiEdit = handlerOf('__docAiEdit');
    await aiEdit({ documentId: 'doc_1', instruction: '  tighten  ' });
    expect(service.aiEdit).toHaveBeenCalledWith('doc_1', 'tighten');
  });
});

describe('documentsBridge.list - validation', () => {
  it('returns [] for a blank userId without calling the service', async () => {
    const list = handlerOf('__docList');
    const result = await list({ userId: '' });
    expect(result).toEqual([]);
    expect(service.list).not.toHaveBeenCalled();
  });
});
