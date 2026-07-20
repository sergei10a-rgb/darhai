/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory, per-provider circuit breaker for the stateless text-completion path.
 *
 * This is the TypeScript-side sibling of the engine's own breaker: the state
 * names (`closed` / `open` / `half_open`) mirror `CircuitState` in
 * `src/process/agent/wcore/protocol.ts` so the two paths read consistently. It
 * does NOT call into the Rust engine - the agent path owns its own breaker; this
 * one guards only the `oneShotComplete` primitive.
 *
 * State is process-lifetime and non-persistent by design: a fresh app start
 * begins with every provider closed.
 */

import type { CircuitState } from '@process/agent/wcore/protocol';

/** Consecutive retryable failures (5xx / timeout) that trip a provider open. */
export const CIRCUIT_FAILURE_THRESHOLD = 5;

/** How long a provider stays `open` before a single `half_open` trial is allowed. */
export const CIRCUIT_OPEN_COOLDOWN_MS = 30 * 1000;

type BreakerEntry = {
  state: CircuitState;
  failures: number;
  /** Epoch ms the breaker last tripped `open`; 0 while closed. */
  openedAt: number;
};

const breakers = new Map<string, BreakerEntry>();

const entryFor = (providerId: string): BreakerEntry => {
  const existing = breakers.get(providerId);
  if (existing) return existing;
  const fresh: BreakerEntry = { state: 'closed', failures: 0, openedAt: 0 };
  breakers.set(providerId, fresh);
  return fresh;
};

/**
 * True when a provider should be skipped. An `open` breaker whose cooldown has
 * elapsed transitions to `half_open` here and reports NOT open, so exactly one
 * trial request is allowed through to prove recovery.
 */
export function isProviderCircuitOpen(providerId: string): boolean {
  const entry = breakers.get(providerId);
  if (!entry) return false;
  if (entry.state !== 'open') return false; // closed or half_open lets traffic through
  if (Date.now() - entry.openedAt >= CIRCUIT_OPEN_COOLDOWN_MS) {
    entry.state = 'half_open';
    return false;
  }
  return true;
}

/**
 * Record a retryable provider failure (5xx / network / timeout). A failure during
 * a `half_open` trial re-opens immediately; otherwise the breaker opens once the
 * consecutive-failure threshold is reached.
 */
export function recordProviderFailure(providerId: string): void {
  const entry = entryFor(providerId);
  entry.failures += 1;
  if (entry.state === 'half_open') {
    entry.state = 'open';
    entry.openedAt = Date.now();
    return;
  }
  if (entry.state === 'closed' && entry.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    entry.state = 'open';
    entry.openedAt = Date.now();
  }
}

/** Record a reachable provider (any HTTP response): resets and closes the breaker. */
export function recordProviderSuccess(providerId: string): void {
  const entry = breakers.get(providerId);
  if (!entry) return;
  entry.state = 'closed';
  entry.failures = 0;
  entry.openedAt = 0;
}

/** Test-only: clear all breaker state. */
export function resetProviderCircuits(): void {
  breakers.clear();
}
