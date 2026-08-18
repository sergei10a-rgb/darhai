/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from prime-agent's `getOAuthApiKey` (MIT, (c) Mario Zechner + Prime
 * Intellect).
 */

import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';
import { getSubscriptionOAuthProvider } from './registry';
import type { OAuthCredentials, SubscriptionCredStore } from './types';

/** The usable key material for a subscription provider at call time. */
export type SubscriptionApiKey = { apiKey: string; credentials: OAuthCredentials };

/**
 * Resolve the current API key for a connected subscription provider, refreshing
 * the token first if it has expired and persisting the refreshed credentials.
 *
 * @returns the key + credentials, or `null` when the provider has no stored
 *   credentials (i.e. the user never connected it).
 * @throws when the provider id is unknown, or when a refresh is required but
 *   fails - the caller must not fall back to a stale/absent key silently.
 */
export async function getSubscriptionApiKey(
  providerId: SubscriptionProviderId,
  store: SubscriptionCredStore
): Promise<SubscriptionApiKey | null> {
  let credentials = store.read(providerId);
  if (!credentials) return null;

  const provider = getSubscriptionOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown subscription provider: ${providerId}`);

  if (Date.now() >= credentials.expires) {
    credentials = await provider.refreshToken(credentials);
    store.write(providerId, credentials);
  }

  return { apiKey: provider.getApiKey(credentials), credentials };
}
