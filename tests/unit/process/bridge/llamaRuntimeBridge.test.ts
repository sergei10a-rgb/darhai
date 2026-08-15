/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The state machine behind the Model Advisor's one-press flow.
 *
 * Four promises are what these tests hold it to:
 *   1. It says what an install COSTS before one byte moves - the acceleration,
 *      the reason it is weaker than the hardware, and a byte total summed from
 *      the release index (or null, never a guess).
 *   2. A machine llama.cpp publishes no build for FAILS with a code. It must
 *      never be left in `downloading`, which is what a spinner-forever UI is.
 *   3. The CUDA probe is what turns a ~510 MB download into ~147 MB, and the
 *      tag disclosed is the tag installed.
 *   4. Two rows pressing at once join ONE install; the second must not get a
 *      `downloading` snapshot back and go on to serve a model against a runtime
 *      that is not there yet.
 *
 * The real `planLlamaAssets` runs throughout - a fake plan would keep passing
 * after the mapper changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/userData' } }));
vi.mock('@/common', () => ({
  ipcBridge: {
    llamaRuntime: {
      status: { provider: vi.fn() },
      plan: { provider: vi.fn() },
      install: { provider: vi.fn() },
      cancel: { provider: vi.fn() },
      onStatus: { emit: vi.fn() },
    },
  },
}));
vi.mock('@process/services/hwfit', () => ({ scanHardware: async () => ({ backend: 'cpu_x86' }) }));

import {
  LlamaRuntimeController,
  type LlamaLayoutLike,
  type LlamaProvisionerLike,
  type LlamaRuntimeDeps,
} from '@process/bridge/engine/llamaRuntimeBridge';
import { planLlamaAssets, type LlamaAssetPlan, type LlamaAssetPlanResult } from '@process/services/llamacpp';
import type { LlamaRuntimeStatus } from '@/common/types/llamacpp';

/** Placeholder callable, hoisted so the linter does not see a per-call closure. */
const NOOP = (): void => undefined;

const TAG = 'b10437';
const USER_DATA = '/userData';

const SERVER_CUDA = `llama-${TAG}-bin-win-cuda-13.3-x64.zip`;
const CUDART = `cudart-llama-bin-win-cuda-13.3-x64.zip`;
const SERVER_CUDA_12 = `llama-${TAG}-bin-win-cuda-12.4-x64.zip`;
const CUDART_12 = `cudart-llama-bin-win-cuda-12.4-x64.zip`;
const SERVER_CPU = `llama-${TAG}-bin-win-cpu-x64.zip`;

const SERVER_CUDA_BYTES = 147_000_000;
const CUDART_BYTES = 373_000_000;
const CPU_BYTES = 30_000_000;
// Measured on the real b10441 release: the 12.4 pair is 250,792,863 B and
// 391,443,627 B, so the older line is the LARGER download - the reason to pick
// it has to be the driver, never the size.
const CUDA_12_BYTES = 250_792_863;
const CUDART_12_BYTES = 391_443_627;

/** A release index shaped like the real GitHub one, with measured sizes. */
function windowsRelease() {
  return {
    tag: TAG,
    assets: [
      { name: SERVER_CUDA, url: 'https://x/1', bytes: SERVER_CUDA_BYTES, sha256: 'a'.repeat(64) },
      { name: CUDART, url: 'https://x/2', bytes: CUDART_BYTES, sha256: 'b'.repeat(64) },
      { name: SERVER_CPU, url: 'https://x/3', bytes: CPU_BYTES, sha256: 'c'.repeat(64) },
    ],
  };
}

/** The same shape for any tag/size, for "latest moved between the two calls". */
function releaseFor(tag: string, cudaBytes: number): ReturnType<typeof windowsRelease> {
  return {
    tag,
    assets: [
      {
        name: `llama-${tag}-bin-win-cuda-13.3-x64.zip`,
        url: 'https://x/1',
        bytes: cudaBytes,
        sha256: 'a'.repeat(64),
      },
      {
        name: `cudart-llama-bin-win-cuda-13.3-x64.zip`,
        url: 'https://x/2',
        bytes: CUDART_BYTES,
        sha256: 'b'.repeat(64),
      },
      { name: `llama-${tag}-bin-win-cpu-x64.zip`, url: 'https://x/3', bytes: CPU_BYTES, sha256: 'c'.repeat(64) },
    ],
  };
}

