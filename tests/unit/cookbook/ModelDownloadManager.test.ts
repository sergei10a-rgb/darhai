/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  CookbookDownloadError,
  ModelDownloadManager,
  localGgufFileName,
  pickGgufFile,
  type CookbookDownloadDescriptor,
  type CookbookDownloadIo,
  type CookbookDownloadProgress,
} from '@process/services/cookbook/ModelDownloadManager';

const encoder = new TextEncoder();

/** A Response whose body streams the given chunks, with a content-length. */
const fileResponse = (chunks: Uint8Array[], opts: { omitContentLength?: boolean } = {}): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const headers = new Headers();
  if (!opts.omitContentLength) headers.set('content-length', String(total));
  return new Response(stream, { status: 200, headers });
};

/** A Response carrying the HF tree JSON. */
const treeResponse = (entries: unknown): Response =>
  new Response(JSON.stringify(entries), { status: 200, headers: { 'content-type': 'application/json' } });

const makeIo = (overrides: Partial<CookbookDownloadIo> = {}): CookbookDownloadIo => ({
  fetch: vi.fn(),
  exists: vi.fn(() => false),
  ensureDir: vi.fn(async () => undefined),
  openWrite: vi.fn(async () => ({ write: vi.fn(async () => undefined), close: vi.fn(async () => undefined) })),
  rename: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  ...overrides,
});

const descriptor = (over: Partial<CookbookDownloadDescriptor> = {}): CookbookDownloadDescriptor => ({
  modelId: 'org/Model',
  repo: 'org/Model-GGUF',
  quant: 'Q4_K_M',
  destDir: '/cache/gguf',
  ...over,
});

describe('pickGgufFile', () => {
  const tree = [
    { type: 'file', path: 'README.md', size: 10 },
    { type: 'file', path: 'model-Q2_K.gguf', size: 100 },
    { type: 'file', path: 'model-Q4_K_M.gguf', size: 400 },
    { type: 'file', path: 'model-Q8_0.gguf', size: 800 },
  ];

  it('picks the exact requested quant', () => {
    expect(pickGgufFile(tree, 'Q4_K_M')?.path).toBe('model-Q4_K_M.gguf');
  });

  it('matches quant ignoring separators/case (q4-k-m)', () => {
    expect(pickGgufFile(tree, 'q4-k-m')?.path).toBe('model-Q4_K_M.gguf');
  });

  it('falls back to the ranked default (Q4_K_M) when no quant requested', () => {
    expect(pickGgufFile(tree)?.path).toBe('model-Q4_K_M.gguf');
  });

  it('returns null when there is no .gguf file', () => {
    expect(pickGgufFile([{ type: 'file', path: 'config.json', size: 1 }])).toBeNull();
  });

  it('skips shard parts beyond the first', () => {
    const shards = [
      { type: 'file', path: 'model-Q4_K_M-00002-of-00003.gguf', size: 2 },
      { type: 'file', path: 'model-Q4_K_M-00001-of-00003.gguf', size: 1 },
    ];
    expect(pickGgufFile(shards, 'Q4_K_M')?.path).toBe('model-Q4_K_M-00001-of-00003.gguf');
  });
});

describe('ModelDownloadManager.resolveGgufFile', () => {
  it('picks the ranked quant file from a mocked HF tree and builds resolve URL + size', async () => {
    const io = makeIo({
      fetch: vi.fn(async () =>
        treeResponse([
          { type: 'file', path: 'model-Q4_K_M.gguf', size: 4096 },
          { type: 'file', path: 'model-Q8_0.gguf', size: 8192 },
        ])
      ),
    });
    const mgr = new ModelDownloadManager(io);
    const resolved = await mgr.resolveGgufFile('org/Model-GGUF', 'Q4_K_M');
    expect(resolved.url).toBe('https://huggingface.co/org/Model-GGUF/resolve/main/model-Q4_K_M.gguf');
    expect(resolved.fileName).toBe('model-Q4_K_M.gguf');
    expect(resolved.sizeBytes).toBe(4096);
  });

  it('throws COOKBOOK_DOWNLOAD_NO_GGUF when the repo has no .gguf', async () => {
    const io = makeIo({ fetch: vi.fn(async () => treeResponse([{ type: 'file', path: 'config.json', size: 1 }])) });
    const mgr = new ModelDownloadManager(io);
    const err = await mgr.resolveGgufFile('org/Empty').catch((e) => e);
    expect(err).toBeInstanceOf(CookbookDownloadError);
    expect(err.code).toBe('COOKBOOK_DOWNLOAD_NO_GGUF');
  });
});

