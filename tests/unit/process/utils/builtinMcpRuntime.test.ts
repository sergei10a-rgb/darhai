/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every builtin MCP server used to be registered with `command: 'node'`.
 *
 * That is a development assumption. A desktop user installs an .exe, not a
 * JavaScript toolchain, so on an ordinary machine the whole builtin layer -
 * calendar, notes, documents, memory, skill-library search, news, email
 * (including the confirmation gate) and Cal.com - died at spawn.
 *
 * The rule these tests pin: prefer the runtime we ship, and never regress a
 * setup that already worked.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { bunDir: null as string | null } }));

vi.mock('@process/utils/shellEnv', () => ({
  getBundledBunDir: () => state.bunDir,
}));

import { isManagedBuiltinMcpCommand, resolveBuiltinMcpRuntime } from '@process/utils/builtinMcpRuntime';

beforeEach(() => {
  state.bunDir = null;
});

describe('resolveBuiltinMcpRuntime', () => {
  it('uses the bundled bun binary when it is present', () => {
    state.bunDir = '/opt/darhai/resources/bundled-bun/linux-x64';
    const { command } = resolveBuiltinMcpRuntime();

    // The exact basename is platform-dependent; what matters is that it is the
    // shipped binary and not a PATH lookup the user may not be able to satisfy.
    expect(command).toContain('bundled-bun');
    expect(command).not.toBe('node');
  });

  it('falls back to node on PATH when no bundle is staged', () => {
    // A dev checkout, or a packaged build with no bun for this platform/arch.
    // This is exactly the previous behaviour, so the change can only add
    // working setups - never take one away.
    expect(resolveBuiltinMcpRuntime().command).toBe('node');
  });

  it('never resolves to the Electron binary', () => {
    // `process.execPath` + ELECTRON_RUN_AS_NODE looks like the obvious fix and
    // is dead code here: afterPack.js turns the RunAsNode fuse OFF, so a
    // packaged binary ignores the variable and boots a second Darhai GUI.
    for (const bunDir of [null, '/opt/darhai/resources/bundled-bun/linux-x64']) {
      state.bunDir = bunDir;
      expect(resolveBuiltinMcpRuntime().command).not.toBe(process.execPath);
    }
  });
});

describe('isManagedBuiltinMcpCommand', () => {
  it('claims the legacy rows written before the runtime was resolved', () => {
    // Without this, an existing install would never migrate off `node`.
    expect(isManagedBuiltinMcpCommand('node')).toBe(true);
  });

  it('claims a bun path, so a moved install gets refreshed', () => {
    expect(isManagedBuiltinMcpCommand('/old/install/resources/bundled-bun/linux-x64/bun')).toBe(true);
    expect(isManagedBuiltinMcpCommand('C:\\Old\\resources\\bundled-bun\\win32-x64\\bun.exe')).toBe(true);
  });

  it('leaves a command the user chose alone', () => {
    // Registration rewrites in place. It may only touch rows WE wrote, or it
    // would silently undo a deliberate override.
    expect(isManagedBuiltinMcpCommand('/usr/local/bin/my-node-wrapper')).toBe(false);
    expect(isManagedBuiltinMcpCommand('deno')).toBe(false);
    expect(isManagedBuiltinMcpCommand(process.execPath)).toBe(false);
    expect(isManagedBuiltinMcpCommand(undefined)).toBe(false);
    expect(isManagedBuiltinMcpCommand('')).toBe(false);
  });
});
