/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Register/deregister the USER-RUN OmniRoute gateway as the `omniroute-gateway`
 * model-registry provider (main process).
 *
 * A direct port of the `cookbook-local` / `ollama-local` keyless-provider
 * pattern ({@link registerCookbookServeInRepo}): an OpenAI-compatible `/v1`
 * endpoint the user confirmed becomes a selectable provider row. Owner
 * conditions enforced here:
 *
 *  - Condition 3 (explicit selection only): registration makes the provider
 *    SELECTABLE, nothing more. It never becomes a default - the auto-pick
 *    guard lives in `usableModels` (oneShot.ts).
 *  - Condition 4 (user-run gateway): this module never spawns/installs
 *    anything; it only writes registry rows pointing at the user's URL. The
 *    model ids fetched from the gateway are DATA - written into the catalog
 *    only, never interpolated into any URL or command.
 *  - Idempotent: re-enable upserts the same row (no duplicates); disable
 *    deletes the row + its catalog (cascade) so a switched-off relay leaves
 *    no trace in the pickers.
 */

import type { CatalogModel, ConnectError, ProviderConnState, ProviderId } from '@process/providers/types';
import { OMNIROUTE_GATEWAY_PROVIDER_ID } from '@/common/types/omnirouteGateway';

/**
 * The slice of the provider repository this flow reads + writes. Parameter
 * types match {@link ProviderRepository} exactly so the concrete repo
 * satisfies this structural type without a cast.
 */
export type OmnirouteGatewayRegistryRepo = {
  getRegistryProvider: (providerId: ProviderId) => { state: string } | null;
  upsertRegistryProvider: (params: {
    providerId: ProviderId;
    connectedVia: string;
    state: ProviderConnState;
    error?: ConnectError;
    creds: Record<string, unknown>;
  }) => void;
  replaceRegistryCatalog: (providerId: ProviderId, models: CatalogModel[]) => void;
  deleteRegistryProvider: (providerId: ProviderId) => void;
};

/** What an enable-registration writes: the confirmed endpoint + optional key. */
export type OmnirouteGatewayRegistration = {
  /** The user-confirmed gateway `/v1` base URL. */
  baseUrl: string;
  /** Optional gateway API key ('' = keyless local gateway). */
  apiKey: string;
  /** Model ids reported by `GET {baseUrl}/models` (empty when unreachable). */
  modelIds: string[];
};

/** Build a minimal catalog model for a gateway-reported model id (data only). */
function toCatalogModel(modelId: string): CatalogModel {
  return {
    id: modelId,
    providerId: OMNIROUTE_GATEWAY_PROVIDER_ID,
    displayName: modelId,
    family: modelId.split('/').pop()?.split(':')[0] || modelId,
    kind: 'text',
    enriched: false,
    tags: ['chat'],
  };
}

/** De-duplicate + drop empties from the reported model ids, preserving order. */
export function normalizeGatewayModelIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Pure, repo-injected enable core (exported for tests). Idempotent: a second
 * enable upserts the same `omniroute-gateway` row (new creds/URL) + replaces
 * the catalog - never a duplicate. Never throws; a repo failure returns false
 * so the caller can surface a clean error instead of a crash.
 */
export function registerOmnirouteGatewayInRepo(
  repo: OmnirouteGatewayRegistryRepo,
  reg: OmnirouteGatewayRegistration
): boolean {
  try {
    repo.upsertRegistryProvider({
      providerId: OMNIROUTE_GATEWAY_PROVIDER_ID,
      connectedVia: 'omniroute-gateway',
      state: 'connected',
      creds: { key: reg.apiKey, baseUrl: reg.baseUrl },
    });
    repo.replaceRegistryCatalog(
      OMNIROUTE_GATEWAY_PROVIDER_ID,
      normalizeGatewayModelIds(reg.modelIds).map(toCatalogModel)
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure, repo-injected disable core (exported for tests). Deletes the provider
 * row (catalog + overrides cascade away) so the relay disappears from every
 * picker - an intentional opt-out must not linger as "Action needed". No-op
 * when the provider was never registered. Never throws.
 */
export function deregisterOmnirouteGatewayFromRepo(repo: OmnirouteGatewayRegistryRepo): boolean {
  try {
    if (repo.getRegistryProvider(OMNIROUTE_GATEWAY_PROVIDER_ID)) {
      repo.deleteRegistryProvider(OMNIROUTE_GATEWAY_PROVIDER_ID);
    }
    return true;
  } catch {
    return false;
  }
}
