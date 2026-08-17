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
 *   - `lm-studio`    -> NOTHING is downloaded and NOTHING is spawned: LM Studio
 *                       is the user's own long-lived app, already serving the
 *                       weights it holds. Serving through it is purely a
 *                       provider registration against the endpoint it is
 *                       already listening on - see {@link serveViaLmStudio}.
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
import type { MoeOffloadRequest } from './moeCalibration';
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
import {
  defaultExecLmStudioServerStatus,
  defaultFetchLmStudioModels,
  lmStudioBaseUrl,
  probeLmStudioForServe,
  LM_STUDIO_DEFAULT_PORT,
  type LmStudioModel,
  type LmStudioServeProbe,
} from './lmStudioDetect';

/** Loopback port the local Ollama daemon binds by default. */
const OLLAMA_LOCAL_PORT = 11434;
/** The fixed native provider id for the local Ollama daemon. */
const OLLAMA_LOCAL_ID = 'ollama-local';
/** Default quant used when a catalog model does not pin one. */
const DEFAULT_QUANT = 'Q4_K_M';
/** LM Studio model kind that must never be registered as a chat model. */
const LM_STUDIO_EMBEDDINGS_TYPE = 'embeddings';
/** LM Studio's own word for "the weights are in memory right now". */
const LM_STUDIO_LOADED = 'loaded';
/** How many of LM Studio's model ids a no-match error names before eliding. */
const LM_STUDIO_ERROR_SAMPLE = 5;

/**
 * Every id the advisor's catalog knows this model by, for LM Studio matching.
 *
 * Two, not one, and both are the SAME weights under different names: the HF
 * repo (`Qwen/Qwen3.6-27B`) and the GGUF repo the download path would use
 * (`org/Model-GGUF`). LM Studio ids a model after the repo it was pulled from,
 * and a user who downloaded the GGUF build has the second name, not the first.
 */
export function lmStudioMatchCandidates(model: HwfitCatalogModel): string[] {
  const out: string[] = [];
  if (typeof model.name === 'string' && model.name.length > 0) out.push(model.name);
  for (const src of model.ggufSources ?? []) {
    if (src && typeof src.repo === 'string' && src.repo.length > 0) out.push(src.repo);
  }
  return out;
}

/**
 * Find the LM Studio model that IS one of `candidates`, or null.
 *
 * EXACT id, case-insensitively - deliberately no fuzzy fallback, and this is
 * the part of the LM Studio path most worth being honest about, because the two
 * id spaces are genuinely different namespaces. MEASURED against the live
 * install's eight models and the 912-entry catalog:
 *
 *   lms `openai/gpt-oss-20b`  -> catalog `openai/gpt-oss-20b`   exact
 *   lms `qwen/qwen3.6-27b`    -> catalog `Qwen/Qwen3.6-27B`     case only
 *   lms `google/gemma-4-e4b`  -> no catalog entry               (correctly none)
 *   lms `supergemma4-26b-uncensored-v2` and three other community
 *       imports                                                 (correctly none)
 *
 * So case-insensitive equality already matched every LM Studio model that the
 * catalog actually contains, and a basename fallback (`gpt-oss-20b`) would have
 * bought nothing while introducing a real wrong-model risk: the catalog holds
 * BOTH `openai/gpt-oss-20b` and `RedHatAI/gpt-oss-20b`, which are different
 * publishers' builds. Serving one where the user asked for the other is exactly
 * the silent lie this whole path must not tell - a mismatch is reported instead.
 *
 * Two filters ride along, both from LM Studio's own fields rather than a guess:
 *  - `type: 'embeddings'` is never a chat model, so it is never a match even
 *    when the id lines up.
 *  - a model whose weights are already `state: 'loaded'` wins over an equally
 *    matching one that is not, so the zero-cost option is preferred. Nothing is
 *    excluded for being unloaded: LM Studio loads on first request.
 */
export function matchLmStudioModel(
  candidates: readonly string[],
  models: readonly LmStudioModel[]
): LmStudioModel | null {
  const wanted = new Set(candidates.map((c) => c.toLowerCase()));
  const matches = models.filter(
    (m) => m && typeof m.id === 'string' && m.type !== LM_STUDIO_EMBEDDINGS_TYPE && wanted.has(m.id.toLowerCase())
  );
  return matches.find((m) => m.state === LM_STUDIO_LOADED) ?? matches[0] ?? null;
}

/**
 * The message for "LM Studio is up, but it does not hold this model".
 *
 * Names what LM Studio DOES have, because the fix is a user action in LM
 * Studio and they cannot take it without knowing the gap. Bounded to
 * {@link LM_STUDIO_ERROR_SAMPLE} ids - the reference install already holds
 * eight, and a catalogue dump is not an error message.
 */
