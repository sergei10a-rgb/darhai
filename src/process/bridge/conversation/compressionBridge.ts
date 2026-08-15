/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Compression IPC bridge - read/write the prompt token-compression mode that
 * `oneShotComplete` applies before every background model call. Mirrors the ECC
 * GateGuard bridge: a thin local config read/write pair.
 */

import { ipcBridge } from '@/common';
import { getCompressionMode, setCompressionMode } from '@process/services/completion/compressionMode';

export function initCompressionBridge(): void {
  ipcBridge.compression.getMode.provider(async () => getCompressionMode());

  ipcBridge.compression.setMode.provider(async ({ mode }) => {
    await setCompressionMode(mode);
    return { ok: true };
  });
}
