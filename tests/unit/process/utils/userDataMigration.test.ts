import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  migrateLegacyUserData,
  LEGACY_USER_DATA_DIR_NAME,
  USER_DATA_MIGRATION_MARKER,
} from '../../../../src/process/utils/userDataMigration';

describe('migrateLegacyUserData', () => {
  let baseDir: string;
  let legacyDir: string;
  let newDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-userdata-migration-'));
    legacyDir = path.join(baseDir, LEGACY_USER_DATA_DIR_NAME);
    newDir = path.join(baseDir, 'Darhai');
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const seedLegacyInstall = () => {
    fs.mkdirSync(path.join(legacyDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'config', 'wayland-config.txt'), 'legacy-config');
    fs.writeFileSync(path.join(legacyDir, 'config', '.wayland-env'), 'legacy-env');
    fs.mkdirSync(path.join(legacyDir, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'Local Storage', 'state.db'), 'ls');
  };

  it('copies a legacy install into a fresh new dir and writes the marker', () => {
    seedLegacyInstall();

    const result = migrateLegacyUserData(newDir);

    expect(result).toEqual({ migrated: true, reason: 'copied' });
    expect(fs.readFileSync(path.join(newDir, 'config', 'wayland-config.txt'), 'utf-8')).toBe('legacy-config');
    expect(fs.existsSync(path.join(newDir, 'Local Storage', 'state.db'))).toBe(true);
    expect(fs.existsSync(path.join(newDir, USER_DATA_MIGRATION_MARKER))).toBe(true);
    // Source is left intact
    expect(fs.existsSync(path.join(legacyDir, 'config', 'wayland-config.txt'))).toBe(true);
  });

  it('skips Chromium junk directories (Cache/GPUCache/Crashpad/logs)', () => {
    seedLegacyInstall();
    for (const junk of ['Cache', 'GPUCache', 'Crashpad', 'logs', 'Code Cache', 'blob_storage']) {
      fs.mkdirSync(path.join(legacyDir, junk), { recursive: true });
      fs.writeFileSync(path.join(legacyDir, junk, 'junk.bin'), 'x');
    }

    const result = migrateLegacyUserData(newDir);

    expect(result.migrated).toBe(true);
    for (const junk of ['Cache', 'GPUCache', 'Crashpad', 'logs', 'Code Cache', 'blob_storage']) {
      expect(fs.existsSync(path.join(newDir, junk))).toBe(false);
    }
    expect(fs.existsSync(path.join(newDir, 'config', 'wayland-config.txt'))).toBe(true);
  });

  it('does nothing when the legacy dir does not exist', () => {
    const result = migrateLegacyUserData(newDir);

    expect(result).toEqual({ migrated: false, reason: 'no-legacy-dir' });
    expect(fs.existsSync(newDir)).toBe(false);
  });

  it('never runs twice: the marker short-circuits subsequent launches', () => {
    seedLegacyInstall();

    expect(migrateLegacyUserData(newDir).migrated).toBe(true);

    // Simulate new legacy content appearing after migration - must NOT be copied
    fs.writeFileSync(path.join(legacyDir, 'config', 'later.txt'), 'later');
    const second = migrateLegacyUserData(newDir);

    expect(second).toEqual({ migrated: false, reason: 'marker-present' });
    expect(fs.existsSync(path.join(newDir, 'config', 'later.txt'))).toBe(false);
  });

  it('does not migrate over an existing install and writes the marker instead', () => {
    seedLegacyInstall();
    fs.mkdirSync(path.join(newDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(newDir, 'config', 'wayland-config.txt'), 'new-install-config');

    const result = migrateLegacyUserData(newDir);

    expect(result).toEqual({ migrated: false, reason: 'existing-install' });
    expect(fs.readFileSync(path.join(newDir, 'config', 'wayland-config.txt'), 'utf-8')).toBe('new-install-config');
    // Marker prevents re-checking on every launch
    expect(fs.existsSync(path.join(newDir, USER_DATA_MIGRATION_MARKER))).toBe(true);
  });

  it('refuses to migrate when legacy and new dirs are the same path', () => {
    seedLegacyInstall();

    const result = migrateLegacyUserData(legacyDir);

    expect(result).toEqual({ migrated: false, reason: 'same-dir' });
  });
});
