/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Token-throughput (tok/s) model.
 *
 * Started as a port of Odysseus' fit.py _estimate_speed: a memory-bandwidth
 * model that blends GPU VRAM bandwidth with system-RAM bandwidth when part of
 * the model offloads to CPU. The constants are now CALIBRATED against Darhai's
 * own serving path rather than inherited.
 *
 * Reference measurement (RTX 4070 Laptop 8 GB / Ryzen 9 7845HX / 64 GB,
 * llama.cpp b10441, real `llama-server` + `/completion`, decode tok/s from the
 * server's own `timings.predicted_per_second`, warm page cache, MEDIAN of
 * three runs - the first run of a model is disk-bound and reads far low):
 *
 *   model                        run                  measured    was     now
 *   Qwen2.5-0.5B-Instruct Q4_K_M all on GPU     299.4 (272-302)  1122.2  296.9
 *   Qwen2.5-7B-Instruct   Q4_K_M all on GPU      34.0 (32.8-41)    72.8   33.8
 *
 * The two errors that produced 3.8x and 2.1x: mobile GPUs were given their
 * DESKTOP namesake's bandwidth (504 GB/s for a 128-bit part), and the model
 * had no per-token cost, so throughput went to infinity as the model shrank.
 *
 * Run-to-run spread on this machine is real - roughly +-10% when the model is
 * GPU-resident and much wider when it is not - so only the two resident points
 * above are treated as calibration data.
 *
 * // secondary: three measured cases remain uncalibrated because one noisy
 * point is not enough to move a constant that applies to every machine.
 *  - Offloaded layers: `-ngl 15` on the 7B (48% off GPU) measured 17.0 tok/s
 *    (12.0-18.3 over three runs) against 12.2 predicted. CPU_BANDWIDTH below
 *    stays at its conservative DDR4 figure; this rig is DDR5 and implies ~84.
 *  - A model far larger than VRAM: gpt-oss-20b (12.8 GiB on 8 GiB) measured
 *    8.5-20.1 tok/s across runs against ~20 predicted. Dominated by host
 *    paging, so it is not stable enough to fit anything to.
 *  - Pure CPU: the same rig decodes Qwen2.5-7B at 4.99 tok/s with `-ngl 0`
 *    against 10.6 from FALLBACK_K, which is left alone for the same reason.
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
  // 128-bit GDDR7 @ 28 Gbps, the same memory config as the 5060 Ti above.
  // Was 256, which is the previous generation's number.
  '5060': 448,
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
  // --- NVIDIA mobile SKUs -------------------------------------------------
  // A laptop part shares its desktop name but not its memory system, and
  // nvidia-smi reports it as e.g. "NVIDIA GeForce RTX 4070 Laptop GPU". The
  // substring lookup below matched the DESKTOP key, so every laptop was given
  // a bandwidth it does not have - on the reference machine, 504 GB/s for a
  // part with a 128-bit bus. Each value here is bus width x memory data rate
  // / 8; the 4070 Laptop row is additionally consistent with the measured
  // 204.8 GB/s of effective decode bandwidth (80% of 256, see below).
  // Keys must stay longer than their desktop namesake so they win the
  // longest-first match.
  '5090 laptop': 896,
  '5080 laptop': 768,
  '5070 ti laptop': 576,
  '5070 laptop': 384,
  '5060 laptop': 384,
  '5050 laptop': 384,
  '4090 laptop': 576,
  '4080 laptop': 432,
  '4070 laptop': 256,
  '4060 laptop': 256,
  '4050 laptop': 192,
  '3080 ti laptop': 448,
  '3080 laptop': 448,
  '3070 ti laptop': 448,
  '3070 laptop': 448,
  '3060 laptop': 336,
  '3050 ti laptop': 224,
  '3050 laptop': 224,
  // Turing-era mobile parts. The driver reports them as "... with Max-Q
  // Design" (no "Laptop" token), which `lookupBandwidth` normalises to
  // "... max-q" so both driver spellings land here rather than on the desktop
  // key. Values are bus width x Max-Q memory data rate / 8 - the Max-Q SKUs
  // run their memory slower than the identically-named desktop part, which is
  // exactly why matching the desktop key was wrong. Turing mobile parts
  // WITHOUT the Max-Q suffix share the desktop memory config, so the desktop
  // key is already correct for them.
  '2080 super max-q': 352,
  '2080 max-q': 384,
  '2070 super max-q': 352,
  '2070 max-q': 384,
  '2060 max-q': 264,
  '1660 ti max-q': 288,
  '1650 max-q': 128,
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
/**
 * Fraction of peak VRAM bandwidth a single-stream decode actually achieves.
 * Solved (with {@link PER_TOKEN_OVERHEAD_GB}) from the two fully-resident
 * reference medians, 299.4 and 34.0 tok/s against a 256 GB/s part, which give
 * 0.533. That it lands next to the inherited 0.55 is the point: the old value
 * was fine and the 3.8x error was entirely the bandwidth table plus the
 * missing per-token term.
 */
