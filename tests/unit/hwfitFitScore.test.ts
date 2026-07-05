/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  estimateMemoryGb,
  paramsB,
  activeParamsB,
  isPrequantized,
  tableLookup,
  QUANT_BYTES_PER_PARAM,
} from '@process/services/hwfit/quantTables';
import { estimateSpeed, lookupBandwidth } from '@process/services/hwfit/speedModel';
import { analyzeModel, rankModels, nativeQuant, inferUseCase, versionKey } from '@process/services/hwfit/fitScore';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit/types';

const dense7b: CatalogModel = {
  name: 'qwen/Qwen3-7B',
  provider: 'qwen',
  parameterCount: '7B',
  parametersRaw: 7_000_000_000,
  quantization: 'Q4_K_M',
  contextLength: 8192,
  architecture: 'qwen3',
  releaseDate: '2026-01-01',
};

const moe: CatalogModel = {
  name: 'deepseek-ai/DeepSeek-V3',
  provider: 'deepseek-ai',
  parameterCount: '235B',
  parametersRaw: 235_000_000_000,
  quantization: 'Q4_K_M',
  contextLength: 32768,
  isMoe: true,
  activeParameters: 22_000_000_000,
  releaseDate: '2026-02-01',
};

function gpuSystem(vramGb: number, name = 'NVIDIA GeForce RTX 4070'): HardwareProfile {
  return {
    totalRamGb: 64,
    availableRamGb: 48,
    cpuCores: 16,
    cpuName: 'Test CPU',
    hasGpu: true,
    gpuName: name,
    gpuVramGb: vramGb,
    gpuCount: 1,
    gpus: [{ index: 0, name, vramGb }],
    backend: 'cuda',
    platform: 'linux',
  };
}

const cpuOnlySystem: HardwareProfile = {
  totalRamGb: 32,
  availableRamGb: 24,
  cpuCores: 8,
  cpuName: 'Test CPU',
  hasGpu: false,
  gpuName: null,
  gpuVramGb: null,
  gpuCount: 0,
  gpus: [],
  backend: 'cpu_x86',
  platform: 'linux',
};

describe('paramsB', () => {
  it('prefers exact parametersRaw over the human string', () => {
    expect(paramsB({ parametersRaw: 7_000_000_000, parameterCount: '7B' })).toBe(7);
  });

  it('parses suffixes B/M/K/T', () => {
    expect(paramsB({ parameterCount: '13B' })).toBe(13);
    expect(paramsB({ parameterCount: '355M' })).toBeCloseTo(0.355, 3);
    expect(paramsB({ parameterCount: '80K' })).toBeCloseTo(0.00008, 6);
    expect(paramsB({ parameterCount: '1.5T' })).toBe(1500);
  });

  it('returns 0 for a malformed count instead of throwing', () => {
    expect(paramsB({ parameterCount: '1.5.3B' })).toBe(0);
    expect(paramsB({ parameterCount: '' })).toBe(0);
  });
});

describe('estimateMemoryGb', () => {
  it('scales weights by bytes-per-param for the quant', () => {
    // 7B * 0.5 (Q4_K_M) + tiny KV + 0.5 overhead ~= 4.0 GB
    const mem = estimateMemoryGb(dense7b, 'Q4_K_M', 4096);
    expect(mem).toBeGreaterThan(3.5);
    expect(mem).toBeLessThan(4.5);
  });

  it('uses active params (not total) for MoE KV cache', () => {
    // Weights still load fully (235B * 0.5 ~= 117.5 GB); KV cache uses 22B active.
    const mem = estimateMemoryGb(moe, 'Q4_K_M', 8192);
    expect(mem).toBeGreaterThan(117);
    expect(mem).toBeLessThan(120);
  });

  it('grows with a larger quant (Q8 > Q4)', () => {
    expect(estimateMemoryGb(dense7b, 'Q8_0', 4096)).toBeGreaterThan(estimateMemoryGb(dense7b, 'Q4_K_M', 4096));
  });

  it('falls back to a default bpp for an unknown quant', () => {
    expect(estimateMemoryGb(dense7b, 'TOTALLY_UNKNOWN', 4096)).toBeGreaterThan(0);
  });
});

