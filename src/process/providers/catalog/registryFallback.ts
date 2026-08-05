/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A provider's model list, taken from the public models.dev registry rather
 * than from the provider itself.
 *
 * The model picker only ever showed models it had already collected: from a
 * connected provider's catalog, or from a CLI that can enumerate its own. Every
 * other case answered with an empty list - and an empty picker looks exactly
 * like "this agent has no models", not like "nothing has been fetched yet".
 *
 * It hit the ordinary cases. Someone signed into Claude on a subscription has
 * no Anthropic API key connected, so the Anthropic catalog is empty and the
 * picker was blank. An ACP backend the registry does not track at all - grok,
 * kimi, qwen - was blank always. And on a cold start, before `codex` has been
 * run once, the enumerable path returns nothing too.
 *
 * The registry is a static description of what a provider offers, so it is the
 * right thing to fall back to: it needs no key, no network call of its own (the
 * client caches it), and it says nothing about what the user can access - only
 * what exists. Anything actually unavailable fails later, with a real message,
 * which is far better than a picker that offers nothing at all.
 */

import type { ProviderId, RawModel } from '../types';
import type { ModelsDevRegistry } from '../enrichment/modelsDevSchema';
import { MODELS_DEV_PROVIDER_KEY } from './CatalogAssembler';

/**
 * The models the registry lists for `providerId`, as raw entries ready for the
 * assembler to enrich. Empty when the registry does not describe this provider.
 */
export function rawModelsFromRegistry(providerId: ProviderId, registry: ModelsDevRegistry): RawModel[] {
  const key = MODELS_DEV_PROVIDER_KEY[providerId] ?? providerId;
  const models = registry?.[key]?.models;
  if (!models) return [];
  return Object.keys(models).map((id) => ({ id, providerId }));
}

/**
 * A `CatalogSource` over the registry, so the fallback reuses the same
 * enrichment path as a real source instead of building `CatalogModel`s by hand.
 */
export function makeRegistrySource(providerId: ProviderId, registry: ModelsDevRegistry) {
  return {
    kind: 'api' as const,
    providerId,
    listModels: async (): Promise<RawModel[]> => rawModelsFromRegistry(providerId, registry),
  };
}
