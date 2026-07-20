/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Email AI Triage (Odysseus assimilation "email pollers"). `sendDraft` is the
 * single verb that dispatches an email over SMTP - a human action for the trusted
 * local user only. A REMOTE (paired-device WebSocket) caller must never be able to
 * send an email on the user's behalf, so `email-triage.send-draft` is remote-denied.
 * The read verbs (email-triage.list / email-triage.get) follow the cron read policy
 * and stay allowed.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives each as `subscribe-<key>`.
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

describe('isAllowedForRemote - email-triage send denied for remote callers', () => {
  it('denies subscribe-email-triage.send-draft (the human-gated SMTP send)', () => {
    expect(isAllowedForRemote('subscribe-email-triage.send-draft')).toBe(false);
  });

  it('still allows the read verbs (email-triage.list / email-triage.get) for remote callers', () => {
    expect(isAllowedForRemote('subscribe-email-triage.list')).toBe(true);
    expect(isAllowedForRemote('subscribe-email-triage.get')).toBe(true);
  });
});
