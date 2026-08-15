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
import path from 'node:path';
import { ipcBridge } from '@/common';
import { CookbookServeService } from './CookbookServeService';
import { ModelDownloadManager } from './ModelDownloadManager';
import { LocalServeManager } from './LocalServeManager';
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

export const cookbookServe = new CookbookServeService({
  downloadManager: new ModelDownloadManager(),
  serveManager: new LocalServeManager({ llamaServerCandidates: managedLlamaServers }),
  getCatalog: () => getCatalog(),
  getRepo: () => getModelRegistryRepository() as CookbookRegistryRepo | null,
  getGgufDir: ggufDir,
  getHardware: detectedHardware,
  probeOllama: probeOllamaDaemon,
  onProgress: (p) => ipcBridge.cookbook.onDownloadProgress.emit(p),
  onStatus: (s) => ipcBridge.cookbook.onServeStatus.emit(s),
});
