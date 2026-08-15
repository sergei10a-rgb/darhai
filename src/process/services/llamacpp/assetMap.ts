/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure (platform, arch, backend) -> llama.cpp release asset mapper.
 *
 * Everything here is a function of its arguments: no `process.*`, no network,
 * no filesystem. The caller passes the asset *names the release actually ships*
 * (`availableAssets`), so this never invents a name that would 404 - if a build
 * is absent from the release it says so and falls back, rather than guessing.
 *
 * Measured against ggml-org/llama.cpp release b10437 on 2026-08-15
 * (`gh api repos/ggml-org/llama.cpp/releases/latest`):
 *
 *   - Windows ships `win-cpu-{x64,arm64}`, `win-cuda-{12.4,13.3}-x64`,
 *     `win-cuda-13.4-arm64`, `win-rocm-7.14-x64`, `win-vulkan-x64`.
 *   - Linux ships `ubuntu-{x64,arm64}` and `ubuntu-vulkan-{x64,arm64}` - and
 *     NO cuda and NO rocm build. A Linux NVIDIA/AMD box therefore gets the CPU
 *     build, and {@link LlamaAssetPlan.fallback} says so out loud.
 *   - macOS ships `macos-arm64` (contains `libggml-metal.dylib`) and
 *     `macos-x64` (contains only `libggml-blas.dylib` - NO Metal). An Intel Mac
 *     asking for `metal` therefore also gets a stated CPU fallback.
 *   - `win-vulkan-x64` / `ubuntu-vulkan-*` exist but are unreachable from
 *     {@link HwfitBackend}, which has no `vulkan` member. A Windows machine
 *     with an Intel/other GPU is typed `cpu_x86` by hwfit and lands on the CPU
 *     build. That is not silently accepted: EVERY cpu outcome checks the
 *     release for a Vulkan build and, when one exists, emits
 *     `VULKAN_BUILD_NOT_REQUESTABLE` in {@link LlamaAssetPlan.noteCodes} so the
 *     user is told they are getting the slow build and why. Reaching the Vulkan
 *     build itself is deliberately NOT done here: hwfit reports no
 *     Vulkan-capable device, so choosing that build would be picking an
 *     accelerator nothing on this machine has been measured to support.
 *
 * The CUDA LINE is chosen from the measured driver, not by "newest wins" - see
 * {@link CUDA_MIN_DRIVER} and {@link pickCudaVersioned}.
 *
 * The CUDA runtime split is the expensive decision and was measured by reading
 * each archive's central directory over HTTP Range:
 *
 *   llama-b10437-bin-win-cuda-13.3-x64.zip  (140 MB) -> ggml-cuda.dll + 51 more
 *   cudart-llama-bin-win-cuda-13.3-x64.zip  (373 MB) -> EXACTLY three entries:
 *                       cublas64_13.dll, cublasLt64_13.dll, cudart64_13.dll
 *
 * The server archive does not contain those three DLLs, so `llama-server.exe`
 * cannot load `ggml-cuda.dll` without them. They ship with the CUDA *Toolkit*,
 * not the NVIDIA *driver* (a driver-only machine has `nvcuda.dll` in System32
 * and none of the three - verified on the dev box, where `CUDA_PATH` is empty).
 * So the cudart archive is required unless the machine already resolves those
 * DLLs; {@link LlamaAssetPlanInput.cudaRuntimePresent} carries that measurement
 * in, and the caller gets ~140 MB instead of ~510 MB when it is true.
 */

import type { HwfitBackend } from '@/common/types/hwfit';
import type { LlamaRuntimeFallbackCode, LlamaRuntimeNoteCode } from '@/common/types/llamacpp';

/** Platforms with a llama.cpp release build. */
export type LlamaPlatform = 'win32' | 'darwin' | 'linux';

/** Architectures with a llama.cpp release build. */
export type LlamaArch = 'x64' | 'arm64';

/** What the chosen build actually accelerates with. */
export type LlamaAcceleration = 'cuda' | 'rocm' | 'metal' | 'cpu';

/** Container format of a release asset - drives which extractor runs. */
export type LlamaArchiveFormat = 'zip' | 'tar.gz';