describe('activeParamsB', () => {
  it('returns active params for MoE and full params for dense', () => {
    expect(activeParamsB(moe)).toBe(22);
    expect(activeParamsB(dense7b)).toBe(7);
  });
});

describe('lookupBandwidth', () => {
  it('matches the longest key first (m4 max before m4)', () => {
    expect(lookupBandwidth('Apple M4 Max')).toBe(546);
    expect(lookupBandwidth('Apple M4')).toBe(120);
  });

  it('returns null for an unknown GPU', () => {
    expect(lookupBandwidth('Some Unknown GPU')).toBeNull();
    expect(lookupBandwidth(null)).toBeNull();
  });
});

describe('estimateSpeed', () => {
  it('is faster on a higher-bandwidth GPU for the same model', () => {
    const slow = estimateSpeed(dense7b, 'Q4_K_M', 'gpu', { gpuName: 'NVIDIA GeForce RTX 4060', backend: 'cuda' });
    const fast = estimateSpeed(dense7b, 'Q4_K_M', 'gpu', { gpuName: 'NVIDIA GeForce RTX 5090', backend: 'cuda' });
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
  });

  it('drops sharply as more of the model offloads to CPU RAM', () => {
    const light = estimateSpeed(
      dense7b,
      'Q4_K_M',
      'cpu_offload',
      { gpuName: 'NVIDIA GeForce RTX 4070', backend: 'cuda' },
      0.1
    );
    const heavy = estimateSpeed(
      dense7b,
      'Q4_K_M',
      'cpu_offload',
      { gpuName: 'NVIDIA GeForce RTX 4070', backend: 'cuda' },
      0.8
    );
    expect(heavy).toBeLessThan(light);
  });

  it('falls back to a per-param constant when GPU bandwidth is unknown', () => {
    const tps = estimateSpeed(dense7b, 'Q4_K_M', 'gpu', { gpuName: 'Mystery GPU', backend: 'cuda' });
    expect(tps).toBeGreaterThan(0);
  });
});

describe('nativeQuant', () => {
  it('detects prequantized formats from the name', () => {
    expect(nativeQuant({ name: 'org/Model-AWQ', provider: 'org', parameterCount: '7B' })).toBe('AWQ-4bit');
    expect(nativeQuant({ name: 'org/Model-FP8', provider: 'org', parameterCount: '7B' })).toBe('FP8');
    expect(nativeQuant({ name: 'org/Model-GPTQ-Int8', provider: 'org', parameterCount: '7B' })).toBe('GPTQ-Int8');
  });

  it('falls back to the declared quantization for plain GGUF models', () => {
    expect(nativeQuant(dense7b)).toBe('Q4_K_M');
  });
});

describe('isPrequantized', () => {
  it('flags AWQ/FP8/GPTQ repos and passes plain GGUF', () => {
    expect(isPrequantized({ name: 'o/M-AWQ', provider: 'o', parameterCount: '7B', quantization: 'AWQ-4bit' })).toBe(
      true
    );
    expect(isPrequantized(dense7b)).toBe(false);
  });
});

describe('inferUseCase', () => {
  it('classifies by name keywords', () => {
    expect(inferUseCase({ name: 'org/CodeLlama', provider: 'org', parameterCount: '7B' })).toBe('coding');
    expect(inferUseCase({ name: 'org/bge-small', provider: 'org', parameterCount: '1B' })).toBe('embedding');
    expect(inferUseCase({ name: 'org/whisper-large', provider: 'org', parameterCount: '1B' })).toBe('stt');
    expect(inferUseCase(dense7b)).toBe('general');
  });
});

