/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fit-scoring pipeline (PURE, side-effect-free, unit-testable).
 *
 * TypeScript re-implementation of Odysseus' fit.py: 4 sub-scores
 * (quality / speed / fit / context) weighted by use-case, quant selection,
 * platform serving-path filters, and MoE-aware memory/speed estimation. The
 * numeric tables are the reference calibration; no Python is wrapped.
 */

import type {
  CatalogModel,
  FitLevel,
  FitResult,
  HardwareProfile,
  RankOptions,
  RunMode,
  SortKey,
  UseCase,
} from './types';
import { QUANT_QUALITY_PENALTY, estimateMemoryGb, isPrequantized, paramsB, tableLookup } from './quantTables';
import { estimateSpeed } from './speedModel';

/** Per-use-case sub-score weights: [quality, speed, fit, context], sum ~= 1. */
const USE_CASE_WEIGHTS: Readonly<Record<UseCase, readonly [number, number, number, number]>> = {
  general: [0.45, 0.3, 0.15, 0.1],
  coding: [0.5, 0.2, 0.15, 0.15],
  reasoning: [0.55, 0.15, 0.15, 0.15],
  chat: [0.4, 0.35, 0.15, 0.1],
  multimodal: [0.5, 0.2, 0.15, 0.15],
  embedding: [0.3, 0.4, 0.2, 0.1],
  tts: [0.4, 0.35, 0.15, 0.1],
  stt: [0.4, 0.35, 0.15, 0.1],
};

/** Target tok/s per use-case; speed sub-score is tps/target capped at 100. */
const SPEED_TARGET: Readonly<Record<UseCase, number>> = {
  general: 40,
  coding: 40,
  multimodal: 40,
  chat: 40,
  reasoning: 25,
  embedding: 200,
  tts: 40,
  stt: 40,
};

/** Target context per use-case; context sub-score buckets around it. */
const CONTEXT_TARGET: Readonly<Record<UseCase, number>> = {
  general: 4096,
  chat: 4096,
  coding: 8192,
  reasoning: 8192,
  multimodal: 4096,
  embedding: 512,
  tts: 2048,
  stt: 2048,
};

const DEFAULT_WEIGHTS: readonly [number, number, number, number] = [0.45, 0.3, 0.15, 0.1];
const DEFAULT_CONTEXT = 4096;
const MIN_HALVED_CONTEXT = 1024;

const NATIVE_QUANT_PREFIXES = [
  'AWQ-',
  'GPTQ-',
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
] as const;

