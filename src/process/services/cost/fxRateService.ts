/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeping the tögrög rate current, without the app deciding that for the user.
 *
 * The rate decision itself lives in `fxRate.ts` and is pure. This module is the
 * I/O around it: one network call a day at most, a cached result that survives
 * offline, and an off switch.
 *
 * Fetching is opt-out, not silent-and-mandatory. This app runs offline by
 * design, so a background call to a foreign service is something the user should
 * be able to see and stop. The request carries nothing but a plea for public
 * exchange rates - no key, no identifier, no usage data - and the response is
 * validated before it is allowed anywhere near a spend figure.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { isUsableRate, type MntRate, resolveMntRate } from './fxRate';

/** Free, keyless, daily-updated public rates. No account, no identifier sent. */
const RATE_API_URL = 'https://open.er-api.com/v6/latest/USD';

const FETCH_TIMEOUT_MS = 10_000;

/** Refresh at most once a day - the upstream source only updates that often. */
export const RATE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

type StoredRate = NonNullable<Awaited<ReturnType<typeof readStored>>>;

async function readStored() {
  try {
    return (await ProcessConfig.get('cost.mntRate')) ?? { auto: true };
  } catch {
    return { auto: true };
  }
}

/**
 * Pull the current rate from the public API.
 *
 * Returns null on every failure - offline, timeout, non-2xx, malformed body, or
 * a number outside the plausible band. A spend report showing a wrong currency
 * figure is worse than one showing none, so nothing questionable gets through.
 *
 * `fetchFn` is injected so this is testable without a network.
 */
export async function fetchMntPerUsd(fetchFn: typeof fetch = globalThis.fetch): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(RATE_API_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { rates?: Record<string, unknown> };
    const rate = body?.rates?.MNT;
    return isUsableRate(rate) ? rate : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether enough time has passed to justify another network call. */
export function isRefreshDue(fetchedAsOf: number | undefined, now: number): boolean {
  if (typeof fetchedAsOf !== 'number' || !Number.isFinite(fetchedAsOf)) return true;
  return now - fetchedAsOf >= RATE_REFRESH_INTERVAL_MS;
}

/**
 * Refresh the cached rate if the user allows it and one is due.
 *
 * Never throws and never clears a good cached rate on failure: losing yesterday's
 * rate because today's request timed out would take away a working conversion
 * for no reason.
 */
export async function refreshMntRate(
  now: number = Date.now(),
  fetchFn: typeof fetch = globalThis.fetch
): Promise<void> {
  const stored: StoredRate = await readStored();
  if (!stored.auto) return;
  if (!isRefreshDue(stored.fetched?.asOf, now)) return;

  const mntPerUsd = await fetchMntPerUsd(fetchFn);
  if (mntPerUsd === null) return;

  try {
    await ProcessConfig.set('cost.mntRate', { ...stored, fetched: { mntPerUsd, asOf: now } });
  } catch (error) {
    console.warn('[fxRate] Could not persist the refreshed rate:', error);
  }
}

/** The rate to convert with right now, or null when none is trustworthy. */
export async function getMntRate(): Promise<MntRate | null> {
  const stored: StoredRate = await readStored();
  return resolveMntRate({ manualMntPerUsd: stored.manualMntPerUsd, fetched: stored.fetched });
}

/**
 * In-memory copy of the resolved rate.
 *
 * The cost recorder runs on the turn-finish path and writes synchronously, so it
 * cannot await config. It reads this instead, and a turn recorded before the
 * first refresh simply carries no rate - which is handled, not broken.
 */
let liveRate: MntRate | null = null;

/** The rate to stamp on a cost row, for callers that cannot await. */
export function currentMntRateSync(): number | null {
  return liveRate?.mntPerUsd ?? null;
}

/** Re-read the stored rate into memory. Call after the user changes settings. */
export async function primeMntRate(): Promise<MntRate | null> {
  liveRate = await getMntRate();
  return liveRate;
}

/**
 * Refresh from the network if due and allowed, then prime the in-memory copy.
 *
 * Safe to call at startup and on a timer: it makes at most one request a day and
 * never throws, so a failure here can never keep the app from starting.
 */
export async function startMntRateRefresh(now: number = Date.now()): Promise<void> {
  try {
    await refreshMntRate(now);
  } catch (error) {
    console.warn('[fxRate] Refresh failed; keeping whatever rate is cached:', error);
  }
  await primeMntRate();
}
