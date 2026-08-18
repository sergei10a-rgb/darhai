/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the Obsidian verbs registered by importBridge:
 *   - memory.import.obsidian-vault (path policy + progress emission)
 *   - memory.import.obsidian-preview (path policy + preview delegation)
 *   - memory.import.obsidian-detect-vaults (configured + documents merge)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

// ── Mocks ────────────────────────────────────────────────────────────────────

let tmpHome: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('electron', () => ({
  app: { getPath: (_key: string) => '/tmp/darhai-test-obsidian' },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture the provider handlers registered by initImportBridge.
type Handler = (args: unknown) => Promise<unknown>;
const providers = new Map<string, Handler>();

// Hoisted so the vi.mock factories below (which vitest hoists to the top of
// the module) can reference them without hitting the TDZ.
const { progressEmit, runObsidianImportMock, previewVaultMock } = vi.hoisted(() => ({
  progressEmit: vi.fn(),
  runObsidianImportMock: vi.fn(),
  previewVaultMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    memory: {
      import: {
        claudeMem: { provider: (h: Handler) => providers.set('claudeMem', h) },
        obsidianVault: { provider: (h: Handler) => providers.set('obsidianVault', h) },
        obsidianDetectVaults: { provider: (h: Handler) => providers.set('obsidianDetectVaults', h) },
        obsidianPreview: { provider: (h: Handler) => providers.set('obsidianPreview', h) },
        obsidianProgress: { emit: (p: unknown) => progressEmit(p) },
        scanDevDir: { provider: (h: Handler) => providers.set('scanDevDir', h) },
        processDropFolder: { provider: (h: Handler) => providers.set('processDropFolder', h) },
        getDropFolderStatus: { provider: (h: Handler) => providers.set('getDropFolderStatus', h) },
      },
      ingestFiles: { provider: (h: Handler) => providers.set('ingestFiles', h) },
    },
  },
}));

// Stub out the importers / watcher so they don't do real work.
vi.mock('@process/services/import/obsidianImporter', async () => {
  const actual = await vi.importActual<typeof import('@process/services/import/obsidianImporter')>(
    '@process/services/import/obsidianImporter'
  );
  return {
    // Real tilde-expansion/resolution so the path policy is exercised for real.
    expandVaultPath: actual.expandVaultPath,
    detectVaults: vi.fn().mockResolvedValue([{ path: '/docs/VaultA', name: 'VaultA', mdFileCount: 3 }]),
    runObsidianImport: runObsidianImportMock,
    previewVault: previewVaultMock,
  };
});
vi.mock('@process/services/import/claudeMemImporter', () => ({
  runClaudeMemImport: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
}));
vi.mock('@process/services/import/claudeNativeImporter', () => ({
  runClaudeNativeImport: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [] }),
}));
vi.mock('@process/services/import/obsidianVaultConfig', async () => {
  // Resolve inside the factory: on Windows `/outside/...` resolves to
  // `C:\outside\...`, and the bridge compares RESOLVED paths.
  const p = await import('node:path');
  const outside = p.resolve('/outside/ConfiguredVault');
  return {
    detectConfiguredVaults: vi.fn().mockResolvedValue([{ path: outside, name: 'ConfiguredVault', mdCount: 7 }]),
    getConfiguredVaultPaths: vi.fn().mockResolvedValue(new Set([outside])),
  };
});
vi.mock('@process/services/import/devScanImporter', () => ({
  scanForMemoryDirs: vi.fn().mockResolvedValue([]),
  runDevScanImport: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, projectsFound: 0, errors: [] }),
}));
vi.mock('@process/services/import/dropFolderWatcher', () => ({
  runDropFolderProcess: vi.fn().mockResolvedValue({ count: 0, errors: [] }),
  startDropFolderWatcher: vi.fn().mockReturnValue({ stop: vi.fn() }),
  getDropFolderStatus: vi.fn().mockReturnValue({ path: '/tmp/drop', watching: false, ingestedToday: 0 }),
}));
vi.mock('@process/services/memory/ijfwArchiveService', () => ({
  getIjfwArchiveService: vi.fn().mockReturnValue({
    rebuildNow: vi.fn().mockResolvedValue(undefined),
    getProjects: vi.fn().mockResolvedValue([]),
  }),
}));