describe('ModelDownloadManager.download', () => {
  it('short-circuits (cached) when the local .gguf already exists - no network', async () => {
    const io = makeIo({ exists: vi.fn(() => true) });
    const mgr = new ModelDownloadManager(io);
    const result = await mgr.download(descriptor());
    expect(result.cached).toBe(true);
    expect(result.filePath).toContain('org_Model.gguf');
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
  });

  it('resolves, streams cumulative progress, atomic-renames, and warns (unpinned sha)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chunks = [encoder.encode('hello '), encoder.encode('world')];
    const fetch = vi.fn(async (url: string) =>
      url.includes('/api/models')
        ? treeResponse([{ type: 'file', path: 'model-Q4_K_M.gguf', size: 11 }])
        : fileResponse(chunks)
    );
    const io = makeIo({ fetch: fetch as unknown as typeof globalThis.fetch });
    const mgr = new ModelDownloadManager(io);
    const progress: CookbookDownloadProgress[] = [];

    const result = await mgr.download(descriptor(), (p) => progress.push(p));

    expect(result.cached).toBe(false);
    expect(result.bytesWritten).toBe(11);
    expect(io.rename).toHaveBeenCalledWith(
      path.join('/cache/gguf', 'org_Model.gguf.tmp'),
      path.join('/cache/gguf', 'org_Model.gguf')
    );
    expect(io.unlink).not.toHaveBeenCalled();
    expect(progress.map((p) => p.bytesDownloaded)).toEqual([6, 11]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without integrity check'));
    warn.mockRestore();
  });

  it('uses the resolved size hint when Content-Length is absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(async (url: string) =>
      url.includes('/api/models')
        ? treeResponse([{ type: 'file', path: 'model-Q4_K_M.gguf', size: 999 }])
        : fileResponse([encoder.encode('abc')], { omitContentLength: true })
    );
    const io = makeIo({ fetch: fetch as unknown as typeof globalThis.fetch });
    const mgr = new ModelDownloadManager(io);
    const progress: CookbookDownloadProgress[] = [];
    await mgr.download(descriptor(), (p) => progress.push(p));
    expect(progress[0].totalBytes).toBe(999);
    vi.restoreAllMocks();
  });

  it('unlinks the .tmp and surfaces OFFLINE when the file fetch throws', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/models')) return treeResponse([{ type: 'file', path: 'model-Q4_K_M.gguf', size: 4 }]);
      throw new Error('ENOTFOUND huggingface.co');
    });
    const io = makeIo({ fetch: fetch as unknown as typeof globalThis.fetch });
    const mgr = new ModelDownloadManager(io);
    const err = await mgr.download(descriptor()).catch((e) => e);
    expect(err.code).toBe('COOKBOOK_DOWNLOAD_OFFLINE');
    expect(io.unlink).toHaveBeenCalledWith(path.join('/cache/gguf', 'org_Model.gguf.tmp'));
    expect(io.rename).not.toHaveBeenCalled();
  });

  it('honours a pre-aborted signal with COOKBOOK_DOWNLOAD_CANCELLED', async () => {
    const io = makeIo();
    const mgr = new ModelDownloadManager(io);
    const ac = new AbortController();
    ac.abort();
    const err = await mgr.download(descriptor(), undefined, ac.signal).catch((e) => e);
    expect(err.code).toBe('COOKBOOK_DOWNLOAD_CANCELLED');
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it('cancel() returns false when no download with the id is in flight', () => {
    expect(new ModelDownloadManager(makeIo()).cancel('nope')).toBe(false);
  });
});

describe('localGgufFileName', () => {
  it('sanitizes the model name into a safe .gguf stem', () => {
    expect(localGgufFileName('org/Model:v2')).toBe('org_Model_v2.gguf');
  });
});
