/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `refreshBackends` has to REPORT what it found, not just trigger a re-render.
 *
 * One backend is not installed by Darhai and not spawned by it either: LM
 * Studio's server is started by a person, in a GUI app. So the row asks the
 * user to go and start it, and when they say they have, it must find out
 * whether that worked WITHIN THE SAME PRESS - the caller is mid-`await`, and
 * the `controller.selection` it can see is the value captured by the render
 * that began the press. Reading the prop back after awaiting answers the
 * question with the state it was asked in; that exact shape is what once
 * reported a user's own cancelled download to them as a failure.
 *
 * The fix is that the probe resolves with its own result. This file measures
 * the half of that claim the component's DOM suite cannot: the DOM tests stub
 * `refreshBackends`, so they prove the component READS the resolved value, and
 * nothing there proves SWR's bound `mutate()` resolves with freshly fetched
 * data rather than the cached value it was called on. Measured here against
 * the real `useSWR` (2.4.1) with only the IPC boundary replaced.
 */

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookbookBackendSelection } from '@/common/types/cookbook';

/** What the main process would answer for `cookbook.backend-options` next. */
let nextSelection: CookbookBackendSelection = { chosen: 'none', viable: [], provisionable: [] };
const backendOptions = vi.fn(async () => nextSelection);

vi.mock('@/common', () => ({
  ipcBridge: {
    cookbook: {
      listDownloads: { invoke: vi.fn(async () => []) },
      detectBackend: { invoke: vi.fn(async () => 'none') },
      backendOptions: { invoke: () => backendOptions() },
      serveStatus: {
        invoke: vi.fn(async () => ({
          state: 'idle',
          modelId: null,
          backend: 'none',
          port: null,
          providerId: null,
          servedModel: null,
        })),
      },
      onDownloadProgress: { on: () => () => undefined },
      onServeStatus: { on: () => () => undefined },
    },
  },
}));

import { useCookbookServe } from '@/renderer/pages/model-advisor/useCookbookServe';

/** LM Studio installed, its own server switched off. */
const IDLE: CookbookBackendSelection = {
  chosen: 'ollama',
  viable: ['ollama'],
  provisionable: ['lm-studio'],
};
/** The same host a moment after the user started LM Studio's server. */
const SERVING: CookbookBackendSelection = {
  chosen: 'ollama',
  viable: ['ollama', 'lm-studio'],
  provisionable: [],
};

/**
 * A private SWR cache per mount. Without it the module-global cache carries the
 * previous test's answer into the next one, and a test that starts life already
 * knowing LM Studio is up proves nothing about learning it.
 *
 * `dedupingInterval` is deliberately LEFT AT ITS DEFAULT: production calls
 * `refreshBackends` seconds after the initial fetch, so whether `mutate()`
 * bypasses deduping is exactly the behaviour under test, not a knob to turn off.
 */
const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

describe('useCookbookServe refreshBackends', () => {
  beforeEach(() => {
    backendOptions.mockClear();
    nextSelection = IDLE;
  });

  it('resolves with what the probe found, not with the selection it was called on', async () => {
    const { result } = renderHook(() => useCookbookServe(), { wrapper });
    await waitFor(() => expect(result.current.selection.viable).toEqual(['ollama']));

    // The user goes and starts LM Studio's server between the two calls.
    nextSelection = SERVING;

    let answer: CookbookBackendSelection | null = null;
    await act(async () => {
      answer = await result.current.refreshBackends();
    });

    // The caller is still inside the press. `result.current.selection` is the
    // prop it would have re-read; the returned value is what it must trust.
    expect(answer).toEqual(SERVING);
    expect((answer as unknown as CookbookBackendSelection).viable).toContain('lm-studio');
  });

  it('actually re-asks the main process rather than serving the cache', async () => {
    const { result } = renderHook(() => useCookbookServe(), { wrapper });
    await waitFor(() => expect(result.current.selection.viable).toEqual(['ollama']));
    const beforeCalls = backendOptions.mock.calls.length;

    await act(async () => {
      await result.current.refreshBackends();
    });

    // A `mutate()` that resolved from cache would answer instantly with the
    // stale value and never learn that the server came up.
    expect(backendOptions.mock.calls.length).toBeGreaterThan(beforeCalls);
  });

  it('lands the fresh probe in the state every row renders from', async () => {
    const { result } = renderHook(() => useCookbookServe(), { wrapper });
    await waitFor(() => expect(result.current.selection.viable).toEqual(['ollama']));

    nextSelection = SERVING;
    await act(async () => {
      await result.current.refreshBackends();
    });

    // Returning the answer is not a substitute for updating the shared state:
    // every other visible row learns about LM Studio only through this.
    await waitFor(() => expect(result.current.selection.viable).toContain('lm-studio'));
  });
});
