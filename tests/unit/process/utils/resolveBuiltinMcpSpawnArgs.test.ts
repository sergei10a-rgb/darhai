/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one place that decides what argv reaches a spawned MCP server.
 *
 * Two production bugs live in this function's absence:
 *   - Catalog entries for bundled servers store a BARE filename
 *     (`builtin-mcp-imap.js`). Only the Test-connection dialog expanded it,
 *     so "Test connection" passed while the real agent spawned the bare name
 *     from its own cwd and failed.
 *   - Builtin entries persist an ABSOLUTE path into `out/main/`. When the app
 *     moves (dev tree -> installed build), that path is dead and the agent gets
 *     a MODULE_NOT_FOUND on every turn.
 *
 * The bare-filename cases below used to name `.mjs` bundles that were supposed
 * to come from a sibling `waylandmcp` repo. That repo exists nowhere, so those
 * two servers were advertised and never shipped; both are now built from source
 * in this repository as ordinary `.js` members of MCP_STDIO_SCRIPT_NAMES.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  resolveBuiltinMcpSpawnArgs,
  getMcpScriptPath,
  resolveMcpScriptDir,
} from '../../../../src/process/utils/mcpScriptDir';

describe('resolveBuiltinMcpSpawnArgs', () => {
  it('expands a bare bundled filename to an absolute path', () => {
    expect(resolveBuiltinMcpSpawnArgs('node', ['builtin-mcp-cal-com.js'])).toEqual([
      getMcpScriptPath('builtin-mcp-cal-com.js'),
    ]);
  });

  it('expands the bare news script name the catalog entry ships', () => {
    // Every bundled server is now built from our own source, so they all live
    // in MCP_STDIO_SCRIPT_NAMES. The catalog entry stores the bare filename, so
    // the expansion has to cover it - a regression here means an installed News
    // MCP spawns `node builtin-mcp-news.js` from the agent's cwd and dies.
    expect(resolveBuiltinMcpSpawnArgs('node', ['builtin-mcp-news.js'])).toEqual([
      getMcpScriptPath('builtin-mcp-news.js'),
    ]);
  });

  it('keeps trailing arguments when expanding a bare filename', () => {
    expect(resolveBuiltinMcpSpawnArgs('node', ['builtin-mcp-imap.js', '--verbose'])).toEqual([
      getMcpScriptPath('builtin-mcp-imap.js'),
      '--verbose',
    ]);
  });

  it('re-points a stale absolute path to one of our scripts at the current bundle dir', () => {
    const stale = path.join(path.sep, 'previous', 'install', 'out', 'main', 'builtin-mcp-search-skills.js');
    expect(resolveBuiltinMcpSpawnArgs('node', [stale])).toEqual([getMcpScriptPath('builtin-mcp-search-skills.js')]);
  });

  it('leaves an existing path untouched', () => {
    // This module's own source file is guaranteed to exist wherever the test
    // runs, so it stands in for a script that is where the config says it is.
    const real = path.join(resolveMcpScriptDir(), 'mcpScriptDir.ts');
    expect(resolveBuiltinMcpSpawnArgs('node', [real])).toEqual([real]);
  });

  it('never touches a user-configured server', () => {
    expect(resolveBuiltinMcpSpawnArgs('npx', ['-y', 'chrome-devtools-mcp@latest'])).toEqual([
      '-y',
      'chrome-devtools-mcp@latest',
    ]);
    expect(resolveBuiltinMcpSpawnArgs('node', ['/somewhere/my-own-server.js'])).toEqual([
      '/somewhere/my-own-server.js',
    ]);
  });

  it('tolerates missing or empty argv', () => {
    expect(resolveBuiltinMcpSpawnArgs('node', undefined)).toEqual([]);
    expect(resolveBuiltinMcpSpawnArgs('node', [])).toEqual([]);
    expect(resolveBuiltinMcpSpawnArgs(undefined, ['builtin-mcp-cal-com.js'])).toEqual(['builtin-mcp-cal-com.js']);
  });

  it('returns a fresh array (callers must not mutate stored config)', () => {
    const args = ['-y', 'some-server'];
    const result = resolveBuiltinMcpSpawnArgs('npx', args);
    expect(result).not.toBe(args);
  });
});
