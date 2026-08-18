/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the subscription-OAuth surface (sign in with a Claude Max /
 * ChatGPT / GitHub Copilot subscription instead of an API key). This is the
 * main-process wiring layer the pure subsystem
 * (`services/completion/subscriptionOAuth`) expects: it enforces the ToS gate
 * before any login, persists the gate + credentials through Darhai's existing
 * `ProviderRepository` credential rail, and forwards the flow's browser /
 * prompt / progress callbacks to the renderer as events.
 *
 * The whole `subscriptionOAuth.*` namespace is remote-denied (see bridgeAllowlist
 * REMOTE_DENIED_PREFIXES): every verb either opens a browser, mints/deletes a
 * stored credential, or flips a persisted policy - a login/credential class only
 * the trusted local user may drive. The local renderer contract is still
 * untrusted input crossing a process boundary, so provider ids are validated
 * here and no verb throws across IPC (a closed gate returns a machine-readable
 * refusal instead).
 */

import { shell } from 'electron';
import { ipcBridge } from '@/common';
import {
  DEFAULT_SUBSCRIPTION_OAUTH_GATE,
  SubscriptionLoginNotAllowedError,
  getSubscriptionCredStore,
  startSubscriptionLogin,
} from '@process/services/completion/subscriptionOAuth';
import type {
  OAuthPrompt,
  SubscriptionCredStore,
  SubscriptionOAuthGate,
} from '@process/services/completion/subscriptionOAuth';
import {
  SUBSCRIPTION_OAUTH_DISCLOSURE,
  SUBSCRIPTION_PROVIDERS,
  getSubscriptionProviderInfo,
} from '@/common/types/subscriptionOAuth';
import type { SubscriptionProviderId } from '@/common/types/subscriptionOAuth';
import type { ProviderId } from '@process/providers/types';

/** Registry provider id under which the feature's gate state is persisted. */
const GATE_PROVIDER_ID = 'subscription:gate' as ProviderId;

/** Injectable collaborators - production defaults are wired in {@link initSubscriptionOAuthBridge}. */
export type SubscriptionOAuthBridgeDeps = {
  /** Resolve the encrypted credential store (singleton in production). */
  getStore: () => Promise<SubscriptionCredStore>;
  /** Read the persisted gate (defaults to everything-off when absent). */
  readGate: () => Promise<SubscriptionOAuthGate>;
  /** Persist the gate. */
  writeGate: (gate: SubscriptionOAuthGate) => Promise<void>;
  /** Run the gated login end-to-end (defaults to the pure `startSubscriptionLogin`). */
  runLogin: typeof startSubscriptionLogin;
  /** Open the browser for the auth step (defaults to Electron `shell.openExternal`). */
  openExternal: (url: string) => void;
};

/** Narrow an untrusted provider id to a known one, else null. */
function safeProviderId(value: unknown): SubscriptionProviderId | null {
  return typeof value === 'string' && getSubscriptionProviderInfo(value) ? (value as SubscriptionProviderId) : null;
}

/** Acquire a `ProviderRepository` bound to the app DB (the gate's persistence rail). */
async function getRepo(): Promise<import('@process/providers/storage/ProviderRepository').ProviderRepository> {
  const { getDatabase } = await import('@process/services/database');
  const { ProviderRepository } = await import('@process/providers/storage/ProviderRepository');
  const db = await getDatabase();
  return new ProviderRepository(db.getDriver());
}

/** Production gate read: decrypt the `subscription:gate` row, or the off default. */
async function productionReadGate(): Promise<SubscriptionOAuthGate> {
  const repo = await getRepo();
  const result = repo.getRegistryProviderCreds(GATE_PROVIDER_ID);
  if (result.status !== 'ok') return DEFAULT_SUBSCRIPTION_OAUTH_GATE;
  return {
    enabled: result.creds.enabled === true,
    disclosureAcknowledged: result.creds.disclosureAcknowledged === true,
  };
}

/** Production gate write: upsert the encrypted `subscription:gate` row. */
async function productionWriteGate(gate: SubscriptionOAuthGate): Promise<void> {
  const repo = await getRepo();
  repo.upsertRegistryProvider({
    providerId: GATE_PROVIDER_ID,
    connectedVia: 'subscription-gate',
    state: 'connected',
    creds: { enabled: gate.enabled, disclosureAcknowledged: gate.disclosureAcknowledged },
  });
}

/** One cred store per process, created on first use (mirrors the OAuth subsystem's contract). */
let storePromise: Promise<SubscriptionCredStore> | null = null;
function productionGetStore(): Promise<SubscriptionCredStore> {
  return (storePromise ??= getSubscriptionCredStore());
}

