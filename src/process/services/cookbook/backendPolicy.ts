/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardware-adaptive backend selector for the cookbook-serve path.
 *
 * Darhai is a product installed by ANY user on ANY hardware - that is exactly
 * why the advisor SCANS the rig. The serve backend must follow the detected
 * hardware (OS + GPU vendor + VRAM) and which binaries are installed, never a
 * fixed assumption about the developer's own machine.
 *
 * The rules, most-capable first:
 *   - `vllm`         viable when the OS is Linux AND the GPU is NVIDIA/CUDA AND
 *                    VRAM >= {@link VLLM_MIN_VRAM_GB} AND a `vllm` binary is
 *                    available. This is the high-end path - offered, not gated
 *                    out, whenever the hardware supports it.
 *   - `llama-server` the universal path: any OS, any VRAM (GPU layers scale via
 *                    ngpuLayersForVram; 0 layers = pure CPU on big-RAM boxes).
 *   - `ollama`       the easy cross-platform path when installed.
 *
 * `chosen` is the most capable viable backend (default-selected, user-overridable
 * in the UI); `viable` lists every backend the host supports so the UI can offer
 * an override. Nothing is cut based on any single reference machine.
 *
 * One of those three is not like the others: llama.cpp is INSIDE Darhai. "Is it
 * installed" is therefore the wrong question to build the user's choice list
 * from - it is the question of whether it is installed YET. A host with Ollama
 * on it produced `viable: ['ollama']`, so the dropdown never offered llama.cpp
 * and `chosen` was not `'none'`, which is the only value that opens the
 * provisioning path; the machine had no route to Darhai's own runtime at all.
 * {@link selectBackend} answers both questions separately: `viable` stays
 * exactly "what is installed", and `provisionable` carries what Darhai can
 * install on request. Consent is unchanged - selecting a provisionable backend
 * runs the same pre-download disclosure, and nothing is fetched before yes.
 */

import type { HardwareBackend, HardwarePlatform } from '@process/services/hwfit';
import type { CookbookBackend, CookbookBackendSelection } from '@/common/types/cookbook';

/**
 * Minimum GPU VRAM (GB) at which vLLM is offered. vLLM targets throughput on
 * capable CUDA GPUs; below this the universal llama.cpp path is the better fit.
 */
export const VLLM_MIN_VRAM_GB = 16;

/** Which backend binaries the host actually has installed (probed separately). */
export type BackendAvailability = {
  ollama: boolean;
  llamaServer: boolean;
  vllm: boolean;
};

/** The hardware + availability signals the selector reads. */
export type BackendPolicyInput = {
  /** Detected OS platform. */
  platform: HardwarePlatform;
  /** Detected GPU/accelerator backend. */
  hwBackend: HardwareBackend;
  /** Detected GPU VRAM in GB (0 when there is no usable GPU). */
  vramGb: number;
  available: BackendAvailability;
  /**
   * True when Darhai could install its OWN llama.cpp for this host. Required,
   * not optional: an omitted flag would silently rebuild the choice list from
   * "what is installed" alone, which is the defect this field exists to close.
   * Callers get it from {@link isLlamaServerProvisionable}.
   */
  canProvisionLlamaServer: boolean;
};

/** Platforms llama.cpp publishes `llama-server` builds for. */
const PROVISIONABLE_PLATFORMS = new Set<HardwarePlatform>(['windows', 'macos', 'linux']);
/** Architectures llama.cpp publishes `llama-server` builds for (`process.arch`). */
const PROVISIONABLE_ARCHES = new Set<string>(['x64', 'arm64']);

/**
 * Whether Darhai can fetch a llama.cpp release for this platform + architecture.
 *
 * The same coarse gate `planLlamaAssets` applies before it touches the network
 * (assetMap.ts `toPlatform`/`toArch`): anything outside win32/darwin/linux and
 * x64/arm64 has no published build. Deliberately NOT the full answer - whether a
 * given release ships the specific asset is a network question, and the plan
 * call that follows answers it honestly ("no build for this machine"). This only
 * keeps an option out of the dropdown when the answer is already knowable here.
 */
export function isLlamaServerProvisionable(platform: HardwarePlatform, arch: string): boolean {
  return PROVISIONABLE_PLATFORMS.has(platform) && PROVISIONABLE_ARCHES.has(arch);
}

/**
 * True when vLLM is a viable backend for this host: a Linux box with an
 * NVIDIA/CUDA GPU carrying at least {@link VLLM_MIN_VRAM_GB} of VRAM, with the
 * `vllm` binary installed.
 */
export function isVllmViable(input: BackendPolicyInput): boolean {
  return (
    input.available.vllm &&
    input.platform === 'linux' &&
    input.hwBackend === 'cuda' &&
    Number.isFinite(input.vramGb) &&
    input.vramGb >= VLLM_MIN_VRAM_GB
  );
}

/**
 * Pick the viable backends for a host, the most capable one to default to, and
 * what Darhai could install if the user asks for it.
 *
 * Preference order: vllm > ollama > llama-server. Pure and total - a host with
 * no backend installed still yields `{ chosen: 'none', viable: [] }`, because
 * `chosen` and `viable` are strictly about what is installed NOW. That machine
 * is unchanged by design: it already reaches the runtime through the
 * `chosen === 'none'` disclosure, and putting a name in its dropdown would only
 * teach it a word ("llama.cpp") the one-press flow exists to spare it.
 * `provisionable` is what changes for everyone else: it lists llama.cpp
 * whenever this host could install it and has not, so a machine that already
 * has Ollama can still choose Darhai's own runtime.
 */
export function selectBackend(input: BackendPolicyInput): CookbookBackendSelection {
  const viable: CookbookBackend[] = [];
  if (isVllmViable(input)) viable.push('vllm');
  if (input.available.ollama) viable.push('ollama');
  if (input.available.llamaServer) viable.push('llama-server');
  const provisionable: CookbookBackend[] =
    input.available.llamaServer === false && input.canProvisionLlamaServer === true ? ['llama-server'] : [];
  return { chosen: viable[0] ?? 'none', viable, provisionable };
}
