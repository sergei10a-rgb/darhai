/**
 * Full backup ROUND TRIP: export -> wipe -> import -> read the data back.
 *
 * `backupExport` was fixed to put the SQLite database into the archive, but the
 * round trip stayed broken: `backupImport` filtered restored entries down to
 * {conversations, attachments, config}, so the `wayland/wayland.db` entry was
 * silently dropped. A user could export a backup, restore it, and get an empty
 * app back with no error anywhere.
 *
 * These tests deliberately do NOT assert on the zip's entry list - that is what
 * `storage.dataPath.test.ts` already pins for the export half. Here the only
 * thing that counts is whether a row written before the export is readable
 * after the import.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';

// The real driver (better-sqlite3) is compiled against the Electron ABI and
// cannot be dlopen'd by the Node-based Vitest runner. Swap in a driver backed
// by Node's built-in SQLite so both halves run REAL SQLite: the export's
// `VACUUM INTO` and the import's validating trial-open are genuinely executed.
vi.mock('@process/services/database/drivers/createDriver', () => {
  class NodeSqliteDriver {
    private db: DatabaseSync;

    constructor(dbPath: string) {
      this.db = new DatabaseSync(dbPath);
    }

    prepare(sql: string) {
      const stmt = this.db.prepare(sql);
      return {
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[])) as unknown[],
        run: (...args: unknown[]) => stmt.run(...(args as never[])) as never,
      };
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    pragma(): unknown {
      return undefined;
    }

    transaction<T>(fn: (...args: unknown[]) => T) {
      return fn;
    }

    close(): void {
      this.db.close();
    }
  }

  return { createDriver: async (dbPath: string) => new NodeSqliteDriver(dbPath) };
});

import { backupExport } from '../../src/process/storage/backupExport';
import { backupImport } from '../../src/process/storage/backupImport';

const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';
const DB_ENTRY = `${DATA_DIR}/${DB_FILE}`;

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-roundtrip-'));
}

function dbPathOf(userData: string): string {
  return path.join(userData, DATA_DIR, DB_FILE);
}

/** Create a real WAL-mode SQLite database at `<userData>/wayland/wayland.db`. */
function seedRealDatabase(userData: string, rowValue: string): string {
  const dbPath = dbPathOf(userData);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE conversations(id TEXT)');
  db.prepare('INSERT INTO conversations VALUES (?)').run(rowValue);
  db.close();
  return dbPath;
}

/** Read every `conversations.id` out of the database on disk. */
function readConversationIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT id FROM conversations ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Delete everything under `userData` - the "user reinstalled / new machine" case. */
function wipe(userData: string): void {
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
}

describe('backup round trip restores the conversations database', () => {
  let userData: string;
  let dest: string;
  let zipPath: string;

  beforeEach(() => {
    userData = mkTmpDir();
    dest = mkTmpDir();
    zipPath = path.join(dest, 'backup.zip');
  });

  afterEach(() => {
    for (const d of [userData, dest]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('a row written before the export is readable after the import', async () => {
    seedRealDatabase(userData, 'conv-round-trip-77');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });
    wipe(userData);
    await backupImport({ userData, srcPath: zipPath });

    expect(fs.existsSync(dbPathOf(userData))).toBe(true);
    expect(readConversationIds(dbPathOf(userData))).toEqual(['conv-round-trip-77']);
  });

  it('still restores the file-based entries alongside the database', async () => {
    seedRealDatabase(userData, 'conv-1');
    const cfg = path.join(userData, 'config', 'settings.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{"theme":"dark"}', 'utf-8');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });
    wipe(userData);
    await backupImport({ userData, srcPath: zipPath });

    expect(fs.readFileSync(cfg, 'utf-8')).toBe('{"theme":"dark"}');
    expect(readConversationIds(dbPathOf(userData))).toEqual(['conv-1']);
  });

  it('imports a backup that has no database without failing', async () => {
    const cfg = path.join(userData, 'config', 'settings.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{}', 'utf-8');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });
    wipe(userData);
    await backupImport({ userData, srcPath: zipPath });

    expect(fs.existsSync(cfg)).toBe(true);
    expect(fs.existsSync(dbPathOf(userData))).toBe(false);
  });

  it('replaces an existing database instead of leaving the old rows in place', async () => {
    seedRealDatabase(userData, 'from-backup');
    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    // Simulate "restore onto a machine that already has data".
    fs.rmSync(path.join(userData, DATA_DIR), { recursive: true, force: true });
    seedRealDatabase(userData, 'currently-on-disk');

    await backupImport({ userData, srcPath: zipPath });

    expect(readConversationIds(dbPathOf(userData))).toEqual(['from-backup']);
  });
});

