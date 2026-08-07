/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The write that vanished when anyone was looking at the file.
 *
 * POSIX rename(2) replaces the target even while another process holds it
 * open. Windows MoveFileEx does not: holding the target open FOR READING is
 * enough to make the rename fail EPERM (measured on win32 10.0.26200 / Node
 * 24). So an "atomic" write silently failed whenever a viewer, a backup
 * daemon, or the app's own second window had the file open - a Windows-only
 * failure the developers on POSIX never saw.
 *
 * The fix falls back to copy+unlink on the rename-failure codes. These tests
 * force those codes by making `rename`/`renameSync` throw a chosen errno while
 * every other fs call stays real, so the fallback is exercised on every
 * platform - not only when a real Windows handle happens to be open. Reads,
 * copies and directory listings hit the actual disk, so "the data landed" and
 * "no tmp was orphaned" are checked against real files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Per-test control over how the next rename behaves. */
const { ctl } = vi.hoisted(() => ({
  ctl: { renameFail: null as string | null, unlinkFail: null as string | null },
}));

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

vi.mock('fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('fs')>();
  const renameSync: typeof orig.renameSync = (from, to) => {
    if (ctl.renameFail) {
      const code = ctl.renameFail;
      ctl.renameFail = null;
      throw errno(code);
    }
    return orig.renameSync(from, to);
  };
  const promises: typeof orig.promises = {
    ...orig.promises,
    rename: async (from, to) => {
      if (ctl.renameFail) {
        const code = ctl.renameFail;
        ctl.renameFail = null;
        throw errno(code);
      }
      return orig.promises.rename(from, to);
    },
    unlink: async (p) => {
      if (ctl.unlinkFail) {
        const code = ctl.unlinkFail;
        ctl.unlinkFail = null;
        throw errno(code);
      }
      return orig.promises.unlink(p);
    },
  };
  return { ...orig, renameSync, promises };
});

// eslint-disable-next-line import/first
import * as fsSync from 'fs';
// eslint-disable-next-line import/first
import { promises as fs } from 'fs';
// eslint-disable-next-line import/first
import path from 'path';
// eslint-disable-next-line import/first
import os from 'os';
// eslint-disable-next-line import/first
import { moveFileAtomic, writeFileAtomic, writeFileSyncAtomic } from '@process/utils/atomicWrite';

let tmpDir: string;

beforeEach(async () => {
  ctl.renameFail = null;
  ctl.unlinkFail = null;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomicWrite-win-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpLeftovers = (dir: string): string[] => fsSync.readdirSync(dir).filter((n) => n.includes('.tmp-'));

describe('writeFileSyncAtomic - Windows rename-over-open-file fallback', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES', 'EXDEV'])('lands the write via copy+unlink when rename throws %s', (code) => {
    const target = path.join(tmpDir, 'state.json');
    fsSync.writeFileSync(target, 'OLD');
    ctl.renameFail = code;

    writeFileSyncAtomic(target, 'NEW');

    // The user's data landed, and no tmp was orphaned.
    expect(fsSync.readFileSync(target, 'utf-8')).toBe('NEW');
    expect(tmpLeftovers(tmpDir)).toEqual([]);
  });

  it('does NOT fall back on an unrelated error - it cleans up and rethrows', () => {
    const target = path.join(tmpDir, 'state.json');
    fsSync.writeFileSync(target, 'OLD');
    ctl.renameFail = 'ENOSPC';

    // Copying under ENOSPC would just consume the space that caused it, so the
    // error must surface and the original file stay put.
    expect(() => writeFileSyncAtomic(target, 'NEW')).toThrow(/ENOSPC/);
    expect(fsSync.readFileSync(target, 'utf-8')).toBe('OLD');
    expect(tmpLeftovers(tmpDir)).toEqual([]);
  });

  it('uses a PID-stamped tmp so two writers cannot clobber each other', () => {
    const target = path.join(tmpDir, 'state.json');
    // Fail the rename so the tmp is copied then removed; capture its name from
    // the copy, since the tmp no longer exists afterward.
    ctl.renameFail = 'EPERM';
    const copySpy = vi.spyOn(fsSync, 'copyFileSync');

    writeFileSyncAtomic(target, 'NEW');

    const tmpUsed = String(copySpy.mock.calls[0][0]);
    expect(tmpUsed).toMatch(new RegExp(`state\\.json\\.tmp-${process.pid}-\\d+$`));
    copySpy.mockRestore();
  });
});

describe('writeFileAtomic (async) - Windows rename-over-open-file fallback', () => {
  it('lands the write via copy+unlink when rename throws EPERM', async () => {
    const target = path.join(tmpDir, 'state.json');
    await fs.writeFile(target, 'OLD');
    ctl.renameFail = 'EPERM';

    await writeFileAtomic(target, 'NEW');

    expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
    expect(tmpLeftovers(tmpDir)).toEqual([]);
  });

  it('rethrows an unrelated error after cleaning up the tmp', async () => {
    const target = path.join(tmpDir, 'state.json');
    await fs.writeFile(target, 'OLD');
    ctl.renameFail = 'ENOSPC';

    await expect(writeFileAtomic(target, 'NEW')).rejects.toThrow(/ENOSPC/);
    expect(await fs.readFile(target, 'utf-8')).toBe('OLD');
    expect(tmpLeftovers(tmpDir)).toEqual([]);
  });
});

describe('moveFileAtomic - Windows quarantine fallback', () => {
  it('moves via copy+unlink when rename throws EPERM', async () => {
    const src = path.join(tmpDir, 'dropped.bin');
    const dest = path.join(tmpDir, 'quarantine', 'dropped.bin');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(src, 'payload');
    ctl.renameFail = 'EPERM';

    await moveFileAtomic(src, dest);

    expect(await fs.readFile(dest, 'utf-8')).toBe('payload');
    // The source is gone: a move that leaves it behind moved nothing.
    await expect(fs.access(src)).rejects.toThrow();
  });

  it('reports failure when the source cannot be removed after the copy', async () => {
    // A quarantine that claims success while the file still sits in the drop
    // directory is a lie the caller would act on; the error must propagate.
    const src = path.join(tmpDir, 'dropped.bin');
    const dest = path.join(tmpDir, 'q', 'dropped.bin');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(src, 'payload');
    ctl.renameFail = 'EPERM';
    ctl.unlinkFail = 'EPERM';

    await expect(moveFileAtomic(src, dest)).rejects.toThrow(/EPERM/);
  });
});
