/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sandbox policy + confinement-logic tests. These exercise the pure decisions
 * the OS-level sandbox makes — the restricting-SID plan, the honest enforcement
 * report, the argv quoting, the deterministic workspace SID, and the
 * fail-closed orchestration guard — WITHOUT touching koffi/Win32. The
 * FFI-shaped restricted-token construction is covered in restrictedToken.test.ts.
 *
 * Mutation coverage is called out inline: each assertion names the fail-open
 * defect it would catch.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandLine,
  enforcementFor,
  isSandboxSupported,
  quoteArg,
  restrictingSidPlan,
  runSandboxed,
  SandboxUnavailableError,
  supportedConfinedModes,
  workspaceWriteSid,
} from '@process/services/sandbox';

describe('restrictingSidPlan (the security-critical allowlist decision)', () => {
  it('read-only carries ONLY the keep-alive group — no write SID', () => {
    // MUTATION: adding 'write' here would make read-only writable → this fails.
    expect(restrictingSidPlan('read-only', 0)).toEqual(['logon', 'world']);
  });

  it('read-only ignores any write SIDs that were passed', () => {
    // A standing workspace ACE must stay INERT under read-only.
    expect(restrictingSidPlan('read-only', 3)).toEqual(['logon', 'world']);
  });

  it('workspace-write appends one "write" entry per write SID', () => {
    expect(restrictingSidPlan('workspace-write', 1)).toEqual(['logon', 'world', 'write']);
    expect(restrictingSidPlan('workspace-write', 2)).toEqual(['logon', 'world', 'write', 'write']);
  });

  it('workspace-write with zero write SIDs THROWS (fail-closed, refuses a silently read-only token)', () => {
    // MUTATION: returning ['logon','world'] here instead of throwing would hand
    // back a read-only token a caller believes is writable → this fails.
    expect(() => restrictingSidPlan('workspace-write', 0)).toThrow(/at least one write SID/i);
  });
});

describe('enforcementFor (honest enforcement reporting — Windows ACL is PARTIAL)', () => {
  it('confined modes report "partial", never "full"', () => {
    // MUTATION: returning 'full' for either confined mode would overstate the
    // boundary (Everyone stays in the restricting list; hard links alias) → fails.
    expect(enforcementFor('read-only')).toBe('partial');
    expect(enforcementFor('workspace-write')).toBe('partial');
  });

  it('danger-full-access reports "none" (no confinement applied)', () => {
    expect(enforcementFor('danger-full-access')).toBe('none');
  });
});

describe('supportedConfinedModes / isSandboxSupported', () => {
  it('reports the enforceable modes for THIS platform', () => {
    if (process.platform === 'win32') {
      expect(supportedConfinedModes()).toEqual(['read-only', 'workspace-write']);
      expect(isSandboxSupported()).toBe(true);
    } else {
      expect(supportedConfinedModes()).toEqual([]);
      expect(isSandboxSupported()).toBe(false);
    }
  });
});

describe('workspaceWriteSid (deterministic per-workspace identity)', () => {
  it('is deterministic: the same canonical path derives the same SID', () => {
    expect(workspaceWriteSid('C:\\work\\proj')).toBe(workspaceWriteSid('C:\\work\\proj'));
  });

  it('different workspaces derive different SIDs', () => {
    expect(workspaceWriteSid('C:\\work\\a')).not.toBe(workspaceWriteSid('C:\\work\\b'));
  });

  it('produces a valid S-1-4-x-y SID string with non-zero subauthorities', () => {
    const sid = workspaceWriteSid('C:\\work\\proj');
    expect(sid).toMatch(/^S-1-4-\d+-\d+$/);
    const [, , , a, b] = sid.split('-');
    expect(Number(a)).toBeGreaterThan(0);
    expect(Number(b)).toBeGreaterThan(0);
  });
});

describe('quoteArg / buildCommandLine (CommandLineToArgvW quoting)', () => {
  it('leaves simple args bare', () => {
    expect(quoteArg('ffmpeg')).toBe('ffmpeg');
    expect(quoteArg('-i')).toBe('-i');
  });

  it('quotes args containing spaces', () => {
    expect(quoteArg('C:\\Program Files\\a.exe')).toBe('"C:\\Program Files\\a.exe"');
  });

  it('escapes embedded quotes and doubles a trailing backslash run before the closing quote', () => {
    expect(quoteArg('a"b')).toBe('"a\\"b"');
    expect(quoteArg('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
  });

  it('represents an empty arg as an explicit empty quoted string', () => {
    expect(quoteArg('')).toBe('""');
  });

  it('joins program + argv into one command line', () => {
    expect(buildCommandLine('ffmpeg', ['-i', 'in file.mp4'])).toBe('ffmpeg -i "in file.mp4"');
  });
});

describe('runSandboxed fail-closed guards', () => {
  const savedPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('rejects danger-full-access — it is NOT a confined execution', async () => {
    // The caller must spawn its original argv unconfined; routing it through the
    // sandbox must never silently "succeed" as if confinement were applied.
    await expect(
      runSandboxed({ mode: 'danger-full-access', workspaceRoot: 'C:\\w' }, 'cmd', [])
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('rejects a confined policy on a non-Windows host (fail-closed, no unconfined fallback)', async () => {
    // MUTATION: returning a plain-spawn result here instead of throwing would run
    // the command UNCONFINED on a platform with no backend → this fails.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await expect(runSandboxed({ mode: 'read-only', workspaceRoot: '/w' }, 'ls', [])).rejects.toBeInstanceOf(
      SandboxUnavailableError
    );
  });
});
