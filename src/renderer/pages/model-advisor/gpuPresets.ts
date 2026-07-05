/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HwfitHardware } from '@/common/types/hwfit';

/**
 * A short list of common GPUs the user can simulate. The `name` must contain a
 * substring the main-process bandwidth table (speedModel.ts GPU_BANDWIDTH) can
 * match, so simulated speed estimates are accurate.
 */
export type GpuPreset = {
  id: string;
  label: string;
  name: string;
  vramGb: number;
  backend: HwfitHardware['backend'];
};

export const GPU_PRESETS: readonly GpuPreset[] = [
  { id: 'rtx-5090', label: 'RTX 5090 (32 GB)', name: 'NVIDIA GeForce RTX 5090', vramGb: 32, backend: 'cuda' },
  { id: 'rtx-4090', label: 'RTX 4090 (24 GB)', name: 'NVIDIA GeForce RTX 4090', vramGb: 24, backend: 'cuda' },
  { id: 'rtx-4070', label: 'RTX 4070 (12 GB)', name: 'NVIDIA GeForce RTX 4070', vramGb: 12, backend: 'cuda' },
  { id: 'rtx-4060', label: 'RTX 4060 (8 GB)', name: 'NVIDIA GeForce RTX 4060', vramGb: 8, backend: 'cuda' },
  { id: 'rtx-3090', label: 'RTX 3090 (24 GB)', name: 'NVIDIA GeForce RTX 3090', vramGb: 24, backend: 'cuda' },
  { id: 'a100-80', label: 'A100 (80 GB)', name: 'NVIDIA A100', vramGb: 80, backend: 'cuda' },
  { id: 'h100-80', label: 'H100 (80 GB)', name: 'NVIDIA H100', vramGb: 80, backend: 'cuda' },
  { id: 'rx-7900xtx', label: 'RX 7900 XTX (24 GB)', name: 'AMD Radeon RX 7900 XTX', vramGb: 24, backend: 'rocm' },
  { id: 'm4-max', label: 'Apple M4 Max (48 GB)', name: 'Apple M4 Max', vramGb: 48, backend: 'metal' },
  { id: 'm4', label: 'Apple M4 (16 GB)', name: 'Apple M4', vramGb: 16, backend: 'metal' },
];

/**
 * Build a full hardware override from a preset + the real system's RAM/CPU, so
 * a simulated GPU still scores against the user's actual system memory. `gpuOnly`
 * restricts scoring to what fits on the GPU (no CPU offload).
 */
export function buildOverride(preset: GpuPreset, base: HwfitHardware, gpuOnly: boolean): HwfitHardware {
  const isAmdConsumer = preset.backend === 'rocm';
  return {
    ...base,
    hasGpu: true,
    gpuName: preset.name,
    gpuVramGb: preset.vramGb,
    gpuCount: 1,
    gpus: [{ index: 0, name: preset.name, vramGb: preset.vramGb }],
    backend: preset.backend,
    gpuFamily: isAmdConsumer ? 'rdna' : undefined,
    unifiedMemory: preset.backend === 'metal',
    gpuError: null,
    gpuOnly,
  };
}
