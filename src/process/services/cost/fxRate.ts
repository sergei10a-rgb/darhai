/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which tögrög-per-dollar rate to show a cost in.
 *
 * Model prices are quoted in USD, but this app's users budget in tögrög, and a
 * dollar figure is a number they have to translate before it means anything.
 *
 * Two rules shape everything here:
 *
 *  1. **Never invent a rate.** If no rate is known, the answer is `null` and the
 *     UI shows dollars alone. A made-up tögrög figure in a spend report is worse
 *     than no tögrög figure, because it looks like an answer.
 *  2. **A rate the user typed always wins.** They may be reconciling against a
 *     bank statement or a contract rate; a network fetch must never quietly
 *     overwrite that.
 *
 * The decision is kept pure and separate from fetching so both can be reasoned
 * about on their own - the fetch can fail in a dozen ways, the decision cannot.
 */

/** Where a rate came from - shown to the user so a stale number is legible. */
export type FxRateSource = 'manual' | 'fetched';

export type MntRate = {
  /** Tögrög per one US dollar. */
  mntPerUsd: number;
  /** When this rate was established (epoch ms). */
  asOf: number;
  source: FxRateSource;
};

/**
 * Plausible band for MNT per USD.
 *
 * Wide on purpose - this is a typo guard, not a forecast. It catches someone
 * entering `3.58` (thinking thousands) or `3580000`, both of which would render
 * a spend report off by three orders of magnitude while looking perfectly
 * formatted. The real rate has lived between roughly 1,000 and 4,000 for
 * decades, so this leaves enormous room before it could reject a real value.
 */
export const MIN_PLAUSIBLE_MNT_PER_USD = 100;
export const MAX_PLAUSIBLE_MNT_PER_USD = 100_000;

/** A rate is only usable if it is a finite, positive, plausible number. */
export function isUsableRate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_PLAUSIBLE_MNT_PER_USD &&
    value <= MAX_PLAUSIBLE_MNT_PER_USD
  );
}

/** A fetched rate older than this is shown with its date so nobody is misled. */
export const RATE_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export type ResolveRateInput = {
  /** Rate the user typed in Settings, if any. */
  manualMntPerUsd?: number | null;
  /** Last successfully fetched rate, if any. */
  fetched?: { mntPerUsd: number; asOf: number } | null;
};

/**
 * The rate to display with, or `null` when none is trustworthy.
 *
 * A stale fetched rate is still returned rather than dropped: for a spend
 * figure, yesterday's rate is materially useful and its `asOf` lets the UI say
 * so. Silently falling back to nothing would be a worse answer than a dated one.
 */
export function resolveMntRate(input: ResolveRateInput): MntRate | null {
  const manual = input.manualMntPerUsd;
  if (isUsableRate(manual)) {
    // No `asOf` for a manual rate - it is true until the user changes it, so
    // stamping "now" on every read would make it look freshly verified.
    return { mntPerUsd: manual, asOf: 0, source: 'manual' };
  }

  const fetched = input.fetched;
  if (fetched && isUsableRate(fetched.mntPerUsd) && Number.isFinite(fetched.asOf)) {
    return { mntPerUsd: fetched.mntPerUsd, asOf: fetched.asOf, source: 'fetched' };
  }

  return null;
}

/** Whether a resolved rate is old enough that the UI should date it. */
export function isRateStale(rate: MntRate | null, now: number): boolean {
  if (!rate || rate.source === 'manual') return false;
  return now - rate.asOf > RATE_STALE_AFTER_MS;
}

/**
 * Tögrög for a dollar amount, or `null` when no rate is known.
 *
 * `rowRate` is the rate recorded on the spend row itself. It wins over the
 * current rate because the user asked for historical spend to be counted at the
 * rate of the day it happened - which is what a ledger needs and what makes last
 * month's total stop drifting every time the exchange rate moves.
 */
export function usdToMnt(costUsd: number, currentRate: MntRate | null, rowRate?: number | null): number | null {
  if (!Number.isFinite(costUsd)) return null;
  if (isUsableRate(rowRate)) return costUsd * rowRate;
  if (currentRate) return costUsd * currentRate.mntPerUsd;
  return null;
}
