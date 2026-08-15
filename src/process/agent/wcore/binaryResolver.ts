/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getEnhancedEnv } from '@process/utils/shellEnv';

/**
 * Binary names to look for, in priority order:
 *  1. `wayland-core`  - primary, written by `prepareWaylandCore.js` and
 *     published by the engine's release workflow.
 *  2. `wcore`         - convenience symlink users may have created.
 */
const BINARY_CANDIDATES: readonly string[] = ['wayland-core', 'wcore'];

function withPlatformExt(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Primary binary name (used for the bundled-resource lookup filename).
 * Iteration over `BINARY_CANDIDATES` happens at the call site for the
 * bundled and PATH searches.
 */
function getBinaryName(): string {
  return withPlatformExt(BINARY_CANDIDATES[0]);
}

function lookupOnPath(name: string): string | null {
  // Use execFileSync (no shell) so the binary-name candidate cannot be
  // interpreted as shell syntax - `BINARY_CANDIDATES` is compile-time
  // constant today but defensive coding prevents future drift.
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    // Search the ENHANCED PATH, the same env `AcpDetector` builds for its own
    // CLI probes, not the raw `process.env`.
    //
    // WHY IT MATTERS: on a GUI launch `process.env.PATH` has no login-shell
    // entries yet. `src/index.ts` merges them in later and ASYNCHRONOUSLY,
    // after boot-time agent detection has already run - so an engine installed
    // under e.g. ~/.local/bin resolved to null at detection time and to a real
    // path once the user actually opened a chat. That gap is precisely how
    // `available: false` could sit on the Agents page for a whole session
    // while Core chats worked. `getEnhancedEnv()` resolves the login-shell PATH
    // itself (module-cached in shellEnv), so the answer no longer depends on
    // boot ordering and matches what `WCoreAgent.start()` will find.
    const result = execFileSync(finder, [name], { encoding: 'utf-8', timeout: 5000, env: getEnhancedEnv() }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // not found in PATH
  }
  return null;
}

/**
 * Resolve the wayland-core engine binary path.
 * Search order:
 *  1. Bundled with app (production resourcesPath) - tries each `BINARY_CANDIDATES` filename.
 *  2. Project-root resources/bundled-wayland-core/ (dev mode) - mirrors the
 *     bundled-bun resolution in shellEnv.ts so `bun start` finds the same
 *     binary the packaged build does.
 *  3. System PATH - tries each `BINARY_CANDIDATES` name in order.
 */
export function resolveWCoreBinary(): string | null {
  const runtimeKey = `${process.platform}-${process.arch}`;

  // 1. Bundled binary (production) - same layout as bundled-bun
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    for (const candidate of BINARY_CANDIDATES) {
      const bundled = join(resourcesPath, 'bundled-wayland-core', runtimeKey, withPlatformExt(candidate));
      if (existsSync(bundled)) return bundled;
    }
  }

  // 2. Dev-mode project-root fallback. In dev, `process.resourcesPath` points
  //    at Electron's own resources dir, not ours - so step 1 misses our
  //    prepared binary. Check project-root resources/ directly.
  for (const candidate of BINARY_CANDIDATES) {
    const devBundled = join(process.cwd(), 'resources', 'bundled-wayland-core', runtimeKey, withPlatformExt(candidate));
    if (existsSync(devBundled)) return devBundled;
  }

  // 3. System PATH - try each candidate in priority order.
  for (const candidate of BINARY_CANDIDATES) {
    const found = lookupOnPath(candidate);
    if (found) return found;
  }

  return null;
}

export function isWCoreAvailable(): boolean {
  return resolveWCoreBinary() !== null;
}

/**
 * Detect wayland-core availability and version for settings UI.
 */
export function detectWCore(): {
  available: boolean;
  version?: string;
  path?: string;
} {
  const binaryPath = resolveWCoreBinary();
  if (!binaryPath) return { available: false };

  try {
    const version = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return { available: true, version, path: binaryPath };
  } catch {
    return { available: true, path: binaryPath };
  }
}

// Internal - exported for tests.
export { BINARY_CANDIDATES, getBinaryName };
