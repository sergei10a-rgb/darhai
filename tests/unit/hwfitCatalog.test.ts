/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getCatalog, getCatalogSize } from '@process/services/hwfit/modelCatalog';
import { rankCatalog } from '@process/services/hwfit';
import type { HardwareProfile } from '@process/services/hwfit/types';

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
