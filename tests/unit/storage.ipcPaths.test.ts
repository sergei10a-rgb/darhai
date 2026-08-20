/**
 * The storage IPC layer's own paths.
 *
 * Two defects live here, both invisible from the outside:
 *
 * 1. `openDir('cache')` / `clearDir('cache')` resolved to `<userData>/cache`.
 *    MEASURED on this machine (`%APPDATA%/Darhai`): that directory is
 *    CHROMIUM'S HTTP cache - it sits next to `Code Cache`, `GPUCache` and
 *    `Network`, and contains `Cache_Data`. Windows paths are case-insensitive,
 *    so `path.join(userData, 'cache')` and Chromium's `Cache` are the same
 *    directory. The settings "clear cache" button therefore deleted the
 *    browser cache out from under a running Electron session and left the
 *    app's own cache (`getDataPath()/cache`, written by `HubInstaller`)
 *    untouched.
 *
 * 2. The export dialog proposed `wayland-backup-<date>.zip`, the pre-fork name.
 *
 * The tests drive the REAL providers registered by `initStorageBridge`; only
 * Electron's `app`/`dialog`/`shell` are stubbed, because those are the process
 * boundary and not the behaviour under test.
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';

const state = vi.hoisted(() => ({
  userData: '',
  logs: '',
  /** `showSaveDialog` returns this path; `null` means the user cancelled. */
  savePath: null as string | null,
  /** `showOpenDialog` returns this path; `null` means the user cancelled. */
  openPath: null as string | null,
  /** `defaultPath` the app proposed in the last save dialog. */
  proposedSaveName: '',
  /** Every path handed to `shell.openPath`. */
  opened: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'logs' ? state.logs : state.userData),
    relaunch: () => {},
    quit: () => {},
  },
  dialog: {
    showSaveDialog: async (opts: { defaultPath: string }) => {
      state.proposedSaveName = opts.defaultPath;
      if (state.savePath === null) return { canceled: true, filePath: undefined };
      return { canceled: false, filePath: state.savePath };
    },
    showOpenDialog: async () => {
      if (state.openPath === null) return { canceled: true, filePaths: [] };
      return { canceled: false, filePaths: [state.openPath] };
    },
  },
  shell: {
    openPath: async (p: string) => {
      state.opened.push(p);
      return '';
    },
  },
}));

const providers = vi.hoisted(() => ({}) as Record<string, (arg?: unknown) => Promise<unknown>>);

vi.mock('@/common', () => {
  const slot = (name: string) => ({
    provider: (fn: (arg?: unknown) => Promise<unknown>) => {
      providers[name] = fn;
    },
  });
  return {
    ipcBridge: {
      storage: {
        computeUsage: slot('computeUsage'),
        openDir: slot('openDir'),
        clearDir: slot('clearDir'),
        changeDir: slot('changeDir'),
        exportAll: slot('exportAll'),
        importBackup: slot('importBackup'),
        resetAll: slot('resetAll'),
      },
    },
  };
});

// See storage.backupRoundTrip.test.ts - better-sqlite3 is built for Electron's
// ABI, so the Node runner uses node:sqlite instead and still exercises real SQL.
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

import { initStorageBridge } from '../../src/process/storage/storageIpc';

const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-ipc-'));
}

