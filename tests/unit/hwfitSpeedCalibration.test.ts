/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ties the advisor's tok/s column to numbers that were actually measured.
 *
 * Every expectation here is a real run on the reference machine (RTX 4070
 * Laptop 8 GB / Ryzen 9 7845HX / 64 GB, llama.cpp b10441), served through the
 * same `llama-server` the Cookbook spawns and read from the server's own
 * `timings.predicted_per_second`. If someone reverts a calibration constant,
 * these go red with the measured number in the diff.
 *
 * Only models that sit entirely in VRAM are asserted against a number. A model
 * larger than the card is dominated by host paging and measured anywhere from
 * 8.5 to 20.1 tok/s across runs on the same machine, which is not a
 * calibration target - see the note in speedModel.ts.
 */

import { describe, it, expect } from 'vitest';
import { GPU_BANDWIDTH, estimateSpeed, lookupBandwidth } from '@process/services/hwfit/speedModel';
import { analyzeModel } from '@process/services/hwfit/fitScore';
import { getCatalog } from '@process/services/hwfit/modelCatalog';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit/types';

/** The machine every measurement below was taken on. */
const REFERENCE_RIG: HardwareProfile = {
  totalRamGb: 64,
  availableRamGb: 48,
  cpuCores: 12,
  cpuName: 'AMD Ryzen 9 7845HX',
  hasGpu: true,
  gpuName: 'NVIDIA GeForce RTX 4070 Laptop GPU',
  gpuVramGb: 8,
  gpuCount: 1,
  gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 4070 Laptop GPU', vramGb: 8 }],
  backend: 'cuda',
  platform: 'windows',
};

/** Measured decode rate, and how far the estimate may sit from it. */
type SpeedCase = { name: string; measuredTps: number; tolerance: number };

/**
 * Median of three warm runs each. Before calibration these two were predicted
 * at 1122.2 and 72.8 tok/s - 3.8x and 2.1x optimistic.
 */
const MEASURED: readonly SpeedCase[] = [
  { name: 'Qwen/Qwen2.5-0.5B-Instruct', measuredTps: 299.44, tolerance: 0.15 },
  { name: 'Qwen/Qwen2.5-7B-Instruct', measuredTps: 33.97, tolerance: 0.15 },
];

/** Ordering must hold for the whole measured set, including the 20B. */
const ORDER_BY_DESCENDING_SPEED = ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-7B-Instruct', 'openai/gpt-oss-20b'];

function catalogRow(name: string): CatalogModel {
  const row = getCatalog().find((m) => m.name === name);
  if (!row) throw new Error(`reference model missing from the catalog: ${name}`);
  return row;
}

describe('advisor speed estimate against measured llama-server throughput', () => {
  it.each(MEASURED)('$name is predicted within tolerance of $measuredTps tok/s', (probe) => {
    const result = analyzeModel(catalogRow(probe.name), REFERENCE_RIG, undefined, 'general', 0);
    expect(result).not.toBeNull();
    const predicted = result?.speedTps ?? 0;
    const relativeError = Math.abs(predicted - probe.measuredTps) / probe.measuredTps;
    expect(relativeError).toBeLessThanOrEqual(probe.tolerance);
  });

  it('keeps the ordering the three measured models actually have', () => {
    const predicted = ORDER_BY_DESCENDING_SPEED.map((name) =>
      analyzeModel(catalogRow(name), REFERENCE_RIG, undefined, 'general', 0)
    );
    expect(predicted.every((r) => r !== null)).toBe(true);
    for (let i = 1; i < predicted.length; i++) {
      expect(predicted[i - 1]?.speedTps ?? 0).toBeGreaterThan(predicted[i]?.speedTps ?? 0);
    }
  });
});

