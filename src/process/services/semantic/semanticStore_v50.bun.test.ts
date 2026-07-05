// src/process/services/semantic/semanticStore_v50.bun.test.ts
// Run with: bun test src/process/services/semantic/semanticStore_v50.bun.test.ts
//
// Bun-runtime INTEGRATION test for the semantic vector path. Unlike the pure
// unit tests (which fake the store), this loads the REAL sqlite-vec extension
// via BunSqliteDriver and exercises actual vec0 KNN search, plus the
// HybridRetriever wired to that real store. Runs under Bun because better-sqlite3
// ABI-mismatches there and bun:sqlite ships native loadable-extension support.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunSqliteDriver } from '../database/drivers/BunSqliteDriver';
import { SqliteVecStore } from './SqliteVecStore';
import { HybridRetriever, type KeywordLane } from './HybridRetriever';
import type { EmbeddingService } from './EmbeddingService';
import type { EmbeddingRecord, SemanticHit } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string };

const DIM = 3;

function realStore(driver: BunSqliteDriver): SqliteVecStore {
  return SqliteVecStore.create(driver, DIM, sqliteVec.getLoadablePath());
}

function vec(a: number[]): Float32Array {
  return Float32Array.from(a);
}

/** A fake embedder: query → fixed vector, docs → caller-provided vectors. */
function fakeEmbedder(queryVec: Float32Array | null, docVecs: Float32Array[] | null): EmbeddingService {
  return {
    modelId: 'fake-model',
    dimension: DIM,
    isDegraded: () => false,
    isReady: () => true,
    ensureLoaded: async () => {},
    embedQuery: async () => queryVec,
    embedDocuments: async () => docVecs,
  } as unknown as EmbeddingService;
}

const staticKeywordLane =
  (hits: SemanticHit[]): KeywordLane =>
  () =>
    hits;

describe('SqliteVecStore + sqlite-vec (real KNN, bun:sqlite)', () => {
  let driver: BunSqliteDriver;

  beforeEach(() => {
    driver = new BunSqliteDriver(':memory:');
  });
  afterEach(() => driver.close());

  it('loads the extension and reports available', () => {
    const store = realStore(driver);
    expect(store.isAvailable()).toBe(true);
  });

  it('upserts vectors and returns nearest neighbours by cosine', () => {
    const store = realStore(driver);
    const records: EmbeddingRecord[] = [
      { id: 'x', fingerprint: 'fx', vector: vec([1, 0, 0]) },
      { id: 'y', fingerprint: 'fy', vector: vec([0, 1, 0]) },
      { id: 'z', fingerprint: 'fz', vector: vec([0.9, 0.1, 0]) },
    ];
    store.upsert('skills', records);

    const hits = store.search('skills', vec([1, 0, 0]), 2);
    expect(hits.map((h) => h.id)).toEqual(['x', 'z']); // x exact, z closest after
    expect(hits[0].source).toBe('vector');
    expect(hits[0].score).toBeGreaterThan(0.99); // near-identical → high similarity
  });

  it('roundtrips fingerprints via the shadow table', () => {
    const store = realStore(driver);
    store.upsert('memory', [{ id: 'm1', fingerprint: 'fp-1', vector: vec([1, 0, 0]) }]);
    const fps = store.fingerprints('memory');
    expect(fps.get('m1')).toBe('fp-1');
    expect(store.count('memory')).toBe(1);
  });

  it('remove() deletes from both the vec0 and shadow tables', () => {
    const store = realStore(driver);
    store.upsert('skills', [{ id: 'gone', fingerprint: 'g', vector: vec([1, 0, 0]) }]);
    store.remove('skills', ['gone']);
    expect(store.count('skills')).toBe(0);
    expect(store.search('skills', vec([1, 0, 0]), 5)).toEqual([]);
  });

  it('keeps skills and memory namespaces isolated', () => {
    const store = realStore(driver);
    store.upsert('skills', [{ id: 's', fingerprint: 'a', vector: vec([1, 0, 0]) }]);
    store.upsert('memory', [{ id: 'm', fingerprint: 'b', vector: vec([1, 0, 0]) }]);
    expect(store.search('skills', vec([1, 0, 0]), 5).map((h) => h.id)).toEqual(['s']);
    expect(store.search('memory', vec([1, 0, 0]), 5).map((h) => h.id)).toEqual(['m']);
  });

  it('throws on an out-of-whitelist namespace (SQL-injection guard)', () => {
    const store = realStore(driver);
    // Cast past the type system the way a future regression might.
    expect(() => store.search('robert); DROP TABLE vec_skills;--' as never, vec([1, 0, 0]), 1)).toThrow(
      /unknown namespace/
    );
  });
});

describe('HybridRetriever over a real vec store (bun:sqlite)', () => {
  let driver: BunSqliteDriver;

  beforeEach(() => {
    driver = new BunSqliteDriver(':memory:');
  });
  afterEach(() => driver.close());

  it('reindexes then serves confident vector hits from the real KNN index', async () => {
    const store = realStore(driver);
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(vec([1, 0, 0]), [vec([1, 0, 0]), vec([0, 1, 0])]),
      store,
      keyword: staticKeywordLane([{ id: 'kw', score: 1, source: 'keyword' }]),
    });

    const report = await r.reindex([
      { id: 'alpha', text: 'alpha' },
      { id: 'beta', text: 'beta' },
    ]);
    expect(report.embedded).toBe(2);

    // Query vector == alpha's vector → confident vector hit wins over keyword.
    const hits = await r.retrieve('q', 3);
    expect(hits[0].id).toBe('alpha');
    expect(hits[0].source).toBe('vector');
  });

  it('degrades to the keyword lane when the query embedding is offline (real store)', async () => {
    const store = realStore(driver);
    const r = new HybridRetriever({
      namespace: 'memory',
      embedder: fakeEmbedder(null, [vec([1, 0, 0])]), // query embed returns null
      store,
      keyword: staticKeywordLane([{ id: 'kw', score: 2, source: 'keyword' }]),
    });
    await r.reindex([{ id: 'a', text: 'a' }]);

    const hits = await r.retrieve('q', 3);
    expect(hits.map((h) => h.id)).toEqual(['kw']);
  });

  it('reindex is fingerprint-incremental against the real shadow table', async () => {
    const store = realStore(driver);
    const r = new HybridRetriever({
      namespace: 'skills',
      embedder: fakeEmbedder(vec([1, 0, 0]), [vec([1, 0, 0])]),
      store,
      keyword: staticKeywordLane([]),
    });

    const first = await r.reindex([{ id: 'a', text: 'alpha' }]);
    expect(first.embedded).toBe(1);

    // Same corpus → fingerprint match → skipped, nothing re-embedded.
    const second = await r.reindex([{ id: 'a', text: 'alpha' }]);
    expect(second.skipped).toBe(1);
    expect(second.embedded).toBe(0);
  });
});
