/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pick a runtime that can execute the bundled builtin-MCP stdio scripts.
 *
 * Why this exists
 * ---------------
 * Every builtin MCP server was registered with `command: 'node'`, resolved from
 * the user's PATH. That is a development assumption: a desktop user installs an
 * .exe, not a JavaScript toolchain. On a machine without Node.js the whole
 * builtin layer dies at spawn - calendar, notes, documents, memory, the skill
 * library search, news, email (including the confirmation gate) and Cal.com all
 * fail with a transport error the user cannot act on.
 *
 * Why not Electron-as-Node
 * -----------------------
 * The obvious fix - spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1` - is
 * dead code in a shipped build. `scripts/afterPack.js` (SEC-ELEC-05) turns the
 * Electron RunAsNode fuse OFF, so a packaged binary ignores that variable and
 * boots a second Darhai GUI instead, which then loses the single-instance lock
 * and quits. It would only ever work in a dev checkout - where Node.js is
 * present by definition, since that is what runs the dev server. So the branch
 * cannot help the users who need it, and carrying it would mean merging an env
 * var into eight call sites to buy nothing. `resolveIjfwNodeRuntime` documents
 * the same fuse discovery; it keeps the branch because it is reached only in
 * dev, but there is no reason to copy it here.
 *
 * The order
 * ---------
 *  1. The bundled `bun` binary. A real, fuse-independent runtime with a writable
 *     stdin - which the JSON-RPC stdio transport requires - and it runs these
 *     pure-JS entries correctly. This is the path a shipped install takes.
 *  2. `node` from PATH. Reached by a dev checkout with no staged bundle, and by
 *     a packaged build whose bun bundle is missing for this platform/arch. This
 *     is exactly the old behaviour, so the change can only add working setups,
 *     never take one away.
 */

import * as path from 'node:path';
import { getBundledBunDir } from '@process/utils/shellEnv';

export type BuiltinMcpRuntime = {
  /** Executable to put in the stdio transport's `command`. */
  command: string;
};

export function resolveBuiltinMcpRuntime(): BuiltinMcpRuntime {
  const bunDir = getBundledBunDir();
  if (bunDir) {
    return { command: path.join(bunDir, process.platform === 'win32' ? 'bun.exe' : 'bun') };
  }
  return { command: 'node' };
}

/**
 * Is this stored `command` one WE wrote, rather than one the user set?
 *
 * Registration refreshes builtin rows in place, and the guard that permits it
 * used to be `command === 'node'` - true of every row, because that was the only
 * command we ever wrote. Now a row can legitimately hold a bun path, and an app
 * update or a move can leave that path stale. This recognises the shapes we
 * produce and nothing else, so a user who deliberately points a builtin server
 * at their own runtime keeps it.
 *
 * @param command - the `command` currently stored on the server's transport
 */
export function isManagedBuiltinMcpCommand(command: string | undefined): boolean {
  if (!command) return false;
  if (command === 'node') return true; // legacy rows, written before this module
  const base = path.basename(command).toLowerCase();
  return base === 'bun' || base === 'bun.exe';
}
