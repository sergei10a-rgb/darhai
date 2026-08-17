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
 * Three measurements on the reference machine (Windows 11, LM Studio 0.3.x, its
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
 *   3. The port is the user's to change, and `lms server status --json` reports
 *      it in BOTH server states (measured 2026-08-17, exit 0 each time):
 *      `{"running":true,"port":1234}` at 313.8 / 329.1 ms warm,
 *      `{"running":false,"port":1234}` at 416.3 ms - the field carries the
 *      CONFIGURED port even while nothing is listening on it. After
 *      `lms server start --port 12399` it answered `{"running":true,"port":12399}`,
 *      `/api/v0/models` served 8 models on 12399, and 1234 REFUSED - which is
 *      exactly the host a probe pinned to 1234 misreports as "no LM Studio".
 *      So {@link detectLmStudioPort} asks the CLI for the real port before the
 *      probe, and only when the CLI was found: the ~300-420 ms status call is
 *      paid solely by machines that HAVE LM Studio, while a bare host keeps its
 *      measured ~1 ms refusal on the 1234 fallback. Once per availability read,
 *      never cached across reads - a user can move the port mid-session.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
 * LM Studio's OWN model endpoint on the given port, and deliberately not the
 * `/v1/models` shim.
 *
 * Two reasons, both load-bearing. It carries fields the OpenAI shape has no
 * room for - measured against the live install: `type` (llm | vlm |
 * embeddings), `state` ("loaded" | "not-loaded"), `arch`, `quantization`,
 * `max_context_length`, `capabilities`. And because the path is LM Studio's
 * alone, a 200 from it identifies WHICH server is on that port. A probe of
 * `/v1/models` would answer 200 for any OpenAI-compatible process that happened
 * to bind it, and Darhai would report "LM Studio is available" about something
 * else entirely.
 */
export function lmStudioModelsUrl(port: number): string {
  return `http://${LM_STUDIO_HOST}:${port}/api/v0/models`;
}

/** {@link lmStudioModelsUrl} on the default port - the pre-detection fallback. */
export const LM_STUDIO_MODELS_URL = lmStudioModelsUrl(LM_STUDIO_DEFAULT_PORT);

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

/**
 * How long `lms server status --json` may run before the port falls back to
 * {@link LM_STUDIO_DEFAULT_PORT}. Measured 313.8-416.3 ms on the reference
 * machine (a 115 MB binary starting up each call); 3000 leaves room for a
 * cold antivirus scan of that binary without stalling an availability read
 * indefinitely.
 */
const STATUS_TIMEOUT_MS = 3000;

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
  /**
   * Run `<cliPath> server status --json` and return its raw stdout, or null on
   * ANY failure (spawn error, non-zero exit, timeout) - the caller has one
   * fallback for all of them. Required, not optional: an omitted seam would
   * silently pin the probe back to 1234, which is the defect this seam closes.
   */
  execServerStatus: (cliPath: string) => Promise<string | null>;
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
    execServerStatus: defaultExecLmStudioServerStatus,
  };
}

/**
 * Resolve an executable on PATH, or verify an absolute path (X_OK), for the
 * default probe alone.
 *
 * A copy of LocalServeManager's `resolveOnPath`, NOT an import: LocalServeManager
 * imports this module (its LM Studio defaults live here), so the reverse import
 * would close a cycle. Everything injectable still receives the manager's own
 * resolver through {@link defaultLmStudioDeps}; only the zero-argument
 * {@link defaultLmStudioServingProbe} - wired as a `LocalServeDeps` default
 * with no way to be handed one - needs a resolver of its own.
 */
function resolveExecutableForDefaults(cmd: string): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

const execFileAsync = promisify(execFile);

/**
 * The production {@link LmStudioDetectDeps.execServerStatus}: run the found
 * `lms` with `server status --json`, bounded by {@link STATUS_TIMEOUT_MS}.
 *
 * Null for every failure, the same one-answer contract as
 * {@link defaultFetchLmStudioModels} - a CLI that cannot answer costs the
 * caller nothing but the 1234 fallback it already had.
 */
