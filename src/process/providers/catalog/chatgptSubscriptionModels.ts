/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */
import type { CatalogModel, UsageTag } from '@process/providers/types';

/** The native provider id for a ChatGPT subscription connected via OAuth. */
export const CHATGPT_SUBSCRIPTION_PROVIDER_ID = 'chatgpt-subscription';

/**
 * The valid model ids on the ChatGPT backend Responses path
 * (`chatgpt.com/backend-api/codex/responses`). A subscription token cannot list
 * models (there is no `/v1/models` on this backend), so the catalog is static.
 */
export const CHATGPT_SUBSCRIPTION_MODEL_IDS = [
  'gpt-5.2-codex',
  'gpt-5.2',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1',
  'codex-mini-latest',
] as const;

/** Human-facing display names for the static model set. */
const DISPLAY: Record<string, string> = {
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1': 'GPT-5.1',
  'codex-mini-latest': 'Codex Mini',
};

/**
 * Build the static catalog for the ChatGPT subscription provider. There is no
 * live model listing on the ChatGPT backend, so these are the canonical ids the
 * Responses path accepts. Mirrors `injectFluxVirtualModels`: unenriched virtual
 * entries that the Curator special-cases (by `providerId`) to keep enabled +
 * recommended downstream, so a connected subscription is usable immediately.
 */
export function buildChatGptSubscriptionCatalog(): CatalogModel[] {
  return CHATGPT_SUBSCRIPTION_MODEL_IDS.map((id) => ({
    id,
    providerId: CHATGPT_SUBSCRIPTION_PROVIDER_ID,
    displayName: DISPLAY[id] ?? id,
    family: id,
    kind: 'text' as const,
    enriched: false,
    tags: [] as UsageTag[],
  }));
}
