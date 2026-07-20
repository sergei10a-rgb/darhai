/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Routing IPC bridge - read/write the model-routing strategy that
 * `oneShotComplete` applies when the caller does not pin a model. Mirrors the
 * compression bridge: a thin local config read/write pair.
 */

import { ipcBridge } from '@/common';
import { getRoutingStrategy, setRoutingStrategy } from '@process/services/completion/routingStrategy';

export function initRoutingBridge(): void {
  ipcBridge.routing.getStrategy.provider(async () => getRoutingStrategy());

  ipcBridge.routing.setStrategy.provider(async ({ strategy }) => {
    await setRoutingStrategy(strategy);
    return { ok: true };
  });
}
