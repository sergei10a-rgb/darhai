/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Memory auto-extract (Odysseus #2, native). Enabling auto-extraction turns on
 * auto-writing durable facts from conversations into the user's persistent
 * memory - a persisted config mutation only the trusted local user may drive.
 * The set-verb must be denied to a remote (paired-device WebSocket) caller,
 * while the read stays allowed for the paired UI.
 *
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - memory auto-extract toggle', () => {
  it('denies the set-verb for remote callers', () => {
    expect(isAllowedForRemote('subscribe-memory.set-auto-extract-enabled')).toBe(false);
  });

  it('allows the read verb for remote callers', () => {
    expect(isAllowedForRemote('subscribe-memory.get-auto-extract-enabled')).toBe(true);
  });
});
