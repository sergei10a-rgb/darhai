/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared (main + renderer) types for Darhai's OWN llama.cpp runtime.
 *
 * The point of this surface is that a person installs Darhai and nothing else.
 * Until now the serve path could only find a `llama-server` the user had put on
 * PATH by hand, so the Model Advisor's action button fell through to printing a
 * shell command. The provisioner in `@process/services/llamacpp` downloads a
 * verified llama.cpp release into `userData/llamacpp/versions/<tag>/`; these
 * types are how the renderer sees that happen.
 *
 * They live in `common` because the renderer must NOT import from `@process/*`.
 * The process-side shapes they mirror are `LlamaProvisionProgress`,
 * `LlamaAssetPlanResult` and `LlamaFallbackCode`; the bridge maps onto these
 * before anything crosses IPC.
 *
 * Every field here exists because the UI is required to be honest about it:
 * `acceleration` + `fallbackCode` so the user is told BEFORE the download that
 * a CPU build is what their machine gets, `downloadBytes` so no percentage is
 * shown that was not measured, and `errorCode` so "no build for this machine"
 * reads as that rather than as a spinner.
 */

/**
 * Lifecycle of the managed runtime.
 *
 * `unknown` is the pre-probe value the renderer holds for the first frame only;
 * everything else is a fact the main process established. There is deliberately
 * no `unsupported` state - a machine with no build reaches `failed` carrying
 * `errorCode: 'LLAMACPP_UNSUPPORTED'`, so a UI that renders the error path at
 * all cannot accidentally leave that case spinning.
 */
export type LlamaRuntimeState = 'unknown' | 'missing' | 'downloading' | 'ready' | 'failed';

/** Coarse stage inside a download, mirroring the provisioner's phases. */
export type LlamaRuntimePhase = 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'done';

/** What the installed (or planned) build actually accelerates with. */
export type LlamaRuntimeAcceleration = 'cuda' | 'rocm' | 'metal' | 'vulkan' | 'cpu';

/**
 * Why the build on offer is weaker than the hardware scan asked for. A stable
 * identifier, NOT prose: the renderer ships 13 locales and keys its message off
 * this code.
 *
 * Declared as a runtime array rather than a bare union so the locale-coverage
 * test can ITERATE it. A union is invisible at runtime, so adding a member used
 * to ship `modelAdvisor.runtime.fallback.NEW_CODE` as literal screen text in all
 * 13 locales with tsc, check-i18n and every test green.
 */
export const LLAMA_RUNTIME_FALLBACK_CODES = [
  'METAL_NOT_ON_THIS_PLATFORM',
  'METAL_REQUIRES_APPLE_SILICON',
  'NO_GPU_BUILD_FOR_TARGET',
  'CUDA_RUNTIME_UNAVAILABLE',
  'CUDA_DRIVER_TOO_OLD',
] as const;

export type LlamaRuntimeFallbackCode = (typeof LLAMA_RUNTIME_FALLBACK_CODES)[number];

/**
 * A non-fatal remark about the build on offer: the plan is what the machine
 * gets, but something about HOW it was chosen is worth saying out loud.
 *
 * Same runtime-array rule as {@link LLAMA_RUNTIME_FALLBACK_CODES}, and for the
 * same reason. Notes are separate from a fallback because none of them mean the
 * acceleration is weaker than requested - they mean the choice rests on
 * something the user should know about.
 *
 *   - `CUDA_LINE_OLDER_FOR_DRIVER` an older CUDA build was picked because the
 *     measured driver cannot load the newest one.
 *   - `CUDA_LINE_UNVERIFIED` the driver version could not be measured (or the
 *     line's driver floor is not known here), so the newest build is offered
 *     without proof that it will initialise.
 *   - `VULKAN_BUILD_NOT_REQUESTABLE` this machine is getting the CPU build
 *     while the release also ships a Vulkan build that the hardware scan has no
 *     way to ask for.
 */
