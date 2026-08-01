/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * OmniRoute-gateway IPC bridge (Phase 7b) - read/write the opt-in gateway
 * config and probe the user's own gateway. Mirrors the compression / routing
 * bridges: a thin local pair over the service accessors.
 *
 * `set-config` + `test-connection` are remote-denied in the bridge allowlist
 * (provider registration / credential write / host-side outbound fetch);
 * `get-config` stays readable and never discloses the stored API key. The
 * local renderer contract is still untrusted input crossing a process
 * boundary, so every field is narrowed here before it reaches the service.
 *
 * C2 (one-click auto-install + run): `install` / `start` / `stop` /
 * `open-dashboard` drive the {@link omnirouteRuntime} manager (host-side
 * install/exec/open, all remote-denied); `runtime-status` is a readable
 * snapshot. NONE of them touch the gateway service: running a local server and
 * ENABLING an external relay are different decisions, and only `set-config`
 * (the user's own Settings switch) makes the second one. The USER connects
 * providers themselves in OmniRoute's dashboard, and the USER turns the relay
 * on in Darhai.
 */

import { ipcBridge } from '@/common';
import {
  applyOmnirouteGatewayConfig,
  getOmnirouteGatewayConfigView,
  testOmnirouteGatewayConnection,
} from '@process/services/omnirouteGateway/omnirouteGatewayService';
import {
  omnirouteRuntime,
  registerOmnirouteQuitReaper,
} from '@process/services/omnirouteGateway/omnirouteRuntimeSingleton';

/** Cap on any string handed across the boundary (chars). */
const MAX_FIELD_LEN = 2048;

/** A trimmed string capped at {@link MAX_FIELD_LEN}, or '' when not a string. */
function safeString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LEN) : '';
}

export function initOmnirouteGatewayBridge(): void {
  // A spawned OmniRoute must not outlive the app. The async before-quit cleanup
  // in src/index.ts is not enough on its own - Electron never awaits it - so the
  // runtime also installs a BLOCKING reaper here, at the one place guaranteed to
  // run once per app start.
  registerOmnirouteQuitReaper();

  ipcBridge.omnirouteGateway.getConfig.provider(async () => getOmnirouteGatewayConfigView());

  ipcBridge.omnirouteGateway.setConfig.provider(async ({ enabled, baseUrl, apiKey }) => {
    return applyOmnirouteGatewayConfig({
      enabled: enabled === true,
      baseUrl: safeString(baseUrl),
      // undefined keeps the stored key; a present string (even '') replaces it.
      ...(apiKey !== undefined ? { apiKey: safeString(apiKey) } : {}),
    });
  });

  ipcBridge.omnirouteGateway.testConnection.provider(async ({ baseUrl, apiKey }) => {
    return testOmnirouteGatewayConnection(safeString(baseUrl), apiKey !== undefined ? safeString(apiKey) : undefined);
  });

  // ── C2: one-click auto-install + run ──────────────────────────────────────

  ipcBridge.omnirouteGateway.install.provider(async () => omnirouteRuntime.install());

  // Starting the server NEVER enables the relay. This handler used to call
  // applyOmnirouteGatewayConfig({enabled:true}) on a green health check, which
  // meant one click on "install & run" (a button whose label promises only an
  // install) flipped the master external-relay switch, persisted it, and pushed
  // ~100 third-party relay models into every conversation picker - without the
  // user ever touching the opt-in Switch. Worse, `running` can come from a
  // server Darhai did not start (see the manager's ownership rule), so a
  // stranger's listener on port 20128 was enough to turn the relay on.
  //
  // The switch is the ONLY thing that enables the relay, and it is the user's.
  // Anything the card needs after a start is a hint, not a config write.
  ipcBridge.omnirouteGateway.start.provider(async () => omnirouteRuntime.start());

  ipcBridge.omnirouteGateway.stop.provider(async () => omnirouteRuntime.stop());

  ipcBridge.omnirouteGateway.runtimeStatus.provider(async () => omnirouteRuntime.getStatus());

  ipcBridge.omnirouteGateway.openDashboard.provider(async () => omnirouteRuntime.openDashboard());
}
