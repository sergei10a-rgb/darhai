/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for MemoryStatusBar.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object') {
        const o = opts as Record<string, unknown>;
        // Mirror i18next default-value resolution: with `count`, the plural
        // suffix wins (one at 1, other elsewhere); plain defaultValue otherwise.
        const plural =
          typeof o.count === 'number' ? (o.count === 1 ? o.defaultValue_one : o.defaultValue_other) : undefined;
        const template = typeof plural === 'string' ? plural : o.defaultValue;
        if (typeof template === 'string') {
          // Simple interpolation: replace {{key}} with o[key]
          return template.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(o[k] ?? `{{${k}}}`));
        }
      }
      return key;
    },
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    memory: {
      import: {
        getDropFolderStatus: {
          invoke: vi.fn(),
        },
      },
    },
    shell: {
      openPath: {
        invoke: vi.fn(),
      },
    },
  },
}));

import { ipcBridge } from '@/common';
import MemoryStatusBar from '@renderer/pages/memory/components/MemoryStatusBar';

const mockGetDropFolderStatus = () => vi.mocked(ipcBridge.memory.import.getDropFolderStatus.invoke);
const mockOpenPath = () => vi.mocked(ipcBridge.shell.openPath.invoke);

beforeEach(() => {
  mockGetDropFolderStatus().mockResolvedValue({
    path: '/Users/testuser/Documents/Darhai-Memory',
    watching: true,
    ingestedToday: 0,
  });
  mockOpenPath().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MemoryStatusBar', () => {
  it('renders "Brain live" when brainLive is true', () => {
    render(<MemoryStatusBar brainLive cliCount={15} />);
    expect(screen.getByTestId('status-brain-pill').textContent).toContain('Brain live');
  });

  it('renders "Brain offline" when brainLive is false', () => {
    render(<MemoryStatusBar brainLive={false} cliCount={0} />);
    expect(screen.getByTestId('status-brain-pill').textContent).toContain('Brain offline');
  });

  it('renders CLI count pill when cliCount > 0', () => {
    render(<MemoryStatusBar brainLive cliCount={15} />);
    expect(screen.getByTestId('status-cli-pill').textContent).toContain('15');
    expect(screen.getByTestId('status-cli-pill').textContent).toContain('CLIs');
  });

  it('hides CLI pill when cliCount === 0', () => {
    render(<MemoryStatusBar brainLive={false} cliCount={0} />);
    expect(screen.queryByTestId('status-cli-pill')).toBeNull();
  });

  it('renders last dream pill when lastDream is provided', () => {
    render(
      <MemoryStatusBar brainLive cliCount={5} lastDream={{ factsExtracted: 14, promoted: 3, agoMs: 8 * 60 * 1000 }} />
    );
    const dreamPill = screen.getByTestId('status-dream-pill');
    expect(dreamPill.textContent).toContain('14');
    expect(dreamPill.textContent).toContain('3');
  });

  it('hides dream pill when lastDream is absent', () => {
    render(<MemoryStatusBar brainLive cliCount={5} />);
    expect(screen.queryByTestId('status-dream-pill')).toBeNull();
  });

  it('renders keyboard hints (K9 fix)', () => {
    render(<MemoryStatusBar brainLive cliCount={5} />);
    expect(screen.getByTestId('status-kbd-close').textContent).toBe('Esc');
    expect(screen.getByTestId('status-kbd-nav-j').textContent).toBe('J');
    expect(screen.getByTestId('status-kbd-nav-k').textContent).toBe('K');
  });

  it('renders drop folder chip with abbreviated path after IPC resolves', async () => {
    render(<MemoryStatusBar brainLive cliCount={5} />);
    const chip = await screen.findByTestId('status-drop-folder-chip');
    expect(chip.textContent).toContain('~/Documents/Darhai-Memory');
  });

  it('does not render drop folder badge when ingestedToday is 0', async () => {
    render(<MemoryStatusBar brainLive cliCount={5} />);
    await screen.findByTestId('status-drop-folder-chip');
    expect(screen.queryByTestId('status-drop-badge')).toBeNull();
  });

  it('renders drop folder badge with count when ingestedToday > 0', async () => {
    mockGetDropFolderStatus().mockResolvedValue({
      path: '/Users/testuser/Documents/Darhai-Memory',
      watching: true,
      ingestedToday: 3,
    });
    render(<MemoryStatusBar brainLive cliCount={5} />);
    const badge = await screen.findByTestId('status-drop-badge');
    expect(badge.textContent).toContain('3 today');
  });

  it('calls openPath IPC when chip is clicked', async () => {
    render(<MemoryStatusBar brainLive cliCount={5} />);
    const chip = await screen.findByTestId('status-drop-folder-chip');
    fireEvent.click(chip);
    await waitFor(() => {
      expect(mockOpenPath()).toHaveBeenCalledWith({
        path: '/Users/testuser/Documents/Darhai-Memory',
      });
    });
  });

  it('chip is not rendered before IPC resolves', () => {
    mockGetDropFolderStatus().mockReturnValue(new Promise(() => {})); // never resolves
    render(<MemoryStatusBar brainLive cliCount={5} />);
    expect(screen.queryByTestId('status-drop-folder-chip')).toBeNull();
  });
});