/**
 * Why an asset is in the plan. `server` carries `llama-server`; `cuda-runtime`
 * is the separate cudart archive that only exists because the server archive
 * omits cuBLAS/cudart (see the module comment).
 */
export type LlamaAssetRole = 'server' | 'cuda-runtime';

export type LlamaAssetRef = {
  role: LlamaAssetRole;
  /** Exact release asset name, taken from `availableAssets`. */
  name: string;
  format: LlamaArchiveFormat;
};

/**
 * Why a stated fallback happened, as a stable identifier.
 *
 * The renderer ships 13 locales, so the prose in {@link LlamaBackendFallback.reason}
 * cannot be what the user reads - it is a developer-facing diagnostic. This code
 * is the thing to key an i18n message off.
 *
 * Aliased to the shared union rather than re-declared: this list and the one the
 * renderer keys its i18n off MUST be the same list, and two copies of a union
 * that "happen to agree" is how a code ships with no locale string behind it.
 */
export type LlamaFallbackCode = LlamaRuntimeFallbackCode;

/** Non-fatal remark about how the plan was chosen. Same aliasing rule. */
export type LlamaNoteCode = LlamaRuntimeNoteCode;

/** A backend was requested that this release has no build for. */
export type LlamaBackendFallback = {
  from: HwfitBackend;
  to: LlamaAcceleration;
  /** Stable, localizable identifier. Use this for user-facing copy. */
  code: LlamaFallbackCode;
  /** English diagnostic detail - for logs and the receipt, not for the UI. */
  reason: string;
};

export type LlamaAssetPlan = {
  kind: 'ok';
  tag: string;
  platform: LlamaPlatform;
  arch: LlamaArch;
  requestedBackend: HwfitBackend;
  /** What the assets below actually give you. */
  acceleration: LlamaAcceleration;
  assets: LlamaAssetRef[];
  /** Basename of the server executable inside the extracted tree. */
  serverBinaryName: string;
  /** Non-null exactly when {@link acceleration} is weaker than requested. */
  fallback: LlamaBackendFallback | null;
  /**
   * CUDA toolkit line of the chosen build (e.g. `'13.3'`), or null when this
   * plan is not a CUDA one. The caller PINS this on the install so the second
   * resolve cannot silently land on a different line than the one described.
   */
  cudaVariant: string | null;
  /** Non-fatal remarks worth showing next to the download button. */
  notes: string[];
  /** The same remarks as stable identifiers, for localized UI copy. */
  noteCodes: LlamaNoteCode[];
};

/**
 * WHY a target has no plan, as a stable identifier.
 *
 * `platform` / `arch` are permanent facts about the machine - llama.cpp has
 * never published a FreeBSD or 32-bit build and no amount of retrying changes
 * that. `asset-missing` is a fact about ONE RELEASE: the platform is supported,
 * this particular release just does not (yet) list the archive. The two are
 * indistinguishable in prose and must not be treated alike, because a GitHub
 * release is created BEFORE its assets finish uploading - measured on
 * ggml-org/llama.cpp b10442, published 14:58:24Z with its 26 assets landing
 * between +15 s and +92 s, and the win/x64 CPU archive only at +53 s. Anything
 * resolving `latest` inside that window sees a real release that genuinely
 * lists no build for this machine. See {@link LlamaCppProvisioner.plan}, which
 * walks back to a complete release rather than reporting an upload window as a
 * permanent verdict.
 */
export type LlamaAssetUnsupportedCause = 'platform' | 'arch' | 'asset-missing';

export type LlamaAssetUnsupported = {
  kind: 'unsupported';
  /** Whether this is a fact about the machine or about one release. */
  cause: LlamaAssetUnsupportedCause;
  reason: string;
};

export type LlamaAssetPlanResult = LlamaAssetPlan | LlamaAssetUnsupported;

