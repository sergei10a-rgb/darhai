/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectConfiguredVaults, getConfiguredVaultPaths } from '@process/services/import/obsidianVaultConfig';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-obsidian-cfg-test-'));
}

describe('detectConfiguredVaults', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tmpDirs.length = 0;
  });

  it('returns vaults listed in obsidian.json that still exist', async () => {
    const base = makeTmp();
    tmpDirs.push(base);

    const vaultPath = path.join(base, 'My Vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.writeFileSync(path.join(vaultPath, 'a.md'), '# A', 'utf8');
    fs.writeFileSync(path.join(vaultPath, 'b.md'), '# B', 'utf8');

    // A deleted vault should be filtered out.
    const configPath = path.join(base, 'obsidian.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        vaults: {
          abc123: { path: vaultPath, ts: 1, open: true },
          dead99: { path: path.join(base, 'Gone'), ts: 2 },
        },
      }),
      'utf8'
    );

    const vaults = await detectConfiguredVaults(configPath);
    expect(vaults).toHaveLength(1);
    expect(vaults[0].path).toBe(vaultPath);
    expect(vaults[0].name).toBe('My Vault');
    expect(vaults[0].mdCount).toBe(2);
  });

  it('returns [] when the config file is absent', async () => {
    const vaults = await detectConfiguredVaults(path.join(makeTmp(), 'nope.json'));
    expect(vaults).toEqual([]);
  });

  it('returns [] for an unparseable config', async () => {
    const base = makeTmp();
    tmpDirs.push(base);
    const configPath = path.join(base, 'obsidian.json');
    fs.writeFileSync(configPath, '{ not json', 'utf8');

    const vaults = await detectConfiguredVaults(configPath);
    expect(vaults).toEqual([]);
  });

  it('getConfiguredVaultPaths returns resolved vault paths', async () => {
    const base = makeTmp();
    tmpDirs.push(base);
    const vaultPath = path.join(base, 'Vault');
    fs.mkdirSync(vaultPath, { recursive: true });

    const configPath = path.join(base, 'obsidian.json');
    fs.writeFileSync(configPath, JSON.stringify({ vaults: { id: { path: vaultPath } } }), 'utf8');

    const set = await getConfiguredVaultPaths(configPath);
    // realpath-canonicalised, so compare against the canonical form.
    const canonical = fs.realpathSync(vaultPath);
    expect(set.has(canonical) || set.has(path.resolve(vaultPath))).toBe(true);
  });
});
