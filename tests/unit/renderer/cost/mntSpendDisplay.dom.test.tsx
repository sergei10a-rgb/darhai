/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a spend figure actually renders as.
 *
 * The pure formatter and the rate resolver each have their own tests, but
 * neither proves the thing the user asked for: that a cost surface shows both
 * currencies when a rate is known and dollars alone when it is not. That
 * depends on the hook, the IPC call and the formatter agreeing, which is
 * exactly the seam a unit test on either side would miss.
 */

import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mntRate = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: { cost: { mntRate: { invoke: () => mntRate() } } },
}));

import { useMntRate } from '@renderer/hooks/cost/useMntRate';
import { formatSpend } from '@renderer/utils/format/tokens';

/** A stand-in for any spend surface: it does what CostTab's summary card does. */
const SpendLine: React.FC<{ usd: number; rowRate?: number | null }> = ({ usd, rowRate }) => {
  const { toMnt } = useMntRate();
  return <span data-testid='spend'>{formatSpend(usd, toMnt(usd, rowRate))}</span>;
};

const renderSpend = (usd: number, rowRate?: number | null) =>
  render(
    // A fresh SWR cache per test - the cache is module-global and would
    // otherwise carry one test's rate into the next.
    <SWRConfig value={{ provider: () => new Map() }}>
      <SpendLine usd={usd} rowRate={rowRate} />
    </SWRConfig>
  );

beforeEach(() => {
  mntRate.mockReset();
});

describe('a spend figure on a cost surface', () => {
  it('shows tögrög next to dollars once the rate arrives', async () => {
    mntRate.mockResolvedValue({ mntPerUsd: 3580, asOf: 1_785_888_000_000, source: 'fetched' });

    renderSpend(2);

    await waitFor(() => expect(screen.getByTestId('spend').textContent).toBe('$2.00 · 7,160₮'));
  });

  it('shows dollars alone when no rate is known', async () => {
    // The promise that matters: never print a tögrög figure we cannot justify.
    mntRate.mockResolvedValue(null);

    renderSpend(2);

    await waitFor(() => expect(screen.getByTestId('spend').textContent).toBe('$2.00'));
    expect(screen.getByTestId('spend').textContent).not.toContain('₮');
  });

  it('shows dollars alone while the rate is still loading', async () => {
    mntRate.mockReturnValue(new Promise(() => {}));

    renderSpend(2);

    expect(screen.getByTestId('spend').textContent).toBe('$2.00');
  });

  it('converts a historical row at the rate it was recorded with', async () => {
    // The reason the rate is stamped per row: last month's total must not move
    // when today's rate does.
    mntRate.mockResolvedValue({ mntPerUsd: 3580, asOf: 1_785_888_000_000, source: 'fetched' });

    renderSpend(2, 3000);

    await waitFor(() => expect(screen.getByTestId('spend').textContent).toBe('$2.00 · 6,000₮'));
  });

  it('still converts an old row when the current rate is unknown', async () => {
    mntRate.mockResolvedValue(null);

    renderSpend(2, 3000);

    await waitFor(() => expect(screen.getByTestId('spend').textContent).toBe('$2.00 · 6,000₮'));
  });

  it('does not survive a failed rate lookup by inventing one', async () => {
    mntRate.mockRejectedValue(new Error('bridge down'));

    renderSpend(2);

    await waitFor(() => expect(screen.getByTestId('spend').textContent).toBe('$2.00'));
  });
});