export type LlamaAssetPlanInput = {
  /** Raw `process.platform`. Anything outside win32/darwin/linux is unsupported. */
  platform: string;
  /** Raw `process.arch`. Anything outside x64/arm64 is unsupported. */
  arch: string;
  backend: HwfitBackend;
  /** llama.cpp release tag, e.g. `b10437`. Appears in every server asset name. */
  tag: string;
  /** Asset names the release actually ships. Nothing outside this list is planned. */
  availableAssets: readonly string[];
  /**
   * True when cublas/cublasLt/cudart already resolve on this machine, which
   * drops the ~373 MB cudart archive from the plan. Defaults to false, i.e.
   * fetch it - the safe answer, because a driver-only machine lacks them.
   */
  cudaRuntimePresent?: boolean;
  /** Pin a CUDA toolkit line (e.g. `'12.4'` for pre-CUDA-13 drivers). */
  cudaVariant?: string;
  /**
   * Measured NVIDIA driver version, exactly as `nvidia-smi
   * --query-gpu=driver_version` prints it (e.g. `'610.62'`). Absent/empty means
   * NOT MEASURED, which is a different answer from "old" - see
   * {@link CUDA_MIN_DRIVER}.
   */
  driverVersion?: string | null;
};

/**
 * Minimum NVIDIA driver each CUDA MAJOR line needs, as the FULL dotted version
 * NVIDIA publishes, per OS.
 *
 * Read from NVIDIA's "CUDA Toolkit and Corresponding Driver Versions" (Table 3
 * of docs.nvidia.com/cuda/cuda-toolkit-release-notes, re-read 2026-08-15):
 *
 *   CUDA 12.0 GA  Linux x86_64 `>=525.60.13`   Windows `>=527.41`
 *   CUDA 13.0 GA  Linux x86_64 `>=580.65.06`   Windows `N/A`
 *
 * Keyed by MAJOR because that is what actually gates loading: CUDA minor
 * version compatibility means a binary built against 12.4 runs on any driver
 * meeting the 12.0 GA floor. The line's own toolkit floor (12.4 wants
 * >=550.54.14) is NOT the number to test.
 *
 * Comparing majors only - what this table used to store, `{'12': 525}` - is
 * what the previous comment claimed was "correct on both". It is not, and the
 * counter-example was internal to this file: `driverMajor >= 525` admits every
 * Windows driver in 525.00-527.40, all of which the same comment cites as below
 * the 527.41 floor. Those drivers then get a CUDA 12 build that cannot
 * initialise, which llama.cpp reports as "Available devices: (none)", exit 0,
 * on the CPU - the exact silent outcome this table exists to prevent, one
 * branch below the case it caught. So the floors are stored whole and compared
 * with {@link compareVersions}.
 *
 * NVIDIA prints `N/A` in the Windows column from CUDA 13 on, noting the Windows
 * display driver is no longer bundled with the toolkit and must meet the stated
 * minimum anyway - so Windows carries the published Linux number rather than an
 * invented one.
 *
 * ADDING A LINE: when llama.cpp starts shipping a CUDA 14 build, put its floor
 * here. Until it is here it is treated as unverifiable, not as safe - see
 * {@link pickCudaVersioned}.
 */
const CUDA_MIN_DRIVER: Readonly<Record<string, Readonly<{ win32: string; linux: string }>>> = {
  '12': { win32: '527.41', linux: '525.60.13' },
  '13': { win32: '580.65.06', linux: '580.65.06' },
};

/**
 * The driver floor a CUDA line needs on a platform, or `''` when this file does
 * not know one. macOS never reaches here (it has no CUDA build at all), so it
 * shares the Linux column rather than needing a third one.
 */
function cudaDriverFloor(cudaVersion: string, platform: LlamaPlatform): string {
  const row = CUDA_MIN_DRIVER[String(majorOf(cudaVersion))];
  if (row === undefined) return '';
  return platform === 'win32' ? row.win32 : row.linux;
}

const CPU_BACKENDS: ReadonlySet<HwfitBackend> = new Set(['cpu_x86', 'cpu_arm']);

/** Normalize `process.platform` to a platform with release builds. */
function toPlatform(raw: string): LlamaPlatform | null {
  if (raw === 'win32' || raw === 'darwin' || raw === 'linux') return raw;
  return null;
}

/** Normalize `process.arch` (and common aliases) to a released architecture. */
function toArch(raw: string): LlamaArch | null {
  if (raw === 'x64' || raw === 'x86_64' || raw === 'amd64') return 'x64';
  if (raw === 'arm64' || raw === 'aarch64') return 'arm64';
  return null;
}

