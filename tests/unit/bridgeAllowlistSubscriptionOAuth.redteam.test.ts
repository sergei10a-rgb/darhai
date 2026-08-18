/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Subscription OAuth (sign in with a Claude Max / ChatGPT / Copilot
 * subscription) providers must NOT be reachable by a remote (paired-device
 * WebSocket) caller. `start-login` opens a browser and mints a stored
 * credential, `set-gate` flips a persisted ToS policy, and `disconnect` deletes
 * a credential - the same login/credential-mutation class as `mcp.login-oauth`
 * and `modelRegistry.connect` (both already denied). Even the reads are denied:
 * `get-status` discloses which subscriptions are connected on the host. The
 * whole `subscriptionOAuth.` namespace is prefix-denied, so the local renderer
 * UI is unaffected while every remote WS call is blocked.
 *
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - subscriptionOAuth providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'subscriptionOAuth.get-providers',
    'subscriptionOAuth.get-gate',
    'subscriptionOAuth.set-gate',
    'subscriptionOAuth.start-login',
    'subscriptionOAuth.get-status',
    'subscriptionOAuth.disconnect',
    'subscriptionOAuth.submit-prompt',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  // Counter-check: the denylist is not a blanket "deny everything" bug. A
  // read the paired WebUI legitimately needs must still pass.
  it('still allows an unrelated read (conversation.get-chat-list)', () => {
    expect(isAllowedForRemote('subscribe-conversation.get-chat-list')).toBe(true);
  });
});
