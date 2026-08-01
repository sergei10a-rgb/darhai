/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * C2 card DOM test: the one-click "Install & run OmniRoute for me" action drives
 * install -> start -> open-dashboard (in that order) and reveals the "Open
 * dashboard" + "Stop" controls once running. Also covers the no-runtime path
 * (Node.js hint + no start attempt). ipcBridge and i18n are mocked - no Electron.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Message: { success: vi.fn(), error: vi.fn(), loading: vi.fn(() => vi.fn()) },
  };
});

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  runtimeStatus: vi.fn(),
  setConfig: vi.fn(),
  testConnection: vi.fn(),
  install: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  openDashboard: vi.fn(),
  openExternal: vi.fn(),
  onRuntimeStatus: vi.fn(() => vi.fn()),
  onInstallProgress: vi.fn(() => vi.fn()),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    omnirouteGateway: {
      getConfig: { invoke: (...a: unknown[]) => mocks.getConfig(...a) },
      runtimeStatus: { invoke: (...a: unknown[]) => mocks.runtimeStatus(...a) },
      setConfig: { invoke: (...a: unknown[]) => mocks.setConfig(...a) },
      testConnection: { invoke: (...a: unknown[]) => mocks.testConnection(...a) },
      install: { invoke: (...a: unknown[]) => mocks.install(...a) },
      start: { invoke: (...a: unknown[]) => mocks.start(...a) },
      stop: { invoke: (...a: unknown[]) => mocks.stop(...a) },
      openDashboard: { invoke: (...a: unknown[]) => mocks.openDashboard(...a) },
      onRuntimeStatus: { on: (cb: unknown) => mocks.onRuntimeStatus(cb) },
      onInstallProgress: { on: (cb: unknown) => mocks.onInstallProgress(cb) },
    },
    shell: {
      openExternal: { invoke: (...a: unknown[]) => mocks.openExternal(...a) },
    },
  },
}));

import OmniRouteGatewayCard from '@renderer/pages/settings/ModelsSettings/components/OmniRouteGatewayCard';

const RUNNING = {
  state: 'running',
  port: 20128,
  dashboardUrl: 'http://localhost:20128',
  runtime: 'bun',
  needsRuntime: false,
  owned: true,
};

beforeEach(() => {
  mocks.getConfig.mockResolvedValue({ enabled: false, baseUrl: 'http://localhost:20128/v1', hasApiKey: false });
  mocks.runtimeStatus.mockResolvedValue({
    state: 'idle',
    port: null,
    dashboardUrl: null,
    runtime: null,
    needsRuntime: false,
  });
  mocks.openDashboard.mockResolvedValue({ ok: true });
  mocks.openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OmniRouteGatewayCard - one-click install + run', () => {
  it('renders the install button and preserves the advanced BYO fields', async () => {
    render(<OmniRouteGatewayCard />);
    expect(await screen.findByTestId('omniroute-gateway-install-run')).toBeTruthy();
    // Advanced / bring-your-own manual path is still present.
    expect(screen.getByTestId('omniroute-gateway-baseurl')).toBeTruthy();
    expect(screen.getByTestId('omniroute-gateway-apikey')).toBeTruthy();
  });

  it('runs install -> start -> open-dashboard and reveals the dashboard + stop controls', async () => {
    mocks.install.mockResolvedValue({
      state: 'installed',
      port: null,
      dashboardUrl: null,
      runtime: 'bun',
      needsRuntime: false,
    });
    mocks.start.mockResolvedValue(RUNNING);

    render(<OmniRouteGatewayCard />);
    const button = await screen.findByTestId('omniroute-gateway-install-run');
    fireEvent.click(button);

    await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.openDashboard).toHaveBeenCalledTimes(1));

    // Once running, the "Open dashboard" + "Stop" controls appear.
    expect(await screen.findByTestId('omniroute-gateway-open-dashboard')).toBeTruthy();
    expect(screen.getByTestId('omniroute-gateway-stop')).toBeTruthy();
  });

  it('shows the Node.js hint and never attempts start when no runtime is available', async () => {
    mocks.install.mockResolvedValue({
      state: 'error',
      port: null,
      dashboardUrl: null,
      runtime: null,
      needsRuntime: true,
      error: 'no-runtime',
    });

    render(<OmniRouteGatewayCard />);
    fireEvent.click(await screen.findByTestId('omniroute-gateway-install-run'));

    await waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('omniroute-gateway-install-node')).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();

    // The Node.js link opens nodejs.org via the shell bridge.
    fireEvent.click(screen.getByTestId('omniroute-gateway-install-node'));
    await waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith('https://nodejs.org'));
  });
});

/**
 * REGRESSION for the refuted "stays opt-in" claim. Running a server is not
 * consent to relay prompts through third parties: the card must never flip its
 * own switch, must never write config off a start, and must say out loud that
 * the relay is still off.
 */
describe('OmniRouteGatewayCard - running is not consent', () => {
  it('leaves the opt-in switch OFF after a successful install + run, and says so', async () => {
    mocks.install.mockResolvedValue({ ...RUNNING, state: 'installed', port: null, dashboardUrl: null, owned: false });
    mocks.start.mockResolvedValue(RUNNING);

    render(<OmniRouteGatewayCard />);
    fireEvent.click(await screen.findByTestId('omniroute-gateway-install-run'));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));

    const toggle = await screen.findByTestId('omniroute-gateway-switch');
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(mocks.setConfig).not.toHaveBeenCalled();
    expect(await screen.findByTestId('omniroute-gateway-enable-hint')).toBeTruthy();
  });

  it('labels an adopted server as one Darhai did not start', async () => {
    mocks.runtimeStatus.mockResolvedValue({ ...RUNNING, owned: false });
    render(<OmniRouteGatewayCard />);
    expect(await screen.findByTestId('omniroute-gateway-external-note')).toBeTruthy();
  });

  it('warns about OmniRoute’s own dashboard password before the user meets it', async () => {
    render(<OmniRouteGatewayCard />);
    expect(await screen.findByTestId('omniroute-gateway-dashboard-password-note')).toBeTruthy();
  });
});