export const LLAMA_RUNTIME_NOTE_CODES = [
  'CUDA_LINE_OLDER_FOR_DRIVER',
  'CUDA_LINE_UNVERIFIED',
  'VULKAN_BUILD_NOT_REQUESTABLE',
] as const;

export type LlamaRuntimeNoteCode = (typeof LLAMA_RUNTIME_NOTE_CODES)[number];

/**
 * The code `install()` answers when the outstanding disclosure aged past its
 * TTL between the card and the Confirm press. NOTHING is installed on this
 * path: the only thing an expired install could fetch is a resolution the user
 * has never seen, which is exactly the substitution the disclosure exists to
 * forbid. The renderer catches this code, calls `plan()` again - which
 * resolves afresh and shows today's card - and only a new Confirm installs.
 *
 * Lives in `common` because both sides need the same literal: the bridge
 * returns it and the advisor row branches on it.
 */
export const LLAMACPP_DISCLOSURE_EXPIRED = 'LLAMACPP_DISCLOSURE_EXPIRED';

/** Live progress of an install. Byte totals are null when genuinely unknown. */
export type LlamaRuntimeProgress = {
  phase: LlamaRuntimePhase;
  /** Archive currently being worked on, or null outside per-asset phases. */
  assetName: string | null;
  /** 1-based position of `assetName` within the plan. */
  assetIndex: number;
  assetCount: number;
  bytesDone: number;
  /** Size of the current archive, or null when the release did not state one. */
  bytesTotal: number | null;
  totalBytesDone: number;
  /** Sum of every planned archive, or null when any size is unknown. */
  totalBytesTotal: number | null;
};

/** Snapshot of the managed runtime, as the renderer sees it. */
export type LlamaRuntimeStatus = {
  state: LlamaRuntimeState;
  /** Installed release tag (e.g. `b10437`), or null when none is installed. */
  tag: string | null;
  /** Absolute path of the managed `llama-server`, or null. */
  serverPath: string | null;
  /** Acceleration of the installed build, or null before one exists. */
  acceleration: LlamaRuntimeAcceleration | null;
  /** Set when the installed build is weaker than the detected hardware. */
  fallbackCode: LlamaRuntimeFallbackCode | null;
  /** Non-null only while `state === 'downloading'`. */
  progress: LlamaRuntimeProgress | null;
  /** `LLAMACPP_*` / `ARCHIVE_*` identifier when `state === 'failed'`. */
  errorCode: string | null;
  /** English diagnostic behind `errorCode` - for logs, never the primary UI copy. */
  errorMessage: string | null;
};

/**
 * What an install WOULD fetch, answered before a byte is downloaded.
 *
 * Three outcomes, discriminated by a string so `kind === 'ok'` narrows without
 * strictNullChecks:
 *   - `ok`          the release resolved and these are the real numbers.
 *   - `unsupported` llama.cpp publishes no build for this platform/arch.
 *   - `unavailable` the release index could not be read (offline, API error);
 *                   the machine may well be supported, we just cannot say.
 */
export type LlamaRuntimePlan =
  | {
      kind: 'ok';
      tag: string;
      acceleration: LlamaRuntimeAcceleration;
      /** Non-null when `acceleration` is weaker than the detected hardware. */
      fallbackCode: LlamaRuntimeFallbackCode | null;
      /**
       * Remarks about how this build was chosen. Empty is the normal case; a
       * non-empty list must reach the screen, because every member of it names
       * a way the install can end up slower than the user expects.
       */
      noteCodes: LlamaRuntimeNoteCode[];
      /** Number of archives in the plan (1, or 2 when cudart is fetched too). */
      assetCount: number;
      /** Measured sum of the planned archives' sizes; null if any is unstated. */
      downloadBytes: number | null;
      /** True when this tag is already installed - pressing install is a no-op. */
      alreadyInstalled: boolean;
    }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'unavailable'; errorCode: string };
