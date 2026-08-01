/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure fusion / layered-fallback logic. No I/O, no embeddings - just rank
 * combination so it is trivially unit-testable.
 *
 * Two strategies are exposed:
 *
 *   - `layeredFallback`: return the vector ranking when it is confident enough,
 *     otherwise the keyword ranking. Simple and predictable - this is the core
 *     of the design (vector first, keyword when vector is empty/offline/weak).
 *
 *   - `reciprocalRankFusion`: blend both rankings by RRF when both are present.
 *     Better recall, still deterministic. Used opportunistically when the
 *     vector lane returned results but we also want keyword signal.
 */

import type { SemanticHit } from './types';

/** Minimum cosine similarity for the top vector hit to be considered trustworthy. */
export const DEFAULT_VECTOR_MIN_SCORE = 0.35;

/** RRF damping constant (standard k = 60 from the TREC literature). */
const RRF_K = 60;

/**
 * Layered fallback: prefer the vector ranking, fall back to keyword.
 *
 * The threshold is applied PER HIT, not just to the top one. Gating on
 * `vectorHits[0]` alone and then returning the whole list meant a single
 * moderately-similar top hit dragged every other candidate in with it - with
 * `k = min(corpus, 50)` that is the entire corpus, which is exactly what the
 * memory search box did for every query, gibberish included.
 *
 * A vector list whose every hit is below `minVectorScore` (offline model, cold
 * index, off-topic query) yields to the keyword lane, which never regresses
 * below the previous BM25 behavior.
 */
export function layeredFallback(
  vectorHits: readonly SemanticHit[],
  keywordHits: readonly SemanticHit[],
  minVectorScore: number = DEFAULT_VECTOR_MIN_SCORE
): SemanticHit[] {
  const confident = vectorHits.filter((hit) => hit.score >= minVectorScore);
  return confident.length > 0 ? confident : [...keywordHits];
}

/**
 * Reciprocal Rank Fusion of two rankings. Each list contributes 1/(k + rank) to
 * every id it contains; the merged list is sorted by summed contribution. Ids
 * appearing high in both lists float to the top. Deterministic and score-scale
 * independent, so it safely blends bounded cosine with unbounded BM25.
 *
 * @returns fused hits with a synthetic RRF `score`; `source` is 'vector' when
 *          the id appeared in the vector list at all, else 'keyword'.
 */
export function reciprocalRankFusion(
  vectorHits: readonly SemanticHit[],
  keywordHits: readonly SemanticHit[],
  limit: number
): SemanticHit[] {
  const contribution = new Map<string, number>();
  const fromVector = new Set<string>();

  vectorHits.forEach((hit, rank) => {
    contribution.set(hit.id, (contribution.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
    fromVector.add(hit.id);
  });
  keywordHits.forEach((hit, rank) => {
    contribution.set(hit.id, (contribution.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
  });

  return [...contribution.entries()]
    .map(([id, score]): SemanticHit => ({ id, score, source: fromVector.has(id) ? 'vector' : 'keyword' }))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);
}
