/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This conversation's real cumulative spend, for the context usage indicator.
 *
 * The number is never estimated from context tokens - token prices are not
 * available in the renderer, and a priced-from-tokens figure would be a guess.
 * Instead it reads the actual recorded spend from the cost service
 * (cost_events, the same table the Mission Control cost panel reports) and
 * converts it to tögrög with the shared rate, so it agrees with every other
 * spend surface to the last unit.
 *
 * When the conversation has no recorded cost yet, or the bridge is unavailable
 * (e.g. under a test that stubs `@/common`), both figures are null and the
 * indicator simply omits the cost row rather than showing a zero.
 */

import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { CostAggregate, CostWindow } from '@process/services/cost/types';
import { useMntRate } from './useMntRate';

/**
 * All-time window. `toMs` is the maximum epoch-ms a JS Date can represent, so
 * every recorded turn falls inside it. Kept as a module constant so the SWR
 * key below is stable across renders - a `Date.now()` here would change the key
 * every render and defeat the cache.
 */
const ALL_TIME_WINDOW: CostWindow = { fromMs: 0, toMs: 8_640_000_000_000_000 };

/** Shared SWR key so every open send box reuses one aggregate fetch. */
export const CONTEXT_SPEND_KEY = 'cost.byConversation.all';

export type ContextSpend = {
  /** Cumulative recorded cost for this conversation in USD, or null if none. */
  spendUsd: number | null;
  /** The same figure in tögrög, or null when no rate is known. */
  spendMnt: number | null;
};

const EMPTY_SPEND: ContextSpend = { spendUsd: null, spendMnt: null };

export function useContextSpend(conversationId?: string): ContextSpend {
  const { toMnt } = useMntRate();

  const { data } = useSWR<CostAggregate[]>(
    // A null key disables the fetch entirely, which is what we want when there
    // is no conversation to attribute cost to.
    conversationId ? CONTEXT_SPEND_KEY : null,
    async () => {
      try {
        const rows = await ipcBridge.cost?.byConversation?.invoke?.(ALL_TIME_WINDOW);
        return Array.isArray(rows) ? rows : [];
      } catch {
        // A cost read failing must never break the send box, so swallow and
        // report no spend rather than surfacing the error here.
        return [];
      }
    },
    {
      // Spend moves only when a turn finishes; refetching on every panel focus
      // would be pure noise against a rarely-changing figure.
      revalidateOnFocus: false,
    }
  );

  if (!conversationId || !Array.isArray(data)) {
    return EMPTY_SPEND;
  }

  const row = data.find((r) => r.key === conversationId);
  const spendUsd = row && Number.isFinite(row.costUsd) && row.costUsd > 0 ? row.costUsd : null;
  const spendMnt = spendUsd !== null ? toMnt(spendUsd) : null;

  return { spendUsd, spendMnt };
}
