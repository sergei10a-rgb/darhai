/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Register a cookbook-served local model as the keyless `cookbook-local`
 * model-registry provider (main process).
 *
 * A direct port of {@link autoRegisterOllamaInRepo}'s pattern: a served GGUF on
 * a loopback OpenAI-compatible `/v1` endpoint becomes a first-class, keyless,
 * connected provider so it is immediately selectable in chat - without the user
 * hand-adding a custom provider. The ollama-local provider (127.0.0.1:11434/v1)
 * is the reference; this uses the DYNAMIC port llama-server bound to.
 *
 * Design constraints (mirroring the ollama-local spec):
 *  - Dedicated native id `cookbook-local` (never overloads the single-row
 *    `openai-compatible` slot a user's cloud provider may own).
 *  - Loopback base URL `http://127.0.0.1:{port}/v1`; keyless (empty key). The
 *    served model name is treated as DATA - written into the catalog only,
 *    never interpolated into any URL or command.
 *  - Idempotent: a re-serve upserts the row (new port) + replaces the one-model
 *    catalog. On stop the row is flipped to `error` (not hard-deleted) so the
 *    user sees "Action needed" rather than a silently vanished provider.
 */

import type { CatalogModel, ConnectError, ProviderConnState, ProviderId } from '@process/providers/types';

/** The fixed native provider id for a cookbook-served local model. */
export const COOKBOOK_LOCAL_ID: ProviderId = 'cookbook-local';

/**
 * The slice of the provider repository this flow reads + writes. The parameter
 * types match {@link ProviderRepository} exactly (ProviderConnState /
 * ConnectError) so the concrete repo satisfies this structural type under
 * strictFunctionTypes without a cast.
 */
export type CookbookRegistryRepo = {
  getRegistryProvider: (providerId: ProviderId) => { state: string } | null;
  upsertRegistryProvider: (params: {
    providerId: ProviderId;
    connectedVia: string;
    state: ProviderConnState;
    error?: ConnectError;
    creds: Record<string, unknown>;
  }) => void;
  updateRegistryProviderState: (providerId: ProviderId, state: ProviderConnState, error?: ConnectError) => void;
  replaceRegistryCatalog: (providerId: ProviderId, models: CatalogModel[]) => void;
};

/** Details of the model a cookbook serve exposes. */
export type CookbookServeRegistration = {
  /** Loopback port the local server bound to. */
  port: number;
  /** The model id the agent should target (the served model). */
  servedModelId: string;
  /** Human display label for the model. */
  displayName: string;
  /**
   * The `/v1` base URL to register, when it is NOT the loopback endpoint a
   * Darhai-spawned server bound.
   *
   * Exists for LM Studio: its server is a long-lived GUI app the user owns, so
   * Darhai never allocates its port - it reads where LM Studio already listens
   * and registers that (`LM_STUDIO_BASE_URL`). Omitted by the llama-server and
   * vLLM paths, which DO own their port and keep deriving the URL from it, so
   * the loopback host stays a single hardcoded literal rather than something a
   * caller could point anywhere.
   */
  baseUrl?: string;
};

/** Build the one-entry catalog model for a cookbook-served model. */
function toCatalogModel(reg: CookbookServeRegistration): CatalogModel {
  return {
    id: reg.servedModelId,
    providerId: COOKBOOK_LOCAL_ID,
    displayName: reg.displayName,
    family: reg.servedModelId.split('/').pop()?.split(':')[0] || reg.servedModelId,
    kind: 'text',
    enriched: false,
    tags: ['chat'],
  };
}

/**
 * Pure, repo-injected core (exported for tests). Idempotent:
 *  - upserts the `cookbook-local` row as `connected` + keyless, pinned to the
 *    loopback endpoint on `port`, and
 *  - replaces its catalog with the single served model.
 *
 * Never throws - a repo error is swallowed so a serve that started fine is not
 * reported as failed just because provider persistence hiccupped.
 */
export function registerCookbookServeInRepo(repo: CookbookRegistryRepo, reg: CookbookServeRegistration): boolean {
  try {
    repo.upsertRegistryProvider({
      providerId: COOKBOOK_LOCAL_ID,
      connectedVia: 'cookbook-serve',
      state: 'connected',
      creds: { key: '', baseUrl: reg.baseUrl || `http://127.0.0.1:${reg.port}/v1` },
    });
    repo.replaceRegistryCatalog(COOKBOOK_LOCAL_ID, [toCatalogModel(reg)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flip the `cookbook-local` provider to `error` when the serve stops. Not a
 * hard delete: the row (and its catalog) stay so the Models page shows it as
 * "Action needed - offline" instead of silently disappearing. No-op when the
 * provider was never registered. Never throws.
 */
export function markCookbookServeStoppedInRepo(repo: CookbookRegistryRepo): void {
  try {
    if (repo.getRegistryProvider(COOKBOOK_LOCAL_ID)) {
      repo.updateRegistryProviderState(COOKBOOK_LOCAL_ID, 'error', 'offline');
    }
  } catch {
    // Best-effort - a stopped serve must never crash the quit / stop path.
  }
}
