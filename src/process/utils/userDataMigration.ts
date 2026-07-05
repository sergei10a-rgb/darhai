/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-time userData migration for the Wayland → Darhai rename.
 *
 * The package.json name/productName rename moved Electron's userData directory
 * from '<base>/Wayland' to '<base>/Darhai' (e.g. %APPDATA%\Wayland →
 * %APPDATA%\Darhai). Without a migration, existing installs would silently
 * lose all local data (provider creds, chat history, extensions) - it would
 * remain stranded in the old directory.
 *
 * This module runs a synchronous copy at import time, BEFORE initStorage's
 * module-level side effects read the env/config files from userData. It is
 * imported by src/index.ts immediately after configureChromium (which
 * finalizes the userData path).
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { writeFileSyncAtomic } from './atomicWrite';

/** Directory name used by pre-rebrand packaged builds. */
export const LEGACY_USER_DATA_DIR_NAME = 'Wayland';

/** Marker file written into the new userData dir so the migration never repeats. */
export const USER_DATA_MIGRATION_MARKER = '.migrated-from-wayland.json';

// Chromium/runtime junk that must not be copied - it is machine/session-local,
// large, and regenerated automatically (finding: skip Cache/GPUCache/Crashpad/logs).
const SKIPPED_TOP_LEVEL_ENTRIES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'crashpad',
  'logs',
  'blob_storage',
]);

export type UserDataMigrationResult = {
  migrated: boolean;
  reason: 'copied' | 'marker-present' | 'no-legacy-dir' | 'same-dir' | 'existing-install' | 'copy-failed';
};

const hasMeaningfulConfig = (userDataDir: string): boolean => {
  // initStorage creates <userData>/config on every startup and writes the
  // config store into it, so its presence (with contents) is the reliable
  // "this install has already run" signal.
  const configDir = path.join(userDataDir, 'config');
  try {
    return existsSync(configDir) && readdirSync(configDir).length > 0;
  } catch {
    // Unreadable - assume it's a real install to avoid overwriting anything.
    return true;
  }
};

const writeMarker = (userDataDir: string, payload: Record<string, unknown>): void => {
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSyncAtomic(path.join(userDataDir, USER_DATA_MIGRATION_MARKER), JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[UserDataMigration] Failed to write migration marker:', error);
  }
};

/**
 * Copy the legacy 'Wayland' userData directory into the new one, once.
 *
 * Preconditions (all checked here):
 * - no migration marker in the new dir
 * - the sibling legacy dir exists and differs from the new dir
 * - the new dir is fresh (no populated config/ store yet)
 *
 * Existing files in the new dir are never overwritten (force: false).
 * Synchronous by design: initStorage reads userData files synchronously at
 * module import time, so the copy must complete before that.
 */
export function migrateLegacyUserData(
  newUserDataDir: string,
  legacyDirName: string = LEGACY_USER_DATA_DIR_NAME
): UserDataMigrationResult {
  const markerPath = path.join(newUserDataDir, USER_DATA_MIGRATION_MARKER);
  if (existsSync(markerPath)) {
    return { migrated: false, reason: 'marker-present' };
  }

  const legacyDir = path.join(path.dirname(newUserDataDir), legacyDirName);
  if (!existsSync(legacyDir)) {
    return { migrated: false, reason: 'no-legacy-dir' };
  }
  if (path.resolve(legacyDir) === path.resolve(newUserDataDir)) {
    return { migrated: false, reason: 'same-dir' };
  }

  if (hasMeaningfulConfig(newUserDataDir)) {
    // Already a real install - never migrate over it, and never re-check.
    writeMarker(newUserDataDir, {
      migratedFrom: null,
      skippedReason: 'existing-install',
      at: new Date().toISOString(),
    });
    return { migrated: false, reason: 'existing-install' };
  }

  try {
    console.log(`[UserDataMigration] Copying legacy userData: ${legacyDir} → ${newUserDataDir}`);
    mkdirSync(newUserDataDir, { recursive: true });
    cpSync(legacyDir, newUserDataDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src: string) => {
        const rel = path.relative(legacyDir, src);
        if (!rel) return true;
        const topLevel = rel.split(path.sep)[0];
        return !SKIPPED_TOP_LEVEL_ENTRIES.has(topLevel);
      },
    });
    writeMarker(newUserDataDir, {
      migratedFrom: legacyDir,
      at: new Date().toISOString(),
    });
    console.log('[UserDataMigration] Legacy userData migration complete');
    return { migrated: true, reason: 'copied' };
  } catch (error) {
    // No marker on failure: the copy is retried on the next launch (force:
    // false makes the retry idempotent for files that did land).
    console.error('[UserDataMigration] Legacy userData copy failed:', error);
    return { migrated: false, reason: 'copy-failed' };
  }
}

/**
 * Boot hook - executed at module import (side effect), mirroring the
 * configureChromium pattern. Electron main process + packaged builds only:
 * dev builds still use the unchanged 'Wayland-Dev' app name, and the sibling
 * 'Wayland' dir on a dev machine may belong to a real production install.
 */
function runLegacyUserDataMigrationBoot(): void {
  try {
    if (!process.versions?.electron) return;
    const processType = (process as NodeJS.Process & { type?: string }).type;
    if (processType !== 'browser') return;
    // Lazy require keeps this module importable from plain-Node unit tests
    // (same pattern as src/common/platform/index.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    if (!app.isPackaged) return;
    migrateLegacyUserData(app.getPath('userData'));
  } catch (error) {
    console.error('[UserDataMigration] Boot failed:', error);
  }
}

runLegacyUserDataMigrationBoot();
