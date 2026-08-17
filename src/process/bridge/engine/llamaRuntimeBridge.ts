/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for Darhai's OWN llama.cpp runtime (`ipcBridge.llamaRuntime`).
 *
 * WHY THIS EXISTS. `cookbook.serve` can only spawn a `llama-server` that is
 * already on disk. Before this bridge the only way one got there was the user
 * installing llama.cpp by hand, so the Model Advisor's action button fell
 * through to printing a shell command - "install something else first", which
 * is exactly the step the product is supposed to remove. This surface is how
 * the runtime comes to exist: it drives the provisioner in
 * `@process/services/llamacpp`, which downloads a digest-verified llama.cpp
 * release into `userData/llamacpp/versions/<tag>/`.
 *
 * SECURITY - HUMAN/RENDERER ONLY. The whole `llamaRuntime.` namespace is
 * remote-denied in `bridgeAllowlist.ts`: `install` DOWNLOADS AN EXECUTABLE and
 * `cookbook.serve` then RUNS it, so a paired-device WebSocket caller reaching
 * this would be remote arbitrary-binary install + exec. `plan` is denied with
 * it (it makes the host reach the network on the caller's say-so) and so is
 * `status` (it discloses host install paths). Every verb takes `void`, so
 * there is no untrusted payload to validate - the denial IS the boundary.
 *
 * HONESTY. {@link LlamaRuntimeController.plan} answers what an install WOULD
 * fetch - which acceleration, why it is weaker than the hardware if it is, and
 * the summed byte total taken from the release index - so the UI can say "this
 * is the CPU build, 147 MB" BEFORE the download rather than after. A machine
 * llama.cpp publishes no build for fails with `LLAMACPP_UNSUPPORTED` instead of
 * sitting in `downloading` forever.
 *
 * BINDING. That answer is not advisory: `install()` CONSUMES the resolution
 * `plan()` disclosed instead of resolving again, and hands the whole resolved
 * PLAN to the provisioner rather than the inputs that produced it, so no layer
 * below re-decides anything. Two independent resolutions seconds apart can
 * legitimately differ - "latest" moves several times a day - so a re-resolving
 * install would fetch a release the user never approved, of a size they never
 * saw. There is also only ever ONE outstanding disclosure, shared by every
 * caller, because 121 model rows share this one controller and each renders its
 * own card. See {@link LlamaRuntimeController.disclosed}.
 */

import { app } from 'electron';
import { ipcBridge } from '@/common';
import { scanHardware } from '@process/services/hwfit';
import {
  LlamaCppProvisioner,
  hasCudaRuntime,
  installedServerPath,
  listInstalledTags,
  llamaRoot,
  planLlamaAssets,
  readReceipt,
  type LlamaAssetPlan,
  type LlamaAssetPlanResult,
  type LlamaInstallReceipt,
  type LlamaProvisionProgress,
  type LlamaProvisionRequest,
  type LlamaRelease,
} from '@process/services/llamacpp';
import type { HwfitBackend } from '@/common/types/hwfit';
import { LLAMACPP_DISCLOSURE_EXPIRED } from '@/common/types/llamacpp';
import type { LlamaRuntimePlan, LlamaRuntimeProgress, LlamaRuntimeStatus } from '@/common/types/llamacpp';

/** The provisioner surface this bridge drives (structural, so tests can fake it). */
export type LlamaProvisionerLike = {
  plan: (request: LlamaProvisionRequest) => Promise<{ release: LlamaRelease; plan: LlamaAssetPlanResult }>;
  ensureInstalled: (request: LlamaProvisionRequest) => Promise<unknown>;
  cancel: () => boolean;
  on: (event: 'progress', listener: (p: LlamaProvisionProgress) => void) => unknown;
};

/** The install-layout reads this bridge makes (all sync fs facts). */
export type LlamaLayoutLike = {
  installedServerPath: (userDataDir: string, tag?: string) => string | null;
  listInstalledTags: (userDataDir: string) => string[];
  readReceipt: (userDataDir: string, tag: string) => LlamaInstallReceipt | null;
  llamaRoot: (userDataDir: string) => string;
};

export type LlamaRuntimeDeps = {
  userDataDir: () => string;
  /** Detected accelerator, straight from the hardware scan hwfit already runs. */
  hwBackend: () => Promise<HwfitBackend>;
  /**
   * Measured NVIDIA driver version (`'610.62'`), or null when the probe could
   * not state one. Decides WHICH CUDA line is installed: a 13.x build does not
   * initialise on a pre-580 driver, and its way of not initialising is to run
   * on the CPU without saying so.
   */
  gpuDriverVersion: () => Promise<string | null>;
  /**
   * Target platform/arch, passed EXPLICITLY on every call rather than left to
   * each layer's own `process.*` default. The plan the user is shown, the
   * re-plan after the CUDA probe and the install must all describe the same
   * machine; two independent defaults that merely happen to agree is not that.
   */
  platform: () => string;
  arch: () => string;
  provisioner: LlamaProvisionerLike;
  layout: LlamaLayoutLike;
  /**
   * True when this machine already resolves the CUDA runtime DLLs of that line.
   * `excludeDir` is our own install root - counting it would be circular.
   */
  cudaPresent: (cudaVersion: string, excludeDir: string) => boolean;
  /** Push a status frame to the renderer. */
  emit: (status: LlamaRuntimeStatus) => void;
  /** Clock in epoch ms, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * A would-be install, fully resolved: exactly the bytes an install will fetch.
 *
 * `plan` is the whole answer, not a summary of one - which asset names, which
 * acceleration, which CUDA line, and why it is weaker than the hardware if it
 * is. Nothing about the decision is kept alongside it (the cudart probe result
 * used to be), because a second copy of a decision is a second thing that can
 * disagree with the plan actually installed.
 */
type ResolvedOk = {
  kind: 'ok';
  tag: string;
  plan: LlamaAssetPlan;
  downloadBytes: number | null;
  /** When this resolution was made (epoch ms), for the staleness cut-off. */
  resolvedAt: number;
};

/**
 * How long an outstanding disclosure may be re-stated and consumed.
 *
 * A short expiry would re-open the "confirm A, install B" hole the stable slot
 * exists to close - two presses seconds apart MUST keep getting one answer. A
 * slot held forever means a card confirmed a day later installs a tag that
 * stopped being `latest` long ago. 24 h separates the two cleanly: within a
 * sitting nothing ever expires, and a disclosure a day old no longer counts.
 *
 * What expiry MEANS differs by verb, because only one of them moves bytes.
 * `plan()` resolves afresh - the user is simply shown today's release. An
 * `install()` that finds its slot expired REFUSES with
 * {@link LLAMACPP_DISCLOSURE_EXPIRED} and downloads nothing: resolving afresh
 * here would install a release the user never saw (a card that said "b10441,
 * CPU, 30 MB" could silently fetch a 512 MB CUDA pair of a newer tag), which
 * is the exact substitution the disclosure exists to forbid. The renderer
 * answers the code by re-planning and asking for a second Confirm.
 */
const DISCLOSURE_TTL_MS = 24 * 60 * 60 * 1000;

/** What {@link LlamaRuntimeController.resolve} established about a would-be install. */
type Resolved =
  | ResolvedOk
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unavailable'; errorCode: string; message: string };

/** Fallback identifier when a thrown value carries no `code` of its own. */
const UNKNOWN_ERROR_CODE = 'LLAMACPP_UNKNOWN';

/** `cudart-llama-bin-win-cuda-13.3-x64.zip` -> `13.3`; `''` when it does not match. */
function cudartVersion(assetName: string): string {
  const match = /^cudart-llama-bin-win-cuda-([0-9]+(?:\.[0-9]+)*)-/.exec(assetName);
  return match ? match[1] : '';
}

/** The `code` an LlamaProvisionError / LlamaReleaseError / ArchiveError carries. */
function errorCodeOf(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.length > 0 ? code : UNKNOWN_ERROR_CODE;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sum the planned archives' sizes from the release index. Null when ANY planned
 * archive has no stated size - a partial sum shown as a total would be a number
 * the user could not trust, and this UI must never show one it did not measure.
 */
function sumPlannedBytes(plan: LlamaAssetPlan, release: LlamaRelease): number | null {
  let total = 0;
  for (const ref of plan.assets) {
    const asset = release.assets.find((a) => a.name === ref.name);
    if (!asset || typeof asset.bytes !== 'number' || asset.bytes <= 0) return null;
    total += asset.bytes;
  }
  return total;
}

/**
 * Owns the one managed runtime: what is installed, what an install would cost,
 * and the single in-flight install. Deps are injected so the whole state
 * machine is testable without electron, the network, or a filesystem.
 */
export class LlamaRuntimeController {
  private readonly deps: LlamaRuntimeDeps;
  /** True from the moment install() is accepted until it settles. */
  private busy = false;
  /** The single in-flight install, so a second caller JOINS it. */
  private inflight: Promise<LlamaRuntimeStatus> | null = null;
  private progress: LlamaRuntimeProgress | null = null;
  /** What the in-flight install is fetching, so `downloading` is not anonymous. */
  private pending: { tag: string; plan: LlamaAssetPlan } | null = null;
  /** Sticky last failure, cleared when an install is started or one succeeds. */
  private failure: { code: string; message: string } | null = null;
  /**
   * The OUTSTANDING resolution: what {@link plan} is currently telling everyone
   * an install would fetch, held so {@link install} fetches exactly that.
   *
   * This is the whole point of the disclosure. `plan()` and `install()` are two
   * separate presses seconds apart, and `latest` moves several times a day: a
   * second, independent resolve can legitimately answer a different tag, a
   * different acceleration and a different byte total than the sentence the
   * user just said yes to. Re-resolving would make the disclosure decoration.
   *
   * OUTSTANDING, NOT "LAST WRITE WINS". There is one runtime per machine, so
   * `useLlamaRuntime` is mounted once by the advisor page and all 121 model
   * rows share this controller - but each row renders its disclosure card from
   * its OWN React state. While this field was simply overwritten by every
   * `plan()`, pressing Serve on row A, then on row B (a second resolve, and
   * `latest` moves several times a day), then confirming A's card installed B's
   * resolution: the card on screen said b10441 / 30 MB and b10442 / 99 MB was
   * fetched, with no second confirmation and no trace in the UI. Binding the
   * slot to "the row that asked" is not available here - IPC carries no row,
   * every verb takes `void`, and that is a security property of this namespace
   * worth keeping. So the slot is made STABLE instead: while a resolution is
   * outstanding, every `plan()` hands back that same one. Two cards can then no
   * longer disagree, because there is only ever one answer to disagree about.
   *
   * It is cleared when an install consumes it - success or failure - so the
   * next press discloses afresh instead of silently reusing an old approval.
   * Not expired on any SHORT timer: that re-opens exactly the hole it closed
   * (press A, wait, press B, confirm A) to buy freshness. The one expiry it
   * does have is {@link DISCLOSURE_TTL_MS}: a slot older than a day reads as
   * never-disclosed to {@link freshDisclosure}, so `plan()` resolves afresh -
   * while `install()` refuses with {@link LLAMACPP_DISCLOSURE_EXPIRED} rather
   * than install a resolution nobody was shown (see {@link runInstall}).
   */
  private disclosed: ResolvedOk | null = null;
  /** Epoch-ms clock; injected in tests, `Date.now` in production. */
  private readonly now: () => number;

  constructor(deps: LlamaRuntimeDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): number => Date.now());
    this.deps.provisioner.on('progress', (p) => this.onProgress(p));
  }

  /**
   * The outstanding disclosure, unless it has aged past
   * {@link DISCLOSURE_TTL_MS} - a stale one reads as "nothing disclosed", so
   * every consumer falls back to resolving afresh.
   */
  private freshDisclosure(): ResolvedOk | null {
    const outstanding = this.disclosed;
    if (outstanding === null) return null;
    if (this.now() - outstanding.resolvedAt >= DISCLOSURE_TTL_MS) return null;
    return outstanding;
  }

  /**
   * Current runtime snapshot. Never returns `'unknown'` - the main process
   * always has an answer; `'unknown'` exists only as the renderer's first frame.
   */
  status(): LlamaRuntimeStatus {
    if (this.busy === true) {
      const pending = this.pending;
      return {
        state: 'downloading',
        tag: pending === null ? null : pending.tag,
        serverPath: null,
        acceleration: pending === null ? null : pending.plan.acceleration,
        fallbackCode: pending === null || pending.plan.fallback === null ? null : pending.plan.fallback.code,
        progress: this.progress,
        errorCode: null,
        errorMessage: null,
      };
    }

    const installed = this.readInstalled();
    if (installed !== null) return installed;

    const failure = this.failure;
    return {
      state: failure === null ? 'missing' : 'failed',
      tag: null,
      serverPath: null,
      acceleration: null,
      fallbackCode: null,
      progress: null,
      errorCode: failure === null ? null : failure.code,
      errorMessage: failure === null ? null : failure.message,
    };
  }

  /** The newest complete install as a `ready` status, or null when none exists. */
  private readInstalled(): LlamaRuntimeStatus | null {
    const dir = this.deps.userDataDir();
    const tags = this.deps.layout.listInstalledTags(dir);
    if (tags.length === 0) return null;
    const tag = tags[0];
    const serverPath = this.deps.layout.installedServerPath(dir, tag);
    if (typeof serverPath !== 'string' || serverPath.length === 0) return null;
    const receipt = this.deps.layout.readReceipt(dir, tag);
    return {
      state: 'ready',
      tag,
      serverPath,
      acceleration: receipt === null ? null : receipt.acceleration,
      fallbackCode: receipt === null || receipt.fallback === null ? null : receipt.fallback.code,
      progress: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  /** What an install would fetch, stated before anything is downloaded. */
  async plan(): Promise<LlamaRuntimePlan> {
    // An outstanding disclosure is re-stated, not replaced. Two rows asking
    // seconds apart must be told the same thing, because either card can be the
    // one the user goes back and confirms and only one of them can be installed.
    // A disclosure past its TTL no longer counts as outstanding.
    const outstanding = this.freshDisclosure();
    const resolved = outstanding === null ? await this.resolve() : outstanding;
    // Whatever we are about to say, that is what install() must do. A failed
    // resolve clears the slot so a stale approval can never be substituted for
    // an answer the user did not get.
    this.disclosed = resolved.kind === 'ok' ? resolved : null;
    if (resolved.kind === 'unsupported') return { kind: 'unsupported', reason: resolved.reason };
    if (resolved.kind === 'unavailable') return { kind: 'unavailable', errorCode: resolved.errorCode };
    return {
      kind: 'ok',
      tag: resolved.tag,
      acceleration: resolved.plan.acceleration,
      fallbackCode: resolved.plan.fallback === null ? null : resolved.plan.fallback.code,
      noteCodes: [...resolved.plan.noteCodes],
      assetCount: resolved.plan.assets.length,
      downloadBytes: resolved.downloadBytes,
      alreadyInstalled: this.deps.layout.listInstalledTags(this.deps.userDataDir()).includes(resolved.tag),
    };
  }

  /**
   * Download + install the runtime. Idempotent: a second press while one is in
   * flight JOINS the first (returns the same promise) rather than starting a
   * rival download or - worse - resolving early with a `downloading` status
   * that its caller would then try to serve a model against. An already
   * installed tag returns `ready` without downloading anything.
   */
  install(): Promise<LlamaRuntimeStatus> {
    const running = this.inflight;
    if (running !== null) return running;
    this.busy = true;
    this.failure = null;
    this.progress = null;
    const run = this.runInstall().finally(() => {
      this.busy = false;
      this.inflight = null;
      this.progress = null;
      this.pending = null;
    });
    this.inflight = run;
    return run;
  }

  /** Abort an in-flight install. The partial download survives for a resume. */
  cancel(): boolean {
    return this.deps.provisioner.cancel();
  }

  /** Never throws - every failure becomes a `failed` status with a code. */
  private async runInstall(): Promise<LlamaRuntimeStatus> {
    // Consume the disclosure rather than resolving again: the tag, the
    // acceleration, the fallback reason and the byte total the user approved
    // are the ones installed. Consumed even on failure, so the next press
    // discloses afresh instead of silently reusing an old approval.
    const outstanding = this.disclosed;
    const approved = this.freshDisclosure();
    this.disclosed = null;
    if (outstanding !== null && approved === null) {
      // A disclosure EXISTED and aged past its TTL: the sentence the user said
      // yes to is no longer the sentence an install would act on. Installing a
      // fresh, never-shown resolution here would be the silent substitution the
      // disclosure exists to forbid - so nothing is fetched. The renderer
      // catches this code, re-plans (which shows today's card), and only a new
      // Confirm installs. A press with NO plan() beforehand is different: no
      // sentence was ever said, so the resolve below is the first and only
      // answer, and installing it breaks no promise.
      return this.failWith(LLAMACPP_DISCLOSURE_EXPIRED, 'disclosure aged past its TTL; re-plan and confirm again');
    }
    const resolved = approved === null ? await this.resolve() : approved;
    if (resolved.kind === 'unsupported') {
      return this.failWith('LLAMACPP_UNSUPPORTED', resolved.reason);
    }
    if (resolved.kind === 'unavailable') {
      return this.failWith(resolved.errorCode, resolved.message);
    }

    this.pending = { tag: resolved.tag, plan: resolved.plan };
    this.deps.emit(this.status());

    try {
      // Hand over the APPROVED PLAN, not the inputs that produced it.
      //
      // This used to pin five fields - tag, backend, platform/arch,
      // cudaRuntimePresent, cudaVariant - and let `ensureInstalled` re-plan
      // from them. Every such field is a field that can be forgotten, and one
      // was: `LlamaProvisionRequest` had no `driverVersion`, so a machine on
      // driver 470.82 was shown "CPU build, 30 MB, CUDA_DRIVER_TOO_OLD"
      // (cudaVariant null, so nothing to pin either) and the re-plan, blind to
      // the driver, ran "newest line wins" and fetched the 512.8 MB CUDA 13.3
      // pair - a build that reports "Available devices: (none)", exits 0 and
      // runs on the CPU, with the receipt recording acceleration 'cuda'.
      //
      // A plan carries the answer instead of the question, so there is no sixth
      // input to forget: the provisioner reads `plan.assets` and fetches those.
      await this.deps.provisioner.ensureInstalled({
        userDataDir: this.deps.userDataDir(),
        plan: resolved.plan,
      });
    } catch (err) {
      return this.failWith(errorCodeOf(err), errorMessageOf(err));
    }

    // Clear `pending` first so status() reads the install from disk, not from
    // what we hoped to install - a receipt is the only proof it is runnable.
    this.pending = null;
    this.busy = false;
    const done = this.status();
    this.deps.emit(done);
    return done;
  }

  private failWith(code: string, message: string): LlamaRuntimeStatus {
    this.pending = null;
    this.busy = false;
    this.failure = { code, message };
    const failed = this.status();
    this.deps.emit(failed);
    return failed;
  }

  /**
   * Resolve the release + asset plan for this machine, folding in the two
   * measurements the release index cannot know about: the NVIDIA driver version
   * (which CUDA line will actually initialise) and whether the CUDA runtime
   * DLLs already resolve (whether the ~373 MB cudart archive is needed).
   *
   * Both re-plans run AFTER the first plan, because only the release knows
   * which CUDA lines it ships and at what version - and both reuse the asset
   * list already fetched rather than hitting the API again. Order matters: the
   * cudart archive's name and the DLL names probed for BOTH depend on which
   * line was chosen, so the driver decision has to come first.
   */
  private async resolve(): Promise<Resolved> {
    const userDataDir = this.deps.userDataDir();
    let backend: HwfitBackend;
    let driverVersion: string | null;
    let first: { release: LlamaRelease; plan: LlamaAssetPlanResult };
    try {
      backend = await this.deps.hwBackend();
      driverVersion = await this.deps.gpuDriverVersion();
      first = await this.deps.provisioner.plan({
        userDataDir,
        backend,
        platform: this.deps.platform(),
        arch: this.deps.arch(),
      });
    } catch (err) {
      return { kind: 'unavailable', errorCode: errorCodeOf(err), message: errorMessageOf(err) };
    }

    if (first.plan.kind === 'unsupported') return { kind: 'unsupported', reason: first.plan.reason };
    const availableAssets = first.release.assets.map((a) => a.name);
    const replan = (extra: { cudaRuntimePresent?: boolean }): LlamaAssetPlanResult =>
      planLlamaAssets({
        platform: this.deps.platform(),
        arch: this.deps.arch(),
        backend,
        tag: first.release.tag,
        availableAssets,
        driverVersion,
        ...extra,
      });

    // 1. The driver decides the CUDA line. `provisioner.plan` did not have it,
    //    so this re-plan is the same question asked with the measurement in
    //    hand - including its right to answer "no build for this machine".
    const withDriver = replan({});
    if (withDriver.kind === 'unsupported') return { kind: 'unsupported', reason: withDriver.reason };
    let plan: LlamaAssetPlan = withDriver;

    // 2. Only now is it known which cudart line to look for on this machine.
    //    The probe's result is not carried out of here as a flag: it is spent
    //    on this re-plan, and the plan that comes back IS the answer.
    const cudart = plan.assets.find((a) => a.role === 'cuda-runtime');
    if (cudart !== undefined) {
      const version = cudartVersion(cudart.name);
      if (version !== '' && this.deps.cudaPresent(version, this.deps.layout.llamaRoot(userDataDir)) === true) {
        const replanned = replan({ cudaRuntimePresent: true });
        // Only take the smaller plan if it is still a plan; otherwise keep the
        // safe one that fetches cudart.
        if (replanned.kind === 'ok') plan = replanned;
      }
    }

    return {
      kind: 'ok',
      tag: first.release.tag,
      plan,
      downloadBytes: sumPlannedBytes(plan, first.release),
      resolvedAt: this.now(),
    };
  }

  private onProgress(p: LlamaProvisionProgress): void {
    if (this.busy !== true) return;
    this.progress = {
      phase: p.phase,
      assetName: p.assetName,
      assetIndex: p.assetIndex,
      assetCount: p.assetCount,
      bytesDone: p.bytesDone,
      bytesTotal: p.bytesTotal,
      totalBytesDone: p.totalBytesDone,
      totalBytesTotal: p.totalBytesTotal,
    };
    this.deps.emit(this.status());
  }
}

let controller: LlamaRuntimeController | null = null;

/** Production deps: real provisioner, real layout reads, real hardware scan. */
function productionController(): LlamaRuntimeController {
  return new LlamaRuntimeController({
    userDataDir: () => app.getPath('userData'),
    hwBackend: async () => (await scanHardware(false)).backend as HwfitBackend,
    // Same scan, not a second probe: `scanHardware` caches and de-duplicates
    // in-flight callers, so this reads the driver off the profile the backend
    // decision just came from.
    gpuDriverVersion: async () => (await scanHardware(false)).gpuDriverVersion || null,
    platform: () => process.platform,
    arch: () => process.arch,
    provisioner: new LlamaCppProvisioner(),
    layout: { installedServerPath, listInstalledTags, readReceipt, llamaRoot },
    // No PATH here on purpose: the probe reads only CUDA_PATH\bin and
    // System32, so a third-party llama.cpp on PATH can no longer masquerade
    // as the machine's own CUDA runtime (see cudaRuntimeProbe.ts).
    cudaPresent: (version, excludeDir) =>
      hasCudaRuntime(
        version,
        {
          cudaPath: process.env.CUDA_PATH,
          systemRoot: process.env.SystemRoot,
        },
        { excludeDirs: [excludeDir] }
      ),
    emit: (status) => ipcBridge.llamaRuntime.onStatus.emit(status),
  });
}

/** Initialize the llama.cpp runtime IPC bridge handlers. */
export function initLlamaRuntimeBridge(): void {
  if (controller === null) controller = productionController();
  const active = controller;
  ipcBridge.llamaRuntime.status.provider(async (): Promise<LlamaRuntimeStatus> => active.status());
  ipcBridge.llamaRuntime.plan.provider(async (): Promise<LlamaRuntimePlan> => active.plan());
  ipcBridge.llamaRuntime.install.provider(async (): Promise<LlamaRuntimeStatus> => active.install());
  ipcBridge.llamaRuntime.cancel.provider(async () => ({ cancelled: active.cancel() }));
}
