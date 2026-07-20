/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory per-(providerId, modelId) selection counter.
 *
 * Feeds the `least-used` and `p2c` routing strategies with a live load metric
 * WITHOUT a database: the gap analysis for the routing feature explicitly keeps
 * this process-lifetime-only for the MVP (no `usage_events`-style rollup table).
 * Counts reset to zero on every app restart, which is the intended behavior -
 * routing balances within a session, not across the machine's whole history.
 *
 * Counts are held in a nested `Map<providerId, Map<modelId, count>>` so a
 * (provider, model) pair is keyed structurally - no string join, hence no
 * separator-collision risk between a provider id and a model id.
 */
export class UsageCounter {
  private readonly counts = new Map<string, Map<string, number>>();

  /** Increment the selection count for one (provider, model) pair. */
  recordUse(providerId: string, modelId: string): void {
    let byModel = this.counts.get(providerId);
    if (!byModel) {
      byModel = new Map<string, number>();
      this.counts.set(providerId, byModel);
    }
    byModel.set(modelId, (byModel.get(modelId) ?? 0) + 1);
  }

  /** Current selection count for one (provider, model) pair (0 if never used). */
  getCount(providerId: string, modelId: string): number {
    return this.counts.get(providerId)?.get(modelId) ?? 0;
  }

  /** Drop all counts. Used by tests to isolate cases; not called in production. */
  reset(): void {
    this.counts.clear();
  }
}

/** Process-lifetime singleton the routing seam records into and reads from. */
export const usageCounter = new UsageCounter();
