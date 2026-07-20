/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Model-routing strategies for the single stateless completion primitive
 * (`oneShotComplete`). A strategy decides WHICH of the user's usable models is
 * selected when the caller does not pin one explicitly.
 *
 * Lives in `src/common` because the type is shared across the process (the
 * routing scorers + the config accessor), the bridge contract, and any renderer
 * Settings selector - mirroring `CompressionMode`.
 *
 * - `auto`           - the EXISTING name-heuristic order (cheapest-fast first).
 *                      The default; with no config set the app behaves exactly
 *                      as it did before routing existed.
 * - `cost-optimized` - cheapest by per-model pricing (input + output USD/M);
 *                      a model with no known pricing sorts last.
 * - `weighted`       - probabilistic pick by configured weights (default equal).
 * - `p2c`            - power-of-two-choices: sample two, keep the less-loaded.
 * - `round-robin`    - cycle through the usable models in order.
 * - `least-used`     - the model selected fewest times this process lifetime.
 */
export type RoutingStrategy = 'auto' | 'cost-optimized' | 'weighted' | 'p2c' | 'round-robin' | 'least-used';

/** Ordered, canonical list of every valid {@link RoutingStrategy}. */
export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = [
  'auto',
  'cost-optimized',
  'weighted',
  'p2c',
  'round-robin',
  'least-used',
];

/** Runtime type guard for an untrusted value claiming to be a {@link RoutingStrategy}. */
export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return typeof value === 'string' && (ROUTING_STRATEGIES as readonly string[]).includes(value);
}
