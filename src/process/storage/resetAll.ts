import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@office-ai/platform';

/**
 * The app's real data directory is `getDataPath()` (src/process/utils/utils.ts),
 * which appends `wayland` to the Electron `userData` path. The SQLite database,
 * its WAL sidecars, extension state, snapshots and scratch workspaces all live
 * there - NOT directly under `userData`.
 *
 * Declared as a local constant rather than imported from `@process/utils`
 * because `getDataPath()` reads the Electron userData path itself and ignores
 * the `userData` argument this function is given; calling it here would make
 * the wipe both untestable and unable to target a caller-supplied root.
 */
const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

/** `schema.ts` sets `journal_mode = WAL`, so the database always has sidecars. */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'];

/**
 * Directories removed by a full reset, relative to `userData`.
 *
 * - `wayland`  - the real data directory (database + sidecars + scratch state)
 * - `config`   - `getConfigPath()`: assistants, skills, chat history, settings
 * - `cache`    - the app's on-disk cache
 * - `conversations` / `attachments` - not created by the current app, but a
 *   restore from an older backup writes them (see `backupImport`), so a full
 *   wipe must still clear them.
 */
const WIPE_DIRS = [DATA_DIR, 'conversations', 'attachments', 'cache', 'config'];

/** Log the contents that will be wiped before deleting, so the user can audit after re-launch. */
function logWipeManifest(userData: string, logsDir: string): void {
  const manifest: Record<string, string[]> = {};

  for (const dir of WIPE_DIRS) {
    const full = path.join(userData, dir);
    if (!fs.existsSync(full)) continue;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(p.replace(userData + path.sep, ''));
      }
    };
    walk(full);
    manifest[dir] = files;
  }

  const logPath = path.join(logsDir, 'pre-reset-manifest.json');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify({ wipedAt: new Date().toISOString(), files: manifest }, null, 2));
    logger.info(`[resetAll] Wipe manifest written to ${logPath}`);
  } catch (err) {
    logger.warn('[resetAll] Could not write wipe manifest', err);
  }
}

/**
 * Release the SQLite handle before deleting its file.
 *
 * MEASURED on Windows: `fs.rmSync` on a database file that still has an open
 * handle fails with EPERM, and a recursive delete of its parent directory fails
 * the same way - leaving the entire data directory intact. Without this the
 * reset reports success while keeping every conversation.
 *
 * Imported lazily so this module stays loadable outside an Electron main
 * process (the database module pulls in the platform/Electron graph).
 */
async function closeDatabaseHandle(): Promise<void> {
  try {
    const { closeDatabase } = await import('@process/services/database/export');
    closeDatabase();
  } catch (err) {
    logger.warn('[resetAll] Could not close the database before wiping', err);
  }
}

/** Remove a path recursively. Failures are logged, never thrown - one locked file must not abort the wipe. */
function rmPath(target: string): void {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`[resetAll] Could not remove ${target}`, err);
  }
}

/**
 * Full data wipe.
 *
 * Callers MUST enforce double-confirm in the renderer before invoking.
 * This function logs a manifest first, then deletes after a 3-second delay
 * so the renderer has time to display the countdown.
 */
export async function resetAll(userData: string, logsDir: string): Promise<void> {
  logWipeManifest(userData, logsDir);

  // 3-second safety delay
  await new Promise<void>((resolve) => setTimeout(resolve, 3000));

  await closeDatabaseHandle();

  const dataDir = path.join(userData, DATA_DIR);
  const dbPath = path.join(dataDir, DB_FILE);

  // Remove the database and its WAL sidecars explicitly first. Wiping the data
  // directory below covers them too, but doing it explicitly means a failure to
  // remove some unrelated scratch file cannot leave the database behind.
  rmPath(dbPath);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    rmPath(`${dbPath}${suffix}`);
  }

  for (const dir of WIPE_DIRS) {
    rmPath(path.join(userData, dir));
  }

  // The action promises "all data deleted" - verify rather than assume, and say
  // so loudly if the promise was not kept.
  if (fs.existsSync(dbPath)) {
    logger.error(`[resetAll] Data wipe INCOMPLETE - the database still exists at ${dbPath}`);
    return;
  }

  logger.info('[resetAll] Data wipe complete');
}
