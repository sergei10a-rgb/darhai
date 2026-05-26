/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * Wave 4 -- DOM tests for FullPanelShell. Asserts the 7-tab Arco shell wires
 * up correctly: tabs render in the expected order, default active tab is
 * Home, clicking a tab title changes selection, the header Drop button
 * switches into the Drop tab, and each stub tab renders its placeholder
 * when activated.
 *
 * Arco Tabs uses `lazyload: true` by default, so only the active tab's
 * children are rendered into the DOM. Tests that verify a specific stub
 * tab content first switch to that tab via the URL `?tab=...` query.
 *
 * Active tab is identified via `aria-selected="true"` on the title
 * (Arco `role="tab"` div). There is no parent `role="tablist"` -- Arco's
 * header is a flat list of role-tab elements.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { messageInfoSpy } = vi.hoisted(() => ({
  messageInfoSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return {
    ...actual,
    Message: {
      ...actual.Message,
      info: messageInfoSpy,
    },
  };
});

import FullPanelShell from '@renderer/pages/memory/state-branches/FullPanelShell';

const renderShell = (initialEntries: string[] = ['/memory']) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <FullPanelShell />
    </MemoryRouter>
  );

const getTabTitles = (): HTMLElement[] =>
  Array.from(document.querySelectorAll('[role="tab"]')) as HTMLElement[];

const getActiveTabTitle = (): HTMLElement | null =>
  (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null);

const findTabByText = (text: string): HTMLElement | undefined =>
  getTabTitles().find((el) => el.textContent === text);

afterEach(() => {
  cleanup();
  messageInfoSpy.mockReset();
});

describe('FullPanelShell', () => {
  it('renders the breadcrumb and three header action buttons', () => {
    renderShell();
    expect(screen.getByTestId('memory-full-panel-breadcrumb').textContent).toBe('memory.panel.header_breadcrumb');
    expect(screen.getByTestId('memory-full-panel-button-drop')).toBeTruthy();
    expect(screen.getByTestId('memory-full-panel-button-history')).toBeTruthy();
    expect(screen.getByTestId('memory-full-panel-button-add')).toBeTruthy();
  });

  it('renders all 7 tab labels in the tab bar', () => {
    renderShell();
    const titles = getTabTitles().map((el) => el.textContent);
    expect(titles).toEqual([
      'memory.panel.tab_home',
      'memory.panel.tab_search',
      'memory.panel.tab_wiki',
      'memory.panel.tab_promotions',
      'memory.panel.tab_drop',
      'memory.panel.tab_conflicts',
      'memory.panel.tab_cross_project',
    ]);
  });

  it('defaults to the Home tab when no ?tab query param is set', () => {
    renderShell();
    expect(getActiveTabTitle()?.textContent).toBe('memory.panel.tab_home');
    expect(screen.getByTestId('memory-tab-home')).toBeTruthy();
  });

  it('honors the ?tab query param on initial mount', () => {
    renderShell(['/memory?tab=wiki']);
    expect(getActiveTabTitle()?.textContent).toBe('memory.panel.tab_wiki');
    expect(screen.getByTestId('memory-tab-wiki')).toBeTruthy();
  });

  it('activates the Search tab when its title is clicked', () => {
    renderShell();
    const searchTitle = findTabByText('memory.panel.tab_search');
    expect(searchTitle).toBeTruthy();
    fireEvent.click(searchTitle as HTMLElement);
    expect(getActiveTabTitle()?.textContent).toBe('memory.panel.tab_search');
    expect(screen.getByTestId('memory-tab-search')).toBeTruthy();
  });

  it('switches to the Drop tab when the header Drop button is clicked', () => {
    renderShell();
    expect(getActiveTabTitle()?.textContent).toBe('memory.panel.tab_home');
    fireEvent.click(screen.getByTestId('memory-full-panel-button-drop'));
    expect(getActiveTabTitle()?.textContent).toBe('memory.panel.tab_drop');
    expect(screen.getByTestId('memory-tab-drop')).toBeTruthy();
  });

  // OBSOLETE — Wave 5 replaced the Wave 4e tab stubs with real production
  // components (HomeTab, SearchTab, WikiTab, PromotionsTab, DropTab,
  // ConflictsTab, CrossProjectTab). Each has its own dedicated dom test
  // suite in this directory. The FullPanelShell still verifies tab routing
  // via the test cases above and below; per-tab content is verified by
  // each tab's own *.dom.test.tsx.

it('fires a Message.info stub when the header History button is clicked', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('memory-full-panel-button-history'));
    expect(messageInfoSpy).toHaveBeenCalledTimes(1);
    expect(messageInfoSpy).toHaveBeenCalledWith('memory.panel.button_history');
  });

  it('fires a Message.info stub when the header Add memory button is clicked', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('memory-full-panel-button-add'));
    expect(messageInfoSpy).toHaveBeenCalledTimes(1);
    expect(messageInfoSpy).toHaveBeenCalledWith('memory.panel.button_add');
  });
});
