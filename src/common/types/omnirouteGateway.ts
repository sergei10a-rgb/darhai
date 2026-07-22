/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OmniRoute-gateway opt-in provider (Phase 7b) - shared types + constants.
 *
 * Darhai can connect to a USER-RUN local OmniRoute gateway (an OpenAI-compatible
 * aggregator) as an opt-in provider. Four binding conditions shape everything:
 *
 *  1. Honest disclosure, default OFF - the Settings card explains benefits AND
 *     risks in Mongolian; Darhai never enables the relay on its own.
 *  2. Visible marking - the provider display name carries the Mongolian
 *     "external relay" marking so every model label shows where prompts go.
 *  3. Explicit selection only - enabling only REGISTERS the provider; it is
 *     never the default and every automatic model pick skips it.
 *  4. User-run gateway - Darhai never installs/spawns/hosts OmniRoute; it only
 *     connects to the URL the user confirmed.
 */

/** The fixed provider id the gateway registers under (registry + guards). */
export const OMNIROUTE_GATEWAY_PROVIDER_ID = 'omniroute-gateway';

/**
 * Condition 2 (visible marking): the display name shown wherever the provider
 * label appears (model picker, conversation header, Models settings). The
 * Mongolian suffix marks it as an EXTERNAL RELAY - prompts leave the machine
 * through third-party providers. Intentionally a constant, not an i18n key:
 * provider names are data shared across processes and must never lose the mark.
 */
export const OMNIROUTE_GATEWAY_DISPLAY_NAME = 'OmniRoute Gateway (гадаад дамжуулагч)';

/** Default gateway endpoint prefill - the port `omniroute` binds locally. */
export const OMNIROUTE_GATEWAY_DEFAULT_BASE_URL = 'http://localhost:20128/v1';

/** The persisted gateway configuration (main-process view). */
export type OmnirouteGatewayConfig = {
  /** Opt-in master switch. Default false - Darhai never enables it itself. */
  enabled: boolean;
  /** The user-confirmed gateway `/v1` endpoint. */
  baseUrl: string;
  /** Optional gateway API key ('' when the gateway runs keyless). */
  apiKey: string;
};

/**
 * The renderer-facing config view. The stored API key is never returned to the
 * renderer (a remote-readable `get-config` must not disclose credentials);
 * `hasApiKey` only says whether one is stored.
 */
export type OmnirouteGatewayConfigView = {
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
};

/** Parameters for the Settings save. `apiKey` undefined = keep the stored key. */
export type OmnirouteGatewaySetConfigParams = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
};

/** Result of a Settings-card "test connection" probe against the gateway. */
export type OmnirouteGatewayTestResult = { ok: true; modelCount: number } | { ok: false; error: string };

// ── C2: one-click auto-install + run (convenience runtime) ──────────────────
//
// Darhai can, as a CONVENIENCE, install + run the user's own OmniRoute in the
// background and open OmniRoute's OWN dashboard. The liability boundary is:
// Darhai installs/spawns/opens the dashboard, but NEVER connects a free provider
// or writes OmniRoute's provider/relay config - the user does that themselves in
// OmniRoute's dashboard (so the ToS/relay choice + liability stay the user's).
// Registering Darhai's own `omniroute-gateway` provider at localhost:20128/v1
// (see applyOmnirouteGatewayConfig) is separate and allowed - it only points
// Darhai's gateway at the user's local OmniRoute.

/** The fixed local port OmniRoute binds (dashboard + OpenAI-compatible `/v1`). */
export const OMNIROUTE_RUNTIME_PORT = 20128;

/** OmniRoute's OWN dashboard URL - opened so the USER connects providers there. */
export const OMNIROUTE_DASHBOARD_URL = 'http://localhost:20128';

/** The `/v1/models` health endpoint used to confirm the spawned server is up. */
export const OMNIROUTE_HEALTH_URL = 'http://localhost:20128/v1/models';

/**
 * OmniRoute package spec installed by the one-click flow. A caret range on the
 * current 3.x line (npm latest is 3.8.48 as of 2026-07) rather than an exact
 * pin: OmniRoute publishes very frequently, so an exact pin goes stale within
 * days and risks a 404 if that version is ever unpublished, while the caret
 * keeps installs fresh yet bounded to the tested major. Bump the floor after
 * verifying a newer release.
 */
export const OMNIROUTE_PINNED_PACKAGE = 'omniroute@^3.8.48';

/** Which runtime the one-click flow used to install/run OmniRoute. */
export type OmnirouteRuntimeKind = 'bun' | 'node';

/** Lifecycle state of the Darhai-managed OmniRoute process. */
export type OmnirouteRuntimeState =
  | 'idle' // never installed/started this session
  | 'installing' // global install in progress
  | 'installed' // installed, not yet running
  | 'starting' // spawned, waiting for health
  | 'running' // healthy on OMNIROUTE_RUNTIME_PORT
  | 'stopped' // was running, now stopped
  | 'error'; // install/start failed (see error / needsRuntime)

/** Snapshot of the OmniRoute runtime the Settings card renders. */
export type OmnirouteRuntimeStatus = {
  state: OmnirouteRuntimeState;
  /** The bound port when running, else null. */
  port: number | null;
  /** OmniRoute's dashboard URL when running, else null. */
  dashboardUrl: string | null;
  /** Which runtime install/run used, or null before resolution. */
  runtime: OmnirouteRuntimeKind | null;
  /** True when no runtime (bun/node) is available - the card shows the Node hint. */
  needsRuntime: boolean;
  /** A clean error token/message when `state === 'error'`. */
  error?: string;
};

/** A single install/start progress event pushed to the card. */
export type OmnirouteInstallProgress = {
  /** Which phase the line belongs to. */
  phase: 'install' | 'start' | 'health';
  /** A human-facing line (installer stdout tail or a phase marker). */
  message: string;
};
