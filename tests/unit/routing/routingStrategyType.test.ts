/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ROUTING_STRATEGIES, isRoutingStrategy } from '@/common/types/routing';

describe('isRoutingStrategy', () => {
  it('accepts every canonical strategy', () => {
    for (const strategy of ROUTING_STRATEGIES) {
      expect(isRoutingStrategy(strategy)).toBe(true);
    }
  });

  it('lists auto first (the default the config maps to)', () => {
    expect(ROUTING_STRATEGIES[0]).toBe('auto');
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isRoutingStrategy('cheapest')).toBe(false);
    expect(isRoutingStrategy('')).toBe(false);
    expect(isRoutingStrategy(undefined)).toBe(false);
    expect(isRoutingStrategy(null)).toBe(false);
    expect(isRoutingStrategy(3)).toBe(false);
  });
});