export async function defaultExecLmStudioServerStatus(cliPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cliPath, ['server', 'status', '--json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
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

/**
 * The port in one `lms server status --json` stdout, or null.
 *
 * The measured shapes (2026-08-17): `{"running":true,"port":1234}` with the
 * server up, `{"running":false,"port":1234}` with it down, and
 * `{"running":true,"port":12399}` after `lms server start --port 12399`. The
 * `port` field is the CONFIGURED port and is present in both states, so
 * `running` is deliberately not read here - whether anything is listening is
 * the probe's question, and the probe answers it against this port either way.
 *
 * Null for anything that is not a JSON object carrying a valid TCP port:
 * the caller's fallback is {@link LM_STUDIO_DEFAULT_PORT}, and a half-trusted
 * number would aim the probe at a port no server was ever configured on.
 */
export function parseLmStudioStatusPort(stdout: string): number | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const port = (body as { port?: unknown }).port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * The port LM Studio's server is configured on, best-effort.
 *
 * The status call runs ONLY when the CLI was found - that keeps the measured
 * property that matters: a machine without LM Studio pays a ~1 ms connection
 * refusal on the fallback port, never a ~300-420 ms CLI start-up for a feature
 * it does not have. When the CLI is missing, errors, or answers something
 * unparseable, the answer is {@link LM_STUDIO_DEFAULT_PORT} - exactly the
 * behaviour this module had before the port was read at all.
 */
export async function detectLmStudioPort(
  cliPath: string | null,
  deps: Pick<LmStudioDetectDeps, 'execServerStatus'>
): Promise<number> {
  if (cliPath === null) return LM_STUDIO_DEFAULT_PORT;
  const stdout = await deps.execServerStatus(cliPath);
  if (stdout === null) return LM_STUDIO_DEFAULT_PORT;
  return parseLmStudioStatusPort(stdout) ?? LM_STUDIO_DEFAULT_PORT;
}

/**
 * Is LM Studio answering on this machine? The manager's default probe.
 *
 * One {@link detectLmStudio} pass: find the CLI, ask IT for the real port
 * (once - this function is called once per `detectAvailability`, so the
 * status cost is once per availability read), then probe that port. A server
 * the user moved off 1234 is found instead of misreported as absent.
 */
export async function defaultLmStudioServingProbe(
  deps: LmStudioDetectDeps = defaultLmStudioDeps(resolveExecutableForDefaults)
): Promise<boolean> {
  const availability = await detectLmStudio(deps);
  return availability.serving;
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
 *
 * `port` defaults to {@link LM_STUDIO_DEFAULT_PORT} so a caller with no better
 * knowledge behaves exactly as before; the availability path passes the port
 * {@link detectLmStudioPort} read from the CLI, which is what finds a server
 * the user moved.
 */
export async function probeLmStudioServer(
  deps: Pick<LmStudioDetectDeps, 'fetchModels'>,
  port: number = LM_STUDIO_DEFAULT_PORT
): Promise<LmStudioServerProbe> {
  const body = await deps.fetchModels(lmStudioModelsUrl(port));
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
 * The two answers stay independent - a server can be up while the CLI is
 * somewhere this search does not reach (a portable install), and that host is
 * still fully usable, because `serving` alone is what makes LM Studio viable.
 * The STEPS are no longer concurrent, though: the CLI, when found, is asked
 * for the configured port first ({@link detectLmStudioPort}, one status call
 * per detection), so the probe aims at the port the user actually chose. A
 * host without the CLI skips the status call entirely and probes the 1234
 * fallback, exactly as before.
 */
export async function detectLmStudio(deps: LmStudioDetectDeps): Promise<LmStudioAvailability> {
  const cliPath = detectLmStudioCli(deps);
  const port = await detectLmStudioPort(cliPath, deps);
  const probe = await probeLmStudioServer(deps, port);
  return { installed: cliPath !== null, serving: probe.serving, cliPath };
}

/** A serve-path probe answer: the models AND the port they were found on. */
export type LmStudioServeProbe = LmStudioServerProbe & {
  /** The port the probe actually asked - detected from the CLI, else 1234. */
  port: number;
};

/**
 * The serve path's probe: same CLI-first port detection as
 * {@link detectLmStudio}, but the caller also needs the model list and the
 * port itself, because whatever URL gets REGISTERED for the agent to call
 * must be the URL the models were found on. Splitting "is it serving" from
 * "which port" across two calls is how the old code registered 1234 for a
 * server it had just found elsewhere.
 */
export async function probeLmStudioForServe(overrides: Partial<LmStudioDetectDeps> = {}): Promise<LmStudioServeProbe> {
  // Callers pass their IMPORTED seam functions as overrides (the manager
  // hands in `defaultFetchLmStudioModels`/`defaultExecLmStudioServerStatus`
  // by name) so a test that mocks this module's exports intercepts the
  // network and the CLI; internal bindings would silently bypass the mock.
  const deps: LmStudioDetectDeps = { ...defaultLmStudioDeps(resolveExecutableForDefaults), ...overrides };
  const cliPath = detectLmStudioCli(deps);
  const port = await detectLmStudioPort(cliPath, deps);
  const probe = await probeLmStudioServer(deps, port);
  return { ...probe, port };
}

/** The `/v1` OpenAI-compatible base URL for a detected LM Studio port. */
export function lmStudioBaseUrl(port: number): string {
  return `http://${LM_STUDIO_HOST}:${port}/v1`;
}
