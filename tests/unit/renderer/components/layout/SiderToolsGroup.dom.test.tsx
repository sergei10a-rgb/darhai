/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for the SiderToolsGroup collapsible nav group.
 *
 *   - Defaults to collapsed when no stored state and no active child.
 *   - Defaults to expanded when a child route is active.
 *   - Clicking the header toggles children and persists to localStorage.
 *   - Header shows the active tint when a child is active while collapsed.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// eslint-disable-next-line import/first
import SiderToolsGroup from '@renderer/components/layout/Sider/SiderNav/SiderToolsGroup';
// eslint-disable-next-line import/first
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

const LS_KEY = 'wayland.sidebar.tools.expanded';

const tooltipProps: SiderTooltipProps = {
  trigger: 'hover',
  disabled: true,
};

const child = <div data-testid='tools-child'>child</div>;

beforeEach(() => {
  localStorage.removeItem(LS_KEY);
});

afterEach(() => {
  cleanup();
});

describe('SiderToolsGroup', () => {
  it('renders the sider.tools label and starts collapsed by default', () => {
    render(
      <SiderToolsGroup isMobile={false} collapsed={false} siderTooltipProps={tooltipProps} isChildActive={false}>
        {child}
      </SiderToolsGroup>
    );
    expect(screen.getByText('sider.tools')).toBeTruthy();
    const header = screen.getByTestId('sider-tools-header');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('tools-child')).toBeNull();
  });

  it('starts expanded when a child route is active', () => {
    render(
      <SiderToolsGroup isMobile={false} collapsed={false} siderTooltipProps={tooltipProps} isChildActive>
        {child}
      </SiderToolsGroup>
    );
    expect(screen.getByTestId('sider-tools-header').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('tools-child')).toBeTruthy();
  });

  it('toggles children on header click and persists the state', () => {
    render(
      <SiderToolsGroup isMobile={false} collapsed={false} siderTooltipProps={tooltipProps} isChildActive={false}>
        {child}
      </SiderToolsGroup>
    );
    const header = screen.getByTestId('sider-tools-header');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('tools-child')).toBeTruthy();
    expect(localStorage.getItem(LS_KEY)).toBe('true');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('tools-child')).toBeNull();
    expect(localStorage.getItem(LS_KEY)).toBe('false');
  });

  it('respects a stored collapsed state over an active child', () => {
    localStorage.setItem(LS_KEY, 'false');
    render(
      <SiderToolsGroup isMobile={false} collapsed={false} siderTooltipProps={tooltipProps} isChildActive>
        {child}
      </SiderToolsGroup>
    );
    const header = screen.getByTestId('sider-tools-header');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    // Active tint shows on the header so the current location stays visible.
    expect(header.className).toContain('text-primary');
  });

  it('renders an icon-only toggle in collapsed sidebar mode', () => {
    render(
      <SiderToolsGroup isMobile={false} collapsed siderTooltipProps={tooltipProps} isChildActive={false}>
        {child}
      </SiderToolsGroup>
    );
    expect(screen.queryByText('sider.tools')).toBeNull();
    const header = screen.getByTestId('sider-tools-header');
    fireEvent.click(header);
    expect(screen.getByTestId('tools-child')).toBeTruthy();
  });
});
