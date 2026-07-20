/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * The Compare feature (Odysseus #6) runs one prompt through several models at
 * once. `compare.run` spends tokens and makes outbound provider calls, so a
 * remote (paired-device WebSocket) caller must NOT be able to drive it - the
 * fan-out amplifies into token spend + provider load. Only the trusted local
 * user compares models; the local renderer UI is unaffected.
 *
 * The wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - compare.run denied for remote callers', () => {
  it('denies subscribe-compare.run', () => {
    expect(isAllowedForRemote('subscribe-compare.run')).toBe(false);
  });
});
