import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { logger } from '@office-ai/platform';
import { createDriver } from '@process/services/database/drivers/createDriver';

export type ImportOptions = {
  userData: string;
  srcPath: string;
  passphrase?: string;
};

/**
 * The app's real data directory is `getDataPath()` (src/process/utils/utils.ts),
 * which appends `wayland` to the Electron `userData` path. The SQLite database
 * that holds every conversation and message lives there. See the note in
 * `resetAll.ts` for why this is a local constant rather than a `getDataPath()`
 * call.
 */
const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

/** The one archive entry that carries the database. Written by `backupExport`. */
const DB_ZIP_ENTRY = `${DATA_DIR}/${DB_FILE}`;

/** `schema.ts` sets `journal_mode = WAL`, so the database always has sidecars. */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'];

/**
 * The previous database is renamed to `<db>.pre-restore` (and its sidecars
 * follow as `<db>.pre-restore-wal` / `-shm`, which is exactly the sidecar
 * naming SQLite expects, so the set stays a coherent, openable database).
 *
 * It is kept AFTER a successful restore, not deleted: restoring a backup is
 * destructive, and one mis-click in the settings screen would otherwise be
 * unrecoverable. The cost is one extra copy of the database on disk, which is
 * overwritten by the next restore and removed by "delete all data"
 * (`resetAll` wipes the whole data directory).
 */
const PRE_RESTORE_SUFFIX = '.pre-restore';

