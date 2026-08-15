/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { CookbookServeService, type CookbookServeDeps } from '@process/services/cookbook/CookbookServeService';
import type { LocalServeManager } from '@process/services/cookbook/LocalServeManager';
import type { ModelDownloadManager } from '@process/services/cookbook/ModelDownloadManager';
import type { BackendAvailability } from '@process/services/cookbook/backendPolicy';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit';

const MODEL: CatalogModel = {
  name: 'org/Model',
  provider: 'org',
  parameterCount: '7B',
  quantization: 'Q4_K_M',
  ggufSources: [{ repo: 'org/Model-GGUF', provider: 'hf' }],
};

const profile = (over: Partial<HardwareProfile> = {}): HardwareProfile => ({
  totalRamGb: 64,
  availableRamGb: 32,
  cpuCores: 16,
  cpuName: 'Test CPU',
  hasGpu: true,
  gpuName: 'Test GPU',
  gpuVramGb: 24,
  gpuCount: 1,
  gpus: [{ index: 0, name: 'Test GPU', vramGb: 24 }],
  backend: 'cuda',
  platform: 'linux',
  gpuError: null,
  ...over,
});

type Harness = {
  service: CookbookServeService;
  serve: { start: ReturnType<typeof vi.fn>; startVllm: ReturnType<typeof vi.fn>; pullOllama: ReturnType<typeof vi.fn> };
};

const makeService = (opts: { available: BackendAvailability; hardware: HardwareProfile; arch?: string }): Harness => {
  const start = vi.fn(async () => 51500);
  const startVllm = vi.fn(async () => 51600);
  const pullOllama = vi.fn(async () => undefined);

  const serveManager = {
    detectAvailability: vi.fn(async () => opts.available),
    detectBackend: vi.fn(async () => 'none' as const),
    start,
    startVllm,
    pullOllama,
    stop: vi.fn(async () => undefined),
    setBackendBinary: vi.fn(() => true),
  } as unknown as LocalServeManager;

  const downloadManager = {
    isDownloaded: vi.fn(() => false),
    download: vi.fn(async () => ({
      modelId: MODEL.name,
      filePath: '/cache/org_Model.gguf',
      cached: false,
      bytesWritten: 10,
    })),
    cancel: vi.fn(() => false),
  } as unknown as ModelDownloadManager;

  const deps: CookbookServeDeps = {
    downloadManager,
    serveManager,
    getCatalog: () => [MODEL],
    getRepo: () => null,
    getGgufDir: () => '/cache/gguf',
    getHardware: async () => opts.hardware,
    arch: opts.arch ?? 'x64',
  };
  return { service: new CookbookServeService(deps), serve: { start, startVllm, pullOllama } };
};

describe('CookbookServeService.backendSelection (hardware-adaptive)', () => {
  it('offers vLLM on a Linux CUDA box with ample VRAM + vllm installed', async () => {
    const { service } = makeService({
      hardware: profile({ vramGb: 24 }),
      available: { ollama: true, llamaServer: true, vllm: true },
    });
    const sel = await service.backendSelection();
    expect(sel.chosen).toBe('vllm');
    expect(sel.viable).toContain('vllm');
  });

  it('does NOT offer vLLM on an 8GB Windows box (chooses llama-server)', async () => {
    const { service } = makeService({
      hardware: profile({ platform: 'windows', backend: 'cpu_x86', gpuVramGb: 8, hasGpu: true }),
      available: { ollama: false, llamaServer: true, vllm: false },
    });
    const sel = await service.backendSelection();
    expect(sel.viable).not.toContain('vllm');
    expect(sel.chosen).toBe('llama-server');
  });

  it("offers Darhai's own llama.cpp to a machine that only has ollama", async () => {
    // The machine the defect was invisible on: a working backend is installed,
    // so `chosen` is never `'none'` and the provisioning path never opens - and
    // llama.cpp was not in the override list either.
    const { service } = makeService({
      hardware: profile({ platform: 'windows', backend: 'cuda', gpuVramGb: 8 }),
      available: { ollama: true, llamaServer: false, vllm: false },
    });
    const sel = await service.backendSelection();
    expect(sel.chosen).toBe('ollama');
    expect(sel.provisionable).toEqual(['llama-server']);
  });

  it('offers nothing installable on an architecture with no published build', async () => {
    const { service } = makeService({
      hardware: profile({ platform: 'windows', backend: 'cpu_x86', gpuVramGb: 0, hasGpu: false }),
      available: { ollama: true, llamaServer: false, vllm: false },
      arch: 'ia32',
    });
    expect((await service.backendSelection()).provisionable).toEqual([]);
  });
});

describe('CookbookServeService.serve (hardware-driven dispatch)', () => {
  it('serves the HF repo via vLLM (no GGUF download) on capable hardware', async () => {
    const { service, serve } = makeService({
      hardware: profile({ vramGb: 24 }),
      available: { ollama: false, llamaServer: false, vllm: true },
    });
    const status = await service.serve(MODEL.name);
    expect(serve.startVllm).toHaveBeenCalledWith({ hfRepo: 'org/Model' });
    expect(serve.start).not.toHaveBeenCalled();
    expect(status.state).toBe('ready');
    expect(status.backend).toBe('vllm');
    expect(status.servedModel).toBe('org/Model');
  });

  it('downloads a GGUF + spawns llama-server on an 8GB box', async () => {
    const { service, serve } = makeService({
      hardware: profile({ platform: 'windows', backend: 'cpu_x86', gpuVramGb: 8 }),
      available: { ollama: false, llamaServer: true, vllm: false },
    });
    const status = await service.serve(MODEL.name);
    expect(serve.start).toHaveBeenCalledWith({ ggufPath: '/cache/org_Model.gguf', ngl: expect.any(Number) });
    expect(serve.startVllm).not.toHaveBeenCalled();
    expect(status.backend).toBe('llama-server');
    expect(status.state).toBe('ready');
  });

  it('honours a viable backend override (ollama) over the default (vllm)', async () => {
    const { service, serve } = makeService({
      hardware: profile({ vramGb: 24 }),
      available: { ollama: true, llamaServer: true, vllm: true },
    });
    const status = await service.serve(MODEL.name, 'ollama');
    expect(serve.pullOllama).toHaveBeenCalled();
    expect(serve.startVllm).not.toHaveBeenCalled();
    expect(status.backend).toBe('ollama');
  });

  it('ignores a non-viable override and uses the hardware default', async () => {
    const { service, serve } = makeService({
      hardware: profile({ platform: 'windows', backend: 'cpu_x86', gpuVramGb: 8 }),
      available: { ollama: false, llamaServer: true, vllm: false },
    });
    // vllm is not viable here; the override is dropped, llama-server default used.
    const status = await service.serve(MODEL.name, 'vllm');
    expect(serve.startVllm).not.toHaveBeenCalled();
    expect(serve.start).toHaveBeenCalled();
    expect(status.backend).toBe('llama-server');
  });
});
