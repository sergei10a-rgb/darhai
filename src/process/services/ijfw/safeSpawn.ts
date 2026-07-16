/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * IJFW safe spawn wrapper - the ONLY entry point under
 * src/process/services/ijfw/** that may import child_process. Resolves npm/npx
 * via trusted paths instead of bare PATH lookup (SEC-007), and forwards a
 * filtered child env via buildChildEnv (R-P04).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveIjfwNodeRuntime } from './nodeRuntime';

export type Cmd = 'npm' | 'npx' | 'node';

export interface SafeSpawnOptions {
  cmd: Cmd;
  args: string[];
  extraEnv?: Record<string, string>;
  cwd?: string;
}

let trustedNpmCache: string | null = null;
let resolverOverride: (() => Promise<string>) | null = null;

/**
 * Test-only: inject a custom resolver. Pass null to restore the default
 * resolution chain. The function is exported with a `__` prefix to make its
 * test-only intent explicit.
 */
export function __setTrustedNpmCliResolver(fn: (() => Promise<string>) | null): void {
  resolverOverride = fn;
  trustedNpmCache = null;
}

async function defaultResolveTrustedNpm(): Promise<string> {
  const isWin = process.platform === 'win32';
  // SEC-007: resolve via known absolute install locations, NOT bare PATH.
  const candidates = [
    path.join(path.dirname(process.execPath), '..', 'libnode', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  ];
  if (isWin) {
    // The Node.js Windows installer (and the nvm-windows symlink) place npm at
    // <ProgramFiles>\nodejs\node_modules\npm; a per-user global prefix lives
    // under %APPDATA%\npm. These are absolute, admin/user-controlled paths -
    // still not a bare PATH lookup, so SEC-007's intent is preserved.
    const npmRel = ['node_modules', 'npm', 'bin', 'npm-cli.js'];
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'nodejs', ...npmRel), path.join(programFilesX86, 'nodejs', ...npmRel));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', ...npmRel));
  }
  for (const candidate of candidates) {
    try {
      const real = await fs.promises.realpath(candidate);
      const stat = await fs.promises.lstat(real);
      // Unix permission hardening (SEC-007). Windows fs.Stats has no comparable
      // uid/mode semantics (a normal file reports the world-writable bit), so
      // these checks would reject every valid Windows npm; the absolute
      // ProgramFiles path is the trust anchor there instead.
      if (!isWin) {
        // Reject world-writable npm CLIs.
        if ((stat.mode & 0o002) !== 0) continue;
        // Reject CLIs owned by anyone other than current uid (where applicable).
        const currentUid = process.getuid?.();
        if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) continue;
      }
      return real;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not resolve trusted npm');
}

async function resolveTrustedNpmCli(): Promise<string> {
  if (trustedNpmCache) return trustedNpmCache;
  const resolver = resolverOverride ?? defaultResolveTrustedNpm;
  const resolved = await resolver();
  trustedNpmCache = resolved;
  return resolved;
}

export async function safeSpawn(opts: SafeSpawnOptions): Promise<ChildProcess> {
  // The JS entry to run under the resolved Node runtime. `node` runs the script
  // directly; `npm`/`npx` run the trusted CLI shim (SEC-007 absolute path).
  let jsArgs: string[];
  if (opts.cmd === 'node') {
    jsArgs = [...opts.args];
  } else if (opts.cmd === 'npm') {
    const npmCli = await resolveTrustedNpmCli();
    jsArgs = [npmCli, ...opts.args];
  } else {
    const npmCli = await resolveTrustedNpmCli();
    const npxCli = path.join(path.dirname(npmCli), 'npx-cli.js');
    jsArgs = [npxCli, ...opts.args];
  }

  // Bundled bun in packaged builds (RunAsNode fuse makes Electron-as-Node
  // unusable there); Electron-as-Node in dev. buildChildEnv is applied inside.
  const rt = resolveIjfwNodeRuntime(opts.extraEnv);

  return spawn(rt.command, [...rt.prefixArgs, ...jsArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: rt.env,
  });
}
