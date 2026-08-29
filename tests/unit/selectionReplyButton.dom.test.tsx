/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reply button, driven the way the browser drives it.
 *
 * The handler bailed on `selection.isCollapsed`, and read the quoted text from
 * `selection.toString()`. Both are wrong for prose inside a shadow root:
 * Chromium reports a selection lying wholly inside one shadow root as
 * COLLAPSED while text is visibly highlighted, and truncates `toString()` at
 * the shadow boundary when a selection spans light and shadow content.
 *
 * Measured on Electron 41.6.0 / Chromium 146 - the table lives in the header of
 * `shadowSelection.ts`. Chromium's own copy is shadow-aware, so Ctrl+C always
 * worked; only the JavaScript read paths were affected, which is why nothing in
 * the suite caught it.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { settleTurns, settleUntil } from '../helpers/eventLoop';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The component calls `t(key, { defaultValue })`, not `t(key, fallback)`.
    // A stub that returns the second argument verbatim hands React an object
    // and the label silently renders as nothing.
    t: (key: string, opts?: string | { defaultValue?: string }) =>
      typeof opts === 'string' ? opts : (opts?.defaultValue ?? key),
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

import SelectionReplyButton from '@renderer/pages/conversation/Messages/components/SelectionReplyButton';
import { registerShadowRoot } from '@/renderer/utils/shadowSelection';

const MESSAGES = [{ id: 'm1', position: 'left' }] as never;

const cleanups: Array<() => void> = [];

/**
 * Build the message element the handler looks for, with prose in a shadow root
 * exactly as MarkdownView renders it.
 */
function mountMessageWithShadowProse(text: string): Text {
  const msg = document.createElement('div');
  msg.id = 'message-m1';
  document.body.appendChild(msg);
  const host = document.createElement('div');
  msg.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const p = document.createElement('p');
  const node = document.createTextNode(text);
  p.appendChild(node);
  root.appendChild(p);
  // ShadowView registers its root on mount; the composed walk can only descend
  // into roots it knows about, so the test has to mirror that.
  cleanups.push(registerShadowRoot(root));
  return node;
}

/** Install the selection Chromium reports for a drag inside one shadow root. */
function installCollapsedShadowSelection(node: Text): void {
  const range = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: node.length,
    getBoundingClientRect: () => ({ top: 300, bottom: 320, left: 100, width: 200 }),
  };
  const selection = {
    // Chromium's report: collapsed and empty, though text is highlighted.
    isCollapsed: true,
    toString: () => '',
    rangeCount: 1,
    // `findMessageElement` walks up from here to locate the message container,
    // crossing the shadow boundary via the root's host.
    anchorNode: node,
    getRangeAt: () => range,
  } as unknown as Selection;
  vi.spyOn(document, 'getSelection').mockReturnValue(selection);
  vi.spyOn(window, 'getSelection').mockReturnValue(selection);
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('SelectionReplyButton over shadow prose', () => {
  it('offers to quote prose the engine reports as a collapsed selection', async () => {
    const node = mountMessageWithShadowProse('THE HIGHLIGHTED ANSWER');
    installCollapsedShadowSelection(node);

    render(<SelectionReplyButton messages={MESSAGES} />);
    fireEvent.mouseUp(document.body, { target: node.parentElement });

    // Wall-clock waits are banned repo-wide (tests/unit/wallClockSleeps.test.ts):
    // under a loaded 24-fork run the timer fires while the pipeline behind it is
    // still in flight. `settleUntil` advances the check phase and a zero-delay
    // timer each turn, so the handler's own 20ms defer still elapses - the test
    // moves with the pipeline instead of racing it. The budget is generous
    // because settleUntil returns the turn its condition holds.
    await settleUntil(() => screen.queryByText('Reply') !== null, 5000);

    expect(screen.queryByText('Reply'), 'no reply affordance for a shadow selection').not.toBeNull();
  });

  it('stays hidden when nothing is selected', async () => {
    mountMessageWithShadowProse('UNSELECTED');
    const empty = {
      isCollapsed: true,
      toString: () => '',
      rangeCount: 0,
      getRangeAt: () => {
        throw new Error('no range');
      },
    } as unknown as Selection;
    vi.spyOn(document, 'getSelection').mockReturnValue(empty);
    vi.spyOn(window, 'getSelection').mockReturnValue(empty);

    render(<SelectionReplyButton messages={MESSAGES} />);
    fireEvent.mouseUp(document.body);
    // Spend the budget in full: proving something did NOT appear means giving
    // the handler every turn it could have used to render it.
    await settleTurns();

    expect(screen.queryByText('Reply')).toBeNull();
  });
});
