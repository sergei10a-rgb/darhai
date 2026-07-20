/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Deep Research (Odysseus assimilation "deep research"). A run spends the user's
 * search + LLM keys and makes many outbound calls, and cancel stops a run. A
 * REMOTE (paired-device WebSocket) caller must never drive or stop a run - only
 * the trusted local user. The read verbs (research.get-run / research.list-runs)
 * follow the cron read policy and stay allowed.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives each as `subscribe-<key>`.
 */
describe('isAllowedForRemote - research run controls denied for remote callers', () => {
  const DENIED = ['research.start', 'research.cancel'];

  it.each(DENIED)('denies subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read verbs (research.get-run / research.list-runs) for remote callers', () => {
    expect(isAllowedForRemote('subscribe-research.get-run')).toBe(true);
    expect(isAllowedForRemote('subscribe-research.list-runs')).toBe(true);
  });
});
