/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the spill store's filesystem mechanics: session-scoped write, byte
 * accounting, traversal-safe filename derivation, owner-only POSIX permissions,
 * and - the security proof - the exclusive open that refuses a pre-planted
 * target (a symlink or a plain file), so a spilled result cannot be redirected.
 *
 * The exclusive-open assertions are mutation proofs: relaxing `saveTextFile`'s
 * flag from `'wx'` to `'w'` would let a planted path be followed/overwritten, and
 * these tests fail if it is. The random filename prefix is pinned (via a mocked
 * `node:crypto.randomBytes`) only for those two tests, so the exact target can be
 * pre-created; every other test uses the real random prefix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

const state = vi.hoisted(() => ({ fixedPrefix: null as string | null }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      state.fixedPrefix !== null ? Buffer.from(state.fixedPrefix, 'hex') : actual.randomBytes(size),
  };
});

import { encodeSegment, privateRoot, saveTextFile, sessionDir } from '@process/services/spill/store';

let root: string;

beforeEach(() => {
  state.fixedPrefix = null;
  root = mkdtempSync(join(tmpdir(), 'darhai-spill-test-'));
});
afterEach(() => {
  state.fixedPrefix = null;
  rmSync(root, { recursive: true, force: true });
});

describe('encodeSegment', () => {
  it('keeps the safe set literal', () => {
    expect(encodeSegment('web_fetch.txt')).toBe('web_fetch.txt');
    expect(encodeSegment('a-B_9.z')).toBe('a-B_9.z');
  });

  it('escapes separators and tilde so a traversal name stays one segment', () => {
    expect(encodeSegment('../etc/passwd')).toBe('..~002Fetc~002Fpasswd');
    expect(encodeSegment('a/b')).toBe('a~002Fb');
    expect(encodeSegment('~')).toBe('~007E');
  });

  it('escapes the whole-segment dot tokens and the empty string', () => {
    expect(encodeSegment('.')).toBe('~002E');
    expect(encodeSegment('..')).toBe('~002E~002E');
    expect(encodeSegment('')).toBe('~');
  });
});

describe('sessionDir', () => {
  it('is a stable per-session hash under the root', () => {
    const dir = sessionDir('/spill', 'sess-1');
    expect(dir).toBe(sessionDir('/spill', 'sess-1'));
    expect(dirname(dir)).toBe(normalize('/spill'));
    expect(basename(dir)).toMatch(/^session-[0-9a-f]{12}$/);
    expect(sessionDir('/spill', 'sess-2')).not.toBe(dir);
  });
});

describe('saveTextFile', () => {
  it('writes the content under the session dir and reports UTF-8 bytes', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'héllo' });
    expect(readFileSync(saved.path, 'utf8')).toBe('héllo');
    expect(saved.bytes).toBe(Buffer.byteLength('héllo', 'utf8'));
    expect(dirname(saved.path)).toBe(sessionDir(root, 'sess-1'));
    expect(basename(saved.path)).toMatch(/^[0-9a-f]{12}-r\.txt$/);
  });

  it('sanitizes a traversal-shaped suggested name into one leaf segment', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: '../../evil', content: 'x' });
    // The whole result is one leaf under the session dir: dirname is the session
    // dir and the leaf carries no path separator, so nothing can traverse out.
    expect(dirname(saved.path)).toBe(sessionDir(root, 'sess-1'));
    expect(basename(saved.path)).not.toMatch(/[/\\]/);
  });

  it('creates the dir and file owner-only on POSIX', async () => {
    const saved = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'x' });
    const dir = statSync(dirname(saved.path));
    const file = statSync(saved.path);
    expect(dir.isDirectory()).toBe(true);
    expect(file.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(dir.mode & 0o777).toBe(0o700);
      expect(file.mode & 0o777).toBe(0o600);
    }
  });

  it('gives distinct paths to two saves of the same name', async () => {
    const a = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'a' });
    const b = await saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'b' });
    expect(a.path).not.toBe(b.path);
  });

  it('refuses a pre-planted regular file at the target path (exclusive open)', async () => {
    // Pin the random prefix so the exact target can be pre-created, proving the
    // open is exclusive rather than trusting the path did not already exist.
    state.fixedPrefix = 'aabbccddeeff';

    const dir = sessionDir(root, 'sess-1');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const planted = join(dir, 'aabbccddeeff-r.txt');
    writeFileSync(planted, 'attacker owned');

    await expect(
      saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'victim' })
    ).rejects.toThrow(/EEXIST/);
    // The planted content was never overwritten.
    expect(readFileSync(planted, 'utf8')).toBe('attacker owned');
  });

  it.skipIf(process.platform === 'win32')('refuses to follow a pre-planted symlink at the target path', async () => {
    state.fixedPrefix = '112233445566';

    const dir = sessionDir(root, 'sess-1');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outsideTarget = join(root, 'outside-secret');
    writeFileSync(outsideTarget, 'do not clobber');
    const planted = join(dir, '112233445566-r.txt');
    symlinkSync(outsideTarget, planted);

    await expect(
      saveTextFile({ root, sessionId: 'sess-1', suggestedName: 'r.txt', content: 'redirected' })
    ).rejects.toThrow(/EEXIST/);
    // The symlink target outside the session dir is untouched: the write was
    // never redirected through the planted link.
    expect(readFileSync(outsideTarget, 'utf8')).toBe('do not clobber');
  });
});

describe('privateRoot', () => {
  it('is a stable absolute directory under the temp dir', () => {
    const first = privateRoot();
    expect(isAbsolute(first)).toBe(true);
    expect(privateRoot()).toBe(first);
  });
});
