/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// profilePaths derives the profiles root from os.homedir(); point homedir at a
// scratch dir so the tests never touch the real ~/.darhai.
let home: string;
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

import {
  DEFAULT_PROFILE,
  getActiveProfile,
  nativeConfigDir,
  profilesRoot,
  ProfileIsolationError,
  resolveActiveConfigDir,
  resolveActiveConfigPath,
  resolveProfileDir,
} from '@process/agent/wcore/profilePaths';

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wcore-home-'));
  delete process.env.DARHAI_HOME;
  delete process.env.XDG_DATA_HOME;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

/** Write the active-profile marker directly (bypassing the IPC store). */
async function setActive(name: string): Promise<void> {
  const root = profilesRoot();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '.active'), `${name}\n`, 'utf-8');
}

describe('nativeConfigDir - mirrors engine wayland_config_dir precedence', () => {
  it('honors DARHAI_HOME as the literal config dir', () => {
    process.env.DARHAI_HOME = '/tmp/wh';
    expect(nativeConfigDir()).toBe('/tmp/wh');
  });

  it('falls back to XDG_DATA_HOME/wayland-core', () => {
    process.env.XDG_DATA_HOME = '/tmp/xdg';
    expect(nativeConfigDir()).toBe(join('/tmp/xdg', 'wayland-core'));
  });
});

describe('resolveActiveConfigDir - the default<->named fork', () => {
  it('default profile resolves to the NATIVE config dir (backward compatible)', async () => {
    // No marker => default. Native dir derives from platform config base, not
    // the profiles root, so it must NOT be under ~/.darhai/profiles.
    const dir = await resolveActiveConfigDir();
    expect(dir).not.toContain(join('.darhai', 'profiles'));
    expect(await getActiveProfile()).toBe(DEFAULT_PROFILE);
  });

  it('an explicit "default" marker still resolves to the native dir', async () => {
    await setActive('default');
    const dir = await resolveActiveConfigDir();
    expect(dir).toBe(nativeConfigDir());
  });

  it('a named profile resolves to its isolated dir under the profiles root', async () => {
    await setActive('client-work');
    const dir = await resolveActiveConfigDir();
    // resolveProfileDir realpaths the root (so /var -> /private/var on macOS);
    // compare against that same realpath'd source of truth, and assert the
    // profile-name segment is present.
    expect(dir).toBe(await resolveProfileDir('client-work'));
    expect(dir.endsWith(join('profiles', 'client-work'))).toBe(true);
  });

  it('resolveActiveConfigPath points at the active profile config.toml', async () => {
    await setActive('research');
    const path = await resolveActiveConfigPath();
    expect(path).toBe(join(await resolveProfileDir('research'), 'config.toml'));
    expect(path.endsWith(join('profiles', 'research', 'config.toml'))).toBe(true);
  });

  it('a corrupt/invalid marker falls back to default (native dir)', async () => {
    await setActive('../../etc'); // fails the name regex => getActiveProfile => default
    const dir = await resolveActiveConfigDir();
    expect(dir).toBe(nativeConfigDir());
  });

  /**
   * A named profile that cannot be resolved must be a hard stop, not a warning.
   *
   * The spawn site used to catch everything here and continue with no config
   * root, which makes the engine fall back to its own default - the DEFAULT
   * profile's config.toml and memory.db. A profile the user made to keep work
   * separate would then write into the profile they were keeping it away from,
   * with nothing to show for it but entries in the wrong place.
   */
  describe('when a named profile cannot be resolved', () => {
    const boom = async (): Promise<string> => {
      throw new Error('EACCES');
    };

    it('throws ProfileIsolationError rather than falling back', async () => {
      await setActive('client-work');

      await expect(resolveActiveConfigDir(boom)).rejects.toBeInstanceOf(ProfileIsolationError);
    });

    it('names the profile it could not resolve, and keeps the cause', async () => {
      await setActive('client-work');

      await expect(resolveActiveConfigDir(boom)).rejects.toMatchObject({ profile: 'client-work' });
      await expect(resolveActiveConfigDir(boom)).rejects.toThrow(/EACCES/);
    });

    it('leaves the default profile alone, which has nothing to isolate from', async () => {
      // Turning a filesystem hiccup into a hard stop here would brick every
      // user who never created a profile at all - and the default profile has
      // no other profile's data to leak into.
      await setActive('default');

      await expect(resolveActiveConfigDir(boom)).resolves.toBe(nativeConfigDir());
    });
  });
});
