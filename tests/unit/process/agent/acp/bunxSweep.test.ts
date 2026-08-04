/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A half-extracted bunx cache used to break the ACP agent permanently.
 *
 * Recovery could only act on a directory whose path bun happened to print in
 * stderr. The failure it exists for prints none: a partial extraction stops at
 * `error: Cannot find module 'zod/v4'` with no path at all. So nothing was
 * deleted, the single retry never fired, and every later launch hit the same
 * broken directory - the agent was dead until the user found and removed the
 * temp folder by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const { state } = vi.hoisted(() => ({
  state: {
    tmp: '',
    // Read from the environment, not from `os.tmpdir()`: the mock below replaces
    // that for every importer in this file, including these tests, so calling it
    // here would create the scratch directory inside the previous scratch
    // directory's name.
    realTmp: process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp',
  },
}));

// Point the sweep at a scratch directory. It deletes what it matches, so it must
// never be aimed at the machine's real temp dir during a test run.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, tmpdir: () => state.tmp }, tmpdir: () => state.tmp };
});

const { clearBunxWorkingDirsForPackage } = await import('@process/agent/acp/acpConnectors');

const PACKAGE = '@zed-industries/claude-agent-acp@0.21.0';

/** Create a directory under the scratch tmpdir with one file inside. */
function makeDir(name: string): string {
  const dir = path.join(state.tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'marker'), 'x');
  return dir;
}

beforeEach(() => {
  state.tmp = mkdtempSync(path.join(state.realTmp, 'darhai-bunx-test-'));
});

afterEach(() => {
  rmSync(state.tmp, { recursive: true, force: true });
});

describe('clearBunxWorkingDirsForPackage', () => {
  it('removes the package working dir when stderr carried no path', () => {
    const victim = makeDir('bunx-501-@zed-industries');

    const removed = clearBunxWorkingDirsForPackage(PACKAGE);

    expect(removed).toEqual([victim]);
    expect(existsSync(victim)).toBe(false);
  });

  it('removes every stale generation, not just one', () => {
    // bun keys the directory on uid or timestamp, so a machine accumulates
    // several. Leaving one behind means the next launch can still land on it.
    const a = makeDir('bunx-501-@zed-industries');
    const b = makeDir('bunx-1743022513-@zed-industries');

    const removed = clearBunxWorkingDirsForPackage(PACKAGE);

    expect(removed.sort()).toEqual([a, b].sort());
  });

  it('leaves another package alone', () => {
    const mine = makeDir('bunx-501-@zed-industries');
    const theirs = makeDir('bunx-501-@openai');

    clearBunxWorkingDirsForPackage(PACKAGE);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs), 'swept a directory belonging to a different package').toBe(true);
  });

  it('touches nothing that is not a bunx working dir', () => {
    // The sweep runs against the OS temp directory, which holds other people's
    // data. It must match only what bun itself creates.
    const innocent = [
      makeDir('my-important-work'),
      makeDir('@zed-industries'),
      makeDir('bunx-@zed-industries'),
      makeDir('prefix-bunx-501-@zed-industries'),
      makeDir('bunx-501-@zed-industries-extra'),
    ];

    clearBunxWorkingDirsForPackage(PACKAGE);

    for (const dir of innocent) {
      expect(existsSync(dir), `swept an unrelated directory: ${dir}`).toBe(true);
    }
  });

  it('handles an unscoped package', () => {
    const victim = makeDir('bunx-501-some-agent');
    const removed = clearBunxWorkingDirsForPackage('some-agent@1.2.3');
    expect(removed).toEqual([victim]);
  });

  it('returns empty rather than throwing when there is nothing to sweep', () => {
    expect(clearBunxWorkingDirsForPackage(PACKAGE)).toEqual([]);
    expect(clearBunxWorkingDirsForPackage('')).toEqual([]);
  });
});
