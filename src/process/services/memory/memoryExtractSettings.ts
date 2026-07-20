/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Persistence for the memory auto-extract toggle (Odysseus #2, native).
 *
 * OPT-IN, default OFF: auto-writing durable facts from conversations into the
 * user's persistent memory must be an explicit choice. When off there are ZERO
 * LLM calls and ZERO writes.
 *
 * Mirrors the promotion-sweep settings precedent but writes to its OWN file in
 * the same config dir, so toggling auto-extract can never clobber the promotion
 * settings (and vice versa). The value is cached in memory after first read so
 * the per-turn `isEnabled()` check stays O(1).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import log from 'electron-log';
import { memoryArchiveConfigDir } from './promotionSweep';

type ExtractSettings = {
  autoExtractEnabled: boolean;
};

const SETTINGS_FILE = 'memory-extract-settings.json';

function settingsPath(): string {
  return path.join(memoryArchiveConfigDir(), SETTINGS_FILE);
}

/** In-memory cache; null until first load. */
let cachedEnabled: boolean | null = null;

function readFromDisk(): boolean {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExtractSettings>;
    return typeof parsed.autoExtractEnabled === 'boolean' ? parsed.autoExtractEnabled : false;
  } catch {
    // Missing / unreadable / malformed -> default OFF.
    return false;
  }
}

/** Whether auto-extract is enabled. Default OFF. Cached after first read. */
export function getAutoExtractEnabled(): boolean {
  if (cachedEnabled === null) {
    cachedEnabled = readFromDisk();
  }
  return cachedEnabled;
}

/** Persist the toggle and update the in-memory cache. */
export function setAutoExtractEnabled(enabled: boolean): void {
  cachedEnabled = enabled;
  const p = settingsPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ autoExtractEnabled: enabled } satisfies ExtractSettings, null, 2), 'utf8');
  } catch (err) {
    log.warn('[memory-extract] could not save settings', { err });
  }
}

/** Reset the cache (test-only). */
export function resetAutoExtractSettingsCache(): void {
  cachedEnabled = null;
}