export function lmStudioNoMatchError(modelId: string, models: readonly LmStudioModel[]): string {
  const servable = models.filter((m) => m && m.type !== LM_STUDIO_EMBEDDINGS_TYPE).map((m) => m.id);
  if (servable.length === 0) {
    return `LM Studio is running but has no models downloaded, so it cannot serve "${modelId}".`;
  }
  const shown = servable.slice(0, LM_STUDIO_ERROR_SAMPLE).join(', ');
  const rest = servable.length > LM_STUDIO_ERROR_SAMPLE ? `, +${servable.length - LM_STUDIO_ERROR_SAMPLE} more` : '';
  return (
    `LM Studio does not have "${modelId}". It holds: ${shown}${rest}. ` +
    `Download "${modelId}" in LM Studio, or serve it through another backend.`
  );
}

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
   * Read LM Studio's OWN model endpoint: is it answering, and what does it
   * hold. ONE fetch answers both, which is why the serve path does not
   * re-check `/v1/models` - a 200 there would prove only that SOMETHING
   * OpenAI-compatible owns the port, not that it is LM Studio.
   *
   * Unlike {@link probeOllama} this defaults to the real implementation, so
   * production needs no wiring (cookbookServeSingleton stays untouched). It is
   * only ever called on the `lm-studio` serve path, which a test reaches only
   * by declaring `lmStudioServing: true` in the availability it injects - so a
   * test that does NOT ask for LM Studio can never fall through to the network.
   */
  probeLmStudio?: () => Promise<LmStudioServeProbe>;
  /**
   * Host architecture (`process.arch` form). Injectable ONLY so a test can ask
   * what a machine llama.cpp publishes no build for would be offered; production
   * leaves it unset and the real `process.arch` is read.
   */
  arch?: string;
  /**
   * Measured `--n-cpu-moe` planner for MoE models that do not fit in VRAM
   * (moeCalibration.ts). Answers the value to pass, or null for "no flag"
   * (dense model, fits fully resident, layer count unknowable). Optional so
   * every existing test - and any host without the calibrator wired - keeps
   * the exact pre-MoE behaviour; production injects the real calibrator in
   * cookbookServeSingleton.ts.
   */
  planNCpuMoe?: (req: MoeOffloadRequest) => Promise<number | null>;
  /**
   * Abort the in-flight `--n-cpu-moe` calibration bench, if one is running
   * (MoeOffloadCalibrator.cancel in production). Pulled by BOTH stop paths -
   * stopServe and the before-quit stopAll - because the bench is a real child
   * process holding a 20-50 GB model mapped, and on Windows a dead parent does
   * not reap it. Optional for the same reason `planNCpuMoe` is: a host with no
   * calibrator wired has nothing to abort.
   */
  cancelCalibration?: () => void;
  /** Emit a download-progress event to the renderer. */
  onProgress?: (p: CookbookDownloadProgress) => void;
  /** Emit a serve-status change to the renderer. */
  onStatus?: (s: CookbookServeStatus) => void;
};

