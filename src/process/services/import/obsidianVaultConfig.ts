/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Obsidian vault discovery from Obsidian's own config file.
 *
 * Obsidian records every vault the user has opened in `obsidian.json`:
 *   Windows: %APPDATA%/obsidian/obsidian.json
 *   macOS:   ~/Library/Application Support/obsidian/obsidian.json
 *   Linux:   ~/.config/obsidian/obsidian.json
 * Shape: { vaults: { <id>: { path: string, ts: number, open?: boolean } } }
 *
 * This is the authoritative source for vaults that live OUTSIDE ~/Documents
 * (which obsidianImporter.detectVaults() cannot see). We use it both to
 * populate the import drawer's vault list and to validate a vault path the
 * renderer asks to import (a configured vault is trusted even outside home).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';

export type ConfiguredVault = {
  path: string;
  name: string;
  mdCount: number;
};

/** Cap the md-count walk so a huge vault does not stall drawer open. */
const MD_COUNT_CAP = 9999;

function obsidianConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return path.join(xdg, 'obsidian', 'obsidian.json');
}

/** Count .md files under `dir` (recursive), stopping at MD_COUNT_CAP. */
async function countMdBounded(dir: string): Promise<number> {
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && count < MD_COUNT_CAP) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue; // skip .obsidian, .trash, .git
        stack.push(path.join(current, entry.name));
      } else if (entry.name.endsWith('.md')) {
        count++;
        if (count >= MD_COUNT_CAP) break;
      }
    }
  }
  return count;
}

/**
 * Read Obsidian's config and return every vault whose directory still exists.
 * Returns [] if the config is absent or unparseable (never throws).
 */
export async function detectConfiguredVaults(configPathOverride?: string): Promise<ConfiguredVault[]> {
  const configPath = configPathOverride ?? obsidianConfigPath();
  let raw: string;
  try {
    raw = await fs.promises.readFile(configPath, 'utf8');
  } catch {
    return []; // Obsidian not installed / never run.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('[obsidianVaultConfig] obsidian.json unparseable', { err });
    return [];
  }

  const vaultsObj =
    parsed && typeof parsed === 'object' && 'vaults' in parsed
      ? (parsed as { vaults?: Record<string, { path?: unknown }> }).vaults
      : undefined;
  if (!vaultsObj || typeof vaultsObj !== 'object') return [];

  const out: ConfiguredVault[] = [];
  for (const entry of Object.values(vaultsObj)) {
    const vaultPath = entry && typeof entry.path === 'string' ? entry.path : null;
    if (!vaultPath) continue;
    try {
      const st = await fs.promises.stat(vaultPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue; // vault directory was deleted/moved - skip.
    }
    const mdCount = await countMdBounded(vaultPath);
    out.push({ path: vaultPath, name: path.basename(vaultPath), mdCount });
  }
  return out;
}

/**
 * Absolute paths of all configured Obsidian vaults, canonicalised for a
 * membership test. Used to trust a vault import that lives outside the home dir.
 */
export async function getConfiguredVaultPaths(configPathOverride?: string): Promise<Set<string>> {
  const vaults = await detectConfiguredVaults(configPathOverride);
  const set = new Set<string>();
  for (const v of vaults) {
    try {
      set.add(await fs.promises.realpath(v.path));
    } catch {
      set.add(path.resolve(v.path));
    }
  }
  return set;
}