/** A release that ships BOTH CUDA lines, as every real win/x64 release does. */
function twoCudaLinesRelease() {
  return {
    tag: TAG,
    assets: [
      { name: SERVER_CUDA, url: 'https://x/1', bytes: SERVER_CUDA_BYTES, sha256: 'a'.repeat(64) },
      { name: CUDART, url: 'https://x/2', bytes: CUDART_BYTES, sha256: 'b'.repeat(64) },
      { name: SERVER_CUDA_12, url: 'https://x/4', bytes: CUDA_12_BYTES, sha256: 'd'.repeat(64) },
      { name: CUDART_12, url: 'https://x/5', bytes: CUDART_12_BYTES, sha256: 'e'.repeat(64) },
      { name: SERVER_CPU, url: 'https://x/3', bytes: CPU_BYTES, sha256: 'c'.repeat(64) },
    ],
  };
}

type Harness = {
  deps: LlamaRuntimeDeps;
  controller: LlamaRuntimeController;
  emitted: LlamaRuntimeStatus[];
  ensureCalls: Array<Record<string, unknown>>;
  /** One entry per `provisioner.plan` call - i.e. per release-index fetch. */
  planCalls: Array<Record<string, unknown>>;
  /**
   * The archive names that actually reached disk, in order.
   *
   * This is the assertion that matters: which fields the bridge pinned is an
   * implementation detail, WHAT GOT DOWNLOADED is the promise. A test that only
   * checks `ensureCalls[0].tag` passes while a 512.8 MB CUDA pair is fetched
   * behind a card that said "CPU build, 30 MB".
   */
  installedAssets: string[];
  /**
   * How many times `resolve()` has started, counted at its first dep call.
   * `planCalls` cannot stand in for this: a resolve that throws from the
   * release fetch never records one.
   */
  resolveAttempts: { count: number };
  provisioner: LlamaProvisionerLike & { fire: (p: Record<string, unknown>) => void };
};

type HarnessOptions = {
  backend?: 'cuda' | 'cpu_x86' | 'metal';
  platform?: string;
  arch?: string;
  release?: ReturnType<typeof windowsRelease>;
  /**
   * A release index that MOVES: call N of `provisioner.plan` sees entry N, and
   * the last entry sticks. llama.cpp publishes several releases a day, so the
   * two resolutions behind one button press can legitimately disagree - a
   * harness with a single immutable release cannot express that, and a guard
   * against it tested that way passes even when the guard is deleted.
   */
  releases?: Array<ReturnType<typeof windowsRelease>>;
  /** Throw from the release fetch, i.e. offline. */
  planError?: Error;
  /** Throw from the install itself. */
  installError?: Error;
  cudaPresent?: boolean;
  /** Measured NVIDIA driver version; null means the probe stated none. */
  driverVersion?: string | null;
  installedTags?: string[];
  /** Resolve `ensureInstalled` only when this is called. */
  gate?: { promise: Promise<void>; release: () => void };
};