function writeFixture(dir: string, relPath: string, content: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

/** The directory Chromium owns: `<userData>/Cache` (plus `Cache_Data` inside). */
function seedChromiumHttpCache(userData: string): string {
  return writeFixture(userData, path.join('Cache', 'Cache_Data', 'f_000001'), 'http-response-bytes');
}

/** The directory the app owns: `getDataPath()/cache` - see HubInstaller. */
function seedAppCache(userData: string): string {
  return writeFixture(userData, path.join(DATA_DIR, 'cache', 'hub', 'pkg.tgz'), 'hub-download');
}

beforeEach(() => {
  state.userData = mkTmpDir();
  state.logs = mkTmpDir();
  state.savePath = null;
  state.openPath = null;
  state.proposedSaveName = '';
  state.opened = [];
  initStorageBridge();
});

afterEach(() => {
  for (const d of [state.userData, state.logs]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("clearDir('cache') clears the app's cache, not Chromium's", () => {
  it("leaves Chromium's HTTP cache alone", async () => {
    const chromium = seedChromiumHttpCache(state.userData);
    seedAppCache(state.userData);

    await providers.clearDir('cache');

    expect(fs.existsSync(chromium)).toBe(true);
  });

  it("empties the app's own cache directory", async () => {
    const appCache = seedAppCache(state.userData);

    await providers.clearDir('cache');

    expect(fs.existsSync(appCache)).toBe(false);
    // The directory itself is recreated so the next writer does not have to.
    expect(fs.existsSync(path.join(state.userData, DATA_DIR, 'cache'))).toBe(true);
  });

  it('never touches the database while clearing the cache', async () => {
    const db = writeFixture(state.userData, path.join(DATA_DIR, DB_FILE), 'sqlite-bytes');
    seedAppCache(state.userData);

    await providers.clearDir('cache');

    expect(fs.existsSync(db)).toBe(true);
  });

  it("still clears the logs directory for kind 'logs'", async () => {
    const log = writeFixture(state.logs, 'main.log', 'noise');

    await providers.clearDir('logs');

    expect(fs.existsSync(log)).toBe(false);
  });
});

describe("openDir('cache') opens the app's cache directory", () => {
  it("hands shell.openPath the app's cache path", async () => {
    seedAppCache(state.userData);

    await providers.openDir('cache');

    expect(state.opened).toEqual([path.join(state.userData, DATA_DIR, 'cache')]);
  });

  it('opens the cache directory even before its first writer created it', async () => {
    await providers.openDir('cache');

    expect(state.opened).toEqual([path.join(state.userData, DATA_DIR, 'cache')]);
  });
});

describe('export dialog proposes a Дархай-named archive', () => {
  it('proposes darhai-backup-<date>.zip', async () => {
    state.savePath = null; // cancel - we only care about the proposed name

    await providers.exportAll({ includeKeys: false });

    expect(path.basename(state.proposedSaveName)).toMatch(/^darhai-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  });
});

describe('importBackup reads the archive CONTENTS, not its filename', () => {
  let src: string;

  beforeEach(() => {
    src = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
  });

  /** Build an archive holding a real SQLite database plus one config file. */
  async function buildBackup(zipName: string, rowValue: string): Promise<string> {
    const donorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-donor-'));
    try {
      const donorDb = path.join(donorDir, DB_FILE);
      const db = new DatabaseSync(donorDb);
      db.exec('CREATE TABLE conversations(id TEXT)');
      db.prepare('INSERT INTO conversations VALUES (?)').run(rowValue);
      db.close();

      const zip = new JSZip();
      zip.file(`${DATA_DIR}/${DB_FILE}`, fs.readFileSync(donorDb));
      zip.file('config/settings.json', '{"from":"old-backup"}');
      zip.file('manifest.json', JSON.stringify({ version: 1, includesDatabase: true }));

      const zipPath = path.join(src, zipName);
      fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
      return zipPath;
    } finally {
      fs.rmSync(donorDir, { recursive: true, force: true });
    }
  }

  it('restores a zip still carrying the old wayland-backup-<date>.zip name', async () => {
    state.openPath = await buildBackup('wayland-backup-2025-01-01.zip', 'old-named-archive');

    const result = (await providers.importBackup({})) as { ok: boolean };

    expect(result.ok).toBe(true);
    const restored = path.join(state.userData, DATA_DIR, DB_FILE);
    const db = new DatabaseSync(restored);
    const row = db.prepare('SELECT id FROM conversations').get() as { id: string };
    db.close();
    expect(row.id).toBe('old-named-archive');
    expect(fs.readFileSync(path.join(state.userData, 'config', 'settings.json'), 'utf-8')).toBe(
      '{"from":"old-backup"}'
    );
  });

  it('restores a zip carrying an arbitrary user-chosen name', async () => {
    state.openPath = await buildBackup('my holiday snapshot.zip', 'renamed-archive');

    await providers.importBackup({});

    const db = new DatabaseSync(path.join(state.userData, DATA_DIR, DB_FILE));
    const row = db.prepare('SELECT id FROM conversations').get() as { id: string };
    db.close();
    expect(row.id).toBe('renamed-archive');
  });
});
