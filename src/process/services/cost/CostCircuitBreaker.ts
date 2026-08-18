/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cost circuit-breaker: a session/daily spend cap that STOPS running agents.
 *
 * Ported from the upstream circuit-breaker idea (P1 `feat(cost): enforce pause
 * budgets with a pre-turn gate`, 837fba534) and adapted to Darhai's own cost
 * plumbing: instead of holding the NEXT turn at send time, this breaker hooks
 * the exact point where cost is counted (CostRecorder's turn-recorded hook) and
 * stops every RUNNING agent the moment the recorded spend crosses the user's
 * limit. The limit is user-configured in tögrög or USD over a rolling window:
 * the current calendar day, or the app session (since process start).
 *
 * Enforcement rules:
 *  - at >= 100% of the limit: stop all running agents via the existing
 *    stop mechanism and emit `cost.circuitBreakerTripped` so the renderer can
 *    explain, in the user's language, why everything just stopped.
 *  - at >= 80% of the limit: emit `cost.circuitBreakerWarning` ONCE per
 *    period (latched, like BudgetController's alert latch).
 *  - disabled, zero/invalid limit, or an MNT limit with no known exchange
 *    rate: do nothing at all.
 *
 * All dependencies are injected so the decision logic is unit-testable without
 * a database, an agent, or a renderer.
 */

import { periodStart } from './BudgetController';
import type { CostWindow } from './types';

/** Persisted settings shape (the `cost.circuitBreaker` config key). */
export type CircuitBreakerSettings = {
  enabled: boolean;
  /** Cap in `currency` units. Enforceable only when finite and > 0. */
  limitAmount: number;
  currency: 'MNT' | 'USD';
  period: 'session' | 'day';
};

export const DEFAULT_CIRCUIT_BREAKER_SETTINGS: CircuitBreakerSettings = {
  enabled: false,
  limitAmount: 0,
  currency: 'MNT',
  period: 'day',
};

/** Fraction of the limit at which the one-time early warning fires. */
export const CIRCUIT_BREAKER_WARN_RATIO = 0.8;

/**
 * Coerce whatever was persisted (or nothing at all) into a safe settings
 * object. Unknown currencies fall back to MNT, unknown periods to 'day', and a
 * non-positive or non-finite limit disables enforcement entirely - a cap of 0
 * would stop every turn including the first, which no user means.
 */
export function normalizeCircuitBreakerSettings(raw: unknown): CircuitBreakerSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CIRCUIT_BREAKER_SETTINGS };
  const record = raw as Record<string, unknown>;
  const currency: CircuitBreakerSettings['currency'] = record.currency === 'USD' ? 'USD' : 'MNT';
  const period: CircuitBreakerSettings['period'] = record.period === 'session' ? 'session' : 'day';
  const rawLimit = record.limitAmount;
  const limitAmount = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 0;
  // `=== true` on purpose: anything else (1, 'true', {}) must not arm a breaker
  // that stops agents. Default-off is the safe direction for a kill switch.
  const enabled = record.enabled === true && limitAmount > 0;
  return { enabled, limitAmount, currency, period };
}

/** Payload for both renderer notices; `stoppedCount` rides on the trip only. */
export type CircuitBreakerNotice = {
  spentUsd: number;
  limitUsd: number;
  limitAmount: number;
  currency: 'MNT' | 'USD';
  period: 'session' | 'day';
  /**
   * Set when this notice is NOT a near-limit warning but an enforcement
   * advisory: an MNT cap is armed while no exchange rate is known, so the
   * kill switch is temporarily inactive (H1). `spentUsd`/`limitUsd` are 0 in
   * that case - there is nothing comparable to report.
   */
  reason?: 'rate_unavailable';
};

export type CircuitBreakerTrip = CircuitBreakerNotice & {
  /** How many running agents the trip actually stopped. */
  stoppedCount: number;
};

export type CostCircuitBreakerDeps = {
  /** Read the persisted settings (raw - normalized here). */
  loadSettings: () => Promise<unknown>;
  /** Spend in USD over a window (CostAnalyticsService.summary). */
  spendUsd: (window: CostWindow) => number;
  /** Current tögrög-per-USD rate, or null when none is known. */
  mntPerUsd: () => number | null;
  /** Stop every running agent; resolves the number actually stopped. */
  stopActiveAgents: () => Promise<number>;
  emitWarning: (notice: CircuitBreakerNotice) => void;
  emitTripped: (trip: CircuitBreakerTrip) => void;
  now?: () => number;
};

export class CostCircuitBreaker {
  /** Session window start: the moment this breaker (i.e. the app) came up. */
  private readonly sessionStartMs: number;
  /** Periods already warned, keyed by `${period}:${windowStartMs}`. */
  private readonly warned = new Set<string>();
  /** Latched once per app session: "MNT cap armed but no rate known" (H1). */
  private rateUnavailableWarned = false;
  /** Re-entrancy guard so overlapping turn-finishes cannot double-trip. */
  private checking = false;

  constructor(private readonly deps: CostCircuitBreakerDeps) {
    this.sessionStartMs = this.now();
  }

  /**
   * Evaluate the cap after a turn's cost was recorded. Never throws into the
   * recording path; a failure here must not break cost accounting.
   */
  async onTurnRecorded(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const settings = normalizeCircuitBreakerSettings(await this.deps.loadSettings());
      if (!settings.enabled) return;

      const limitUsd = this.limitInUsd(settings);
      // An MNT cap with no known rate cannot be compared to USD spend. Skip
      // rather than guess - guessing a rate on a kill switch cuts both ways.
      // But never go silently dark: the user armed a kill switch and believes
      // it protects them, so tell them ONCE per session that it is temporarily
      // not enforced (H1). Rides the existing warning emitter with a `reason`
      // discriminator so the renderer shows its own copy.
      if (limitUsd === null) {
        if (!this.rateUnavailableWarned) {
          this.rateUnavailableWarned = true;
          this.deps.emitWarning({
            spentUsd: 0,
            limitUsd: 0,
            limitAmount: settings.limitAmount,
            currency: settings.currency,
            period: settings.period,
            reason: 'rate_unavailable',
          });
        }
        return;
      }

      const at = this.now();
      const window = this.windowFor(settings.period, at);
      const spentUsd = this.deps.spendUsd(window);

      const notice: CircuitBreakerNotice = {
        spentUsd,
        limitUsd,
        limitAmount: settings.limitAmount,
        currency: settings.currency,
        period: settings.period,
      };

      if (spentUsd >= limitUsd) {
        const stoppedCount = await this.deps.stopActiveAgents();
        this.deps.emitTripped({ ...notice, stoppedCount });
        return;
      }

      if (spentUsd >= limitUsd * CIRCUIT_BREAKER_WARN_RATIO) {
        const key = `${settings.period}:${window.fromMs}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          this.deps.emitWarning(notice);
        }
      }
    } catch (error) {
      console.warn('[cost] circuit breaker check failed:', error);
    } finally {
      this.checking = false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The user's cap expressed in USD, or null when it cannot be resolved. */
  private limitInUsd(settings: CircuitBreakerSettings): number | null {
    if (settings.currency === 'USD') return settings.limitAmount;
    const rate = this.deps.mntPerUsd();
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
    return settings.limitAmount / rate;
  }

  /** Spend window for the period: calendar day (local) or the app session. */
  private windowFor(period: CircuitBreakerSettings['period'], at: number): CostWindow {
    const fromMs = period === 'day' ? periodStart('day', at) : this.sessionStartMs;
    return { fromMs, toMs: at + 1 };
  }
}