function makeHarness(opts: HarnessOptions = {}): Harness {
  const platform = opts.platform || 'win32';
  const arch = opts.arch || 'x64';
  const releases = opts.releases || [opts.release || windowsRelease()];
  const emitted: LlamaRuntimeStatus[] = [];
  const ensureCalls: Array<Record<string, unknown>> = [];
  const planCalls: Array<Record<string, unknown>> = [];
  const installedAssets: string[] = [];
  let progressListener: (p: Record<string, unknown>) => void = NOOP;
  const installedTags = opts.installedTags ? [...opts.installedTags] : [];

  /** The release "latest" resolves to on this fetch, then it moves on. */
  const nextRelease = (): ReturnType<typeof windowsRelease> =>
    releases[Math.min(planCalls.length - 1, releases.length - 1)];

  type PlanRequest = {
    backend: 'cuda' | 'cpu_x86' | 'metal';
    cudaRuntimePresent?: boolean;
    cudaVariant?: string;
    tag?: string;
  };

  /**
   * One resolution, done the way the REAL `LlamaCppProvisioner.plan` does it -
   * including what it does NOT receive. `driverVersion` is deliberately absent:
   * `LlamaProvisionRequest` has no such field, so a re-plan inside the
   * provisioner is blind to the driver measurement. A harness that quietly
   * supplied it would hide the exact defect this file has to be able to catch.
   */
  const resolveFor = (request: PlanRequest) => {
    planCalls.push(request);
    const pinned = request.tag ? releases.find((r) => r.tag === request.tag) : undefined;
    const release = pinned || nextRelease();
    return {
      release,
      plan: planLlamaAssets({
        platform,
        arch,
        backend: request.backend,
        tag: release.tag,
        availableAssets: release.assets.map((a) => a.name),
        cudaRuntimePresent: request.cudaRuntimePresent,
        cudaVariant: request.cudaVariant,
      }),
    };
  };

  const provisioner = {
    plan: async (request: PlanRequest) => {
      if (opts.planError) throw opts.planError;
      return resolveFor(request);
    },
    ensureInstalled: async (request: Record<string, unknown>) => {
      ensureCalls.push(request);
      if (opts.gate) await opts.gate.promise;
      if (opts.installError) throw opts.installError;
      // Mirrors the real provisioner on BOTH branches. A pinned `plan` is
      // installed verbatim and nothing is re-decided; without one it re-plans
      // from the request's inputs against whatever "latest" is now - which is
      // how an input nobody carried across (the driver version) turned a
      // disclosed CPU install into a CUDA one.
      const approved = request.plan as LlamaAssetPlan | undefined;
      const chosen: LlamaAssetPlanResult = approved === undefined ? resolveFor(request as PlanRequest).plan : approved;
      if (chosen.kind !== 'ok') throw Object.assign(new Error(chosen.reason), { code: 'LLAMACPP_UNSUPPORTED' });
      for (const asset of chosen.assets) installedAssets.push(asset.name);
      installedTags.unshift(chosen.tag);
      return {};
    },
    cancel: (): boolean => true,
    on: (_event: 'progress', listener: (p: Record<string, unknown>) => void): undefined => {
      progressListener = listener;
      return undefined;
    },
    fire: (p: Record<string, unknown>): void => progressListener(p),
  };

  const layout: LlamaLayoutLike = {
    installedServerPath: (_dir, tag) =>
      installedTags.includes(String(tag)) ? `/userData/llamacpp/versions/${tag}/llama-server.exe` : null,
    listInstalledTags: () => [...installedTags],
    readReceipt: (_dir, tag) =>
      installedTags.includes(tag)
        ? ({
            schema: 1,
            tag,
            platform,
            arch,
            requestedBackend: 'cuda',
            acceleration: 'cpu',
            fallback: { from: 'cuda', to: 'cpu', code: 'NO_GPU_BUILD_FOR_TARGET', reason: 'measured' },
            serverRelPath: 'llama-server.exe',
            assets: [],
            fileCount: 1,
            installedAt: '2026-08-15T00:00:00.000Z',
          } as never)
        : null,
    llamaRoot: (dir) => `${dir}/llamacpp`,
  };

  const resolveAttempts = { count: 0 };

  const deps: LlamaRuntimeDeps = {
    userDataDir: () => USER_DATA,
    hwBackend: async () => {
      // `resolve()` calls this first, so it counts resolutions that are STARTED
      // - including the ones that go on to fail.
      resolveAttempts.count += 1;
      return opts.backend || 'cuda';
    },
    // 610.62 is the driver measured on the reference RTX 4070 box, so the
    // default harness machine is the one the feature was measured on.
    gpuDriverVersion: async () => (opts.driverVersion === undefined ? '610.62' : opts.driverVersion),
    platform: () => platform,
    arch: () => arch,
    provisioner: provisioner as unknown as LlamaProvisionerLike,
    layout,
    cudaPresent: () => opts.cudaPresent === true,
    emit: (status) => emitted.push(status),
  };

  return {
    deps,
    controller: new LlamaRuntimeController(deps),
    emitted,
    ensureCalls,
    planCalls,
    installedAssets,
    resolveAttempts,
    provisioner: provisioner as unknown as Harness['provisioner'],
  };
}

