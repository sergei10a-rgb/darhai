/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Text typed into the composer and not yet sent used to live in a module-level
 * Map and nowhere else. A renderer reload, an app restart, or a crash took it
 * with them - "the system jumps and all my words in chat box are lost".
 *
 * The round trip below is the real one: type through the hook, then throw away
 * everything a reload throws away - the React tree, the module Map, AND the SWR
 * cache - remount the same conversation, and expect the words back.
 *
 * That last one matters. An earlier version of this file kept one SWR cache
 * across the "reload" and still passed with persistence deleted, because SWR
 * was quietly answering from memory. A reload test that shares a cache with the
 * session before it is not testing a reload.
 */

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { __clearInMemoryDraftsForTests, getSendBoxDraftHook } from '@renderer/hooks/chat/useSendBoxDraft';
import type { FileOrFolderItem } from '@renderer/hooks/chat/useSendBoxDraft';

const initial = {
  _type: 'wcore' as const,
  content: '',
  atPath: [] as Array<string | FileOrFolderItem>,
  uploadFile: [] as string[],
};
const useDraft = getSendBoxDraftHook('wcore', initial);

/** A fresh conversation id per test, so nothing can carry between them. */
let CONV = 'conv-0';
let convCounter = 0;

beforeEach(() => {
  localStorage.clear();
  __clearInMemoryDraftsForTests();
  convCounter += 1;
  CONV = `conv-${convCounter}`;
});

/** Mount the hook with a cache of its own - one app session. */
function mountSession(conversationId: string) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SWRConfig, { value: { provider: () => new Map() } }, children);
  return renderHook(() => useDraft(conversationId), { wrapper });
}

/** Everything a renderer reload destroys except what reached storage. */
function simulateReload(): void {
  cleanup();
  __clearInMemoryDraftsForTests();
}

describe('composer draft persistence', () => {
  it('restores what was typed after a reload', () => {
    const first = mountSession(CONV);
    act(() => first.result.current.mutate((d) => ({ ...d, content: 'half-written thought' })));

    simulateReload();

    expect(mountSession(CONV).result.current.data?.content).toBe('half-written thought');
  });

  it('has the draft on the very first render, not one render later', () => {
    // The gap matters: an empty first render is a window in which a partial
    // update rebuilds from the empty value and overwrites the saved text. The
    // read below happens before any effect could have run, so `fallbackData`
    // is what has to carry it.
    const first = mountSession(CONV);
    act(() => first.result.current.mutate((d) => ({ ...d, content: 'seeded' })));

    simulateReload();

    expect(mountSession(CONV).result.current.data?.content).toBe('seeded');
  });

  it('keeps attachments alongside the text', () => {
    const first = mountSession(CONV);
    act(() => first.result.current.mutate((d) => ({ ...d, content: 'see file', uploadFile: ['/tmp/a.png'] })));

    simulateReload();

    expect(mountSession(CONV).result.current.data?.uploadFile).toEqual(['/tmp/a.png']);
  });

  it('keeps each conversation to its own draft', () => {
    const a = mountSession(`${CONV}-a`);
    const b = mountSession(`${CONV}-b`);
    act(() => a.result.current.mutate((d) => ({ ...d, content: 'for a' })));
    act(() => b.result.current.mutate((d) => ({ ...d, content: 'for b' })));

    simulateReload();

    expect(mountSession(`${CONV}-a`).result.current.data?.content).toBe('for a');
    simulateReload();
    expect(mountSession(`${CONV}-b`).result.current.data?.content).toBe('for b');
  });

  it('forgets an emptied draft instead of resurrecting it', () => {
    // The sent-message case: the composer clears, and the next launch must not
    // put the message back.
    const first = mountSession(CONV);
    act(() => first.result.current.mutate((d) => ({ ...d, content: 'about to send' })));
    act(() => first.result.current.mutate((d) => ({ ...d, content: '' })));

    simulateReload();

    expect(mountSession(CONV).result.current.data?.content).toBeFalsy();
    expect(localStorage.getItem(`send-box-draft/wcore/${CONV}`)).toBeNull();
  });

  it('ignores a stored value that is corrupt or from another platform', () => {
    localStorage.setItem(`send-box-draft/wcore/${CONV}`, 'not json');
    expect(mountSession(CONV).result.current.data?.content).toBeFalsy();

    simulateReload();
    localStorage.setItem(`send-box-draft/wcore/${CONV}`, JSON.stringify({ _type: 'gemini', content: 'x' }));
    expect(mountSession(CONV).result.current.data?.content).toBeFalsy();
  });
});
