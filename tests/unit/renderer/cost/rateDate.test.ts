/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The rate's date, in a form a Mongolian reader is not misled by.
 *
 * Found by looking at the rendered page, not by a test: `toLocaleDateString()`
 * with no locale follows the operating system, and printed `8/5/2026` inside
 * otherwise fully-Mongolian copy - a US month-first date that also reads as
 * 5 August under every other convention.
 */

import { describe, expect, it } from 'vitest';
import { formatRateDate } from '@renderer/pages/mission-control/cost/MntRatePanel';

describe('formatRateDate', () => {
  it('writes the date year-first, never month-first', () => {
    expect(formatRateDate(new Date(2026, 7, 5).getTime())).toBe('2026-08-05');
  });

  it('pads single-digit months and days so the width never jumps', () => {
    expect(formatRateDate(new Date(2026, 0, 9).getTime())).toBe('2026-01-09');
  });

  it('is unambiguous on a date the US and the rest of the world disagree about', () => {
    // 3 February. `2/3/2026` would read as 2 March almost everywhere else.
    expect(formatRateDate(new Date(2026, 1, 3).getTime())).toBe('2026-02-03');
  });
});
