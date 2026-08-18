/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * DOM tests for ImportDrawer.
 *
 * Covers:
 *   - Returns null (no inner content) when open=false.
 *   - Renders 4 source cards when open=true.
 *   - Clicking the claude-mem Import button invokes ipcBridge.memory.import.claudeMem.
 *   - Obsidian: auto-detect on open, single-vault auto-select + import,
 *     multi-vault explicit pick, empty-scan re-scan button, folder-picker
 *     preview flow (import + cancel), progress subscription.
 *   - Drop folder card shows Open folder + Process now buttons.
 *   - Close button calls onClose.
 *   - Esc keydown calls onClose.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

// ===== Mocks =====
// All vi.fn() definitions are inside the factory to avoid hoisting issues.

vi.mock('@/common', () => {
  const claudeMemInvoke = vi.fn().mockResolvedValue({ count: 5, errors: [] });
  const obsidianVaultInvoke = vi.fn().mockResolvedValue({ count: 3, errors: [] });
  // ImportDrawer auto-detects vaults on open; default to none found so the
  // "no vaults" cases below stay valid.
  const obsidianDetectVaultsInvoke = vi.fn().mockResolvedValue({ vaults: [] });
  const obsidianPreviewInvoke = vi.fn().mockResolvedValue({ ok: true, mdCount: 5, totalBytes: 1_048_576 });
  const obsidianProgressOn = vi.fn(() => () => {});
  const scanDevDirInvoke = vi.fn().mockResolvedValue({ count: 10, projectsFound: 2, errors: [] });
  const processDropFolderInvoke = vi.fn().mockResolvedValue({ count: 2, errors: [] });
  const openExternalInvoke = vi.fn().mockResolvedValue(undefined);
  const showOpenInvoke = vi.fn().mockResolvedValue([]);

  return {
    ipcBridge: {
      memory: {
        import: {
          claudeMem: { invoke: claudeMemInvoke },
          obsidianVault: { invoke: obsidianVaultInvoke },
          obsidianDetectVaults: { invoke: obsidianDetectVaultsInvoke },
          obsidianPreview: { invoke: obsidianPreviewInvoke },
          obsidianProgress: { on: obsidianProgressOn },
          scanDevDir: { invoke: scanDevDirInvoke },
          processDropFolder: { invoke: processDropFolderInvoke },
        },
      },
      shell: {
        openExternal: { invoke: openExternalInvoke },
      },
      dialog: {
        showOpen: { invoke: showOpenInvoke },
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'defaultValue' in (opts as Record<string, unknown>)) {
        return String((opts as { defaultValue: unknown }).defaultValue);
      }
      return key;
    },
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    onClick,
    loading,
    disabled,
    type: _type,
    long: _long,
    shape: _shape,
    size: _size,
    icon,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    loading?: boolean;
    disabled?: boolean;
    type?: string;
    long?: boolean;
    shape?: string;
    size?: string;
    icon?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled === true || loading === true} {...rest}>
      {icon}
      {children}
    </button>
  ),
  Message: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@icon-park/react', () => ({
  Close: (p: Record<string, unknown>) => <span data-testid='icon-close' {...p} />,
}));

// ===== Subject (imported AFTER mocks) =====

import { ImportDrawer } from '@renderer/pages/memory/components/ImportDrawer';
import { ipcBridge } from '@/common';
import { Message } from '@arco-design/web-react';

// ===== Helper to extract typed mock fns =====

type ImportBridge = {
  memory: {
    import: {
      claudeMem: { invoke: Mock };
      obsidianVault: { invoke: Mock };
      obsidianDetectVaults: { invoke: Mock };
      obsidianPreview: { invoke: Mock };
      obsidianProgress: { on: Mock };
      scanDevDir: { invoke: Mock };
      processDropFolder: { invoke: Mock };
    };
  };
  shell: {
    openExternal: { invoke: Mock };
  };
  dialog: {
    showOpen: { invoke: Mock };
  };
};

function getBridge() {
  return ipcBridge as unknown as ImportBridge;
}

/** Render open and wait for the on-open auto-detect to settle. */
async function renderOpen(onClose = vi.fn()) {
  render(<ImportDrawer open={true} onClose={onClose} />);
  await waitFor(() => {
    expect(getBridge().memory.import.obsidianDetectVaults.invoke).toHaveBeenCalled();
  });
}