/** Discard a settled value/reason without turning it into an unhandled rejection. */
const noopServe = (): void => {};

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
  /**
   * Bumped by every stop request (stopServe / stopAll). A serve captures the
   * value when it starts and re-checks it after its long awaits (download +
   * calibration, minutes each): a mismatch means the user stopped things in
   * the meantime, and the serve must abandon the launch instead of spawning a
   * server and overwriting the 'stopped' status with 'ready'.
   */
  private stopEpoch = 0;
  /** The serve currently running, so a second press queues behind it. */
  private serveInFlight: Promise<CookbookServeStatus> | null = null;

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
  private async resolveSelection(): Promise<{
    selection: CookbookBackendSelection;
    vramGb: number;
    gpuName: string | null;
  }> {
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
    return { selection, vramGb, gpuName: profile.gpuName ?? null };
  }

  /**
   * Auto-serve a model through the backend chosen for THIS host's hardware,
   * registering it as a usable provider. `backend` is an optional user override
   * among the viable backends; when absent or not viable the default is used.
   * The download step is backend-specific (GGUF for llama.cpp; self-pull for
   * ollama + vllm). Never throws - a failure is reflected in the returned status.
   *
   * SERIALISED at the service level, one serve at a time in press order - the
   * same queue-not-share shape as `LocalServeManager.serialized`, and needed
   * even though that queue exists: the manager serialises only the SPAWN,
   * while the download and the minutes-long calibration that precede it ran
   * concurrently. Pressing Serve on B while A was calibrating ran two benches
   * against the same GPU at once, and the contended - i.e. wrong - winner was
   * cached PERMANENTLY under A's model key. Each press still gets the status
   * of its own serve, and a failed serve does not strand the queue.
   */
  async serve(modelId: string, backend?: CookbookBackend): Promise<CookbookServeStatus> {
    const ahead = this.serveInFlight;
    // serveNow never rejects, but swallow a predecessor's rejection anyway so
    // an unforeseen one cannot poison every serve queued behind it.
    const mine = (ahead === null ? Promise.resolve() : ahead.then(noopServe, noopServe)).then(() =>
      this.serveNow(modelId, backend)
    );
    this.serveInFlight = mine;
    try {
      return await mine;
    } finally {
      // Only the last serve in the queue clears the slot.
      if (this.serveInFlight === mine) this.serveInFlight = null;
    }
  }

  /** One serve, start to finish. Only ever entered by the queue in {@link serve}. */
  private async serveNow(modelId: string, backend?: CookbookBackend): Promise<CookbookServeStatus> {
    try {
      const model = this.resolveModel(modelId);
      if (!model) return this.fail(modelId, 'none', `unknown model "${modelId}"`);

      const { selection, vramGb, gpuName } = await this.resolveSelection();
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
        return await this.serveViaLlamaServer(modelId, model, vramGb, gpuName);
      }
      // Deliberately AFTER the GGUF-source guards and never subject to one: LM
      // Studio serves what it already holds, so a catalog model with no GGUF
      // source is not a reason to refuse - only "LM Studio does not have it" is.
      if (chosen === 'lm-studio') return await this.serveViaLmStudio(modelId, model);
      if (chosen === 'none') return await this.serveDegraded(modelId, model, vramGb, gpuName);

      // Every serveable backend is dispatched above, so `chosen` is `never` by
      // the time control reaches here. That assignment is the point: adding a
      // member to CookbookBackend without a branch above stops COMPILING here,
      // instead of falling into serveDegraded - the "copy this shell command"
      // path meant for a host with no backend at all - and reporting that as
      // the outcome of the user's explicit pick.
      const _exhaustive: never = chosen;
      return await this.serveDegraded(modelId, model, vramGb, gpuName);
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
    model: HwfitCatalogModel,
    vramGb: number,
    gpuName: string | null
  ): Promise<CookbookServeStatus> {
    const servedModelId = model.name;
    const epoch = this.stopEpoch;
    this.setStatus({ state: 'downloading', modelId, backend: 'llama-server' });
    const dl = await this.download(modelId);
    // MoE expert offload, decided BEFORE 'starting': for a MoE model that does
    // not fit in VRAM this may run a one-time llama-bench calibration (~1-3
    // min, cached per model+GPU), reported as its own 'calibrating' state.
    const nCpuMoe = await this.resolveNCpuMoe(modelId, model, dl.filePath, vramGb, gpuName);
    if (this.stopEpoch !== epoch) {
      // A Stop arrived during the download/calibration minutes. Its status
      // ('stopped') is the user's last word: launching now would spawn a
      // server nobody asked to keep and overwrite that word with 'ready'.
      // The aborted calibration already answered through its fallback and
      // cached nothing, so the next press starts clean.
      return this.status;
    }
    this.setStatus({ state: 'starting', modelId, backend: 'llama-server' });
    const ngl = ngpuLayersForVram(vramGb);
    const port = await this.deps.serveManager.start({
      ggufPath: dl.filePath,
      ngl,
      nCpuMoe: nCpuMoe ?? undefined,
    });
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

  /**
   * The `--n-cpu-moe` value for this serve, or null for "no flag". Delegates
   * to the injected planner; a missing planner and a planner that THROWS both
   * answer null, because expert offload is an optimisation and must never turn
   * a servable model into a failed serve.
   */
  private async resolveNCpuMoe(
    modelId: string,
    model: HwfitCatalogModel,
    ggufPath: string,
    vramGb: number,
    gpuName: string | null
  ): Promise<number | null> {
    const planner = this.deps.planNCpuMoe;
    if (!planner) return null;
    try {
      return await planner({
        modelId: model.name,
        ggufPath,
        isMoeHint: model.isMoe === true,
        gpuName,
        vramGb,
        onCalibrating: () => {
          this.setStatus({ state: 'calibrating', modelId, backend: 'llama-server' });
        },
      });
    } catch (err) {
      console.warn(`[CookbookServeService] MoE offload planning failed for "${modelId}"; serving without it:`, err);
      return null;
    }
  }

  /**
   * Serve through the user's OWN LM Studio: no download, no spawn, no load.
   *
   * Every other backend here is something Darhai fetches or starts. LM Studio
   * is a long-lived GUI app the user opened, already holding whatever weights
   * they chose, so the only honest act is to point a provider at it and say
   * which model it will answer as. Three consequences, each deliberate:
   *
   *  - **`lms load <id>` is NOT run.** It exists, and it is exactly the
   *    surprise this path must not spring: loading a 20B evicts whatever the
   *    user has in memory and takes minutes. LM Studio's own just-in-time
   *    loading (MEASURED on the reference install: `justInTimeModelLoading:
   *    true` in its server config) means the weights arrive on the FIRST
   *    request - i.e. when the user actually sends a message, at LM Studio's
   *    hands, under LM Studio's policy, exactly as if they had used it
   *    directly. If they never send one, nothing was ever loaded.
   *  - **A server Darhai DID spawn is stopped first.** `stop()` reaps only this
   *    manager's own child, never LM Studio; without it a llama-server would
   *    keep the GPU while the single `cookbook-local` provider had moved away
   *    from it, and nothing would reach it again until quit.
   *  - **The state is re-read, not remembered.** `lmStudioServing` was true
   *    when the dropdown was built; the user can close LM Studio between that
   *    and pressing Serve. The probe here is the one that decides.
   */
  private async serveViaLmStudio(modelId: string, model: HwfitCatalogModel): Promise<CookbookServeStatus> {
    this.setStatus({ state: 'starting', modelId, backend: 'lm-studio', port: LM_STUDIO_DEFAULT_PORT });
    await this.deps.serveManager.stop();

    const probe = await this.probeLmStudio();
    if (probe.serving !== true) {
      return this.fail(modelId, 'lm-studio', 'LM Studio is not answering on its local server - is it still open?');
    }

    const match = matchLmStudioModel(lmStudioMatchCandidates(model), probe.models);
    if (!match) return this.fail(modelId, 'lm-studio', lmStudioNoMatchError(modelId, probe.models));

    const repo = this.deps.getRepo();
    if (repo) {
      registerCookbookServeInRepo(repo, {
        port: probe.port,
        servedModelId: match.id,
        displayName: match.id,
        // The registered URL must be the URL the models were FOUND on: the
        // probe detects the user's configured port from `lms server status`
        // (measured: `{"running":true,"port":12399}` when relocated) and
        // carries it here, so a server moved off 1234 is registered where it
        // actually listens instead of at the default.
        baseUrl: lmStudioBaseUrl(probe.port),
      });
    }
    return this.setStatus({
      state: 'ready',
      modelId,
      backend: 'lm-studio',
      port: probe.port,
      providerId: COOKBOOK_LOCAL_ID,
      // LM Studio's id, NOT the catalog's: this is the string the agent must
      // put in `model`, and LM Studio answers to its own name only.
      servedModel: match.id,
    });
  }

  private async serveDegraded(
    modelId: string,
    model: HwfitCatalogModel,
    vramGb: number,
    gpuName: string | null
  ): Promise<CookbookServeStatus> {
    // No backend installed: the download must still succeed so the user is never
    // worse off than today. Then surface the exact hand-run serve command.
    const epoch = this.stopEpoch;
    this.setStatus({ state: 'downloading', modelId, backend: 'none' });
    const dl = await this.download(modelId);
    const ngl = ngpuLayersForVram(vramGb);
    // On a host with no backend there is no llama-bench either, so the planner
    // answers the measured all-layers fallback for a too-big MoE model - the
    // copy-paste advice must not be the plain `-ngl` that is slower than CPU.
    const nCpuMoe = await this.resolveNCpuMoe(modelId, model, dl.filePath, vramGb, gpuName);
    // Same rule as serveViaLlamaServer: a Stop pressed during the waits wins.
    if (this.stopEpoch !== epoch) return this.status;
    return this.setStatus({
      state: 'needs_backend',
      modelId,
      backend: 'none',
      port: null,
      providerId: null,
      servedModel: null,
      serveCommand: buildServeCommand(dl.filePath, ngl, undefined, nCpuMoe ?? undefined),
    });
  }

  /** Stop the active serve and flip the cookbook-local provider to offline. */
  async stopServe(): Promise<CookbookServeStatus> {
    // Before anything async: the epoch bump is what tells an in-flight serve
    // (waiting on its download or calibration) that this Stop happened, and
    // the cancel is what reaches the bench child itself - `serveManager.stop`
    // only reaps a server that was already spawned.
    this.stopEpoch += 1;
    this.deps.cancelCalibration?.();
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
   * leaks and holds the GPU - and so must an in-flight calibration bench: it
   * is a separate child holding a 20-50 GB model mapped, Windows does not reap
   * it with the parent, and `serveManager.stop` has never heard of it. Wired
   * into the before-quit CleanupModules bundle.
   */
  async stopAll(): Promise<void> {
    this.stopEpoch += 1;
    this.deps.cancelCalibration?.();
    await this.deps.serveManager.stop();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** LM Studio's live model list AND the port it was found on. */
  private probeLmStudio(): Promise<LmStudioServeProbe> {
    if (this.deps.probeLmStudio) return this.deps.probeLmStudio();
    return probeLmStudioForServe({
      fetchModels: defaultFetchLmStudioModels,
      execServerStatus: defaultExecLmStudioServerStatus,
    });
  }

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
