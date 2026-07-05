/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared (main + renderer) types for the hardware-fit model advisor.
 *
 * These mirror the process-side shapes in
 * `src/process/services/hwfit/types.ts` but live in `common` so the renderer
 * can import them without crossing the process boundary (the renderer must NOT
 * import from `@process/*`). Keep the two in sync.
 */

export type HwfitBackend = 'cuda' | 'rocm' | 'metal' | 'cpu_x86' | 'cpu_arm';

export type HwfitPlatform = 'windows' | 'linux' | 'macos' | 'unknown';

export type HwfitGpu = {
  index: number;
  name: string;
  vramGb: number;
};

/** Detected (or user-overridden) hardware profile. */
export type HwfitHardware = {
  totalRamGb: number;
  availableRamGb: number;
  cpuCores: number;
  cpuName: string;
  hasGpu: boolean;
  gpuName: string | null;
  gpuVramGb: number | null;
  gpuCount: number;
  gpus: HwfitGpu[];
  backend: HwfitBackend;
  platform: HwfitPlatform;
  gpuFamily?: string;
  unifiedMemory?: boolean;
  gpuError?: string | null;
  gpuOnly?: boolean;
};

export type HwfitUseCase = 'general' | 'coding' | 'reasoning' | 'chat' | 'multimodal' | 'embedding' | 'tts' | 'stt';

export type HwfitRunMode = 'gpu' | 'cpu_offload' | 'cpu_only' | 'no_fit';

export type HwfitFitLevel = 'perfect' | 'good' | 'marginal' | 'too_tight';

export type HwfitSubScores = {
  quality: number;
  speed: number;
  fit: number;
  context: number;
};

export type HwfitGgufSource = {
  repo: string;
  provider: string;
};

/** One ranked model result. */
export type HwfitResult = {
  name: string;
  provider: string;
  parameterCount: string;
  paramsB: number;
  isMoe: boolean;
  useCase: HwfitUseCase;
  fitLevel: HwfitFitLevel;
  runMode: HwfitRunMode;
  quant: string;
  context: number;
  requiredGb: number;
  speedTps: number;
  score: number;
  scores: HwfitSubScores;
  ggufSources: HwfitGgufSource[];
  contextLength: number;
  releaseDate?: string;
};

export type HwfitSortKey = 'score' | 'speed' | 'vram' | 'params' | 'context' | 'newest';

/** Options accepted by the rankModels IPC method. */
export type HwfitRankOptions = {
  useCase?: HwfitUseCase;
  limit?: number;
  search?: string;
  sort?: HwfitSortKey;
  quant?: string;
  targetContext?: number;
  fitOnly?: boolean;
  /**
   * Simulate a different rig without re-probing: when provided, the ranker
   * scores against this override instead of the detected hardware. The UI
   * builds it from the GPU picker (name + VRAM + count + gpuOnly).
   */
  hardwareOverride?: HwfitHardware;
};
