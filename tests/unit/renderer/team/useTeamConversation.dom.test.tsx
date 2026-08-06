/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The team page held a stale copy of each teammate's conversation.
 *
 * It read the record through a plain `useSWR` with nothing subscribed to
 * changes, so what it showed was whatever the record looked like when the tab
 * was opened. Pick a different model for a teammate from the header and the
 * send box below went on showing - and using - the old one. The user saw their
 * choice apply in one place and not the other, with no way to tell which one
 * the next message would go to.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

type Listener = (event: { conversationId: string; action: string }) => void;

const listeners = new Set<Listener>();
const getConversation = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: (args: { id: string }) => getConversation(args) },
      listChanged: {
        on: (listener: Listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  },
}));

import { useTeamConversation } from '@renderer/pages/team/hooks/useTeamConversation';

/** The one field these tests care about, which the union type does not name. */
const modelIdOf = (data: unknown): string | undefined =>
  (data as { extra?: { currentModelId?: string } } | undefined)?.extra?.currentModelId;

/** What the main process does when a teammate's model changes. */
function announce(conversationId: string, action = 'updated'): void {
  // Iterate the Set itself. A snapshot would only matter if a listener added
  // another listener mid-dispatch, which nothing here does - and Set iteration
  // already skips entries deleted before they are reached, so an unsubscribe
  // during dispatch behaves the way we want without one.
  for (const listener of listeners) listener({ conversationId, action });
}

function mount(conversationId: string | undefined) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);
  return renderHook(() => useTeamConversation(conversationId), { wrapper });
}

beforeEach(() => {
  listeners.clear();
  getConversation.mockReset();
  getConversation.mockResolvedValue({ id: 'conv-1', extra: { currentModelId: 'first' } });
});

afterEach(() => {
  cleanup();
});

describe('useTeamConversation', () => {
  it('reloads the record when the main process says it changed', async () => {
    // The defect, stated directly.
    const hook = mount('conv-1');
    await waitFor(() => expect(modelIdOf(hook.result.current.data)).toBe('first'));

    getConversation.mockResolvedValue({ id: 'conv-1', extra: { currentModelId: 'second' } });
    await act(async () => {
      announce('conv-1');
    });

    await waitFor(() => expect(modelIdOf(hook.result.current.data)).toBe('second'));
  });

  it('ignores a change to somebody else’s conversation', async () => {
    // Every teammate tile mounts one of these; refetching all of them on every
    // announcement would put the whole team's records on the wire at once.
    const hook = mount('conv-1');
    await waitFor(() => expect(getConversation).toHaveBeenCalledTimes(1));

    await act(async () => {
      announce('conv-other');
    });

    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it('ignores create and delete, which are the list’s business', async () => {
    const hook = mount('conv-1');
    await waitFor(() => expect(hook.result.current.data?.id).toBe('conv-1'));

    await act(async () => {
      announce('conv-1', 'created');
      announce('conv-1', 'deleted');
    });

    expect(getConversation).toHaveBeenCalledTimes(1);
  });

  it('fetches nothing for an agent with no conversation yet', async () => {
    mount(undefined);

    expect(getConversation).not.toHaveBeenCalled();
  });

  it('stops listening when the tile unmounts', async () => {
    mount('conv-1');
    await waitFor(() => expect(listeners.size).toBe(1));

    cleanup();

    expect(listeners.size).toBe(0);
  });
});
