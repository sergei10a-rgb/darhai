/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift guard for the Windows Application User Model ID.
 *
 * Windows groups taskbar buttons and attributes toast notifications by this
 * ID. The installer registers its shortcut under `appId` from
 * electron-builder.yml; the running process must claim the SAME string via
 * `app.setAppUserModelId`. A mismatch is invisible in code review and silently
 * breaks notifications in packaged builds - so the constant is held against
 * the YAML here, and `src/index.ts` is checked for the call itself.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DARHAI_APP_USER_MODEL_ID } from '@/common/config/appIdentity';

const repoRoot = path.resolve(__dirname, '../..');

const readRepoFile = (relative: string): string => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('Windows Application User Model ID', () => {
  it('matches electron-builder appId byte for byte', () => {
    const yaml = readRepoFile('electron-builder.yml');
    const match = /^appId:\s*(\S+)\s*$/m.exec(yaml);
    expect(match, 'electron-builder.yml must declare appId').not.toBeNull();
    expect(DARHAI_APP_USER_MODEL_ID).toBe(match![1]);
  });

  it('is claimed at startup on Windows in src/index.ts', () => {
    const indexSource = readRepoFile('src/index.ts');
    expect(indexSource).toContain('setAppUserModelId(DARHAI_APP_USER_MODEL_ID)');
    // Guarded by a win32 check - the call is a no-op elsewhere but the guard
    // documents intent and keeps macOS/Linux startup untouched.
    expect(indexSource).toMatch(/process\.platform === 'win32'[\s\S]{0,120}setAppUserModelId/);
  });

  it('is a reverse-DNS id under the project domain, not a leftover upstream id', () => {
    expect(DARHAI_APP_USER_MODEL_ID).toMatch(/^mn\.darhai\./);
    expect(DARHAI_APP_USER_MODEL_ID.toLowerCase()).not.toContain('wayland');
  });
});

describe('branding assets the dev window loads', () => {
  it('ships the icon files src/index.ts resolves in development', () => {
    expect(fs.existsSync(path.join(repoRoot, 'resources/app.ico'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'resources/app_dev.png'))).toBe(true);
  });
});
