/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide {@link CookbookServeService} singleton, wired to production
 * collaborators. Mirrors calendarServiceSingleton / noteServiceSingleton.
 *
 * There is nothing to "start" on boot (no scanner) - the service is inert until
 * the user triggers a download or serve from the Model Advisor. It MUST be torn
 * down in before-quit (`stopAll`) so a spawned llama-server is killed and the
 * GPU is released.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ipcBridge } from '@/common';
import { CookbookServeService } from './CookbookServeService';
import { ModelDownloadManager } from './ModelDownloadManager';
import { LocalServeManager } from './LocalServeManager';
import { MoeOffloadCalibrator } from './moeCalibration';
import type { CookbookRegistryRepo } from './cookbookProviderRegistration';
import { getCatalog, scanHardware } from '@process/services/hwfit';
import type { HardwareProfile } from '@process/services/hwfit';
import { llamaServerCandidates } from '@process/services/llamacpp';
import { getModelRegistryRepository } from '@process/providers/ipc/modelRegistryIpc';

/** Directory verified GGUF downloads live in (`userData/models/gguf`). */
function ggufDir(): string {
  return path.join(app.getPath('userData'), 'models', 'gguf');
}

/**
 * Absolute paths of Darhai's OWN `llama-server`, newest release first.
 *
 * This is the production wiring for `LocalServeManager`'s
 * `llamaServerCandidates` dep, whose default is `() => []`. Without it the
 * manager could only find a binary the user had put on PATH by hand, so
 * `detectAvailability()` reported `llamaServer: false` on a machine where only
 * Darhai was installed and the whole serve flow fell through to printing a
 * shell command. Read fresh on every call - `llamaRuntime.install` can drop a
 * binary in mid-session and the very next serve attempt must see it. Still
 * `[]` when nothing is installed, so the degraded path is unchanged.
 */
function managedLlamaServers(): string[] {
  return llamaServerCandidates(app.getPath('userData'));
}

/**
 * The detected hardware profile (OS + GPU vendor + VRAM). Drives the
 * hardware-adaptive backend selection and the `-ngl` heuristic.
 */
function detectedHardware(): Promise<HardwareProfile> {
  return scanHardware(false);
}

/** Probe the local Ollama daemon `/api/tags` for post-pull registration. */
async function probeOllamaDaemon(): Promise<{ running: boolean; models: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    if (!res.ok) return { running: false, models: [] };
    const body = (await res.json()) as unknown;
    const raw = body && typeof body === 'object' ? (body as { models?: unknown }).models : undefined;
    if (!Array.isArray(raw)) return { running: true, models: [] };
    const models = raw
      .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

const serveManager = new LocalServeManager({ llamaServerCandidates: managedLlamaServers });

/** Both spellings, because the managed dir and a hand install differ only by OS. */
const LLAMA_BENCH_BINARIES = ['llama-bench.exe', 'llama-bench'] as const;

/**
 * The `llama-bench` that ships BESIDE the resolved `llama-server` - same
 * release, same acceleration, so what it measures is what the serve will run.
 * Verified against the managed b10441 install on the reference machine: the
 * archive carries `llama-bench.exe` next to `llama-server.exe`. Null when the
 * resolved server has no bench sibling (or no server resolves at all), which
 * the calibrator answers with its measured all-layers fallback.
 */
function resolveBenchBinary(): string | null {
  const server = serveManager.resolveLlamaServer();
  if (!server) return null;
  const dir = path.dirname(server);
  for (const name of LLAMA_BENCH_BINARIES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const moeCalibrator = new MoeOffloadCalibrator({
  userDataDir: () => app.getPath('userData'),
  resolveBenchBinary,
});

export const cookbookServe = new CookbookServeService({
  downloadManager: new ModelDownloadManager(),
  serveManager,
  getCatalog: () => getCatalog(),
  getRepo: () => getModelRegistryRepository() as CookbookRegistryRepo | null,
  getGgufDir: ggufDir,
  getHardware: detectedHardware,
  probeOllama: probeOllamaDaemon,
  planNCpuMoe: (req) => moeCalibrator.resolveNCpuMoe(req),
  // Both stop paths (stopServe + before-quit stopAll) pull this so a running
  // llama-bench dies with the serve instead of outliving the app on Windows.
  cancelCalibration: () => {
    moeCalibrator.cancel();
  },
  onProgress: (p) => ipcBridge.cookbook.onDownloadProgress.emit(p),
  onStatus: (s) => ipcBridge.cookbook.onServeStatus.emit(s),
});
