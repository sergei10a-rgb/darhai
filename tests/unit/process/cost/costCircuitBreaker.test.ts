import { describe, it, expect, vi } from 'vitest';
import {
  CostCircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_SETTINGS,
  normalizeCircuitBreakerSettings,
  type CircuitBreakerNotice,
  type CircuitBreakerTrip,
  type CostCircuitBreakerDeps,
} from '@process/services/cost/CostCircuitBreaker';
import type { CostWindow } from '@process/services/cost/types';

/** 2026-08-17 12:00 local - a fixed mid-day instant so 'day' windows are stable. */
const NOON = new Date(2026, 7, 17, 12, 0, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 7, 17, 0, 0, 0, 0).getTime();

type Overrides = Partial<CostCircuitBreakerDeps> & { settings?: unknown; spend?: number };

function makeBreaker(overrides: Overrides = {}) {
  const stopActiveAgents = vi.fn(async () => 2);
  const emitWarning = vi.fn((_: CircuitBreakerNotice) => {});
  const emitTripped = vi.fn((_: CircuitBreakerTrip) => {});
  const spendUsd = vi.fn((_: CostWindow) => overrides.spend ?? 0);
  const deps: CostCircuitBreakerDeps = {
    loadSettings: async () => overrides.settings,
    spendUsd,
    mntPerUsd: () => 3500,
    stopActiveAgents,
    emitWarning,
    emitTripped,
    now: () => NOON,
    ...overrides,
  };
  return { breaker: new CostCircuitBreaker(deps), stopActiveAgents, emitWarning, emitTripped, spendUsd };
}

describe('CostCircuitBreaker - trip at the limit', () => {
  it('stops active agents and emits tripped when spend reaches a USD limit', async () => {
    const { breaker, stopActiveAgents, emitTripped, emitWarning } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 10,
    });

    await breaker.onTurnRecorded();

    expect(stopActiveAgents).toHaveBeenCalledTimes(1);
    expect(emitTripped).toHaveBeenCalledTimes(1);
    expect(emitTripped.mock.calls[0][0]).toMatchObject({
      spentUsd: 10,
      limitUsd: 10,
      limitAmount: 10,
      currency: 'USD',
      period: 'day',
      stoppedCount: 2,
    });
    // A trip is a trip, not also a warning.
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('converts an MNT limit through the current rate before comparing', async () => {
    // 700,000 MNT at 3,500 MNT/USD = 200 USD. Spend of 250 USD must trip.
    const { breaker, stopActiveAgents, emitTripped } = makeBreaker({
      settings: { enabled: true, limitAmount: 700_000, currency: 'MNT', period: 'day' },
      spend: 250,
    });

    await breaker.onTurnRecorded();

    expect(stopActiveAgents).toHaveBeenCalledTimes(1);
    expect(emitTripped.mock.calls[0][0]).toMatchObject({ limitUsd: 200, limitAmount: 700_000, currency: 'MNT' });
  });

  it('does not evaluate an MNT limit when no exchange rate is known - but says so ONCE (H1)', async () => {
    const { breaker, stopActiveAgents, emitTripped, emitWarning, spendUsd } = makeBreaker({
      settings: { enabled: true, limitAmount: 700_000, currency: 'MNT', period: 'day' },
      spend: 9999,
      mntPerUsd: () => null,
    });

    await breaker.onTurnRecorded();
    await breaker.onTurnRecorded();
    await breaker.onTurnRecorded();

    // Never trips or guesses a rate on the kill switch...
    expect(spendUsd).not.toHaveBeenCalled();
    expect(stopActiveAgents).not.toHaveBeenCalled();
    expect(emitTripped).not.toHaveBeenCalled();
    // ...but no longer goes silently dark: exactly ONE per-session advisory
    // that the MNT cap is temporarily unenforced, distinguishable by `reason`.
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning.mock.calls[0][0]).toMatchObject({
      reason: 'rate_unavailable',
      limitAmount: 700_000,
      currency: 'MNT',
      period: 'day',
    });
  });

  it('resumes normal enforcement (and can still trip) once the rate appears (H1)', async () => {
    let rate: number | null = null;
    const { breaker, stopActiveAgents, emitTripped, emitWarning } = makeBreaker({
      settings: { enabled: true, limitAmount: 700_000, currency: 'MNT', period: 'day' },
      spend: 250, // 700,000 / 3,500 = 200 USD limit → 250 spend trips
      mntPerUsd: () => rate,
    });

    await breaker.onTurnRecorded(); // no rate → advisory only
    expect(emitWarning).toHaveBeenCalledTimes(1);

    rate = 3500;
    await breaker.onTurnRecorded(); // rate known → real evaluation → trip
    expect(stopActiveAgents).toHaveBeenCalledTimes(1);
    expect(emitTripped).toHaveBeenCalledTimes(1);
    // The advisory did not repeat and near-limit warning did not fire extra.
    expect(emitWarning).toHaveBeenCalledTimes(1);
  });

  it('measures a day limit over the current calendar day window', async () => {
    const { breaker, spendUsd } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 1,
    });

    await breaker.onTurnRecorded();

    expect(spendUsd).toHaveBeenCalledTimes(1);
    const window = spendUsd.mock.calls[0][0];
    expect(window.fromMs).toBe(MIDNIGHT);
    expect(window.toMs).toBe(NOON + 1);
  });

  it('measures a session limit from breaker construction time', async () => {
    let clock = NOON;
    const { breaker, spendUsd } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'session' },
      spend: 1,
      now: () => clock,
    });

    clock = NOON + 60_000; // a minute into the session
    await breaker.onTurnRecorded();

    const window = spendUsd.mock.calls[0][0];
    expect(window.fromMs).toBe(NOON);
    expect(window.toMs).toBe(NOON + 60_000 + 1);
  });
});

