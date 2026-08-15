/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * ECC IPC bridge - GateGuard toggle + install status for the bundled ECC
 * agent harness, and the launch-time seeding kick-off.
 */

import log from 'electron-log';
import { ipcBridge } from '@/common';
import { getEccStatus, seedEccIfAbsent, setGateGuardEnabled } from '@process/services/eccSystemService';

/** Delay before background seeding so app launch stays snappy. */
const SEED_DELAY_MS = 7_000;

export function initEccBridge(): void {
  ipcBridge.ecc.getStatus.provider(async () => getEccStatus());

  ipcBridge.ecc.setGateGuard.provider(async ({ enabled }) => {
    await setGateGuardEnabled(enabled === true);
    return { ok: true };
  });

  // Install the bundled harness in the background on every launch; the seed
  // is idempotent and skips itself whenever any existing install is found.
  setTimeout(() => {
    void seedEccIfAbsent().catch((err: unknown) => {
      log.warn('[ecc-bridge] background seed failed', { err });
    });
  }, SEED_DELAY_MS);
}
