/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detection for LM Studio - the second of the two local runtimes a knowledgeable
 * user expects to be able to pick by name.
 *
 * LM Studio is not like ollama, vllm or llama-server, and the difference is the
 * whole reason this module exists rather than one more line in
 * `detectAvailability`. Those three are answered by ONE question - "is the
 * binary there" - because Darhai spawns them itself. LM Studio's server is
 * started by a person inside a GUI app, so it splits into two facts that a
 * single boolean cannot carry:
 *
 *   INSTALLED  the `lms` CLI is on this machine, so Darhai can ask it to start
 *              the server (`lms server start`).
 *   SERVING    something is answering LM Studio's own REST API on loopback
 *              right now, so a model can be reached without touching anything.
 *
 * A host with LM Studio installed and its server off is not the same host as
 * one with no LM Studio at all, and the UI has to be able to tell them apart -
 * the first can be offered "start it", the second can only be told to install
 * it. {@link detectLmStudio} reports both; `backendPolicy.selectBackend` maps
 * SERVING onto `viable` and INSTALLED-but-not-SERVING onto `provisionable`,
 * reusing the split 15aed2b53 introduced for llama.cpp instead of inventing a
 * third shape.
 *
 * Two measurements on the reference machine (Windows 11, LM Studio 0.3.x, its
 * server up on 1234) shaped what follows:
 *
 *   1. `resolveOnPath('lms')` -> null, `resolveOnPath('lms.exe')` -> the real
 *      binary. `~/.lmstudio/bin` WAS on this user's PATH, and the extensionless
 *      name still missed, because the directory holds only `lms.exe`. Probing
 *      one name would have reported "not installed" on a machine that has it.
 *   2. A `fetch` to a CLOSED loopback port rejects in 0.7-2.4 ms (three runs);
 *      the live server answered in 38.6 ms cold and 4.5 ms warm. That is what
 *      makes it acceptable for {@link probeLmStudioServer} to run on every
 *      availability read: the cost on a machine WITHOUT LM Studio - the case
 *      that must not be taxed - is a connection refusal, not a timeout.
 */

import os from 'node:os';
import path from 'node:path';

/** Loopback port LM Studio's local server binds unless the user changed it. */
export const LM_STUDIO_DEFAULT_PORT = 1234;

/** Host LM Studio's server binds. Loopback only - never a LAN address. */
export const LM_STUDIO_HOST = '127.0.0.1';

/**
 * The OpenAI-compatible base URL Darhai registers as a provider. Keyless: LM
 * Studio ships no auth on the local server, which is why `urlValidation.ts`
 * already lets loopback through and names LM Studio while doing it.
 */
export const LM_STUDIO_BASE_URL = `http://${LM_STUDIO_HOST}:${LM_STUDIO_DEFAULT_PORT}/v1`;

/**
 * LM Studio's OWN model endpoint, and deliberately not the `/v1/models` shim.
 *
 * Two reasons, both load-bearing. It carries fields the OpenAI shape has no
 * room for - measured against the live install: `type` (llm | vlm |
 * embeddings), `state` ("loaded" | "not-loaded"), `arch`, `quantization`,
 * `max_context_length`, `capabilities`. And because the path is LM Studio's
 * alone, a 200 from it identifies WHICH server is on 1234. A probe of
 * `/v1/models` would answer 200 for any OpenAI-compatible process that happened
 * to bind that port, and Darhai would report "LM Studio is available" about
 * something else entirely.
 */
export const LM_STUDIO_MODELS_URL = `http://${LM_STUDIO_HOST}:${LM_STUDIO_DEFAULT_PORT}/api/v0/models`;

/**
 * Binary names to look for on PATH, BOTH spellings.
 *
 * Measured, not assumed: on Windows `~/.lmstudio/bin` contains only `lms.exe`,
 * so a PATH scan for the bare name misses even when the directory is on PATH.
 * Mirrors OLLAMA_BINARIES / VLLM_BINARIES in LocalServeManager.
 */
export const LM_STUDIO_CLI_BINARIES = ['lms', 'lms.exe'] as const;

/** How long a single availability probe may hang before it counts as "no". */
const PROBE_TIMEOUT_MS = 1500;

