/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * OmniRoute-gateway (Phase 7b) remote-caller policy. `set-config` flips the
 * external relay on/off, registers a provider, and stores a credential;
 * `test-connection` makes the HOST fetch a caller-supplied URL. A paired-device
 * WebSocket caller must never reach either - only the trusted local user opts
 * into the relay through the disclosure card. The read-only `get-config` stays
 * allowed (it exposes enabled/baseUrl/hasApiKey, never the key itself).
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives them as `subscribe-<key>`.
 */
describe('isAllowedForRemote - omniroute-gateway policy', () => {
  it('denies subscribe-omniroute-gateway.set-config', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.set-config')).toBe(false);
  });

  it('denies subscribe-omniroute-gateway.test-connection', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.test-connection')).toBe(false);
  });

  it('allows the read-only subscribe-omniroute-gateway.get-config', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.get-config')).toBe(true);
  });

  // C2 one-click runtime: install runs a host-side global package install,
  // start/stop spawn/kill a Next.js server on the host, and open-dashboard opens
  // a browser URL. A paired-device WebSocket caller must never drive any of
  // these host-side install/exec/open verbs.
  it('denies subscribe-omniroute-gateway.install', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.install')).toBe(false);
  });

  it('denies subscribe-omniroute-gateway.start', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.start')).toBe(false);
  });

  it('denies subscribe-omniroute-gateway.stop', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.stop')).toBe(false);
  });

  it('denies subscribe-omniroute-gateway.open-dashboard', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.open-dashboard')).toBe(false);
  });

  it('allows the read-only subscribe-omniroute-gateway.runtime-status', () => {
    expect(isAllowedForRemote('subscribe-omniroute-gateway.runtime-status')).toBe(true);
  });
});
