/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoist mocks ---
const { mockNavigate, mockGetAvailableAgents, mockProviders, mockMcpServers, MOCK_CONFIG_PATH, mockProfiles } =
  vi.hoisted(() => ({
    mockNavigate: vi.fn(),
    mockGetAvailableAgents: vi.fn(),
    mockProviders: { value: [] as Array<{ providerId: string }> },
    mockMcpServers: { value: [] as Array<{ name: string; enabled?: boolean }> },
    // A platform-shaped absolute path, deliberately NOT `~/.wayland-core/...`:
    // the point of these assertions is that the panes print what the main
    // process reports, not a path compiled into the markup.
    MOCK_CONFIG_PATH: '/home/tester/.config/wayland-core/config.toml',
    mockProfiles: { value: [] as Array<{ name: string; active: boolean; dir?: string }> },
  }));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// i18n: return the defaultValue (the reference English string) so assertions
// read against stable copy without depending on the loaded resource bundle.
// Interpolates {{count}}, {{names}}, {{catalog}} so the rich inherited-row
// strings resolve the way they do at runtime.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown> & { defaultValue?: string }) => {
      let dv = opts?.defaultValue ?? _key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === 'defaultValue') continue;
          dv = dv.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return dv;
    },
  }),
}));

vi.mock('../../../../src/common', () => ({
  ipcBridge: {
    acpConversation: {
      getAvailableAgents: { invoke: () => mockGetAvailableAgents() },
    },
    // Engine config.toml read/write (Tools / Security / Memory / Runtime panes).
    wcoreConfig: {
      getSection: { invoke: () => Promise.resolve(undefined) },
      setSection: { invoke: () => Promise.resolve({ ok: true }) },
      // The REAL path of the active profile's config.toml. The panes used to
      // print a hardcoded `~/.wayland-core/config.toml`, which resolves to a
      // file that exists on no platform the app ships to.
      getConfigPath: { invoke: () => Promise.resolve(MOCK_CONFIG_PATH) },
    },
    // Tool-backend key presence (Services & Keys pane).
    wcoreToolKeys: {
      list: { invoke: () => Promise.resolve([]) },
      set: { invoke: () => Promise.resolve({ ok: true }) },
      delete: { invoke: () => Promise.resolve({ ok: true }) },
    },
    // Profile fs (Profiles pane).
    wcoreProfiles: {
      list: { invoke: () => Promise.resolve(mockProfiles.value) },
      create: { invoke: () => Promise.resolve({ ok: true }) },
      clone: { invoke: () => Promise.resolve({ ok: true }) },
      activate: { invoke: () => Promise.resolve({ ok: true }) },
      delete: { invoke: () => Promise.resolve({ ok: true }) },
    },
  },
}));

vi.mock('../../../../src/renderer/hooks/useModelRegistry', () => ({
  useModelRegistry: () => ({ providers: mockProviders.value }),
}));

vi.mock('../../../../src/renderer/hooks/mcp/useMcpServers', () => ({
  useMcpServers: () => ({ allMcpServers: mockMcpServers.value }),
}));

// CSS module — return the class names verbatim so queries by data attr / text work.
vi.mock('../../../../src/renderer/pages/settings/WCoreConfig/WCoreConfig.module.css', () => ({ default: {} }));
vi.mock('../../../../src/renderer/pages/settings/WCoreConfig/panes/Panes.module.css', () => ({ default: {} }));

import React from 'react';
import WCoreConfig from '../../../../src/renderer/pages/settings/WCoreConfig';

