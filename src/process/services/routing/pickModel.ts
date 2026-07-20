/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The routing dispatcher: apply a {@link RoutingStrategy}'s ordering to a
 * candidate list and return the top pick. Sits BESIDE `pickCheapestFastModel` /
 * `pickBestModel` in `oneShot.ts` (which are untouched); the seam consults this
 * only when a non-`auto` strategy is configured.
 */

import type { RoutingStrategy } from '@/common/types/routing';
import {
  costOptimized,
  leastUsed,
  p2c,
  priority,
  roundRobin,
  weighted,
  type HeuristicRank,
  type LoadOf,
  type RoutingCandidate,
  type WeightOf,
} from './strategies';

/** A `{ provider, modelId }` pick - structurally the `PickedModel` from `oneShot.ts`. */
export type PickedRoute = Pick<RoutingCandidate, 'provider' | 'modelId'>;

/** A mutable cursor the caller owns so `round-robin` advances between picks. */
export type RoundRobinCursor = { value: number };

/**
 * Everything a strategy might need, injected. Only the fields a given strategy
 * uses are read; the rest are ignored - e.g. `cost-optimized` reads none of them.
 */
export type RoutingContext = {
  /** Name heuristic (the exported `fastRank`) - drives `priority`/`auto` + tie-breaks. */
  rank: HeuristicRank;
  /** Load metric for `p2c` / `least-used` (the in-memory usage counter). */
  loadOf: LoadOf;
  /** RNG for `weighted` / `p2c`; defaults to `Math.random`. Inject for determinism. */
  random?: () => number;
  /** Per-candidate weight for `weighted`; defaults to equal. */
  weightOf?: WeightOf;
  /** Cursor for `round-robin`; advanced by one on each `round-robin` pick. */
  roundRobinCursor?: RoundRobinCursor;
};

/** Order candidates by the chosen strategy. `auto` maps to the `priority` heuristic. */
function orderCandidates(
  strategy: RoutingStrategy,
  candidates: readonly RoutingCandidate[],
  ctx: RoutingContext
): RoutingCandidate[] {
  switch (strategy) {
    case 'cost-optimized':
      return costOptimized(candidates);
    case 'weighted':
      return weighted(candidates, { random: ctx.random ?? Math.random, weightOf: ctx.weightOf });
    case 'p2c':
      return p2c(candidates, { random: ctx.random ?? Math.random, loadOf: ctx.loadOf });
    case 'least-used':
      return leastUsed(candidates, { loadOf: ctx.loadOf, rank: ctx.rank });
    case 'round-robin': {
      const cursor = ctx.roundRobinCursor;
      const index = cursor ? cursor.value : 0;
      const ordered = roundRobin(candidates, index);
      if (cursor) cursor.value = index + 1;
      return ordered;
    }
    case 'auto':
    default:
      return priority(candidates, ctx.rank);
  }
}

/**
 * Apply `strategy` to `candidates` and return the top pick, or `null` for an
 * empty list. The returned object is `{ provider, modelId }` only - the pricing
 * a candidate may carry is a routing input, not part of the pick.
 */
export function pickModel(
  strategy: RoutingStrategy,
  candidates: readonly RoutingCandidate[],
  ctx: RoutingContext
): PickedRoute | null {
  if (candidates.length === 0) return null;
  const top = orderCandidates(strategy, candidates, ctx)[0];
  return top ? { provider: top.provider, modelId: top.modelId } : null;
}
