/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardware-fit model advisor ("Загвар зөвлөмж" / Cookbook) types.
 *
 * These are the native Darhai shapes for the local-model catalog and the
 * fit-scoring pipeline. The catalog data itself is a reference-only port of
 * Odysseus' hf_models.json (converted to camelCase, see data/modelCatalog.json);
 * the algorithms are re-implemented in TypeScript, not wrapped.
 */

/** A GGUF alternate-download source for a model (llama.cpp/Ollama serving path). */
export type GgufSource = {
  repo: string;
  provider: string;
};

/**
 * One entry in the local-model catalog. Mirrors the fields the fit-scoring
 * pipeline reads. Optional fields are absent (not null) when the source row
 * lacked them, so consumers must default.
 */
export type CatalogModel = {
  /** Hugging Face repo id, e.g. "deepseek-ai/DeepSeek-V4-Flash". */
  name: string;
  /** Owning org/user (the repo namespace). */
  provider: string;
  /** Human display count, e.g. "7B", "284B", "80K". Empty when unknown. */
  parameterCount: string;
  /** Exact parameter count when known (preferred over parsing parameterCount). */
  parametersRaw?: number;
  minRamGb?: number;
  recommendedRamGb?: number;
  minVramGb?: number;
  /** Native/default quantization label, e.g. "Q4_K_M", "FP8", "AWQ-4bit". */
  quantization?: string;
  contextLength?: number;
  /** Free-text upstream use-case blurb (not the scoring use-case enum). */
  useCase?: string;
  capabilities?: string[];
  pipelineTag?: string;
  architecture?: string;
  downloads?: number;
  likes?: number;
  /** ISO-ish date string ("2026-05-15"). Empty/absent sorts last. */
  releaseDate?: string;
  /** Prequantized serving format tag ("awq" | "gptq"), when applicable. */
  format?: string;
  // --- Mixture-of-Experts ---
  isMoe?: boolean;
  numExperts?: number;
  activeExperts?: number;
  /** Active params per token (drives KV-cache + speed, not total VRAM). */
  activeParameters?: number;
  // --- GGUF availability (llama.cpp/Ollama servable) ---
  ggufSources?: GgufSource[];
  isGguf?: boolean;
  /**
   * Marks a model added outside the bundled catalog. Reserved for a future
   * "add Mongolian / discovered model" flow: a user-supplied entry should be
   * tagged `source: 'custom'` (or `'discovered'` for auto-scraped ones) so the
   * UI can badge it and the ranker can treat it identically to bundled models.
   * Bundled catalog entries omit this field entirely.
   */
  source?: 'custom' | 'discovered';
};

/** GPU/accelerator backend detected on the host. */
export type HardwareBackend = 'cuda' | 'rocm' | 'metal' | 'cpu_x86' | 'cpu_arm';

/** OS platform, when known (drives serving-path filters). */
export type HardwarePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

/** A single detected GPU. */
export type DetectedGpu = {
  index: number;
  name: string;
  vramGb: number;
};

/**
 * The detected (or user-overridden) hardware profile the ranker scores against.
 * Produced by hardwareDetect.scanHardware(); a GPU-less host still returns a
 * well-formed profile with hasGpu=false so the ranker can recommend CPU/RAM
 * models rather than failing.
 */
export type HardwareProfile = {
  totalRamGb: number;
  availableRamGb: number;
  cpuCores: number;
  cpuName: string;
  hasGpu: boolean;
  gpuName: string | null;
  gpuVramGb: number | null;
  gpuCount: number;
  gpus: DetectedGpu[];
  backend: HardwareBackend;
  platform: HardwarePlatform;
  /** AMD ISA family ("rdna" | "cdna" | "gcn" | "unknown"), when detected. */
  gpuFamily?: string;
  /** Apple Silicon / AMD APU: the "VRAM" above is carved from system RAM. */
  unifiedMemory?: boolean;
  /**
   * Set when a GPU probe existed but failed (e.g. nvidia-smi present but the
   * driver mismatched). Lets the UI say "GPU driver error" instead of the
   * misleading "no GPU".
   */
  gpuError?: string | null;
  /**
   * When true, the ranker scores models that must fit ON the GPU(s) only,
   * zeroing the CPU-offload budget. Set by the UI when the user picks an
   * explicit GPU config (simulated rig) rather than "use my RAM too".
   */
  gpuOnly?: boolean;
};

/** The scoring use-case the user picks (drives weights + targets + filters). */
export type UseCase = 'general' | 'coding' | 'reasoning' | 'chat' | 'multimodal' | 'embedding' | 'tts' | 'stt';

/** Where a model can actually run given the budget. */
export type RunMode = 'gpu' | 'cpu_offload' | 'cpu_only' | 'no_fit';

/** How comfortably a model fits (drives the row color badge). */
export type FitLevel = 'perfect' | 'good' | 'marginal' | 'too_tight';

/** The four sub-scores that compose the final ranking score. */
export type FitSubScores = {
  quality: number;
  speed: number;
  fit: number;
  context: number;
};

/** One ranked model result returned to the renderer. */
export type FitResult = {
  name: string;
  provider: string;
  parameterCount: string;
  paramsB: number;
  isMoe: boolean;
  useCase: UseCase;
  fitLevel: FitLevel;
  runMode: RunMode;
  quant: string;
  context: number;
  requiredGb: number;
  speedTps: number;
  score: number;
  scores: FitSubScores;
  ggufSources: GgufSource[];
  contextLength: number;
  releaseDate?: string;
};

/** Column the ranked list is sorted by. */
export type SortKey = 'score' | 'speed' | 'vram' | 'params' | 'context' | 'newest';

/** Options for a ranking pass. */
export type RankOptions = {
  useCase?: UseCase;
  limit?: number;
  search?: string;
  sort?: SortKey;
  quant?: string;
  targetContext?: number;
  /** Drop rows that do not fit ("too_tight") from the result. */
  fitOnly?: boolean;
};
