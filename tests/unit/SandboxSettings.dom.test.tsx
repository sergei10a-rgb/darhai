/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM smoke tests for the host-sandbox Settings card. These assert the control
 * renders, gates its mode picker on the enabled flag, surfaces the honest
 * "partial enforcement" disclosure, and writes the config on toggle. NOT a
 * substitute for a real screenshot pass (the card lives inside the Electron
 * Settings modal) — see the handoff note.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Force the Windows-only feature ON before the component module evaluates its
// module-level `isWindows` check.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    configurable: true,
  });
});

const state = vi.hoisted(() => ({ data: undefined as unknown }));
const setMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/common/config/storage', () => ({
  ConfigStorage: {
    get: vi.fn().mockResolvedValue(state.data),
    set: setMock,
  },
}));

vi.mock('swr', () => ({
  default: () => ({ data: state.data }),
  mutate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import SandboxSettings from '@renderer/components/settings/SettingsModal/contents/SystemModalContent/SandboxSettings';

describe('SandboxSettings card', () => {
  beforeEach(() => {
    state.data = undefined;
    setMock.mockClear();
  });

  it('renders the enable switch and, while OFF, hides the mode picker + partial warning', () => {
    state.data = { enabled: false, mode: 'read-only' };
    render(<SandboxSettings />);
    expect(screen.getByRole('switch')).toBeTruthy();
    // Mode picker + partial-enforcement disclosure only appear once enabled.
    expect(screen.queryByText('settings.sandbox.partialWarning')).toBeNull();
  });

  it('shows the mode picker and the HONEST partial-enforcement warning when enabled', () => {
    state.data = { enabled: true, mode: 'read-only' };
    render(<SandboxSettings />);
    expect(screen.getByText('settings.sandbox.modeReadOnly')).toBeTruthy();
    expect(screen.getByText('settings.sandbox.modeWorkspaceWrite')).toBeTruthy();
    // The card must never hide that Windows ACL enforcement is only partial.
    expect(screen.getByText('settings.sandbox.partialWarning')).toBeTruthy();
  });

  it('persists enabled=true when the switch is toggled on', () => {
    state.data = { enabled: false, mode: 'read-only' };
    render(<SandboxSettings />);
    fireEvent.click(screen.getByRole('switch'));
    expect(setMock).toHaveBeenCalledWith('security.hostSandbox', { enabled: true, mode: 'read-only' });
  });
});