/** The plan the bridge handed the provisioner on install call `index`. */
function approvedPlan(ensureCalls: Array<Record<string, unknown>>, index = 0): LlamaAssetPlan {
  return ensureCalls[index].plan as LlamaAssetPlan;
}

function openGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = NOOP;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LlamaRuntimeController.status', () => {
  it('reports missing when no install exists', () => {
    const { controller } = makeHarness();
    const status = controller.status();
    expect(status.state).toBe('missing');
    expect(status.serverPath).toBeNull();
    expect(status.errorCode).toBeNull();
  });

  it('reports ready with the tag, path and the receipt acceleration', () => {
    const { controller } = makeHarness({ installedTags: [TAG] });
    const status = controller.status();
    expect(status.state).toBe('ready');
    expect(status.tag).toBe(TAG);
    expect(status.serverPath).toBe(`/userData/llamacpp/versions/${TAG}/llama-server.exe`);
    expect(status.acceleration).toBe('cpu');
    expect(status.fallbackCode).toBe('NO_GPU_BUILD_FOR_TARGET');
  });
});

describe('LlamaRuntimeController.plan - what it costs, before it costs it', () => {
  it('sums the planned assets from the release index', async () => {
    const { controller } = makeHarness({ backend: 'cuda' });
    const plan = await controller.plan();
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.acceleration).toBe('cuda');
    expect(plan.assetCount).toBe(2);
    expect(plan.downloadBytes).toBe(SERVER_CUDA_BYTES + CUDART_BYTES);
    expect(plan.fallbackCode).toBeNull();
    expect(plan.alreadyInstalled).toBe(false);
  });

  it('drops the cudart archive when this machine already has the CUDA runtime', async () => {
    const { controller } = makeHarness({ backend: 'cuda', cudaPresent: true });
    const plan = await controller.plan();
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.assetCount).toBe(1);
    expect(plan.downloadBytes).toBe(SERVER_CUDA_BYTES);
  });

  it('states the CPU fallback and its reason when no GPU build exists', async () => {
    const release = {
      tag: TAG,
      assets: [{ name: SERVER_CPU, url: 'https://x/3', bytes: CPU_BYTES, sha256: 'c'.repeat(64) }],
    };
    const { controller } = makeHarness({ backend: 'cuda', release });
    const plan = await controller.plan();
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.acceleration).toBe('cpu');
    expect(plan.fallbackCode).toBe('NO_GPU_BUILD_FOR_TARGET');
    expect(plan.downloadBytes).toBe(CPU_BYTES);
  });

  it('reports downloadBytes null rather than a partial sum when a size is missing', async () => {
    const release = windowsRelease();
    release.assets[1] = { ...release.assets[1], bytes: 0 };
    const { controller } = makeHarness({ backend: 'cuda', release });
    const plan = await controller.plan();
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.assetCount).toBe(2);
    expect(plan.downloadBytes).toBeNull();
  });

  it('says unsupported for a platform llama.cpp publishes nothing for', async () => {
    const { controller } = makeHarness({ platform: 'freebsd' });
    const plan = await controller.plan();
    expect(plan.kind).toBe('unsupported');
  });

  it('says unavailable - not unsupported - when the release list cannot be read', async () => {
    const offline = Object.assign(new Error('offline'), { code: 'LLAMACPP_OFFLINE' });
    const { controller } = makeHarness({ planError: offline });
    const plan = await controller.plan();
    expect(plan.kind).toBe('unavailable');
    if (plan.kind !== 'unavailable') return;
    expect(plan.errorCode).toBe('LLAMACPP_OFFLINE');
  });

  it('marks an already-installed tag so the caller can skip the disclosure', async () => {
    const { controller } = makeHarness({ installedTags: [TAG] });
    const plan = await controller.plan();
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.alreadyInstalled).toBe(true);
  });
});

