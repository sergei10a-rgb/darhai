/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Quantization tables and memory estimation.
 *
 * Pure, side-effect-free port of Odysseus' models.py quant maps and
 * estimate_memory_gb. Values are re-typed for TypeScript; the numeric tables
 * are the reference calibration, not copied executable code.
 */

import type { CatalogModel } from './types';

/** Bytes per parameter for each quant format (drives VRAM/RAM estimate). */
export const QUANT_BYTES_PER_PARAM: Readonly<Record<string, number>> = {
  F32: 4.0,
  F16: 2.0,
  BF16: 2.0,
  FP8: 1.0,
  FP4: 0.5,
  NVFP4: 0.5,
  MXFP4: 0.5,
  NF4: 0.5,
  INT4: 0.5,
  INT8: 1.0,
  W4A16: 0.5,
  W8A8: 1.0,
  W8A16: 1.0,
  Q8_0: 1.0,
  Q6_K: 0.75,
  Q5_K_M: 0.625,
  Q4_K_M: 0.5,
  Q4_0: 0.5,
  Q3_K_M: 0.375,
  Q2_K: 0.25,
  'AWQ-4bit': 0.5,
  'AWQ-8bit': 1.0,
  'GPTQ-Int4': 0.5,
  'GPTQ-Int8': 1.0,
  'mlx-4bit': 0.5,
  'mlx-8bit': 1.0,
  'mlx-6bit': 0.75,
  // DeepSeek-V4-style mixed precision (MoE experts FP4, rest FP8/BF16).
  'FP4-MoE-Mixed': 0.55,
  'FP8-Mixed': 1.0,
};

/** Speed multiplier per quant (lighter quants decode faster per param). */
export const QUANT_SPEED_MULT: Readonly<Record<string, number>> = {
  F16: 0.6,
  BF16: 0.6,
  FP8: 0.85,
  FP4: 1.15,
  NVFP4: 1.15,
  MXFP4: 1.15,
  NF4: 1.1,
  INT4: 1.15,
  INT8: 0.85,
  W4A16: 1.15,
  W8A8: 0.85,
  W8A16: 0.85,
  Q8_0: 0.8,
  Q6_K: 0.95,
  Q5_K_M: 1.0,
  Q4_K_M: 1.15,
  Q4_0: 1.15,
  Q3_K_M: 1.25,
  Q2_K: 1.35,
  'AWQ-4bit': 1.2,
  'AWQ-8bit': 0.85,
  'GPTQ-Int4': 1.2,
  'GPTQ-Int8': 0.85,
  'mlx-4bit': 1.15,
  'mlx-8bit': 0.85,
  'mlx-6bit': 1.0,
  'FP4-MoE-Mixed': 1.1,
  'FP8-Mixed': 0.85,
};

/** Quality delta applied to a model's base score for lossy quants (<= 0). */
export const QUANT_QUALITY_PENALTY: Readonly<Record<string, number>> = {
  F16: 0.0,
  BF16: 0.0,
  FP8: 0.0,
  FP4: -3.0,
  NVFP4: -3.0,
  MXFP4: -3.0,
  NF4: -4.0,
  INT4: -4.0,
  INT8: 0.0,
  W4A16: -4.0,
  W8A8: 0.0,
  W8A16: 0.0,
  Q8_0: 0.0,
  Q6_K: -1.0,
  Q5_K_M: -2.0,
  Q4_K_M: -5.0,
  Q4_0: -5.0,
  Q3_K_M: -8.0,
  Q2_K: -12.0,
  AWQ: -1.0,
  'AWQ-4bit': -4.0,
  'AWQ-8bit': -1.0,
  GPTQ: -1.0,
  'GPTQ-Int4': -4.0,
  'GPTQ-Int8': -1.0,
  'mlx-4bit': -4.0,
  'mlx-8bit': -0.5,
  'mlx-6bit': -1.5,
  'FP4-MoE-Mixed': -0.5,
  'FP8-Mixed': 0.0,
};

/** GGUF quant tiers tried best-quality-first when auto-selecting a quant. */
export const QUANT_HIERARCHY: readonly string[] = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'Q2_K'];

/** Native/prequantized format label prefixes (not GGUF quant tiers). */
export const PREQUANTIZED_PREFIXES: readonly string[] = [
  'AWQ-',
  'GPTQ-',
  'mlx-',
  'FP8',
  'FP4',
  'NVFP4',
  'MXFP4',
  'NF4',
  'INT4',
  'INT8',
  'W4A16',
  'W8A8',
  'W8A16',
  'FP4-MoE-Mixed',
  'FP8-Mixed',
];

const DEFAULT_BYTES_PER_PARAM = 0.58;