/** Compare dotted numeric versions ("13.3" > "12.4"); non-numeric parts sort last. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] || '0', 10);
    const nb = Number.parseInt(pb[i] || '0', 10);
    const va = Number.isFinite(na) ? na : -1;
    const vb = Number.isFinite(nb) ? nb : -1;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** Escape a literal for embedding in a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every asset matching `<prefix><version><suffix>` and return the one with
 * the highest version, or the pinned version when `pin` is given.
 */
function pickVersioned(
  assets: readonly string[],
  prefix: string,
  suffix: string,
  pin?: string
): { name: string; version: string } | null {
  const re = new RegExp(`^${escapeRe(prefix)}(.+)${escapeRe(suffix)}$`);
  const hits: { name: string; version: string }[] = [];
  for (const name of assets) {
    const m = re.exec(name);
    if (m) hits.push({ name, version: m[1] });
  }
  if (hits.length === 0) return null;
  if (pin) return hits.find((h) => h.version === pin) || null;
  hits.sort((a, b) => compareVersions(b.version, a.version));
  return hits[0];
}

/** Leading integer of a dotted version, or null when there is not one. */
function majorOf(version: string): number | null {
  const n = Number.parseInt((version || '').split('.')[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** What {@link pickCudaVersioned} decided, and what the user must be told. */
type CudaPick = {
  hit: { name: string; version: string } | null;
  noteCodes: LlamaNoteCode[];
  /** True when CUDA builds exist but this driver can load none of them. */
  driverTooOld: boolean;
};

/**
 * Choose WHICH CUDA line to install, not merely the newest one that exists.
 *
 * llama.cpp publishes 12.x AND 13.x builds of the same release precisely
 * because a 13.x binary will not initialise on a pre-580 driver. That failure
 * is silent: the server reports "Available devices: (none)", exits 0, and runs
 * on CPU - after a ~500 MB download - so "newest wins" is not a safe default,
 * it is a coin flip weighted by whatever the user's driver happens to be.
 *
 * An explicit `pin` always wins (it is a deliberate override). Otherwise the
 * answer is the newest line whose measured driver floor this machine meets. A
 * line with no floor in {@link CUDA_MIN_DRIVER} is UNVERIFIABLE, never
 * "fine": it is used only when no line with a known floor is eligible, and
 * saying so is the note that comes back.
 *
 * The floor test is a FULL version comparison, not an integer one, and it is
 * per-OS: on Windows CUDA 12 needs 527.41, which no integer test can express.
 */
function pickCudaVersioned(
  assets: readonly string[],
  prefix: string,
  suffix: string,
  pin: string | undefined,
  driverVersion: string | null | undefined,
  platform: LlamaPlatform
): CudaPick {
  const all = allVersioned(assets, prefix, suffix);
  if (all.length === 0) return { hit: null, noteCodes: [], driverTooOld: false };
  const newest = all[0];
  if (pin) return { hit: all.find((h) => h.version === pin) || null, noteCodes: [], driverTooOld: false };

  // The driver is "measured" only when its leading component parses; `''` and
  // `'unknown'` are NOT MEASURED, which is a different answer from "too old".
  const driverMajor = majorOf(driverVersion || '');
  const unknownFloor = all.filter((h) => cudaDriverFloor(h.version, platform) === '');

  if (driverMajor === null) {
    // The driver was not measured. Offering the newest build is what shipped
    // before this check existed, so this path is not a regression - but it is
    // an unproven choice and the user is told so rather than left to discover
    // it as "the GPU did nothing".
    return { hit: newest, noteCodes: ['CUDA_LINE_UNVERIFIED'], driverTooOld: false };
  }

  const measured = String(driverVersion);
  const eligible = all.filter((h) => {
    const floor = cudaDriverFloor(h.version, platform);
    return floor !== '' && compareVersions(measured, floor) >= 0;
  });
  if (eligible.length > 0) {
    const chosen = eligible[0];
    // Only say "older, because of your driver" when that IS the reason. Skipping
    // a newest line whose floor is simply not known here costs the user nothing
    // (they still get a verified GPU build), and telling them to update a driver
    // that is already new enough would be advice for a problem they do not have.
    const newestFloorKnown = cudaDriverFloor(newest.version, platform) !== '';
    const skippedForDriver = chosen.version !== newest.version && newestFloorKnown === true;
    return { hit: chosen, noteCodes: skippedForDriver ? ['CUDA_LINE_OLDER_FOR_DRIVER'] : [], driverTooOld: false };
  }
  if (unknownFloor.length > 0) {
    return { hit: unknownFloor[0], noteCodes: ['CUDA_LINE_UNVERIFIED'], driverTooOld: false };
  }
  // Every line ships with a known floor and this driver clears none of them.
  return { hit: null, noteCodes: [], driverTooOld: true };
}

/** Every `<prefix><version><suffix>` match, newest version first. */
function allVersioned(assets: readonly string[], prefix: string, suffix: string): { name: string; version: string }[] {
  const re = new RegExp(`^${escapeRe(prefix)}(.+)${escapeRe(suffix)}$`);
  const hits: { name: string; version: string }[] = [];
  for (const name of assets) {
    const m = re.exec(name);
    if (m) hits.push({ name, version: m[1] });
  }
  hits.sort((a, b) => compareVersions(b.version, a.version));
  return hits;
}

/** Archive format each platform publishes. Measured: Windows zip, others tar.gz. */
function formatFor(platform: LlamaPlatform): LlamaArchiveFormat {
  return platform === 'win32' ? 'zip' : 'tar.gz';
}

/** Name of the plain CPU build for a platform/arch, whether or not it exists. */
function cpuAssetName(platform: LlamaPlatform, arch: LlamaArch, tag: string): string {
  if (platform === 'win32') return `llama-${tag}-bin-win-cpu-${arch}.zip`;
  if (platform === 'darwin') return `llama-${tag}-bin-macos-${arch}.tar.gz`;
  return `llama-${tag}-bin-ubuntu-${arch}.tar.gz`;
}

/** Human name for a backend, used in fallback reasons. */
function backendLabel(backend: HwfitBackend): string {
  if (backend === 'cuda') return 'CUDA';
  if (backend === 'rocm') return 'ROCm';
  if (backend === 'metal') return 'Metal';
  return 'CPU';
}

/** The GPU-accelerated asset for a backend on a platform, if the release has one. */
function findAcceleratedAsset(input: LlamaAssetPlanInput, platform: LlamaPlatform, arch: LlamaArch): CudaPick {
  const { tag, availableAssets, backend, cudaVariant, driverVersion } = input;
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  const osPart = platform === 'win32' ? 'win' : 'ubuntu';
  if (backend === 'cuda') {
    const prefix = `llama-${tag}-bin-${osPart}-cuda-`;
    return pickCudaVersioned(availableAssets, prefix, `-${arch}${ext}`, cudaVariant, driverVersion, platform);
  }
  if (backend === 'rocm') {
    const hit = pickVersioned(availableAssets, `llama-${tag}-bin-${osPart}-rocm-`, `-${arch}${ext}`);
    return { hit, noteCodes: [], driverTooOld: false };
  }
  return { hit: null, noteCodes: [], driverTooOld: false };
}

/** The Vulkan build for a platform/arch, whether or not the release has it. */
function vulkanAssetName(platform: LlamaPlatform, arch: LlamaArch, tag: string): string {
  if (platform === 'win32') return `llama-${tag}-bin-win-vulkan-${arch}.zip`;
  if (platform === 'linux') return `llama-${tag}-bin-ubuntu-vulkan-${arch}.tar.gz`;
  return '';
}

/**
 * Build the plain-CPU plan, optionally recording why an accelerated build was
 * skipped.
 *
 * Every CPU outcome checks for a published Vulkan build, because that is the
 * one case where the release HAS something better than what this machine is
 * about to get and {@link HwfitBackend} has no member that can ask for it. The
 * user is told rather than quietly handed the slow build.
 */
function cpuPlan(
  input: LlamaAssetPlanInput,
  platform: LlamaPlatform,
  arch: LlamaArch,
  fallback: LlamaBackendFallback | null,
  notes: string[],
  noteCodes: LlamaNoteCode[]
): LlamaAssetPlanResult {
  const name = cpuAssetName(platform, arch, input.tag);
  if (!input.availableAssets.includes(name)) {
    return {
      kind: 'unsupported',
      // A fact about THIS RELEASE, not about this machine: a release that is
      // still uploading lists a subset of its assets. The caller may retry
      // against an older, complete release.
      cause: 'asset-missing',
      reason: `llama.cpp release ${input.tag} ships no build for ${platform}/${arch} (expected asset "${name}")`,
    };
  }
  const vulkan = vulkanAssetName(platform, arch, input.tag);
  const allNotes = [...notes];
  const allCodes = [...noteCodes];
  if (vulkan !== '' && input.availableAssets.includes(vulkan)) {
    allNotes.push(
      `CPU build selected; release ${input.tag} also ships a Vulkan build ("${vulkan}") that hwfit cannot request.`
    );
    allCodes.push('VULKAN_BUILD_NOT_REQUESTABLE');
  }
  return {
    kind: 'ok',
    tag: input.tag,
    platform,
    arch,
    requestedBackend: input.backend,
    acceleration: 'cpu',
    assets: [{ role: 'server', name, format: formatFor(platform) }],
    serverBinaryName: serverBinaryName(platform),
    fallback,
    cudaVariant: null,
    notes: allNotes,
    noteCodes: allCodes,
  };
}

/** Basename of `llama-server` for a platform. */
export function serverBinaryName(platform: LlamaPlatform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * The CUDA runtime DLLs a given cudart line provides. Measured from the
 * archives: the 12.x line ships `*64_12.dll`, the 13.x line ships `*64_13.dll`.
 * Exported so the caller can probe the machine and set `cudaRuntimePresent`.
 */
export function cudaRuntimeDllNames(cudaVersion: string): string[] {
  const major = cudaVersion.split('.')[0] || '';
  return [`cudart64_${major}.dll`, `cublas64_${major}.dll`, `cublasLt64_${major}.dll`];
}

/**
 * Map a machine to the llama.cpp release assets that give it a runnable
 * `llama-server`, or an explicit "no build for this machine" answer.
 *
 * A weaker-than-requested result is never silent: `acceleration` reports what
 * you actually get and `fallback` carries the reason to show the user.
 */
export function planLlamaAssets(input: LlamaAssetPlanInput): LlamaAssetPlanResult {
  const platform = toPlatform(input.platform);
  if (!platform) {
    return {
      kind: 'unsupported',
      cause: 'platform',
      reason: `llama.cpp publishes no build for platform "${input.platform}"`,
    };
  }
  const arch = toArch(input.arch);
  if (!arch) {
    return {
      kind: 'unsupported',
      cause: 'arch',
      reason: `llama.cpp publishes no build for architecture "${input.arch}"`,
    };
  }

  const backend = input.backend;
  const notes: string[] = [];
  const noteCodes: LlamaNoteCode[] = [];

  // Plain CPU request: the CPU build is the answer, not a fallback.
  if (CPU_BACKENDS.has(backend)) {
    return cpuPlan(input, platform, arch, null, notes, noteCodes);
  }

  if (backend === 'metal') {
    if (platform !== 'darwin') {
      return cpuPlan(
        input,
        platform,
        arch,
        {
          from: backend,
          to: 'cpu',
          code: 'METAL_NOT_ON_THIS_PLATFORM',
          reason: 'Metal exists only on macOS; using the CPU build instead.',
        },
        notes,
        noteCodes
      );
    }
    if (arch !== 'arm64') {
      // Measured: llama-b10437-bin-macos-x64.tar.gz contains libggml-blas.dylib
      // and NO libggml-metal.dylib. Only the arm64 tarball has Metal.
      return cpuPlan(
        input,
        platform,
        arch,
        {
          from: backend,
          to: 'cpu',
          code: 'METAL_REQUIRES_APPLE_SILICON',
          reason: 'The macOS x64 build ships no Metal backend (Metal is Apple-silicon only); using CPU/BLAS.',
        },
        notes,
        noteCodes
      );
    }
    const name = cpuAssetName(platform, arch, input.tag);
    if (!input.availableAssets.includes(name)) {
      return {
        kind: 'unsupported',
        cause: 'asset-missing',
        reason: `llama.cpp release ${input.tag} is missing "${name}"`,
      };
    }
    return {
      kind: 'ok',
      tag: input.tag,
      platform,
      arch,
      requestedBackend: backend,
      acceleration: 'metal',
      assets: [{ role: 'server', name, format: 'tar.gz' }],
      serverBinaryName: serverBinaryName(platform),
      fallback: null,
      cudaVariant: null,
      notes,
      noteCodes,
    };
  }

  // cuda / rocm: only if the release actually ships that build for this target.
  if (platform === 'darwin') {
    return cpuPlan(
      input,
      platform,
      arch,
      {
        from: backend,
        to: 'cpu',
        code: 'NO_GPU_BUILD_FOR_TARGET',
        reason: `llama.cpp publishes no ${backendLabel(backend)} build for macOS; using the CPU build instead.`,
      },
      notes,
      noteCodes
    );
  }

  const pick = findAcceleratedAsset(input, platform, arch);
  noteCodes.push(...pick.noteCodes);
  const accelerated = pick.hit;
  if (!accelerated) {
    if (pick.driverTooOld === true) {
      // CUDA builds exist for this machine; the installed driver predates every
      // one of them. Downloading ~500 MB to have it fall back to CPU silently
      // is the failure this branch exists to turn into a sentence.
      return cpuPlan(
        input,
        platform,
        arch,
        {
          from: backend,
          to: 'cpu',
          code: 'CUDA_DRIVER_TOO_OLD',
          reason:
            `NVIDIA driver ${input.driverVersion} is older than every CUDA build in release ${input.tag} ` +
            `(on ${platform}: CUDA 13.x needs >=${cudaDriverFloor('13', platform)}, ` +
            `12.x needs >=${cudaDriverFloor('12', platform)}); using the CPU build instead.`,
        },
        notes,
        noteCodes
      );
    }
    const pinned = backend === 'cuda' && input.cudaVariant ? ` (CUDA ${input.cudaVariant} pinned)` : '';
    return cpuPlan(
      input,
      platform,
      arch,
      {
        from: backend,
        to: 'cpu',
        code: 'NO_GPU_BUILD_FOR_TARGET',
        reason:
          `llama.cpp release ${input.tag} ships no ${backendLabel(backend)} build for ` +
          `${platform}/${arch}${pinned}; using the CPU build instead.`,
      },
      notes,
      noteCodes
    );
  }

  const assets: LlamaAssetRef[] = [{ role: 'server', name: accelerated.name, format: formatFor(platform) }];

  if (backend === 'cuda' && platform === 'win32') {
    // The server archive has ggml-cuda.dll but not cuBLAS/cudart - measured.
    const cudartName = `cudart-llama-bin-win-cuda-${accelerated.version}-${arch}.zip`;
    const cudartAvailable = input.availableAssets.includes(cudartName);
    if (input.cudaRuntimePresent === true) {
      notes.push(
        `CUDA runtime already present on this machine; skipping ${cudartName} ` +
          `(${cudaRuntimeDllNames(accelerated.version).join(', ')}).`
      );
    } else if (cudartAvailable) {
      assets.push({ role: 'cuda-runtime', name: cudartName, format: 'zip' });
      notes.push(
        `The CUDA server build omits ${cudaRuntimeDllNames(accelerated.version).join(', ')}, ` +
          `so ${cudartName} is fetched alongside it.`
      );
    } else {
      // No runtime on the machine and none in the release: CUDA cannot load.
      return cpuPlan(
        input,
        platform,
        arch,
        {
          from: backend,
          to: 'cpu',
          code: 'CUDA_RUNTIME_UNAVAILABLE',
          reason:
            `The CUDA build needs ${cudaRuntimeDllNames(accelerated.version).join(', ')}, which are absent ` +
            `from this machine and from release ${input.tag} ("${cudartName}"); using the CPU build instead.`,
        },
        notes,
        noteCodes
      );
    }
  }

  return {
    kind: 'ok',
    tag: input.tag,
    platform,
    arch,
    requestedBackend: backend,
    acceleration: backend === 'cuda' ? 'cuda' : 'rocm',
    assets,
    serverBinaryName: serverBinaryName(platform),
    fallback: null,
    cudaVariant: backend === 'cuda' ? accelerated.version : null,
    notes,
    noteCodes,
  };
}
