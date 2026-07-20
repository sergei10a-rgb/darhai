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
};

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
 * Pick the viable backends for a host and the most capable one to default to.
 * Preference order: vllm > ollama > llama-server. Pure and total - a host with
 * no backend installed yields `{ chosen: 'none', viable: [] }`.
 */
export function selectBackend(input: BackendPolicyInput): CookbookBackendSelection {
  const viable: CookbookBackend[] = [];
  if (isVllmViable(input)) viable.push('vllm');
  if (input.available.ollama) viable.push('ollama');
  if (input.available.llamaServer) viable.push('llama-server');
  return { chosen: viable[0] ?? 'none', viable };
}
