/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Terms-of-Service safety gate for subscription OAuth.
 *
 * Using a Claude Max / ChatGPT / Copilot subscription's OAuth session from a
 * third-party app may conflict with that vendor's ToS. Per the project rule the
 * feature is (a) a technical port, (b) DISABLED by default, and (c) only
 * reachable after the user sees and accepts the disclosure. This module is the
 * single mechanical choke point that enforces (b) and (c): every login path goes
 * through {@link assertSubscriptionLoginAllowed}, so the gate cannot be bypassed
 * by a caller forgetting to check.
 */

import type { SubscriptionOAuthGate } from './types';

/** Reason a login was refused - lets the UI show the right remediation. */
export type SubscriptionGateDenialReason = 'disabled' | 'disclosure-not-acknowledged';

/**
 * Thrown when a subscription login is attempted while the gate is closed.
 * Carries a machine-readable {@link reason} so the caller can route to "enable
 * the feature" vs "show the disclosure" without string-matching the message.
 */
export class SubscriptionLoginNotAllowedError extends Error {
  readonly reason: SubscriptionGateDenialReason;

  constructor(reason: SubscriptionGateDenialReason) {
    super(
      reason === 'disabled'
        ? 'Subscription OAuth is disabled. The user must enable it explicitly before signing in.'
        : 'Subscription OAuth disclosure has not been acknowledged. Show the disclosure and record acceptance first.'
    );
    this.name = 'SubscriptionLoginNotAllowedError';
    this.reason = reason;
  }
}

/** The default gate: everything off. New installs never auto-enable the feature. */
export const DEFAULT_SUBSCRIPTION_OAUTH_GATE: SubscriptionOAuthGate = {
  enabled: false,
  disclosureAcknowledged: false,
};

/** Pure predicate: is a login permitted under this gate? */
export function isSubscriptionLoginAllowed(gate: SubscriptionOAuthGate): boolean {
  return gate.enabled && gate.disclosureAcknowledged;
}

/**
 * Enforce the gate. Returns normally only when the feature is enabled AND the
 * disclosure was acknowledged; otherwise throws {@link SubscriptionLoginNotAllowedError}
 * with the first failing reason (disabled is reported before disclosure).
 */
export function assertSubscriptionLoginAllowed(gate: SubscriptionOAuthGate): void {
  if (!gate.enabled) throw new SubscriptionLoginNotAllowedError('disabled');
  if (!gate.disclosureAcknowledged) throw new SubscriptionLoginNotAllowedError('disclosure-not-acknowledged');
}
