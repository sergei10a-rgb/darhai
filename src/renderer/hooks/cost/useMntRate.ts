/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The tögrög rate for spend surfaces.
 *
 * Returns null while loading and whenever no rate is trustworthy, and every
 * caller treats null the same way: show dollars alone. That makes "we don't
 * know the rate" and "we haven't asked yet" indistinguishable to the UI, which
 * is correct - neither is a reason to print a number.
 */

import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { MntRate } from '@process/services/cost/fxRate';
import { usdToMnt } from '@process/services/cost/fxRate';

/**
 * Shared SWR key so every spend surface converts with the same rate.
 *
 * Without one key, the sidebar meter and the cost panel could each hold a
 * different rate and disagree about the same spend.
 */
const MNT_RATE_KEY = 'cost.mntRate';

export type UseMntRate = {
  rate: MntRate | null;
  /** Tögrög for a dollar amount, or null when no rate is known. */
  toMnt: (costUsd: number, rowRate?: number | null) => number | null;
};

export function useMntRate(): UseMntRate {
  const { data } = useSWR<MntRate | null>(MNT_RATE_KEY, () => ipcBridge.cost.mntRate.invoke(), {
    // The rate moves once a day at most, so re-fetching on every panel focus
    // would be pure noise.
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });

  const rate = data ?? null;
  return {
    rate,
    toMnt: (costUsd: number, rowRate?: number | null) => usdToMnt(costUsd, rate, rowRate),
  };
}
