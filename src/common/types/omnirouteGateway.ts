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
