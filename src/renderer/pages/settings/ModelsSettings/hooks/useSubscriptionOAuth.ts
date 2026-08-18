/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State + actions for the subscription-OAuth card. Loads the provider list and
 * disclosure, tracks the ToS gate and each provider's connection status, and
 * drives a login while surfacing the flow's browser / prompt / progress events
 * (the cookbook onDownloadProgress subscription shape).
 *
 * The gate is a single user decision here: the one "I accept" checkbox turns
 * BOTH `enabled` and `disclosureAcknowledged` on together, because a subscription
 * login is only ever wanted by a user who has just read and accepted the
 * disclosure. `loginAllowed` mirrors the pure gate predicate.
 */

import { useCallback, useEffect, useState } from 'react';
import { subscriptionOAuth } from '@/common/adapter/ipcBridge';
import type {
  SubscriptionAuthEvent,
  SubscriptionOAuthGateView,
  SubscriptionPromptEvent,
  SubscriptionProviderId,
  SubscriptionProvidersView,
} from '@/common/types/subscriptionOAuth';

const CLOSED_GATE: SubscriptionOAuthGateView = { enabled: false, disclosureAcknowledged: false };

export type SubscriptionOAuthController = {
  providers: SubscriptionProvidersView['providers'];
  disclosure: SubscriptionProvidersView['disclosure'] | null;
  gate: SubscriptionOAuthGateView;
  /** Connected flag per provider id (absent = unknown/not-yet-checked). */
  statuses: Partial<Record<SubscriptionProviderId, boolean>>;
  /** Last browser-step event (URL to visit); main also opens it. */
  auth: SubscriptionAuthEvent | null;
  /** Pending free-text request; answered via {@link submitPrompt}. */
  prompt: SubscriptionPromptEvent | null;
  /** Last progress message during a login. */
  progress: string | null;
  /** The provider whose login is currently running, if any. */
  busyProviderId: SubscriptionProviderId | null;
  /** BOTH gate flags true - the pure "login permitted" predicate. */
  loginAllowed: boolean;
  setAcknowledged: (checked: boolean) => Promise<void>;
  login: (providerId: SubscriptionProviderId) => Promise<void>;
  disconnect: (providerId: SubscriptionProviderId) => Promise<void>;
  submitPrompt: (value: string) => Promise<void>;
};

export function useSubscriptionOAuth(): SubscriptionOAuthController {
  const [providers, setProviders] = useState<SubscriptionProvidersView['providers']>([]);
  const [disclosure, setDisclosure] = useState<SubscriptionProvidersView['disclosure'] | null>(null);
  const [gate, setGateState] = useState<SubscriptionOAuthGateView>(CLOSED_GATE);
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProviderId, boolean>>>({});
  const [auth, setAuth] = useState<SubscriptionAuthEvent | null>(null);
  const [prompt, setPrompt] = useState<SubscriptionPromptEvent | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busyProviderId, setBusyProviderId] = useState<SubscriptionProviderId | null>(null);

  const refreshStatus = useCallback(async (list: SubscriptionProvidersView['providers']): Promise<void> => {
    const entries = await Promise.all(
      list.map(async (p) => {
        const status = await subscriptionOAuth.getStatus
          .invoke({ providerId: p.id })
          .catch(() => ({ connected: false }));
        return [p.id, status.connected] as const;
      })
    );
    setStatuses(Object.fromEntries(entries));
  }, []);

  // Seed providers + disclosure + gate once on mount.
  useEffect(() => {
    let alive = true;
    void subscriptionOAuth.getProviders.invoke().then(
      (view) => {
        if (!alive) return;
        setProviders(view.providers);
        setDisclosure(view.disclosure);
        void refreshStatus(view.providers);
      },
      () => {
        // Bridge unavailable (e.g. WebUI): leave empty; the card renders nothing.
      }
    );
    void subscriptionOAuth.getGate.invoke().then(
      (g) => {
        if (alive) setGateState(g);
      },
      () => {
        // Gate unavailable: keep the closed default.
      }
    );
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  // Live login events (browser / prompt / progress).
  useEffect(() => {
    const offAuth = subscriptionOAuth.onAuth.on((e: SubscriptionAuthEvent) => setAuth(e));
    const offPrompt = subscriptionOAuth.onPrompt.on((e: SubscriptionPromptEvent) => setPrompt(e));
    const offProgress = subscriptionOAuth.onProgress.on((e) => setProgress(e.message));
    return () => {
      offAuth();
      offPrompt();
      offProgress();
    };
  }, []);

  const setAcknowledged = useCallback(async (checked: boolean): Promise<void> => {
    const saved = await subscriptionOAuth.setGate.invoke({ enabled: checked, disclosureAcknowledged: checked });
    setGateState(saved);
  }, []);

  const login = useCallback(async (providerId: SubscriptionProviderId): Promise<void> => {
    setBusyProviderId(providerId);
    setAuth(null);
    setPrompt(null);
    setProgress(null);
    try {
      await subscriptionOAuth.startLogin.invoke({ providerId });
    } finally {
      setBusyProviderId(null);
      const status = await subscriptionOAuth.getStatus.invoke({ providerId }).catch(() => ({ connected: false }));
      setStatuses((prev) => ({ ...prev, [providerId]: status.connected }));
    }
  }, []);

  const disconnect = useCallback(async (providerId: SubscriptionProviderId): Promise<void> => {
    await subscriptionOAuth.disconnect.invoke({ providerId });
    setStatuses((prev) => ({ ...prev, [providerId]: false }));
  }, []);

  const submitPrompt = useCallback(
    async (value: string): Promise<void> => {
      if (!prompt) return;
      await subscriptionOAuth.submitPrompt.invoke({ promptId: prompt.promptId, value });
      setPrompt(null);
    },
    [prompt]
  );

  return {
    providers,
    disclosure,
    gate,
    statuses,
    auth,
    prompt,
    progress,
    busyProviderId,
    loginAllowed: gate.enabled && gate.disclosureAcknowledged,
    setAcknowledged,
    login,
    disconnect,
    submitPrompt,
  };
}
