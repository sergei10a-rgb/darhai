import { app, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ipcBridge } from '@/common';
import { computeUsage, invalidateUsageCache } from './computeUsage';
import { backupExport } from './backupExport';
import { backupImport } from './backupImport';
import { resetAll } from './resetAll';

/**
 * The app's real data directory is `getDataPath()` (src/process/utils/utils.ts),
 * which appends `wayland` to the Electron `userData` path. See the note in
 * `resetAll.ts` for why this is a local constant rather than a `getDataPath()`
 * call.
 */
const DATA_DIR = 'wayland';

function getUserData(): string {
  return app.getPath('userData');
}

function getLogsDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    return path.join(getUserData(), 'logs');
  }
}

/**
 * The app's OWN cache directory - `getDataPath()/cache`, which is what
 * `HubInstaller` writes into (`getDataPath()/cache/hub`).
 *
 * This used to be `<userData>/cache`, which is NOT the app's cache at all.
 * MEASURED on this machine (`%APPDATA%/Darhai`): that path is Chromium's HTTP
 * cache, sitting beside `Code Cache`, `GPUCache`, `Network` and `Local
 * Storage`, and holding a `Cache_Data` directory. Windows paths are
 * case-insensitive, so `path.join(userData, 'cache')` and Chromium's `Cache`
 * resolve to the same directory: the settings "clear cache" button deleted the
 * browser cache of a running Electron session - which Chromium owns and may
 * have open - while the app's own cache grew forever, untouched and invisible.
 *
 * Only the app's cache is ours to clear. Chromium's belongs to the session and
 * is managed by `session.clearCache()`, never by `fs.rmSync`.
 */
function getAppCacheDir(): string {
  return path.join(getUserData(), DATA_DIR, 'cache');
}

export function initStorageBridge(): void {
  // Compute disk usage (cached in computeUsage)
  ipcBridge.storage.computeUsage.provider(async () => {
    return computeUsage(getUserData(), getLogsDir());
  });

  // Open a directory in the system file manager
  ipcBridge.storage.openDir.provider(async (kind) => {
    const k = kind as 'workspace' | 'cache' | 'logs';
    const dirs: Record<string, string> = {
      workspace: getUserData(),
      cache: getAppCacheDir(),
      logs: getLogsDir(),
    };
    const dirPath = dirs[k] ?? getUserData();
    // The cache directory is created lazily by its first writer, so on a fresh
    // install it does not exist yet. Create it rather than letting the button
    // silently do nothing.
    fs.mkdirSync(dirPath, { recursive: true });
    await shell.openPath(dirPath);
  });

  // Clear a directory (cache or logs only - workspace not clearable)
  ipcBridge.storage.clearDir.provider(async (kind) => {
    const k = kind as 'cache' | 'logs';
    const dirs: Record<string, string> = {
      cache: getAppCacheDir(),
      logs: getLogsDir(),
    };
    const dirPath = dirs[k];
    if (!dirPath || !fs.existsSync(dirPath)) return;
    fs.rmSync(dirPath, { recursive: true, force: true });
    fs.mkdirSync(dirPath, { recursive: true });
    invalidateUsageCache();
  });

  // Change workspace directory (opens folder picker, returns chosen path)
  ipcBridge.storage.changeDir.provider(async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });

  // Export all data to a zip file
  ipcBridge.storage.exportAll.provider(async (opts) => {
    const result = await dialog.showSaveDialog({
      title: 'Export Дархай data',
      // Cosmetic only. `backupImport` reads the archive's CONTENTS (its entry
      // names), never its filename, so archives written under the old
      // `wayland-backup-*` name - or renamed by the user - still restore.
      defaultPath: `darhai-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await backupExport({
      userData: getUserData(),
      destPath: result.filePath,
      includeKeys: opts.includeKeys,
      passphrase: opts.passphrase,
    });
    return { ok: true, path: result.filePath };
  });

  // Import from a backup zip
  ipcBridge.storage.importBackup.provider(async (opts) => {
    const result = await dialog.showOpenDialog({
      title: 'Restore Дархай backup',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    await backupImport({
      userData: getUserData(),
      srcPath: result.filePaths[0],
      passphrase: opts.passphrase,
    });
    invalidateUsageCache();
    return { ok: true };
  });

  // Full data reset (renderer must enforce double-confirm before calling)
  ipcBridge.storage.resetAll.provider(async () => {
    await resetAll(getUserData(), getLogsDir());
    invalidateUsageCache();
    // Relaunch so the app starts fresh
    app.relaunch();
    app.quit();
  });
}
