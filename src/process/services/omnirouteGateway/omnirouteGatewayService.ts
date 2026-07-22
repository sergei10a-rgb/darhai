/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OmniRoute-gateway orchestration: persist the Settings-card state and keep the
 * `omniroute-gateway` provider registration in sync with it.
 *
 * Connect-only by design: this service NEVER connects a free provider or writes
 * OmniRoute's provider/relay config on the user's behalf. The only network call
 * it ever makes is a bounded `GET {baseUrl}/models` against the URL the user
 * confirmed - either to populate the catalog on enable or on "test connection".
 *
 * C2 update to the boundary: Darhai may now INSTALL + SPAWN + open OmniRoute's
 * dashboard as a convenience (see OmnirouteRuntimeManager), but that lifecycle
 * lives OUTSIDE this file. This service only registers Darhai's OWN
 * `omniroute-gateway` provider at the (local) endpoint - it still NEVER connects
 * a provider inside OmniRoute for the user; that stays the user's own action in
 * OmniRoute's dashboard.
 *
 * Enable = registry upsert + catalog + legacy mirror (so the provider appears
 * in the per-conversation model pickers, marked as an external relay). Disable
 * = registry delete + mirror removal. Neither path touches default-model
 * logic; the auto-pick exclusion lives in `usableModels` (oneShot.ts).
 */

import type {
  OmnirouteGatewayConfigView,
  OmnirouteGatewaySetConfigParams,
  OmnirouteGatewayTestResult,
} from '@/common/types/omnirouteGateway';
import { OMNIROUTE_GATEWAY_PROVIDER_ID } from '@/common/types/omnirouteGateway';
import { getModelRegistryRepository } from '@process/providers/ipc/modelRegistryIpc';
import { mirrorConnectOrRekey, mirrorDisconnect } from '@process/providers/legacyModelConfigBridge';
import {
  getOmnirouteGatewayConfig,
  normalizeGatewayBaseUrl,
  setOmnirouteGatewayConfig,
} from './omnirouteGatewayConfig';
import {
  deregisterOmnirouteGatewayFromRepo,
  registerOmnirouteGatewayInRepo,
  type OmnirouteGatewayRegistryRepo,
} from './omnirouteGatewayRegistration';

/** Probe timeout - the gateway is local, so a slow answer means "not there". */
const MODELS_FETCH_TIMEOUT_MS = 4000;

/** Cap on model ids accepted from the gateway (untrusted response data). */
const MAX_GATEWAY_MODELS = 500;

/** Result of a `GET {baseUrl}/models` probe. */
type GatewayModelsProbe = { ok: true; modelIds: string[] } | { ok: false; error: string };

/**
 * Fetch the gateway's OpenAI-compatible model list (`GET {baseUrl}/models`)
 * with a bounded timeout. Never throws - failures come back as `{ ok: false }`
 * so enable can degrade to an empty catalog and test-connection can surface a
 * clean error string.
 */
export async function fetchGatewayModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<GatewayModelsProbe> {
  const base = normalizeGatewayBaseUrl(baseUrl);
  if (!base) return { ok: false, error: 'invalid-base-url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim().length > 0) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetchImpl(`${base}/models`, { signal: controller.signal, headers });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    const body = (await res.json()) as unknown;
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) return { ok: true, modelIds: [] };
    const modelIds = data
      .slice(0, MAX_GATEWAY_MODELS)
      .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    return { ok: true, modelIds };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The renderer-facing config view - never includes the stored API key. */
export async function getOmnirouteGatewayConfigView(): Promise<OmnirouteGatewayConfigView> {
  const config = await getOmnirouteGatewayConfig();
  return { enabled: config.enabled, baseUrl: config.baseUrl, hasApiKey: config.apiKey.length > 0 };
}

/**
 * Apply a Settings-card save: validate + persist the config, then register or
 * deregister the gateway provider to match. `apiKey === undefined` keeps the
 * stored key; `''` clears it. Never throws - failures come back as
 * `{ ok: false, error }` for the card to display.
 */
export async function applyOmnirouteGatewayConfig(
  params: OmnirouteGatewaySetConfigParams,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = normalizeGatewayBaseUrl(params.baseUrl);
  if (!baseUrl) return { ok: false, error: 'invalid-base-url' };

  try {
    const current = await getOmnirouteGatewayConfig();
    const apiKey = params.apiKey !== undefined ? params.apiKey : current.apiKey;
    const enabled = params.enabled === true;
    await setOmnirouteGatewayConfig({ enabled, baseUrl, apiKey });

    const repo = getModelRegistryRepository() as OmnirouteGatewayRegistryRepo | null;
    if (!repo) return { ok: false, error: 'registry-unavailable' };

    if (enabled) {
      // Catalog is best-effort: an unreachable gateway still registers with an
      // empty catalog (the user may start their gateway later; re-saving or
      // re-enabling refreshes it). Registration itself must not depend on the
      // gateway being up at the moment of the toggle.
      const probe = await fetchGatewayModels(baseUrl, apiKey, fetchImpl);
      const registered = registerOmnirouteGatewayInRepo(repo, {
        baseUrl,
        apiKey,
        modelIds: probe.ok ? probe.modelIds : [],
      });
      if (!registered) return { ok: false, error: 'registration-failed' };
      // Mirror into the legacy model.config so the per-conversation pickers
      // list the relay-marked provider for EXPLICIT selection (condition 3).
      await mirrorConnectOrRekey(repo as Parameters<typeof mirrorConnectOrRekey>[0], OMNIROUTE_GATEWAY_PROVIDER_ID);
    } else {
      deregisterOmnirouteGatewayFromRepo(repo);
      await mirrorDisconnect(OMNIROUTE_GATEWAY_PROVIDER_ID);
    }
    return { ok: true };
  } catch (err) {
    console.error('[omnirouteGateway] applyConfig failed:', err);
    return { ok: false, error: 'apply-failed' };
  }
}

/**
 * Settings-card "test connection": probe the URL the user typed (their own
 * gateway - condition 4) and report reachability + model count, or a clean
 * error token the card maps to a localized message. Never throws.
 */
export async function testOmnirouteGatewayConnection(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch
): Promise<OmnirouteGatewayTestResult> {
  const key = typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : (await getOmnirouteGatewayConfig()).apiKey;
  const probe = await fetchGatewayModels(baseUrl, key, fetchImpl);
  // Explicit discriminant comparison: this tsconfig has no strictNullChecks,
  // so a truthiness check would not narrow the union.
  if (probe.ok === false) return { ok: false, error: probe.error };
  return { ok: true, modelCount: probe.modelIds.length };
}
