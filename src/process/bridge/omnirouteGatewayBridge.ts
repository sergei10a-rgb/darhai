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
 */

import { ipcBridge } from '@/common';
import {
  applyOmnirouteGatewayConfig,
  getOmnirouteGatewayConfigView,
  testOmnirouteGatewayConnection,
} from '@process/services/omnirouteGateway/omnirouteGatewayService';

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
}