describe('WCoreConfig - Wayland Core configuration surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProviders.value = [];
    mockMcpServers.value = [];
    mockProfiles.value = [];
    mockGetAvailableAgents.mockResolvedValue({
      success: true,
      data: [{ backend: 'wcore', name: 'Darhai Core', cliPath: '/usr/local/bin/wcore' }],
    });
  });

  it('renders the seven engine rail sections (no Constitution — engine has none)', () => {
    render(<WCoreConfig />);
    const rail = screen.getByLabelText('Darhai Core');
    for (const label of [
      'Overview',
      'Services & Keys',
      'Tools',
      'Memory',
      'Security & Permissions',
      'Profiles',
      'Runtime',
    ]) {
      expect(rail.textContent).toContain(label);
    }
    // Constitution is a Desktop concept and must NOT appear in the Core rail.
    expect(rail.querySelector('[data-wcore-rail-id="constitution"]')).toBeNull();
  });

  it('defaults to the Overview pane with the inherited-from-Desktop card', () => {
    render(<WCoreConfig />);
    expect(screen.getByText('Allocated by Дархай Desktop')).toBeTruthy();
    expect(screen.getByText('Models (override)')).toBeTruthy();
    expect(screen.getAllByText('Manage in Desktop Settings').length).toBeGreaterThan(0);
  });

  it('renders the three engine status stat cards', async () => {
    render(<WCoreConfig />);
    // "Engine" also appears as the rail group label, so assert the unique
    // stat-card meta strings instead of the ambiguous labels.
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('embedded · spawned in-process')).toBeTruthy();
    expect(screen.getByText('wayland-core · pinned')).toBeTruthy();
    expect(screen.getByText('Active Profile')).toBeTruthy();
    // This used to assert the literal `~/.darhai/profiles/default`, which is
    // where the default profile does NOT live - it maps to the engine's native
    // config dir. The card now shows the resolved location; the dedicated
    // describe block below covers the cases.
    await waitFor(() => expect(screen.getByTestId('active-profile-dir').textContent).toBe(MOCK_CONFIG_PATH));
  });

  it('renders the smart-defaults "configured in the engine" strip', () => {
    render(<WCoreConfig />);
    expect(screen.getByText('Configured in the engine')).toBeTruthy();
    expect(screen.getByText('smart defaults active')).toBeTruthy();
    expect(screen.getByText('DuckDuckGo')).toBeTruthy();
  });

  it('falls back to the catalog-only model line when no providers are connected', () => {
    mockProviders.value = [];
    render(<WCoreConfig />);
    expect(screen.getByText('104 provider catalog · Allocated by Desktop · this session')).toBeTruthy();
  });

  it('shows real connected provider names + the catalog headline', () => {
    mockProviders.value = [{ providerId: 'anthropic' }, { providerId: 'openai' }];
    render(<WCoreConfig />);
    expect(screen.getByText('Anthropic, OpenAI + 104 catalog · Allocated by Desktop · this session')).toBeTruthy();
  });

  it('shows the honest MCP row (the Desktop MCP library is NOT inherited)', () => {
    mockMcpServers.value = [
      { name: 'filesystem', enabled: true },
      { name: 'playwright', enabled: true },
    ];
    render(<WCoreConfig />);
    // The embedded engine does not receive the user's Desktop MCP library — only
    // Дархай's own operational MCPs — so the row must not claim the Desktop servers.
    expect(screen.getByText('Дархай operational MCPs · your Desktop MCP library is separate')).toBeTruthy();
  });

  it('deep-links to the Desktop models settings from the inherited row', () => {
    render(<WCoreConfig />);
    const manageLinks = screen.getAllByText('Manage in Desktop Settings');
    fireEvent.click(manageLinks[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/models', { replace: true });
  });

  it('switches to the Tools pane when a rail item is selected', () => {
    const { container } = render(<WCoreConfig />);
    fireEvent.click(container.querySelector('[data-wcore-rail-id="tools"]')!);
    expect(
      screen.getByText(
        'Everything the engine can actually do, with sensible defaults already on. Toggle a tool to grant or revoke it across all profiles. Tools that need a credential link straight to where you set it.'
      )
    ).toBeTruthy();
  });

  it('navigates back to Desktop settings via the back link', () => {
    render(<WCoreConfig />);
    fireEvent.click(screen.getByText('Settings'));
    expect(mockNavigate).toHaveBeenCalledWith('/settings', { replace: true });
  });

  it('shows the engine chip with the pinned version when running', async () => {
    render(<WCoreConfig />);
    await waitFor(() => expect(screen.getByText('engine running · v0.9.6-rc.1')).toBeTruthy());
  });

  it('shows engine stopped when the wcore backend is absent', async () => {
    mockGetAvailableAgents.mockResolvedValue({ success: true, data: [] });
    render(<WCoreConfig />);
    await waitFor(() => expect(screen.getByText('engine stopped')).toBeTruthy());
  });

  /**
   * Where the engine config lives was printed as a literal
   * `~/.wayland-core/config.toml`. That path is wrong on Windows (%APPDATA%),
   * wrong on macOS (~/Library/Application Support), and wrong for anyone on a
   * named profile. A user who opened a terminal to edit it found nothing.
   */
  describe('the engine config location is reported, not guessed', () => {
    it('prints the path the main process resolved', async () => {
      render(<WCoreConfig />);
      await waitFor(() => expect(screen.getByTestId('active-profile-dir').textContent).toBe(MOCK_CONFIG_PATH));
    });

    it('never prints the old hardcoded path anywhere on the pane', async () => {
      const { container } = render(<WCoreConfig />);
      await waitFor(() => expect(screen.getByTestId('active-profile-dir').textContent).toBeTruthy());
      expect(container.textContent).not.toContain('~/.wayland-core');
      expect(container.textContent).not.toContain('~/.darhai/profiles/default');
    });

    it('names the ACTIVE profile and its real dir, not a hardcoded "Default"', async () => {
      mockProfiles.value = [
        { name: 'default', active: false, dir: '/home/tester/.config/wayland-core' },
        { name: 'client-work', active: true, dir: '/home/tester/.darhai/profiles/client-work' },
      ];
      render(<WCoreConfig />);
      await waitFor(() => expect(screen.getByTestId('active-profile-name').textContent).toBe('client-work'));
      expect(screen.getByTestId('active-profile-dir').textContent).toBe('/home/tester/.darhai/profiles/client-work');
    });

    it('falls back to the config path when the profile list cannot be read', async () => {
      // list resolves empty => no active profile => the card still shows a real
      // location rather than inventing one.
      render(<WCoreConfig />);
      await waitFor(() => expect(screen.getByTestId('active-profile-dir').textContent).toBe(MOCK_CONFIG_PATH));
      expect(screen.getByTestId('active-profile-name').textContent).toBe('Default');
    });
  });
});
