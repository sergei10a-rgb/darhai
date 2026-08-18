/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, transport-safe contract for the "sign in with your existing
 * subscription" feature (Claude Max / ChatGPT / GitHub Copilot). This file
 * holds ONLY plain data - provider ids, human labels, and the disclosure text -
 * so both the renderer (which shows the disclosure and the connect UI) and the
 * main process (which runs the OAuth flow) can import it without pulling in any
 * Node/Electron code or any token material.
 *
 * ⚠️ Terms-of-Service note: using a Claude Max / ChatGPT Plus / GitHub Copilot
 * subscription's OAuth session from a third-party app MAY conflict with that
 * service's terms. This capability therefore ships DISABLED by default and must
 * be turned on deliberately by the user, who first sees {@link SUBSCRIPTION_OAUTH_DISCLOSURE}.
 * The app performs no automatic sign-in.
 */

/** The subscription-OAuth providers this feature can connect. */
export type SubscriptionProviderId = 'anthropic-max' | 'chatgpt' | 'github-copilot';

/** Readiness of a ported provider flow, surfaced honestly in the UI. */
export type SubscriptionProviderReadiness = 'ready' | 'experimental';

/** Static, transport-safe descriptor for one subscription-OAuth provider. */
export type SubscriptionProviderInfo = {
  id: SubscriptionProviderId;
  /** Short human label, e.g. "Claude Max". */
  label: string;
  /** The subscription this connects, spelled out for the disclosure. */
  subscriptionName: string;
  /** How the browser step works, so the UI can set expectations. */
  flow: 'callback-server' | 'device-code';
  readiness: SubscriptionProviderReadiness;
};

/** The three providers, in display order. */
export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderInfo[] = [
  {
    id: 'anthropic-max',
    label: 'Claude Max / Pro',
    subscriptionName: 'Anthropic Claude Max эсвэл Pro',
    flow: 'callback-server',
    readiness: 'ready',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT Plus / Pro',
    subscriptionName: 'OpenAI ChatGPT Plus эсвэл Pro (Codex)',
    flow: 'callback-server',
    readiness: 'experimental',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    subscriptionName: 'GitHub Copilot',
    flow: 'device-code',
    readiness: 'experimental',
  },
] as const;

/** Look up a provider descriptor by id, or `undefined` when unknown. */
export function getSubscriptionProviderInfo(id: string): SubscriptionProviderInfo | undefined {
  return SUBSCRIPTION_PROVIDERS.find((p) => p.id === id);
}

/**
 * The disclosure the user MUST see and accept before any subscription login.
 * Provider-agnostic on purpose: the card lists every provider below it, so the
 * disclosure names them collectively rather than templating one in. Bilingual -
 * Дархай's audience is Mongolian, but the ToS terms are the vendor's English.
 */
export const SUBSCRIPTION_OAUTH_DISCLOSURE = {
  title: 'Захиалгаараа нэвтрэх — анхаарах зүйл',
  body: [
    'Энэ нь таны одоо байгаа захиалгыг (Claude Max, ChatGPT, эсвэл Copilot) Дархай дотор шууд ашиглана. API түлхүүр шаардлагагүй.',
    'Тухайн үйлчилгээний Үйлчилгээний нөхцөл (ToS)-ийг гуравдагч апп-аар ашиглах нь зөрчилдож болзошгүй. Үүнийг та өөрөө хариуцна.',
    'Нэвтрэлт зөвхөн таны зөвшөөрлөөр, зориудаар эхэлнэ. Дархай автоматаар нэвтрэхгүй.',
    'Токеныг таны төхөөрөмжийн үйлдлийн системийн түлхүүрийн сан (Keychain / DPAPI / libsecret)-аар шифрлэж хадгална.',
  ],
  acknowledgeLabel: 'Ойлголоо, нөхцөлийг өөрөө хариуцна',
} as const;

// ===== IPC transport shapes (main <-> renderer) =====
// These are the only shapes that cross the bridge. They restate the plain-data
// contract above so the renderer never imports any main-process (Node/Electron)
// module and no token material ever appears in a transport type.

/** The user-controlled gate for the whole feature (transport copy). */
export type SubscriptionOAuthGateView = {
  enabled: boolean;
  disclosureAcknowledged: boolean;
};

/** `getProviders` payload: the provider list plus the disclosure to render. */
export type SubscriptionProvidersView = {
  providers: readonly SubscriptionProviderInfo[];
  disclosure: {
    title: string;
    /** The provider-agnostic disclosure lines, rendered verbatim. */
    body: readonly string[];
    acknowledgeLabel: string;
  };
};

/** Why a `startLogin` refused, mirrored from the process-side gate denial reasons. */
export type SubscriptionLoginRefusal = 'disabled' | 'disclosure-not-acknowledged' | 'unknown-provider' | 'error';

/** `startLogin` result: `ok` on success, else a machine-readable refusal. */
export type SubscriptionLoginResult = { ok: true } | { ok: false; reason: SubscriptionLoginRefusal; message?: string };

/** `getStatus` result: is this provider currently connected (has stored creds)? */
export type SubscriptionConnectionStatus = { connected: boolean };

/** Emitted when a login needs the browser (main also opens it) - so the UI can show the URL. */
export type SubscriptionAuthEvent = { providerId: SubscriptionProviderId; url: string; instructions?: string };

/** Emitted when a login needs free-text input; the UI answers via `submitPrompt`. */
export type SubscriptionPromptEvent = {
  providerId: SubscriptionProviderId;
  promptId: string;
  message: string;
  placeholder?: string;
};

/** Emitted for progress messages during a login (token exchange, etc.). */
export type SubscriptionProgressEvent = { providerId: SubscriptionProviderId; message: string };
