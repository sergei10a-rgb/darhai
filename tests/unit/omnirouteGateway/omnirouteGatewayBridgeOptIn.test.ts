/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * REGRESSION: "the OmniRoute gateway stays opt-in / off unless the user enables
 * it" was REFUTED on a live fresh profile. `omniroute-gateway.start` called
 * `applyOmnirouteGatewayConfig({enabled:true, ...})` on any green health check,
 * so pressing "Install & run OmniRoute for me" - a button that promises an
 * install, sitting under a disclosure that says Darhai installs nothing - moved
 * the persisted master relay switch from false to true and pushed ~100
 * third-party relay models into every conversation picker. Because "running"
 * can also come from a server Darhai never started, a stranger's listener on
 * port 20128 was enough to trigger it.
 *
 * The invariant under test: NOTHING in the runtime lifecycle
 * (install/start/stop/open-dashboard/runtime-status) may write gateway config.
 * Only `set-config` - the user's own Settings switch - may.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmnirouteRuntimeStatus } from '@/common/types/omnirouteGateway';

const RUNNING: OmnirouteRuntimeStatus = {
  state: 'running',
  port: 20128,
  dashboardUrl: 'http://localhost:20128',
  runtime: 'node',
  needsRuntime: false,
  owned: true,
};

/** Bridge provider keys the module registers. */
const PROVIDER_KEYS = [
  'getConfig',
  'setConfig',
  'testConnection',
  'install',
  'start',
  'stop',
  'runtimeStatus',
  'openDashboard',
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number];
type Handler = (payload?: unknown) => Promise<unknown>;

const handlers = new Map<ProviderKey, Handler>();

const serviceMocks = {
  applyOmnirouteGatewayConfig: vi.fn(async () => ({ ok: true as const })),
  getOmnirouteGatewayConfigView: vi.fn(async () => ({ enabled: false, baseUrl: '', hasApiKey: false })),
  testOmnirouteGatewayConnection: vi.fn(async () => ({ ok: true as const, modelCount: 0 })),
};

const registerQuitReaper = vi.fn();

const runtimeMocks = {
  install: vi.fn(async () => RUNNING),
  start: vi.fn(async () => RUNNING),
  stop: vi.fn(async () => ({ ...RUNNING, state: 'stopped' as const, port: null, owned: false })),
  getStatus: vi.fn(() => RUNNING),
  openDashboard: vi.fn(async () => ({ ok: true })),
};

beforeEach(async () => {
  handlers.clear();
  vi.resetModules();
  vi.clearAllMocks();

  const omnirouteGateway = Object.fromEntries(
    PROVIDER_KEYS.map((key) => [key, { provider: (fn: Handler) => handlers.set(key, fn) }])
  );
  vi.doMock('@/common', () => ({ ipcBridge: { omnirouteGateway } }));
  vi.doMock('@process/services/omnirouteGateway/omnirouteGatewayService', () => serviceMocks);
  vi.doMock('@process/services/omnirouteGateway/omnirouteRuntimeSingleton', () => ({
    omnirouteRuntime: runtimeMocks,
    registerOmnirouteQuitReaper: registerQuitReaper,
  }));

  const mod = await import('@process/bridge/model/omnirouteGatewayBridge');
  mod.initOmnirouteGatewayBridge();
});

afterEach(() => {
  vi.doUnmock('@/common');
  vi.doUnmock('@process/services/omnirouteGateway/omnirouteGatewayService');
  vi.doUnmock('@process/services/omnirouteGateway/omnirouteRuntimeSingleton');
});

describe('omnirouteGatewayBridge - the relay stays the user’s switch', () => {
  it('installs the blocking quit reaper exactly once at bridge init', () => {
    expect(registerQuitReaper).toHaveBeenCalledTimes(1);
  });

  it('start returns the runtime status WITHOUT enabling the relay', async () => {
    const status = await handlers.get('start')?.();

    expect(runtimeMocks.start).toHaveBeenCalledTimes(1);
    expect(status).toEqual(RUNNING);
    expect(serviceMocks.applyOmnirouteGatewayConfig).not.toHaveBeenCalled();
  });

  it('no runtime-lifecycle call writes gateway config', async () => {
    for (const key of ['install', 'start', 'stop', 'runtimeStatus', 'openDashboard'] as const) {
      await handlers.get(key)?.();
    }
    expect(serviceMocks.applyOmnirouteGatewayConfig).not.toHaveBeenCalled();
  });

  it('the Settings switch is still the one path that CAN enable it', async () => {
    await handlers.get('setConfig')?.({ enabled: true, baseUrl: 'http://localhost:20128/v1' });
    expect(serviceMocks.applyOmnirouteGatewayConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, baseUrl: 'http://localhost:20128/v1' })
    );
  });

  it('a non-true enabled value can never be coerced into an opt-in', async () => {
    await handlers.get('setConfig')?.({ enabled: 'yes', baseUrl: 'http://localhost:20128/v1' });
    expect(serviceMocks.applyOmnirouteGatewayConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
