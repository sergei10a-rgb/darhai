/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Green, but no tools."
 *
 * A catalog-installed MCP server stores the literal string `npx` as its
 * transport command. The connection-test path rewrote that to the bundled Bun
 * runtime before spawning, so the Library badge went green - but every session
 * path forwarded the raw `npx`. On Windows that is `npx.cmd`, which does not
 * resolve through CreateProcess/PATHEXT for a `shell: false` spawn, so the
 * server never started in the live session and the agent got zero tools with no
 * error shown anywhere.
 *
 * Both halves are pinned here: the rewrite must happen on Windows, and it must
 * NOT happen anywhere else - on Linux the resolved absolute path is written into
 * a persisted config.toml, and an AppImage remounts `resources` at a new temp
 * path every launch, so baking one in would create a stale ENOENT path.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@process/utils/mcpScriptDir', () => ({
  // Identity: this test is about the npx decision, not bundled-script rewriting,
  // which mcpScriptDir has its own tests for.
  resolveBuiltinMcpSpawnArgs: (_command: string | undefined, args: readonly string[] | undefined) => [...(args ?? [])],
}));

vi.mock('@process/utils/shellEnv', () => ({
  resolveNpxPath: () => 'C:/Program Files/Darhai/resources/bun/bun.exe',
  normalizeNpxArgsForBundledBun: (args: string[]) =>
    args.filter((arg) => arg !== '-y' && arg !== '--yes' && arg !== '--prefer-offline'),
}));

import { resolveMcpStdioSpawn } from '@process/services/mcpServices/mcpStdioSpawn';

const BUN = 'C:/bun/bun.exe';
const onWindows = (command: string, args: readonly string[] = []) =>
  resolveMcpStdioSpawn(command, args, () => BUN, 'win32');
const onLinux = (command: string, args: readonly string[] = []) =>
  resolveMcpStdioSpawn(command, args, () => BUN, 'linux');

describe('resolveMcpStdioSpawn on Windows', () => {
  it('turns a bare npx into a real binary the session can spawn', () => {
    const spawn = onWindows('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/data']);

    expect(spawn.command).toBe(BUN);
    expect(spawn.args).toEqual(['x', '--bun', '@modelcontextprotocol/server-filesystem', '/data']);
  });

  it('never leaves the command as the literal string npx', () => {
    // This is the actual defect: `npx` reaching CreateProcess is what produced
    // a green badge with no tools.
    expect(onWindows('npx', ['some-server']).command).not.toBe('npx');
  });

  it('drops npx-only flags that bun x does not take', () => {
    expect(onWindows('npx', ['-y', '--prefer-offline', 'pkg']).args).toEqual(['x', '--bun', 'pkg']);
    expect(onWindows('npx', ['--yes', 'pkg']).args).toEqual(['x', '--bun', 'pkg']);
  });

  it('keeps -p/--package through, so multi-bin packages still work', () => {
    expect(onWindows('npx', ['-p', 'some-pkg', 'some-bin']).args).toEqual(['x', '--bun', '-p', 'some-pkg', 'some-bin']);
  });

  it('leaves any other command alone', () => {
    expect(onWindows('node', ['server.js'])).toEqual({ command: 'node', args: ['server.js'] });
    expect(onWindows('uvx', ['mcp-server-git'])).toEqual({ command: 'uvx', args: ['mcp-server-git'] });
  });
});

describe('resolveMcpStdioSpawn off Windows', () => {
  it('leaves npx exactly as stored', () => {
    // `npx` resolves through execvp/PATH here, and the resolved path would be
    // persisted into config.toml where an AppImage relocation makes it stale.
    const spawn = onLinux('npx', ['-y', 'pkg']);

    expect(spawn.command).toBe('npx');
    expect(spawn.args).toEqual(['-y', 'pkg']);
  });

  it('keeps the npx-only flags, because real npx wants them', () => {
    expect(onLinux('npx', ['-y', '--prefer-offline', 'pkg']).args).toEqual(['-y', '--prefer-offline', 'pkg']);
  });

  it('does the same for darwin', () => {
    expect(resolveMcpStdioSpawn('npx', ['pkg'], () => BUN, 'darwin').command).toBe('npx');
  });
});

describe('resolveMcpStdioSpawn argument handling', () => {
  it('copies the args rather than aliasing the caller’s array', () => {
    const args = ['pkg'];
    const spawn = onLinux('node', args);
    spawn.args.push('mutated');

    expect(args).toEqual(['pkg']);
  });

  it('handles a missing args list', () => {
    expect(onWindows('npx').args).toEqual(['x', '--bun']);
    expect(onLinux('node').args).toEqual([]);
  });
});
