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
 * snapshot. Only `start` touches the gateway service: once the spawned server
 * is HEALTHY, it registers Darhai's OWN `omniroute-gateway` provider at the
 * local endpoint (applyOmnirouteGatewayConfig). That points Darhai's gateway at
 * the user's local OmniRoute - it never connects a free provider on the user's
 * behalf. The USER connects providers themselves in OmniRoute's dashboard.
 */

import { ipcBridge } from '@/common';
import { OMNIROUTE_GATEWAY_DEFAULT_BASE_URL } from '@/common/types/omnirouteGateway';
import {
  applyOmnirouteGatewayConfig,
  getOmnirouteGatewayConfigView,
  testOmnirouteGatewayConnection,
} from '@process/services/omnirouteGateway/omnirouteGatewayService';
import { omnirouteRuntime } from '@process/services/omnirouteGateway/omnirouteRuntimeSingleton';

/** Cap on any string handed across the boundary (chars). */
const MAX_FIELD_LEN = 2048;

/** A trimmed string capped at {@link MAX_FIELD_LEN}, or '' when not a string. */
function safeString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LEN) : '';
}

export function initOmnirouteGatewayBridge(): void {
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

  ipcBridge.omnirouteGateway.start.provider(async () => {
    const status = await omnirouteRuntime.start();
    // Only after the spawned server is HEALTHY do we register Darhai's OWN
    // gateway provider pointing at the user's local OmniRoute. This does NOT
    // connect any free provider - that choice (and its ToS/relay liability)
    // stays entirely the user's, done in OmniRoute's own dashboard. Best-effort:
    // a registration hiccup must not turn a running server into a failure.
    if (status.state === 'running') {
      try {
        await applyOmnirouteGatewayConfig({ enabled: true, baseUrl: OMNIROUTE_GATEWAY_DEFAULT_BASE_URL });
      } catch (err) {
        console.error('[omnirouteGateway] post-start provider registration failed:', err);
      }
    }
    return status;
  });

  ipcBridge.omnirouteGateway.stop.provider(async () => omnirouteRuntime.stop());

  ipcBridge.omnirouteGateway.runtimeStatus.provider(async () => omnirouteRuntime.getStatus());

  ipcBridge.omnirouteGateway.openDashboard.provider(async () => omnirouteRuntime.openDashboard());
}
