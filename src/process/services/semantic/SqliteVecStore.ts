/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SqliteVecStore - persistent vector index backed by sqlite-vec (vec0) inside
 * the SAME better-sqlite3 database as everything else. No separate process, no
 * separate file.
 *
 * Per namespace ('skills' | 'memory') there are two tables:
 *   - `vec_<ns>`      : a vec0 virtual table holding the id + embedding, queried
 *                       with cosine distance for KNN search.
 *   - `vec_<ns>_meta` : a plain shadow table mapping id -> fingerprint, so a
 *                       backfill can skip documents whose text is unchanged
 *                       (vec0 can't be SELECTed for arbitrary columns cheaply).
 *
 * The extension is loaded once via the driver's `loadExtension`. If loading
 * fails (extension missing, disabled, or the platform binary is absent) the
 * store reports `available = false` and every method is a safe no-op / empty
 * result, so the hybrid retriever transparently falls back to keyword search.
 */

import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import type { EmbeddingRecord, SemanticHit, SemanticNamespace } from './types';

const NAMESPACES: readonly SemanticNamespace[] = ['skills', 'memory'];

/**
 * Assert a namespace is one of the known values before it is interpolated into
 * SQL. `ns` is a compile-time union today, but this guards against a future
 * caller (or an `as` cast) smuggling an arbitrary string into a table name -
 * turning a type regression into a hard throw rather than a SQL-injection hole.
 */
function assertNamespace(ns: SemanticNamespace): SemanticNamespace {
  if (!NAMESPACES.includes(ns)) {
    throw new Error(`[SqliteVecStore] unknown namespace: ${String(ns)}`);
  }
  return ns;
}

/** Serialize a Float32Array to the little-endian byte blob vec0 expects. */
function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export class SqliteVecStore {
  private available = false;
  private readonly dim: number;

  private constructor(
    private readonly db: ISqliteDriver,
    dim: number
  ) {
    this.dim = dim;
  }

  /**
   * Create a store, loading the sqlite-vec extension and creating the vec0 +
   * shadow tables. Never throws: on any failure the returned store is
   * `available = false` and the caller falls back to keyword retrieval.
   *
   * @param loadablePath absolute path to the sqlite-vec loadable extension
   *                     (from `require('sqlite-vec').getLoadablePath()`)
   */
  static create(db: ISqliteDriver, dim: number, loadablePath: string): SqliteVecStore {
    const store = new SqliteVecStore(db, dim);
    try {
      if (typeof db.loadExtension !== 'function') {
        throw new Error('driver does not support loadExtension');
      }
      db.loadExtension(loadablePath);
      store.ensureSchema();
      store.available = true;
    } catch (err) {
      console.warn('[SqliteVecStore] sqlite-vec unavailable - vector index disabled, keyword fallback active:', err);
      store.available = false;
    }
    return store;
  }

  /** True when the vector index is usable. False ⇒ callers must use keyword search. */
  isAvailable(): boolean {
    return this.available;
  }

  private ensureSchema(): void {
    for (const ns of NAMESPACES) {
      // The `vec_<ns>` vec0 virtual table can ONLY be created here: it needs the
      // sqlite-vec extension loaded, which the plain migration runner does not
      // have. distance_metric=cosine so KNN `distance` is cosine distance in
      // [0, 2]; similarity = 1 - distance. Vectors are pre-normalized by the
      // embedder.
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${ns} USING vec0(` +
          `id TEXT PRIMARY KEY, embedding float[${this.dim}] distance_metric=cosine)`
      );
      // Ownership note: the `vec_<ns>_meta` shadow tables are OWNED by migration
      // v50 (schema lives with migrations). This IF NOT EXISTS is only an
      // idempotent safety net for a store constructed before migrations ran
      // (e.g. a bare test driver); it must stay identical to the v50 definition.
      this.db.exec(`CREATE TABLE IF NOT EXISTS vec_${ns}_meta (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`);
    }
  }

  /** Return id -> fingerprint for every stored doc in a namespace. */
  fingerprints(ns: SemanticNamespace): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.available) return out;
    assertNamespace(ns);
    const rows = this.db.prepare(`SELECT id, fingerprint FROM vec_${ns}_meta`).all() as Array<{
      id: string;
      fingerprint: string;
    }>;
    for (const r of rows) out.set(r.id, r.fingerprint);
    return out;
  }

  /**
   * Upsert a batch of embedding records (id, fingerprint, vector). Wrapped in a
   * single transaction for throughput. vec0 has no UPSERT, so we DELETE then
   * INSERT per id.
   */
  upsert(ns: SemanticNamespace, records: readonly EmbeddingRecord[]): void {
    if (!this.available || records.length === 0) return;
    assertNamespace(ns);
    const delVec = this.db.prepare(`DELETE FROM vec_${ns} WHERE id = ?`);
    const insVec = this.db.prepare(`INSERT INTO vec_${ns}(id, embedding) VALUES (?, ?)`);
    const upMeta = this.db.prepare(
      `INSERT INTO vec_${ns}_meta(id, fingerprint) VALUES (?, ?) ` +
        `ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint`
    );
    const run = this.db.transaction((batch: readonly EmbeddingRecord[]) => {
      for (const rec of batch) {
        delVec.run(rec.id);
        insVec.run(rec.id, toBlob(rec.vector));
        upMeta.run(rec.id, rec.fingerprint);
      }
    });
    run(records);
  }

  /** Remove ids that no longer exist in the source corpus. */
  remove(ns: SemanticNamespace, ids: readonly string[]): void {
    if (!this.available || ids.length === 0) return;
    assertNamespace(ns);
    const delVec = this.db.prepare(`DELETE FROM vec_${ns} WHERE id = ?`);
    const delMeta = this.db.prepare(`DELETE FROM vec_${ns}_meta WHERE id = ?`);
    const run = this.db.transaction((batch: readonly string[]) => {
      for (const id of batch) {
        delVec.run(id);
        delMeta.run(id);
      }
    });
    run(ids);
  }

  /**
   * KNN search: return up to `limit` nearest ids by cosine similarity. vec0
   * returns cosine `distance`; we convert to a [0, 1] similarity score.
   */
  search(ns: SemanticNamespace, queryVector: Float32Array, limit: number): SemanticHit[] {
    if (!this.available) return [];
    assertNamespace(ns);
    const rows = this.db
      .prepare(`SELECT id, distance FROM vec_${ns} ` + `WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
      .all(toBlob(queryVector), limit) as Array<{ id: string; distance: number }>;
    return rows.map((r) => ({
      id: r.id,
      // cosine distance -> similarity, clamped to [0, 1] for a stable score.
      score: Math.max(0, Math.min(1, 1 - r.distance)),
      source: 'vector' as const,
    }));
  }

  /** Number of vectors stored in a namespace (for diagnostics / stats). */
  count(ns: SemanticNamespace): number {
    if (!this.available) return 0;
    assertNamespace(ns);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM vec_${ns}_meta`).get() as { n: number };
    return row?.n ?? 0;
  }
}
