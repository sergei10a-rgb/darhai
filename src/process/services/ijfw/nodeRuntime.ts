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
import { getPlatformServices } from '@/common/platform';
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
  // No bun bundle. In a dev checkout that is expected, and Electron-as-Node
  // works there because the fuse is applied at pack time. In a PACKAGED build it
  // means the bundle is missing for this platform/arch - most plausibly x64
  // without AVX2 and no staged `-baseline` build - and there the fuse is OFF, so
  // this branch would not run the script at all: it would boot a second Darhai
  // GUI, which loses the single-instance lock and quits. `node` from PATH fails
  // cleanly on a machine without Node.js instead of opening a window nobody
  // asked for.
  if (isPackagedBuild()) {
    return { command: 'node', prefixArgs: [], env: buildChildEnv(extraEnv) };
  }

  return {
    command: process.execPath,
    prefixArgs: [],
    env: buildChildEnv({ ...extraEnv, ELECTRON_RUN_AS_NODE: '1' }),
  };
}

/**
 * Is this a packaged build?
 *
 * Defaults to NOT packaged when platform services are unavailable, because that
 * is what being unable to answer actually means here: the only callers without
 * them are tests and tooling, never a shipped app. Guessing "packaged" there
 * would send them down the PATH branch and change behaviour nothing asked to
 * change.
 */
function isPackagedBuild(): boolean {
  try {
    return getPlatformServices().paths.isPackaged();
  } catch {
    return false;
  }
}
