/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { settleTurns } from '../../helpers/eventLoop';
import { CookbookServeService, type CookbookServeDeps } from '@process/services/cookbook/CookbookServeService';
import type { LocalServeManager } from '@process/services/cookbook/LocalServeManager';
import type { ModelDownloadManager } from '@process/services/cookbook/ModelDownloadManager';
import type { BackendAvailability } from '@process/services/cookbook/backendPolicy';
import { LM_STUDIO_DEFAULT_PORT } from '@process/services/cookbook/lmStudioDetect';
import type { LmStudioModel, LmStudioServeProbe, LmStudioServerProbe } from '@process/services/cookbook/lmStudioDetect';
import type { CookbookRegistryRepo } from '@process/services/cookbook/cookbookProviderRegistration';
import type { CatalogModel, HardwareProfile } from '@process/services/hwfit';

/** Placeholder callable, hoisted so the linter does not see a per-call closure. */
const NOOP = (): void => undefined;

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
  lmStudio?: LmStudioServerProbe & { port?: number };
  /** MoE offload planner; absent = the pre-MoE service (production default). */
  planNCpuMoe?: CookbookServeDeps['planNCpuMoe'];
  /** Abort hook for the in-flight calibration bench (moeCalibration.cancel). */
  cancelCalibration?: CookbookServeDeps['cancelCalibration'];
  /** Collects every status frame the service emits, in order. */
  statuses?: Array<{ state: string }>;
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
  const probeLmStudio = vi.fn(async (): Promise<LmStudioServeProbe> => {
    if (!opts.lmStudio) throw new Error('probeLmStudio not stubbed by this test');
    // Default to LM Studio's stock port; a test proves port threading by
    // overriding it (the registered baseUrl must follow the probe's port).
    return { port: LM_STUDIO_DEFAULT_PORT, ...opts.lmStudio };
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
    planNCpuMoe: opts.planNCpuMoe,
    cancelCalibration: opts.cancelCalibration,
    onStatus: opts.statuses ? (s) => opts.statuses?.push({ state: s.state }) : undefined,
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

  it('registers a server the user moved off 1234 at its DETECTED port', async () => {
    // The probe carries the port it actually found the models on (measured:
    // `lms server status --json` reports the configured port even when the
    // server was relocated). The registered baseUrl must follow it - the old
    // code pinned 1234 here and handed the agent a dead URL.
    const { service, repo } = makeService({
      hardware: lmStudioHost,
      available: servingLmStudio,
      lmStudio: { serving: true, models: [lmModel({ id: 'org/Model' })], port: 12399 },
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('ready');
    expect(status.port).toBe(12399);
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ creds: { key: '', baseUrl: 'http://127.0.0.1:12399/v1' } })
    );
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

/**
 * MoE expert offload on the llama-server path. The planner is a seam
 * (moeCalibration.ts in production); what these cases pin is the CONTRACT
 * around it: when it answers, its number reaches the spawn; when it is absent,
 * fails, or declines, the serve is byte-identical to the pre-MoE service.
 */
describe('CookbookServeService: MoE expert offload', () => {
  const moeModel: CatalogModel = { ...MODEL, isMoe: true };
  const gpu8 = profile({ platform: 'windows', gpuVramGb: 8 });

  it('passes the planned --n-cpu-moe to the spawn and reports a calibrating phase', async () => {
    const statuses: Array<{ state: string }> = [];
    const planNCpuMoe = vi.fn(async (req: { onCalibrating?: () => void }) => {
      req.onCalibrating?.();
      return 36;
    });
    const { service, serve } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe,
      statuses,
    });

    const status = await service.serve(MODEL.name);

    expect(status.state).toBe('ready');
    expect(serve.start).toHaveBeenCalledWith(expect.objectContaining({ nCpuMoe: 36 }));
    // The planner was told everything it keys the cache by, plus the hint.
    expect(planNCpuMoe).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: MODEL.name,
        ggufPath: '/cache/org_Model.gguf',
        isMoeHint: true,
        gpuName: 'Test GPU',
        vramGb: 8,
      })
    );
    // The calibration got its own visible phase, between download and start.
    const calibratingAt = statuses.findIndex((s) => s.state === 'calibrating');
    const readyAt = statuses.findIndex((s) => s.state === 'ready');
    expect(calibratingAt).toBeGreaterThanOrEqual(0);
    expect(calibratingAt).toBeLessThan(readyAt);
  });

  it('serves without the flag when the planner answers null', async () => {
    const { service, serve } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      planNCpuMoe: async () => null,
    });
    const status = await service.serve(MODEL.name);
    expect(status.state).toBe('ready');
    expect(serve.start).toHaveBeenCalledWith(expect.objectContaining({ nCpuMoe: undefined }));
  });

  it('serves exactly as before when no planner is wired at all', async () => {
    const { service, serve } = makeService({ available: { llamaServer: true }, hardware: gpu8, catalog: [moeModel] });
    const status = await service.serve(MODEL.name);
    expect(status.state).toBe('ready');
    expect(serve.start).toHaveBeenCalledWith(expect.objectContaining({ nCpuMoe: undefined }));
  });

  it('a planner that throws costs the optimisation, never the serve', async () => {
    const { service, serve } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe: async () => {
        throw new Error('bench exploded');
      },
    });
    const status = await service.serve(MODEL.name);
    expect(status.state).toBe('ready');
    expect(serve.start).toHaveBeenCalledWith(expect.objectContaining({ nCpuMoe: undefined }));
  });

  it('the degraded copy-command carries the MoE combination too', async () => {
    const { service } = makeService({
      available: {},
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe: async () => 40,
    });
    const status = await service.serve(MODEL.name);
    expect(status.state).toBe('needs_backend');
    expect(status.serveCommand).toContain('--n-gpu-layers 99 --n-cpu-moe 40');
  });
});