describe('analyzeModel', () => {
  it('marks a 7B Q4 model as fitting on a 12 GB GPU', () => {
    const r = analyzeModel(dense7b, gpuSystem(12), undefined, 'general');
    expect(r).not.toBeNull();
    expect(r?.runMode).toBe('gpu');
    expect(r?.fitLevel).not.toBe('too_tight');
    expect(r?.requiredGb).toBeLessThan(12);
  });

  it('marks a 235B MoE as too_tight on an 8 GB GPU (surfaced, not dropped)', () => {
    const r = analyzeModel(moe, { ...gpuSystem(8), gpuOnly: true }, undefined, 'general');
    expect(r).not.toBeNull();
    expect(r?.fitLevel).toBe('too_tight');
    expect(r?.runMode).toBe('no_fit');
    expect(r?.score).toBe(0);
  });

  it('returns null for a model with no usable parameter count', () => {
    const bad: CatalogModel = { name: 'x/y', provider: 'x', parameterCount: '' };
    expect(analyzeModel(bad, gpuSystem(24), undefined, 'general')).toBeNull();
  });

  it('routes an over-VRAM model to CPU offload when RAM allows', () => {
    // 7B fits VRAM easily; force offload by shrinking VRAM below the weight size.
    const big: CatalogModel = { ...dense7b, parametersRaw: 40_000_000_000, parameterCount: '40B' };
    const r = analyzeModel(big, gpuSystem(8), undefined, 'general');
    expect(r).not.toBeNull();
    expect(r?.runMode).toBe('cpu_offload');
  });
});

describe('rankModels', () => {
  const catalog: CatalogModel[] = [dense7b, moe];

  it('ranks fitting models above too-tight ones by score on a small GPU', () => {
    const ranked = rankModels(catalog, gpuSystem(12), { useCase: 'general' });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].name).toBe(dense7b.name);
  });

  it('drops too_tight rows when fitOnly is set', () => {
    const ranked = rankModels(catalog, { ...gpuSystem(8), gpuOnly: true }, { useCase: 'general', fitOnly: true });
    expect(ranked.every((r) => r.fitLevel !== 'too_tight')).toBe(true);
  });

  it('filters by search term over name and provider', () => {
    const ranked = rankModels(catalog, gpuSystem(80), { search: 'deepseek' });
    expect(ranked.every((r) => r.name.toLowerCase().includes('deepseek'))).toBe(true);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...dense7b, name: `qwen/Model-${i}` }));
    const ranked = rankModels(many, gpuSystem(24), { limit: 10 });
    expect(ranked.length).toBe(10);
  });

  it('recommends CPU/RAM models on a GPU-less host without throwing', () => {
    const ranked = rankModels(catalog, cpuOnlySystem, { useCase: 'general' });
    expect(Array.isArray(ranked)).toBe(true);
    // The 7B fits in 24 GB RAM as cpu_only.
    expect(ranked.some((r) => r.runMode === 'cpu_only')).toBe(true);
  });
});

describe('versionKey', () => {
  it('extracts a decimal version and ignores param-count suffixes', () => {
    expect(versionKey('MiniMax-M2.7')).toBe(2.7);
    expect(versionKey('Qwen3-235B')).toBe(3);
    expect(versionKey(undefined)).toBe(0);
  });
});

// --- M-1: prototype-chain quant lookup ------------------------------------

describe('tableLookup (M-1 prototype pollution guard)', () => {
  it('returns real own-property values', () => {
    expect(tableLookup(QUANT_BYTES_PER_PARAM, 'Q4_K_M', 999)).toBe(0.5);
    expect(tableLookup(QUANT_BYTES_PER_PARAM, 'F16', 999)).toBe(2.0);
  });

  it('returns the default for an unknown quant', () => {
    expect(tableLookup(QUANT_BYTES_PER_PARAM, 'TOTALLY_UNKNOWN', 0.58)).toBe(0.58);
  });

  it('does NOT resolve inherited Object.prototype members to functions', () => {
    for (const evil of ['constructor', 'hasOwnProperty', 'toString', 'valueOf', '__proto__', 'isPrototypeOf']) {
      expect(tableLookup(QUANT_BYTES_PER_PARAM, evil, 0.58)).toBe(0.58);
    }
  });
});

