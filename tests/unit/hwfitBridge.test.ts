/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HwfitHardware, HwfitRankOptions } from '@/common/types/hwfit';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

// Capture provider handlers so tests can invoke them directly.
const handlers: Record<string, (...args: any[]) => any> = {};
function makeProvider(name: string) {
  return {
    provider: vi.fn((fn: (...args: any[]) => any) => {
      handlers[name] = fn;
    }),
    emit: vi.fn(),
    invoke: vi.fn(),
  };
}

vi.mock('../../src/common/adapter/ipcBridge', () => ({
  hwfit: {
    scanHardware: makeProvider('scanHardware'),
    rankModels: makeProvider('rankModels'),
    catalogSize: makeProvider('catalogSize'),
  },
}));

// Mock the hwfit service so we can assert exactly what the bridge forwards to
// the ranker (the clamped/validated system + options) and to scanHardware.
const mockScanHardware = vi.fn(async () => ({ backend: 'cpu_x86', hasGpu: false }) as unknown);
const mockRankCatalog = vi.fn(() => [] as unknown[]);
const mockGetCatalogSize = vi.fn(() => 42);

vi.mock('@process/services/hwfit', () => ({
  scanHardware: (...args: unknown[]) => mockScanHardware(...args),
  rankCatalog: (...args: unknown[]) => mockRankCatalog(...args),
  getCatalogSize: (...args: unknown[]) => mockGetCatalogSize(...args),
}));

import { initHwfitBridge } from '@process/bridge/hwfitBridge';

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(handlers)) delete handlers[k];
  initHwfitBridge();
});

/** A minimal, well-formed override the tests mutate to inject hostile values. */
function baseOverride(): HwfitHardware {
  return {
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
}

/** Invoke rankModels and return the (system, options) tuple passed to rankCatalog. */
async function invokeRank(opts: HwfitRankOptions): Promise<{ system: any; options: any }> {
  await handlers.rankModels(opts);
  const call = mockRankCatalog.mock.calls.at(-1)!;
  return { system: call[0], options: call[1] };
}

describe('hwfitBridge - override validation (H-2)', () => {
  it('clamps non-finite / negative numeric fields to safe defaults', async () => {
    const hostile = {
      ...baseOverride(),
      totalRamGb: Number.NaN,
      availableRamGb: -100,
      gpuVramGb: Number.POSITIVE_INFINITY,
      cpuCores: -4,
      gpuCount: -2,
    } as unknown as HwfitHardware;

    const { system } = await invokeRank({ hardwareOverride: hostile });

    expect(system.totalRamGb).toBe(0);
    expect(system.availableRamGb).toBe(0);
    // Infinity is not a finite non-negative number -> gpuVramGb collapses to null.
    expect(system.gpuVramGb).toBeNull();
    expect(system.cpuCores).toBe(0);
    expect(system.gpuCount).toBe(0);
  });

  it('truncates fractional counts and preserves valid values', async () => {
    const { system } = await invokeRank({
      hardwareOverride: { ...baseOverride(), gpuCount: 2.9, cpuCores: 8.7 },
    });
    expect(system.gpuCount).toBe(2);
    expect(system.cpuCores).toBe(8);
    expect(system.gpuVramGb).toBe(24);
  });

  it('coerces an invalid backend / platform to safe enum members', async () => {
    const { system } = await invokeRank({
      hardwareOverride: { ...baseOverride(), backend: 'evil' as any, platform: 'pwned' as any },
    });
    expect(system.backend).toBe('cpu_x86');
    expect(system.platform).toBe('unknown');
  });

  it('caps over-long strings and bounds the gpus array', async () => {
    const longName = 'x'.repeat(5000);
    const manyGpus = Array.from({ length: 500 }, (_, i) => ({ index: i, name: 'g', vramGb: 1 }));
    const { system } = await invokeRank({
      hardwareOverride: { ...baseOverride(), gpuName: longName, gpus: manyGpus },
    });
    expect(system.gpuName.length).toBeLessThanOrEqual(256);
    expect(system.gpus.length).toBeLessThanOrEqual(64);
  });
});

describe('hwfitBridge - rank options validation (H-2)', () => {
  it('clamps the limit into [1, 200]', async () => {
    let out = await invokeRank({ hardwareOverride: baseOverride(), limit: 100000 });
    expect(out.options.limit).toBe(200);

    out = await invokeRank({ hardwareOverride: baseOverride(), limit: -5 });
    expect(out.options.limit).toBe(1);

    out = await invokeRank({ hardwareOverride: baseOverride(), limit: Number.NaN });
    expect(out.options.limit).toBe(50);
  });

  it('drops an invalid useCase / sort instead of forwarding it', async () => {
    const { options } = await invokeRank({
      hardwareOverride: baseOverride(),
      useCase: 'malware' as any,
      sort: 'drop-tables' as any,
    });
    expect(options.useCase).toBeUndefined();
    expect(options.sort).toBeUndefined();
  });

  it('zeroes a non-positive / non-finite targetContext', async () => {
    let out = await invokeRank({ hardwareOverride: baseOverride(), targetContext: -1 });
    expect(out.options.targetContext).toBe(0);

    out = await invokeRank({ hardwareOverride: baseOverride(), targetContext: Number.POSITIVE_INFINITY });
    expect(out.options.targetContext).toBe(0);
  });

  it('caps an over-long search string', async () => {
    const { options } = await invokeRank({
      hardwareOverride: baseOverride(),
      search: 'q'.repeat(9999),
    });
    expect((options.search as string).length).toBeLessThanOrEqual(256);
  });
});

describe('hwfitBridge - scanHardware routing', () => {
  it('probes the host (no override) via scanHardware, not an override', async () => {
    await invokeRank({ useCase: 'general' });
    expect(mockScanHardware).toHaveBeenCalledWith(false);
  });

  it('skips the probe entirely when an override is supplied', async () => {
    await invokeRank({ hardwareOverride: baseOverride() });
    expect(mockScanHardware).not.toHaveBeenCalled();
  });

  it('forwards the fresh flag from scanHardware provider params', async () => {
    await handlers.scanHardware({ fresh: true });
    expect(mockScanHardware).toHaveBeenCalledWith(true);
  });

  it('catalogSize returns the service count', async () => {
    const size = await handlers.catalogSize();
    expect(size).toBe(42);
  });
});
