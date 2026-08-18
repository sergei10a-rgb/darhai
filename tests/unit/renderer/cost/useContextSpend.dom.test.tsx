/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The per-chat spend hook that feeds the context indicator.
 *
 * It must (1) do nothing at all without a conversation to attribute cost to,
 * (2) read the ONE matching conversation out of the all-conversation aggregate
 * the cost service returns, (3) convert to tögrög through the shared rate,
 * (4) treat a zero or missing figure as "no spend" rather than a real zero, and
 * (5) never let a failed cost read throw into the send box - a swallowed error
 * becomes null, not a crash. Each test below pins one of those five rules.
 */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const byConversationInvoke = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    cost: {
      byConversation: {
        invoke: (...args: unknown[]) => byConversationInvoke(...args),
      },
    },
  },
}));

// A fixed, known rate so the tögrög assertion is exact: 1 USD => 3500₮.
vi.mock('@/renderer/hooks/cost/useMntRate', () => ({
  useMntRate: () => ({
    rate: { mntPerUsd: 3500, asOf: 0, source: 'manual' as const },
    toMnt: (usd: number) => usd * 3500,
  }),
}));

import { useContextSpend } from '@/renderer/hooks/cost/useContextSpend';

/** Fresh SWR cache per render so one test's fetch never leaks into the next. */
const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

const renderSpend = (conversationId?: string) => renderHook(() => useContextSpend(conversationId), { wrapper });

describe('useContextSpend', () => {
  beforeEach(() => {
    byConversationInvoke.mockReset();
  });

  it('does not fetch and reports no spend without a conversation id', async () => {
    const { result } = renderSpend(undefined);
    expect(result.current).toEqual({ spendUsd: null, spendMnt: null });
    // The null SWR key must keep the bridge untouched.
    await waitFor(() => expect(byConversationInvoke).not.toHaveBeenCalled());
  });

  it('extracts the matching conversation and converts it to tögrög', async () => {
    byConversationInvoke.mockResolvedValue([
      { key: 'other', costUsd: 9, tokensTotal: 0, events: 1 },
      { key: 'conv-1', costUsd: 0.5, tokensTotal: 1234, events: 3 },
    ]);
    const { result } = renderSpend('conv-1');
    await waitFor(() => expect(result.current.spendUsd).toBe(0.5));
    expect(result.current.spendMnt).toBe(1750);
  });

  it('reports no spend when the conversation is absent from the aggregate', async () => {
    byConversationInvoke.mockResolvedValue([{ key: 'someone-else', costUsd: 4, tokensTotal: 0, events: 1 }]);
    const { result } = renderSpend('conv-1');
    await waitFor(() => expect(byConversationInvoke).toHaveBeenCalled());
    expect(result.current).toEqual({ spendUsd: null, spendMnt: null });
  });

  it('treats a zero recorded cost as no spend, not a real zero', async () => {
    byConversationInvoke.mockResolvedValue([{ key: 'conv-1', costUsd: 0, tokensTotal: 500, events: 2 }]);
    const { result } = renderSpend('conv-1');
    await waitFor(() => expect(byConversationInvoke).toHaveBeenCalled());
    expect(result.current).toEqual({ spendUsd: null, spendMnt: null });
  });

  it('swallows a failed cost read and reports no spend', async () => {
    byConversationInvoke.mockRejectedValue(new Error('bridge down'));
    const { result } = renderSpend('conv-1');
    await waitFor(() => expect(byConversationInvoke).toHaveBeenCalled());
    expect(result.current).toEqual({ spendUsd: null, spendMnt: null });
  });
});
