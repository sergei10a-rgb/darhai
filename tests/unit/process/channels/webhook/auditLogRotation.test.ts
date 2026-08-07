/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The audit log that grew without bound.
 *
 * The log is meant to self-rotate at a size cap so it can't fill a small disk.
 * Rotation renamed the file to `.1` - and the old code wrapped that rename in a
 * blanket `catch {}` that treated EVERY failure as "file missing". On Windows a
 * rename fails EPERM whenever any process holds the log open, even just for
 * reading, so rotation silently never happened and the cap silently stopped
 * existing. This is the same accumulation class that piled up 100 MB of files
 * elsewhere.
 *
 * The fix keeps ENOENT as the genuine no-op and falls back to copy+truncate for
 * a lock - the same thing logrotate's `copytruncate` does when it can't move a
 * held-open file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ctl } = vi.hoisted(() => ({ ctl: { renameFail: null as string | null } }));

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof orig.renameSync = (from, to) => {
    if (ctl.renameFail) {
      const code = ctl.renameFail;
      ctl.renameFail = null;
      throw errno(code);
    }
    return orig.renameSync(from, to);
  };
  return { ...orig, renameSync };
});

// eslint-disable-next-line import/first
import * as fsSync from 'node:fs';
// eslint-disable-next-line import/first
import path from 'node:path';
// eslint-disable-next-line import/first
import os from 'node:os';
// eslint-disable-next-line import/first
import { rotateIfNeeded } from '@process/channels/webhook/audit-log';

let dir: string;
let logPath: string;

beforeEach(() => {
  ctl.renameFail = null;
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'audit-rot-'));
  logPath = path.join(dir, 'webhook-audit.log');
});

afterEach(() => {
  fsSync.rmSync(dir, { recursive: true, force: true });
});

describe('rotateIfNeeded', () => {
  it('does nothing while the log is under the cap', () => {
    fsSync.writeFileSync(logPath, 'small');
    rotateIfNeeded(logPath, 1024);
    expect(fsSync.existsSync(`${logPath}.1`)).toBe(false);
    expect(fsSync.readFileSync(logPath, 'utf-8')).toBe('small');
  });

  it('does nothing when the log does not exist yet', () => {
    // The genuine "nothing to rotate" case - must stay a silent no-op.
    expect(() => rotateIfNeeded(logPath, 1)).not.toThrow();
    expect(fsSync.existsSync(`${logPath}.1`)).toBe(false);
  });

  it('renames the over-cap log to .1 on the normal path', () => {
    fsSync.writeFileSync(logPath, 'A'.repeat(100));
    rotateIfNeeded(logPath, 10);
    expect(fsSync.readFileSync(`${logPath}.1`, 'utf-8')).toBe('A'.repeat(100));
    expect(fsSync.existsSync(logPath)).toBe(false);
  });

  it('falls back to copy+truncate when the rename is blocked (Windows lock)', () => {
    // THE bug: on the old code this EPERM was swallowed as "missing" and the
    // log kept growing. Now the content is preserved in .1 and the active log
    // is reset, so the cap stays real even while a reader holds the file.
    fsSync.writeFileSync(logPath, 'B'.repeat(100));
    ctl.renameFail = 'EPERM';

    rotateIfNeeded(logPath, 10);

    expect(fsSync.readFileSync(`${logPath}.1`, 'utf-8')).toBe('B'.repeat(100));
    expect(fsSync.readFileSync(logPath, 'utf-8')).toBe(''); // truncated, not left to grow
    expect(fsSync.statSync(logPath).size).toBe(0);
  });

  it('never throws even if the fallback copy also fails', () => {
    // If the file is so locked that even the copy fails, rotation gives up
    // rather than break the append that follows it - the record matters more.
    fsSync.writeFileSync(logPath, 'C'.repeat(100));
    ctl.renameFail = 'EPERM';
    const copySpy = vi.spyOn(fsSync, 'copyFileSync').mockImplementationOnce(() => {
      throw errno('EPERM');
    });

    expect(() => rotateIfNeeded(logPath, 10)).not.toThrow();
    copySpy.mockRestore();
  });
});
