/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which runtime runs the IJFW mcp-server entry.
 *
 * The tempting answer - `process.execPath` with `ELECTRON_RUN_AS_NODE=1` - is
 * dead in a shipped build: `scripts/afterPack.js` (SEC-ELEC-05) turns the
 * Electron RunAsNode fuse OFF, so a packaged binary ignores the variable and
 * boots a second Darhai GUI, which then loses the single-instance lock and
 * quits. Nothing runs, and a window the user did not ask for flashes past.
 *
 * So the order is: the bundled bun we ship, then - only outside a packaged
 * build, where the fuse has not been applied - Electron-as-Node, and otherwise
 * `node` from PATH, which at least fails cleanly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { bunDir: null as string | null, packaged: false } }));

vi.mock('@process/utils/shellEnv', () => ({ getBundledBunDir: () => state.bunDir }));
vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({ paths: { isPackaged: () => state.packaged } }),
}));
vi.mock('@process/services/ijfw/envAllowlist', () => ({
  buildChildEnv: (extra: Record<string, string> = {}) => ({ ...extra }),
}));

import { resolveIjfwNodeRuntime } from '@process/services/ijfw/nodeRuntime';

beforeEach(() => {
  state.bunDir = null;
  state.packaged = false;
});

describe('resolveIjfwNodeRuntime', () => {
  it('prefers the bundled bun, packaged or not', () => {
    state.bunDir = '/opt/darhai/resources/bundled-bun/linux-x64';
    for (const packaged of [true, false]) {
      state.packaged = packaged;
      const rt = resolveIjfwNodeRuntime();
      expect(rt.command).toContain('bundled-bun');
      // bun needs no ELECTRON_RUN_AS_NODE, and adding it would be a lie about
      // what is being spawned.
      expect(rt.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    }
  });

  it('borrows the Electron binary in a dev checkout with no bundle', () => {
    // The fuse is applied at pack time, so this genuinely works here - and a dev
    // machine is exactly where the bundle may not be staged.
    const rt = resolveIjfwNodeRuntime();
    expect(rt.command).toBe(process.execPath);
    expect(rt.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('never spawns the fuse-disabled Electron binary in a packaged build', () => {
    // The regression this pins: with the bundle missing for this platform/arch
    // (x64 without AVX2 and no staged -baseline), the old code fell through to
    // execPath and opened a second GUI instead of running the script.
    state.packaged = true;
    const rt = resolveIjfwNodeRuntime();
    expect(rt.command).not.toBe(process.execPath);
    expect(rt.command).toBe('node');
    expect(rt.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('treats an unavailable platform layer as "not packaged"', async () => {
    // Only tests and tooling can reach that state; a shipped app always has it.
    // Guessing "packaged" would change behaviour nothing asked to change.
    vi.resetModules();
    vi.doMock('@/common/platform', () => ({
      getPlatformServices: () => {
        throw new Error('platform services not initialised');
      },
    }));
    const { resolveIjfwNodeRuntime: resolve } = await import('@process/services/ijfw/nodeRuntime');
    expect(resolve().command).toBe(process.execPath);
    vi.doUnmock('@/common/platform');
    vi.resetModules();
  });

  it('passes the caller env through on every branch', () => {
    for (const [bunDir, packaged] of [
      ['/opt/bundled-bun/linux-x64', false],
      [null, true],
      [null, false],
    ] as Array<[string | null, boolean]>) {
      state.bunDir = bunDir;
      state.packaged = packaged;
      expect(resolveIjfwNodeRuntime({ IJFW_TOKEN: 'abc' }).env.IJFW_TOKEN).toBe('abc');
    }
  });
});
