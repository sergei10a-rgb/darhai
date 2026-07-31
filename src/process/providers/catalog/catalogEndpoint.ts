/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Catalog endpoint resolution - the routing authority lookup for the ~100
 * catalog providers surfaced by `modelRegistry.getProviderCatalog`.
 *
 * The native providers ship a hand-wired `PROVIDER_ENDPOINTS` entry; the
 * catalog providers do NOT (they are curated out of the vendored file by the
 * `native-collision` rule, so the two sets never overlap). Their endpoint lives
 * in the vendored `providerCatalog.generated.json` `baseUrl` column and nowhere
 * else, which means every code path that needs to talk to a catalog provider -
 * the connection probe, the catalog build, the chat-start dispatch - has to read
 * it from here rather than hardcode a URL at the call site.
 *
 * Backed by {@link loadBaselineProviderCatalog} (the vendored file, never the
 * network), indexed once on first use. Main-process only.
 */

import type { ProviderId } from '../types';
import { loadBaselineProviderCatalog } from './providerCatalogStore';

/** Lazily-built `providerId -> baseUrl` index over the vendored baseline. */
let baseUrlIndex: ReadonlyMap<string, string> | null = null;

/** Build (once) the id -> baseUrl index from the vendored baseline catalog. */
function index(): ReadonlyMap<string, string> {
  if (baseUrlIndex === null) {
    baseUrlIndex = new Map(loadBaselineProviderCatalog().map((entry) => [entry.id, entry.baseUrl]));
  }
  return baseUrlIndex;
}

/**
 * The catalog provider's own OpenAI-compatible REST root, or `undefined` when
 * `providerId` is not a catalog provider (every native provider lands here).
 * A blank `baseUrl` is treated as absent so a malformed row can never be
 * promoted into a routing URL.
 */
export function catalogBaseUrlFor(providerId: ProviderId): string | undefined {
  const baseUrl = index().get(providerId);
  if (typeof baseUrl !== 'string') return undefined;
  const trimmed = baseUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True when `providerId` is one of the vendored catalog providers. */
export function isCatalogProvider(providerId: ProviderId): boolean {
  return index().has(providerId);
}
