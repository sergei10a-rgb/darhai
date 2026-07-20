/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import {
  costOptimized,
  leastUsed,
  p2c,
  priority,
  roundRobin,
  weighted,
  type RoutingCandidate,
  type RoutingCandidatePricing,
} from '@process/services/routing/strategies';

function provider(id: string): IProvider {
  return { id, platform: id, name: id, baseUrl: '', apiKey: 'sk-x', model: [] };
}

function cand(id: string, modelId: string, pricing?: RoutingCandidatePricing): RoutingCandidate {
  return pricing ? { provider: provider(id), modelId, pricing } : { provider: provider(id), modelId };
}

/** A scripted RNG that yields a fixed sequence, then repeats the last value. */
function scriptedRandom(values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

// Module-scope fixture factories: the returned closures capture their map so the
// linter's consistent-function-scoping rule is satisfied while tests stay local.
const rankBy =
  (map: Record<string, number>) =>
  (modelId: string): number =>
    map[modelId] ?? 9;
const loadBy =
  (map: Record<string, number>) =>
  (c: RoutingCandidate): number =>
    map[c.modelId] ?? 0;
const weightBy =
  (map: Record<string, number>, dflt = 1) =>
  (c: RoutingCandidate): number =>
    map[c.modelId] ?? dflt;

const ids = (candidates: RoutingCandidate[]): string[] => candidates.map((c) => c.modelId);

describe('costOptimized', () => {
  it('orders cheapest-first by combined in+out pricing', () => {
    const list = [
      cand('p', 'mid', { inUSDPerMillion: 3, outUSDPerMillion: 6 }), // 9
      cand('p', 'cheap', { inUSDPerMillion: 1, outUSDPerMillion: 2 }), // 3
      cand('p', 'dear', { inUSDPerMillion: 10, outUSDPerMillion: 20 }), // 30
    ];
    expect(ids(costOptimized(list))).toEqual(['cheap', 'mid', 'dear']);
  });

  it('sorts a model with no pricing last', () => {
    const list = [cand('p', 'unpriced'), cand('p', 'priced', { inUSDPerMillion: 5, outUSDPerMillion: 5 })];
    expect(ids(costOptimized(list))).toEqual(['priced', 'unpriced']);
  });

  it('treats pricing with both fields absent as unpriced (last)', () => {
    const list = [cand('p', 'empty', {}), cand('p', 'priced', { inUSDPerMillion: 1, outUSDPerMillion: 1 })];
    expect(ids(costOptimized(list))).toEqual(['priced', 'empty']);
  });

  it('is stable among unpriced candidates (preserves incoming order)', () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    expect(ids(costOptimized(list))).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const list = [
      cand('p', 'b', { inUSDPerMillion: 9, outUSDPerMillion: 0 }),
      cand('p', 'a', { inUSDPerMillion: 1, outUSDPerMillion: 0 }),
    ];
    const before = ids(list);
    costOptimized(list);
    expect(ids(list)).toEqual(before);
  });
});

describe('priority', () => {
  it('orders by the injected heuristic rank (lower first)', () => {
    const rank = rankBy({ haiku: 0, sonnet: 1, opus: 2 });
    const list = [cand('p', 'opus'), cand('p', 'haiku'), cand('p', 'sonnet')];
    expect(ids(priority(list, rank))).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('is stable among equal-rank candidates', () => {
    const rank = rankBy({}); // every model ranks equal (the default)
    const list = [cand('p', 'x'), cand('p', 'y'), cand('p', 'z')];
    expect(ids(priority(list, rank))).toEqual(['x', 'y', 'z']);
  });
});

describe('weighted', () => {
  it('is deterministic for a fixed RNG sequence', () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const run = () => ids(weighted(list, { random: scriptedRandom([0, 0.99, 0]) }));
    expect(run()).toEqual(run());
  });

  it('puts a dominant-weight candidate first regardless of the RNG', () => {
    const list = [cand('p', 'a'), cand('p', 'heavy'), cand('p', 'c')];
    const weightOf = weightBy({ heavy: 1000 });
    expect(ids(weighted(list, { random: scriptedRandom([0.5, 0.5, 0.5]), weightOf }))[0]).toBe('heavy');
  });

  it('appends zero-weight candidates in incoming order without looping', () => {
    const list = [cand('p', 'a'), cand('p', 'b')];
    const weightOf = weightBy({}, 0); // every weight is zero
    expect(ids(weighted(list, { random: scriptedRandom([0.5]), weightOf }))).toEqual(['a', 'b']);
  });
});

describe('p2c', () => {
  it('keeps the less-loaded of the two sampled candidates first', () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const loadOf = loadBy({ a: 5, b: 1, c: 9 });
    // random sequence -> sample index 0 (a, load 5) and index 2 (c, load 9); a wins.
    const ordered = p2c(list, { random: scriptedRandom([0, 0.7]), loadOf });
    expect(ordered[0].modelId).toBe('a');
    expect(ordered[1].modelId).toBe('c');
    expect(ordered[2].modelId).toBe('b');
  });

  it('samples a distinct second candidate when the RNG repeats an index', () => {
    const list = [cand('p', 'a'), cand('p', 'b')];
    const loadOf = loadBy({ a: 3, b: 1 });
    // both draws land on index 0; guard forces second -> index 1; b (load 1) wins.
    expect(p2c(list, { random: scriptedRandom([0, 0]), loadOf })[0].modelId).toBe('b');
  });

  it('passes a single-candidate list through unchanged', () => {
    const list = [cand('p', 'solo')];
    expect(ids(p2c(list, { random: scriptedRandom([0]), loadOf: loadBy({}) }))).toEqual(['solo']);
  });
});

describe('roundRobin', () => {
  it('cycles the head across successive indices', () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    expect(ids(roundRobin(list, 0))).toEqual(['a', 'b', 'c']);
    expect(ids(roundRobin(list, 1))).toEqual(['b', 'c', 'a']);
    expect(ids(roundRobin(list, 2))).toEqual(['c', 'a', 'b']);
    expect(ids(roundRobin(list, 3))).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for no candidates', () => {
    expect(roundRobin([], 5)).toEqual([]);
  });
});

describe('leastUsed', () => {
  it('orders by ascending load metric', () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const loadOf = loadBy({ a: 2, b: 0, c: 1 });
    expect(ids(leastUsed(list, { loadOf, rank: rankBy({}) }))).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by the heuristic rank', () => {
    const list = [cand('p', 'slow'), cand('p', 'fast')];
    const loadOf = loadBy({}); // every load is a tie at zero
    const rank = rankBy({ fast: 0, slow: 1 });
    expect(ids(leastUsed(list, { loadOf, rank }))).toEqual(['fast', 'slow']);
  });
});
