/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cookbook-serve orchestrator: scan hardware -> select backend -> serve -> register.
 *
 * Ties {@link ModelDownloadManager} (the GGUF download primitive) and
 * {@link LocalServeManager} (the vLLM / llama-server / ollama lifecycle) to the
 * model registry so a recommended local model becomes a one-button, immediately
 * usable provider. The backend is chosen from the DETECTED hardware (OS + GPU
 * vendor + VRAM) and which binaries are installed - never assumed - via
 * {@link selectBackend}; the download step is backend-specific:
 *   - `vllm`         -> `vllm serve <hf-repo>` self-downloads the model (no GGUF).
 *   - `llama-server` -> download the GGUF + spawn a loopback OpenAI server +
 *                       cookbook-local provider; GPU layers scale to the VRAM.
 *   - `ollama`       -> `ollama pull hf.co/<repo>:<quant>` + ollama-local provider.
 *   - none installed -> the GGUF download still succeeds; status carries the exact
 *                       copy-command so the user is never worse off.
 *
 * One active serve at a time (MVP default). All collaborators are injected so the
 * whole flow is unit-testable without the network, filesystem, subprocesses, DB,
 * or a real host probe.
 */

import type {
  CookbookBackend,
  CookbookBackendSelection,
  CookbookDownloadInfo,
  CookbookDownloadProgress,
  CookbookServeStatus,
} from '@/common/types/cookbook';
import type { CatalogModel as HwfitCatalogModel, HardwareProfile } from '@process/services/hwfit';
import { localGgufPath, type CookbookDownloadResult, type ModelDownloadManager } from './ModelDownloadManager';
import { buildServeCommand, ngpuLayersForVram, type LocalServeManager } from './LocalServeManager';
import { isLlamaServerProvisionable, selectBackend } from './backendPolicy';
import {
  COOKBOOK_LOCAL_ID,
  registerCookbookServeInRepo,
  markCookbookServeStoppedInRepo,
  type CookbookRegistryRepo,
} from './cookbookProviderRegistration';
import {
  autoRegisterOllamaInRepo,
  type OllamaProbe,
  type OllamaRegistryRepo,
} from '@process/onboarding/autoRegisterOllama';

/** Loopback port the local Ollama daemon binds by default. */
const OLLAMA_LOCAL_PORT = 11434;
/** The fixed native provider id for the local Ollama daemon. */
const OLLAMA_LOCAL_ID = 'ollama-local';
/** Default quant used when a catalog model does not pin one. */
const DEFAULT_QUANT = 'Q4_K_M';

/** Injectable collaborators for the orchestrator. */
export type CookbookServeDeps = {
  downloadManager: ModelDownloadManager;
  serveManager: LocalServeManager;
  /** The full local-model catalog (hwfit); scanned by name. */
  getCatalog: () => readonly HwfitCatalogModel[];
  /** The model-registry repository slice, or null before it is ready. */
  getRepo: () => CookbookRegistryRepo | null;
  /** Directory GGUF downloads land in (`userData/models/gguf`). */
  getGgufDir: () => string;
  /**
   * The detected hardware profile (OS + GPU vendor + VRAM). Drives the
   * backend selection and the `-ngl` heuristic - never assume a fixed rig.
   */
  getHardware: () => Promise<HardwareProfile>;
  /** Probe the local Ollama daemon `/api/tags` (for post-pull registration). */
  probeOllama?: () => Promise<OllamaProbe>;
  /**
   * Host architecture (`process.arch` form). Injectable ONLY so a test can ask
   * what a machine llama.cpp publishes no build for would be offered; production
   * leaves it unset and the real `process.arch` is read.
   */
  arch?: string;
  /** Emit a download-progress event to the renderer. */
  onProgress?: (p: CookbookDownloadProgress) => void;
  /** Emit a serve-status change to the renderer. */
  onStatus?: (s: CookbookServeStatus) => void;
};

const IDLE_STATUS: CookbookServeStatus = {
  state: 'idle',
  modelId: null,
  backend: 'none',
  port: null,
  providerId: null,
  servedModel: null,
};

export class CookbookServeService {
  private status: CookbookServeStatus = { ...IDLE_STATUS };
  private readonly downloads = new Map<string, CookbookDownloadInfo>();

  constructor(private readonly deps: CookbookServeDeps) {}

  // ── Catalog resolution ────────────────────────────────────────────────────

  private resolveModel(modelId: string): HwfitCatalogModel | undefined {
    return this.deps.getCatalog().find((m) => m.name === modelId);
  }

  private ggufCapableModels(): HwfitCatalogModel[] {
    return this.deps.getCatalog().filter((m) => (m.ggufSources?.length ?? 0) > 0);
  }

  // ── Downloads ─────────────────────────────────────────────────────────────

