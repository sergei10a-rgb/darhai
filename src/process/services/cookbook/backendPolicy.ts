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
 *   - `lm-studio`    the user's own LM Studio, when its loopback server is up.
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
 * exactly "what can serve now", and `provisionable` carries what Darhai can
 * make serve on request. Consent is unchanged - selecting a provisionable
 * backend runs the same pre-download disclosure, and nothing is fetched before
 * yes.
 *
 * LM Studio poses that same two-question split with a different verb, so it
 * reuses the same two lists rather than adding a third. Its server is a GUI app
 * the user starts, which makes "LM Studio is on this machine" and "LM Studio is
 * answering right now" separate facts - hence two flags in
 * {@link BackendAvailability}, not one. Serving makes it `viable`; installed
 * without serving makes it `provisionable`, where the act Darhai offers is
 * `lms server start` rather than a download.
 */

import type { HardwareBackend, HardwarePlatform } from '@process/services/hwfit';
import { SERVEABLE_COOKBOOK_BACKENDS } from '@/common/types/cookbook';
import type { CookbookBackend, CookbookBackendSelection } from '@/common/types/cookbook';

/**
 * Minimum GPU VRAM (GB) at which vLLM is offered. vLLM targets throughput on
 * capable CUDA GPUs; below this the universal llama.cpp path is the better fit.
 */
export const VLLM_MIN_VRAM_GB = 16;

/**
 * What each backend can do on this host right now (probed separately).
 *
 * Three of these are one boolean because Darhai spawns them itself, so "the
 * binary is there" is the whole answer. LM Studio needs TWO, because Darhai
 * does not spawn it: its server is started by a person in a GUI app, so a host
 * can have LM Studio and still have nothing listening. Collapsing that into one
 * flag would force a choice between never offering an installed-but-idle LM
 * Studio and claiming a dead endpoint is usable. Both flags are reported so the
 * UI can say which of the two a host is.
 */
export type BackendAvailability = {
  ollama: boolean;
  llamaServer: boolean;
  vllm: boolean;
  /** LM Studio's loopback server is answering its own API right now. */
  lmStudioServing: boolean;
  /** LM Studio's `lms` CLI was found, so Darhai could start that server. */
  lmStudioInstalled: boolean;
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
 * True when LM Studio can serve RIGHT NOW: its loopback server is answering.
 *
 * Deliberately independent of whether the `lms` CLI was found. A machine whose
 * LM Studio lives somewhere {@link lmStudioCliCandidates} does not search - a
 * portable copy, a relocated install - is still completely usable when its
 * server is up, and reporting it as not-viable would be false about the one
 * thing that matters. The CLI only buys the ability to START a stopped server.
 */
export function isLmStudioViable(input: BackendPolicyInput): boolean {
  return input.available.lmStudioServing === true;
}

/**
 * True when Darhai could get LM Studio serving: it is installed, and it is not
 * answering yet.
 *
 * Both halves are required. Without `lmStudioInstalled` there is no `lms` to
 * run, so offering "start it" would be a button that cannot work; without
 * `lmStudioServing === false` the backend is already viable, and a backend must
 * never appear in both lists.
 */
export function isLmStudioProvisionable(input: BackendPolicyInput): boolean {
  return input.available.lmStudioInstalled === true && input.available.lmStudioServing === false;
}

/**
 * Pick the viable backends for a host, the most capable one to default to, and
 * what Darhai could make usable if the user asks for it.
 *
 * Preference order: **vllm > ollama > lm-studio > llama-server**. The order
 * decides only the DEFAULT; every viable backend is offered, so ranking one
 * lower never takes it away from a user who knows they want it.
 *
 * Why LM Studio sits below ollama and above llama-server - argued, not assumed:
 *
 *   - **Below ollama**, for one concrete reason. This selector serves a model
 *     the user picked from Darhai's catalog, and ollama can GO GET that model
 *     (`ollama pull hf.co/<repo>:<quant>`). LM Studio serves what it already
 *     holds, so defaulting to it would mean defaulting to a backend that may
 *     not have the chosen model at all. A second reason points the same way:
 *     ollama runs as a background service, while LM Studio's server lives
 *     inside a GUI app - measured on the reference machine, `lms server status`
 *     reported the server up only because the app was open. A default should be
 *     the choice most likely to still answer in an hour.
 *   - **Above llama-server**, because a server that is already answering beats
 *     one Darhai has to download a GGUF for and spawn. LM Studio being up means
 *     the user has already made the decisions llama.cpp would ask them for.
 *
 * Pure and total - a host with nothing usable still yields
 * `{ chosen: 'none', viable: [] }`, because `chosen` and `viable` are strictly
 * about what can serve NOW. That machine is unchanged by design: it already
 * reaches the runtime through the `chosen === 'none'` disclosure, and putting a
 * name in its dropdown would only teach it a word ("llama.cpp") the one-press
 * flow exists to spare it. `provisionable` is what changes for everyone else:
 * it lists llama.cpp whenever this host could install it and has not, and
 * LM Studio whenever it is installed but idle - so a machine that already has
 * Ollama can still choose either.
 */
/**
 * Per-backend answers to the two questions, as exhaustive maps rather than an
 * `if` chain.
 *
 * WHY A MAP. An `if` chain compiles fine when a backend is added to the union
 * and forgotten here — the new member simply never appears in any host's
 * `viable`, so it is in the dropdown for nobody and no error is raised
 * anywhere. A `Record` over the union cannot be missing a member: `tsc` refuses
 * the file. That moves this site from "a test catches it" to "it does not
 * compile", which is the same standard `BACKEND_LABEL_KEY` and `VALID_BACKENDS`
 * already meet.
 *
 * Iteration order comes from {@link SERVEABLE_COOKBOOK_BACKENDS}, which is the
 * ranking — vllm > ollama > lm-studio > llama-server — so the ranking lives in
 * exactly one place instead of being re-stated by the order of the branches.
 */
const VIABLE_WHEN: Record<Exclude<CookbookBackend, 'none'>, (input: BackendPolicyInput) => boolean> = {
  vllm: isVllmViable,
  ollama: (input) => input.available.ollama === true,
  'lm-studio': isLmStudioViable,
  'llama-server': (input) => input.available.llamaServer === true,
};

/**
 * When Darhai could make a backend serve that is not serving now. The act
 * differs per backend — a download for llama.cpp, a request to the user for LM
 * Studio — but the question is the same, so it gets the same exhaustive shape.
 * A backend Darhai cannot provision answers `false` explicitly rather than
 * being absent, because "absent" is what this map exists to make impossible.
 */
const PROVISIONABLE_WHEN: Record<Exclude<CookbookBackend, 'none'>, (input: BackendPolicyInput) => boolean> = {
  vllm: () => false,
  ollama: () => false,
  'lm-studio': isLmStudioProvisionable,
  'llama-server': (input) => input.available.llamaServer === false && input.canProvisionLlamaServer === true,
};

export function selectBackend(input: BackendPolicyInput): CookbookBackendSelection {
  const viable: CookbookBackend[] = [];
  const provisionable: CookbookBackend[] = [];
  // One pass in ranking order, so `viable` and `provisionable` are both ranked
  // and the chooser reads as one list once the UI concatenates them.
  for (const backend of SERVEABLE_COOKBOOK_BACKENDS) {
    if (VIABLE_WHEN[backend](input) === true) {
      viable.push(backend);
    } else if (PROVISIONABLE_WHEN[backend](input) === true) {
      provisionable.push(backend);
    }
  }
  return { chosen: viable[0] ?? 'none', viable, provisionable };
}
