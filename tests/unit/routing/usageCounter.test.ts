/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { UsageCounter } from '@process/services/routing/usageCounter';

describe('UsageCounter', () => {
  it('starts every pair at zero', () => {
    const counter = new UsageCounter();
    expect(counter.getCount('openai', 'gpt-4o-mini')).toBe(0);
  });

  it('recordUse increments the count for a pair', () => {
    const counter = new UsageCounter();
    counter.recordUse('openai', 'gpt-4o-mini');
    counter.recordUse('openai', 'gpt-4o-mini');
    expect(counter.getCount('openai', 'gpt-4o-mini')).toBe(2);
  });

  it('isolates counts per model within a provider', () => {
    const counter = new UsageCounter();
    counter.recordUse('openai', 'gpt-4o-mini');
    expect(counter.getCount('openai', 'gpt-4o-mini')).toBe(1);
    expect(counter.getCount('openai', 'gpt-4o')).toBe(0);
  });

  it('isolates counts per provider for the same model id', () => {
    const counter = new UsageCounter();
    counter.recordUse('openai', 'shared-model');
    counter.recordUse('azure', 'shared-model');
    counter.recordUse('azure', 'shared-model');
    expect(counter.getCount('openai', 'shared-model')).toBe(1);
    expect(counter.getCount('azure', 'shared-model')).toBe(2);
  });

  it('reset clears all counts', () => {
    const counter = new UsageCounter();
    counter.recordUse('openai', 'gpt-4o-mini');
    counter.reset();
    expect(counter.getCount('openai', 'gpt-4o-mini')).toBe(0);
  });
});
