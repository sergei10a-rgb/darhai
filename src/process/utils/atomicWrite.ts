/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Atomic file-write helpers for state files.
 *
 * Plain writeFile/writeFileSync truncates the destination then streams bytes.
 * If the process crashes mid-write the file is left empty or partial and the
 * next launch fails JSON.parse - losing analytics IDs, CDP registry state,
 * Wayland config, or user workspace paths.
 *
 * The helpers below write to a sibling `.tmp-<pid>-<ts>` file first, then
 * rename into place. POSIX rename is atomic on the same filesystem, so a crash
 * leaves either the old file intact or the new file fully written - never a
 * truncated half.
 *
 * Scope: state files only. User-content writes (where partial output is
 * recoverable by the user) intentionally do not use these helpers.
 *
 * --- Windows rename-over-open-file (measured win32 10.0.26200 / Node 24) ------
 * POSIX rename(2) replaces the target even while another process holds it open.
 * Windows MoveFileEx does NOT: if any process has the target open - and merely
 * open for READING is enough (a settings viewer, a backup daemon, the app's own
 * other window) - the rename fails with EPERM/EBUSY/EACCES. The write is then
 * lost and, without this fallback, the tmp is orphaned. This is a
 * Windows-user-only, developer-invisible failure, and it is the exact class of
 * bug that silently accumulated 100 MB of orphaned temp files elsewhere.
 *
 * On those three codes we fall back to copyFileSync(tmp -> target) + unlink,
 * which succeeds where the rename could not (copy opens the target with a
 * generous share mode). That single copy is not itself atomic, but the choice
 * is "non-atomic write that lands" vs "atomic write that is lost", and landing
 * the user's data wins. POSIX never hits this path, so its atomicity is
 * unchanged.
 *
 * --- RT-S1: cross-platform confidentiality of the temp file ----------------
 * The sibling temp file is created inside the SAME directory as `targetPath`.
 * For secret-bearing writes (callers pass `{ mode: 0o600 }` - config/env/chat
 * blobs, analytics id, models cache) that directory is userData/config, which
 * on Windows is already ACL-restricted to the current user, so the temp file
 * inherits an owner-only ACL by default.
 *
 * Node IGNORES the `mode` option on Windows, so 0o600 alone is a no-op there.
 * As defense-in-depth (in case the parent dir's ACL was widened, or the file
 * is created somewhere with a permissive inherited ACL), when the caller asked
 * for owner-only POSIX perms we ALSO restrict the Windows DACL explicitly:
 * strip inherited ACEs and grant the current user full control, applied to the
 * temp file before secrets are flushed AND to the final file after rename.
 * This is best-effort (icacls failures are swallowed) - the inherited
 * owner-only ACL of userData/config remains the baseline guarantee. POSIX
 * behavior is unchanged.
 */

import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { execFileSync, spawn } from 'child_process';

/**
 * Rename-failure codes for which a copy+unlink fallback is worth trying.
 * EXDEV is the cross-filesystem case (rename can't span mounts); EPERM/EBUSY/
 * EACCES are the Windows rename-over-open-file case. On any of these the copy
 * lands the data where the rename could not.
 */
const RENAME_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EBUSY', 'EACCES']);

function isRenameFallbackError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && RENAME_FALLBACK_CODES.has(code);
}

/**
 * True when the caller requested owner-only POSIX permissions, i.e. the data
 * is secret-bearing and must not be world-readable during the write window.
 */
function wantsOwnerOnly(opts?: fsSync.WriteFileOptions): boolean {
  if (opts == null || typeof opts === 'string') return false;
  return opts.mode === 0o600;
}

/**
 * On Windows, set an owner-only DACL on `filePath`: remove inherited ACEs and
 * grant the current user full control. Mirrors the intent of POSIX 0o600 on a
 * platform where Node ignores the `mode` option. Best-effort: any failure is
 * swallowed because the file already lives in an ACL-restricted directory.
 *
 * `*S-1-3-4` is the well-known OWNER RIGHTS SID, so the grant always resolves
 * to whoever created the file regardless of username/domain quirks.
 */
function restrictWindowsDacl(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    // /inheritance:r  → drop ACEs inherited from the parent directory
    // /grant:r <SID>:F → replace grants with: current owner = full control
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', '*S-1-3-4:F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // Best-effort. The temp/final file already inherits the userData/config
    // dir's owner-only ACL; an icacls failure leaves that baseline intact.
  }
}

/** Async variant of {@link restrictWindowsDacl}; never rejects. */
function restrictWindowsDaclAsync(filePath: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const child = spawn('icacls', [filePath, '/inheritance:r', '/grant:r', '*S-1-3-4:F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

export async function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
  opts?: fsSync.WriteFileOptions
): Promise<void> {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const ownerOnly = wantsOwnerOnly(opts);
  await fs.writeFile(tmp, data, opts);
  // Harden the temp file's DACL on Windows immediately after creation so the
  // secret bytes are not world-readable during the rename window.
  if (ownerOnly) await restrictWindowsDaclAsync(tmp);
  try {
    await fs.rename(tmp, targetPath);
  } catch (err) {
    if (isRenameFallbackError(err)) {
      // Windows rename-over-open-file (or cross-device): copy the bytes into
      // place instead, then drop the tmp. Landing the write beats losing it.
      try {
        await fs.copyFile(tmp, targetPath);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    } else {
      // Anything else (ENOSPC, ...) is not recoverable by copying: clean up the
      // tmp and surface the original error. Swallow unlink failures so the real
      // error propagates.
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }
  // Re-apply after rename: the destination may pre-exist with a wider ACL, and
  // rename does not reset it on Windows.
  if (ownerOnly) await restrictWindowsDaclAsync(targetPath);
}

export function writeFileSyncAtomic(targetPath: string, data: string | Buffer, opts?: fsSync.WriteFileOptions): void {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const ownerOnly = wantsOwnerOnly(opts);
  fsSync.writeFileSync(tmp, data, opts);
  if (ownerOnly) restrictWindowsDacl(tmp);
  try {
    fsSync.renameSync(tmp, targetPath);
  } catch (err) {
    if (isRenameFallbackError(err)) {
      // Windows rename-over-open-file (or cross-device): copy into place, then
      // drop the tmp. Landing the write beats losing it.
      try {
        fsSync.copyFileSync(tmp, targetPath);
      } finally {
        try {
          fsSync.unlinkSync(tmp);
        } catch {
          // best-effort
        }
      }
    } else {
      // Non-recoverable (ENOSPC, ...): clean up and surface the original error.
      try {
        fsSync.unlinkSync(tmp);
      } catch {
        // Ignore - surface the original rename error below.
      }
      throw err;
    }
  }
  if (ownerOnly) restrictWindowsDacl(targetPath);
}

/**
 * Move a file into place, tolerating the same Windows rename-over-open-file
 * failure as {@link writeFileAtomic}. Unlike the write helpers, `src` is an
 * existing file the caller already produced (e.g. quarantining a dropped file),
 * so there is no tmp of our own to manage.
 *
 * On a fallback code the source is copied to `dest` and then unlinked. If the
 * unlink itself fails (Windows cannot delete a file another process holds
 * open), the error PROPAGATES even though the copy landed: a move that leaves
 * the source behind has not moved anything, and reporting success would let a
 * caller like the drop-quarantine claim a file was quarantined while it still
 * sits in the drop directory. The stray copy at `dest` is harmless; the honest
 * error is not.
 */
export async function moveFileAtomic(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if (isRenameFallbackError(err)) {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
      return;
    }
    throw err;
  }
}
