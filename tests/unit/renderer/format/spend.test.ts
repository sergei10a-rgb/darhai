/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a spend figure reads to someone who budgets in tögrög.
 *
 * Providers bill in dollars, so dollars stay the primary number - the tögrög
 * figure is a conversion and should not be dressed up as the billed amount. But
 * a dollar total is a number a user here has to translate before it means
 * anything, so it belongs next to it whenever a rate is known, and must be
 * absent (not guessed) when one is not.
 */

import { describe, expect, it } from 'vitest';
import { formatMnt, formatSpend, formatUsd } from '@/renderer/utils/format/tokens';

describe('formatMnt', () => {
  it('renders whole tögrög with separators', () => {
    // No sub-tögrög denomination exists, and these numbers are already long.
    expect(formatMnt(7160)).toBe('7,160₮');
    expect(formatMnt(3580.4)).toBe('3,580₮');
    expect(formatMnt(1_234_567)).toBe('1,234,567₮');
  });

  it('does not round a real spend down to nothing', () => {
    // Showing `0₮` for money that was actually spent makes a cost report lie.
    expect(formatMnt(0.4)).toBe('<1₮');
    expect(formatMnt(0.001)).toBe('<1₮');
  });

  it('renders a genuine zero as zero', () => {
    expect(formatMnt(0)).toBe('0₮');
    expect(formatMnt(-5)).toBe('0₮');
    expect(formatMnt(Number.NaN)).toBe('0₮');
  });
});

describe('formatSpend', () => {
  it('shows both currencies when a rate is known', () => {
    expect(formatSpend(2, 7160)).toBe('$2.00 · 7,160₮');
  });

  it('leads with dollars, the currency actually billed', () => {
    expect(formatSpend(2, 7160).indexOf('$')).toBeLessThan(formatSpend(2, 7160).indexOf('₮'));
  });

  it('shows dollars alone rather than a guess when no rate is known', () => {
    // The whole promise: never invent a tögrög number.
    expect(formatSpend(2, null)).toBe('$2.00');
    expect(formatSpend(2, Number.NaN)).toBe('$2.00');
  });

  it('keeps the existing dollar conventions intact', () => {
    expect(formatSpend(12.5, null)).toBe(formatUsd(12.5));
    expect(formatSpend(12_345, 44_000_000)).toBe('$12,345 · 44,000,000₮');
  });

  it('renders a zero spend in both currencies', () => {
    expect(formatSpend(0, 0)).toBe('$0.00 · 0₮');
  });
});
