/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider registry and the single gated entry point for a subscription login.
 * Every login MUST go through {@link startSubscriptionLogin}, which enforces the
 * ToS gate before touching any provider flow and persists the result through the
 * caller-supplied encrypted store. This is the mechanical guarantee that the
 * feature stays off-by-default and disclosure-gated.
 */

import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';
import { assertSubscriptionLoginAllowed } from './disclosure';
import { anthropicSubscriptionProvider } from './providers/anthropic';
import { chatgptSubscriptionProvider } from './providers/chatgpt';
import { githubCopilotSubscriptionProvider } from './providers/githubCopilot';
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  SubscriptionCredStore,
  SubscriptionOAuthGate,
  SubscriptionOAuthProvider,
} from './types';

const PROVIDERS: readonly SubscriptionOAuthProvider[] = [
  anthropicSubscriptionProvider,
  chatgptSubscriptionProvider,
  githubCopilotSubscriptionProvider,
];

const registry = new Map<SubscriptionProviderId, SubscriptionOAuthProvider>(PROVIDERS.map((p) => [p.id, p]));

/** Look up a provider flow by id, or `undefined` when unknown. */
export function getSubscriptionOAuthProvider(id: SubscriptionProviderId): SubscriptionOAuthProvider | undefined {
  return registry.get(id);
}

/** All registered provider flows. */
export function getSubscriptionOAuthProviders(): SubscriptionOAuthProvider[] {
  return [...registry.values()];
}

/**
 * Run a subscription login end-to-end: enforce the ToS gate, run the provider's
 * OAuth flow, and persist the returned credentials encrypted. Throws
 * {@link SubscriptionLoginNotAllowedError} before any network/browser activity
 * when the gate is closed, and a plain `Error` for an unknown provider id.
 */
export async function startSubscriptionLogin(params: {
  providerId: SubscriptionProviderId;
  gate: SubscriptionOAuthGate;
  store: SubscriptionCredStore;
  callbacks: OAuthLoginCallbacks;
}): Promise<OAuthCredentials> {
  // Gate first - nothing (no port bind, no browser, no fetch) happens if closed.
  assertSubscriptionLoginAllowed(params.gate);

  const provider = getSubscriptionOAuthProvider(params.providerId);
  if (!provider) throw new Error(`Unknown subscription provider: ${params.providerId}`);

  const credentials = await provider.login(params.callbacks);
  params.store.write(params.providerId, credentials);
  return credentials;
}
