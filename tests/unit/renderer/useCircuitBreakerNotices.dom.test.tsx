/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Renderer messaging for the cost circuit-breaker notices (H1 + H2/M4).
 *
 * H2/M4: the breaker is reactive (it runs after a turn's cost is recorded), so
 * a trip usually stops ZERO agents - the sticky error must not claim "0 agents
 * were stopped" as if that were the news; it must explain that the cap is
 * exceeded and how to continue.
 *
 * H1: an MNT cap with no known exchange rate arrives as a warning notice with
 * `reason: 'rate_unavailable'` and must render its own copy, not the
 * near-limit copy.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: Record<string, unknown>) => void;

const listeners = vi.hoisted(() => ({
  warning: [] as Listener[],
  tripped: [] as Listener[],
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    cost: {
      circuitBreakerWarning: {
        on: (cb: Listener) => {
          listeners.warning.push(cb);
          return () => {};
        },
      },
      circuitBreakerTripped: {
        on: (cb: Listener) => {
          listeners.tripped.push(cb);
          return () => {};
        },
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Notification: { warning: vi.fn(), error: vi.fn() },
}));

import { Notification } from '@arco-design/web-react';
import { useCircuitBreakerNotices } from '@renderer/hooks/cost/useCircuitBreakerNotices';

const Host: React.FC = () => {
  useCircuitBreakerNotices();
  return null;
};

const BASE_NOTICE = { spentUsd: 12, limitUsd: 10, limitAmount: 10, currency: 'USD', period: 'day' };

afterEach(() => {
  vi.mocked(Notification.warning).mockClear();
  vi.mocked(Notification.error).mockClear();
  listeners.warning.length = 0;
  listeners.tripped.length = 0;
});

describe('useCircuitBreakerNotices - trip copy (H2/M4)', () => {
  it('uses the stopped-agents copy when the trip actually stopped agents', () => {
    render(<Host />);
    act(() => listeners.tripped.forEach((cb) => cb({ ...BASE_NOTICE, stoppedCount: 2 })));

    expect(Notification.error).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Notification.error).mock.calls[0][0] as { content: string };
    expect(call.content).toContain('missionControl.cost.circuitBreaker.tripBody|');
    expect(call.content).not.toContain('tripBodyNoAgents');
  });

  it('uses the no-agents copy when stoppedCount is 0 - never "0 agents were stopped"', () => {
    render(<Host />);
    act(() => listeners.tripped.forEach((cb) => cb({ ...BASE_NOTICE, stoppedCount: 0 })));

    expect(Notification.error).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Notification.error).mock.calls[0][0] as { content: string };
    expect(call.content).toContain('missionControl.cost.circuitBreaker.tripBodyNoAgents');
  });
});

describe('useCircuitBreakerNotices - warning copy (H1)', () => {
  it('renders the near-limit copy for an ordinary warning', () => {
    render(<Host />);
    act(() => listeners.warning.forEach((cb) => cb({ ...BASE_NOTICE, spentUsd: 8 })));

    expect(Notification.warning).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Notification.warning).mock.calls[0][0] as { title: string };
    expect(call.title).toBe('missionControl.cost.circuitBreaker.warnTitle');
  });

  it('renders the rate-unavailable advisory for reason: rate_unavailable', () => {
    render(<Host />);
    act(() =>
      listeners.warning.forEach((cb) =>
        cb({
          spentUsd: 0,
          limitUsd: 0,
          limitAmount: 700_000,
          currency: 'MNT',
          period: 'day',
          reason: 'rate_unavailable',
        })
      )
    );

    expect(Notification.warning).toHaveBeenCalledTimes(1);
    const call = vi.mocked(Notification.warning).mock.calls[0][0] as { title: string; content: string };
    expect(call.title).toBe('missionControl.cost.circuitBreaker.rateMissingTitle');
    expect(call.content).toContain('missionControl.cost.circuitBreaker.rateMissingBody|');
    expect(call.content).toContain('700,000');
  });
});