// eslint-disable-next-line import/first
import { initImportBridge } from '@process/bridge/knowledge/importBridge';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('importBridge - obsidian verbs', () => {
  beforeEach(() => {
    providers.clear();
    progressEmit.mockClear();
    runObsidianImportMock.mockReset();
    previewVaultMock.mockReset();
    tmpHome = path.resolve('/home/darhai-test');
    initImportBridge();
  });

  it('registers all three obsidian providers', () => {
    expect(providers.get('obsidianVault')).toBeDefined();
    expect(providers.get('obsidianDetectVaults')).toBeDefined();
    expect(providers.get('obsidianPreview')).toBeDefined();
  });

  // ── obsidian-vault ─────────────────────────────────────────────────────────

  it('obsidianVault rejects a path outside home that is not a configured vault', async () => {
    const handler = providers.get('obsidianVault')!;
    const result = (await handler({ vaultPath: '/somewhere/else' })) as { count: number; errors: string[] };
    expect(result.count).toBe(0);
    expect(result.errors[0]).toMatch(/home directory|configured/i);
    expect(runObsidianImportMock).not.toHaveBeenCalled();
  });

  it('obsidianVault imports a home-dir vault and re-emits importer progress over IPC', async () => {
    runObsidianImportMock.mockImplementation(
      async (_vaultPath: string, opts: { onProgress?: (done: number, total: number) => void }) => {
        opts.onProgress?.(25, 50);
        opts.onProgress?.(50, 50);
        return { imported: 50, skipped: 0, errors: [], total: 50, capped: false };
      }
    );

    const handler = providers.get('obsidianVault')!;
    const vaultPath = path.join(tmpHome, 'Vault');
    const result = (await handler({ vaultPath })) as { count: number; errors: string[] };

    expect(result.count).toBe(50);
    expect(runObsidianImportMock).toHaveBeenCalledTimes(1);
    expect(progressEmit).toHaveBeenNthCalledWith(1, { done: 25, total: 50 });
    expect(progressEmit).toHaveBeenNthCalledWith(2, { done: 50, total: 50 });
  });

  it('obsidianVault allows a configured vault outside the home dir', async () => {
    runObsidianImportMock.mockResolvedValue({ imported: 7, skipped: 0, errors: [], total: 7, capped: false });
    const handler = providers.get('obsidianVault')!;
    const result = (await handler({ vaultPath: path.resolve('/outside/ConfiguredVault') })) as { count: number };
    expect(result.count).toBe(7);
    expect(runObsidianImportMock).toHaveBeenCalledTimes(1);
  });

  // ── obsidian-preview ───────────────────────────────────────────────────────

  it('obsidianPreview returns counts for a home-dir vault', async () => {
    previewVaultMock.mockResolvedValue({ mdCount: 5, totalBytes: 12_345 });
    const handler = providers.get('obsidianPreview')!;
    const vaultPath = path.join(tmpHome, 'Хувийн сан');
    const result = (await handler({ vaultPath })) as { ok: boolean; mdCount: number; totalBytes: number };
    expect(result).toEqual({ ok: true, mdCount: 5, totalBytes: 12_345 });
    expect(previewVaultMock).toHaveBeenCalledTimes(1);
  });

  it('obsidianPreview rejects a path outside home that is not a configured vault', async () => {
    const handler = providers.get('obsidianPreview')!;
    const result = (await handler({ vaultPath: '/somewhere/else' })) as { ok: boolean; mdCount: number };
    expect(result.ok).toBe(false);
    expect(result.mdCount).toBe(0);
    expect(previewVaultMock).not.toHaveBeenCalled();
  });

  it('obsidianPreview rejects invalid args', async () => {
    const handler = providers.get('obsidianPreview')!;
    const result = (await handler({ nope: true })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(previewVaultMock).not.toHaveBeenCalled();
  });

  // ── obsidian-detect-vaults ─────────────────────────────────────────────────

  it('obsidianDetectVaults merges configured vaults with the Documents scan', async () => {
    const handler = providers.get('obsidianDetectVaults')!;
    const result = (await handler(undefined)) as { vaults: { path: string; mdCount: number }[] };
    const outside = path.resolve('/outside/ConfiguredVault');
    const paths = result.vaults.map((v) => v.path).sort();
    expect(paths).toEqual(['/docs/VaultA', outside].sort());
    const configured = result.vaults.find((v) => v.path === outside);
    expect(configured?.mdCount).toBe(7);
  });
});
