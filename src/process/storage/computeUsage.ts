import * as fs from 'fs';
import * as path from 'path';

/**
 * The app's real data directory is `getDataPath()` (src/process/utils/utils.ts),
 * which appends `wayland` to the Electron `userData` path. See the note in
 * `resetAll.ts` for why this is a local constant rather than a `getDataPath()`
 * call.
 */
const DATA_DIR = 'wayland';
const DB_FILE = 'wayland.db';

/** `schema.ts` sets `journal_mode = WAL`, so unflushed bytes sit in the sidecars. */
const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'];

export type UsageBreakdownItem = {
  label: string;
  bytes: number;
  color: string;
};

export type UsageResult = {
  total: number;
  used: number;
  breakdown: UsageBreakdownItem[];
  computedAt: number;
};

/** Size of a single file, or 0 if it is missing or unreadable. */
function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Walk a directory recursively and sum file sizes. Returns 0 if the dir does not
 * exist. Files whose absolute path is in `skip` are not counted, so a caller can
 * measure a directory without double-counting a part it reports separately.
 */
async function dirSize(dirPath: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  if (!fs.existsSync(dirPath)) return 0;

  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await dirSize(full, skip);
      } else if (entry.isFile()) {
        if (skip.has(full)) return;
        total += fileSize(full);
      }
    })
  );

  return total;
}

let cachedResult: UsageResult | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function computeUsage(userData: string, logsDir: string): Promise<UsageResult> {
  if (cachedResult && Date.now() - cachedResult.computedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  const dataDir = path.join(userData, DATA_DIR);
  const dbPath = path.join(dataDir, DB_FILE);
  const dbFiles = [dbPath, ...DB_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`)];

  // Conversations and messages live in SQLite, not in a `conversations/`
  // directory - so the database file plus its WAL sidecars IS the conversation
  // footprint.
  const conversationBytes = dbFiles.reduce((sum, file) => sum + fileSize(file), 0);

  // Everything else the app writes into its data directory: scratch workspaces
  // (`wcore-temp-*`, `claude-temp-*`), snapshots and extension state.
  //
  // NOTE: the three labels below are used verbatim as i18n keys by
  // `StorageSettings/UsageCard.tsx` (`settings.storagePage.${label}`), and only
  // `conversations`, `cache` and `logs` exist in `locales/*/settings.json`.
  // Reporting this remainder under `cache` keeps the breakdown honest about the
  // bytes without inventing a key that no locale defines.
  const [cacheBytes, logBytes] = await Promise.all([dirSize(dataDir, new Set(dbFiles)), dirSize(logsDir)]);

  const used = conversationBytes + cacheBytes + logBytes;

  const result: UsageResult = {
    total: 0, // disk total not queried - renderer shows used only
    used,
    breakdown: [
      { label: 'conversations', bytes: conversationBytes, color: 'var(--primary)' },
      { label: 'cache', bytes: cacheBytes, color: 'var(--warning)' },
      { label: 'logs', bytes: logBytes, color: 'var(--text-muted)' },
    ],
    computedAt: Date.now(),
  };

  cachedResult = result;
  return result;
}

/** Force-invalidate the cache (call after clear/reset operations). */
export function invalidateUsageCache(): void {
  cachedResult = null;
}
