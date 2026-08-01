/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `.cmd`/`.bat` launchers on Windows: every CLI installed through npm lands on
 * PATH as a batch shim that `spawn(..., { shell: false })` cannot execute
 * (ENOENT for the bare name, EINVAL for the explicit `.cmd` since
 * CVE-2024-27980). These tests pin both halves of the fix: batch shims are
 * routed through an explicitly-invoked cmd.exe with a command line this module
 * owns, and nothing else is touched.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import {
  adaptWindowsLauncher,
  buildBatchLauncherPlan,
  clearWindowsLauncherCache,
  isWindowsBatchLauncher,
} from '../../src/process/utils/windowsLauncher';

const mockExecFileSync = vi.mocked(execFileSync);

let originalPlatform: PropertyDescriptor | undefined;

const setPlatform = (value: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', { value, configurable: true });
};

beforeEach(() => {
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  clearWindowsLauncherCache();
  mockExecFileSync.mockReset();
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  vi.clearAllMocks();
});

describe('isWindowsBatchLauncher', () => {
  it.each([
    ['opencode.cmd', true],
    ['C:\\npm\\opencode.CMD', true],
    ['setup.bat', true],
    ['goose.exe', false],
    ['opencode', false],
    ['node', false],
  ])('%s -> %s', (command, expected) => {
    expect(isWindowsBatchLauncher(command)).toBe(expected);
  });
});

describe('adaptWindowsLauncher - passthrough cases', () => {
  it('never touches a non-Windows spawn', () => {
    setPlatform('linux');
    const plan = adaptWindowsLauncher('opencode.cmd', ['acp'], { PATH: '/usr/bin' });

    expect(plan).toEqual({ command: 'opencode.cmd', args: ['acp'], options: {} });
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('leaves a real executable alone and does not pay for a PATH lookup', () => {
    setPlatform('win32');
    const plan = adaptWindowsLauncher('C:\\Program Files\\Goose\\goose.exe', ['acp'], {});

    expect(plan.command).toBe('C:\\Program Files\\Goose\\goose.exe');
    expect(plan.args).toEqual(['acp']);
    expect(plan.options).toEqual({});
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('prefers the .exe when PATH offers both an .exe and a shim', () => {
    setPlatform('win32');
    mockExecFileSync.mockReturnValue('C:\\bin\\tool.cmd\r\nC:\\bin\\tool.exe\r\n' as unknown as Buffer);

    const plan = adaptWindowsLauncher('tool', ['acp'], { PATH: 'C:\\bin' });

    expect(plan.command).toBe('tool');
    expect(plan.options).toEqual({});
  });

  it('leaves an unresolvable bare command alone so spawn reports the real ENOENT', () => {
    setPlatform('win32');
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const plan = adaptWindowsLauncher('definitely-not-installed', ['acp'], { PATH: 'C:\\bin' });

    expect(plan).toEqual({ command: 'definitely-not-installed', args: ['acp'], options: {} });
  });
});

describe('adaptWindowsLauncher - batch shims', () => {
  it('routes an explicit .cmd through cmd.exe with verbatim arguments', () => {
    setPlatform('win32');
    const plan = adaptWindowsLauncher('C:\\npm\\opencode.cmd', ['acp'], {});

    expect(plan.command.toLowerCase()).toContain('cmd.exe');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // The whole line is wrapped once more: `cmd /c` strips the outermost quotes
    // when the line starts and ends with one.
    expect(plan.args[3]).toBe('""C:\\npm\\opencode.cmd" "acp""');
    expect(plan.options).toEqual({ windowsVerbatimArguments: true });
  });

  it('resolves a bare npm CLI name to its shim and launches that', () => {
    setPlatform('win32');
    mockExecFileSync.mockReturnValue(
      'C:\\Users\\x\\AppData\\Roaming\\npm\\opencode\r\nC:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd\r\n' as unknown as Buffer
    );

    const plan = adaptWindowsLauncher('opencode', ['acp'], { PATH: 'C:\\Users\\x\\AppData\\Roaming\\npm' });

    // The extensionless sh shim is skipped - CreateProcess cannot run it either.
    expect(plan.args[3]).toContain('"C:\\Users\\x\\AppData\\Roaming\\npm\\opencode.cmd"');
    expect(plan.options).toEqual({ windowsVerbatimArguments: true });
  });

  it('resolves each command name only once per PATH', () => {
    setPlatform('win32');
    mockExecFileSync.mockReturnValue('C:\\npm\\opencode.cmd\r\n' as unknown as Buffer);

    adaptWindowsLauncher('opencode', ['acp'], { PATH: 'C:\\npm' });
    adaptWindowsLauncher('opencode', ['acp'], { PATH: 'C:\\npm' });

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('quotes an argument containing spaces rather than splitting it', () => {
    setPlatform('win32');
    const plan = adaptWindowsLauncher('C:\\npm\\agent.cmd', ['--config', 'C:\\Program Files\\a b\\cfg.json'], {});

    expect(plan.args[3]).toContain('"--config" "C:\\Program Files\\a b\\cfg.json"');
  });
});

describe('buildBatchLauncherPlan - injection surface', () => {
  it('keeps shell metacharacters inert inside the quoted token', () => {
    setPlatform('win32');
    // `&` `|` `>` are operators only OUTSIDE quotes; each token is quoted, so
    // this stays a single literal argument instead of chaining a command.
    const plan = buildBatchLauncherPlan('C:\\npm\\agent.cmd', ['a & calc.exe', 'b | whoami', 'c > out.txt']);

    expect(plan.args[3]).toBe('""C:\\npm\\agent.cmd" "a & calc.exe" "b | whoami" "c > out.txt""');
    expect(plan.options).toEqual({ windowsVerbatimArguments: true });
  });

  it('refuses a token with an embedded quote instead of mangling the command line', () => {
    setPlatform('win32');
    expect(() => buildBatchLauncherPlan('C:\\npm\\agent.cmd', ['a" & calc.exe & "b'])).toThrow(
      /cannot be quoted safely/
    );
  });

  it('refuses a token with a percent expansion, which quotes do not neutralise', () => {
    setPlatform('win32');
    expect(() => buildBatchLauncherPlan('C:\\npm\\agent.cmd', ['%USERPROFILE%'])).toThrow(/cannot be quoted safely/);
  });

  it('refuses a CLI path with a newline', () => {
    setPlatform('win32');
    expect(() => buildBatchLauncherPlan('C:\\npm\\agent.cmd\ncalc.exe', [])).toThrow(/cannot be quoted safely/);
  });
});
