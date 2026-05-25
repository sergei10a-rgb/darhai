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

// useAssistantList depends on swr + ipcBridge — stub it to return a deterministic
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
      { id: 'ext-forge', name: 'Forge', nameI18n: { 'en-US': 'Forge' } },
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
    expect(onAnchorClick.mock.calls[0]?.[0]).toMatchObject({
      assistantId: 'ext-copy',
      label: 'Write copy',
      prefill: 'Draft me ',
    });
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
});
