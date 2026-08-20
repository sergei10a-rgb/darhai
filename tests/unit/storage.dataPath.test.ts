/**
 * Regression tests for the three storage actions that build paths under
 * `userData` DIRECTLY, while the app's real data lives one level deeper -
 * in `getDataPath()` (`src/process/utils/utils.ts`), which appends `wayland`.
 *
 * Measured on-disk layout (Windows, `%APPDATA%/Darhai`):
 *   <userData>/wayland/wayland.db        <- the database (conversations live here)
 *   <userData>/wayland/wayland.db-wal    <- WAL sidecar (schema.ts: journal_mode = WAL)
 *   <userData>/wayland/wayland.db-shm    <- shared-memory sidecar
 *   <userData>/wayland/<scratch dirs>    <- wcore-temp-*, snapshots, extension state
 *   <userData>/config/                   <- getConfigPath()
 *   <userData>/conversations             <- DOES NOT EXIST
 *   <userData>/attachments               <- DOES NOT EXIST
 *
 * Each test below fails against the pre-fix implementation.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';

// The real driver (better-sqlite3) is compiled against the Electron ABI and
// cannot be dlopen'd by the Node-based Vitest runner. Swap in a driver backed
// by Node's built-in SQLite so the export path still runs REAL SQLite - the
// `VACUUM INTO` snapshot is genuinely executed, not stubbed away.
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
import { computeUsage, invalidateUsageCache } from '../../src/process/storage/computeUsage';
import { resetAll } from '../../src/process/storage/resetAll';

const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-storage-'));
}

function writeFixture(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Create a real WAL-mode SQLite database at `<userData>/wayland/wayland.db`. */
function seedRealDatabase(userData: string, rowValue: string): string {
  const dbPath = path.join(userData, DATA_DIR, DB_FILE);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE conversations(id TEXT)');
  db.prepare('INSERT INTO conversations VALUES (?)').run(rowValue);
  db.close();
  return dbPath;
}

// -------------------------------------------------------------------
// 1. resetAll - the wipe must actually remove the database
// -------------------------------------------------------------------

describe('resetAll targets the real data directory', () => {
  let userData: string;
  let logsDir: string;

  beforeEach(() => {
    userData = mkTmpDir();
    logsDir = mkTmpDir();
  });

  afterEach(() => {
    for (const d of [userData, logsDir]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('deletes the database and its WAL sidecars', async () => {
    const dbPath = path.join(userData, DATA_DIR, DB_FILE);
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'sqlite-bytes');
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-wal`), 'wal-bytes');
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-shm`), 'shm-bytes');

    await resetAll(userData, logsDir);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('wipes the rest of the data directory, not just the database file', async () => {
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'sqlite-bytes');
    writeFixture(userData, path.join(DATA_DIR, 'extension-states.json'), '{}');
    writeFixture(userData, path.join(DATA_DIR, 'wcore-temp-1', 'scratch.txt'), 'x');

    await resetAll(userData, logsDir);

    expect(fs.existsSync(path.join(userData, DATA_DIR, 'extension-states.json'))).toBe(false);
    expect(fs.existsSync(path.join(userData, DATA_DIR, 'wcore-temp-1'))).toBe(false);
  });

  it('still wipes the config directory', async () => {
    writeFixture(userData, path.join('config', 'wayland-config.txt'), 'cfg');
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'sqlite-bytes');

    await resetAll(userData, logsDir);

    expect(fs.existsSync(path.join(userData, 'config'))).toBe(false);
  });
});

// -------------------------------------------------------------------
// 2. backupExport - the archive must contain the database
// -------------------------------------------------------------------

describe('backupExport includes the database', () => {
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

  it('writes a zip entry for the database file', async () => {
    seedRealDatabase(userData, 'conv-1');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const entries = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

    // Assert on the archive's own entry list, not on the destination filename.
    expect(entries).toContain(`${DATA_DIR}/${DB_FILE}`);
  });

  it('the exported database entry is a readable SQLite file holding the rows', async () => {
    seedRealDatabase(userData, 'conv-42');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const entry = zip.files[`${DATA_DIR}/${DB_FILE}`];
    expect(entry).toBeDefined();

    const extracted = path.join(dest, 'restored.db');
    fs.writeFileSync(extracted, await entry.async('nodebuffer'));

    const db = new DatabaseSync(extracted);
    const row = db.prepare('SELECT id FROM conversations').get() as { id: string };
    db.close();
    expect(row.id).toBe('conv-42');
  });

  it('does not copy the volatile -wal / -shm sidecars into the archive', async () => {
    seedRealDatabase(userData, 'conv-1');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const entries = Object.keys(zip.files);
    expect(entries.some((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toBe(false);
  });

  it('records in the manifest whether the database was included', async () => {
    seedRealDatabase(userData, 'conv-1');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const manifest = JSON.parse(await zip.files['manifest.json'].async('string')) as {
      includesDatabase?: boolean;
    };
    expect(manifest.includesDatabase).toBe(true);
  });

  it('exports successfully when there is no database yet', async () => {
    writeFixture(userData, path.join('config', 'settings.json'), '{}');

    await backupExport({ userData, destPath: zipPath, includeKeys: false });

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const manifest = JSON.parse(await zip.files['manifest.json'].async('string')) as {
      includesDatabase?: boolean;
    };
    expect(manifest.includesDatabase).toBe(false);
    expect(Object.keys(zip.files)).toContain('config/settings.json');
  });
});

// -------------------------------------------------------------------
// 3. computeUsage - the totals must reflect real bytes on disk
// -------------------------------------------------------------------

describe('computeUsage measures the real data directory', () => {
  let userData: string;
  let logsDir: string;

  beforeEach(() => {
    userData = mkTmpDir();
    logsDir = mkTmpDir();
    invalidateUsageCache();
  });

  afterEach(() => {
    for (const d of [userData, logsDir]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    invalidateUsageCache();
  });

  it('counts the database plus its sidecars as conversation bytes', async () => {
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'a'.repeat(100));
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-wal`), 'b'.repeat(20));
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-shm`), 'c'.repeat(5));

    const result = await computeUsage(userData, logsDir);
    const conversations = result.breakdown.find((b) => b.label === 'conversations');

    expect(conversations?.bytes).toBe(125);
  });

  it('counts the non-database remainder of the data directory as cache bytes', async () => {
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'a'.repeat(100));
    writeFixture(userData, path.join(DATA_DIR, 'wcore-temp-1', 'scratch.bin'), 'x'.repeat(7));
    writeFixture(userData, path.join(DATA_DIR, 'extension-states.json'), 'y'.repeat(3));

    const result = await computeUsage(userData, logsDir);
    const cache = result.breakdown.find((b) => b.label === 'cache');

    expect(cache?.bytes).toBe(10);
  });

  it('sums a fully seeded layout to the exact expected total', async () => {
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'a'.repeat(100));
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-wal`), 'b'.repeat(20));
    writeFixture(userData, path.join(DATA_DIR, `${DB_FILE}-shm`), 'c'.repeat(5));
    writeFixture(userData, path.join(DATA_DIR, 'wcore-temp-1', 'scratch.bin'), 'x'.repeat(7));
    writeFixture(logsDir, 'main.log', 'z'.repeat(10));

    const result = await computeUsage(userData, logsDir);

    expect(result.used).toBe(142);
  });

  it('keeps the three i18n-backed breakdown labels', async () => {
    writeFixture(userData, path.join(DATA_DIR, DB_FILE), 'a');

    const result = await computeUsage(userData, logsDir);

    expect(result.breakdown.map((b) => b.label)).toEqual(['conversations', 'cache', 'logs']);
  });
});
