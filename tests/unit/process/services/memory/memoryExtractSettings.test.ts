/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the memory auto-extract toggle persistence. Verifies the
 * OPT-IN default (OFF), that set persists + updates the cache, and that a fresh
 * read reflects the saved value. Uses a temp HOME via an os.homedir spy.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAutoExtractEnabled,
  setAutoExtractEnabled,
  resetAutoExtractSettingsCache,
} from '@process/services/memory/memoryExtractSettings';
import { memoryArchiveConfigDir } from '@process/services/memory/promotionSweep';

const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;

function restoreEnv(key: 'USERPROFILE' | 'HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restoreEnv('USERPROFILE', ORIG_USERPROFILE);
  restoreEnv('HOME', ORIG_HOME);
  resetAutoExtractSettingsCache();
  vi.restoreAllMocks();
});

/** Point os.homedir() at a fresh temp dir via the env vars it reads. */
function withTempHome(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-extract-settings-'));
  process.env.USERPROFILE = tmp;
  process.env.HOME = tmp;
  resetAutoExtractSettingsCache();
  return tmp;
}

describe('memoryExtractSettings', () => {
  it('defaults to OFF when no settings file exists', () => {
    withTempHome();
    expect(getAutoExtractEnabled()).toBe(false);
  });

  it('persists the toggle and reflects it in the cache and a fresh read', () => {
    const tmp = withTempHome();

    setAutoExtractEnabled(true);
    expect(getAutoExtractEnabled()).toBe(true);

    // Written to its own file (derived from the shared config dir helper), not
    // the promotion settings file.
    const file = path.join(memoryArchiveConfigDir(), 'memory-extract-settings.json');
    expect(file.startsWith(tmp)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toEqual({ autoExtractEnabled: true });

    // A cold read (cache reset) still sees the persisted value.
    resetAutoExtractSettingsCache();
    expect(getAutoExtractEnabled()).toBe(true);
  });

  it('can be turned back off', () => {
    withTempHome();
    setAutoExtractEnabled(true);
    setAutoExtractEnabled(false);
    expect(getAutoExtractEnabled()).toBe(false);
    resetAutoExtractSettingsCache();
    expect(getAutoExtractEnabled()).toBe(false);
  });
});
