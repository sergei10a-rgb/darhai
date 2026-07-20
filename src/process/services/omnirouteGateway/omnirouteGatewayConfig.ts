/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read/write the persisted OmniRoute-gateway opt-in config. Single source of
 * truth for the gateway service and the Settings bridge, mirroring the
 * compression-mode accessor pair (`getCompressionMode` / `setCompressionMode`).
 *
 * Default (absent config) is DISABLED with the local default endpoint - owner
 * condition 1: Darhai never enables the external relay on its own; only an
 * explicit user opt-in through the Settings card flips `enabled`. Reads are
 * tolerant of a not-yet-ready store: any failure degrades to the disabled
 * default.
 */

import type { OmnirouteGatewayConfig } from '@/common/types/omnirouteGateway';
import { OMNIROUTE_GATEWAY_DEFAULT_BASE_URL } from '@/common/types/omnirouteGateway';
import { ProcessConfig } from '@process/utils/initStorage';

/** The safe default applied when nothing is configured: relay OFF. */
export const DEFAULT_OMNIROUTE_GATEWAY_CONFIG: OmnirouteGatewayConfig = {
  enabled: false,
  baseUrl: OMNIROUTE_GATEWAY_DEFAULT_BASE_URL,
  apiKey: '',
};

/**
 * Normalize a user-typed gateway base URL: trimmed, `http(s)` only, no
 * trailing slashes. Returns `null` when the value does not parse as an http(s)
 * URL. Any URL the user confirmed is acceptable (it is THEIR gateway - owner
 * condition 4), but a non-URL must never reach `fetch`.
 */
export function normalizeGatewayBaseUrl(raw: string): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Current gateway config from the store, defaulting to disabled on failure. */
export async function getOmnirouteGatewayConfig(): Promise<OmnirouteGatewayConfig> {
  try {
    const [enabled, baseUrl, apiKey] = await Promise.all([
      ProcessConfig.get('omnirouteGateway.enabled'),
      ProcessConfig.get('omnirouteGateway.baseUrl'),
      ProcessConfig.get('omnirouteGateway.apiKey'),
    ]);
    return {
      enabled: enabled === true,
      baseUrl:
        typeof baseUrl === 'string' && normalizeGatewayBaseUrl(baseUrl) !== null
          ? (normalizeGatewayBaseUrl(baseUrl) as string)
          : OMNIROUTE_GATEWAY_DEFAULT_BASE_URL,
      apiKey: typeof apiKey === 'string' ? apiKey : '',
    };
  } catch {
    return { ...DEFAULT_OMNIROUTE_GATEWAY_CONFIG };
  }
}

/** Persist the full gateway config (already validated by the caller). */
export async function setOmnirouteGatewayConfig(config: OmnirouteGatewayConfig): Promise<void> {
  await ProcessConfig.set('omnirouteGateway.enabled', config.enabled === true);
  await ProcessConfig.set('omnirouteGateway.baseUrl', config.baseUrl);
  await ProcessConfig.set('omnirouteGateway.apiKey', config.apiKey);
}
