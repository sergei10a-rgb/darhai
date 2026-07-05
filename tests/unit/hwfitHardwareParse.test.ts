/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseNvidiaSmi,
  isNvidiaDriverError,
  withIndices,
  parseWindowsProbe,
  appleMetalBudgetGb,
  parseSysctlBytes,
  classifyAmdGfx,
  parseRocmGfx,
} from '@process/services/hwfit/hardwareParse';

describe('parseNvidiaSmi', () => {
  it('parses a single-GPU csv row into name + GB', () => {
    const gpus = parseNvidiaSmi('12282, NVIDIA GeForce RTX 4070');
    expect(gpus).toHaveLength(1);
    expect(gpus[0].name).toBe('NVIDIA GeForce RTX 4070');
    expect(gpus[0].vramGb).toBeCloseTo(11.99, 1);
  });

  it('parses multiple GPU rows', () => {
    const out = '24576, NVIDIA A100\n24576, NVIDIA A100';
    const gpus = parseNvidiaSmi(out);
    expect(gpus).toHaveLength(2);
  });

  it('skips rows with a non-numeric memory value (unified-memory parts)', () => {
    const out = '[N/A], NVIDIA GB10\n8192, NVIDIA RTX 4060';
    const gpus = parseNvidiaSmi(out);
    expect(gpus).toHaveLength(1);
    expect(gpus[0].name).toBe('NVIDIA RTX 4060');
  });

  it('returns an empty array for empty/garbage input', () => {
    expect(parseNvidiaSmi('')).toEqual([]);
    expect(parseNvidiaSmi('   \n  ')).toEqual([]);
  });

  it('does not evaluate a maliciously-crafted GPU name (treated as data)', () => {
    const out = '8192, $(rm -rf /); evil';
    const gpus = parseNvidiaSmi(out);
    expect(gpus).toHaveLength(1);
    // The name is stored verbatim as a string - never interpreted.
    expect(gpus[0].name).toBe('$(rm -rf /); evil');
  });
});

describe('isNvidiaDriverError', () => {
  it('detects a driver/library mismatch message', () => {
    expect(isNvidiaDriverError('Failed to initialize NVML: Driver/library version mismatch')).toBe(true);
  });

  it('is false for a normal csv row', () => {
    expect(isNvidiaDriverError('12282, NVIDIA GeForce RTX 4070')).toBe(false);
  });
});

describe('withIndices', () => {
  it('assigns sequential CUDA indices in row order', () => {
    const indexed = withIndices([
      { name: 'A', vramGb: 24 },
      { name: 'B', vramGb: 24 },
    ]);
    expect(indexed[0].index).toBe(0);
    expect(indexed[1].index).toBe(1);
  });
});

describe('parseWindowsProbe', () => {
  const goodJson = JSON.stringify({
    ram_gb: 64,
    avail_gb: 40,
    cpu_name: 'AMD Ryzen 9 7845HX',
    cpu_cores: 24,
    gpu_name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
    gpu_vram_gb: 8,
    gpu_count: 1,
    gpu_backend: 'cuda',
  });

  it('parses a full GPU probe result', () => {
    const info = parseWindowsProbe(goodJson);
    expect(info).not.toBeNull();
    expect(info?.totalRamGb).toBe(64);
    expect(info?.gpuName).toBe('NVIDIA GeForce RTX 4070 Laptop GPU');
    expect(info?.backend).toBe('cuda');
    expect(info?.gpuCount).toBe(1);
  });

  it('returns null on malformed JSON', () => {
    expect(parseWindowsProbe('{not json')).toBeNull();
  });

  it('returns null when RAM is 0 (probe failure signal)', () => {
    expect(parseWindowsProbe(JSON.stringify({ ram_gb: 0 }))).toBeNull();
  });

  it('reports a CPU-only machine (no GPU) without a VRAM value', () => {
    const info = parseWindowsProbe(JSON.stringify({ ram_gb: 16, avail_gb: 8, cpu_cores: 4, cpu_name: 'CPU' }));
    expect(info?.gpuName).toBeNull();
    expect(info?.gpuVramGb).toBeNull();
    expect(info?.backend).toBe('cpu_x86');
  });

  it('coerces a WMI backend that is not cuda to cpu_x86', () => {
    const info = parseWindowsProbe(
      JSON.stringify({ ram_gb: 16, gpu_name: 'Intel Iris', gpu_vram_gb: 2, gpu_count: 1, gpu_backend: 'cpu_x86' })
    );
    expect(info?.backend).toBe('cpu_x86');
  });
});

describe('appleMetalBudgetGb', () => {
  it('reserves more for the OS on small machines', () => {
    expect(appleMetalBudgetGb(16)).toBeCloseTo(10.7, 1);
    expect(appleMetalBudgetGb(48)).toBeCloseTo(36, 0);
    expect(appleMetalBudgetGb(128)).toBeCloseTo(102.4, 1);
  });

  it('returns 0 for a non-positive total', () => {
    expect(appleMetalBudgetGb(0)).toBe(0);
  });
});

describe('parseSysctlBytes', () => {
  it('converts bytes to GB', () => {
    expect(parseSysctlBytes(String(64 * 1024 ** 3))).toBeCloseTo(64, 5);
  });

  it('returns 0 for garbage', () => {
    expect(parseSysctlBytes('nope')).toBe(0);
    expect(parseSysctlBytes('')).toBe(0);
  });
});

describe('classifyAmdGfx', () => {
  it('maps consumer RDNA targets to the rdna family', () => {
    expect(classifyAmdGfx('gfx1100').family).toBe('rdna');
    expect(classifyAmdGfx('gfx1201').family).toBe('rdna');
  });

  it('maps datacenter Instinct targets to cdna', () => {
    expect(classifyAmdGfx('gfx908').family).toBe('cdna');
    expect(classifyAmdGfx('gfx942').family).toBe('cdna');
  });

  it('returns unknown for an unrecognized target', () => {
    expect(classifyAmdGfx('not-a-gfx').family).toBe('unknown');
  });
});

describe('parseRocmGfx', () => {
  it('extracts the first gfx target from rocminfo output', () => {
    expect(parseRocmGfx('  Name:  gfx1100  ')).toBe('gfx1100');
  });

  it('returns empty string when absent', () => {
    expect(parseRocmGfx('no target here')).toBe('');
  });
});