  /** Every download the UI should know about: in-memory state + cached-on-disk. */
  listDownloads(): CookbookDownloadInfo[] {
    const dir = this.deps.getGgufDir();
    const out = new Map<string, CookbookDownloadInfo>();
    for (const [id, info] of this.downloads) out.set(id, info);
    for (const model of this.ggufCapableModels()) {
      if (out.has(model.name)) continue;
      if (this.deps.downloadManager.isDownloaded(dir, model.name)) {
        out.set(model.name, {
          modelId: model.name,
          status: 'downloaded',
          bytesDownloaded: 0,
          totalBytes: null,
          filePath: localGgufPath(dir, model.name),
        });
      }
    }
    return [...out.values()];
  }

  /** Resolve + download a model's GGUF build. Short-circuits if already cached. */
  async download(modelId: string): Promise<CookbookDownloadResult> {
    const model = this.resolveModel(modelId);
    const repo = model?.ggufSources?.[0]?.repo;
    if (!model || !repo) {
      throw new Error(`cookbook: no GGUF source for "${modelId}"`);
    }
    this.setDownload(modelId, { status: 'downloading', bytesDownloaded: 0, totalBytes: null, filePath: null });
    try {
      const result = await this.deps.downloadManager.download(
        { modelId, repo, quant: model.quantization, destDir: this.deps.getGgufDir() },
        (p) => {
          this.setDownload(modelId, {
            status: 'downloading',
            bytesDownloaded: p.bytesDownloaded,
            totalBytes: p.totalBytes,
            filePath: null,
          });
          this.deps.onProgress?.(p);
        }
      );
      this.setDownload(modelId, {
        status: 'downloaded',
        bytesDownloaded: result.bytesWritten,
        totalBytes: result.bytesWritten || null,
        filePath: result.filePath,
      });
      return result;
    } catch (err) {
      this.setDownload(modelId, {
        status: 'error',
        bytesDownloaded: 0,
        totalBytes: null,
        filePath: null,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Cancel an in-flight download. */
  cancelDownload(modelId: string): boolean {
    const cancelled = this.deps.downloadManager.cancel(modelId);
    if (cancelled) {
      this.setDownload(modelId, { status: 'idle', bytesDownloaded: 0, totalBytes: null, filePath: null });
    }
    return cancelled;
  }

  // ── Serve ─────────────────────────────────────────────────────────────────

  serveStatus(): CookbookServeStatus {
    return this.status;
  }

  /**
   * The hardware-adaptive backend choice for this host: the default-selected
   * (most capable viable) backend + every viable one the UI may offer as an
   * override. Reads the hardware scan + which binaries are installed.
   */
  async backendSelection(): Promise<CookbookBackendSelection> {
    return (await this.resolveSelection()).selection;
  }

  /** Read hardware + installed binaries and compute the backend selection. */
  private async resolveSelection(): Promise<{ selection: CookbookBackendSelection; vramGb: number }> {
    const profile = await this.deps.getHardware();
    const available = await this.deps.serveManager.detectAvailability();
    const vramGb = profile.hasGpu && typeof profile.gpuVramGb === 'number' ? profile.gpuVramGb : 0;
    const selection = selectBackend({
      platform: profile.platform,
      hwBackend: profile.backend,
      vramGb,
      available,
      // Main-process code, so `process.arch` is the real architecture of the
      // host that would run the downloaded binary.
      canProvisionLlamaServer: isLlamaServerProvisionable(profile.platform, this.deps.arch ?? process.arch),
    });
    return { selection, vramGb };
  }

  /**
   * Auto-serve a model through the backend chosen for THIS host's hardware,
   * registering it as a usable provider. `backend` is an optional user override
   * among the viable backends; when absent or not viable the default is used.
   * The download step is backend-specific (GGUF for llama.cpp; self-pull for
   * ollama + vllm). Never throws - a failure is reflected in the returned status.
   */
  async serve(modelId: string, backend?: CookbookBackend): Promise<CookbookServeStatus> {
    try {
      const model = this.resolveModel(modelId);
      if (!model) return this.fail(modelId, 'none', `unknown model "${modelId}"`);

      const { selection, vramGb } = await this.resolveSelection();
      const chosen = backend && selection.viable.includes(backend) ? backend : selection.chosen;

      if (chosen === 'vllm') return await this.serveViaVllm(modelId, model.name);

      // GGUF-based backends need a GGUF source; vLLM does not (it self-pulls).
      const repoId = model.ggufSources?.[0]?.repo;
      if (chosen === 'ollama') {
        if (!repoId) return this.fail(modelId, 'ollama', `no GGUF source for "${modelId}"`);
        return await this.serveViaOllama(modelId, repoId, model.quantization || DEFAULT_QUANT);
      }
      if (chosen === 'llama-server') {
        if (!repoId) return this.fail(modelId, 'llama-server', `no GGUF source for "${modelId}"`);
        return await this.serveViaLlamaServer(modelId, model.name, vramGb);
      }
      return await this.serveDegraded(modelId, vramGb);
    } catch (err) {
      return this.fail(modelId, this.status.backend, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Serve a model's full Hugging Face repo through vLLM. vLLM self-downloads the
   * model from the hub on first run, so there is NO separate GGUF download here.
   * The served repo is registered as the same keyless loopback provider.
   */
  private async serveViaVllm(modelId: string, hfRepo: string): Promise<CookbookServeStatus> {
    this.setStatus({ state: 'starting', modelId, backend: 'vllm' });
    const port = await this.deps.serveManager.startVllm({ hfRepo });
    const repo = this.deps.getRepo();
    if (repo) registerCookbookServeInRepo(repo, { port, servedModelId: hfRepo, displayName: hfRepo });
    return this.setStatus({
      state: 'ready',
      modelId,
      backend: 'vllm',
      port,
      providerId: COOKBOOK_LOCAL_ID,
      servedModel: hfRepo,
    });
  }

  private async serveViaOllama(modelId: string, repoId: string, quant: string): Promise<CookbookServeStatus> {
    const ref = `hf.co/${repoId}:${quant}`;
    this.setStatus({ state: 'starting', modelId, backend: 'ollama', port: OLLAMA_LOCAL_PORT });
    await this.deps.serveManager.pullOllama(ref);
    await this.registerOllamaLocal();
    return this.setStatus({
      state: 'ready',
      modelId,
      backend: 'ollama',
      port: OLLAMA_LOCAL_PORT,
      providerId: OLLAMA_LOCAL_ID,
      servedModel: ref,
    });
  }

  private async serveViaLlamaServer(
    modelId: string,
    servedModelId: string,
    vramGb: number
  ): Promise<CookbookServeStatus> {
    this.setStatus({ state: 'downloading', modelId, backend: 'llama-server' });
    const dl = await this.download(modelId);
    this.setStatus({ state: 'starting', modelId, backend: 'llama-server' });
    const ngl = ngpuLayersForVram(vramGb);
    const port = await this.deps.serveManager.start({ ggufPath: dl.filePath, ngl });
    const repo = this.deps.getRepo();
    if (repo) registerCookbookServeInRepo(repo, { port, servedModelId, displayName: servedModelId });
    return this.setStatus({
      state: 'ready',
      modelId,
      backend: 'llama-server',
      port,
      providerId: COOKBOOK_LOCAL_ID,
      servedModel: servedModelId,
    });
  }

  private async serveDegraded(modelId: string, vramGb: number): Promise<CookbookServeStatus> {
    // No backend installed: the download must still succeed so the user is never
    // worse off than today. Then surface the exact hand-run serve command.
    this.setStatus({ state: 'downloading', modelId, backend: 'none' });
    const dl = await this.download(modelId);
    const ngl = ngpuLayersForVram(vramGb);
    return this.setStatus({
      state: 'needs_backend',
      modelId,
      backend: 'none',
      port: null,
      providerId: null,
      servedModel: null,
      serveCommand: buildServeCommand(dl.filePath, ngl),
    });
  }

  /** Stop the active serve and flip the cookbook-local provider to offline. */
  async stopServe(): Promise<CookbookServeStatus> {
    await this.deps.serveManager.stop();
    const repo = this.deps.getRepo();
    if (repo) markCookbookServeStoppedInRepo(repo);
    return this.setStatus({ ...IDLE_STATUS, state: 'stopped' });
  }

  /** Point the serve path at a user-located llama-server binary. */
  async locateBackend(binaryPath: string): Promise<{ ok: boolean; backend: CookbookBackend }> {
    const ok = this.deps.serveManager.setBackendBinary(binaryPath);
    const backend = await this.deps.serveManager.detectBackend();
    return { ok, backend };
  }

  /** Detect the currently-available backend (for the UI's degraded affordance). */
  detectBackend(): Promise<CookbookBackend> {
    return this.deps.serveManager.detectBackend();
  }

  /**
   * Stop everything for app quit. A spawned llama-server MUST be killed or it
   * leaks and holds the GPU. Wired into the before-quit CleanupModules bundle.
   */
  async stopAll(): Promise<void> {
    await this.deps.serveManager.stop();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async registerOllamaLocal(): Promise<void> {
    const repo = this.deps.getRepo();
    if (!repo || !this.deps.probeOllama) return;
    const probe = await this.deps.probeOllama().catch((): OllamaProbe => ({ running: false, models: [] }));
    if (!probe.running) return;
    // The Cookbook + onboarding repos share the same concrete ProviderRepository;
    // the structural slices differ only in optional error typing (cast is safe).
    autoRegisterOllamaInRepo(repo as unknown as OllamaRegistryRepo, probe);
  }

  private setDownload(modelId: string, partial: Omit<CookbookDownloadInfo, 'modelId'>): void {
    this.downloads.set(modelId, { modelId, ...partial });
  }

  private setStatus(
    partial: Partial<CookbookServeStatus> & { state: CookbookServeStatus['state'] }
  ): CookbookServeStatus {
    this.status = { ...this.status, ...partial };
    this.deps.onStatus?.(this.status);
    return this.status;
  }

  private fail(modelId: string, backend: CookbookBackend, error: string): CookbookServeStatus {
    return this.setStatus({
      state: 'error',
      modelId,
      backend,
      port: null,
      providerId: null,
      servedModel: null,
      error,
    });
  }
}