// ===== Tests =====

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImportDrawer', () => {
  it('renders no inner content when open=false', () => {
    render(<ImportDrawer open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('import-drawer-inner')).toBeNull();
  });

  it('does not apply drawerOpen class when closed', () => {
    render(<ImportDrawer open={false} onClose={vi.fn()} />);
    const drawer = screen.getByTestId('import-drawer');
    expect(drawer.className).not.toMatch(/drawerOpen/);
  });

  it('renders inner content when open=true', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-drawer-inner')).toBeTruthy();
  });

  it('applies drawerOpen class when open=true', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    const drawer = screen.getByTestId('import-drawer');
    expect(drawer.className).toMatch(/drawerOpen/);
  });

  it('renders 4 source cards when open', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-card-claudemem')).toBeTruthy();
    expect(screen.getByTestId('import-card-obsidian')).toBeTruthy();
    expect(screen.getByTestId('import-card-devscan')).toBeTruthy();
    expect(screen.getByTestId('import-card-dropfolder')).toBeTruthy();
  });

  it('shows header title "Import memories"', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId('import-drawer-title').textContent).toContain('Import memories');
  });

  it('clicking close button calls onClose', () => {
    const onClose = vi.fn();
    render(<ImportDrawer open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('import-drawer-close-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc key calls onClose when open', () => {
    const onClose = vi.fn();
    render(<ImportDrawer open={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc key does not call onClose when closed', () => {
    const onClose = vi.fn();
    render(<ImportDrawer open={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking claude-mem Import button invokes ipcBridge.memory.import.claudeMem', async () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('import-btn-claudemem'));
    await waitFor(() => {
      expect(getBridge().memory.import.claudeMem.invoke).toHaveBeenCalledTimes(1);
    });
  });

  it('clicking dev scan Import button invokes ipcBridge.memory.import.scanDevDir', async () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('import-btn-devscan'));
    await waitFor(() => {
      expect(getBridge().memory.import.scanDevDir.invoke).toHaveBeenCalledTimes(1);
    });
  });

  it('drop folder card shows Open folder button', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    const openBtn = screen.getByTestId('import-btn-openfolder');
    expect(openBtn.textContent).toContain('Open folder');
  });

  it('drop folder card shows Process now button', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    const processBtn = screen.getByTestId('import-btn-dropfolder');
    expect(processBtn.textContent).toContain('Process now');
  });

  it('clicking Open folder invokes ipcBridge.shell.openExternal', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('import-btn-openfolder'));
    expect(getBridge().shell.openExternal.invoke).toHaveBeenCalledTimes(1);
  });

  it('clicking Process now invokes ipcBridge.memory.import.processDropFolder', async () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('import-btn-dropfolder'));
    await waitFor(() => {
      expect(getBridge().memory.import.processDropFolder.invoke).toHaveBeenCalledTimes(1);
    });
  });

  it('drop folder card shows folder path', () => {
    render(<ImportDrawer open={true} onClose={vi.fn()} />);
    const pathEl = screen.getByTestId('import-dropfolder-path');
    expect(pathEl.textContent).toContain('~/Documents/Darhai-Memory/');
  });
});