describe('CostCircuitBreaker - 80% early warning', () => {
  it('emits the warning once and only once per period', async () => {
    const { breaker, emitWarning, emitTripped, stopActiveAgents } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 8, // exactly 80%
    });

    await breaker.onTurnRecorded();
    await breaker.onTurnRecorded();
    await breaker.onTurnRecorded();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning.mock.calls[0][0]).toMatchObject({ spentUsd: 8, limitUsd: 10, period: 'day' });
    expect(emitTripped).not.toHaveBeenCalled();
    expect(stopActiveAgents).not.toHaveBeenCalled();
  });

  it('stays silent below the warning threshold', async () => {
    const { breaker, emitWarning, emitTripped } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 7.99,
    });

    await breaker.onTurnRecorded();

    expect(emitWarning).not.toHaveBeenCalled();
    expect(emitTripped).not.toHaveBeenCalled();
  });

  it('warns again in a NEW day period after the latch day rolls over', async () => {
    let clock = NOON;
    const { breaker, emitWarning } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 8,
      now: () => clock,
    });

    await breaker.onTurnRecorded();
    clock = NOON + 24 * 60 * 60 * 1000; // same time tomorrow
    await breaker.onTurnRecorded();

    expect(emitWarning).toHaveBeenCalledTimes(2);
  });
});

describe('CostCircuitBreaker - disabled or unenforceable', () => {
  it('does nothing at all when disabled, regardless of spend', async () => {
    const { breaker, stopActiveAgents, emitWarning, emitTripped, spendUsd } = makeBreaker({
      settings: { enabled: false, limitAmount: 10, currency: 'USD', period: 'day' },
      spend: 99999,
    });

    await breaker.onTurnRecorded();

    expect(spendUsd).not.toHaveBeenCalled();
    expect(stopActiveAgents).not.toHaveBeenCalled();
    expect(emitWarning).not.toHaveBeenCalled();
    expect(emitTripped).not.toHaveBeenCalled();
  });

  it('does nothing when no settings were ever persisted', async () => {
    const { breaker, stopActiveAgents, emitTripped } = makeBreaker({ settings: undefined, spend: 99999 });

    await breaker.onTurnRecorded();

    expect(stopActiveAgents).not.toHaveBeenCalled();
    expect(emitTripped).not.toHaveBeenCalled();
  });

  it('never throws into the recording path when a dependency throws', async () => {
    const { breaker } = makeBreaker({
      settings: { enabled: true, limitAmount: 10, currency: 'USD', period: 'day' },
      spendUsd: () => {
        throw new Error('db is on fire');
      },
    });

    await expect(breaker.onTurnRecorded()).resolves.toBeUndefined();
  });
});

describe('normalizeCircuitBreakerSettings', () => {
  it('returns defaults for a missing or non-object value', () => {
    expect(normalizeCircuitBreakerSettings(undefined)).toEqual(DEFAULT_CIRCUIT_BREAKER_SETTINGS);
    expect(normalizeCircuitBreakerSettings(null)).toEqual(DEFAULT_CIRCUIT_BREAKER_SETTINGS);
    expect(normalizeCircuitBreakerSettings('nope')).toEqual(DEFAULT_CIRCUIT_BREAKER_SETTINGS);
    expect(normalizeCircuitBreakerSettings(42)).toEqual(DEFAULT_CIRCUIT_BREAKER_SETTINGS);
  });

  it('keeps a fully valid settings object as-is', () => {
    expect(
      normalizeCircuitBreakerSettings({ enabled: true, limitAmount: 50_000, currency: 'MNT', period: 'session' })
    ).toEqual({ enabled: true, limitAmount: 50_000, currency: 'MNT', period: 'session' });
  });

  it('falls back to MNT for an unknown currency and day for an unknown period', () => {
    const out = normalizeCircuitBreakerSettings({ enabled: true, limitAmount: 5, currency: 'EUR', period: 'year' });
    expect(out.currency).toBe('MNT');
    expect(out.period).toBe('day');
  });

  it('disables enforcement when the limit is zero, negative, NaN, or not a number', () => {
    for (const limitAmount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', undefined]) {
      const out = normalizeCircuitBreakerSettings({ enabled: true, limitAmount, currency: 'USD', period: 'day' });
      expect(out.enabled).toBe(false);
      expect(out.limitAmount).toBe(0);
    }
  });

  it('treats anything but literal true as disabled', () => {
    for (const enabled of [1, 'true', {}, undefined, null]) {
      expect(
        normalizeCircuitBreakerSettings({ enabled, limitAmount: 10, currency: 'USD', period: 'day' }).enabled
      ).toBe(false);
    }
  });
});