/** Every SQLite file starts with this 16-byte magic, NUL included. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');

/**
 * Decompression caps to defend against zip-bombs. A backup archive holding
 * conversations + attachments is large but bounded; these limits reject a
 * single entry or a total payload that is implausible for a real backup.
 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024; // 256 MiB per entry
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB total

/** AES-256-GCM decrypt a base64-encoded payload produced by backupExport. */
function decryptBuffer(encoded: string, passphrase: string): Buffer {
  const buf = Buffer.from(encoded, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ciphertext = buf.subarray(44);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Resolve a zip entry destination inside `baseDir`, rejecting any path that
 * escapes it (zip-slip). Normalizes BOTH separators before inspection so
 * mixed-separator entries (e.g. `config/..\..\evil.bat`) cannot bypass the
 * check on either POSIX or Windows.
 *
 * @returns the absolute, contained destination path, or `null` if the entry
 *          traverses outside `baseDir` and must be skipped.
 */
function resolveContained(baseDir: string, entryName: string): string | null {
  // Normalize backslashes to forward slashes so a single `..` check covers
  // both separator styles, then reject any `..` path segment outright.
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) {
    return null;
  }
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, normalized);
  // Containment: the resolved path must equal the root or sit beneath it.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

/** Write a file, creating parent directories as needed. */
function writeFile(filePath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

/**
 * Release the SQLite handle before replacing its file.
 *
 * The app is RUNNING while a restore happens, and it holds the database open.
 * `resetAll` hit this first and MEASURED it on Windows: an open handle makes
 * `fs.rmSync`/rename on the database file fail with EPERM, and on any platform
 * swapping the file underneath a live connection is how a database gets
 * corrupted. This follows that precedent exactly.
 *
 * Imported lazily so this module stays loadable outside an Electron main
 * process (the database module pulls in the platform/Electron graph).
 */
async function closeDatabaseHandle(): Promise<void> {
  try {
    const { closeDatabase } = await import('@process/services/database/export');
    closeDatabase();
  } catch (err) {
    logger.warn('[backupImport] Could not close the database before restoring', err);
  }
}

/**
 * Prove a file is a database this app can actually open, BEFORE it is allowed
 * anywhere near the user's real one.
 *
 * Two checks, because either alone is insufficient:
 *  - the 16-byte magic rejects a file that is not SQLite at all (an HTML error
 *    page saved as .zip content, a text file, a wrong entry);
 *  - a real open plus `PRAGMA integrity_check` rejects a file that HAS the
 *    magic but is truncated or corrupt - a half-uploaded backup keeps a valid
 *    header, so a header-only check would wave it straight through.
 *
 * Throws on anything it cannot vouch for. Losing the current data to a bad
 * backup is strictly worse than a failed import.
 */
async function assertUsableDatabase(dbPath: string): Promise<void> {
  const size = fs.statSync(dbPath).size;
  if (size < SQLITE_MAGIC.length) {
    throw new Error(`[backupImport] Refusing to restore: database payload is only ${size} bytes`);
  }

  const header = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = fs.openSync(dbPath, 'r');
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.equals(SQLITE_MAGIC)) {
    throw new Error('[backupImport] Refusing to restore: the archive’s database entry is not a SQLite file');
  }

  const driver = await createDriver(dbPath);
  try {
    // `sqlite_master` forces page 1 to parse; `integrity_check` walks the rest.
    driver.prepare('SELECT count(*) FROM sqlite_master').get();
    const row = driver.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    const verdict = row?.integrity_check;
    if (verdict !== 'ok') {
      throw new Error(`[backupImport] Refusing to restore: integrity_check reported "${verdict ?? 'nothing'}"`);
    }
  } finally {
    // Closing matters on Windows: the file is about to be renamed/copied over.
    driver.close();
  }
}

/**
 * Swap `stagedPath` in as the app's database, all-or-nothing.
 *
 * Sequence, and why each step is where it is:
 *  1. close the live handle (see `closeDatabaseHandle`);
 *  2. move the current database AND its `-wal`/`-shm` sidecars aside together.
 *     MEASURED on Windows with a live SQLite handle open on the file:
 *     `fs.renameSync` fails EBUSY, while `fs.writeFileSync` over the same file
 *     SUCCEEDS. So the obvious implementation - write the restored bytes
 *     straight over `wayland.db` - silently corrupts a database the app still
 *     has open, and moving the file aside first is what turns that into a
 *     refusal. It matters for a second reason too:
 *     a WAL sidecar belongs to exactly one database file, so leaving the old
 *     pair next to a restored database lets SQLite replay pages from the
 *     PREVIOUS database over the new one (resurrecting deleted data) or refuse
 *     to open it at all. Moving them as a set also keeps the rollback copy
 *     complete: commits that live only in the WAL would be lost if the sidecar
 *     were simply deleted;
 *  3. copy the staged file into place (copy, not rename - the staging directory
 *     is in the OS temp dir, which is frequently a different volume, and
 *     `fs.renameSync` fails EXDEV across volumes);
 *  4. open the installed file once more. Only after it opens cleanly is the
 *     restore considered done.
 *
 * Any failure in 3-4 puts the original database and its sidecars back and
 * rethrows, so the user still has exactly what they had before.
 */
async function installDatabase(root: string, stagedPath: string): Promise<void> {
  await closeDatabaseHandle();

  const dbPath = path.join(root, DATA_DIR, DB_FILE);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const asideOf = (suffix: string) => `${dbPath}${PRE_RESTORE_SUFFIX}${suffix}`;
  const moved: { from: string; to: string }[] = [];

  // '' is the database file itself; the suffixes are its sidecars.
  for (const suffix of ['', ...DB_SIDECAR_SUFFIXES]) {
    const from = `${dbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    const to = asideOf(suffix);
    fs.rmSync(to, { force: true });
    fs.renameSync(from, to);
    moved.push({ from, to });
  }

  try {
    fs.copyFileSync(stagedPath, dbPath);
    await assertUsableDatabase(dbPath);
  } catch (err) {
    // Roll back: drop whatever we managed to write, put the original back.
    fs.rmSync(dbPath, { force: true });
    for (const { from, to } of moved) {
      try {
        fs.renameSync(to, from);
      } catch (rollbackErr) {
        logger.error(`[backupImport] Could not restore ${from} after a failed import`, rollbackErr);
      }
    }
    throw err;
  }

  logger.info(`[backupImport] Database restored; previous copy kept at ${asideOf('')}`);
}

export async function backupImport(opts: ImportOptions): Promise<void> {
  const raw = fs.readFileSync(opts.srcPath);
  const zip = await JSZip.loadAsync(raw);

  const restoreDirs = new Set(['conversations', 'attachments', 'config']);
  const root = path.resolve(opts.userData);

  // Running total of decompressed bytes to bound zip-bomb amplification.
  let totalBytes = 0;
  const accountBytes = (len: number): boolean => {
    if (len > MAX_ENTRY_BYTES) return false;
    totalBytes += len;
    return totalBytes <= MAX_TOTAL_BYTES;
  };

  // The database is NOT restored through the loop below. It is not a plain
  // file: it must be validated before it is allowed to replace the live one,
  // the live handle must be closed first, and the swap has to be reversible.
  // The `restoreDirs` allowlist deliberately still excludes `wayland`, so this
  // exact entry is the ONLY thing the archive can write into the data
  // directory - a hand-made zip cannot smuggle in extra files there.
  const dbEntry = Object.entries(zip.files).find(
    ([name, file]) => !file.dir && name.replace(/\\/g, '/') === DB_ZIP_ENTRY
  )?.[1];

  const stagingDir = dbEntry ? fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-restore-')) : null;

  try {
    let stagedDb: string | null = null;

    if (dbEntry && stagingDir) {
      const data = await dbEntry.async('nodebuffer');
      if (!accountBytes(data.length)) {
        // Loud, not silent: skipping the database here is the exact failure
        // this whole path exists to remove.
        throw new Error(
          `[backupImport] Refusing to restore: database entry is ${data.length} bytes, over the ${MAX_ENTRY_BYTES}-byte cap`
        );
      }
      stagedDb = path.join(stagingDir, DB_FILE);
      fs.writeFileSync(stagedDb, data);
      // Validate BEFORE anything is written to the user's data directory, so a
      // broken archive is rejected while their install is still untouched.
      await assertUsableDatabase(stagedDb);
    }

    await Promise.all(
      Object.entries(zip.files).map(async ([zipPath, file]) => {
        if (file.dir) return;

        // Handle encrypted keys. Containment still applies even though the
        // destination is fixed - the same hardening must guard every write.
        if (zipPath === 'keys.json.enc') {
          if (!opts.passphrase) return;
          const encoded = await file.async('string');
          const decrypted = decryptBuffer(encoded, opts.passphrase);
          if (!accountBytes(decrypted.length)) return;
          const keysDest = resolveContained(root, 'keys.json');
          if (keysDest === null) return;
          writeFile(keysDest, decrypted);
          return;
        }

        // Skip manifest
        if (zipPath === 'manifest.json') return;

        // Normalize separators BEFORE the top-dir gate so a mixed-separator
        // entry cannot slip a foreign top directory past the allowlist.
        const normalized = zipPath.replace(/\\/g, '/');
        const topDir = normalized.split('/')[0];
        if (!restoreDirs.has(topDir)) return;

        // Restore files under known dirs, enforcing path containment.
        const destFull = resolveContained(root, zipPath);
        if (destFull === null) return;

        const data = await file.async('nodebuffer');
        if (!accountBytes(data.length)) return;
        writeFile(destFull, data);
      })
    );

    if (stagedDb) {
      await installDatabase(root, stagedDb);
    }
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
