/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared (main + renderer) types for the "cookbook serve" surface - the
 * download + auto-serve extension of the hardware-fit model advisor.
 *
 * These live in `common` so the renderer can import them without crossing the
 * process boundary (the renderer must NOT import from `@process/*`). The
 * process-side service maps its internal state onto these shapes before it
 * crosses IPC.
 *
 * Darhai is a product installed on ANY hardware, so the serve backend is chosen
 * from the DETECTED hardware (OS + GPU vendor + VRAM) and which binaries are
 * installed - never assumed. See backendPolicy.ts for the selector. The viable
 * backends, and how a recommended model is served through each:
 *   - `vllm`         -> high-end path (Linux + CUDA + ample VRAM): `vllm serve
 *                       <hf-repo>`, which self-downloads the model from the hub
 *                       (no separate GGUF download).
 *   - `llama-server` -> universal path (any OS, any VRAM): download the GGUF +
 *                       spawn a loopback OpenAI-compatible server; GPU layers
 *                       scale to the detected VRAM (0 = pure CPU on big-RAM boxes).
 *   - `ollama`       -> easy cross-platform path when installed: `ollama pull`
 *                       + the existing keyless ollama-local provider.
 *   - `none`         -> no backend installed: the GGUF download still succeeds and
 *                       the UI offers a copy-command + locate-binary + "install
 *                       ollama or vllm" affordance so the user is never worse off.
 */

/**
 * A local inference backend the serve path can drive. Which ones are VIABLE is
 * decided per host by {@link selectBackend} from the hardware scan + installed
 * binaries; the most capable viable one is default-selected but user-overridable.
 */
export type CookbookBackend = 'ollama' | 'llama-server' | 'vllm' | 'none';

/**
 * The hardware-adaptive backend choice for the current host: the default-selected
 * (most capable viable) backend plus every viable backend the user may override
 * to. `viable` never contains `'none'`; `chosen` is `'none'` only when nothing is
 * installed.
 */
export type CookbookBackendSelection = {
  chosen: CookbookBackend;
  viable: CookbookBackend[];
};

/** Lifecycle state of a per-model download. */
export type CookbookDownloadStatus = 'idle' | 'downloading' | 'downloaded' | 'error';

/**
 * Lifecycle state of the active serve. One active serve at a time is an MVP
 * DEFAULT design choice (not a hardware limit).
 * // secondary: concurrent serves could be enabled on higher-VRAM machines later.
 */
export type CookbookServeState =
  | 'idle'
  | 'downloading'
  | 'starting'
  | 'ready'
  | 'error'
  /** GGUF downloaded but no backend installed - degraded copy-command path. */
  | 'needs_backend'
  | 'stopped';

/** One model's download state, as reported to the renderer. */
export type CookbookDownloadInfo = {
  /** The catalog model name (its stable id, e.g. "org/model"). */
  modelId: string;
  status: CookbookDownloadStatus;
  bytesDownloaded: number;
  totalBytes: number | null;
  /** Absolute path of the cached .gguf once downloaded. */
  filePath: string | null;
  error?: string;
};

/** Streaming download-progress event (main -> renderer). */
export type CookbookDownloadProgress = {
  modelId: string;
  bytesDownloaded: number;
  totalBytes: number | null;
};

/** Current serve status, as reported to the renderer. */
export type CookbookServeStatus = {
  state: CookbookServeState;
  /** The model currently being served / starting, or null when idle. */
  modelId: string | null;
  backend: CookbookBackend;
  /** Loopback port of the running server, or null. */
  port: number | null;
  /** The registered provider id ('cookbook-local' | 'ollama-local'), or null. */
  providerId: string | null;
  /** The served model id the agent should target, or null. */
  servedModel: string | null;
  error?: string;
  /**
   * When `state === 'needs_backend'`, the exact command the user can copy to
   * serve the downloaded GGUF by hand. Populated only on the degraded path.
   */
  serveCommand?: string;
};

/** Params for the download verb (renderer -> main). */
export type CookbookModelRequest = { modelId: string };

/**
 * Params for the serve verb. `backend` is an optional user override among the
 * host's viable backends; when absent (or not viable) the hardware-selected
 * default is used.
 */
export type CookbookServeRequest = { modelId: string; backend?: CookbookBackend };

/** Params for cancelling an in-flight download. */
export type CookbookCancelRequest = { modelId: string };

/** Params for pointing the serve path at a user-located llama-server binary. */
export type CookbookLocateBackendRequest = { path: string };

/** Result of a locate-backend attempt. */
export type CookbookLocateBackendResult = {
  ok: boolean;
  backend: CookbookBackend;
  error?: string;
};
