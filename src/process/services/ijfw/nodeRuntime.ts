/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Resolve a runtime that can execute the IJFW mcp-server JS entry as Node.
 *
 * Packaged binaries have the Electron RunAsNode fuse turned OFF (scripts/
 * afterPack.js, SEC-ELEC-05), so `spawn(process.execPath, [entry], {env:
 * {ELECTRON_RUN_AS_NODE:'1'}})` no longer runs as Node in a shipped build - the
 * fuse makes the binary ignore ELECTRON_RUN_AS_NODE and boot a second Darhai
 * GUI instance instead (which then loses the single-instance lock and quits).
 *
 * The bundled `bun` binary is a real, fuse-independent runtime with full stdio
 * (including a writable stdin, required by the JSON-RPC transport), and it runs
 * the pure-JS mcp-server correctly. Prefer it whenever the bundle is present.
 * When it is absent (a dev checkout without a staged bundle) fall back to
 * Electron-as-Node, which still works there because the fuse is only applied to
 * packaged binaries.
 */

import * as path from 'node:path';
import { getBundledBunDir } from '@process/utils/shellEnv';
import { buildChildEnv } from './envAllowlist';

export type IjfwNodeRuntime = {
  /** Executable to spawn (bun binary, or the Electron binary in dev). */
  command: string;
  /** Args to prepend before the script path (empty for both current runtimes). */
  prefixArgs: string[];
  /** Filtered child env (adds ELECTRON_RUN_AS_NODE only on the Electron path). */
  env: ReturnType<typeof buildChildEnv>;
};

export function resolveIjfwNodeRuntime(extraEnv: Record<string, string> = {}): IjfwNodeRuntime {
  const bunDir = getBundledBunDir();
  if (bunDir) {
    const bun = path.join(bunDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
    return { command: bun, prefixArgs: [], env: buildChildEnv(extraEnv) };
  }
  return {
    command: process.execPath,
    prefixArgs: [],
    env: buildChildEnv({ ...extraEnv, ELECTRON_RUN_AS_NODE: '1' }),
  };
}