/** Open only http/https URLs; provider authorize URLs are https. Malformed input is ignored. */
function productionOpenExternal(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url);
  } catch {
    // Not a URL - never hand it to the OS opener.
  }
}

/** In-flight `onPrompt` requests, resolved when the renderer answers via `submitPrompt`. */
const pendingPrompts = new Map<string, (value: string) => void>();
let promptSeq = 0;

/** Emit a prompt request to the renderer and wait for its `submitPrompt` answer. */
function waitForPrompt(providerId: SubscriptionProviderId, prompt: OAuthPrompt): Promise<string> {
  const promptId = `subscriptionOAuth-prompt-${++promptSeq}`;
  return new Promise<string>((resolve) => {
    pendingPrompts.set(promptId, resolve);
    ipcBridge.subscriptionOAuth.onPrompt.emit({
      providerId,
      promptId,
      message: prompt.message,
      placeholder: prompt.placeholder,
    });
  });
}

/** Initialize the subscription-OAuth IPC bridge handlers. */
export function initSubscriptionOAuthBridge(deps?: Partial<SubscriptionOAuthBridgeDeps>): void {
  const resolved: SubscriptionOAuthBridgeDeps = {
    getStore: productionGetStore,
    readGate: productionReadGate,
    writeGate: productionWriteGate,
    runLogin: startSubscriptionLogin,
    openExternal: productionOpenExternal,
    ...deps,
  };

  ipcBridge.subscriptionOAuth.getProviders.provider(async () => ({
    providers: SUBSCRIPTION_PROVIDERS,
    disclosure: {
      title: SUBSCRIPTION_OAUTH_DISCLOSURE.title,
      body: SUBSCRIPTION_OAUTH_DISCLOSURE.body,
      acknowledgeLabel: SUBSCRIPTION_OAUTH_DISCLOSURE.acknowledgeLabel,
    },
  }));

  ipcBridge.subscriptionOAuth.getGate.provider(async () => {
    const gate = await resolved.readGate();
    return { enabled: gate.enabled, disclosureAcknowledged: gate.disclosureAcknowledged };
  });

  ipcBridge.subscriptionOAuth.setGate.provider(async ({ enabled, disclosureAcknowledged }) => {
    const gate: SubscriptionOAuthGate = {
      enabled: enabled === true,
      disclosureAcknowledged: disclosureAcknowledged === true,
    };
    await resolved.writeGate(gate);
    return gate;
  });

  ipcBridge.subscriptionOAuth.startLogin.provider(async ({ providerId }) => {
    const id = safeProviderId(providerId);
    if (!id) return { ok: false, reason: 'unknown-provider' as const };

    const gate = await resolved.readGate();
    const store = await resolved.getStore();
    try {
      await resolved.runLogin({
        providerId: id,
        gate,
        store,
        callbacks: {
          onAuth: (info) => {
            ipcBridge.subscriptionOAuth.onAuth.emit({ providerId: id, url: info.url, instructions: info.instructions });
            resolved.openExternal(info.url);
          },
          onProgress: (message) => ipcBridge.subscriptionOAuth.onProgress.emit({ providerId: id, message }),
          onPrompt: (prompt) => waitForPrompt(id, prompt),
        },
      });
      return { ok: true as const };
    } catch (err) {
      // The gate is the one refusal we translate structurally; everything else
      // (network, provider) is surfaced as a generic error, never thrown across IPC.
      if (err instanceof SubscriptionLoginNotAllowedError) {
        return { ok: false as const, reason: err.reason };
      }
      return {
        ok: false as const,
        reason: 'error' as const,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcBridge.subscriptionOAuth.getStatus.provider(async ({ providerId }) => {
    const id = safeProviderId(providerId);
    if (!id) return { connected: false };
    const store = await resolved.getStore();
    return { connected: store.read(id) !== undefined };
  });

  ipcBridge.subscriptionOAuth.disconnect.provider(async ({ providerId }) => {
    const id = safeProviderId(providerId);
    if (!id) return { disconnected: false };
    const store = await resolved.getStore();
    store.clear(id);
    return { disconnected: true };
  });

  ipcBridge.subscriptionOAuth.submitPrompt.provider(async ({ promptId, value }) => {
    const resolvePrompt = pendingPrompts.get(promptId);
    if (resolvePrompt) {
      pendingPrompts.delete(promptId);
      resolvePrompt(typeof value === 'string' ? value : '');
    }
  });
}
