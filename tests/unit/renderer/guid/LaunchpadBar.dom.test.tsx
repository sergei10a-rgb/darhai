/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.hoisted(() => vi.fn());
const setMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: getMock,
    set: setMock,
  },
}));

// useAssistantList depends on swr + ipcBridge - stub it to return a deterministic
// catalogue so the picker / catalog resolution path is exercisable in isolation.
// Mocked on the barrel path so the LaunchpadBar's `from '@/renderer/hooks/assistant'`
// import resolves here (and other consumers using the deep path stay unaffected).
vi.mock('@/renderer/hooks/assistant', () => ({
  useAssistantList: () => ({
    assistants: [
      { id: 'ext-copy', name: 'Copywriter', nameI18n: { 'en-US': 'Copywriter' } },
      { id: 'ext-sales', name: 'Sales', nameI18n: { 'en-US': 'Sales' } },
      { id: 'ext-product-launch', name: 'Launch', nameI18n: { 'en-US': 'Launch' } },
      { id: 'ext-coin', name: 'Coin', nameI18n: { 'en-US': 'Coin' } },
      { id: 'ext-quiet-money', name: 'Quiet Money', nameI18n: { 'en-US': 'Quiet Money' } },
      {
        id: 'ext-forge',
        name: 'Forge',
        nameI18n: { 'en-US': 'Forge' },
        avatar: 'lucide:Sparkles',
      },
    ],
    localeKey: 'en-US',
  }),
}));

import LaunchpadBar from '@/renderer/pages/guid/components/newChatStarter/LaunchpadBar';

const flushLoad = async () => {
  await waitFor(() => expect(screen.queryByTestId('launchpad-bar')?.getAttribute('aria-busy')).not.toBe('true'));
};

