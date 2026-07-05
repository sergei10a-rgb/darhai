/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { layeredFallback, reciprocalRankFusion, DEFAULT_VECTOR_MIN_SCORE } from '@process/services/semantic/fusion';
import type { SemanticHit } from '@process/services/semantic/types';

const vec = (id: string, score: number): SemanticHit => ({ id, score, source: 'vector' });
const kw = (id: string, score: number): SemanticHit => ({ id, score, source: 'keyword' });

describe('layeredFallback', () => {
  it('returns the vector ranking when the top vector hit is confident', () => {
    const vectorHits = [vec('a', 0.8), vec('b', 0.5)];
    const keywordHits = [kw('x', 10)];
    const result = layeredFallback(vectorHits, keywordHits);
    expect(result.map((h) => h.id)).toEqual(['a', 'b']);
    expect(result[0].source).toBe('vector');
  });

  it('falls back to keyword when the top vector score is below threshold', () => {
    const vectorHits = [vec('a', DEFAULT_VECTOR_MIN_SCORE - 0.01)];
    const keywordHits = [kw('x', 10), kw('y', 5)];
    const result = layeredFallback(vectorHits, keywordHits);
    expect(result.map((h) => h.id)).toEqual(['x', 'y']);
  });

  it('falls back to keyword when the vector lane is empty', () => {
    const result = layeredFallback([], [kw('x', 3)]);
    expect(result.map((h) => h.id)).toEqual(['x']);
  });

  it('returns empty when both lanes are empty', () => {
    expect(layeredFallback([], [])).toEqual([]);
  });

  it('respects a custom minVectorScore', () => {
    const vectorHits = [vec('a', 0.5)];
    const keywordHits = [kw('x', 1)];
    // Raise the bar above the vector score -> keyword wins.
    expect(layeredFallback(vectorHits, keywordHits, 0.9).map((h) => h.id)).toEqual(['x']);
    // Lower the bar -> vector wins.
    expect(layeredFallback(vectorHits, keywordHits, 0.1).map((h) => h.id)).toEqual(['a']);
  });
});

describe('reciprocalRankFusion', () => {
  it('ranks an id appearing high in both lists above single-list ids', () => {
    const vectorHits = [vec('shared', 0.9), vec('vonly', 0.8)];
    const keywordHits = [kw('shared', 10), kw('konly', 5)];
    const result = reciprocalRankFusion(vectorHits, keywordHits, 10);
    expect(result[0].id).toBe('shared');
  });

  it('marks source as vector when the id appeared in the vector list', () => {
    const result = reciprocalRankFusion([vec('a', 0.9)], [kw('a', 5), kw('b', 4)], 10);
    const a = result.find((h) => h.id === 'a');
    const b = result.find((h) => h.id === 'b');
    expect(a?.source).toBe('vector');
    expect(b?.source).toBe('keyword');
  });

  it('respects the limit', () => {
    const vectorHits = Array.from({ length: 20 }, (_, i) => vec(`v${i}`, 1 - i / 100));
    const result = reciprocalRankFusion(vectorHits, [], 5);
    expect(result).toHaveLength(5);
  });

  it('is deterministic regardless of raw score scale', () => {
    // Bounded cosine vs unbounded BM25 must not let BM25 magnitude dominate.
    const a = reciprocalRankFusion([vec('a', 0.9)], [kw('b', 9999)], 10);
    const b = reciprocalRankFusion([vec('a', 0.9)], [kw('b', 1)], 10);
    expect(a.map((h) => h.id)).toEqual(b.map((h) => h.id));
  });
});
