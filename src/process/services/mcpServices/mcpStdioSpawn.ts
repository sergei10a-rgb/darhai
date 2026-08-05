/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveBuiltinMcpSpawnArgs } from '@process/utils/mcpScriptDir';
import { normalizeNpxArgsForBundledBun, resolveNpxPath } from '@process/utils/shellEnv';

export type McpStdioSpawn = { command: string; args: string[] };

/**
 * Turn a stored MCP stdio transport into a command that can actually be spawned.
 *
 * "Green, but no tools." A catalog-installed MCP server persists a bare runtime
 * hint - the literal string `npx` - as its transport command. The connection
 * TEST path already rewrote that to the bundled Bun runtime (`bun x --bun <pkg>`)
 * before spawning, which is why the Library badge went green. Every SESSION
 * path forwarded the raw `npx` instead. On Windows a bare `npx` is `npx.cmd`,
 * which does not resolve through `CreateProcess`/PATHEXT for a `shell: false`
 * spawn - and the engine's Rust `std::process::Command` will not shim it either.
 * So the server never started in the live session and contributed zero tools,
 * with a green badge sitting next to it and no error anywhere.
 *
 * WINDOWS-ONLY, deliberately. A bare `npx` resolves fine through `execvp`/PATH
 * on macOS and Linux, so rewriting there would change working behaviour for no
 * reason - and worse, it would bake an absolute bundled-Bun path into the
 * PERSISTED engine `config.toml`. On a Linux AppImage `resources` remounts at a
 * new temp path every launch while `config.toml` is rewritten only when settings
 * change, so that path would go stale and ENOENT. The Windows install path is
 * stable (perMachine), so a resolved path is durable there.
 *
 * Bundled-script resolution runs for every platform: that fixes a bare filename
 * or a stale absolute path left behind when the app moved.
 *
 * `resolveNpx` and `platform` are injected so the decision is testable without a
 * bundled Bun on disk or a real Windows host.
 */
export function resolveMcpStdioSpawn(
  command: string,
  args: readonly string[] = [],
  resolveNpx: () => string = () => resolveNpxPath({}),
  platform: NodeJS.Platform = process.platform
): McpStdioSpawn {
  if (command === 'npx' && platform === 'win32') {
    // `bun x` understands `-p`/`--package`, so multi-bin npx forms pass through.
    // `-y` / `--yes` / `--prefer-offline` are npx-only and are dropped.
    return { command: resolveNpx(), args: ['x', '--bun', ...normalizeNpxArgsForBundledBun([...args])] };
  }
  return { command, args: resolveBuiltinMcpSpawnArgs(command, args) };
}