describe('LlamaRuntimeController.install', () => {
  it('installs and ends ready, pinning the tag it disclosed', async () => {
    const { controller, ensureCalls, installedAssets } = makeHarness({ backend: 'cuda' });
    const status = await controller.install();
    expect(status.state).toBe('ready');
    expect(status.tag).toBe(TAG);
    expect(ensureCalls).toHaveLength(1);
    expect(approvedPlan(ensureCalls).tag).toBe(TAG);
    // The cudart archive is in the plan, which is what "the runtime is not
    // already present" MEANS - asserted as the download it causes, not as the
    // boolean that was passed.
    expect(installedAssets).toEqual([SERVER_CUDA, CUDART]);
  });

  it('passes cudaRuntimePresent through so the 373 MB archive is skipped', async () => {
    const { controller, installedAssets } = makeHarness({ backend: 'cuda', cudaPresent: true });
    await controller.install();
    expect(installedAssets).toEqual([SERVER_CUDA]);
  });

  it('fails with LLAMACPP_UNSUPPORTED instead of spinning on an unbuildable machine', async () => {
    const { controller } = makeHarness({ platform: 'freebsd' });
    const status = await controller.install();
    expect(status.state).toBe('failed');
    expect(status.errorCode).toBe('LLAMACPP_UNSUPPORTED');
    expect(controller.status().state).toBe('failed');
  });

  it('surfaces the provisioner error code on a failed install', async () => {
    const boom = Object.assign(new Error('digest mismatch'), { code: 'LLAMACPP_DIGEST_MISMATCH' });
    const { controller } = makeHarness({ installError: boom });
    const status = await controller.install();
    expect(status.state).toBe('failed');
    expect(status.errorCode).toBe('LLAMACPP_DIGEST_MISMATCH');
  });

  it('joins a concurrent second press onto the same install', async () => {
    const gate = openGate();
    const { controller, ensureCalls } = makeHarness({ gate });
    const first = controller.install();
    const second = controller.install();
    expect(controller.status().state).toBe('downloading');
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect(ensureCalls).toHaveLength(1);
    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
  });

  it('emits measured byte totals while downloading, never an invented one', async () => {
    const gate = openGate();
    const { controller, provisioner, emitted } = makeHarness({ gate });
    const running = controller.install();
    await Promise.resolve();
    await Promise.resolve();
    provisioner.fire({
      phase: 'downloading',
      assetName: SERVER_CUDA,
      assetIndex: 1,
      assetCount: 2,
      bytesDone: 1000,
      bytesTotal: SERVER_CUDA_BYTES,
      totalBytesDone: 1000,
      totalBytesTotal: SERVER_CUDA_BYTES + CUDART_BYTES,
    });
    const frame = emitted.at(-1) as LlamaRuntimeStatus;
    expect(frame.state).toBe('downloading');
    expect(frame.progress).not.toBeNull();
    expect(frame.progress.totalBytesTotal).toBe(SERVER_CUDA_BYTES + CUDART_BYTES);
    expect(frame.progress.totalBytesDone).toBe(1000);
    gate.release();
    await running;
  });

  it('clears progress once the install settles', async () => {
    const { controller } = makeHarness();
    await controller.install();
    expect(controller.status().progress).toBeNull();
  });
});

/**
 * The disclosure is a promise, and these are the tests that make it one.
 *
 * `plan()` and `install()` are two presses seconds apart. Between them "latest"
 * can move - llama.cpp publishes several releases a day - so an `install()`
 * that resolves independently can fetch a different tag, of a different size,
 * with a different acceleration than the sentence the user just approved.
 */
