/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getCatalog, getCatalogSize } from '@process/services/hwfit/modelCatalog';
import { rankCatalog } from '@process/services/hwfit';
import { paramsB } from '@process/services/hwfit/quantTables';
import type { HardwareProfile } from '@process/services/hwfit/types';

/**
 * A parameter-size token inside a repo name: "-7B", "1.2B", "135M", "1.5T".
 * The character before it must not be a letter, digit, `.` or `_`, so the "6b"
 * inside "stablelm-2-1_6b" (which means 1.6B) is not read as 6B. The largest
 * token wins, so "Qwen3-30B-A3B" is read as its 30B total, not its 3B active.
 */
const NAME_SIZE_TOKEN = /(?:^|[^a-z0-9._])(\d+(?:\.\d+)?)([bmt])(?![a-z0-9])/gi;

/** Largest parameter size (in billions) declared by a repo name, or null. */
function nameDeclaredParamsB(name: string): number | null {
  let best: number | null = null;
  let m: RegExpExecArray | null;
  NAME_SIZE_TOKEN.lastIndex = 0;
  while ((m = NAME_SIZE_TOKEN.exec(name)) !== null) {
    const value = Number(m[1]);
    const unit = m[2].toLowerCase();
    const billions = unit === 'b' ? value : unit === 'm' ? value / 1000 : value * 1000;
    // Above ~3T is a date, a step count or a rank, not a parameter count.
    if (billions > 0 && billions < 3000) best = best === null ? billions : Math.max(best, billions);
  }
  return best;
}

/**
 * Repos whose element count legitimately sits far below the size in their
 * name: MLX/NVFP4-style repos publish PACKED sub-byte weights, and a
 * speculative-decoding draft head is a small model named after the big model
 * it drafts for.
 */
const PACKED_OR_DRAFT = /mlx|speculator|eagle|dflash|draft/i;

/**
 * How far below its own name a row's parameter count may sit before it is a
 * data defect. MEASURED over the shipped catalog: the largest legitimate gap
 * among the 620 checked rows is 1.93x (nvidia/Qwen3-30B-A3B-NVFP4, 15.58B
 * packed elements for a 30B model), so 10x leaves a 5x margin.
 */
const MAX_NAME_UNDERSTATEMENT = 10;

describe('bundled model catalog', () => {
  const catalog = getCatalog();

  it('is a non-empty array', () => {
    expect(Array.isArray(catalog)).toBe(true);
    expect(catalog.length).toBeGreaterThan(500);
    expect(getCatalogSize()).toBe(catalog.length);
  });

  it('every entry has the required identity fields', () => {
    for (const m of catalog) {
      expect(typeof m.name).toBe('string');
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.provider).toBe('string');
      expect(typeof m.parameterCount).toBe('string');
    }
  });

  it('MoE entries carry active-parameter metadata', () => {
    const moes = catalog.filter((m) => m.isMoe);
    expect(moes.length).toBeGreaterThan(0);
    for (const m of moes) {
      expect(typeof m.activeParameters === 'number' || m.activeParameters === undefined).toBe(true);
    }
  });

  it('gguf sources, when present, are well-formed', () => {
    for (const m of catalog) {
      if (!m.ggufSources) continue;
      for (const g of m.ggufSources) {
        expect(typeof g.repo).toBe('string');
        expect(typeof g.provider).toBe('string');
      }
    }
  });

  it('no row records a parameter count its own name contradicts', () => {
    // The defect this catches, as shipped: allenai/Olmo-3-7B-Instruct and
    // -Think carried parametersRaw 528384 - 0.5M parameters for a 7B model,
    // 13,248x below the name. Every downstream number is derived from that
    // count, so the advisor put those rows at rank #1 by speed claiming
    // 1,049,236.9 tok/s in 0.5 GB of VRAM. Nothing else in the pipeline can
    // notice: the memory estimate, the fit level and the speed estimate all
    // read the same wrong number and agree with each other.
    const offenders: string[] = [];
    for (const m of catalog) {
      if (PACKED_OR_DRAFT.test(m.name)) continue;
      const recorded = paramsB(m);
      if (recorded <= 0) continue;
      const declared = nameDeclaredParamsB(m.name);
      if (declared === null) continue;
      if (declared / recorded > MAX_NAME_UNDERSTATEMENT) {
        offenders.push(`${m.name}: name says ${declared}B, row says ${recorded.toFixed(6)}B`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the contradiction check would actually catch the shipped defect', () => {
    // Guard the guard: the regex, the exclusions and the threshold above must
    // still flag an Olmo-shaped row, or the test above is decoration.
    const broken = { name: 'allenai/Olmo-3-7B-Instruct', parametersRaw: 528384, parameterCount: '528K' };
    expect(nameDeclaredParamsB(broken.name)).toBe(7);
    expect(PACKED_OR_DRAFT.test(broken.name)).toBe(false);
    expect(7 / paramsB(broken) > MAX_NAME_UNDERSTATEMENT).toBe(true);
  });

  it('does not flag a MoE repo named after its active parameters', () => {
    // Llama-4-Maverick-17B-128E is 401.6B total with 17B active; the name is
    // 23x BELOW the row, which is the opposite direction and legitimate.
    const maverick = catalog.find((m) => m.name === 'meta-llama/Llama-4-Maverick-17B-128E-Instruct');
    expect(maverick).toBeDefined();
    if (maverick) {
      const declared = nameDeclaredParamsB(maverick.name) ?? 0;
      expect(declared / paramsB(maverick)).toBeLessThan(1);
    }
  });
});

describe('rankCatalog integration', () => {
  const rig: HardwareProfile = {
    totalRamGb: 64,
    availableRamGb: 48,
    cpuCores: 16,
    cpuName: 'Test CPU',
    hasGpu: true,
    gpuName: 'NVIDIA GeForce RTX 4090',
    gpuVramGb: 24,
    gpuCount: 1,
    gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 4090', vramGb: 24 }],
    backend: 'cuda',
    platform: 'linux',
  };

  it('ranks the real catalog for a 24 GB GPU and returns fitting models', () => {
    const ranked = rankCatalog(rig, { useCase: 'general', limit: 20, fitOnly: true });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThanOrEqual(20);
    expect(ranked.every((r) => r.fitLevel !== 'too_tight')).toBe(true);
    // Results are score-sorted descending.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it('returns coding-only models when the coding use-case is picked', () => {
    const ranked = rankCatalog(rig, { useCase: 'coding', limit: 30 });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.useCase === 'coding')).toBe(true);
  });
});
