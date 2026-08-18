/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider-flow contracts, ported/adapted from prime-agent
 * (`packages/ai/src/utils/oauth/types.ts`, MIT, (c) Mario Zechner + Prime Intellect).
 */

import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';

/**
 * Persisted OAuth credentials for one subscription provider. `expires` is an
 * absolute epoch-ms deadline (already adjusted for the provider's early-refresh
 * skew at write time). Extra provider-specific fields (e.g. Copilot's
 * `enterpriseUrl`, ChatGPT's `accountId`) ride along via the index signature.
 */
export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

/** Info handed to the UI when a browser step is required. */
export type OAuthAuthInfo = { url: string; instructions?: string };

/** A free-text prompt the flow may ask the user (e.g. paste the redirect URL). */
export type OAuthPrompt = { message: string; placeholder?: string; allowEmpty?: boolean };

/**
 * Callbacks the host (main process / IPC bridge) supplies so a headless flow can
 * drive the UI without importing it. Mirrors prime's shape so the ported flows
 * are drop-in.
 */
export type OAuthLoginCallbacks = {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
};

/** One subscription-OAuth provider's login/refresh/api-key surface. */
export type SubscriptionOAuthProvider = {
  readonly id: SubscriptionProviderId;
  readonly name: string;
  /** Run the login flow and return credentials to persist. */
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  /** Exchange a (possibly expired) credential set for a fresh one. */
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  /** The bearer/API-key string the completion layer sends for this provider. */
  getApiKey(credentials: OAuthCredentials): string;
};

/**
 * The user-controlled gate for the whole feature. Both flags default to `false`;
 * a login is refused unless BOTH are `true`. Kept as a plain value (not read from
 * a global) so it is trivially testable and impossible to bypass silently.
 */
export type SubscriptionOAuthGate = {
  /** The user turned the feature on. Default `false`. */
  enabled: boolean;
  /** The user saw and accepted {@link SUBSCRIPTION_OAUTH_DISCLOSURE}. Default `false`. */
  disclosureAcknowledged: boolean;
};

/**
 * Storage abstraction for encrypted credentials. The production impl is backed
 * by `ProviderRepository` (OS-keychain `safeStorage`); tests use an in-memory
 * fake. Kept narrow so neither depends on the other.
 */
export type SubscriptionCredStore = {
  read(providerId: SubscriptionProviderId): OAuthCredentials | undefined;
  write(providerId: SubscriptionProviderId, credentials: OAuthCredentials): void;
  clear(providerId: SubscriptionProviderId): void;
};
