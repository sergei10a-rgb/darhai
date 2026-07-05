/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { HybridRetriever, MAX_REINDEX_DOCS, type KeywordLane } from '@process/services/semantic/HybridRetriever';
import type { EmbeddingService } from '@process/services/semantic/EmbeddingService';
import type { SqliteVecStore } from '@process/services/semantic/SqliteVecStore';
import type { SemanticHit } from '@process/services/semantic/types';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type EmbedderOpts = { degraded?: boolean; queryVec?: Float32Array | null; docVecs?: Float32Array[] | null };

function fakeEmbedder(opts: EmbedderOpts = {}): EmbeddingService {
  return {
    modelId: 'fake-model',
    dimension: 3,
    isDegraded: () => opts.degraded ?? false,
    isReady: () => !(opts.degraded ?? false),
    ensureLoaded: vi.fn(async () => {}),
    embedQuery: vi.fn(async () => (opts.queryVec === undefined ? Float32Array.from([1, 0, 0]) : opts.queryVec)),
    embedDocuments: vi.fn(async () => (opts.docVecs === undefined ? [] : opts.docVecs)),
  } as unknown as EmbeddingService;
}

type StoreOpts = { available?: boolean; searchHits?: SemanticHit[]; fingerprints?: Map<string, string> };

function fakeStore(opts: StoreOpts = {}): SqliteVecStore & { _upserts: unknown[]; _removed: string[] } {
  const upserts: unknown[] = [];
  const removed: string[] = [];
  const store = {
    isAvailable: () => opts.available ?? true,
    fingerprints: () => opts.fingerprints ?? new Map<string, string>(),
    search: () => opts.searchHits ?? [],
    upsert: (_ns: string, records: unknown[]) => upserts.push(...records),
    remove: (_ns: string, ids: string[]) => removed.push(...ids),
    count: () => 0,
    _upserts: upserts,
    _removed: removed,
  };
  return store as unknown as SqliteVecStore & { _upserts: unknown[]; _removed: string[] };
}

const keywordLane =
  (hits: SemanticHit[]): KeywordLane =>
  () =>
    hits;

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

describe('HybridRetriever.retrieve', () => {
  it('returns keyword hits when the store is unavailable', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(),
      store: fakeStore({ available: false }),
      keyword: keywordLane([{ id: 'kw', score: 5, source: 'keyword' }]),
    });
    const hits = await r.retrieve('q', 5);
    expect(hits.map((h) => h.id)).toEqual(['kw']);
  });

  it('returns keyword hits when the embedder is degraded (offline model)', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder({ degraded: true }),
      store: fakeStore({ available: true, searchHits: [{ id: 'vec', score: 0.9, source: 'vector' }] }),
      keyword: keywordLane([{ id: 'kw', score: 5, source: 'keyword' }]),
    });
    const hits = await r.retrieve('q', 5);
    expect(hits.map((h) => h.id)).toEqual(['kw']);
  });

  it('prefers confident vector hits over keyword hits', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(),
      store: fakeStore({ available: true, searchHits: [{ id: 'vec', score: 0.85, source: 'vector' }] }),
      keyword: keywordLane([{ id: 'kw', score: 5, source: 'keyword' }]),
    });
    const hits = await r.retrieve('q', 5);
    expect(hits[0].id).toBe('vec');
    expect(hits[0].source).toBe('vector');
  });

  it('falls back to keyword when the query embedding is null (offline query)', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder({ queryVec: null }),
      store: fakeStore({ available: true, searchHits: [{ id: 'vec', score: 0.9, source: 'vector' }] }),
      keyword: keywordLane([{ id: 'kw', score: 5, source: 'keyword' }]),
    });
    const hits = await r.retrieve('q', 5);
    expect(hits.map((h) => h.id)).toEqual(['kw']);
  });

  it('falls back to keyword when the vector search returns nothing', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(),
      store: fakeStore({ available: true, searchHits: [] }),
      keyword: keywordLane([{ id: 'kw', score: 5, source: 'keyword' }]),
    });
    const hits = await r.retrieve('q', 5);
    expect(hits.map((h) => h.id)).toEqual(['kw']);
  });

  it('does not throw when the keyword lane throws - returns vector hits', async () => {
    const r = new HybridRetriever({
      namespace: 'memory',
      embedder: fakeEmbedder(),
      store: fakeStore({ available: true, searchHits: [{ id: 'vec', score: 0.9, source: 'vector' }] }),
      keyword: () => {
        throw new Error('keyword boom');
      },
    });
    const hits = await r.retrieve('q', 5);
    expect(hits[0].id).toBe('vec');
  });
});

