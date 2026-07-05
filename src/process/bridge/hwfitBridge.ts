/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the hardware-fit model advisor ("Загвар зөвлөмж" / Cookbook).
 *
 * Read-only surface: scan hardware + rank the bundled catalog. No model
 * download or serve orchestration is exposed here (deliberately out of scope).
 * The process-side hwfit types are structurally identical to the shared
 * `common/types/hwfit` shapes, so results cross the boundary unchanged.
 */

import { ipcBridge } from '@/common';
import { rankCatalog, scanHardware, getCatalogSize } from '@process/services/hwfit';
import type { HardwareProfile, RankOptions } from '@process/services/hwfit';
import type {
  HwfitBackend,
  HwfitGpu,
  HwfitHardware,
  HwfitPlatform,
  HwfitRankOptions,
  HwfitSortKey,
  HwfitUseCase,
} from '@/common/types/hwfit';

// --- Boundary validation ---------------------------------------------------
// A remote (paired-device WebSocket) caller is denied hwfit entirely (see
// bridgeAllowlist REMOTE_DENIED_KEYS), but the local renderer contract is still
// untrusted input crossing a process boundary. Clamp/validate every field here
// so a malformed or hostile override can never inject NaN/Infinity/negative
// values into the ranker's memory + speed math (which would silently poison the
// fit estimate) or blow the result limit.

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_STRING_LEN = 256;
const MAX_GPUS = 64;

/** Finite, non-negative number or a default (rejects NaN/Infinity/negatives). */
function safeNonNegNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A trimmed string capped at {@link MAX_STRING_LEN}, or undefined. */
function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, MAX_STRING_LEN);
}

const VALID_BACKENDS: ReadonlySet<HwfitBackend> = new Set(['cuda', 'rocm', 'metal', 'cpu_x86', 'cpu_arm']);
const VALID_PLATFORMS: ReadonlySet<HwfitPlatform> = new Set(['windows', 'linux', 'macos', 'unknown']);
const VALID_USE_CASES: ReadonlySet<HwfitUseCase> = new Set([
  'general',
  'coding',
  'reasoning',
  'chat',
  'multimodal',
  'embedding',
  'tts',
  'stt',
]);
const VALID_SORTS: ReadonlySet<HwfitSortKey> = new Set(['score', 'speed', 'vram', 'params', 'context', 'newest']);

function safeBackend(value: unknown): HwfitBackend {
  return typeof value === 'string' && VALID_BACKENDS.has(value as HwfitBackend) ? (value as HwfitBackend) : 'cpu_x86';
}

function safePlatform(value: unknown): HwfitPlatform {
  return typeof value === 'string' && VALID_PLATFORMS.has(value as HwfitPlatform)
    ? (value as HwfitPlatform)
    : 'unknown';
}

/** Sanitize the detected-GPU list (bounded length, clamped numbers). */
function safeGpus(value: unknown): HwfitGpu[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_GPUS).map((g, i) => {
    const gpu = (g && typeof g === 'object' ? g : {}) as Partial<HwfitGpu>;
    return {
      index: Math.max(0, Math.trunc(safeNonNegNumber(gpu.index, i))),
      name: safeString(gpu.name) ?? 'unknown',
      vramGb: safeNonNegNumber(gpu.vramGb, 0),
    };
  });
}

/**
 * Validate + clamp a renderer-supplied hardware override into the process-side
 * profile. Every numeric field is coerced to a finite, non-negative value so
 * the ranker never sees NaN/Infinity/negative memory budgets.
 */
function toProfile(override: HwfitHardware): HardwareProfile {
  const gpuVram = typeof override.gpuVramGb === 'number' && Number.isFinite(override.gpuVramGb) && override.gpuVramGb >= 0
    ? override.gpuVramGb
    : null;
  return {
    totalRamGb: safeNonNegNumber(override.totalRamGb, 0),
    availableRamGb: safeNonNegNumber(override.availableRamGb, 0),
    cpuCores: Math.max(0, Math.trunc(safeNonNegNumber(override.cpuCores, 0))),
    cpuName: safeString(override.cpuName) ?? 'unknown',
    hasGpu: Boolean(override.hasGpu),
    gpuName: safeString(override.gpuName) ?? null,
    gpuVramGb: gpuVram,
    gpuCount: Math.max(0, Math.trunc(safeNonNegNumber(override.gpuCount, 0))),
    gpus: safeGpus(override.gpus),
    backend: safeBackend(override.backend),
    platform: safePlatform(override.platform),
    gpuFamily: safeString(override.gpuFamily),
    unifiedMemory: override.unifiedMemory === undefined ? undefined : Boolean(override.unifiedMemory),
    gpuError: safeString(override.gpuError) ?? null,
    gpuOnly: override.gpuOnly === undefined ? undefined : Boolean(override.gpuOnly),
  };
}

/** Clamp a limit into [1, MAX_LIMIT], defaulting when absent/invalid. */
function safeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/** Map + validate the shared rank options into process-side options. */
function toRankOptions(opts: HwfitRankOptions): RankOptions {
  const targetContext =
    typeof opts.targetContext === 'number' && Number.isFinite(opts.targetContext) && opts.targetContext > 0
      ? Math.trunc(opts.targetContext)
      : 0;
  return {
    useCase: VALID_USE_CASES.has(opts.useCase as HwfitUseCase) ? opts.useCase : undefined,
    limit: safeLimit(opts.limit),
    search: safeString(opts.search),
    sort: VALID_SORTS.has(opts.sort as HwfitSortKey) ? opts.sort : undefined,
    quant: safeString(opts.quant),
    targetContext,
    fitOnly: Boolean(opts.fitOnly),
  };
}

/** Initialize hwfit IPC bridge handlers. */
export function initHwfitBridge(): void {
  ipcBridge.hwfit.scanHardware.provider(async (params) => {
    const fresh = params && typeof params === 'object' ? Boolean(params.fresh) : false;
    return scanHardware(fresh);
  });

  ipcBridge.hwfit.rankModels.provider(async (params) => {
    const opts: HwfitRankOptions = params && typeof params === 'object' ? params : {};
    // A simulated-rig override skips the probe entirely; otherwise score
    // against the detected (cached) hardware.
    const system = opts.hardwareOverride ? toProfile(opts.hardwareOverride) : await scanHardware(false);
    return rankCatalog(system, toRankOptions(opts));
  });

  ipcBridge.hwfit.catalogSize.provider(async () => {
    return getCatalogSize();
  });
}
