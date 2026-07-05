/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSection, readConfig, resolveUserConfigPath, setSection } from '@process/agent/wcore/configBridge';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wcore-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readConfig', () => {
  it('returns {} for a missing file', async () => {
    const result = await readConfig(join(dir, 'config.toml'));
    expect(result).toEqual({});
  });

  it('parses the entire file into a plain object', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[tools]\nallow_list = ["ls"]\n\n[custom]\nfoo = "bar"\n', 'utf-8');
    const result = await readConfig(path);
    expect(result.tools).toEqual({ allow_list: ['ls'] });
    expect(result.custom).toEqual({ foo: 'bar' });
  });
});

describe('getSection', () => {
  it('returns the typed section value', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[tools]\nauto_approve = true\nallow_list = ["ls", "cat"]\n', 'utf-8');
    const tools = await getSection<{ auto_approve: boolean; allow_list: string[] }>('tools', path);
    expect(tools).toEqual({ auto_approve: true, allow_list: ['ls', 'cat'] });
  });

  it('returns undefined for an absent section', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[tools]\nallow_list = []\n', 'utf-8');
    expect(await getSection('memory', path)).toBeUndefined();
  });
});

describe('setSection', () => {
  it('updates the targeted section and preserves unknown sections', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[custom]\nkeep = "me"\n\n[tools]\nallow_list = ["old"]\nauto_approve = false\n', 'utf-8');

    await setSection('tools', { allow_list: ['ls'] }, path);

    const after = await readConfig(path);
    expect(after.tools).toEqual({ allow_list: ['ls'] });
    // Unknown section must survive a round-trip (parse whole / re-stringify whole).
    expect(after.custom).toEqual({ keep: 'me' });
  });

  it('creates the file (and parent dir) on first write to a nonexistent path', async () => {
    const path = join(dir, 'nested', 'config.toml');
    await setSection('security', { sandbox: true }, path);
    const after = await readConfig(path);
    expect(after.security).toEqual({ sandbox: true });
  });

  it('writes atomically via a temp file + rename (no .tmp leftover, no truncation)', async () => {
    const path = join(dir, 'config.toml');
    const big = Array.from({ length: 5000 }, (_, i) => `item-${i}`);

    await setSection('tools', { allow_list: big }, path);

    const after = await readConfig(path);
    expect((after.tools as { allow_list: string[] }).allow_list).toHaveLength(5000);

    // A truncate-in-place write would leave a partial file; rename-over leaves
    // exactly one file and no temp artifact in the directory.
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
    expect(entries).toContain('config.toml');
  });

  it('serializes concurrent writes to different sections (no lost update)', async () => {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[tools]\nallow_list = []\n', 'utf-8');

    // Fire both without awaiting between them - the single-flight lock must
    // serialize the read-modify-write so neither section is clobbered.
    await Promise.all([
      setSection('tools', { allow_list: ['ls'] }, path),
      setSection('memory', { enabled: true }, path),
    ]);

    const after = await readConfig(path);
    expect(after.tools).toEqual({ allow_list: ['ls'] });
    expect(after.memory).toEqual({ enabled: true });
  });
});

describe('resolveUserConfigPath', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('honors DARHAI_HOME (config.toml directly inside it)', () => {
    process.env.DARHAI_HOME = dir;
    expect(resolveUserConfigPath()).toBe(join(dir, 'config.toml'));
  });

  it('falls back to XDG_DATA_HOME/wayland-core when DARHAI_HOME is unset', () => {
    delete process.env.DARHAI_HOME;
    process.env.XDG_DATA_HOME = dir;
    expect(resolveUserConfigPath()).toBe(join(dir, 'wayland-core', 'config.toml'));
  });
});
