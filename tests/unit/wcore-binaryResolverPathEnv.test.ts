/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which PATH the Core binary lookup is allowed to search.
 *
 * WHY THIS EXISTS. `resolveWCoreBinary()` answers two questions that must not
 * disagree: `AgentRegistry.createWCoreAgent().available` ("is a Core engine
 * installed", asked once at boot) and `WCoreAgent.start()` ("give me the path",
 * asked when the user opens a chat). Step 3 of the resolver used to spawn
 * `where`/`which` with no `env`, i.e. against the raw `process.env.PATH`.
 *
 * On a GUI launch that PATH has no login-shell entries yet: `src/index.ts`
 * merges them in later and asynchronously, AFTER boot-time detection has run.
 * So an engine installed under e.g. ~/.local/bin resolved to `null` at
 * detection time - cached for the whole session, since only a hub install
 * re-runs `refreshBuiltinAgents()` - while `start()` found it minutes later and
 * chatted happily. The Agents page sat there saying the engine was not
 * installed while it demonstrably was.
 *
 * The fix is to search the same enhanced env `AcpDetector` builds for its CLI
 * probes, so the answer stops depending on boot ordering. These tests pin that:
 * the spawn must carry the enhanced env, and an engine reachable ONLY through
 * it must be found.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A directory that exists only in the login shell's PATH, never in process.env. */
const SHELL_ONLY_DIR = '/shell-only/bin';
const FOUND = `${SHELL_ONLY_DIR}/wayland-core`;

const execFileSync = vi.fn<(cmd: string, args: string[], opts: { env?: Record<string, string> }) => string>();
vi.mock('node:child_process', () => ({
  execFileSync: (cmd: string, args: string[], opts: { env?: Record<string, string> }) => execFileSync(cmd, args, opts),
}));

/**
 * Only the resolved binary "exists", so resolver steps 1 and 2 (bundled and
 * dev-tree lookups) miss and the PATH branch under test is the one that runs.
 */
vi.mock('node:fs', () => ({ existsSync: (p: string) => p === FOUND }));

const getEnhancedEnv = vi.fn<() => Record<string, string>>();
vi.mock('@process/utils/shellEnv', () => ({ getEnhancedEnv: () => getEnhancedEnv() }));

import { resolveWCoreBinary } from '@process/agent/wcore/binaryResolver';

/** The lookup tool the resolver picks for this platform. */
const FINDER = process.platform === 'win32' ? 'where' : 'which';

describe('resolveWCoreBinary - the PATH it searches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnhancedEnv.mockReturnValue({ PATH: SHELL_ONLY_DIR, DARHAI_TEST_MARKER: 'enhanced' });
    execFileSync.mockReturnValue(`${FOUND}\n`);
  });

  it('passes the enhanced env to the PATH lookup instead of inheriting the raw one', () => {
    expect(resolveWCoreBinary()).toBe(FOUND);

    expect(execFileSync).toHaveBeenCalledWith(
      FINDER,
      ['wayland-core'],
      expect.objectContaining({ env: expect.objectContaining({ DARHAI_TEST_MARKER: 'enhanced' }) })
    );
  });

  it('finds an engine that is reachable ONLY through the login-shell PATH', () => {
    // The boot-ordering case in prose: the binary is on the shell PATH and
    // nowhere in `process.env.PATH`, which is what a GUI launch looks like
    // before `loadShellEnvironmentAsync()` has merged anything in.
    execFileSync.mockImplementation((_cmd, _args, opts) => {
      const searched = opts?.env?.PATH ?? '';
      if (searched.includes(SHELL_ONLY_DIR)) return `${FOUND}\n`;
      throw new Error('INFO: Could not find files for the given pattern(s).');
    });

    expect(resolveWCoreBinary()).toBe(FOUND);
  });

  it('still reports null when the enhanced PATH does not have it either', () => {
    // The guard must not turn "not installed" into a false positive: an honest
    // miss is the whole point of the `available: false` this feeds.
    execFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(resolveWCoreBinary()).toBeNull();
  });

  it('tries every binary-name candidate against that same env', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    resolveWCoreBinary();

    // `wayland-core` first, then the `wcore` convenience name - both searched
    // with the enhanced env, so a symlinked install is not env-dependent either.
    const names = execFileSync.mock.calls.map((call) => call[1][0]);
    expect(names).toEqual(['wayland-core', 'wcore']);
    for (const call of execFileSync.mock.calls) {
      expect(call[2].env?.DARHAI_TEST_MARKER).toBe('enhanced');
    }
  });
});
