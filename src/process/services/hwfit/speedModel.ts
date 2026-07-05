/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token-throughput (tok/s) model.
 *
 * Pure port of Odysseus' fit.py _estimate_speed: a memory-bandwidth model that
 * blends GPU VRAM bandwidth with system-RAM bandwidth when part of the model
 * offloads to CPU. Calibrated against measured rigs (see comments in the
 * reference); re-implemented in TypeScript, no Python wrapped.
 */

import type { CatalogModel, HardwareBackend, RunMode } from './types';
import { QUANT_BYTES_PER_PARAM, QUANT_SPEED_MULT, activeParamsB, tableLookup } from './quantTables';

/** Peak memory bandwidth (GB/s) keyed by a GPU-name substring. */
export const GPU_BANDWIDTH: Readonly<Record<string, number>> = {
  '5090': 1792,
  '5080': 960,
  '5070 ti': 896,
  '5070': 672,
  '5060 ti': 448,
  '5060': 256,
  '4090': 1008,
  '4080 super': 736,
  '4080': 717,
  '4070 ti super': 672,
  '4070 ti': 504,
  '4070 super': 504,
  '4070': 504,
  '4060 ti': 288,
  '4060': 272,
  '3090 ti': 1008,
  '3090': 936,
  '3080 ti': 912,
  '3080': 760,
  '3070 ti': 608,
  '3070': 448,
  '3060 ti': 448,
  '3060': 360,
  '2080 ti': 616,
  '2080 super': 496,
  '2080': 448,
  '2070 super': 448,
  '2070': 448,
  '2060 super': 448,
  '2060': 336,
  '1660 ti': 288,
  '1660 super': 336,
  '1660': 192,
  '1650 super': 192,
  '1650': 128,
  'h100 sxm': 3350,
  h100: 2039,
  h200: 4800,
  'a100 sxm': 2039,
  a100: 1555,
  l40s: 864,
  l40: 864,
  l4: 300,
  a10g: 600,
  a10: 600,
  t4: 320,
  'v100 sxm': 900,
  v100: 897,
  a6000: 768,
  a5000: 768,
  a4000: 448,
  '7900 xtx': 960,
  '7900 xt': 800,
  '7900 gre': 576,
  '7800 xt': 624,
  '7700 xt': 432,
  '7600': 288,
  '6950 xt': 576,
  '6900 xt': 512,
  '6800 xt': 512,
  '6800': 512,
  '6700 xt': 384,
  '6600 xt': 256,
  '6600': 224,
  mi300x: 5300,
  mi300: 5300,
  mi250x: 3277,
  mi250: 3277,
  mi210: 1638,
  mi100: 1229,
  '9070 xt': 624,
  '9070': 488,
  '9060 xt': 322,
  '9060': 322,
  // Apple Silicon unified-memory bandwidth (GB/s), keyed off the chip name.
  'm1 ultra': 800,
  'm1 max': 400,
  'm1 pro': 200,
  m1: 68,
  'm2 ultra': 800,
  'm2 max': 400,
  'm2 pro': 200,
  m2: 100,
  'm3 ultra': 800,
  'm3 max': 300,
  'm3 pro': 150,
  m3: 100,
  'm4 max': 546,
  'm4 pro': 273,
  m4: 120,
  'm5 max': 546,
  'm5 pro': 273,
  m5: 150,
};

// Keys sorted longest-first so "m4 max" matches before "m4".
const BW_KEYS_SORTED = Object.keys(GPU_BANDWIDTH).toSorted((a, b) => b.length - a.length);

/** Fallback per-param throughput constant (tok/s * B) when no GPU bandwidth. */
const FALLBACK_K: Readonly<Record<HardwareBackend, number>> = {
  cuda: 220,
  rocm: 180,
  metal: 150,
  cpu_x86: 70,
  cpu_arm: 90,
};

const DEFAULT_BYTES_PER_PARAM = 0.5;
const GPU_EFFICIENCY = 0.55;
/** Conservative dual-channel DDR4-3200 system bandwidth (GB/s). */
const CPU_BANDWIDTH = 55.0;
const MOE_SPEED_FACTOR = 0.8;

/** Look up a GPU's memory bandwidth by matching a substring of its name. */
export function lookupBandwidth(gpuName: string | null | undefined): number | null {
  if (!gpuName) return null;
  const gn = gpuName.toLowerCase();
  for (const key of BW_KEYS_SORTED) {
    if (gn.includes(key)) return GPU_BANDWIDTH[key];
  }
  return null;
}

/** Minimal system view the speed model reads (subset of HardwareProfile). */
export type SpeedSystem = {
  gpuName: string | null;
  backend: HardwareBackend;
};

/**
 * Estimate tok/s. Uses active params for MoE. `offloadFrac` (0..1) is the
 * fraction of weights spilled to system RAM; the effective bandwidth is a
 * harmonic blend so the slow CPU portion dominates as it grows.
 */
export function estimateSpeed(
  model: CatalogModel,
  quant: string,
  runMode: RunMode,
  system: SpeedSystem,
  offloadFrac = 0.0
): number {
  const pb = activeParamsB(model);
  const isMoe = Boolean(model.isMoe);
  const bw = lookupBandwidth(system.gpuName);
  const backend = system.backend ?? 'cpu_x86';

  if (bw && (runMode === 'gpu' || runMode === 'cpu_offload')) {
    const bpp = tableLookup(QUANT_BYTES_PER_PARAM, quant, DEFAULT_BYTES_PER_PARAM);
    const modelGb = pb * bpp;
    if (modelGb <= 0) return 0;

    if (runMode === 'cpu_offload') {
      let frac = Math.min(Math.max(offloadFrac, 0), 1);
      // Legacy callers pass 0 with cpu_offload: assume a meaningful spill so
      // we do not overestimate.
      if (frac <= 0) frac = 0.5;
      const effBw = 1 / (frac / CPU_BANDWIDTH + (1 - frac) / bw);
      const rawTps = (effBw / modelGb) * GPU_EFFICIENCY;
      return rawTps * (isMoe ? MOE_SPEED_FACTOR : 1);
    }
    // Fully on GPU.
    const rawTps = (bw / modelGb) * GPU_EFFICIENCY;
    return rawTps * (isMoe ? MOE_SPEED_FACTOR : 1);
  }

  const k = tableLookup(FALLBACK_K, backend, 70);
  if (pb <= 0) return 0;
  const sm = tableLookup(QUANT_SPEED_MULT, quant, 1.0);
  return (k / pb) * sm;
}
