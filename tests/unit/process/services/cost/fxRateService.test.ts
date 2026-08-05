/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The network side of the tögrög rate.
 *
 * Two promises are load-bearing here. A failed fetch must never clear a good
 * cached rate - losing yesterday's number because today's request timed out
 * would take away a working conversion for nothing. And an implausible response
 * must never reach a spend figure, however well-formed the JSON around it looks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store: { value: unknown } = { value: undefined };

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async () => store.value),
    set: vi.fn(async (_key: string, value: unknown) => {
      store.value = value;
    }),
  },
}));

import { ProcessConfig } from '@process/utils/initStorage';
import {
  fetchMntPerUsd,
  isRefreshDue,
  refreshMntRate,
  RATE_REFRESH_INTERVAL_MS,
} from '@process/services/cost/fxRateService';

const NOW = 1_785_888_000_000;
const RATE = 3580.006747;

const okResponse = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => {
  store.value = undefined;
  vi.clearAllMocks();
});

describe('fetchMntPerUsd', () => {
  it('reads the tögrög rate out of the public response', async () => {
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE, EUR: 0.9 } }));

    expect(await fetchMntPerUsd(fetchFn as unknown as typeof fetch)).toBe(RATE);
  });

  it('sends no key, no identifier - just a request for public rates', async () => {
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE } }));
    await fetchMntPerUsd(fetchFn as unknown as typeof fetch);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://open.er-api.com/v6/latest/USD');
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('returns null rather than a wrong number on every failure shape', async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => ({ ok: false, json: async () => ({}) }) as unknown as Response,
      async () => okResponse({}),
      async () => okResponse({ rates: {} }),
      async () => okResponse({ rates: { MNT: 'lots' } }),
      async () => okResponse({ rates: { MNT: null } }),
      async () => {
        throw new Error('offline');
      },
    ];

    for (const fetchFn of failures) {
      expect(await fetchMntPerUsd(fetchFn as unknown as typeof fetch)).toBeNull();
    }
  });

  it('rejects a well-formed response carrying an implausible rate', async () => {
    // Valid JSON, plausible-looking shape, catastrophic number.
    expect(
      await fetchMntPerUsd((async () => okResponse({ rates: { MNT: 3.58 } })) as unknown as typeof fetch)
    ).toBeNull();
  });
});

describe('isRefreshDue', () => {
  it('is due when nothing has ever been fetched', () => {
    expect(isRefreshDue(undefined, NOW)).toBe(true);
    expect(isRefreshDue(Number.NaN, NOW)).toBe(true);
  });

  it('is not due again within the day', () => {
    expect(isRefreshDue(NOW - 1000, NOW)).toBe(false);
  });

  it('is due once the interval has passed', () => {
    expect(isRefreshDue(NOW - RATE_REFRESH_INTERVAL_MS, NOW)).toBe(true);
  });
});

describe('refreshMntRate', () => {
  it('stores a fresh rate with the time it was taken', async () => {
    store.value = { auto: true };
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE } }));

    await refreshMntRate(NOW, fetchFn as unknown as typeof fetch);

    expect(ProcessConfig.set).toHaveBeenCalledWith('cost.mntRate', {
      auto: true,
      fetched: { mntPerUsd: RATE, asOf: NOW },
    });
  });

  it('makes no network call when the user turned refresh off', async () => {
    store.value = { auto: false };
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE } }));

    await refreshMntRate(NOW, fetchFn as unknown as typeof fetch);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('makes no network call when today’s rate is already cached', async () => {
    store.value = { auto: true, fetched: { mntPerUsd: RATE, asOf: NOW - 1000 } };
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE } }));

    await refreshMntRate(NOW, fetchFn as unknown as typeof fetch);

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('keeps the cached rate when the fetch fails', async () => {
    // The important one: a timeout must not cost the user a working conversion.
    const cached = { mntPerUsd: 3500, asOf: NOW - RATE_REFRESH_INTERVAL_MS - 1 };
    store.value = { auto: true, fetched: cached };

    await refreshMntRate(NOW, (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);

    expect(ProcessConfig.set).not.toHaveBeenCalled();
    expect(store.value).toEqual({ auto: true, fetched: cached });
  });

  it('leaves a manual rate untouched while refreshing the fetched one', async () => {
    // The user's own number must survive a background refresh.
    store.value = { auto: true, manualMntPerUsd: 3400 };
    const fetchFn = vi.fn(async () => okResponse({ rates: { MNT: RATE } }));

    await refreshMntRate(NOW, fetchFn as unknown as typeof fetch);

    expect(store.value).toEqual({
      auto: true,
      manualMntPerUsd: 3400,
      fetched: { mntPerUsd: RATE, asOf: NOW },
    });
  });
});
