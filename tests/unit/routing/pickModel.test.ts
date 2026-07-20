/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import { pickModel, type RoundRobinCursor, type RoutingContext } from '@process/services/routing/pickModel';
import { priority, type RoutingCandidate, type RoutingCandidatePricing } from '@process/services/routing/strategies';

function provider(id: string): IProvider {
  return { id, platform: id, name: id, baseUrl: '', apiKey: 'sk-x', model: [] };
}

function cand(id: string, modelId: string, pricing?: RoutingCandidatePricing): RoutingCandidate {
  return pricing ? { provider: provider(id), modelId, pricing } : { provider: provider(id), modelId };
}

// Module-scope fixture factories (see strategies.test.ts) keep the linter's
// consistent-function-scoping rule happy while tests stay self-contained.
const rankBy =
  (map: Record<string, number>) =>
  (modelId: string): number =>
    map[modelId] ?? 9;
const loadBy =
  (map: Record<string, number>) =>
  (c: RoutingCandidate): number =>
    map[c.modelId] ?? 0;
const weightBy =
  (map: Record<string, number>) =>
  (c: RoutingCandidate): number =>
    map[c.modelId] ?? 1;

/** A rank fixture standing in for `fastRank` (lower = preferred). */
const rank = rankBy({ haiku: 0, sonnet: 1, opus: 2 });

function ctx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return { rank, loadOf: loadBy({}), ...overrides };
}

describe('pickModel', () => {
  it('returns null for an empty candidate list', () => {
    expect(pickModel('auto', [], ctx())).toBeNull();
  });

  it("'auto' returns the same top as the priority heuristic", () => {
    const list = [cand('p', 'opus'), cand('p', 'haiku'), cand('p', 'sonnet')];
    const expected = priority(list, rank)[0];
    const picked = pickModel('auto', list, ctx());
    expect(picked).toEqual({ provider: expected.provider, modelId: expected.modelId });
    expect(picked?.modelId).toBe('haiku');
  });

  it("'cost-optimized' returns the cheapest candidate", () => {
    const list = [
      cand('p', 'dear', { inUSDPerMillion: 10, outUSDPerMillion: 10 }),
      cand('p', 'cheap', { inUSDPerMillion: 1, outUSDPerMillion: 1 }),
      cand('p', 'unpriced'),
    ];
    expect(pickModel('cost-optimized', list, ctx())?.modelId).toBe('cheap');
  });

  it("'least-used' returns the lowest-load candidate", () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const loadOf = loadBy({ a: 2, b: 0, c: 1 });
    expect(pickModel('least-used', list, ctx({ loadOf }))?.modelId).toBe('b');
  });

  it("'round-robin' advances the cursor across successive picks", () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const cursor: RoundRobinCursor = { value: 0 };
    const c = ctx({ roundRobinCursor: cursor });
    expect(pickModel('round-robin', list, c)?.modelId).toBe('a');
    expect(pickModel('round-robin', list, c)?.modelId).toBe('b');
    expect(pickModel('round-robin', list, c)?.modelId).toBe('c');
    expect(pickModel('round-robin', list, c)?.modelId).toBe('a');
    expect(cursor.value).toBe(4);
  });

  it("'weighted' returns a dominant-weight candidate deterministically", () => {
    const list = [cand('p', 'a'), cand('p', 'heavy'), cand('p', 'c')];
    const weightOf = weightBy({ heavy: 1000 });
    expect(pickModel('weighted', list, ctx({ random: () => 0.5, weightOf }))?.modelId).toBe('heavy');
  });

  it("'p2c' returns the less-loaded of the two sampled candidates", () => {
    const list = [cand('p', 'a'), cand('p', 'b'), cand('p', 'c')];
    const loadOf = loadBy({ a: 5, b: 1, c: 9 });
    const values = [0, 0.7];
    let i = 0;
    const random = () => (i < values.length ? values[i++] : 0);
    // samples index 0 (a, load 5) and index 2 (c, load 9) -> a wins.
    expect(pickModel('p2c', list, ctx({ random, loadOf }))?.modelId).toBe('a');
  });

  it('returns a bare provider+modelId pick (pricing is not carried through)', () => {
    const list = [cand('p', 'only', { inUSDPerMillion: 1, outUSDPerMillion: 1 })];
    const picked = pickModel('cost-optimized', list, ctx());
    expect(picked).toEqual({ provider: provider('p'), modelId: 'only' });
    expect(picked as Record<string, unknown>).not.toHaveProperty('pricing');
  });
});
