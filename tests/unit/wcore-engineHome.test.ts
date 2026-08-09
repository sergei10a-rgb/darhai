/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's config-root contract, measured against the REAL binary.
 *
 * Why this file exists: `envBuilder` used to export `DARHAI_HOME` as the
 * per-profile config root. The bundled engine has never read that name - it
 * reads `WAYLAND_HOME` - so every profile silently resolved to the one native
 * config dir and shared its config.toml, memory.db and skills. That is exactly
 * the cross-contamination `ProfileIsolationError` was written to prevent, and
 * the existing profile tests stayed green through all of it because they only
 * ever exercised the TypeScript mirror against itself.
 *
 * So these tests ask the binary. `nativeConfigDir()` claims to mirror the
 * engine's `wayland_config_dir()` precedence; here each branch of that claim is
 * checked against what `wayland-core --config-path` actually prints. If the
 * engine is rebranded or its precedence changes, this fails instead of drifting.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveWCoreBinary } from '@process/agent/wcore/binaryResolver';
import { buildEngineSpawnEnv } from '@process/agent/wcore/envBuilder';
import { nativeConfigDir } from '@process/agent/wcore/profilePaths';

const BINARY = resolveWCoreBinary();

/** Env names this suite controls; anything left over would skew a branch. */
const HOME_VARS = ['WAYLAND_HOME', 'DARHAI_HOME', 'XDG_DATA_HOME'] as const;

/**
 * Run `wayland-core --config-path` with ONLY the given home vars set, and
 * return the config DIRECTORY it resolved to.
 */
function engineConfigDir(overrides: Partial<Record<(typeof HOME_VARS)[number], string>>): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of HOME_VARS) delete env[name];
  Object.assign(env, overrides);

  const out = execFileSync(BINARY!, ['--config-path'], { encoding: 'utf-8', env, timeout: 20_000 }).trim();
  return dirname(out);
}

/** Same question, asked of the TypeScript mirror. */
function mirrorConfigDir(overrides: Partial<Record<(typeof HOME_VARS)[number], string>>): string {
  const saved = HOME_VARS.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of HOME_VARS) delete process.env[name];
    Object.assign(process.env, overrides);
    return nativeConfigDir();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Windows paths come back with mixed separators - the engine prints the env
 * value verbatim (forward slashes) and appends its own `\config.toml`. Compare
 * on a normalised, case-folded form so a separator difference is not read as a
 * behavioural difference.
 */
const norm = (p: string): string =>
  p
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();

describe.skipIf(!BINARY)('engine config root - measured against the bundled binary', () => {
  let scratch: string;
  let other: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'wcore-home-'));
    other = await mkdtemp(join(tmpdir(), 'wcore-xdg-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await rm(other, { recursive: true, force: true }).catch(() => {});
  });

  it('honours WAYLAND_HOME as the LITERAL config dir', () => {
    expect(norm(engineConfigDir({ WAYLAND_HOME: scratch }))).toBe(norm(scratch));
  });

  /**
   * The regression guard. `DARHAI_HOME` is our own brand name and the engine
   * has never heard of it; asserting that it does NOTHING is what stops the
   * rebrand from being re-applied to a load-bearing variable.
   */
  it('IGNORES DARHAI_HOME - the engine binary is upstream and knows only its own name', () => {
    expect(norm(engineConfigDir({ DARHAI_HOME: scratch }))).not.toBe(norm(scratch));
    expect(norm(engineConfigDir({ DARHAI_HOME: scratch }))).toBe(norm(engineConfigDir({})));
  });

  it('falls back to XDG_DATA_HOME/wayland-core when WAYLAND_HOME is unset', () => {
    expect(norm(engineConfigDir({ XDG_DATA_HOME: other }))).toBe(norm(join(other, 'wayland-core')));
  });

  it('prefers WAYLAND_HOME over XDG_DATA_HOME', () => {
    expect(norm(engineConfigDir({ WAYLAND_HOME: scratch, XDG_DATA_HOME: other }))).toBe(norm(scratch));
  });

  describe('nativeConfigDir mirrors that precedence exactly', () => {
    /** Both sides answer the same question under the same env. */
    const agree = (overrides: Partial<Record<(typeof HOME_VARS)[number], string>>): void => {
      expect(norm(mirrorConfigDir(overrides))).toBe(norm(engineConfigDir(overrides)));
    };

    it('agrees on the WAYLAND_HOME branch', () => agree({ WAYLAND_HOME: scratch, XDG_DATA_HOME: other }));
    it('agrees on the XDG_DATA_HOME branch', () => agree({ XDG_DATA_HOME: other }));
    it('agrees on the platform-default branch', () => agree({}));
  });
});

describe('buildEngineSpawnEnv exports the name the engine actually reads', () => {
  it('sets WAYLAND_HOME to the resolved profile dir', () => {
    const env = buildEngineSpawnEnv({ providerEnv: {}, waylandHome: '/tmp/profile-x' });
    expect(env.WAYLAND_HOME).toBe('/tmp/profile-x');
  });

  it('does not set the dead DARHAI_HOME name', () => {
    const env = buildEngineSpawnEnv({ providerEnv: {}, waylandHome: '/tmp/profile-x' });
    expect(env.DARHAI_HOME).toBeUndefined();
  });

  it('sets nothing when no profile dir was resolved', () => {
    const env = buildEngineSpawnEnv({ providerEnv: {} });
    expect(env.WAYLAND_HOME).toBeUndefined();
  });

  /**
   * WAYLAND_HOME must NOT be inheritable from the user's shell. It is absent
   * from ENGINE_ENV_ALLOWLIST on purpose: an exported value would apply on
   * every spawn where profile resolution set nothing, quietly pointing all
   * profiles at one config tree - the same failure, arriving by another door.
   */
  it('never inherits WAYLAND_HOME from process.env', () => {
    const saved = process.env.WAYLAND_HOME;
    try {
      process.env.WAYLAND_HOME = '/tmp/from-the-users-shell';
      expect(buildEngineSpawnEnv({ providerEnv: {} }).WAYLAND_HOME).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.WAYLAND_HOME;
      else process.env.WAYLAND_HOME = saved;
    }
  });

  it('the resolved profile dir wins over an inherited one', () => {
    const saved = process.env.WAYLAND_HOME;
    try {
      process.env.WAYLAND_HOME = '/tmp/from-the-users-shell';
      const env = buildEngineSpawnEnv({ providerEnv: {}, waylandHome: '/tmp/profile-x' });
      expect(env.WAYLAND_HOME).toBe('/tmp/profile-x');
    } finally {
      if (saved === undefined) delete process.env.WAYLAND_HOME;
      else process.env.WAYLAND_HOME = saved;
    }
  });
});
