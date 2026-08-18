/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ToS gate is the safety-critical piece: the feature must be OFF by default
 * and refuse a login unless BOTH `enabled` and `disclosureAcknowledged` are true.
 * These tests assert the default is closed and that flipping EITHER flag off is
 * caught with the correct machine-readable reason - i.e. the gate would fail red
 * if someone loosened it to an OR.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUBSCRIPTION_OAUTH_GATE,
  SubscriptionLoginNotAllowedError,
  assertSubscriptionLoginAllowed,
  isSubscriptionLoginAllowed,
} from '@process/services/completion/subscriptionOAuth/disclosure';

describe('subscription OAuth gate', () => {
  it('defaults to fully closed', () => {
    expect(DEFAULT_SUBSCRIPTION_OAUTH_GATE).toEqual({ enabled: false, disclosureAcknowledged: false });
    expect(isSubscriptionLoginAllowed(DEFAULT_SUBSCRIPTION_OAUTH_GATE)).toBe(false);
  });

  it('allows a login only when enabled AND disclosure acknowledged', () => {
    expect(isSubscriptionLoginAllowed({ enabled: true, disclosureAcknowledged: true })).toBe(true);
    expect(() => assertSubscriptionLoginAllowed({ enabled: true, disclosureAcknowledged: true })).not.toThrow();
  });

  it('throws "disabled" when the feature is off (even if disclosure accepted)', () => {
    try {
      assertSubscriptionLoginAllowed({ enabled: false, disclosureAcknowledged: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SubscriptionLoginNotAllowedError);
      expect((err as SubscriptionLoginNotAllowedError).reason).toBe('disabled');
    }
  });

  it('throws "disclosure-not-acknowledged" when enabled but not accepted', () => {
    try {
      assertSubscriptionLoginAllowed({ enabled: true, disclosureAcknowledged: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SubscriptionLoginNotAllowedError).reason).toBe('disclosure-not-acknowledged');
    }
  });

  it('reports disabled before disclosure when both are missing', () => {
    try {
      assertSubscriptionLoginAllowed({ enabled: false, disclosureAcknowledged: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SubscriptionLoginNotAllowedError).reason).toBe('disabled');
    }
  });
});
