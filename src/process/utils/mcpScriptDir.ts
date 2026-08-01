/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolve the directory containing the bundled MCP stdio scripts.
 *
 * Background
 * ----------
 * Nine stdio scripts are spawned as external `node` child processes:
 *   - team-mcp-stdio.js          (team coordination tools)
 *   - team-guide-mcp-stdio.js    (solo aion_* tools)
 *   - builtin-mcp-image-gen.js   (image generation)
 *   - builtin-mcp-search-skills.js (skills library)
 *   - builtin-mcp-web-search.js  (web search)
 *   - builtin-mcp-personal-data.js (calendar / notes / documents / memory)
 *   - builtin-mcp-news.js        (RSS / Atom feeds + Hacker News)
 *   - builtin-mcp-imap.js        (email: read + save draft, never send)
 *   - builtin-mcp-cal-com.js     (Cal.com scheduling, read-only)
 *
 * `scripts/build-mcp-servers.js` emits them next to the main bundle:
 *   - dev:      <project>/app/out/main/
 *   - packaged: <resources>/app.asar.unpacked/out/main/
 *
 * Reliable resolution
 * -------------------
 * The previous resolvers (`resolveMcpScriptDir` in tcpHelpers.ts and
 * `getBuiltinMcpBaseDir` in initStorage.ts) trusted runtime hints that proved
 * unreliable in dev:
 *   - `app.getAppPath()` returned `.../app/out/main` in dev with electron-vite,
 *     so `path.join(appPath, 'out', 'main')` produced a doubled path
 *     `.../app/out/main/out/main/` that didn't exist. Every `team_*` tool
 *     silently failed to register because the stdio child died with
 *     MODULE_NOT_FOUND.
 *   - `require.main?.filename` can be a launcher script, not the main bundle,
 *     so its dirname is not the bundle dir.
 *
 * The one hint that is *guaranteed* correct after bundling is `__dirname` of
 * the bundle file. esbuild/electron-vite preserve it literally so the value at
 * runtime is the directory the file is loaded from - i.e. `out/main/` for
 * `index.js`, or `out/main/chunks/` for code-split chunks. This module is
 * itself bundled into `out/main/index.js` so its `__dirname` is the answer we
 * want (with the chunks carve-out).
 *
 * Packaged mode
 * -------------
 * In packaged builds the bundle is loaded from inside `app.asar`. External
 * `node` processes cannot read from ASAR, so we redirect the dir to
 * `app.asar.unpacked` (which `electron-builder` configures via `asarUnpack`).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Names of every stdio script that must exist next to the main bundle.
 * Used by both the resolver (no validation cost) and the startup canary
 * (`assertMcpScriptsExist`), so adding a script in one place doesn't drift
 * out of sync with the other.
 */
export const MCP_STDIO_SCRIPT_NAMES = [
  'team-mcp-stdio.js',
  'team-guide-mcp-stdio.js',
  'builtin-mcp-image-gen.js',
  'builtin-mcp-search-skills.js',
  'builtin-mcp-web-search.js',
  'builtin-mcp-personal-data.js',
  'builtin-mcp-news.js',
  'builtin-mcp-imap.js',
  'builtin-mcp-cal-com.js',
] as const;

export type McpStdioScriptName = (typeof MCP_STDIO_SCRIPT_NAMES)[number];

/**
 * Every script name this app may hand to an external `node` process.
 *
 * There used to be a second list here for "bundled @darhai" servers built from
 * a sibling `waylandmcp` repo. That repo exists nowhere - not in a checkout,
 * not on npm, not in upstream CI - so the two servers it was supposed to
 * provide (`imap`, `cal-com`) were advertised in the catalog and never once
 * shipped. Both are now built from source in this repository, so one list is
 * enough and there is nothing left to drift against.
 */
const SPAWNABLE_SCRIPT_NAMES: ReadonlySet<string> = new Set<string>(MCP_STDIO_SCRIPT_NAMES);

/**
 * Resolve the directory containing the bundled MCP stdio scripts.
 *
 * Returns:
 *   - dev:      `<project>/app/out/main`
 *   - packaged: `<resources>/app.asar.unpacked/out/main`
 *
 * Never throws - pure path computation. Use `assertMcpScriptsExist()` at
 * startup if you want a fail-loud check that the resolved dir actually
 * contains the expected scripts.
 */
