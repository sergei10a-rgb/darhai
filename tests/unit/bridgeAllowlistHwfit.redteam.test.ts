/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Hardware-fit model advisor (hwfit) host-probe providers must NOT be reachable
 * by a remote (paired-device WebSocket) caller. `hwfit.scan-hardware` spawns
 * host processes (nvidia-smi / rocminfo / sysctl / a PowerShell WMI probe);
 * `hwfit.rank-models` falls through to scan-hardware when no hardwareOverride is
 * supplied, so it too kicks off host probes. Repeated remote invocations would
 * amplify into a host-process spawn DoS. `hwfit.catalog-size` is denied for
 * consistency (same read-only host-side surface). The local renderer UI is
 * unaffected; only remote WS callers are blocked.
 *
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - hwfit host-probe providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = ['hwfit.scan-hardware', 'hwfit.rank-models', 'hwfit.catalog-size'];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });
});
