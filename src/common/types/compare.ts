/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared request/result types for the "Compare" feature (Odysseus #6).
 *
 * Compare runs the SAME prompt through several user-selected models and returns
 * their outputs side by side. These shapes cross the IPC boundary, so they carry
 * NO secrets: a model is referenced only by its registry `providerId` + `modelId`
 * (the same non-secret handle the model picker uses). The main process resolves
 * the decrypted key at dispatch time (`hydrateModelForSpawn`) and it never comes
 * back to the renderer.
 */

/**
 * A non-secret reference to one connected model. `providerId` is the registry
 * `ProviderId` (e.g. `'anthropic'`); `modelId` is the concrete model id the user
 * picked (e.g. `'claude-3-5-sonnet'`). `label` is an optional display string the
 * renderer already has - the service falls back to `providerId / modelId`.
 */
export type CompareModelRef = {
  providerId: string;
  modelId: string;
  label?: string;
};

/** A Compare request: one prompt fanned out across several models. */
export type CompareRequest = {
  prompt: string;
  modelRefs: CompareModelRef[];
  /**
   * Blind mode. Purely a hint for the renderer: when true the UI hides which
   * model produced which output until the user reveals it. The service always
   * returns full, attributed results so reveal is a client-side toggle.
   */
  blind: boolean;
};

/** The outcome of running the prompt through a single model. */
export type CompareRunResult = {
  modelRef: CompareModelRef;
  /** Display label (never a secret). Blind mode aliases this client-side. */
  label: string;
  /** True when the completion succeeded. */
  ok: boolean;
  /** The model's completion text (empty on failure). */
  text: string;
  /** A short error code / message when `ok` is false (e.g. `no-usable-model`). */
  error?: string;
  /** Wall-clock duration of this run in milliseconds. */
  ms: number;
};

/** The full Compare result: one run per selected model, plus a usability flag. */
export type CompareResult = {
  runs: CompareRunResult[];
  /**
   * True when NONE of the selected refs resolved to a callable model (no keyed
   * provider on the machine). Lets the renderer show a single "connect a model"
   * empty state instead of N identical per-card errors.
   */
  noUsableModel: boolean;
};

/**
 * A Fusion request (OmniRoute idea): fan the SAME prompt out across a panel of
 * models (exactly like Compare), then have a judge model synthesize the single
 * best answer from the panel. Carries no secrets - same non-secret refs as
 * Compare; the judge is auto-selected as the best available local model.
 */
export type FusionRequest = {
  prompt: string;
  modelRefs: CompareModelRef[];
};

/**
 * The Fusion result: the raw panel runs (so the UI can still show each model's
 * answer), plus the judge's synthesized answer and which model judged.
 */
export type FusionResult = {
  /** Each panel model's answer (same shape Compare returns). */
  runs: CompareRunResult[];
  /** The judge's synthesized best answer (empty when the judge could not run). */
  synthesis: string;
  /** Display label of the model that synthesized, or `''`. */
  judgeLabel: string;
  /** True when not a single panel ref resolved to a callable model. */
  noUsableModel: boolean;
  /** A short error code / message when the judge step failed (panel still returned). */
  judgeError?: string;
};
