/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure model-selection scorers (the OmniRoute "routing strategies" idea, native).
 *
 * Every function here is a PURE ordering over a candidate list: given the models
 * `usableModels` already enumerated, it returns them ORDERED best-first. Nothing
 * here fetches, mutates global state, or touches the network - the runtime inputs
 * a strategy needs (per-model pricing, a load metric, the RNG, a cursor) are all
 * INJECTED by the caller, which is what makes them deterministically testable.
 *
 * The pricing shape reuses `ProviderModel.pricing` from the providers layer
 * (`{ inUSDPerMillion, outUSDPerMillion }`) - the cost data already available in
 * the app, never refetched here.
 */

import type { IProvider } from '@/common/config/storage';

/** Per-model pricing, mirroring `ProviderModel.pricing` (USD per 1M tokens). */
export type RoutingCandidatePricing = {
  inUSDPerMillion?: number;
  outUSDPerMillion?: number;
};

/**
 * One selectable model: the provider that serves it, its raw model id, and -
 * when known - its pricing. Structurally a superset of `PickedModel`, so the
 * top-ranked candidate reduces directly to a pick.
 */
export type RoutingCandidate = {
  provider: IProvider;
  modelId: string;
  pricing?: RoutingCandidatePricing;
};

/**
 * A name-heuristic rank (lower = preferred). This is exactly the existing
 * `fastRank` from `oneShot.ts`, injected so the `priority` strategy reproduces
 * today's ordering byte-for-byte and `leastUsed` can break ties by it.
 */
export type HeuristicRank = (modelId: string) => number;

/** A load metric for a candidate (e.g. its in-memory selection count). */
export type LoadOf = (candidate: RoutingCandidate) => number;

/** A relative weight for a candidate (default equal). Non-positive => never picked. */
export type WeightOf = (candidate: RoutingCandidate) => number;

/**
 * Combined per-million cost of a candidate: `inUSDPerMillion + outUSDPerMillion`.
 * A candidate with no pricing at all - or pricing whose both fields are absent -
 * scores `Infinity` so it sorts LAST (honest: unknown cost is never treated as
 * free). A partially-specified pricing treats the missing half as 0.
 */
function combinedCost(candidate: RoutingCandidate): number {
  const pricing = candidate.pricing;
  if (!pricing) return Number.POSITIVE_INFINITY;
  const { inUSDPerMillion, outUSDPerMillion } = pricing;
  if (inUSDPerMillion == null && outUSDPerMillion == null) return Number.POSITIVE_INFINITY;
  return (inUSDPerMillion ?? 0) + (outUSDPerMillion ?? 0);
}

/**
 * Cheapest-first by combined per-million pricing; unpriced models sort last.
 * Array#sort is stable, so among equal-cost (and among all-unpriced) candidates
 * the incoming order - the name heuristic - is preserved.
 */
export function costOptimized(candidates: readonly RoutingCandidate[]): RoutingCandidate[] {
  return candidates.toSorted((a, b) => combinedCost(a) - combinedCost(b));
}

/**
 * The EXISTING name-heuristic order - what `auto` maps to. Sorts by the injected
 * rank with the same stable comparator `pickCheapestFastModel` uses, so the top
 * candidate is identical to today's default pick.
 */
export function priority(candidates: readonly RoutingCandidate[], rank: HeuristicRank): RoutingCandidate[] {
  return candidates.toSorted((a, b) => rank(a.modelId) - rank(b.modelId));
}

/**
 * Probabilistic order by weight (default equal), sampled WITHOUT replacement so
 * the whole list is ordered, not just the head. Deterministic for a given `random`
 * sequence - inject a seeded RNG in tests. When every remaining weight is <= 0 the
 * rest are appended in their incoming order rather than looping forever.
 */
export function weighted(
  candidates: readonly RoutingCandidate[],
  opts: { random: () => number; weightOf?: WeightOf }
): RoutingCandidate[] {
  const weightOf = opts.weightOf ?? (() => 1);
  const remaining = candidates.map((candidate) => ({ candidate, weight: Math.max(0, weightOf(candidate)) }));
  const ordered: RoutingCandidate[] = [];

  while (remaining.length > 0) {
    const total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    if (total <= 0) {
      for (const entry of remaining) ordered.push(entry.candidate);
      break;
    }
    let threshold = opts.random() * total;
    let index = 0;
    for (; index < remaining.length - 1; index++) {
      threshold -= remaining[index].weight;
      if (threshold < 0) break;
    }
    ordered.push(remaining[index].candidate);
    remaining.splice(index, 1);
  }

  return ordered;
}

/**
 * Power-of-two-choices: sample two distinct candidates and put the less-loaded
 * one first (ties keep the first sampled), then the other, then the rest in
 * incoming order. Deterministic for a given `random` sequence + `loadOf`.
 * Degenerate lists (0 or 1 candidate) pass through unchanged.
 */
export function p2c(
  candidates: readonly RoutingCandidate[],
  opts: { random: () => number; loadOf: LoadOf }
): RoutingCandidate[] {
  const count = candidates.length;
  if (count <= 1) return [...candidates];

  const first = Math.min(count - 1, Math.floor(opts.random() * count));
  let second = Math.min(count - 1, Math.floor(opts.random() * count));
  if (second === first) second = (first + 1) % count;

  const a = candidates[first];
  const b = candidates[second];
  const winner = opts.loadOf(a) <= opts.loadOf(b) ? a : b;
  const loser = winner === a ? b : a;
  const rest = candidates.filter((_, i) => i !== first && i !== second);
  return [winner, loser, ...rest];
}

/**
 * Rotate the list so the candidate at `index` (cyclic, non-negative-normalized)
 * is first. The caller owns advancing `index` between calls, which is what makes
 * successive picks cycle through every candidate. Pure - no internal cursor.
 */
export function roundRobin(candidates: readonly RoutingCandidate[], index: number): RoutingCandidate[] {
  const count = candidates.length;
  if (count === 0) return [];
  const start = ((Math.trunc(index) % count) + count) % count;
  return [...candidates.slice(start), ...candidates.slice(0, start)];
}

/**
 * Least-selected first by the injected load metric; ties broken by the name
 * heuristic so the order is fully deterministic even before any usage is recorded.
 */
export function leastUsed(
  candidates: readonly RoutingCandidate[],
  opts: { loadOf: LoadOf; rank: HeuristicRank }
): RoutingCandidate[] {
  return candidates.toSorted((a, b) => {
    const byLoad = opts.loadOf(a) - opts.loadOf(b);
    if (byLoad !== 0) return byLoad;
    return opts.rank(a.modelId) - opts.rank(b.modelId);
  });
}
