/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide {@link OmnirouteRuntimeManager} singleton, wired to production
 * collaborators. Mirrors cookbookServeSingleton.
 *
 * There is nothing to "start" on boot - the manager is inert until the user
 * presses "Install & run OmniRoute for me" in the Settings card. It MUST be torn
 * down in before-quit (`stopAll`) so the spawned OmniRoute (Next.js) server is
 * killed and the port is released.
 *
 * Runtime resolution (best-effort, graceful): prefer the bundled bun, else fall
 * back to a system npm/node on PATH. If neither is present, install() surfaces a
 * `needsRuntime` status and the card shows a "install Node.js" hint - it never
 * crashes.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { app, shell } from 'electron';
import { ipcBridge } from '@/common';
import {
  getBundledBunDir,
  getBunGlobalBinDir,
  getEnhancedEnv,
  getWindowsShellExecutionOptions,
} from '@process/utils/shellEnv';
import { resolveOnPath, type ChildProcessLike } from '@process/services/cookbook/LocalServeManager';
import { killProcessTree, killProcessTreeSync } from './killProcessTree';
import { OmnirouteRuntimeManager, type OmnirouteSpawnOptions } from './OmnirouteRuntimeManager';

/** GET a URL with a short timeout; true on 2xx. */
async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Absolute path of the bundled bun binary, or null when unavailable. */
function bundledBunPath(): string | null {
  const dir = getBundledBunDir();
  if (!dir) return null;
  return path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun');
}

/**
 * Extra absolute paths a global `omniroute` bin may live at. bun's `add -g`
 * drops bins into ~/.bun/bin; npm's `install -g` lands on PATH (resolved
 * separately). Windows shims carry `.cmd` / `.exe` / `.bunx` extensions.
 */
function omnirouteBinCandidates(): string[] {
  const bunBin = getBunGlobalBinDir();
  const names =
    process.platform === 'win32' ? ['omniroute.exe', 'omniroute.cmd', 'omniroute.bunx', 'omniroute'] : ['omniroute'];
  return names.map((n) => path.join(bunBin, n));
}

export const omnirouteRuntime = new OmnirouteRuntimeManager({
  spawn: (cmd: string, args: string[], opts: OmnirouteSpawnOptions): ChildProcessLike =>
    nodeSpawn(cmd, args, {
      stdio: opts.stdio,
      env: opts.env,
      ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
      ...(opts.windowsHide !== undefined ? { windowsHide: opts.windowsHide } : {}),
      // POSIX process group, so killProcessTree can signal the server's forks.
      ...(opts.detached !== undefined ? { detached: opts.detached } : {}),
    }) as unknown as ChildProcessLike,
  healthProbe: probeUrl,
  openUrl: (url: string) => shell.openExternal(url),
  env: () => getEnhancedEnv() as Record<string, string>,
  bundledBunPath,
  resolveCommandPath: (cmd) => resolveOnPath(cmd),
  omnirouteBinCandidates,
  readyTimeoutMs: 30000,
  spawnShellOptions: () => getWindowsShellExecutionOptions(),
  killTree: killProcessTree,
  onStatus: (status) => ipcBridge.omnirouteGateway.onRuntimeStatus.emit(status),
  onProgress: (progress) => ipcBridge.omnirouteGateway.onInstallProgress.emit(progress),
});

/** Set once so a repeated bridge init cannot stack quit handlers. */
let quitReaperRegistered = false;

/**
 * Register the BLOCKING quit reaper (idempotent; called from the gateway bridge
 * init, which runs exactly once per app start).
 *
 * The app-level cleanup bundle in `src/index.ts` awaits `omnirouteRuntime
 * .stopAll()` from an async `before-quit` handler - but Electron does not await
 * those handlers. Measured on this build: `[Darhai] before-quit` -> 23ms ->
 * `[Darhai] will-quit`, Electron pid gone, and `netstat` still showing
 * `127.0.0.1:20128 LISTENING` held by the OmniRoute tree. The async path is
 * still the right one for an ordinary stop; this is the guarantee that quitting
 * Darhai cannot leave a server behind, and it deliberately runs synchronously
 * so the quit sequence cannot cut it short.
 */
export function registerOmnirouteQuitReaper(): void {
  if (quitReaperRegistered) return;
  quitReaperRegistered = true;
  app.on('before-quit', () => {
    omnirouteRuntime.reapOnQuitSync((pid) => {
      const outcome = killProcessTreeSync(pid);
      if (!outcome.ok) console.error('[omnirouteGateway] quit reaper failed:', outcome.detail);
    });
  });
}
