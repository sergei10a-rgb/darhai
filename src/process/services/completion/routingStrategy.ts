/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read/write the persisted model-routing strategy. Single source of truth for
 * both the completion seam (`oneShotComplete`) and the Settings bridge, mirroring
 * the compression-mode accessor pair (`getCompressionMode` / `setCompressionMode`).
 *
 * Default (absent config) is `auto` - which maps to the EXISTING name-heuristic
 * ordering, so with no strategy configured the app selects exactly the model it
 * did before routing existed. Reads are tolerant of a not-yet-ready store: any
 * failure or unrecognized value degrades to `auto`.
 */

import type { RoutingStrategy } from '@/common/types/routing';
import { isRoutingStrategy } from '@/common/types/routing';
import { ProcessConfig } from '@process/utils/initStorage';

/** The safe default applied when no strategy is configured. */
export const DEFAULT_ROUTING_STRATEGY: RoutingStrategy = 'auto';

/** Current routing strategy from config, defaulting to `auto` on any failure. */
export async function getRoutingStrategy(): Promise<RoutingStrategy> {
  try {
    const value = (await ProcessConfig.get('routing.strategy')) as unknown;
    return isRoutingStrategy(value) ? value : DEFAULT_ROUTING_STRATEGY;
  } catch {
    return DEFAULT_ROUTING_STRATEGY;
  }
}

/** Persist the routing strategy. Unrecognized input is coerced to the default. */
export async function setRoutingStrategy(strategy: RoutingStrategy): Promise<void> {
  const safe = isRoutingStrategy(strategy) ? strategy : DEFAULT_ROUTING_STRATEGY;
  await ProcessConfig.set('routing.strategy', safe);
}
