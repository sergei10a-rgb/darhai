/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * MECHANICAL GUARD: the build output must contain every builtin MCP stdio
 * script the app advertises, and each one must actually start.
 *
 * The regression this exists to catch shipped once already. `electron-vite
 * build` registered `scripts/build-mcp-servers.js` only in development mode, so
 * `npm run package` produced an `out/main/` with no `builtin-mcp-*.js` in it -
 * while `initStorage.ensureBuiltinMcpServers()` still seeded `mcp.config` with
 * absolute paths into that directory and handed them to every agent in
 * `session/new`. Two of those servers are enabled by default, so every agent
 * spawn died with MODULE_NOT_FOUND and the per-turn advert told the model to
 * call a `darhai_search_skills` tool that could never exist.
 *
 * `mcpScriptDir.test.ts` cannot catch this: under vitest the resolver's
 * `__dirname` is the SOURCE directory, not `out/main`, so every assertion there
 * is necessarily branch-conditional. This file checks the real build output at
 * a path derived from the repo root, and asserts unconditionally.
 *
 * Skip rule: when `out/main/index.js` is absent no build has run at all (fresh
 * clone, or the CI unit-test shards which do not build), and there is nothing
 * to check. The moment a build exists, a missing script is a hard failure.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MCP_STDIO_SCRIPT_NAMES } from '../../../../src/process/utils/mcpScriptDir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const OUT_MAIN = path.join(REPO_ROOT, 'out/main');
const MAIN_BUNDLE = path.join(OUT_MAIN, 'index.js');

/** True once `electron-vite build` (or dev) has produced a main bundle. */
const hasBuild = fs.existsSync(MAIN_BUNDLE);

/**
 * Env that lets the two TCP-bridge scripts register their tools. They exit
 * immediately without their port/token, which is correct behaviour but would
 * hide a genuine load failure behind the same exit code.
 */
const BRIDGE_ENV = {
  TEAM_MCP_PORT: '59999',
  TEAM_MCP_TOKEN: 'guard-token',
  TEAM_AGENT_SLOT_ID: 'guard-slot',
  AION_MCP_PORT: '59999',
  AION_MCP_TOKEN: 'guard-token',
  AION_MCP_BACKEND: 'claude',
} as const;

type HandshakeResult = { tools: string[]; serverName: string };

/**
 * Speak real MCP over stdio to a built script: `initialize`, then `tools/list`.
 * Rejects with the child's stderr so a MODULE_NOT_FOUND is reported verbatim.
 */
function handshake(scriptPath: string, timeoutMs = 30_000): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', ...BRIDGE_ENV },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let serverName = '';

    const done = (err: Error | null, value?: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(value as HandshakeResult);
    };

    const timer = setTimeout(
      () => done(new Error(`${path.basename(scriptPath)}: no MCP response within ${timeoutMs}ms. stderr: ${stderr}`)),
      timeoutMs
    );

    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => done(new Error(`${path.basename(scriptPath)}: spawn failed: ${e.message}`)));
    child.on('exit', (code) =>
      done(new Error(`${path.basename(scriptPath)}: exited with code ${code} before answering. stderr: ${stderr}`))
    );

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      let nl = stdout.indexOf('\n');
      while (nl >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        nl = stdout.indexOf('\n');
        if (!line) continue;

        let msg: { id?: number; result?: Record<string, never>; error?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        const result = msg.result as { serverInfo?: { name?: string }; tools?: Array<{ name: string }> } | undefined;

        if (msg.id === 1 && result) {
          // serverInfo only ever arrives on the initialize result.
          serverName = result.serverInfo?.name ?? '';
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        } else if (msg.id === 2) {
          if (!result?.tools) {
            done(new Error(`${path.basename(scriptPath)}: tools/list failed: ${JSON.stringify(msg.error)}`));
            return;
          }
          done(null, { tools: result.tools.map((t) => t.name), serverName });
          return;
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'darhai-mcp-guard', version: '1.0.0' },
        },
      })}\n`
    );
  });
}

describe.skipIf(!hasBuild)('builtin MCP scripts are present in the build output', () => {
  it('emits every advertised MCP stdio script into out/main', () => {
    const missing = MCP_STDIO_SCRIPT_NAMES.filter((name) => !fs.existsSync(path.join(OUT_MAIN, name)));
    const dirContents = fs.readdirSync(OUT_MAIN).toSorted().join(', ');

    expect(
      missing,
      `out/main/index.js exists, so a build ran - but it did not emit ${missing.join(', ')}. ` +
        `initStorage seeds mcp.config with absolute paths to these files and hands them to every ` +
        `agent in session/new, so a missing script is a dead tool registration, not a warning. ` +
        `Dir contents: ${dirContents}. Fix: node scripts/build-mcp-servers.js`
    ).toEqual([]);
  });

  it('emits non-empty bundles (a 0-byte file spawns and registers nothing)', () => {
    const empty = MCP_STDIO_SCRIPT_NAMES.filter((name) => {
      const file = path.join(OUT_MAIN, name);
      return fs.existsSync(file) && fs.statSync(file).size === 0;
    });
    expect(empty).toEqual([]);
  });
});

describe.skipIf(!hasBuild)('builtin MCP scripts actually start and register tools', () => {
  for (const name of MCP_STDIO_SCRIPT_NAMES) {
    it(`${name} answers initialize + tools/list with at least one tool`, async () => {
      const result = await handshake(path.join(OUT_MAIN, name));
      expect(result.serverName.length).toBeGreaterThan(0);
      expect(result.tools.length).toBeGreaterThan(0);
    }, 45_000);
  }
});