/** One model LM Studio knows about, as its native API reports it. */
export type LmStudioModel = {
  /** The id to send as `model` on a `/v1/chat/completions` call. */
  id: string;
  /** `'llm' | 'vlm' | 'embeddings'` today; kept open because LM Studio adds kinds. */
  type: string;
  /**
   * `'loaded'` when the weights are in memory right now, `'not-loaded'` when
   * the model is only on disk. LM Studio loads on first request either way, so
   * this is a latency hint, never a usability gate.
   */
  state: string;
  publisher?: string;
  arch?: string;
  quantization?: string;
  /** Native field `max_context_length`, renamed to this repo's camelCase. */
  maxContextLength?: number;
  /** e.g. `['tool_use']`. Absent on embedding models. */
  capabilities?: string[];
};

/** What one read of LM Studio's model endpoint learned. */
export type LmStudioServerProbe = {
  /** True only when LM Studio's OWN endpoint answered with a model list. */
  serving: boolean;
  /** Every model LM Studio knows about; empty whenever `serving` is false. */
  models: LmStudioModel[];
};

/** Both facts about LM Studio on this host. */
export type LmStudioAvailability = {
  /** The `lms` CLI was found, so Darhai could ask it to start the server. */
  installed: boolean;
  /** LM Studio's local server is answering right now. */
  serving: boolean;
  /** Absolute path of the `lms` CLI when found, else null. */
  cliPath: string | null;
};

/** Injectable I/O seam, so every branch below is testable without a machine. */
export type LmStudioDetectDeps = {
  /** Resolve an executable on PATH, or verify an absolute path (X_OK). */
  resolveCommandPath: (cmd: string) => string | null;
  /** The current user's home directory. */
  homeDir: () => string;
  /** `process.platform`, injected so one machine can test all three. */
  platform: () => NodeJS.Platform;
  /** Fetch LM Studio's model endpoint. Defaults to a timed `globalThis.fetch`. */
  fetchModels: (url: string) => Promise<unknown>;
};

/**
 * Absolute places an `lms` CLI lives when it is NOT on PATH.
 *
 * LM Studio only puts `lms` on PATH when the user runs `lms bootstrap`, so
 * "not on PATH" says nothing about whether LM Studio is installed - which is
 * exactly the machine this list is for. `~/.lmstudio/bin` is the modern home on
 * all three platforms (verified against the live install); `~/.cache/lm-studio/bin`
 * is where releases before the rename put it, and an install that predates the
 * move and was never re-bootstrapped still has only that one.
 *
 * Pure and parameterised: `homeDir` is passed in rather than read, so no user's
 * home is baked into the search, and a test can drive all three platforms.
 */
export function lmStudioCliCandidates(homeDir: string, platform: NodeJS.Platform): string[] {
  if (typeof homeDir !== 'string' || homeDir.length === 0) return [];
  const roots = [path.join(homeDir, '.lmstudio', 'bin'), path.join(homeDir, '.cache', 'lm-studio', 'bin')];
  // Windows ships `lms.exe`; macOS and Linux ship the extensionless `lms`. Both
  // names are tried on every platform anyway - `resolveCommandPath` just says
  // no to the one that is absent, and a wrong guess about a future packaging
  // change would otherwise read as "LM Studio is not installed".
  const names = platform === 'win32' ? ['lms.exe', 'lms'] : ['lms', 'lms.exe'];
  const out: string[] = [];
  for (const root of roots) {
    for (const name of names) out.push(path.join(root, name));
  }
  return out;
}

/** Production defaults: the real PATH resolver is supplied by the caller. */
export function defaultLmStudioDeps(resolveCommandPath: (cmd: string) => string | null): LmStudioDetectDeps {
  return {
    resolveCommandPath,
    homeDir: () => os.homedir(),
    platform: () => process.platform,
    fetchModels: defaultFetchLmStudioModels,
  };
}

/**
 * The `lms` candidate paths for THIS machine.
 *
 * Shaped for `new LocalServeManager({ lmStudioCliCandidates: ... })`, and
 * unlike llama.cpp's equivalent it needs nothing from Electron - LM Studio
 * lives under the user's home, not under Darhai's `userData` - so it is the
 * manager's DEFAULT rather than something production has to remember to wire.
 */
