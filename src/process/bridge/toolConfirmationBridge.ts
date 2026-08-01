/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the MCP tool-confirmation gate.
 *
 * Two providers, both thin. `respond` carries the human's press into
 * `ToolConfirmationService`, which is the ONLY place an approval can be minted;
 * `listPending` lets a reloading renderer re-draw dialogs that are still open
 * rather than stranding the tool that is waiting on them.
 *
 * `toolConfirmation.respond` is in `REMOTE_DENIED_KEYS` (see
 * `bridgeAllowlist.ts`): a paired device must never be able to press Send for
 * the person at the keyboard.
 */

import { ipcBridge } from '@/common';
import { getToolConfirmationService } from '@process/services/toolConfirmation';

export function initToolConfirmationBridge(): void {
  ipcBridge.toolConfirmation.respond.provider(async ({ requestId, approved }) => {
    // `approved === true` and nothing else. A truthy string arriving from a
    // damaged caller must read as a refusal, not as consent.
    const settled = getToolConfirmationService().respond({
      requestId: String(requestId ?? ''),
      approved: approved === true,
    });
    return { settled };
  });

  ipcBridge.toolConfirmation.listPending.provider(async () => getToolConfirmationService().listPending());
}
