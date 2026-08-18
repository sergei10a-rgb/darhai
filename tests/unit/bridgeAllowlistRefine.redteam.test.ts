/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * The /refine rule providers must NOT be reachable by a remote (paired-device
 * WebSocket) caller. `apply-rules` and `rollback` rewrite the user's on-disk
 * global rule set (the same hard-mutation class as `memory.update-entry` /
 * `memory.delete-entry`, both already denied), and `list-rules` discloses the
 * local user's rules. The whole `refine.` namespace is prefix-denied, so the
 * local Memory settings UI is unaffected while every remote WS call is blocked.
 */
describe('isAllowedForRemote - refine providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = ['refine.list-rules', 'refine.apply-rules', 'refine.rollback'];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  // Counter-check: an unrelated allowed read must still pass, proving the gate
  // is a targeted denylist and not a blanket block.
  it('still allows an unrelated read (memory.list-entries)', () => {
    expect(isAllowedForRemote('subscribe-memory.list-entries')).toBe(true);
  });
});