describe('restore removes the stale WAL sidecars of the replaced database', () => {
  let userData: string;
  let dest: string;
  let zipPath: string;

  beforeEach(() => {
    userData = mkTmpDir();
    dest = mkTmpDir();
    zipPath = path.join(dest, 'backup.zip');
  });

  afterEach(() => {
    for (const d of [userData, dest]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * Leave a GENUINE, checksum-valid WAL from the previous database next to a
   * restored one and SQLite replays it - silently.
   *
   * MEASURED with node:sqlite before writing this test: copy a backup database
   * over `a.db`, put the old database's `-wal` back beside it, reopen, and
   * `SELECT` returns the OLD rows while `PRAGMA integrity_check` still answers
   * "ok". The restore appears to succeed and the user gets their previous data
   * back instead of the backup's. A junk sidecar would NOT show this: SQLite
   * discards a sidecar whose header fails its checksum, so the test has to use
   * a real one to have any counter-force at all.
   */
  it('does not let the replaced database’s WAL replay over the restored one', async () => {
    seedRealDatabase(userData, 'from-backup');
    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    // Rebuild the "currently installed" database and reattach its real WAL.
    fs.rmSync(path.join(userData, DATA_DIR), { recursive: true, force: true });
    const live = dbPathOf(userData);
    fs.mkdirSync(path.dirname(live), { recursive: true });
    const db = new DatabaseSync(live);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE conversations(id TEXT)');
    db.prepare('INSERT INTO conversations VALUES (?)').run('ghost-from-old-db');
    // Capture the sidecars while the connection still holds them, then put them
    // back after close (closing checkpoints and removes them).
    const wal = fs.readFileSync(`${live}-wal`);
    const shm = fs.existsSync(`${live}-shm`) ? fs.readFileSync(`${live}-shm`) : null;
    db.close();
    fs.writeFileSync(`${live}-wal`, wal);
    if (shm) fs.writeFileSync(`${live}-shm`, shm);

    await backupImport({ userData, srcPath: zipPath });

    expect(readConversationIds(live)).toEqual(['from-backup']);
    expect(fs.existsSync(`${live}-wal`)).toBe(false);
    expect(fs.existsSync(`${live}-shm`)).toBe(false);
  });

  /**
   * The sidecars are moved aside WITH the database rather than deleted, so the
   * kept-back copy still carries commits that live ONLY in the WAL.
   *
   * `only-in-the-wal` below is genuinely absent from the `.db` file: the file
   * is rewound to a snapshot taken before that commit, and only the WAL knows
   * about it. Deleting the sidecars instead of moving them would silently trim
   * the user's most recent conversations out of their one rollback copy.
   */
  it('keeps the replaced database, WAL included, as a recoverable copy', async () => {
    seedRealDatabase(userData, 'from-backup');
    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    fs.rmSync(path.join(userData, DATA_DIR), { recursive: true, force: true });
    const live = dbPathOf(userData);
    fs.mkdirSync(path.dirname(live), { recursive: true });

    // Checkpointed state: the .db file holds `checkpointed` and nothing else.
    const first = new DatabaseSync(live);
    first.exec('PRAGMA journal_mode = WAL');
    first.exec('CREATE TABLE conversations(id TEXT)');
    first.prepare('INSERT INTO conversations VALUES (?)').run('checkpointed');
    first.close();
    const snapshot = fs.readFileSync(live);

    // One more commit, captured from the WAL before it is checkpointed away.
    const second = new DatabaseSync(live);
    second.prepare('INSERT INTO conversations VALUES (?)').run('only-in-the-wal');
    const wal = fs.readFileSync(`${live}-wal`);
    second.close();

    // Rewind the .db to the snapshot and reattach the WAL: the second row now
    // exists in the sidecar alone, exactly as it does on a running install.
    fs.writeFileSync(live, snapshot);
    fs.writeFileSync(`${live}-wal`, wal);
    expect(readConversationIds(live)).toEqual(['checkpointed', 'only-in-the-wal']);
    fs.writeFileSync(live, snapshot);
    fs.writeFileSync(`${live}-wal`, wal);

    await backupImport({ userData, srcPath: zipPath });

    const kept = `${live}.pre-restore`;
    expect(fs.existsSync(kept)).toBe(true);
    // `<db>.pre-restore` + `-wal` is exactly the sidecar name SQLite expects,
    // so the kept copy opens as a coherent database on its own.
    expect(readConversationIds(kept)).toEqual(['checkpointed', 'only-in-the-wal']);
  });
});

describe('restore refuses to overwrite the database with a broken payload', () => {
  let userData: string;
  let dest: string;
  let zipPath: string;

  beforeEach(() => {
    userData = mkTmpDir();
    dest = mkTmpDir();
    zipPath = path.join(dest, 'backup.zip');
  });

  afterEach(() => {
    for (const d of [userData, dest]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  /** Build an archive whose database entry holds exactly `bytes`. */
  async function writeArchiveWithDbBytes(bytes: Buffer): Promise<void> {
    const zip = new JSZip();
    zip.file(DB_ENTRY, bytes);
    zip.file('config/settings.json', '{"restored":true}');
    zip.file('manifest.json', JSON.stringify({ version: 1, includesDatabase: true }));
    fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
  }

  it('rejects a non-SQLite payload and keeps the current database intact', async () => {
    seedRealDatabase(userData, 'keep-me');
    await writeArchiveWithDbBytes(Buffer.from('this is not a database at all', 'utf-8'));

    await expect(backupImport({ userData, srcPath: zipPath })).rejects.toThrow();

    expect(readConversationIds(dbPathOf(userData))).toEqual(['keep-me']);
  });

  it('rejects a truncated SQLite file and keeps the current database intact', async () => {
    // A real database, cut in half: the header still says "SQLite format 3",
    // so a header-only check would wave it through.
    const donor = mkTmpDir();
    try {
      const donorDb = path.join(donor, 'donor.db');
      const db = new DatabaseSync(donorDb);
      db.exec('CREATE TABLE conversations(id TEXT)');
      const insert = db.prepare('INSERT INTO conversations VALUES (?)');
      for (let i = 0; i < 500; i++) insert.run(`row-${i}`);
      db.close();
      const full = fs.readFileSync(donorDb);
      expect(full.length).toBeGreaterThan(8192);
      await writeArchiveWithDbBytes(full.subarray(0, 4096));
    } finally {
      fs.rmSync(donor, { recursive: true, force: true });
    }

    seedRealDatabase(userData, 'keep-me-too');

    await expect(backupImport({ userData, srcPath: zipPath })).rejects.toThrow();

    expect(readConversationIds(dbPathOf(userData))).toEqual(['keep-me-too']);
  });

  /**
   * The database payload is validated BEFORE the first byte is written to the
   * user's data directory, so a rejected archive leaves the whole install
   * exactly as it was - not just the database. Validating only at swap time
   * would already have overwritten `config/` by the time the archive turned
   * out to be unusable.
   */
  it('leaves the rest of the install untouched when the database is rejected', async () => {
    seedRealDatabase(userData, 'keep-me');
    const cfg = path.join(userData, 'config', 'settings.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{"current":true}', 'utf-8');

    await writeArchiveWithDbBytes(Buffer.from('not sqlite', 'utf-8'));

    await expect(backupImport({ userData, srcPath: zipPath })).rejects.toThrow();

    expect(fs.readFileSync(cfg, 'utf-8')).toBe('{"current":true}');
  });

  it('does not leave a half-written database behind when there was none before', async () => {
    await writeArchiveWithDbBytes(Buffer.from('not sqlite', 'utf-8'));

    await expect(backupImport({ userData, srcPath: zipPath })).rejects.toThrow();

    expect(fs.existsSync(dbPathOf(userData))).toBe(false);
  });
});