/**
 * A Stop pressed DURING the calibration minutes must actually stop things.
 *
 * Calibration is the one multi-minute window between the press and the spawn.
 * Before the fix, `stopServe` inside that window only flipped the status: the
 * bench child kept running (20-50 GB model mapped, and on Windows a dead
 * parent does not reap it), and when the sweep finished the serve carried on -
 * spawned the server and overwrote the user's 'stopped' with 'ready'.
 */
describe('CookbookServeService: Stop wins over an in-flight calibration', () => {
  const moeModel: CatalogModel = { ...MODEL, isMoe: true };
  const gpu8 = profile({ platform: 'windows', gpuVramGb: 8 });

  it("does not overwrite 'stopped' or spawn the server after a mid-calibration Stop", async () => {
    const statuses: Array<{ state: string }> = [];
    let releaseCalibration: () => void = NOOP;
    const gate = new Promise<void>((resolve) => {
      releaseCalibration = resolve;
    });
    const planNCpuMoe = vi.fn(async (req: { onCalibrating?: () => void }) => {
      req.onCalibrating?.();
      await gate;
      return 36;
    });
    const cancelCalibration = vi.fn();
    const { service, serve } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe,
      cancelCalibration,
      statuses,
    });

    const serving = service.serve(MODEL.name);
    await vi.waitFor(() => expect(statuses.some((s) => s.state === 'calibrating')).toBe(true));

    const stopped = await service.stopServe();
    expect(stopped.state).toBe('stopped');
    // The stop reached the bench, not just the status field.
    expect(cancelCalibration).toHaveBeenCalledTimes(1);

    releaseCalibration();
    const final = await serving;

    // The user's Stop is the last word: no spawn, no 'ready' minutes later.
    expect(serve.start).not.toHaveBeenCalled();
    expect(final.state).toBe('stopped');
    expect(service.serveStatus().state).toBe('stopped');
    expect(statuses.at(-1)?.state).toBe('stopped');
  });

  it('stopAll (before-quit) aborts the in-flight bench too', async () => {
    let releaseCalibration: () => void = NOOP;
    const gate = new Promise<void>((resolve) => {
      releaseCalibration = resolve;
    });
    const cancelCalibration = vi.fn();
    const planNCpuMoe = vi.fn(async () => {
      await gate;
      return 36;
    });
    const { service, serve } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe,
      cancelCalibration,
    });

    const serving = service.serve(MODEL.name);
    await vi.waitFor(() => expect(planNCpuMoe).toHaveBeenCalledTimes(1));
    await service.stopAll();
    expect(cancelCalibration).toHaveBeenCalledTimes(1);

    releaseCalibration();
    await serving;
    // App quit: nothing may be spawned by a serve that outlived the quit.
    expect(serve.start).not.toHaveBeenCalled();
  });
});

/**
 * One serve at a time, at the SERVICE level. `LocalServeManager.serialized`
 * already queues the spawns, but the download + calibration that precede a
 * spawn ran unserialised: pressing Serve on B while A was calibrating ran two
 * benches and two downloads concurrently, and the gazumped bench's winner was
 * cached PERMANENTLY (the cache has no notion of a contended measurement).
 */
describe('CookbookServeService.serve: concurrent presses are serialised', () => {
  const moeModel: CatalogModel = { ...MODEL, isMoe: true };
  const gpu8 = profile({ platform: 'windows', gpuVramGb: 8 });

  it('makes the second serve wait for the first to settle', async () => {
    let releaseFirst: () => void = NOOP;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calibrations = 0;
    const planNCpuMoe = vi.fn(async () => {
      calibrations += 1;
      if (calibrations === 1) await gate;
      return 36;
    });
    const { service, serve, download } = makeService({
      available: { llamaServer: true },
      hardware: gpu8,
      catalog: [moeModel],
      planNCpuMoe,
    });

    const first = service.serve(MODEL.name);
    await vi.waitFor(() => expect(planNCpuMoe).toHaveBeenCalledTimes(1));
    const second = service.serve(MODEL.name);

    // Give the (wrongly) concurrent path every chance to run before asserting.
    // Event-loop turns, not wall clock: a loaded 24-fork run can stall a real
    // timer past any budget while microtasks still drain deterministically.
    await settleTurns(50);
    // While A is still calibrating, B has started NOTHING: no second download,
    // no second bench - so no interleaved measurement can reach the cache.
    expect(download).toHaveBeenCalledTimes(1);
    expect(planNCpuMoe).toHaveBeenCalledTimes(1);

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);

    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
    expect(download).toHaveBeenCalledTimes(2);
    expect(serve.start).toHaveBeenCalledTimes(2);
  });
});
