/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Task 3.1 — DOM tests for the 6-state MemoryPage router.
 *
 * The page subscribes to `ipcBridge.ijfw.onStatusChanged` on mount and
 * dispatches one of five placeholder components based on
 * {@link IjfwLifecycleStatus}. These tests drive the subscription handler
 * directly and assert the rendered branch — they do not exercise the real
 * IPC layer (Wave 2 owns that wire).
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IjfwStatusPayload } from '@/common/adapter/ipcBridge';

type Listener = (payload: IjfwStatusPayload) => void;

const { listeners, unsubscribeSpy, getStatusInvoke } = vi.hoisted(() => ({
  listeners: new Set<Listener>(),
  unsubscribeSpy: vi.fn(),
  getStatusInvoke: vi.fn<() => Promise<IjfwStatusPayload | undefined>>(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    ijfw: {
      onStatusChanged: {
        on: (fn: Listener) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
            unsubscribeSpy();
          };
        },
      },
      getStatus: { invoke: getStatusInvoke },
    },
  },
}));

import MemoryPage from '@renderer/pages/memory/MemoryPage';

const emit = (payload: IjfwStatusPayload): void => {
  act(() => {
    for (const fn of listeners) fn(payload);
  });
};

beforeEach(() => {
  listeners.clear();
  unsubscribeSpy.mockReset();
  // Default: getStatus resolves with no payload, leaving the page in its
  // initial loading state until an emit arrives. Individual tests override.
  getStatusInvoke.mockReset();
  getStatusInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('MemoryPage', () => {
  it('subscribes to status emitter on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<MemoryPage />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('renders InstallerPitch placeholder when status is not_installed', () => {
    render(<MemoryPage />);
    emit({ status: 'not_installed' });
    expect(screen.getByTestId('memory-installer-pitch-placeholder')).toBeTruthy();
  });

  it('renders Installing placeholder when status is installing', () => {
    render(<MemoryPage />);
    emit({ status: 'installing' });
    expect(screen.getByTestId('memory-installing-placeholder')).toBeTruthy();
  });

  it('renders Installing placeholder when status is upgrading', () => {
    render(<MemoryPage />);
    emit({ status: 'upgrading', version: '1.2.3' });
    const card = screen.getByTestId('memory-installing-placeholder');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('1.2.3');
  });

  it('renders InstallFailed placeholder with errorReason', () => {
    render(<MemoryPage />);
    emit({ status: 'install_failed', errorReason: 'NPM_EXIT_NON_ZERO' });
    const card = screen.getByTestId('memory-install-failed-placeholder');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('NPM_EXIT_NON_ZERO');
  });

  it('renders Installing placeholder when status is installed_pending_activation', () => {
    render(<MemoryPage />);
    emit({ status: 'installed_pending_activation', version: '2.0.0' });
    const card = screen.getByTestId('memory-installing-placeholder');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('2.0.0');
  });

  it('renders OnboardingEmptyState placeholder when status is installed_current', () => {
    // Wave 3 contract: always render OnboardingEmptyState for installed_current;
    // Wave 5 will replace this with the real "has memories?" branching.
    render(<MemoryPage />);
    emit({ status: 'installed_current', version: '1.0.0' });
    expect(screen.getByTestId('memory-onboarding-empty-placeholder')).toBeTruthy();
  });

  it('does not duplicate subscriptions under React strict-mode double-mount', () => {
    const { unmount } = render(
      <React.StrictMode>
        <MemoryPage />
      </React.StrictMode>
    );
    // After strict-mode double-invoke, exactly one listener remains —
    // the first effect's cleanup ran before the second effect attached.
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
