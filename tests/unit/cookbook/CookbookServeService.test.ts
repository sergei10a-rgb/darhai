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
import type { LmStudioModel, LmStudioServerProbe } from '@process/services/cookbook/lmStudioDetect';
import type { CookbookRegistryRepo } from '@process/services/cookbook/cookbookProviderRegistration';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit';

const MODEL: CatalogModel = {
  name: 'org/Model',
  provider: 'org',
  parameterCount: '7B',
  quantization: 'Q4_K_M',
  ggufSources: [{ repo: 'org/Model-GGUF', provider: 'hf' }],
};

/** One entry of LM Studio's `/api/v0/models`, defaulted to a servable LLM. */
const lmModel = (over: Partial<LmStudioModel> & { id: string }): LmStudioModel => ({
  type: 'llm',
  state: 'not-loaded',
  ...over,
});

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
  serve: {
    start: ReturnType<typeof vi.fn>;
    startVllm: ReturnType<typeof vi.fn>;
    pullOllama: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  download: ReturnType<typeof vi.fn>;
  probeLmStudio: ReturnType<typeof vi.fn>;
  repo: { upsert: ReturnType<typeof vi.fn>; replaceCatalog: ReturnType<typeof vi.fn> };
};

/**
 * Fill in the backends a case does not care about. LM Studio contributes two
 * flags rather than one (its server is a GUI app the user starts, so installed
 * and serving are different facts), and both default to absent so no case below
 * silently acquires a backend it never asked for.
 */
const availability = (over: Partial<BackendAvailability>): BackendAvailability => ({
  ollama: false,
  llamaServer: false,
  vllm: false,
  lmStudioServing: false,
  lmStudioInstalled: false,
  ...over,
});