/**
 * Own-property table lookup. A plain-object `TABLE[key] ?? default` walks the
 * prototype chain, so an attacker-controlled `key` of `constructor`,
 * `hasOwnProperty`, `toString`, etc. resolves to an inherited Function/method
 * instead of `undefined` — poisoning the numeric estimate (e.g. `NaN`). This
 * returns the default unless `key` is an OWN, numeric-valued entry of `table`.
 */
export function tableLookup(table: Readonly<Record<string, number>>, key: string, fallback: number): number {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(table, key)) return fallback;
  const value = table[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** MoE active-param heuristic when a catalog row omits `activeParameters`. */
const MOE_ACTIVE_FALLBACK_FRACTION = 0.15;

/**
 * Parse a model's parameter count in billions. Prefers the exact
 * `parametersRaw` field; falls back to parsing the human `parameterCount`
 * ("7B", "355M", "80K", "1.5T"). Returns 0 for unknown/malformed sizes so a
 * single bad row never aborts a whole ranking pass.
 */
export function paramsB(model: Pick<CatalogModel, 'parametersRaw' | 'parameterCount'>): number {
  const raw = model.parametersRaw;
  if (typeof raw === 'number' && raw > 0) {
    return raw / 1_000_000_000;
  }
  const pc = (model.parameterCount || '').trim().toUpperCase();
  if (!pc) return 0;
  const match = /^([\d.]+)\s*([BKMGT]?)$/.exec(pc);
  if (!match) return 0;
  // Number() (not parseFloat) rejects malformed values like "1.5.3" as NaN,
  // matching Python float()'s throw-on-bad-input behavior — a single bad
  // catalog row must map to "unknown size", never a silently-truncated number.
  const val = Number(match[1]);
  if (!Number.isFinite(val)) return 0;
  switch (match[2]) {
    case 'B':
      return val;
    case 'M':
      return val / 1000;
    case 'K':
      return val / 1_000_000;
    case 'T':
      return val * 1000;
    default:
      // No unit: a bare large number is a raw parameter count; a small bare
      // number ("355") is conventionally millions ("355M" -> 0.355B).
      if (val >= 1_000_000) return val / 1_000_000_000;
      if (val >= 1000) return val / 1000;
      return val / 1000;
  }
}

/**
 * Active params per token (billions). For MoE only the active experts run per
 * token, which drives KV-cache size and decode speed (not total VRAM). Dense
 * models return their full param count.
 */
export function activeParamsB(model: CatalogModel): number {
  const total = paramsB(model);
  if (!model.isMoe) return total;
  if (typeof model.activeParameters === 'number' && model.activeParameters > 0) {
    return model.activeParameters / 1_000_000_000;
  }
  // MoE row missing activeParameters: using the full param count here would
  // make the KV-cache and decode-speed estimate far too pessimistic (VRAM and
  // tok/s treated as a dense model). Prefer an experts-ratio estimate when the
  // catalog gives the expert counts; otherwise fall back to a coarse fraction
  // of the total so a MoE still scores like a MoE, not a dense giant.
  if (
    typeof model.numExperts === 'number' &&
    model.numExperts > 0 &&
    typeof model.activeExperts === 'number' &&
    model.activeExperts > 0
  ) {
    const ratio = Math.min(1, model.activeExperts / model.numExperts);
    const estimated = total * ratio;
    if (estimated > 0) return estimated;
  }
  return total * MOE_ACTIVE_FALLBACK_FRACTION;
}

/**
 * Estimate the memory (GB) needed to serve a model at a given quant + context.
 * All weights load (even MoE experts); KV-cache scales with ACTIVE params for
 * MoE. Formula: params*bpp + kvFactor*activeParams*ctx + fixed overhead.
 */
export function estimateMemoryGb(model: CatalogModel, quant: string, ctx: number): number {
  const pb = paramsB(model);
  const bpp = tableLookup(QUANT_BYTES_PER_PARAM, quant, DEFAULT_BYTES_PER_PARAM);
  const kvParams = activeParamsB(model);
  const KV_FACTOR = 0.000008;
  const FIXED_OVERHEAD_GB = 0.5;
  return pb * bpp + KV_FACTOR * kvParams * ctx + FIXED_OVERHEAD_GB;
}

/** True when a model's native format is a prequantized (non-GGUF) repo. */
export function isPrequantized(model: CatalogModel): boolean {
  const q = model.quantization || '';
  const name = (model.name || '').toLowerCase();
  const fmt = (model.format || '').toLowerCase();
  const text = `${name} ${fmt}`;
  if (text.includes('nvfp4')) return true;
  if (/(^|[-_/])fp8($|[-_/\s])/.test(text)) return true;
  if (!(model.isGguf || model.ggufSources?.length) && /(^|[-_/])(?:int)?8bit($|[-_/\s])/.test(text)) {
    return true;
  }
  if (['awq', 'gptq', 'mlx'].some((x) => text.includes(x))) return true;
  return PREQUANTIZED_PREFIXES.some((p) => q.startsWith(p));
}
