/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resilience primitives for the stateless text-completion path: an in-memory
 * per-provider circuit breaker and a per-(provider, model) 429 lockout. Both are
 * consulted by `usableModels` in the one-shot picker so cross-provider fallback
 * happens for free, and are tripped by `resilientFetch`.
 */

export {
  isProviderCircuitOpen,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderCircuits,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_COOLDOWN_MS,
} from './providerCircuitBreaker';

export { lockModel, isModelLockedOut, resetModelLockouts, DEFAULT_MODEL_LOCKOUT_MS } from './modelLockout';
