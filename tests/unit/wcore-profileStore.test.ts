/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// profileStore imports ipcBridge from '@/common' (for initWcoreProfileIpc, which
// we never call here) - stub it so the module loads in a node test env.
vi.mock('@/common', () => ({ ipcBridge: { wcoreProfiles: {} } }));

// Root the profiles/native dirs at a scratch home.
let home: string;
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

import { listProfiles } from '@process/agent/wcore/profileStore';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wcore-store-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('listProfiles - per-profile stats from the isolated config tree', () => {
  it('reads model + tool count + skill count + dir for a named profile', async () => {
    const dir = join(home, '.darhai', 'profiles', 'work');
    await mkdir(join(dir, 'skills', 'alpha'), { recursive: true });
    await mkdir(join(dir, 'skills', 'beta'), { recursive: true });
    await writeFile(
      join(dir, 'config.toml'),
      '[default]\nprovider = "anthropic"\nmodel = "anthropic/claude-opus-4.8"\n\n[tools]\nallow_list = ["ls", "cat", "grep"]\n',
      'utf-8'
    );
    // Make "work" the active profile.
    await writeFile(join(home, '.darhai', 'profiles', '.active'), 'work\n', 'utf-8');

    const profiles = await listProfiles();
    const work = profiles.find((p) => p.name === 'work');
    expect(work).toBeTruthy();
    expect(work?.active).toBe(true);
    expect(work?.model).toBe('anthropic/claude-opus-4.8');
    expect(work?.tools).toBe(3);
    expect(work?.skills).toBe(2);
    // dir is realpath'd (macOS /var -> /private/var), so compare by suffix.
    expect(work?.dir?.endsWith(join('profiles', 'work'))).toBe(true);
    expect(typeof work?.updatedAt).toBe('number');
  });

  it('OMITS stats (no fabricated zeros) for a profile with no config yet', async () => {
    await mkdir(join(home, '.darhai', 'profiles', 'empty'), { recursive: true });
    const profiles = await listProfiles();
    const empty = profiles.find((p) => p.name === 'empty');
    expect(empty).toBeTruthy();
    expect(empty?.model).toBeUndefined();
    expect(empty?.tools).toBeUndefined();
    expect(empty?.skills).toBeUndefined();
    expect(empty?.updatedAt).toBeUndefined();
  });

  it('always lists the implicit default profile', async () => {
    const profiles = await listProfiles();
    expect(profiles.some((p) => p.name === 'default')).toBe(true);
  });
});
