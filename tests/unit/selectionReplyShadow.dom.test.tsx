/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reply button that could not see what the user had highlighted.
 *
 * Agent prose renders inside a shadow root, and Chromium reports selections
 * that cross that boundary differently from selections in the light tree. Two
 * consequences, both measured on Electron 41.6.0 / Chromium 146 (see the header
 * of `shadowSelection.ts` for the drag-by-drag table):
 *
 *   - A selection lying wholly inside one shadow root reports
 *     `isCollapsed === true` while text is plainly highlighted. The handler bails
 *     on that flag, so the reply button never appears.
 *   - A selection spanning a light node and a shadow root returns only the light
 *     part from `toString()`. The button appears, but quoting the wrong - shorter
 *     - text than the user chose.
 *
 * Chromium's own copy is shadow-aware, so Ctrl+C was never affected. Only the
 * JavaScript read paths were, which is why 14,000 tests stayed green.
 *
 * These tests drive the two helpers the handler depends on, with selection
 * objects shaped the way Chromium shapes them. jsdom cannot produce a real
 * cross-shadow selection, so the boundary points are supplied directly - the
 * part under test is what the code does with them, not the browser's geometry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { collectComposedText, readSelectionText, registerShadowRoot } from '@/renderer/utils/shadowSelection';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.innerHTML = '';
});

/** A host whose shadow root holds `text`, registered the way ShadowView does. */
function mountShadowProse(text: string): { host: HTMLElement; inner: Text } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const p = document.createElement('p');
  const inner = document.createTextNode(text);
  p.appendChild(inner);
  root.appendChild(p);
  cleanups.push(registerShadowRoot(root));
  return { host, inner };
}

/** A Selection stub carrying exactly what Chromium reports for the case. */
function selectionStub(nativeText: string, start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  return {
    toString: () => nativeText,
    rangeCount: 1,
    isCollapsed: nativeText.length === 0,
    getRangeAt: () => ({ startContainer: start, startOffset, endContainer: end, endOffset }),
  } as unknown as Selection;
}

describe('reading a selection that touches a shadow root', () => {
  it('recovers text the engine reports as empty (selection inside one shadow root)', () => {
    const { inner } = mountShadowProse('SHADOW PROSE THE USER HIGHLIGHTED');
    // Chromium's report for this gesture: collapsed, empty string.
    const sel = selectionStub('', inner, 0, inner, inner.length);

    expect(readSelectionText(sel)).toContain('SHADOW PROSE THE USER HIGHLIGHTED');
  });

  it('recovers the shadow half of a selection that starts in the light tree', () => {
    const light = document.createElement('p');
    const lightText = document.createTextNode('LIGHT PART ');
    light.appendChild(lightText);
    document.body.appendChild(light);
    const { inner } = mountShadowProse('SHADOW PART');

    // Chromium truncates at the boundary: only the light half comes back.
    const sel = selectionStub('LIGHT PART ', lightText, 0, inner, inner.length);

    const text = readSelectionText(sel);
    expect(text).toContain('LIGHT PART');
    expect(text, 'the shadow half was dropped').toContain('SHADOW PART');
  });

  it('never returns less than the engine already reported', () => {
    // The composed walk is an addition, not a replacement: if it somehow finds
    // less, the native string still wins. A caller must never lose text by
    // routing through this helper.
    const p = document.createElement('p');
    p.appendChild(document.createTextNode('PLAIN LIGHT SELECTION'));
    document.body.appendChild(p);
    const node = p.firstChild as Text;
    const sel = selectionStub('PLAIN LIGHT SELECTION', node, 0, node, node.length);

    expect(readSelectionText(sel)).toBe('PLAIN LIGHT SELECTION');
  });

  it('returns empty for a genuinely empty selection', () => {
    expect(readSelectionText(null)).toBe('');
  });

  it('walks into a registered shadow root when collecting composed text', () => {
    const { inner } = mountShadowProse('WALKED THROUGH');
    const text = collectComposedText(
      document,
      { container: inner, offset: 0 },
      { container: inner, offset: inner.length }
    );
    expect(text).toContain('WALKED THROUGH');
  });
});
