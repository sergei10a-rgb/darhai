/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HybridRetriever - namespace-agnostic orchestrator for layered-fallback
 * retrieval over one corpus (skills or memory).
 *
 * Wiring:
 *   - EmbeddingService produces query/document vectors (or null when offline).
 *   - SqliteVecStore holds the persistent vec0 index and does KNN search.
 *   - A caller-supplied `keyword` function is the always-available lane
 *     (BM25 for skills, substring for memory) - it never depends on the model.
 *
 * Retrieval order (the core of the design):
 *   1. If the model + index are available, run vector KNN.
 *   2. Run the keyword lane.
 *   3. Fuse: prefer vector when its top hit is confident (layered fallback);
 *      otherwise return keyword. This never regresses below the prior
 *      keyword-only behavior - offline, cold-index, and off-topic queries all
 *      resolve through keyword.
 *
 * Indexing is fingerprint-driven: unchanged docs are skipped, changed docs are
 * re-embedded, and removed docs are pruned. A full pass yields to the event
 * loop (via the embedder's batching) so it can run in the background without
 * freezing the main process.
 */

import type { EmbeddingService } from './EmbeddingService';
import type { SqliteVecStore } from './SqliteVecStore';
import { computeFingerprint } from './fingerprint';
import { layeredFallback, reciprocalRankFusion } from './fusion';
import type { EmbeddingRecord, IndexReport, SemanticDoc, SemanticHit, SemanticNamespace } from './types';

/** A keyword lane: given a query and limit, return ranked hits. Always available. */
export type KeywordLane = (query: string, limit: number) => SemanticHit[];

/**
 * Upper bound on documents embedded in a single reindex pass. The real corpora
 * are ~2k skills and a slowly-growing memory set, so this only ever trips on a
 * pathological/attacker-crafted corpus. Capping bounds the inference budget of
 * one pass (each doc is an ONNX forward); excess docs are simply skipped this
 * pass and picked up on a later one once the corpus normalizes.
 */
export const MAX_REINDEX_DOCS = 20000;

export type HybridRetrieverOptions = {
  namespace: SemanticNamespace;
  embedder: EmbeddingService;
  store: SqliteVecStore;
  /** The always-available keyword ranking (BM25 / substring). */
  keyword: KeywordLane;
  /**
   * 'fallback' (default): vector when confident, else keyword.
   * 'rrf': blend vector + keyword by reciprocal rank fusion when both exist.
   */
  strategy?: 'fallback' | 'rrf';
};

export class HybridRetriever {
  private readonly namespace: SemanticNamespace;
  private readonly embedder: EmbeddingService;
  private readonly store: SqliteVecStore;
  // Mutable: the keyword lane is rebound on every getRetriever() call so a
  // cached retriever never ranks against a stale corpus snapshot. The embedder
  // and store are expensive shared singletons; only the (cheap, per-corpus)
  // keyword lane is swapped.
  private keyword: KeywordLane;
  private readonly strategy: 'fallback' | 'rrf';

  constructor(opts: HybridRetrieverOptions) {
    this.namespace = opts.namespace;
    this.embedder = opts.embedder;
    this.store = opts.store;
    this.keyword = opts.keyword;
    this.strategy = opts.strategy ?? 'fallback';
  }

  /**
   * Rebind the keyword lane to a fresh corpus snapshot. Called whenever the
   * caller hands in a lane built over an updated corpus, so a cached retriever
   * always ranks keywords against current skills/memory - not the first snapshot
   * it happened to be constructed with.
   */
  setKeyword(keyword: KeywordLane): void {
    this.keyword = keyword;
  }

  /**
   * Retrieve the top `limit` hits for a query, hybrid vector + keyword.
   *
   * The keyword lane is always computed (cheap, in-memory). The vector lane is
   * attempted only when the store is available; a null query embedding (offline
   * model) silently skips it. Fusion then decides the final ranking.
   */
  async retrieve(query: string, limit: number): Promise<SemanticHit[]> {
    const keywordHits = this.safeKeyword(query, limit);

    if (!this.store.isAvailable() || this.embedder.isDegraded()) {
      return keywordHits;
    }

    let vectorHits: SemanticHit[] = [];
    try {
      const qVec = await this.embedder.embedQuery(query);
      if (qVec) {
        vectorHits = this.store.search(this.namespace, qVec, limit);
      }
    } catch (err) {
      // Any inference/search failure degrades to keyword for this query only.
      console.warn(`[HybridRetriever:${this.namespace}] vector lane failed, using keyword:`, err);
      vectorHits = [];
    }

    if (vectorHits.length === 0) return keywordHits;

    return this.strategy === 'rrf'
      ? reciprocalRankFusion(vectorHits, keywordHits, limit)
      : layeredFallback(vectorHits, keywordHits);
  }

  private safeKeyword(query: string, limit: number): SemanticHit[] {
    try {
      return this.keyword(query, limit);
    } catch (err) {
      console.warn(`[HybridRetriever:${this.namespace}] keyword lane threw:`, err);
      return [];
    }
  }

  /**
   * Backfill / update the vector index for the current corpus. Fingerprint-
   * driven: only new or changed docs are embedded, stale ids are pruned. Safe to
   * call repeatedly; a no-op when the store or model is unavailable (returns a
   * `degraded` report).
   *
   * Intended to run in the background (fire-and-forget) after the corpus loads
   * and whenever it changes. The embedder batches + yields internally, so this
   * does not block the event loop for long stretches.
   */
  async reindex(docs: readonly SemanticDoc[]): Promise<IndexReport> {
    const report: IndexReport = {
      namespace: this.namespace,
      embedded: 0,
      skipped: 0,
      removed: 0,
      degraded: false,
    };

    if (!this.store.isAvailable()) {
      report.degraded = true;
      return report;
    }

    const existing = this.store.fingerprints(this.namespace);
    const model = this.embedder.modelId;
    const dim = this.embedder.dimension;

    // Partition into unchanged (skip) vs new/changed (embed).
    const toEmbed: SemanticDoc[] = [];
    const fingerprintById = new Map<string, string>();
    const liveIds = new Set<string>();

    for (const doc of docs) {
      liveIds.add(doc.id);
      const fp = computeFingerprint(doc.text, model, dim);
      fingerprintById.set(doc.id, fp);
      if (existing.get(doc.id) === fp) {
        report.skipped += 1;
      } else {
        toEmbed.push(doc);
      }
    }

    // Prune ids that vanished from the corpus.
    const staleIds = [...existing.keys()].filter((id) => !liveIds.has(id));
    if (staleIds.length > 0) {
      this.store.remove(this.namespace, staleIds);
      report.removed = staleIds.length;
    }

    if (toEmbed.length === 0) return report;

    // Bound one pass so a pathologically large corpus can't launch an unbounded
    // batch of ONNX forwards. The overflow is left for a subsequent pass.
    let batch = toEmbed;
    if (batch.length > MAX_REINDEX_DOCS) {
      console.warn(
        `[HybridRetriever:${this.namespace}] reindex batch of ${batch.length} exceeds cap ${MAX_REINDEX_DOCS}; ` +
          'embedding the first slice this pass, remainder deferred.'
      );
      batch = batch.slice(0, MAX_REINDEX_DOCS);
    }

    const vectors = await this.embedder.embedDocuments(batch.map((d) => d.text));
    if (!vectors) {
      // Model became unavailable mid-pass: report degraded, keep what we had.
      report.degraded = true;
      return report;
    }

    const records: EmbeddingRecord[] = batch.map((doc, i) => ({
      id: doc.id,
      fingerprint: fingerprintById.get(doc.id) as string,
      vector: vectors[i],
    }));
    this.store.upsert(this.namespace, records);
    report.embedded = records.length;
    return report;
  }
}
