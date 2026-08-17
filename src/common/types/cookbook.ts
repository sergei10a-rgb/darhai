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
 *   - `lm-studio`    -> the user's OWN LM Studio, already serving an
 *                       OpenAI-compatible `/v1` on loopback (port 1234 by
 *                       default, keyless). Darhai spawns nothing: the server is
 *                       a GUI app the user started, so serving through it is a
 *                       registration, not a launch.
 *   - `none`         -> no backend installed: the GGUF download still succeeds and
 *                       the UI offers a copy-command + locate-binary + "install
 *                       ollama or vllm" affordance so the user is never worse off.
 */

/**
 * Every local inference backend the serve path can drive, plus `'none'`.
 *
 * Declared as a runtime array with the union DERIVED from it, not as a bare
 * union - the same shape as `LLAMA_RUNTIME_FALLBACK_CODES`, for the same reason
 * and after the same near-miss. A union is invisible at runtime, so the one
 * duplication that tsc cannot see - the thirteen locale files each backend
 * needs a name in - could only be checked by a test that hard-codes its own
 * list, which drifts the moment someone adds a backend. Adding a member here
 * now fails `backendSurfaceCoverage.dom.test.tsx` in all 13 locales until the string
 * exists, and fails `Record<CookbookBackend, ...>` at the label map and the
 * serve dispatch until those are written too.
 *
 * Order is the ORDERING CONTRACT, not decoration: it is the order
 * {@link selectBackend} emits `viable` and `provisionable` in - most capable
 * first - so the UI's `[...viable, ...provisionable]` reads as one ranked list.
 * `'none'` is last because it is not a backend; it is the absence of one.
 */
export const COOKBOOK_BACKENDS = ['vllm', 'ollama', 'lm-studio', 'llama-server', 'none'] as const;

/**
 * A local inference backend the serve path can drive. Which ones are VIABLE is
 * decided per host by {@link selectBackend} from the hardware scan + installed
 * binaries; the most capable viable one is default-selected but user-overridable.
 */
export type CookbookBackend = (typeof COOKBOOK_BACKENDS)[number];

/**
 * The backends that can actually serve a model - {@link COOKBOOK_BACKENDS}
 * without `'none'`.
 *
 * Every one of these must be reachable: named in all 13 locales, accepted by
 * the IPC validator, emitted by `selectBackend` for SOME host, and dispatched
 * by `CookbookServeService.serve`. `'none'` is exempt from all four, which is
 * exactly why it is subtracted here rather than special-cased at each site.
 */
export const SERVEABLE_COOKBOOK_BACKENDS = COOKBOOK_BACKENDS.filter(
  (b): b is Exclude<CookbookBackend, 'none'> => b !== 'none'
);

/**
 * The hardware-adaptive backend choice for the current host: the default-selected
 * (most capable viable) backend plus every viable backend the user may override
 * to. `viable` never contains `'none'`; `chosen` is `'none'` only when nothing is
 * installed.
 *
 * `provisionable` is the answer to a question `viable` cannot express: "is it
 * INSTALLED" is the wrong test for llama.cpp, because Darhai ships the ability
 * to install it. A machine that already has Ollama used to see `viable:
 * ['ollama']` and had NO path to Darhai's own runtime at all - not in the
 * dropdown, and not through the zero-backend disclosure either, which only
 * fires when `chosen === 'none'`. Backends listed here are offered alongside
 * `viable`, and picking one runs the same pre-download disclosure a bare
 * machine gets, so nothing is fetched without the user saying yes. A backend is
 * never in both lists: once it is usable it is simply viable.
 *
 * LM Studio joins the SAME two lists rather than adding a third shape, because
 * it poses the same question with a different verb. Its server is a GUI app the
 * user starts, so "LM Studio is on this machine" and "LM Studio is answering
 * right now" are different facts, and a host with LM Studio installed but its
 * server off is not the same host as one without LM Studio at all. It is
 * `viable` when its `/v1` answers and `provisionable` when only its `lms` CLI
 * was found - the act Darhai offers is `lms server start` instead of a
 * download, but the contract is identical: not usable yet, Darhai can make it
 * usable, only after the user says yes.
 */
export type CookbookBackendSelection = {
  chosen: CookbookBackend;
  viable: CookbookBackend[];
  /**
   * Backends that are NOT usable yet but that Darhai can make usable on
   * request, with consent. The act is per backend: `llama-server` is a download
   * + install, `lm-studio` is starting the local server of an app that is
   * already on the machine.
   */
  provisionable: CookbookBackend[];
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
  /**
   * One-time measured `--n-cpu-moe` calibration for a MoE model that does not
   * fit in VRAM (~1-3 min, llama-bench sweep, cached per model+GPU). Its own
   * state rather than a flavour of `starting`, because the honest label is
   * different: nothing is being started yet, and the wait is much longer.
   */
  | 'calibrating'
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
