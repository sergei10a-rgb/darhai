/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the per-provider circuit breaker: it opens after K consecutive
 * retryable failures, skips traffic while open, and after the cooldown allows a
 * single half-open trial that either closes (success) or re-opens (failure).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isProviderCircuitOpen,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderCircuits,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_COOLDOWN_MS,
} from '@process/services/resilience/providerCircuitBreaker';

const P = 'provider-a';

beforeEach(() => {
  resetProviderCircuits();
});

describe('providerCircuitBreaker', () => {
  it('starts closed and reports an unknown provider as not open', () => {
    expect(isProviderCircuitOpen('never-seen')).toBe(false);
  });

  it('opens only after K consecutive failures', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
      recordProviderFailure(P);
      expect(isProviderCircuitOpen(P)).toBe(false);
    }
    recordProviderFailure(P); // Kth failure
    expect(isProviderCircuitOpen(P)).toBe(true);
  });

  it('a success before the threshold resets the failure count', () => {
    recordProviderFailure(P);
    recordProviderFailure(P);
    recordProviderSuccess(P);
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD - 1; i++) recordProviderFailure(P);
    expect(isProviderCircuitOpen(P)).toBe(false); // count restarted, threshold not reached
  });

  describe('cooldown and half-open', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const trip = (): void => {
      for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordProviderFailure(P);
    };

    it('skips while open, then goes half-open (not open) after the cooldown', () => {
      trip();
      expect(isProviderCircuitOpen(P)).toBe(true); // open -> skip

      vi.advanceTimersByTime(CIRCUIT_OPEN_COOLDOWN_MS + 1);
      expect(isProviderCircuitOpen(P)).toBe(false); // cooldown elapsed -> half-open trial allowed
    });

    it('a successful half-open trial closes the breaker', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_OPEN_COOLDOWN_MS + 1);
      expect(isProviderCircuitOpen(P)).toBe(false); // enter half-open

      recordProviderSuccess(P);
      expect(isProviderCircuitOpen(P)).toBe(false); // closed and staying closed
    });

    it('a failed half-open trial re-opens the breaker immediately', () => {
      trip();
      vi.advanceTimersByTime(CIRCUIT_OPEN_COOLDOWN_MS + 1);
      expect(isProviderCircuitOpen(P)).toBe(false); // enter half-open

      recordProviderFailure(P);
      expect(isProviderCircuitOpen(P)).toBe(true); // re-opened without waiting for a new threshold
    });
  });

  it('isolates providers from one another', () => {
    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i++) recordProviderFailure('provider-a');
    expect(isProviderCircuitOpen('provider-a')).toBe(true);
    expect(isProviderCircuitOpen('provider-b')).toBe(false);
  });
});