describe('estimate functions reject attacker-controlled prototype quants (M-1)', () => {
  const protoQuants = ['constructor', 'hasOwnProperty', '__proto__', 'toString'];

  it.each(protoQuants)('estimateMemoryGb stays finite for quant=%s', (quant) => {
    const mem = estimateMemoryGb(dense7b, quant, 4096);
    expect(Number.isFinite(mem)).toBe(true);
    expect(mem).toBeGreaterThan(0);
  });

  it.each(protoQuants)('estimateSpeed stays finite for quant=%s', (quant) => {
    const tps = estimateSpeed(dense7b, quant, 'gpu', { gpuName: 'NVIDIA GeForce RTX 4090', backend: 'cuda' });
    expect(Number.isFinite(tps)).toBe(true);
    expect(tps).toBeGreaterThan(0);
  });

  it.each(protoQuants)('analyzeModel produces a finite score for targetQuant=%s', (quant) => {
    // Not a native-prequant prefix, so it is treated as the quant to try.
    const r = analyzeModel(dense7b, gpuSystem(24), quant, 'general');
    expect(r).not.toBeNull();
    expect(Number.isFinite(r?.score ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(r?.requiredGb ?? Number.NaN)).toBe(true);
  });
});

// --- LOW-1: MoE active-params fallback ------------------------------------

describe('activeParamsB MoE fallback (LOW-1)', () => {
  it('uses activeParameters when present', () => {
    expect(activeParamsB(moe)).toBe(22);
  });

  it('estimates from expert ratio when activeParameters is missing', () => {
    // 80B total, 10 of 512 experts active -> ~1.56B active (far below dense).
    const moeNoActive: CatalogModel = {
      name: 'org/Coder-MoE',
      provider: 'org',
      parameterCount: '80B',
      parametersRaw: 80_000_000_000,
      isMoe: true,
      numExperts: 512,
      activeExperts: 10,
    };
    const active = activeParamsB(moeNoActive);
    expect(active).toBeGreaterThan(0);
    expect(active).toBeCloseTo(80 * (10 / 512), 3);
    // Must be much smaller than the dense total, else VRAM/speed over-estimate.
    expect(active).toBeLessThan(paramsB(moeNoActive));
  });

  it('falls back to a coarse fraction when expert counts are absent', () => {
    const moeBare: CatalogModel = {
      name: 'org/Bare-MoE',
      provider: 'org',
      parameterCount: '31B',
      parametersRaw: 31_000_000_000,
      isMoe: true,
    };
    const active = activeParamsB(moeBare);
    expect(active).toBeCloseTo(31 * 0.15, 3);
    expect(active).toBeLessThan(paramsB(moeBare));
  });

  it('returns full params for a dense model regardless of expert fields', () => {
    expect(activeParamsB(dense7b)).toBe(7);
  });
});

// --- LOW-2: NaN guard in analyzeModel -------------------------------------

describe('analyzeModel NaN/Infinity guards (LOW-2)', () => {
  it('treats a NaN gpuVramGb as zero VRAM instead of poisoning the fit', () => {
    const poisoned: HardwareProfile = { ...gpuSystem(24), gpuVramGb: Number.NaN };
    const r = analyzeModel(dense7b, poisoned, undefined, 'general');
    // With no usable VRAM but ample RAM, the model still ranks (cpu path),
    // and every numeric output is finite.
    expect(r).not.toBeNull();
    expect(Number.isFinite(r?.score ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(r?.requiredGb ?? Number.NaN)).toBe(true);
    expect(r?.runMode).not.toBe('gpu');
  });

  it('treats an Infinity availableRamGb as zero, never NaN', () => {
    const poisoned: HardwareProfile = {
      ...cpuOnlySystem,
      availableRamGb: Number.POSITIVE_INFINITY,
    };
    const r = analyzeModel(dense7b, poisoned, undefined, 'general');
    // Zero RAM budget -> too_tight, but a well-formed finite result.
    expect(r).not.toBeNull();
    expect(Number.isFinite(r?.score ?? Number.NaN)).toBe(true);
  });
});