describe('LlamaRuntimeController.install - installs what it disclosed', () => {
  it('installs the disclosed tag even though "latest" moved in between', async () => {
    const disclosed = releaseFor(TAG, CPU_BYTES);
    const moved = releaseFor('b10440', 900_000_000);
    const { controller, ensureCalls, planCalls } = makeHarness({ releases: [disclosed, moved] });

    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.tag).toBe(TAG);
    const shownBytes = shown.downloadBytes;

    const status = await controller.install();

    expect(ensureCalls).toHaveLength(1);
    expect(approvedPlan(ensureCalls).tag).toBe(TAG);
    expect(status.tag).toBe(TAG);
    // One resolution for the whole press: the approved plan is reused, so there
    // is no second answer that could disagree with the first.
    expect(planCalls).toHaveLength(1);
    expect(shownBytes).toBe(CPU_BYTES + CUDART_BYTES);
  });

  it('discloses afresh for a second press rather than reusing the old approval', async () => {
    const first = releaseFor(TAG, CPU_BYTES);
    const second = releaseFor('b10440', CPU_BYTES);
    const { controller, ensureCalls } = makeHarness({ releases: [first, second] });

    await controller.plan();
    await controller.install();
    // No new disclosure: the approval was consumed, so this resolves fresh and
    // lands on whatever "latest" is now.
    await controller.install();

    expect(ensureCalls).toHaveLength(2);
    expect(approvedPlan(ensureCalls, 0).tag).toBe(TAG);
    expect(approvedPlan(ensureCalls, 1).tag).toBe('b10440');
  });

  it('does not carry a failed plan forward as an approval', async () => {
    const offline = Object.assign(new Error('offline'), { code: 'LLAMACPP_OFFLINE' });
    const { controller } = makeHarness({ planError: offline });
    const shown = await controller.plan();
    expect(shown.kind).toBe('unavailable');
    const status = await controller.install();
    expect(status.state).toBe('failed');
    expect(status.errorCode).toBe('LLAMACPP_OFFLINE');
  });

  it('pins the CUDA line it disclosed, so the install cannot re-pick the newest', async () => {
    // 552.22 is an r550 driver: CUDA 12 (floor 527.41 on Windows) yes,
    // CUDA 13 (floor 580.65.06) no.
    const { controller, ensureCalls, installedAssets } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
      driverVersion: '552.22',
    });
    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.noteCodes).toContain('CUDA_LINE_OLDER_FOR_DRIVER');
    expect(shown.downloadBytes).toBe(CUDA_12_BYTES + CUDART_12_BYTES);

    await controller.install();
    expect(approvedPlan(ensureCalls).cudaVariant).toBe('12.4');
    expect(installedAssets).toEqual([SERVER_CUDA_12, CUDART_12]);
  });
});

/**
 * The driver measurement has to SURVIVE the trip into the install.
 *
 * `resolve()` re-plans with the measured driver and may honestly answer "CPU
 * build, because your driver predates every CUDA build in this release". That
 * answer used to be reconstructed inside `ensureInstalled` from a handful of
 * pinned INPUTS - and `LlamaProvisionRequest` had no `driverVersion`, while a
 * CPU fallback has `cudaVariant: null` and so pinned nothing on the CUDA axis
 * either. The re-plan therefore ran "newest line wins" blind, and a card that
 * said 30 MB fetched 512.8 MB of CUDA 13.3 that the driver cannot load.
 */
describe('LlamaRuntimeController.install - the driver decision reaches the download', () => {
  it('installs the CPU build it disclosed on a driver older than every CUDA line', async () => {
    // 470.82 is below the CUDA 12 floor on either OS, so no line is loadable.
    const { controller, ensureCalls, installedAssets } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
      driverVersion: '470.82',
    });

    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.acceleration).toBe('cpu');
    expect(shown.fallbackCode).toBe('CUDA_DRIVER_TOO_OLD');
    expect(shown.downloadBytes).toBe(CPU_BYTES);

    await controller.install();

    // The bytes, not the boolean: the card promised the 30 MB CPU archive and
    // nothing else, so that is the only archive allowed to reach disk.
    expect(installedAssets).toEqual([SERVER_CPU]);
    expect(approvedPlan(ensureCalls).acceleration).toBe('cpu');
    expect(approvedPlan(ensureCalls).fallback.code).toBe('CUDA_DRIVER_TOO_OLD');
  });

  it('installs the disclosed CPU build even with no plan() beforehand', async () => {
    // Straight to install: `runInstall` resolves for itself, and that
    // resolution is equally bound - it is the same driver-aware answer.
    const { controller, installedAssets } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
      driverVersion: '470.82',
    });
    const status = await controller.install();
    expect(status.state).toBe('ready');
    expect(installedAssets).toEqual([SERVER_CPU]);
  });
});

/**
 * One outstanding disclosure, shared by every caller.
 *
 * `useLlamaRuntime` is mounted once and handed to all 121 advisor rows, but
 * each row renders its card from its own React state. While `disclosed` was
 * last-write-wins, pressing Serve on row A and then on row B re-resolved into
 * the same slot, so confirming A's card installed B's resolution.
 */