describe('mobile GPUs are not given their desktop namesake bandwidth', () => {
  it('reads the reference laptop GPU as its own 128-bit part', () => {
    // nvidia-smi reports the full "... Laptop GPU" string; the substring
    // lookup used to land on the desktop 4070's 504 GB/s.
    expect(lookupBandwidth('NVIDIA GeForce RTX 4070 Laptop GPU')).toBe(256);
    expect(lookupBandwidth('NVIDIA GeForce RTX 4070')).toBe(504);
  });

  it('never rates a laptop part above its desktop namesake', () => {
    const overrated: string[] = [];
    for (const [key, value] of Object.entries(GPU_BANDWIDTH)) {
      if (!key.endsWith(' laptop')) continue;
      const desktop = GPU_BANDWIDTH[key.slice(0, -' laptop'.length)];
      if (typeof desktop === 'number' && value > desktop) {
        overrated.push(`${key}=${value} > ${key.slice(0, -' laptop'.length)}=${desktop}`);
      }
    }
    expect(overrated).toEqual([]);
  });

  it('has a laptop entry for every mobile SKU it claims to cover', () => {
    const laptopKeys = Object.keys(GPU_BANDWIDTH).filter((k) => k.endsWith(' laptop'));
    expect(laptopKeys.length).toBeGreaterThan(10);
    // Longest-first matching is what makes the laptop key win; a key that is
    // not longer than its desktop sibling would never be reached.
    for (const key of laptopKeys) {
      expect(key.length).toBeGreaterThan(key.slice(0, -' laptop'.length).length);
    }
  });

  it('reads a Turing Max-Q part as its own mobile SKU, not its desktop namesake', () => {
    // The driver reports Turing mobiles as "... with Max-Q Design" - there is
    // no "Laptop" token - so these used to resolve to the desktop key. Each
    // expectation is bus width x memory data rate / 8 for the Max-Q variant.
    expect(lookupBandwidth('NVIDIA GeForce RTX 2080 Super with Max-Q Design')).toBe(352);
    expect(lookupBandwidth('NVIDIA GeForce RTX 2080 with Max-Q Design')).toBe(384);
    expect(lookupBandwidth('NVIDIA GeForce RTX 2070 Super with Max-Q Design')).toBe(352);
    expect(lookupBandwidth('NVIDIA GeForce RTX 2070 with Max-Q Design')).toBe(384);
    expect(lookupBandwidth('NVIDIA GeForce RTX 2060 with Max-Q Design')).toBe(264);
    expect(lookupBandwidth('NVIDIA GeForce GTX 1660 Ti with Max-Q Design')).toBe(288);
    // The desktop names must be untouched by the mobile keys.
    expect(lookupBandwidth('NVIDIA GeForce RTX 2080 Super')).toBe(496);
    expect(lookupBandwidth('NVIDIA GeForce RTX 2070')).toBe(448);
  });

  it('matches the shorter "Max-Q" spelling some driver versions report', () => {
    // The same physical part crosses nvidia-smi as either "... with Max-Q
    // Design" or "... Max-Q" depending on driver generation; both must land
    // on the mobile key.
    expect(lookupBandwidth('GeForce RTX 2080 Super Max-Q')).toBe(352);
    expect(lookupBandwidth('GeForce RTX 2060 Max-Q')).toBe(264);
  });

  it('never rates a Max-Q part above its desktop namesake', () => {
    const overrated: string[] = [];
    for (const [key, value] of Object.entries(GPU_BANDWIDTH)) {
      if (!key.endsWith(' max-q')) continue;
      const desktop = GPU_BANDWIDTH[key.slice(0, -' max-q'.length)];
      if (typeof desktop === 'number' && value > desktop) {
        overrated.push(`${key}=${value} > ${key.slice(0, -' max-q'.length)}=${desktop}`);
      }
    }
    expect(overrated).toEqual([]);
  });
});

describe('per-token overhead bounds the estimate for tiny models', () => {
  const tiny: CatalogModel = {
    name: 'test/impossible-row',
    provider: 'test',
    parameterCount: '528K',
    parametersRaw: 528384,
    quantization: 'Q4_K_M',
  };

  it('a half-million-parameter row cannot claim a million tok/s', () => {
    // This is what the shipped model returned for the broken Olmo rows:
    // 1,049,236.9 tok/s, because throughput was bandwidth/modelSize with no
    // per-token cost, so it went to infinity as the model shrank.
    const tps = estimateSpeed(tiny, 'Q4_K_M', 'gpu', {
      gpuName: 'NVIDIA GeForce RTX 4070 Laptop GPU',
      backend: 'cuda',
    });
    expect(tps).toBeGreaterThan(0);
    expect(tps).toBeLessThan(1000);
  });

  it('bounds the no-known-bandwidth fallback the same way', () => {
    const tps = estimateSpeed(tiny, 'Q4_K_M', 'cpu_only', { gpuName: 'Some Unlisted GPU', backend: 'cpu_x86' });
    expect(tps).toBeGreaterThan(0);
    expect(tps).toBeLessThan(1000);
  });

  it('still ranks a small model faster than a large one', () => {
    const large: CatalogModel = { ...tiny, name: 'test/large', parameterCount: '70B', parametersRaw: 70_000_000_000 };
    const system = { gpuName: 'NVIDIA GeForce RTX 4090', backend: 'cuda' as const };
    expect(estimateSpeed(tiny, 'Q4_K_M', 'gpu', system)).toBeGreaterThan(estimateSpeed(large, 'Q4_K_M', 'gpu', system));
  });
});
