/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Native pre-tool guard IPC bridge (Phase 3) - the enabled toggle for the
 * guard that gates agent tool execution at Darhai's WCore / ACP approval
 * seams. Mirrors the ECC GateGuard bridge shape: a local config read/write
 * pair, with `set-enabled` remote-denied in the bridge allowlist.
 */

import { ipcBridge } from '@/common';
import { getHookGuardConfig, setHookGuardEnabled } from '@process/agent/guard';

export function initHookGuardBridge(): void {
  ipcBridge.hookGuard.getStatus.provider(async () => {
    const cfg = await getHookGuardConfig();
    return { enabled: cfg.enabled };
  });

  ipcBridge.hookGuard.setEnabled.provider(async ({ enabled }) => {
    await setHookGuardEnabled(enabled === true);
    return { ok: true };
  });
}