// ---------------------------------------------------------------------------
// reindex
// ---------------------------------------------------------------------------

describe('HybridRetriever.reindex', () => {
  it('reports degraded and does nothing when the store is unavailable', async () => {
    const store = fakeStore({ available: false });
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(),
      store,
      keyword: keywordLane([]),
    });
    const report = await r.reindex([{ id: 'a', text: 'hello' }]);
    expect(report.degraded).toBe(true);
    expect(store._upserts).toHaveLength(0);
  });

  it('embeds new docs and upserts them', async () => {
    const store = fakeStore({ available: true, fingerprints: new Map() });
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder({ docVecs: [Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0])] }),
      store,
      keyword: keywordLane([]),
    });
    const report = await r.reindex([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ]);
    expect(report.embedded).toBe(2);
    expect(store._upserts).toHaveLength(2);
  });

  it('skips docs whose fingerprint is unchanged', async () => {
    // Precompute the fingerprint the retriever will produce for this doc.
    const { computeFingerprint } = await import('@process/services/semantic/fingerprint');
    const fp = computeFingerprint('alpha', 'fake-model', 3);
    const store = fakeStore({ available: true, fingerprints: new Map([['a', fp]]) });
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder({ docVecs: [] }),
      store,
      keyword: keywordLane([]),
    });
    const report = await r.reindex([{ id: 'a', text: 'alpha' }]);
    expect(report.skipped).toBe(1);
    expect(report.embedded).toBe(0);
  });

  it('prunes ids that disappeared from the corpus', async () => {
    const store = fakeStore({ available: true, fingerprints: new Map([['gone', 'oldfp']]) });
    const r = new HybridRetriever({
      namespace: 'memory',
      embedder: fakeEmbedder({ docVecs: [Float32Array.from([1, 0, 0])] }),
      store,
      keyword: keywordLane([]),
    });
    const report = await r.reindex([{ id: 'new', text: 'fresh' }]);
    expect(report.removed).toBe(1);
    expect(store._removed).toEqual(['gone']);
  });

  it('caps a pathologically large corpus at MAX_REINDEX_DOCS in one pass', async () => {
    const store = fakeStore({ available: true, fingerprints: new Map() });
    // Embedder returns exactly one vector per input it is handed, so we can
    // assert the batch it received was capped.
    const embedder = {
      modelId: 'fake-model',
      dimension: 3,
      isDegraded: () => false,
      isReady: () => true,
      ensureLoaded: vi.fn(async () => {}),
      embedQuery: vi.fn(async () => Float32Array.from([1, 0, 0])),
      embedDocuments: vi.fn(async (texts: readonly string[]) => texts.map(() => Float32Array.from([1, 0, 0]))),
    } as unknown as EmbeddingService;
    const r = new HybridRetriever({ namespace: 'skills', embedder, store, keyword: keywordLane([]) });

    const docs = Array.from({ length: MAX_REINDEX_DOCS + 25 }, (_, i) => ({ id: `d${i}`, text: `t${i}` }));
    const report = await r.reindex(docs);

    expect(report.embedded).toBe(MAX_REINDEX_DOCS);
    expect(store._upserts).toHaveLength(MAX_REINDEX_DOCS);
  });
});

// ---------------------------------------------------------------------------
// setKeyword (corpus-freshness rebinding)
// ---------------------------------------------------------------------------

describe('HybridRetriever.setKeyword', () => {
  it('rebinds the keyword lane so a later query ranks against the fresh corpus', async () => {
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder({ degraded: true }), // force keyword-only
      store: fakeStore({ available: false }),
      keyword: keywordLane([{ id: 'stale', score: 1, source: 'keyword' }]),
    });
    expect((await r.retrieve('q', 5)).map((h) => h.id)).toEqual(['stale']);

    // A fresh corpus snapshot arrives (e.g. a new skill was added).
    r.setKeyword(keywordLane([{ id: 'fresh', score: 1, source: 'keyword' }]));
    expect((await r.retrieve('q', 5)).map((h) => h.id)).toEqual(['fresh']);
  });
});