export function resolveMcpScriptDir(): string {
  // __dirname after bundling = the directory the bundle file is loaded from.
  // For the main bundle this is `out/main/`; for code-split chunks it's
  // `out/main/chunks/`. The carve-out drops back to `out/main/`.
  const dir = path.basename(__dirname) === 'chunks' ? path.dirname(__dirname) : __dirname;
  // In packaged builds the bundle lives inside `app.asar` (read-only, no
  // child-process spawn possible). Scripts are unpacked to a sibling
  // `app.asar.unpacked/` directory by `asarUnpack` in electron-builder.
  // The substring is unambiguous because `app.asar` always appears with
  // surrounding directory separators when present.
  return dir.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

/**
 * Build an absolute path to a specific MCP stdio script.
 * Convenience wrapper around `resolveMcpScriptDir()`.
 */
export function getMcpScriptPath(scriptName: McpStdioScriptName | string): string {
  return path.join(resolveMcpScriptDir(), scriptName);
}

/**
 * Rewrite the argv of a bundled MCP stdio spawn so it points at a file that
 * actually exists on this machine.
 *
 * Two failure modes this closes, both observed in the field:
 *
 *  1. **Bare filename.** Catalog entries for bundled servers store
 *     `{ command: 'node', args: ['builtin-mcp-imap.js'] }`. Only the
 *     Test-connection dialog used to expand that to an absolute path, so
 *     "Test connection" passed while the real agent spawned the bare name from
 *     its own cwd and failed.
 *  2. **Stale absolute path.** Builtin entries are persisted with an absolute
 *     path into `out/main/`. After the app moves (dev tree -> installed
 *     app, or an update that relocates Resources) the stored path is dead. If
 *     the basename is one we ship, re-resolve it against the current bundle
 *     dir instead of handing an agent a path to nothing.
 *
 * Anything else is passed through untouched - user-added servers keep exactly
 * the argv the user configured.
 */
export function resolveBuiltinMcpSpawnArgs(command: string | undefined, args: readonly string[] | undefined): string[] {
  const raw = args ? [...args] : [];
  if (command !== 'node') return raw;

  const first = raw[0];
  if (typeof first !== 'string' || first.length === 0) return raw;

  // Case 1: bare bundled filename (no directory component at all). Catalog
  // entries persist exactly this, so it must resolve against the bundle dir and
  // never against whatever cwd the agent happens to have.
  const isBare = !first.includes('/') && !first.includes('\\');
  if (isBare && SPAWNABLE_SCRIPT_NAMES.has(first)) {
    return [getMcpScriptPath(first), ...raw.slice(1)];
  }

  // Case 2: a path to one of our scripts that no longer exists there.
  const base = path.basename(first);
  if (!SPAWNABLE_SCRIPT_NAMES.has(base)) return raw;
  if (fs.existsSync(first)) return raw;

  return [getMcpScriptPath(base), ...raw.slice(1)];
}

export type McpScriptCanaryResult = {
  ok: boolean;
  dir: string;
  presentScripts: readonly string[];
  missingScripts: readonly string[];
  dirContents: readonly string[];
  message: string;
};

/**
 * Inspect the resolved MCP script dir and report which expected scripts are
 * present vs. missing. Pure data - does not throw. Use as the foundation for
 * a startup check (`assertMcpScriptsExist`).
 */
export function inspectMcpScripts(): McpScriptCanaryResult {
  const dir = resolveMcpScriptDir();
  const missing: string[] = [];
  const present: string[] = [];
  for (const name of MCP_STDIO_SCRIPT_NAMES) {
    if (fs.existsSync(path.join(dir, name))) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }
  let dirContents: string[] = [];
  try {
    dirContents = fs.readdirSync(dir).toSorted();
  } catch {
    dirContents = ['<unreadable>'];
  }
  if (missing.length === 0) {
    return {
      ok: true,
      dir,
      presentScripts: present,
      missingScripts: missing,
      dirContents,
      message: `All ${present.length} MCP stdio scripts present at ${dir}`,
    };
  }
  const message =
    `MCP stdio scripts missing at resolved dir.\n` +
    `  Resolved dir: ${dir}\n` +
    `  Missing:      ${missing.join(', ')}\n` +
    `  Present:      ${present.length > 0 ? present.join(', ') : '(none)'}\n` +
    `  Dir contents: ${dirContents.length > 0 ? dirContents.join(', ') : '(empty)'}\n` +
    `Run 'node scripts/build-mcp-servers.js' to rebuild them.`;
  return {
    ok: false,
    dir,
    missingScripts: missing,
    presentScripts: present,
    dirContents,
    message,
  };
}

/**
 * Startup canary: throws if any expected MCP stdio script is missing.
 *
 * Why throw vs warn: silent absence of these scripts produces the worst
 * possible UX - the leader's role prompt advertises `team_*` tools, the
 * Gemini worker logs `injected team MCP server`, but the spawned MCP child
 * crashes immediately with MODULE_NOT_FOUND and registers zero tools. The
 * leader then truthfully reports "team_* tools missing" and zero specialist
 * dispatch occurs. Failing loud at startup beats failing mute at first send.
 */
export function assertMcpScriptsExist(): void {
  const result = inspectMcpScripts();
  if (!result.ok) {
    throw new Error(result.message);
  }
}