describe('ImportDrawer - Obsidian card (#553 port)', () => {
  it('auto-detects vaults on open and subscribes to import progress', async () => {
    await renderOpen();
    expect(getBridge().memory.import.obsidianProgress.on).toHaveBeenCalledTimes(1);
  });

  it('a single detected vault is auto-selected and the button imports it', async () => {
    getBridge().memory.import.obsidianDetectVaults.invoke.mockResolvedValueOnce({
      vaults: [{ path: '/home/user/Documents/MyVault', mdCount: 12 }],
    });
    await renderOpen();

    await waitFor(() => {
      expect(screen.getByTestId('import-vault-list')).toBeTruthy();
    });
    const btn = screen.getByTestId('import-btn-obsidian');
    expect(btn.textContent).toContain('Import');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(getBridge().memory.import.obsidianVault.invoke).toHaveBeenCalledWith({
        vaultPath: '/home/user/Documents/MyVault',
      });
    });
  });

  it('multiple detected vaults require an explicit pick before importing', async () => {
    getBridge().memory.import.obsidianDetectVaults.invoke.mockResolvedValueOnce({
      vaults: [
        { path: '/vaults/A', mdCount: 1 },
        { path: '/vaults/B', mdCount: 2 },
      ],
    });
    await renderOpen();

    await waitFor(() => {
      expect(screen.getAllByTestId('import-vault-row').length).toBe(2);
    });
    // No auto-select → the Import button is disabled.
    const btn = screen.getByTestId('import-btn-obsidian') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    // Pick the second vault, then import goes to that path.
    fireEvent.click(screen.getAllByTestId('import-vault-row')[1]);
    await waitFor(() => {
      expect((screen.getByTestId('import-btn-obsidian') as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByTestId('import-btn-obsidian'));
    await waitFor(() => {
      expect(getBridge().memory.import.obsidianVault.invoke).toHaveBeenCalledWith({ vaultPath: '/vaults/B' });
    });
  });

  it('with no vaults the button re-scans (never a silent no-op) and reports an empty result', async () => {
    await renderOpen();
    // Auto-detect found nothing → the button offers a scan, not an import.
    const btn = screen.getByTestId('import-btn-obsidian');
    expect(btn.textContent).toContain('Scan for vaults');

    fireEvent.click(btn);
    await waitFor(() => {
      // 1st call = auto-detect on open, 2nd = the manual re-scan.
      expect(getBridge().memory.import.obsidianDetectVaults.invoke).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect((Message as unknown as { info: Mock }).info).toHaveBeenCalled();
    });
    expect(getBridge().memory.import.obsidianVault.invoke).not.toHaveBeenCalled();
  });

  it('surfaces a scan error on manual re-scan', async () => {
    await renderOpen();
    getBridge().memory.import.obsidianDetectVaults.invoke.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('import-btn-obsidian'));
    await waitFor(() => {
      expect((Message as unknown as { error: Mock }).error).toHaveBeenCalled();
    });
    expect(getBridge().memory.import.obsidianVault.invoke).not.toHaveBeenCalled();
  });

  it('folder picker previews the picked directory, adds it selected, then imports on confirm', async () => {
    getBridge().dialog.showOpen.invoke.mockResolvedValueOnce(['/outside/Миний сан']);
    await renderOpen();

    fireEvent.click(screen.getByTestId('import-btn-obsidian-choose'));
    await waitFor(() => {
      expect(getBridge().memory.import.obsidianPreview.invoke).toHaveBeenCalledWith({
        vaultPath: '/outside/Миний сан',
      });
    });
    // The picked dir appears in the list with the previewed count, selected.
    await waitFor(() => {
      expect(screen.getByTestId('import-vault-list').textContent).toContain('/outside/Миний сан');
    });
    expect((Message as unknown as { info: Mock }).info).toHaveBeenCalled();
    // Import stays behind the explicit press.
    expect(getBridge().memory.import.obsidianVault.invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('import-btn-obsidian'));
    await waitFor(() => {
      expect(getBridge().memory.import.obsidianVault.invoke).toHaveBeenCalledWith({
        vaultPath: '/outside/Миний сан',
      });
    });
  });

  it('a cancelled folder pick does nothing', async () => {
    getBridge().dialog.showOpen.invoke.mockResolvedValueOnce([]);
    await renderOpen();

    fireEvent.click(screen.getByTestId('import-btn-obsidian-choose'));
    await waitFor(() => {
      expect(getBridge().dialog.showOpen.invoke).toHaveBeenCalledTimes(1);
    });
    expect(getBridge().memory.import.obsidianPreview.invoke).not.toHaveBeenCalled();
    expect(getBridge().memory.import.obsidianVault.invoke).not.toHaveBeenCalled();
  });

  it('a failed preview surfaces an error and does not import', async () => {
    getBridge().dialog.showOpen.invoke.mockResolvedValueOnce(['/blocked/dir']);
    getBridge().memory.import.obsidianPreview.invoke.mockResolvedValueOnce({ ok: false, mdCount: 0, totalBytes: 0 });
    await renderOpen();

    fireEvent.click(screen.getByTestId('import-btn-obsidian-choose'));
    await waitFor(() => {
      expect((Message as unknown as { error: Mock }).error).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('import-vault-list')).toBeNull();
    expect(getBridge().memory.import.obsidianVault.invoke).not.toHaveBeenCalled();
  });
});
