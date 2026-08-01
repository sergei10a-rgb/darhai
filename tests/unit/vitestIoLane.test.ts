/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guard for the `io` vitest project (see `tests/osResourceTests.ts`).
 *
 * A test that binds a loopback socket cannot be trusted while 23 sibling forks
 * are saturating the host: measured on this repo, `tests/integration/
 * team-stress-tcp.test.ts` failed all 17 of its tests with
 * `connect ETIMEDOUT 127.0.0.1:<port>` in one run and passed completely in the
 * next, on the same commit. The fix is the serialised `io` project - but a
 * hand-maintained file list rots the moment someone adds a new socket test, and
 * the symptom is an intermittent failure weeks later rather than an error now.
 *
 * So the list is checked mechanically instead of remembered.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { OS_RESOURCE_TESTS } from '../osResourceTests';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_ROOTS = ['tests/unit', 'tests/integration', 'tests/regression'];

/**
 * Source markers that mean "this file really binds a listening socket".
 *
 * Deliberately narrow. `new TeamMcpServer(...)` alone does NOT qualify - the
 * constructor binds nothing, and `tests/unit/process/team/teamDescribeAssistant
 * .test.ts` builds one purely to reach a private method - so the MCP-server
 * marker additionally requires a `.start()` call, which is what opens the port.
 */
const DIRECT_BIND = /net\.createServer\(|http\.createServer\(|\.listen\(0,/;
const MCP_SERVER_CTOR = /new (TeamMcpServer|AionMcpServer|TeamGuideMcpServer)\(/;
const MCP_SERVER_START = /\.start\(\)/;

function listTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(test|e2e)\.tsx?$/.test(entry.name) || /^test_.*\.ts$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const root of SEARCH_ROOTS) walk(path.join(REPO_ROOT, root));
  return found.sort();
}

function bindsASocket(relativePath: string): boolean {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  if (DIRECT_BIND.test(source)) return true;
  return MCP_SERVER_CTOR.test(source) && MCP_SERVER_START.test(source);
}

describe('io test lane', () => {
  it('lists only files that still exist', () => {
    const missing = OS_RESOURCE_TESTS.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    expect(missing, 'OS_RESOURCE_TESTS entries that no longer exist - a renamed file silently stops running').toEqual(
      []
    );
  });

  it('covers every test file that binds a listening socket', () => {
    const listed = new Set(OS_RESOURCE_TESTS);
    const unlisted = listTestFiles()
      .filter((rel) => !listed.has(rel))
      .filter((rel) => rel !== 'tests/unit/vitestIoLane.test.ts')
      .filter(bindsASocket);

    expect(
      unlisted,
      'These tests bind a real socket but run in the parallel lane, where a loopback ' +
        'connect can time out under full-suite load. Add them to tests/osResourceTests.ts.'
    ).toEqual([]);
  });
});
