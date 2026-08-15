/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * The llama.cpp runtime providers must NOT be reachable by a remote
 * (paired-device WebSocket) caller.
 *
 * `llamaRuntime.install` DOWNLOADS AN EXECUTABLE from a release feed, and
 * `cookbook.serve` then SPAWNS it - together that is remote arbitrary-binary
 * install plus exec, the worst class on this bridge. `plan` is denied with it
 * because it makes the host reach the network on the caller's say-so, and
 * `status` because it discloses host install paths and which release is on
 * disk. The whole `llamaRuntime.` namespace is prefix-denied, so the local
 * Model Advisor is unaffected while every remote WS call is blocked - the same
 * shape as the `cookbook.` denial it completes.
 *
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - llama.cpp runtime providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'llamaRuntime.status',
    'llamaRuntime.plan',
    'llamaRuntime.install',
    'llamaRuntime.cancel',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows an unrelated read verb, so the deny is scoped and not blanket', () => {
    expect(isAllowedForRemote('subscribe-conversation.get-workspace')).toBe(true);
  });
});