const GGUF_TIER_PREFIXES = ['Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'IQ'] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A finite, non-negative number (NaN/Infinity/negatives/null collapse to 0). */
function finiteNonNeg(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- Use-case inference ---------------------------------------------------

/** Infer a model's intrinsic use-case from its name + upstream blurb. */
export function inferUseCase(model: CatalogModel): UseCase {
  const name = (model.name || '').toLowerCase();
  const uc = (model.useCase || '').toLowerCase();
  const combined = `${name} ${uc}`;

  if (['embedding', 'embed', 'bge'].some((k) => combined.includes(k))) return 'embedding';
  if (['tts', 'text-to-speech', 'speech-synthesis', 'cosyvoice', 'parler'].some((k) => combined.includes(k))) {
    return 'tts';
  }
  if (['stt', 'speech-to-text', 'whisper', 'transcri', 'asr'].some((k) => combined.includes(k))) return 'stt';
  if (combined.includes('code')) return 'coding';
  if (['vision', 'multimodal', 'vlm', 'vl-'].some((k) => combined.includes(k))) return 'multimodal';
  if (['reason', 'chain-of-thought', 'deepseek-r1'].some((k) => combined.includes(k))) return 'reasoning';
  if (['chat', 'instruction'].some((k) => combined.includes(k))) return 'chat';
  return 'general';
}

// --- Native quant resolution ----------------------------------------------

/** Approximate bit-width of a quant label so GGUF tiers match prequant formats. */
export function quantBits(q: string): number {
  const qu = (q || '').toUpperCase().replace(/[-_ ]/g, '');
  if (qu.startsWith('Q8') || qu.includes('FP8') || qu.includes('INT8') || qu.startsWith('W8')) return 8;
  if (
    qu.startsWith('Q4') ||
    qu.startsWith('IQ4') ||
    qu.includes('FP4') ||
    qu.includes('NF4') ||
    qu.includes('INT4') ||
    qu.startsWith('W4')
  ) {
    return 4;
  }
  if (qu.startsWith('Q2') || qu.startsWith('IQ2')) return 2;
  if (qu.startsWith('Q3') || qu.startsWith('IQ3')) return 3;
  if (qu.startsWith('Q5')) return 5;
  if (qu.startsWith('Q6')) return 6;
  if (qu.startsWith('F16') || qu.startsWith('BF16') || qu.startsWith('F32')) return 16;
  const m = /(?:AWQ|GPTQ|MLX|EXL2|BNB|INT|W)(\d{1,2})/.exec(qu) || /(\d{1,2})BIT/.exec(qu);
  if (m) {
    const b = Number.parseInt(m[1], 10);
    if (b >= 2 && b <= 16) return b;
  }
  return 0;
}

/** Resolve the model's native/default quant label from its metadata. */
export function nativeQuant(model: CatalogModel): string {
  const fallback = model.quantization || 'Q4_K_M';
  const name = (model.name || '').toLowerCase();
  const fmt = (model.format || '').toLowerCase();
  const text = `${name} ${fmt}`;
  if (text.includes('nvfp4')) return 'NVFP4';
  if (/(^|[-_/])fp8($|[-_/\s])/.test(text)) return 'FP8';
  if (text.includes('gptq')) {
    const m = /(?:gptq|int|w)(?:[-_]?)(\d{1,2})(?:bit)?/.exec(text);
    return m ? `GPTQ-Int${m[1]}` : 'GPTQ-Int4';
  }
  if (text.includes('awq')) {
    const m = /(?:awq|int|w)(?:[-_]?)(\d{1,2})(?:bit)?/.exec(text);
    return m ? `AWQ-${m[1]}bit` : 'AWQ-4bit';
  }
  if (text.includes('mlx')) {
    const m = /mlx[-_]?(\d{1,2})bit/.exec(text);
    return m ? `mlx-${m[1]}bit` : fallback;
  }
  if (!(model.isGguf || model.ggufSources?.length) && /(^|[-_/])(?:int)?8bit($|[-_/\s])/.test(text)) {
    return 'INT8';
  }
  return fallback;
}

// --- Sub-scores -----------------------------------------------------------

function architectureBonus(model: CatalogModel): number {
  const text = `${(model.name || '').toLowerCase()} ${(model.architecture || '').toLowerCase()}`;
  const arch = (model.architecture || '').toLowerCase();
  if (text.includes('qwen3.6') || text.includes('qwen3_6')) return 9;
  if (text.includes('qwen3.5') || text.includes('qwen3_5')) return 8;
  if (text.includes('qwen3-next') || text.includes('qwen3_next')) return 6;
  if (text.includes('qwen3') || arch.startsWith('qwen3')) return 4;
  if (text.includes('qwen2.5') || text.includes('qwen2_5')) return 2;
  return 0;
}

function qualityScore(model: CatalogModel, quant: string, useCase: UseCase): number {
  const pb = paramsB(model);
  let base: number;
  if (pb < 1) base = 30;
  else if (pb < 3) base = 45;
  else if (pb < 7) base = 60;
  else if (pb < 10) base = 75;
  else if (pb < 20) base = 82;
  else if (pb < 40) base = 89;
  else base = 95;

  const nameLower = (model.name || '').toLowerCase();
  if (nameLower.includes('qwen')) base += 2;
  if (nameLower.includes('deepseek')) base += 3;
  if (nameLower.includes('llama')) base += 2;
  if (nameLower.includes('mistral') || nameLower.includes('mixtral')) base += 1;
  if (nameLower.includes('gemma')) base += 1;

  base += architectureBonus(model);
  base += tableLookup(QUANT_QUALITY_PENALTY, quant, 0);

  const modelUc = inferUseCase(model);
  if (modelUc === 'coding' && useCase === 'coding') base += 6;
  else if (modelUc === 'coding' && (useCase === 'general' || useCase === 'chat')) base -= 10;
  if (modelUc === 'reasoning' && useCase === 'reasoning' && pb >= 13) base += 5;
  else if (modelUc === 'reasoning' && useCase === 'chat') base -= 4;
  if (modelUc === 'multimodal' && useCase === 'multimodal') base += 6;

  return clamp(base, 0, 100);
}

function speedScore(tps: number, useCase: UseCase): number {
  const target = SPEED_TARGET[useCase] ?? 40;
  return clamp((tps / target) * 100, 0, 100);
}

function fitScoreValue(required: number, available: number): number {
  if (required > available) return 0;
  if (available <= 0) return 0;
  const ratio = required / available;
  if (ratio <= 0.5) return 60 + (ratio / 0.5) * 40;
  if (ratio <= 0.8) return 100;
  if (ratio <= 0.9) return 70;
  return 50;
}

function contextScore(ctx: number, useCase: UseCase): number {
  const target = CONTEXT_TARGET[useCase] ?? DEFAULT_CONTEXT;
  if (ctx >= target) return 100;
  if (ctx >= target / 2) return 70;
  return 30;
}

// --- Quant-at-context fitting ---------------------------------------------

type QuantFit = { runMode: RunMode; quant: string; ctx: number; mem: number };

/** Try a quant at a context, halving context until it fits or gives up. */
function tryQuantAt(
  model: CatalogModel,
  quant: string,
  ctx: number,
  gpuVram: number,
  availableRam: number
): QuantFit | null {
  let mem = estimateMemoryGb(model, quant, ctx);
  if (gpuVram > 0 && mem <= gpuVram) return { runMode: 'gpu', quant, ctx, mem };
  if (gpuVram > 0 && mem <= availableRam) return { runMode: 'cpu_offload', quant, ctx, mem };
  if (gpuVram <= 0 && mem <= availableRam) return { runMode: 'cpu_only', quant, ctx, mem };

  let curCtx = Math.floor(ctx / 2);
  while (curCtx >= MIN_HALVED_CONTEXT) {
    mem = estimateMemoryGb(model, quant, curCtx);
    if (gpuVram > 0 && mem <= gpuVram) return { runMode: 'gpu', quant, ctx: curCtx, mem };
    if (mem <= availableRam) {
      return { runMode: gpuVram > 0 ? 'cpu_offload' : 'cpu_only', quant, ctx: curCtx, mem };
    }
    curCtx = Math.floor(curCtx / 2);
  }
  return null;
}

// --- analyzeModel ---------------------------------------------------------

/**
 * Score one model against the hardware profile. Returns a FitResult (possibly
 * with fitLevel "too_tight" when it does not fit) or null when the model has
 * no usable parameter count or is filtered out for the platform serving path.
 */
export function analyzeModel(
  model: CatalogModel,
  system: HardwareProfile,
  targetQuant?: string,
  scoringUseCase: UseCase = 'general',
  targetContext = 0
): FitResult | null {
  const pb = paramsB(model);
  if (pb <= 0) return null;

  const modelUseCase = inferUseCase(model);
  const hasGpu = system.hasGpu;
  // Defense-in-depth: coerce to a finite, non-negative budget. The IPC boundary
  // (hwfitBridge) already clamps a renderer-supplied override, but a detected
  // profile or a direct caller could still carry NaN/Infinity/negative here,
  // which would silently corrupt every downstream fit/speed comparison.
  const gpuVram = hasGpu ? finiteNonNeg(system.gpuVramGb) : 0;
  const gpuCount = system.gpuCount > 0 ? Math.trunc(system.gpuCount) : 1;
  const singleGpuVram = gpuCount > 1 ? gpuVram / gpuCount : gpuVram;
  const availableRam = finiteNonNeg(system.availableRamGb);
  const gpuOnly = Boolean(system.gpuOnly) && hasGpu && gpuVram > 0;
  const effRam = gpuOnly ? 0 : availableRam;
  const isMoe = Boolean(model.isMoe);
  const modelCtx = model.contextLength || DEFAULT_CONTEXT;
  const tc = Number.isFinite(targetContext) && targetContext > 0 ? targetContext : 0;
  const ctx = tc > 0 ? Math.min(modelCtx, tc) : modelCtx;

  const preq = isPrequantized(model);
  const isGguf = Boolean(model.ggufSources?.length);
  const nq = nativeQuant(model);
  const quantUpper = nq.toUpperCase();
  const isGgufQuant = ['Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q8', 'IQ', 'F16', 'F32'].some((p) => quantUpper.startsWith(p));

  // GGUF/dense builds can't shard across GPUs (llama.cpp); prequant (AWQ/GPTQ/
  // FP8) is served sharded by vLLM, so it gets the full multi-GPU VRAM.
  const effectiveVram = (isGguf || isGgufQuant) && !preq ? singleGpuVram : gpuVram;
  const nativeGpuOnly = preq && !nq.startsWith('mlx-');

  // Determine the quant to evaluate at.
  let quantToTry: string;
  if (preq) {
    if (targetQuant) {
      if (!NATIVE_QUANT_PREFIXES.some((p) => targetQuant.startsWith(p))) return null;
      const tb = quantBits(targetQuant);
      const nb = quantBits(nq);
      if (tb && nb && tb !== nb) return null;
    }
    quantToTry = nq;
  } else if (targetQuant) {
    quantToTry = targetQuant;
  } else if (gpuCount >= 2) {
    // Multi-GPU: vLLM/SGLang can't serve GGUF Q* quants; default to BF16.
    quantToTry = 'BF16';
  } else {
    quantToTry = 'Q4_K_M';
  }

  // Multi-GPU filter: skip GGUF-tier rows (unservable via vLLM/SGLang).
  if (gpuCount >= 2 && !targetQuant && GGUF_TIER_PREFIXES.some((p) => quantToTry.toUpperCase().startsWith(p))) {
    return null;
  }

  const result = tryQuantAt(model, quantToTry, ctx, effectiveVram, nativeGpuOnly ? 0 : effRam);

  if (result === null) {
    // Doesn't fit: surface with a "too_tight" badge instead of dropping it so
    // the user can see what a bigger rig would run.
    const oversizedRequired = estimateMemoryGb(model, quantToTry, ctx);
    return {
      name: model.name,
      provider: model.provider,
      parameterCount: model.parameterCount,
      paramsB: round1(pb),
      isMoe,
      useCase: modelUseCase,
      fitLevel: 'too_tight',
      runMode: 'no_fit',
      quant: quantToTry,
      context: ctx,
      requiredGb: round1(oversizedRequired),
      speedTps: 0,
      score: 0,
      scores: { quality: 0, speed: 0, fit: 0, context: 0 },
      ggufSources: model.ggufSources ?? [],
      contextLength: modelCtx,
      releaseDate: model.releaseDate,
    };
  }

  const { runMode, quant, ctx: fitCtx, mem: requiredGb } = result;
  const budget = runMode === 'gpu' ? effectiveVram : availableRam;
  if (requiredGb > budget) return null;

  let fitLevel: FitLevel;
  if (runMode === 'gpu') {
    const rec = model.recommendedRamGb || requiredGb;
    if (rec <= gpuVram) fitLevel = 'perfect';
    else if (gpuVram >= requiredGb * 1.2) fitLevel = 'good';
    else fitLevel = 'marginal';
  } else if (runMode === 'cpu_offload') {
    fitLevel = availableRam >= requiredGb * 1.2 ? 'good' : 'marginal';
  } else {
    fitLevel = 'marginal';
  }

  let offloadFrac = 0;
  if (runMode === 'cpu_offload' && requiredGb > 0 && effectiveVram > 0) {
    offloadFrac = Math.max(0, (requiredGb - effectiveVram) / requiredGb);
  }
  const tps = estimateSpeed(model, quant, runMode, { gpuName: system.gpuName, backend: system.backend }, offloadFrac);

  const qScore = qualityScore(model, quant, scoringUseCase);
  const sScore = speedScore(tps, scoringUseCase);
  const fScore = fitScoreValue(requiredGb, budget);
  const cScore = contextScore(fitCtx, scoringUseCase);

  const [wq, ws, wf, wc] = USE_CASE_WEIGHTS[scoringUseCase] ?? DEFAULT_WEIGHTS;
  const composite = qScore * wq + sScore * ws + fScore * wf + cScore * wc;

  return {
    name: model.name,
    provider: model.provider,
    parameterCount: model.parameterCount,
    paramsB: round1(pb),
    isMoe,
    useCase: modelUseCase,
    fitLevel,
    runMode,
    quant,
    context: fitCtx,
    requiredGb: round1(requiredGb),
    speedTps: round1(tps),
    score: round1(composite),
    scores: {
      quality: round1(qScore),
      speed: round1(sScore),
      fit: round1(fScore),
      context: round1(cScore),
    },
    ggufSources: model.ggufSources ?? [],
    contextLength: modelCtx,
    releaseDate: model.releaseDate,
  };
}

// --- Sorting --------------------------------------------------------------

/** Parse a version number from a name so equal-score ties prefer the newer. */
export function versionKey(name: string | undefined): number {
  if (!name) return 0;
  const re = /[A-Za-z](\d+(?:\.\d+)?)(?![A-Za-z])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) {
    const val = m[1];
    const f = Number.parseFloat(val);
    if (!Number.isFinite(f)) continue;
    // Bare integers >= 100 are almost certainly param counts, not versions.
    if (!val.includes('.') && f >= 100) continue;
    return f;
  }
  return 0;
}

function sortComparator(sort: SortKey): (a: FitResult, b: FitResult) => number {
  switch (sort) {
    case 'speed':
      return (a, b) => b.speedTps - a.speedTps;
    case 'vram':
      return (a, b) => b.requiredGb - a.requiredGb;
    case 'params':
      return (a, b) => b.paramsB - a.paramsB;
    case 'context':
      return (a, b) => b.context - a.context;
    case 'newest':
      return (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '');
    case 'score':
    default:
      return (a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return versionKey(b.name) - versionKey(a.name);
      };
  }
}

// --- rankModels -----------------------------------------------------------

const DEFAULT_LIMIT = 50;

/**
 * Rank all catalog models against the hardware profile. Applies platform
 * serving-path filters (Apple/Windows/consumer-AMD => GGUF only; multi-GPU
 * hides GGUF tiers), format filters, search, and use-case filtering, then
 * sorts and truncates to `limit`.
 */
export function rankModels(
  models: readonly CatalogModel[],
  system: HardwareProfile,
  options: RankOptions = {}
): FitResult[] {
  const { useCase, limit = DEFAULT_LIMIT, search, sort = 'score', quant, targetContext = 0, fitOnly = false } = options;

  const backend = (system.backend || '').toLowerCase();
  const appleSilicon = backend === 'metal';
  const rocm = backend === 'rocm';
  const isWindows = system.platform === 'windows';
  const gpuFamily = (system.gpuFamily || '').toLowerCase();
  const consumerAmd = rocm && gpuFamily === 'rdna';

  // Filter to native prequantized formats only when the user picked one.
  const filterNative = !!quant && NATIVE_QUANT_PREFIXES.some((p) => quant.startsWith(p));

  const results: FitResult[] = [];
  const searchLower = search?.toLowerCase();

  for (const m of models) {
    const nq = nativeQuant(m);

    // MLX needs the mlx_lm runtime we don't generate serve commands for.
    if (nq.startsWith('mlx-') || (m.name || '').toLowerCase().includes('mlx')) continue;

    // ROCm: keep AWQ/GPTQ/FP8 discoverable only when explicitly picked.
    if (rocm && isPrequantized(m) && !filterNative) continue;

    // Apple/consumer-AMD/Windows: only GGUF-servable models are recommendable.
    if ((appleSilicon || consumerAmd || isWindows) && !(m.isGguf || m.ggufSources?.length)) continue;

    // Format filter: AWQ tab -> only AWQ, FP4 tab -> FP4 family, etc.
    if (filterNative && quant) {
      if (quant === 'FP8' && nq !== 'FP8') continue;
      if (quant === 'FP4' && !['FP4', 'NVFP4', 'MXFP4', 'NF4'].includes(nq)) continue;
      if (quant.startsWith('AWQ') && !nq.startsWith('AWQ')) continue;
      if (quant.startsWith('GPTQ') && !nq.startsWith('GPTQ')) continue;
      if (quant.startsWith('NVFP4') && !nq.startsWith('NVFP4')) continue;
      if (['INT4', 'INT8', 'W4A16', 'W8A8', 'W8A16'].includes(quant) && nq !== quant) continue;
    }

    if (searchLower) {
      const name = (m.name || '').toLowerCase();
      const provider = (m.provider || '').toLowerCase();
      if (!name.includes(searchLower) && !provider.includes(searchLower)) continue;
    }

    const result = analyzeModel(m, system, quant, useCase || 'general', targetContext);
    if (result === null) continue;

    if (useCase) {
      const modelUc = inferUseCase(m);
      if (useCase !== modelUc && useCase !== 'general') continue;
    }

    results.push(result);
  }

  let final = results;
  if (fitOnly) {
    final = final.filter((r) => r.fitLevel !== 'too_tight');
  }
  final.sort(sortComparator(sort));
  return final.slice(0, limit);
}
