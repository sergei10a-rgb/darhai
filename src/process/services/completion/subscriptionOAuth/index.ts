/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public barrel for the subscription-OAuth subsystem: sign into Дархай with an
 * existing Claude Max / ChatGPT / GitHub Copilot subscription instead of an API
 * key. The feature is OFF by default and gated behind a ToS disclosure - see
 * {@link ./disclosure}.
 *
 * The main-process wiring layer (IPC bridge) is expected to expose exactly two
 * operations: {@link startSubscriptionLogin} (connect) and
 * {@link getSubscriptionApiKey} (use), both taking a {@link SubscriptionCredStore}
 * from {@link getSubscriptionCredStore}.
 */

export {
  DEFAULT_SUBSCRIPTION_OAUTH_GATE,
  SubscriptionLoginNotAllowedError,
  assertSubscriptionLoginAllowed,
  isSubscriptionLoginAllowed,
  type SubscriptionGateDenialReason,
} from './disclosure';
export { getSubscriptionApiKey, type SubscriptionApiKey } from './getSubscriptionApiKey';
export { getSubscriptionOAuthProvider, getSubscriptionOAuthProviders, startSubscriptionLogin } from './registry';
export { ProviderRepositoryCredStore, coerceCredentials, getSubscriptionCredStore } from './tokenStore';
export type {
  OAuthAuthInfo,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthPrompt,
  SubscriptionCredStore,
  SubscriptionOAuthGate,
  SubscriptionOAuthProvider,
} from './types';
