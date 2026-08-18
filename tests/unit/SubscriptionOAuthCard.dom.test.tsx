/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}));

// Mock the exact bridge module the hook imports from.
vi.mock('@/common/adapter/ipcBridge', () => {
  const g = globalThis as Record<string, unknown>;
  const mk = (name: string): ReturnType<typeof vi.fn> => (g[name] ??= vi.fn()) as ReturnType<typeof vi.fn>;
  // Emitter `.on` returns an unsubscribe fn; a fresh no-op per call is fine here.
  const onStub = (): ReturnType<typeof vi.fn> => vi.fn().mockReturnValue(() => undefined);
  return {
    subscriptionOAuth: {
      getProviders: { invoke: mk('__cardGetProviders') },
      getGate: { invoke: mk('__cardGetGate') },
      setGate: { invoke: mk('__cardSetGate') },
      startLogin: { invoke: mk('__cardStartLogin') },
      getStatus: { invoke: mk('__cardGetStatus') },
      disconnect: { invoke: mk('__cardDisconnect') },
      submitPrompt: { invoke: mk('__cardSubmitPrompt') },
      onAuth: { on: onStub() },
      onPrompt: { on: onStub() },
      onProgress: { on: onStub() },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const getProvidersMock = g.__cardGetProviders as ReturnType<typeof vi.fn>;
const getGateMock = g.__cardGetGate as ReturnType<typeof vi.fn>;
const setGateMock = g.__cardSetGate as ReturnType<typeof vi.fn>;
const getStatusMock = g.__cardGetStatus as ReturnType<typeof vi.fn>;

import SubscriptionOAuthCard from '@renderer/pages/settings/ModelsSettings/components/SubscriptionOAuthCard';

const PROVIDERS_VIEW = {
  providers: [
    {
      id: 'anthropic-max',
      label: 'Claude Max',
      subscriptionName: 'Claude Max subscription',
      flow: 'callback-server' as const,
      readiness: 'ready' as const,
    },
  ],
  disclosure: { title: 'Disclosure', body: ['You accept the risk.'], acknowledgeLabel: 'I accept' },
};

beforeEach(() => {
  getProvidersMock.mockReset().mockResolvedValue(PROVIDERS_VIEW);
  getGateMock.mockReset().mockResolvedValue({ enabled: false, disclosureAcknowledged: false });
  setGateMock.mockReset().mockResolvedValue({ enabled: true, disclosureAcknowledged: true });
  getStatusMock.mockReset().mockResolvedValue({ connected: false });
});

afterEach(() => vi.clearAllMocks());

describe('SubscriptionOAuthCard', () => {
  it('disables the Sign in button until the disclosure is accepted, then enables it', async () => {
    render(<SubscriptionOAuthCard />);

    // Card appears once providers + disclosure resolve.
    const loginButton = await screen.findByTestId('subscription-login-anthropic-max');
    // Gate closed by default -> Sign in disabled.
    expect(loginButton).toBeDisabled();

    // Accept the disclosure: the single checkbox turns the gate on.
    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(setGateMock).toHaveBeenCalledWith({ enabled: true, disclosureAcknowledged: true }));
    // Gate open -> Sign in enabled.
    await waitFor(() => expect(screen.getByTestId('subscription-login-anthropic-max')).not.toBeDisabled());
  });

  it('renders nothing when the bridge is unavailable (no providers)', async () => {
    getProvidersMock.mockRejectedValueOnce(new Error('bridge down'));
    const { container } = render(<SubscriptionOAuthCard />);
    // Never mounts the card body.
    await waitFor(() => expect(screen.queryByTestId('subscription-oauth-card')).toBeNull());
    expect(container).toBeTruthy();
  });
});