export function defaultLmStudioCliCandidates(): string[] {
  return lmStudioCliCandidates(os.homedir(), process.platform);
}

/** Is LM Studio answering on this machine? The manager's default probe. */
export async function defaultLmStudioServingProbe(): Promise<boolean> {
  const probe = await probeLmStudioServer({ fetchModels: defaultFetchLmStudioModels });
  return probe.serving;
}

/**
 * GET LM Studio's model endpoint, bounded by {@link PROBE_TIMEOUT_MS}.
 *
 * Returns `null` for every failure - refused connection, non-2xx, unparseable
 * body, timeout - because the caller has exactly one question and any of those
 * answers it the same way. The timeout exists for a hung socket, not for the
 * common case: a machine with no LM Studio refuses in ~1 ms (measured).
 */
export async function defaultFetchLmStudioModels(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce one raw entry from `/api/v0/models` without trusting any field. */
function toModel(raw: unknown): LmStudioModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  const model: LmStudioModel = {
    id: r.id,
    type: typeof r.type === 'string' ? r.type : 'llm',
    state: typeof r.state === 'string' ? r.state : 'not-loaded',
  };
  if (typeof r.publisher === 'string') model.publisher = r.publisher;
  if (typeof r.arch === 'string') model.arch = r.arch;
  if (typeof r.quantization === 'string') model.quantization = r.quantization;
  if (typeof r.max_context_length === 'number') model.maxContextLength = r.max_context_length;
  if (Array.isArray(r.capabilities)) {
    model.capabilities = r.capabilities.filter((c): c is string => typeof c === 'string');
  }
  return model;
}

/**
 * Ask LM Studio's own API what it is serving.
 *
 * `serving` requires BOTH a reachable endpoint AND a `data` array, so a proxy
 * or captive portal that returns 200-with-HTML on 1234 does not read as LM
 * Studio. An empty `data` array is still `serving: true` - a running LM Studio
 * with no models downloaded is up, just not useful yet, and those are different
 * things for the caller to say.
 */
export async function probeLmStudioServer(deps: Pick<LmStudioDetectDeps, 'fetchModels'>): Promise<LmStudioServerProbe> {
  const body = await deps.fetchModels(LM_STUDIO_MODELS_URL);
  if (!body || typeof body !== 'object') return { serving: false, models: [] };
  const raw = (body as { data?: unknown }).data;
  if (!Array.isArray(raw)) return { serving: false, models: [] };
  const models: LmStudioModel[] = [];
  for (const entry of raw) {
    const model = toModel(entry);
    if (model) models.push(model);
  }
  return { serving: true, models };
}

/**
 * Absolute path of the `lms` CLI, or null.
 *
 * PATH first (a bootstrapped install, and the only place a portable or
 * relocated one can be found), then the home-directory candidates. Both spellings
 * are tried at each step - see {@link LM_STUDIO_CLI_BINARIES}.
 */
export function detectLmStudioCli(
  deps: Pick<LmStudioDetectDeps, 'resolveCommandPath' | 'homeDir' | 'platform'>
): string | null {
  for (const name of LM_STUDIO_CLI_BINARIES) {
    const found = deps.resolveCommandPath(name);
    if (found) return found;
  }
  for (const candidate of lmStudioCliCandidates(deps.homeDir(), deps.platform())) {
    const found = deps.resolveCommandPath(candidate);
    if (found) return found;
  }
  return null;
}

/**
 * Both LM Studio facts for this host, in one call.
 *
 * The two probes are independent and run concurrently: neither answer is
 * derivable from the other. A server can be up while the CLI is somewhere this
 * search does not reach (a portable install), and that host is still fully
 * usable - `serving` alone is what makes LM Studio viable.
 */
export async function detectLmStudio(deps: LmStudioDetectDeps): Promise<LmStudioAvailability> {
  const [cliPath, probe] = await Promise.all([Promise.resolve(detectLmStudioCli(deps)), probeLmStudioServer(deps)]);
  return { installed: cliPath !== null, serving: probe.serving, cliPath };
}