const makeService = (opts: {
  available: Partial<BackendAvailability>;
  hardware: HardwareProfile;
  arch?: string;
  catalog?: CatalogModel[];
  /** What LM Studio's own endpoint answers on this run. */
  lmStudio?: LmStudioServerProbe;
}): Harness => {
  const start = vi.fn(async () => 51500);
  const startVllm = vi.fn(async () => 51600);
  const pullOllama = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const available = availability(opts.available);

  const serveManager = {
    detectAvailability: vi.fn(async () => available),
    detectBackend: vi.fn(async () => 'none' as const),
    start,
    startVllm,
    pullOllama,
    stop,
    setBackendBinary: vi.fn(() => true),
  } as unknown as LocalServeManager;

  const download = vi.fn(async () => ({
    modelId: MODEL.name,
    filePath: '/cache/org_Model.gguf',
    cached: false,
    bytesWritten: 10,
  }));
  const downloadManager = {
    isDownloaded: vi.fn(() => false),
    download,
    cancel: vi.fn(() => false),
  } as unknown as ModelDownloadManager;

  const upsert = vi.fn();
  const replaceCatalog = vi.fn();
  const repo: CookbookRegistryRepo = {
    getRegistryProvider: vi.fn(() => null),
    upsertRegistryProvider: upsert,
    updateRegistryProviderState: vi.fn(),
    replaceRegistryCatalog: replaceCatalog,
  };

  // Throws rather than defaulting to the real probe: a case that reaches the LM
  // Studio path without declaring what LM Studio answers must FAIL here, never
  // fall through to the developer's own running LM Studio and diverge from CI.
  const probeLmStudio = vi.fn(async (): Promise<LmStudioServerProbe> => {
    if (!opts.lmStudio) throw new Error('probeLmStudio not stubbed by this test');
    return opts.lmStudio;
  });

  const deps: CookbookServeDeps = {
    downloadManager,
    serveManager,
    getCatalog: () => opts.catalog ?? [MODEL],
    getRepo: () => repo,
    getGgufDir: () => '/cache/gguf',
    getHardware: async () => opts.hardware,
    arch: opts.arch ?? 'x64',
    probeLmStudio,
  };
  return {
    service: new CookbookServeService(deps),
    serve: { start, startVllm, pullOllama, stop },
    download,
    probeLmStudio,
    repo: { upsert, replaceCatalog },
  };
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

/**
 * LM Studio is the one backend Darhai does not own: no download, no spawn, no
 * load. What it CAN get wrong is the identity of the model it registers, so
 * most of what follows pins the id matching to the two real namespaces.
 */
describe('CookbookServeService.serve via LM Studio', () => {
  /** A host whose only usable backend is a running LM Studio. */
  const lmStudioHost = profile({ platform: 'windows', backend: 'cuda', gpuVramGb: 8 });
  const servingLmStudio = { ollama: false, llamaServer: false, vllm: false, lmStudioServing: true };

  it('registers the already-running server without downloading or spawning', async () => {
    const { service, serve, download, repo } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: { serving: true, models: [lmModel({ id: 'org/Model' })] },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('ready');
    expect(status.backend).toBe('lm-studio');
    expect(status.servedModel).toBe('org/Model');
    expect(status.port).toBe(1234);
    expect(status.providerId).toBe('cookbook-local');
    // Nothing was fetched and nothing was launched - the whole point.
    expect(download).not.toHaveBeenCalled();
    expect(serve.start).not.toHaveBeenCalled();
    expect(serve.startVllm).not.toHaveBeenCalled();
    expect(serve.pullOllama).not.toHaveBeenCalled();
    // Keyless loopback provider at LM Studio's own endpoint.
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'cookbook-local',
        state: 'connected',
        creds: { key: '', baseUrl: 'http://127.0.0.1:1234/v1' },
      })
    );
    const [, models] = repo.replaceCatalog.mock.calls[0];
    expect(models[0].id).toBe('org/Model');
  });

  it("matches LM Studio's lowercased id against the catalog's cased HF repo", async () => {
    // The exact pair measured on the reference install: LM Studio reports
    // `qwen/qwen3.6-27b`, the catalog carries `Qwen/Qwen3.6-27B`.
    const cased: CatalogModel = { ...MODEL, name: 'Qwen/Qwen3.6-27B', ggufSources: [] };
    const { service } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      catalog: [cased],
      lmStudio: { serving: true, models: [lmModel({ id: 'qwen/qwen3.6-27b' })] },
    });

    const status = await service.serve('Qwen/Qwen3.6-27B');

    expect(status.state).toBe('ready');
    // LM Studio's own spelling is what the agent must send as `model`.
    expect(status.servedModel).toBe('qwen/qwen3.6-27b');
  });

  it('matches the GGUF repo the catalog lists when the HF name does not', async () => {
    const { service } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: { serving: true, models: [lmModel({ id: 'org/model-gguf' })] },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('ready');
    expect(status.servedModel).toBe('org/model-gguf');
  });

  it('prefers the build already loaded in memory over an unloaded one', async () => {
    const { service } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: {
        serving: true,
        models: [lmModel({ id: 'org/Model', state: 'not-loaded' }), lmModel({ id: 'org/Model-GGUF', state: 'loaded' })],
      },
    });

    const status = await service.serve(MODEL.name);

    expect(status.servedModel).toBe('org/Model-GGUF');
  });

  it('never serves an embeddings model, even when the id matches exactly', async () => {
    const { service, repo } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: { serving: true, models: [lmModel({ id: 'org/Model', type: 'embeddings', state: 'loaded' })] },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('error');
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it("does not serve another publisher's build of the same model name", async () => {
    // The catalog carries BOTH `openai/gpt-oss-20b` and `RedHatAI/gpt-oss-20b`.
    // A basename match would hand the first to a user who asked for the second.
    const redhat: CatalogModel = { ...MODEL, name: 'RedHatAI/gpt-oss-20b', ggufSources: [] };
    const { service, repo } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      catalog: [redhat],
      lmStudio: { serving: true, models: [lmModel({ id: 'openai/gpt-oss-20b', state: 'loaded' })] },
    });

    const status = await service.serve('RedHatAI/gpt-oss-20b');

    expect(status.state).toBe('error');
    expect(status.servedModel).toBeNull();
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('names what LM Studio does hold when it does not have the model', async () => {
    const { service } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: {
        serving: true,
        models: [lmModel({ id: 'supergemma4-26b-uncensored-v2' }), lmModel({ id: 'google/gemma-4-e4b' })],
      },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('error');
    expect(status.error).toContain('org/Model');
    expect(status.error).toContain('supergemma4-26b-uncensored-v2');
  });

  it('fails honestly when LM Studio was closed after the dropdown was built', async () => {
    const { service, repo } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: { serving: false, models: [] },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('error');
    expect(status.backend).toBe('lm-studio');
    expect(repo.upsert).not.toHaveBeenCalled();
  });

  it('stops the server Darhai spawned before handing the provider to LM Studio', async () => {
    // `stop()` reaps only this manager's own child - LM Studio is never touched -
    // but a llama-server left running would hold the GPU with no provider on it.
    const { service, serve } = makeService({
      hardware: lmStudioHost,
      available: { ...servingLmStudio, llamaServer: true },
      lmStudio: { serving: true, models: [lmModel({ id: 'org/Model' })] },
    });

    const status = await service.serve(MODEL.name, 'lm-studio');

    expect(status.backend).toBe('lm-studio');
    expect(serve.stop).toHaveBeenCalled();
    expect(serve.start).not.toHaveBeenCalled();
  });

  it('is chosen over llama.cpp but not over ollama', async () => {
    const { service } = makeService({
      hardware: lmStudioHost,
      available: { ...servingLmStudio, llamaServer: true },
      lmStudio: { serving: true, models: [] },
    });
    expect((await service.backendSelection()).chosen).toBe('lm-studio');

    const withOllama = makeService({
      hardware: lmStudioHost,
      available: { ...servingLmStudio, ollama: true },
      lmStudio: { serving: true, models: [] },
    });
    const sel = await withOllama.service.backendSelection();
    expect(sel.chosen).toBe('ollama');
    expect(sel.viable).toContain('lm-studio');
  });
});
