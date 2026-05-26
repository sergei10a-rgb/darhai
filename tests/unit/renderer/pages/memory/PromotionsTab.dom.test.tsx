/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 5 Task 5.1d - DOM tests for PromotionsTab.
 *
 * Covers:
 *   - List renders one row per pending item.
 *   - Promote button invokes brainInvoke('wiki.promote', { id }).
 *   - Refresh button forces a re-fetch (pollGen increments → invoke fires again).
 *   - On error, backoff doubles: the next poll fires after 60s, not 30s.
 *   - On success, backoff resets: the next poll fires after 30s.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeArgs = { verb: string; args?: Record<string, unknown> };
type InvokeResult = { ok: true; data?: unknown } | { ok: false; error?: string; errorReason?: string };

const { brainInvokeMock, messageSuccessSpy, messageErrorSpy } = vi.hoisted(() => ({
  brainInvokeMock: vi.fn<(args: InvokeArgs) => Promise<InvokeResult>>(),
  messageSuccessSpy: vi.fn(),
  messageErrorSpy: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      brainInvoke: { invoke: brainInvokeMock },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'time' in opts) {
        return `${key}|${String((opts as { time: string }).time)}`;
      }
      return key;
    },
  }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      ...actual.Message,
      success: messageSuccessSpy,
      error: messageErrorSpy,
    },
  };
});

import PromotionsTab from '@renderer/pages/memory/tabs/PromotionsTab';

const PENDING_OK: InvokeResult = {
  ok: true,
  data: {
    pending: [
      { id: 'p-1', preview: 'Stripe webhooks must be idempotent', queuedAt: 1_700_000_000_000 },
      { id: 'p-2', preview: 'Cron skill defaults to PROPOSE', queuedAt: 1_700_000_001_000 },
    ],
  },
};

beforeEach(() => {
  brainInvokeMock.mockReset();
  messageSuccessSpy.mockReset();
  messageErrorSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PromotionsTab', () => {
  it('renders one row per pending item from memory_facts', async () => {
    brainInvokeMock.mockResolvedValue(PENDING_OK);
    render(<PromotionsTab />);
    expect(await screen.findByTestId('memory-promotions-row-p-1')).toBeTruthy();
    expect(screen.getByTestId('memory-promotions-row-p-2')).toBeTruthy();
  });

  it('Promote button invokes wiki.promote with the row id and shows success', async () => {
    brainInvokeMock.mockImplementation(async ({ verb }) => {
      if (verb === 'wiki.promote') return { ok: true };
      return PENDING_OK;
    });
    render(<PromotionsTab />);
    const btn = await screen.findByTestId('memory-promotions-promote-p-1');
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(brainInvokeMock).toHaveBeenCalledWith({
        verb: 'wiki.promote',
        args: { id: 'p-1' },
      });
    });
    await waitFor(() => {
      expect(messageSuccessSpy).toHaveBeenCalledWith('memory.promotions.promote_success');
    });
  });

  it('Refresh button forces a re-fetch (pollGen increments)', async () => {
    brainInvokeMock.mockResolvedValue(PENDING_OK);
    render(<PromotionsTab />);
    await screen.findByTestId('memory-promotions-row-p-1');
    const initial = brainInvokeMock.mock.calls.length;
    const refresh = screen.getByTestId('memory-promotions-refresh');
    await act(async () => {
      fireEvent.click(refresh);
    });
    await waitFor(() => {
      expect(brainInvokeMock.mock.calls.length).toBeGreaterThan(initial);
    });
  });

  it('on error, backoff doubles - the next poll does not fire at 30s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    brainInvokeMock.mockResolvedValue({ ok: false, errorReason: 'mcp_error' });

    render(<PromotionsTab />);
    // Flush microtasks so the initial ok:false resolves and the polling
    // effect runs (which both doubles backoff to 60s and schedules the next
    // timer based on the doubled value).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterInitial = brainInvokeMock.mock.calls.length;
    expect(callsAfterInitial).toBeGreaterThan(0);

    // Advance 30s - backoff is now 60s, so no new fetch yet.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(brainInvokeMock.mock.calls.length).toBe(callsAfterInitial);

    // Advance to 60s total - the next poll fires.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(brainInvokeMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
  });

  it('on success, the next poll fires at the 30s base interval', async () => {
    vi.useFakeTimers();
    brainInvokeMock.mockResolvedValue(PENDING_OK);

    render(<PromotionsTab />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const callsAfterInitial = brainInvokeMock.mock.calls.length;

    // Advance 29s - no poll yet.
    await act(async () => {
      vi.advanceTimersByTime(29_000);
      await Promise.resolve();
    });
    expect(brainInvokeMock.mock.calls.length).toBe(callsAfterInitial);

    // Advance 1s more (total 30s) - the next scheduled poll fires.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(brainInvokeMock.mock.calls.length).toBeGreaterThan(callsAfterInitial);
  });
});
