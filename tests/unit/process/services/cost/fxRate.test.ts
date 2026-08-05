/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A spend figure in the wrong currency is worse than no figure at all.
 *
 * These tests hold two promises: the app never invents a tögrög number it cannot
 * justify, and a rate the user typed is never quietly replaced by a fetched one.
 * The typo guard matters as much - `3.58` entered instead of `3580` would render
 * a perfectly formatted report that is off by a thousand times.
 */

import { describe, expect, it } from 'vitest';
import {
  isRateStale,
  isUsableRate,
  MAX_PLAUSIBLE_MNT_PER_USD,
  MIN_PLAUSIBLE_MNT_PER_USD,
  RATE_STALE_AFTER_MS,
  resolveMntRate,
  usdToMnt,
} from '@process/services/cost/fxRate';

const NOW = 1_785_888_000_000;
const RATE = 3580;

describe('isUsableRate', () => {
  it('accepts a real rate', () => {
    expect(isUsableRate(RATE)).toBe(true);
    expect(isUsableRate(MIN_PLAUSIBLE_MNT_PER_USD)).toBe(true);
    expect(isUsableRate(MAX_PLAUSIBLE_MNT_PER_USD)).toBe(true);
  });

  it('rejects the typo that would misprice a report by a thousand', () => {
    // Someone typing the rate "in thousands".
    expect(isUsableRate(3.58)).toBe(false);
    // Someone adding three zeros.
    expect(isUsableRate(3_580_000)).toBe(false);
  });

  it('rejects nonsense rather than passing it through to a total', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '3580', {}]) {
      expect(isUsableRate(bad)).toBe(false);
    }
  });
});

describe('resolveMntRate', () => {
  it('returns null when nothing is known, so the UI can show dollars alone', () => {
    expect(resolveMntRate({})).toBeNull();
    expect(resolveMntRate({ manualMntPerUsd: null, fetched: null })).toBeNull();
  });

  it('uses a fetched rate when there is no manual one', () => {
    const rate = resolveMntRate({ fetched: { mntPerUsd: RATE, asOf: NOW } });

    expect(rate).toEqual({ mntPerUsd: RATE, asOf: NOW, source: 'fetched' });
  });

  it('lets a rate the user typed beat a fetched one', () => {
    // They may be reconciling against a bank statement or a contract rate; a
    // background fetch must not silently overwrite that.
    const rate = resolveMntRate({ manualMntPerUsd: 3400, fetched: { mntPerUsd: RATE, asOf: NOW } });

    expect(rate?.mntPerUsd).toBe(3400);
    expect(rate?.source).toBe('manual');
  });

  it('ignores an unusable manual rate instead of pricing with it', () => {
    const rate = resolveMntRate({ manualMntPerUsd: 3.58, fetched: { mntPerUsd: RATE, asOf: NOW } });

    expect(rate?.mntPerUsd).toBe(RATE);
    expect(rate?.source).toBe('fetched');
  });

  it('ignores an unusable fetched rate rather than showing a wrong total', () => {
    expect(resolveMntRate({ fetched: { mntPerUsd: 0, asOf: NOW } })).toBeNull();
    expect(resolveMntRate({ fetched: { mntPerUsd: RATE, asOf: NaN } })).toBeNull();
  });

  it('still returns a stale fetched rate - yesterday’s rate beats no answer', () => {
    const old = NOW - 30 * 24 * 60 * 60 * 1000;
    const rate = resolveMntRate({ fetched: { mntPerUsd: RATE, asOf: old } });

    expect(rate?.mntPerUsd).toBe(RATE);
    expect(rate?.asOf).toBe(old);
  });
});

describe('isRateStale', () => {
  it('flags a fetched rate past the freshness window', () => {
    expect(isRateStale({ mntPerUsd: RATE, asOf: NOW - RATE_STALE_AFTER_MS - 1, source: 'fetched' }, NOW)).toBe(true);
    expect(isRateStale({ mntPerUsd: RATE, asOf: NOW - 1000, source: 'fetched' }, NOW)).toBe(false);
  });

  it('never calls a manual rate stale - it is true until the user changes it', () => {
    expect(isRateStale({ mntPerUsd: RATE, asOf: 0, source: 'manual' }, NOW)).toBe(false);
  });

  it('is not stale when there is no rate at all', () => {
    expect(isRateStale(null, NOW)).toBe(false);
  });
});

describe('usdToMnt', () => {
  const current = { mntPerUsd: RATE, asOf: NOW, source: 'fetched' as const };

  it('converts with the current rate when the row carries none', () => {
    expect(usdToMnt(2, current)).toBe(7160);
  });

  it('prefers the rate recorded on the row itself', () => {
    // The whole point of stamping a rate at spend time: last month's total must
    // not drift every time the exchange rate moves.
    expect(usdToMnt(2, current, 3000)).toBe(6000);
  });

  it('falls back to the current rate when the row’s rate is unusable', () => {
    expect(usdToMnt(2, current, 0)).toBe(7160);
    expect(usdToMnt(2, current, null)).toBe(7160);
  });

  it('returns null rather than a number when no rate is known anywhere', () => {
    expect(usdToMnt(2, null)).toBeNull();
  });

  it('still uses a row rate when there is no current rate', () => {
    // An old row remains convertible even with the network down.
    expect(usdToMnt(2, null, 3000)).toBe(6000);
  });

  it('handles a zero cost without inventing anything', () => {
    expect(usdToMnt(0, current)).toBe(0);
    expect(usdToMnt(Number.NaN, current)).toBeNull();
  });
});
