/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Encrypted-at-rest storage for subscription OAuth tokens.
 *
 * Like {@link ToolKeyStore}, this reuses the existing model-registry credential
 * rail rather than adding a parallel encryption boundary: each provider's tokens
 * are persisted through {@link ProviderRepository} under a `subscription:<id>`
 * provider id, encrypted by the same OS-keychain-backed `safeStorage` path
 * (macOS Keychain / Windows DPAPI / Linux libsecret) as every other credential.
 * The `ProviderId` type already accepts arbitrary string ids, so no new table or
 * migration is needed.
 *
 * The store interface ({@link SubscriptionCredStore}) is deliberately narrow so
 * the flows and tests depend on the abstraction, not on the database.
 */

import type { ProviderRepository } from '@process/providers/storage/ProviderRepository';
import type { ProviderId } from '@process/providers/types';
import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';
import type { OAuthCredentials, SubscriptionCredStore } from './types';

/** Provider-id namespace under which subscription tokens live in the registry. */
const SUBSCRIPTION_PROVIDER_PREFIX = 'subscription:';

/** Map a subscription id onto its namespaced registry provider id. */
function registryId(id: SubscriptionProviderId): ProviderId {
  return `${SUBSCRIPTION_PROVIDER_PREFIX}${id}`;
}

/**
 * Validate a decrypted registry record into {@link OAuthCredentials}. Returns
 * `undefined` when the required token fields are missing or the wrong type, so a
 * corrupt/legacy row is treated as "not connected" rather than crashing a
 * completion. Extra provider fields (accountId, enterpriseUrl) are preserved.
 */
export function coerceCredentials(creds: Record<string, unknown>): OAuthCredentials | undefined {
  if (
    typeof creds.access === 'string' &&
    creds.access.length > 0 &&
    typeof creds.refresh === 'string' &&
    creds.refresh.length > 0 &&
    typeof creds.expires === 'number'
  ) {
    return creds as OAuthCredentials;
  }
  return undefined;
}

/**
 * {@link ProviderRepository}-backed implementation of {@link SubscriptionCredStore}.
 * Synchronous, mirroring the repository's better-sqlite3 access.
 */
export class ProviderRepositoryCredStore implements SubscriptionCredStore {
  constructor(private readonly repo: ProviderRepository) {}

  read(providerId: SubscriptionProviderId): OAuthCredentials | undefined {
    const result = this.repo.getRegistryProviderCreds(registryId(providerId));
    if (result.status !== 'ok') return undefined;
    return coerceCredentials(result.creds);
  }

  write(providerId: SubscriptionProviderId, credentials: OAuthCredentials): void {
    this.repo.upsertRegistryProvider({
      providerId: registryId(providerId),
      connectedVia: 'subscription-oauth',
      state: 'connected',
      creds: { ...credentials },
    });
  }

  clear(providerId: SubscriptionProviderId): void {
    this.repo.deleteRegistryProvider(registryId(providerId));
  }
}

/**
 * Build the production store, bound to the app database. Async only because
 * acquiring the SQLite driver is async; the returned store's methods are sync.
 */
export async function getSubscriptionCredStore(): Promise<SubscriptionCredStore> {
  const { getDatabase } = await import('@process/services/database');
  const { ProviderRepository: Repo } = await import('@process/providers/storage/ProviderRepository');
  const db = await getDatabase();
  return new ProviderRepositoryCredStore(new Repo(db.getDriver()));
}
