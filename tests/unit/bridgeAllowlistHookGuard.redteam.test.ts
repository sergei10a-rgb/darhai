/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Native pre-tool guard (Phase 3) remote-caller policy. `set-enabled` flips the
 * guard that gates AGENT TOOL EXECUTION at the WCore / ACP approval seams;
 * disabling it drops the destructive-command DENY floor. A paired-device
 * WebSocket caller must never reach it - only the trusted local user toggles it
 * from Settings. The read-only `get-status` stays allowed.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives them as `subscribe-<key>`.
 */
describe('isAllowedForRemote - hookGuard policy', () => {
  it('denies subscribe-hookGuard.set-enabled', () => {
    expect(isAllowedForRemote('subscribe-hookGuard.set-enabled')).toBe(false);
  });

  it('allows the read-only subscribe-hookGuard.get-status', () => {
    expect(isAllowedForRemote('subscribe-hookGuard.get-status')).toBe(true);
  });
});