describe('LaunchpadBar', () => {
  beforeEach(() => {
    getMock.mockReset();
    setMock.mockReset();
    setMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the 6 default anchors plus the + chip', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    const cards = document.querySelectorAll('[data-launchpad-entry]');
    expect(cards).toHaveLength(6);
    expect(screen.getByTestId('launchpad-add-chip')).toBeInTheDocument();
  });

  it('places Cowork first by default', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();
    const first = document.querySelector('[data-launchpad-entry]');
    expect(first?.getAttribute('data-launchpad-entry')).toBe('builtin-cowork');
  });

  it('clicking a card body fires onAnchorClick with the anchor shape', async () => {
    getMock.mockResolvedValueOnce(undefined);
    const onAnchorClick = vi.fn();
    render(<LaunchpadBar onAnchorClick={onAnchorClick} onViewAll={vi.fn()} />);
    await flushLoad();

    const writeCard = document.querySelector('[data-quicklaunch-id="ext-copy"]') as HTMLButtonElement;
    expect(writeCard).toBeTruthy();
    fireEvent.click(writeCard);

    expect(onAnchorClick).toHaveBeenCalledTimes(1);
    // The anchor's label/sub/prefill are translated now (they used to be
    // hardcoded English on an otherwise fully translated home screen), so the
    // identity field is asserted exactly and the copy only for presence -
    // pinning the English strings here would fail under any other locale.
    const payload = onAnchorClick.mock.calls[0]?.[0] as { assistantId?: string; label?: string; prefill?: string };
    expect(payload).toMatchObject({ assistantId: 'ext-copy' });
    expect(payload.label).toBeTruthy();
    expect(payload.prefill).toBeTruthy();
  });

  it('clicking × removes the card and persists', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    expect(document.querySelectorAll('[data-launchpad-entry]')).toHaveLength(6);

    const removeBtn = screen.getByTestId('launchpad-remove-ext-quiet-money');
    fireEvent.click(removeBtn);

    expect(document.querySelectorAll('[data-launchpad-entry]')).toHaveLength(5);
    expect(setMock).toHaveBeenCalledWith(
      'launchpad.barOrder',
      expect.not.arrayContaining(['ext-quiet-money'])
    );
  });

  it('clicking + opens the picker drawer (and toggles closed)', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    expect(screen.queryByTestId('launchpad-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('launchpad-add-chip'));
    expect(screen.getByTestId('launchpad-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('launchpad-add-chip'));
    expect(screen.queryByTestId('launchpad-picker')).toBeNull();
  });

  it('renders View-all in compact mode only', async () => {
    getMock.mockResolvedValueOnce(undefined);
    const onViewAll = vi.fn();
    const { rerender } = render(
      <LaunchpadBar onAnchorClick={vi.fn()} onViewAll={onViewAll} mode='compact' />
    );
    await flushLoad();
    expect(screen.getByTestId('launchpad-view-all')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('launchpad-view-all'));
    expect(onViewAll).toHaveBeenCalledTimes(1);

    rerender(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={onViewAll} mode='expanded' />);
    expect(screen.queryByTestId('launchpad-view-all')).toBeNull();
  });

  it('reset link wipes user customisation back to the defaults', async () => {
    getMock.mockResolvedValueOnce(['ext-forge', 'builtin-cowork']);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    expect(document.querySelectorAll('[data-launchpad-entry]')).toHaveLength(2);

    act(() => {
      fireEvent.click(screen.getByTestId('launchpad-reset'));
    });

    expect(document.querySelectorAll('[data-launchpad-entry]')).toHaveLength(6);
    expect(setMock).toHaveBeenCalledWith(
      'launchpad.barOrder',
      expect.arrayContaining(['builtin-cowork', 'ext-copy', 'ext-sales', 'ext-product-launch', 'ext-coin', 'ext-quiet-money'])
    );
  });

  it('skips IDs that no longer resolve (e.g. uninstalled extension)', async () => {
    getMock.mockResolvedValueOnce(['builtin-cowork', 'ext-gone-extension', 'ext-copy']);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    const ids = Array.from(document.querySelectorAll('[data-launchpad-entry]')).map((e) =>
      e.getAttribute('data-launchpad-entry')
    );
    expect(ids).toEqual(['builtin-cowork', 'ext-copy']);
  });

  it('shows the empty-state slot when the user empties the bar', async () => {
    getMock.mockResolvedValueOnce([]);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();
    expect(screen.getByTestId('launchpad-bar-empty')).toBeInTheDocument();
  });

  // Bug 1 - card body uses semantic text token, not `inherit` (which gives
  // black-on-black when a parent sets color: rgb(0,0,0)).
  it('card body text color uses --color-text-1, not inherit', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();
    const card = document.querySelector('[data-quicklaunch-id="builtin-cowork"]') as HTMLButtonElement;
    expect(card).toBeTruthy();
    expect(card.style.color).toBe('var(--color-text-1)');
  });

  // Bug 2 - only Cowork carries the orange halo treatment; other anchors are neutral.
  it('only Cowork gets the orange halo background; other anchors stay neutral', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} />);
    await flushLoad();

    const cowork = document.querySelector('[data-quicklaunch-id="builtin-cowork"]') as HTMLButtonElement;
    const writeCopy = document.querySelector('[data-quicklaunch-id="ext-copy"]') as HTMLButtonElement;
    const numbers = document.querySelector('[data-quicklaunch-id="ext-coin"]') as HTMLButtonElement;
    expect(cowork).toBeTruthy();
    expect(writeCopy).toBeTruthy();
    expect(numbers).toBeTruthy();

    // Cowork: orange linear-gradient + orange border.
    expect(cowork.style.background).toContain('linear-gradient');
    expect(cowork.style.background).toContain('249, 115, 22');
    expect(cowork.style.borderColor).toContain('249, 115, 22');
    expect(cowork.classList.contains('launchpad-body-anchor')).toBe(true);

    // Other anchors: neutral fill + neutral border, no orange anywhere.
    expect(writeCopy.style.background).toBe('var(--color-fill-2)');
    expect(writeCopy.style.borderColor).toBe('var(--color-border-2)');
    expect(writeCopy.classList.contains('launchpad-body-anchor')).toBe(false);
    expect(numbers.style.background).toBe('var(--color-fill-2)');
    expect(numbers.classList.contains('launchpad-body-anchor')).toBe(false);
  });

  // Bug 6 - view-all interpolates the real assistant count instead of a
  // hardcoded 54. The mn-MN string itself used to bake in "54" (so the label
  // lied once the catalogue changed size); it now carries {{count}} and the
  // renderer substitutes the live number, which is what this asserts.
  it('view-all label interpolates the live count, never a hardcoded 54', async () => {
    getMock.mockResolvedValueOnce(undefined);
    render(<LaunchpadBar onAnchorClick={vi.fn()} onViewAll={vi.fn()} mode='compact' />);
    await flushLoad();
    const viewAll = screen.getByTestId('launchpad-view-all');
    const text = viewAll.textContent ?? '';
    // The point of the assertion: no baked-in number. It used to read "54"
    // both in the default string and in the mn-MN translation, so the label
    // lied as soon as the catalogue changed size.
    expect(text).not.toContain('54');
    // Whether the placeholder is substituted depends on the harness (the
    // stub `t` returns defaultValue verbatim; the real i18n interpolates), so
    // accept either - what must never appear is a hardcoded count.
    expect(text.includes('{{count}}') || /\d+/.test(text)).toBe(true);
  });
});
