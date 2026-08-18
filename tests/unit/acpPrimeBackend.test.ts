/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="node" />

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Config registration (no mocks needed) ────────────────────────────────
// prime is registered in ACP_BACKENDS_ALL; POTENTIAL_ACP_CLIS is auto-generated
// from it, so a single config entry drives both detection and connection.
import { ACP_BACKENDS_ALL, POTENTIAL_ACP_CLIS } from '../../src/common/types/acpTypes';

describe('prime ACP backend registration', () => {
  it('registers prime in ACP_BACKENDS_ALL with the prime-agent CLI and --mode acp', () => {
    const prime = ACP_BACKENDS_ALL.prime;
    expect(prime).toBeDefined();
    expect(prime.id).toBe('prime');
    expect(prime.cliCommand).toBe('prime-agent');
    // Mutation proof: the ACP launch flag must be exactly `--mode acp`. A wrong
    // flag (e.g. the default --experimental-acp) would silently start the wrong
    // prime mode, so pin the exact argv.
    expect(prime.acpArgs).toEqual(['--mode', 'acp']);
    expect(prime.enabled).toBe(true);
    // prime uses environment API keys, not an interactive login flow (like droid).
    expect(prime.authRequired).toBe(false);
  });

  it('exposes prime for auto-detection via POTENTIAL_ACP_CLIS', () => {
    const primeCli = POTENTIAL_ACP_CLIS.find((cli) => cli.backendId === 'prime');
    expect(primeCli).toBeDefined();
    // The generated detection entry must carry the same command + args the
    // connector will spawn - otherwise a detected agent would launch with the
    // wrong flags.
    expect(primeCli?.cmd).toBe('prime-agent');
    expect(primeCli?.args).toEqual(['--mode', 'acp']);
  });

  it('discloses the Windows kernel caveat in the backend description', () => {
    const description = ACP_BACKENDS_ALL.prime.description ?? '';
    // The disclosure must name Windows AND the WSL/Linux recommendation so the
    // user learns of the runtime caveat before selecting prime on Windows.
    expect(description).toMatch(/Windows/i);
    expect(description).toMatch(/WSL|Linux/i);
  });
});

// ── Spawn behaviour (mirrors acpConnectors.test.ts mock setup) ────────────
const { fsPromisesMock } = vi.hoisted(() => ({
  fsPromisesMock: {
    access: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(async () => undefined),
  },
}));

vi.mock('fs', () => ({
  promises: fsPromisesMock,
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(() => 'v20.10.0\n'),
}));

vi.mock('@process/utils/shellEnv', () => ({
  findSuitableNodeBin: vi.fn(() => null),
  getEnhancedEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
  getNpxCacheDir: vi.fn(() => '/mock-npm-cache/_npx'),
  getWindowsShellExecutionOptions: vi.fn(() =>
    process.platform === 'win32' ? { shell: true, windowsHide: true } : {}
  ),
  loadFullShellEnvironment: vi.fn(async () => ({ PATH: '/usr/bin' })),
  normalizeNpxArgsForBundledBun: vi.fn((args: string[]) =>
    args.filter((arg) => arg !== '-y' && arg !== '--yes' && arg !== '--prefer-offline')
  ),
  resolveNpxPath: vi.fn(() => '/bundled/bun'),
  resolveNpxDirect: vi.fn(() => null),
}));

vi.mock('@process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainWarn: vi.fn(),
}));

vi.mock('@process/services/ccSwitchModelSource', () => ({
  readClaudeProviderEnvFromCcSwitch: vi.fn(() => ({})),
}));

import { spawn } from 'child_process';
import { spawnGenericBackend } from '../../src/process/agent/acp/acpConnectors';

const mockSpawn = vi.mocked(spawn);

describe('prime ACP backend spawn', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  const mockChild = { unref: vi.fn() };

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);
    fsPromisesMock.readdir.mockRejectedValue(new Error('cache not found'));
    fsPromisesMock.stat.mockRejectedValue(new Error('not found'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('spawns prime-agent with the --mode acp argv on POSIX (detached process group)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const result = await spawnGenericBackend('prime', 'prime-agent', '/cwd', ['--mode', 'acp']);

    expect(mockSpawn).toHaveBeenCalledWith(
      'prime-agent',
      ['--mode', 'acp'],
      expect.objectContaining({
        cwd: '/cwd',
        detached: true,
        shell: false,
      })
    );
    expect(result.isDetached).toBe(true);
    expect(mockChild.unref).toHaveBeenCalledTimes(1);
  });

  it('spawns prime-agent without a shell on Windows (SEC-ACP-04, not detached)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const result = await spawnGenericBackend('prime', 'prime-agent', 'C:\\cwd', ['--mode', 'acp']);

    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe('prime-agent');
    // Mutation proof: the exact ACP-mode argv must reach the process, unwrapped
    // and unshelled. A dropped or reordered flag fails here.
    expect(args).toEqual(['--mode', 'acp']);
    expect(options).toMatchObject({ cwd: 'C:\\cwd', detached: false, shell: false, windowsHide: true });
    expect(result.isDetached).toBe(false);
    expect(mockChild.unref).not.toHaveBeenCalled();
  });
});
