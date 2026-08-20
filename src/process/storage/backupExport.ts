import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { createDriver } from '@process/services/database/drivers/createDriver';

/**
 * The app's real data directory is `getDataPath()` (src/process/utils/utils.ts),
 * which appends `wayland` to the Electron `userData` path. The SQLite database
 * that holds every conversation and message lives there - not directly under
 * `userData`. See the note in `resetAll.ts` for why this is a local constant
 * rather than a `getDataPath()` call.
 */
const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

export type ExportOptions = {
  userData: string;
  destPath: string;
  /** When true, encrypt the API-keys section with AES-256-GCM. */
  includeKeys: boolean;
  passphrase?: string;
};

/** Recursively add a directory's contents into a JSZip folder. */
async function addDir(zip: JSZip, dir: string, zipPath: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcFull = path.join(dir, entry.name);
    const zipFull = `${zipPath}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDir(zip, srcFull, zipFull);
    } else if (entry.isFile()) {
      const data = fs.readFileSync(srcFull);
      zip.file(zipFull, data);
    }
  }
}

/** Quote a filesystem path for use as a SQLite string literal. */
function toSqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Add a consistent snapshot of the SQLite database to the archive.
 *
 * The database runs in WAL mode (`schema.ts` sets `journal_mode = WAL`), so it
 * is NOT a plain file: recent commits may live only in the `-wal` sidecar, and
 * the main file can be mid-write while the app is running. Copying
 * `wayland.db` byte-for-byte therefore produces a backup that is missing recent
 * data at best, and unopenable at worst.
 *
 * `VACUUM INTO` is SQLite's supported way to take that snapshot: it runs inside
 * a read transaction, so it sees a single consistent point in time even while
 * other connections write, and it emits ONE self-contained file with no
 * sidecars - exactly what belongs in an archive. The app had no existing safe
 * copy mechanism (no `VACUUM INTO`, no `backup()`, no checkpoint helper
 * anywhere in `src/`), so this introduces one rather than reusing one.
 *
 * If the database exists but cannot be snapshotted, this THROWS rather than
 * falling back to a raw copy. A loud failure is recoverable; a silent backup
 * missing the user's conversations is what this whole function exists to fix.
 *
 * @returns true if a database snapshot was added, false if there is no database yet.
 */
async function addDatabaseSnapshot(zip: JSZip, userData: string): Promise<boolean> {
  const dbPath = path.join(userData, DATA_DIR, DB_FILE);
  if (!fs.existsSync(dbPath)) return false;

  // `VACUUM INTO` refuses to overwrite an existing file, so the destination
  // must be a fresh path inside a private directory.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-backup-'));
  const snapshotPath = path.join(tmpDir, DB_FILE);

  try {
    const driver = await createDriver(dbPath);
    try {
      driver.exec(`VACUUM INTO ${toSqliteLiteral(snapshotPath)}`);
    } finally {
      driver.close();
    }
    zip.file(`${DATA_DIR}/${DB_FILE}`, fs.readFileSync(snapshotPath));
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** AES-256-GCM encrypt a Buffer with a passphrase. Returns base64. */
function encryptBuffer(buf: Buffer, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: salt(16) | iv(12) | tag(16) | ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

export async function backupExport(opts: ExportOptions): Promise<void> {
  const zip = new JSZip();

  // The database - conversations and messages live in SQLite, not in files.
  const includesDatabase = await addDatabaseSnapshot(zip, opts.userData);

  // Conversations (legacy file-based layout, restored by older backups)
  await addDir(zip, path.join(opts.userData, 'conversations'), 'conversations');

  // Attachments / blobs
  await addDir(zip, path.join(opts.userData, 'attachments'), 'attachments');

  // Settings (localStorage snapshot not accessible from main; export config files)
  const configDir = path.join(opts.userData, 'config');
  await addDir(zip, configDir, 'config');

  // API keys (optional, encrypted)
  if (opts.includeKeys && opts.passphrase) {
    const keysFile = path.join(opts.userData, 'keys.json');
    if (fs.existsSync(keysFile)) {
      const raw = fs.readFileSync(keysFile);
      const encrypted = encryptBuffer(raw, opts.passphrase);
      zip.file('keys.json.enc', encrypted);
    }
  }

  // Manifest
  zip.file(
    'manifest.json',
    JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includesKeys: opts.includeKeys,
        includesDatabase,
      },
      null,
      2
    )
  );

  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(opts.destPath, content);
}
