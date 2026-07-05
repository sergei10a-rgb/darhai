/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the semantic (hybrid vector + keyword) retrieval subsystem.
 *
 * The design is a layered-fallback: vector similarity first, keyword/BM25
 * second. Every type here is process-agnostic (no Electron / DOM imports) so
 * the pure logic (fingerprint, fusion) can be unit-tested in isolation.
 */

/** A document to index: stable id + the text whose embedding we store. */
export type SemanticDoc = {
  /** Stable identity of the document within its namespace. */
  id: string;
  /** The text to embed (name + description + tags for skills, summary + body for memory). */
  text: string;
};

/** Which corpus a vector belongs to. Keeps skills and memory in separate tables. */
export type SemanticNamespace = 'skills' | 'memory';

/** Where a retrieval hit came from - lets callers reason about confidence and debug fallback. */
export type RetrievalSource = 'vector' | 'keyword';

/** A single retrieval result, normalized across vector and keyword lanes. */
export type SemanticHit = {
  id: string;
  /**
   * Normalized relevance score. For vector hits this is cosine similarity in
   * [0, 1]; for keyword hits it is the raw BM25 score (unbounded). Callers must
   * not compare scores ACROSS sources - `source` disambiguates.
   */
  score: number;
  source: RetrievalSource;
};

/** Persisted per-document embedding record (mirrors the vec0 + shadow table rows). */
export type EmbeddingRecord = {
  id: string;
  /** Fingerprint of the source text at embed time - lets us skip re-embedding unchanged docs. */
  fingerprint: string;
  /** The embedding vector (already L2-normalized so dot-product == cosine). */
  vector: Float32Array;
};

/** Result of a backfill/index pass over a namespace. */
export type IndexReport = {
  namespace: SemanticNamespace;
  /** Documents newly embedded or re-embedded (fingerprint changed). */
  embedded: number;
  /** Documents skipped because their fingerprint was unchanged. */
  skipped: number;
  /** Stale rows removed (doc no longer present in the source corpus). */
  removed: number;
  /** True when the vector path was unavailable and the pass was a no-op. */
  degraded: boolean;
};
