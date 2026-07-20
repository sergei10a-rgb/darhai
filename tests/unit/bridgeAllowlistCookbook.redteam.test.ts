/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Cookbook serve (download + auto-serve local models) providers must NOT be
 * reachable by a remote (paired-device WebSocket) caller. `cookbook.download`
 * pulls a multi-GB GGUF and `cookbook.serve` spawns a llama-server / runs
 * `ollama pull` on the host - a host-side DoS/exec class only the trusted local
 * user may drive. Even the read verbs (list-downloads / serve-status /
 * detect-backend) are denied for consistency (they expose host install +
 * model-cache state). The whole `cookbook.` namespace is prefix-denied, so the
 * local renderer UI is unaffected while every remote WS call is blocked.
 *
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - cookbook serve providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'cookbook.list-downloads',
    'cookbook.download',
    'cookbook.cancel-download',
    'cookbook.serve',
    'cookbook.stop-serve',
    'cookbook.serve-status',
    'cookbook.detect-backend',
    'cookbook.backend-options',
    'cookbook.locate-backend',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });
});
