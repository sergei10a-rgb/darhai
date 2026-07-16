/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for the SiderMemoryEntry navigation row.
 *
 * The entry is a plain nav row (the Archive/Wiki submenu moved into the memory
 * pages themselves as a header switcher). Mirrors the patterns of the other
 * Sider entry DOM tests:
 *   - Click invokes the supplied `onClick` handler.
 *   - Collapsed mode renders an icon-only row (tested via testid).
 *   - Expanded mode renders the i18n label key.
 *   - Active class is applied when `isActive` is true.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The entry resolves its label via `useTranslation()`. Mock react-i18next so
// the test asserts on the i18n key path explicitly - if the component is wired
// to a wrong key, the test fails.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// The entry fetches the wiki orphan count on mount; stub the bridge so the
// effect resolves quietly in jsdom.
vi.mock('@/common/adapter/ipcBridge', () => ({
  wiki: {
    getState: { invoke: vi.fn().mockResolvedValue({ orphanCandidates: [] }) },
    stateChanged: { on: vi.fn(() => () => undefined) },
  },
}));

// eslint-disable-next-line import/first
import SiderMemoryEntry from '@renderer/components/layout/Sider/SiderNav/SiderMemoryEntry';
// eslint-disable-next-line import/first
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

const tooltipProps: SiderTooltipProps = {
  trigger: 'hover',
  disabled: true,
};

afterEach(() => {
  cleanup();
});

describe('SiderMemoryEntry', () => {
  it('renders the sider.memory label when expanded', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('sider-memory-entry')).toBeTruthy();
    expect(screen.getByText('sider.memory')).toBeTruthy();
  });

  it('hides the label and renders icon-only when collapsed', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('sider-memory-entry')).toBeTruthy();
    expect(screen.queryByText('sider.memory')).toBeNull();
  });

  it('invokes onClick when the row is clicked', () => {
    const onClick = vi.fn();
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive={false}
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={onClick}
      />
    );
    fireEvent.click(screen.getByTestId('sider-memory-entry'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('applies the primary active styling when isActive is true', () => {
    render(
      <SiderMemoryEntry
        isMobile={false}
        isActive
        collapsed={false}
        siderTooltipProps={tooltipProps}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByTestId('sider-memory-entry').className).toContain('text-primary');
  });
});
