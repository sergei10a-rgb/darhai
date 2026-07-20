/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the per-(provider, model) 429 lockout: a locked model is
 * reported locked until its expiry, other models on the same provider are
 * unaffected, and expiry is pruned lazily on read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  lockModel,
  isModelLockedOut,
  resetModelLockouts,
  DEFAULT_MODEL_LOCKOUT_MS,
} from '@process/services/resilience/modelLockout';

const P = 'openai';

beforeEach(() => {
  resetModelLockouts();
});

describe('modelLockout', () => {
  it('reports an un-locked model as available', () => {
    expect(isModelLockedOut(P, 'gpt-4o-mini')).toBe(false);
  });

  it('locks only the targeted (provider, model) pair', () => {
    lockModel(P, 'gpt-4o-mini', DEFAULT_MODEL_LOCKOUT_MS);
    expect(isModelLockedOut(P, 'gpt-4o-mini')).toBe(true);
    expect(isModelLockedOut(P, 'gpt-4o')).toBe(false); // sibling model unaffected
    expect(isModelLockedOut('anthropic', 'gpt-4o-mini')).toBe(false); // other provider unaffected
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stays locked until the duration elapses, then clears', () => {
      lockModel(P, 'gpt-4o-mini', 1000);
      expect(isModelLockedOut(P, 'gpt-4o-mini')).toBe(true);

      vi.advanceTimersByTime(999);
      expect(isModelLockedOut(P, 'gpt-4o-mini')).toBe(true);

      vi.advanceTimersByTime(2);
      expect(isModelLockedOut(P, 'gpt-4o-mini')).toBe(false); // expired and pruned
    });
  });
});