describe('LlamaRuntimeController.plan - two rows cannot be told different things', () => {
  it('re-states the outstanding disclosure instead of re-resolving for a second row', async () => {
    const first = releaseFor(TAG, CPU_BYTES);
    const moved = releaseFor('b10442', 99_000_000);
    const { controller, ensureCalls, planCalls, installedAssets } = makeHarness({
      backend: 'cuda',
      releases: [first, moved],
    });

    const cardA = await controller.plan();
    const cardB = await controller.plan();
    expect(cardA.kind).toBe('ok');
    expect(cardB.kind).toBe('ok');
    if (cardA.kind !== 'ok' || cardB.kind !== 'ok') return;

    // Row B is shown row A's answer, because only one of them can be installed.
    expect(cardA.tag).toBe(TAG);
    expect(cardB.tag).toBe(cardA.tag);
    expect(cardB.downloadBytes).toBe(cardA.downloadBytes);
    expect(planCalls).toHaveLength(1);

    // The user goes back and confirms A's card.
    await controller.install();
    expect(approvedPlan(ensureCalls).tag).toBe(cardA.tag);
    expect(installedAssets[0]).toBe(`llama-${cardA.tag}-bin-win-cuda-13.3-x64.zip`);
  });

  it('still discloses afresh once the outstanding one has been consumed', async () => {
    const first = releaseFor(TAG, CPU_BYTES);
    const moved = releaseFor('b10442', 99_000_000);
    const { controller } = makeHarness({ backend: 'cuda', releases: [first, moved] });

    await controller.plan();
    await controller.install();
    const after = await controller.plan();
    expect(after.kind).toBe('ok');
    if (after.kind !== 'ok') return;
    expect(after.tag).toBe('b10442');
  });

  it('does not reuse a resolution that failed', async () => {
    const offline = Object.assign(new Error('offline'), { code: 'LLAMACPP_OFFLINE' });
    const { controller, resolveAttempts } = makeHarness({ planError: offline });
    expect((await controller.plan()).kind).toBe('unavailable');
    expect((await controller.plan()).kind).toBe('unavailable');
    // Nothing was disclosed, so the second press really does ask again rather
    // than re-stating a slot that was never filled.
    expect(resolveAttempts.count).toBe(2);
  });
});

describe('LlamaRuntimeController.plan - the driver decides the CUDA line', () => {
  it('takes the newest line on the measured 610.62 driver', async () => {
    const { controller, ensureCalls, installedAssets } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
    });
    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.downloadBytes).toBe(SERVER_CUDA_BYTES + CUDART_BYTES);
    expect(shown.noteCodes).toEqual([]);
    await controller.install();
    expect(approvedPlan(ensureCalls).cudaVariant).toBe('13.3');
    expect(installedAssets).toEqual([SERVER_CUDA, CUDART]);
  });

  it('marks the line unverified when no driver version could be measured', async () => {
    const { controller } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
      driverVersion: null,
    });
    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.noteCodes).toContain('CUDA_LINE_UNVERIFIED');
  });

  it('states the CPU fallback when the driver predates every CUDA build', async () => {
    const { controller } = makeHarness({
      backend: 'cuda',
      release: twoCudaLinesRelease(),
      driverVersion: '470.82',
    });
    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.acceleration).toBe('cpu');
    expect(shown.fallbackCode).toBe('CUDA_DRIVER_TOO_OLD');
    expect(shown.downloadBytes).toBe(CPU_BYTES);
  });

  it('carries the Vulkan note across IPC instead of dropping it', async () => {
    // A Windows machine with an Intel GPU: hwfit types it cpu_x86, the CPU
    // build is what it gets, and the release does ship a Vulkan build.
    const release = twoCudaLinesRelease();
    release.assets.push({
      name: `llama-${TAG}-bin-win-vulkan-x64.zip`,
      url: 'https://x/6',
      bytes: 34_580_767,
      sha256: 'f'.repeat(64),
    });
    const { controller } = makeHarness({ backend: 'cpu_x86', release });
    const shown = await controller.plan();
    expect(shown.kind).toBe('ok');
    if (shown.kind !== 'ok') return;
    expect(shown.acceleration).toBe('cpu');
    expect(shown.fallbackCode).toBeNull();
    expect(shown.noteCodes).toContain('VULKAN_BUILD_NOT_REQUESTABLE');
  });
});