const GPU_EFFICIENCY = 0.53;
/**
 * Conservative dual-channel DDR4-3200 system bandwidth (GB/s), used for the
 * share of the weights that is NOT on the GPU.
 *
 * Left at the inherited value on purpose. The reference rig is DDR5 and its
 * one forced-offload run implies ~84 GB/s, but that run varied 12.0-18.3
 * tok/s across three attempts, and this constant applies to every machine
 * regardless of memory generation. Raising it on that evidence would trade a
 * conservative estimate for a machine-specific one.
 */
const CPU_BANDWIDTH = 55.0;
/**
 * Per-token work that is NOT reading weights - attention over the KV cache,
 * activations, sampling, and the server's own per-token bookkeeping -
 * expressed as the equivalent bytes of memory traffic (GB) so it scales with
 * the device like everything else in this model.
 *
 * Without this term throughput is `bandwidth / modelSize`, which goes to
 * INFINITY as the model shrinks: a 0.5B model was predicted at 1122 tok/s
 * against 299 measured, and a catalog row that understates its size can claim
 * a rate no hardware can produce. Solved together with GPU_EFFICIENCY from the
 * two fully-resident reference medians.
 */
const PER_TOKEN_OVERHEAD_GB = 0.21;
/**
 * Same idea for the no-known-bandwidth fallback below, in params-billions:
 * {@link PER_TOKEN_OVERHEAD_GB} divided by the default bytes-per-param, so a
 * near-zero parameter count cannot divide its way to an impossible rate there
 * either.
 */
const FALLBACK_OVERHEAD_B = PER_TOKEN_OVERHEAD_GB / DEFAULT_BYTES_PER_PARAM;
const MOE_SPEED_FACTOR = 0.8;

/**
 * Look up a GPU's memory bandwidth by matching a substring of its name.
 *
 * Turing mobiles cross nvidia-smi as either "RTX 2080 Super with Max-Q
 * Design" or, on other driver generations, "RTX 2080 Super Max-Q". The
 * longer spelling is collapsed to the shorter before matching, so one
 * `... max-q` key in the table covers both - without it the substring walk
 * lands on the desktop key and hands the part a bandwidth it does not have.
 */
export function lookupBandwidth(gpuName: string | null | undefined): number | null {
  if (!gpuName) return null;
  const gn = gpuName.toLowerCase().replace(/\bwith\s+max-q\s+design\b/g, 'max-q');
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
      const rawTps = (effBw * GPU_EFFICIENCY) / (modelGb + PER_TOKEN_OVERHEAD_GB);
      return rawTps * (isMoe ? MOE_SPEED_FACTOR : 1);
    }
    // Fully on GPU.
    const rawTps = (bw * GPU_EFFICIENCY) / (modelGb + PER_TOKEN_OVERHEAD_GB);
    return rawTps * (isMoe ? MOE_SPEED_FACTOR : 1);
  }

  const k = tableLookup(FALLBACK_K, backend, 70);
  if (pb <= 0) return 0;
  const sm = tableLookup(QUANT_SPEED_MULT, quant, 1.0);
  return (k / (pb + FALLBACK_OVERHEAD_B)) * sm;
}
