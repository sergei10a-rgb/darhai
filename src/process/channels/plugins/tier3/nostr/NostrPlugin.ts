/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Portions adapted from OpenClaw (https://github.com/steipete/openclaw)
 * Copyright (c) 2025 Peter Steinberger
 * Licensed under the MIT License — see LICENSES/openclaw.txt
 *
 * Nostr channel plugin. Connects to operator-configured WebSocket relays,
 * subscribes to NIP-04 encrypted DMs (kind:4) tagged to our pubkey, decrypts
 * inbound events, and publishes kind:4 events for outbound DMs.
 *
 * Multi-relay fanout: each relay gets its own WebSocket and reconnect backoff
 * (5s → 60s, max 5 attempts). Plugin status='error' only when ALL relays are
 * down; remaining relays keep the channel partially live.
 *
 * Capabilities: text + reactions (kind:7). No edits — Nostr is append-only.
 */

import WebSocket from 'ws';

import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import {
  derivePublicKey,
  fromUnifiedOutgoingToNostr,
  hexToNpub,
  nip04Decrypt,
  nip04Encrypt,
  toUnifiedIncomingFromNostr,
  validatePrivateKey,
  type NostrEventLike,
} from './NostrAdapter';

// ── Constants ─────────────────────────────────────────────────────────────────

const RECONNECT_BACKOFF_START_MS = 5_000;
const RECONNECT_BACKOFF_CAP_MS = 60_000;
const RECONNECT_BACKOFF_MAX_ATTEMPTS = 5;

/** Wait up to 5s for EOSE during testConnection. */
const TEST_CONNECT_TIMEOUT_MS = 5_000;

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol'];

// ── Nostr wire types ──────────────────────────────────────────────────────────

type NostrFilter = {
  kinds?: number[];
  '#p'?: string[];
  since?: number;
  limit?: number;
};

type RelayStatus = 'connecting' | 'connected' | 'down';

type RelayState = {
  url: string;
  ws: WebSocket | null;
  status: RelayStatus;
  failureCount: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  subId: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSubId(): string {
  return `wayland-${Math.random().toString(36).slice(2, 10)}`;
}

function buildReqMessage(subId: string, pk: string, since: number): string {
  const filter: NostrFilter = { kinds: [4], '#p': [pk], since };
  return JSON.stringify(['REQ', subId, filter]);
}

function buildEventMessage(event: NostrEventLike): string {
  return JSON.stringify(['EVENT', event]);
}

/**
 * finalizeEvent from nostr-tools: signs a partial event and returns the full
 * signed Event. We import it lazily to keep the class testable with mocks.
 */
async function signEvent(
  partial: { kind: number; content: string; tags: string[][]; created_at: number },
  sk: Uint8Array,
): Promise<NostrEventLike> {
  const { finalizeEvent } = await import('nostr-tools');
  return finalizeEvent(partial, sk) as NostrEventLike;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class NostrPlugin extends BasePlugin {
  readonly type: PluginType = 'nostr';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: true,
    canTypingIndicator: false,
  };

  private sk: Uint8Array | null = null;
  private pk: string = '';
  private relayStates: RelayState[] = [];
  private stopped = false;
  /** Unix seconds: start time - small overlap so we don't miss recent events. */
  private since = 0;
  private readonly seenEventIds = new Set<string>();

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    const creds = config.credentials ?? {};
    const privateKey = typeof creds['privateKey'] === 'string' ? creds['privateKey'].trim() : '';
    if (!privateKey) throw new Error('Nostr private key is required');

    this.sk = validatePrivateKey(privateKey);
    this.pk = derivePublicKey(privateKey);

    const rawRelays = creds['relays'];
    const relays: string[] =
      Array.isArray(rawRelays) && rawRelays.length > 0
        ? (rawRelays as string[]).filter((r) => typeof r === 'string' && r.trim().startsWith('wss://'))
        : DEFAULT_RELAYS;

    if (relays.length === 0) throw new Error('At least one wss:// relay URL is required');

    this.relayStates = relays.map((url): RelayState => ({
      url,
      ws: null,
      status: 'connecting',
      failureCount: 0,
      reconnectTimer: null,
      subId: makeSubId(),
    }));
  }

  protected async onStart(): Promise<void> {
    if (!this.sk || !this.pk) throw new Error('Nostr plugin not initialized');
    this.stopped = false;
    // 120s lookback to tolerate relay lag and clock skew (matches OpenClaw).
    this.since = Math.floor(Date.now() / 1000) - 120;

    // Wait for at least one relay to reach 'connected' before resolving.
    // Promise.any resolves on the first success; if all fail we still continue
    // so the plugin can recover via scheduleReconnect. A 10s timeout prevents
    // hanging indefinitely when all relays are unreachable at startup.
    const connectPromises = this.relayStates.map((state) => this.connectRelay(state));
    await Promise.race([
      Promise.any(connectPromises).catch(() => Promise.resolve()),
      new Promise<void>((r) => setTimeout(r, 10_000)),
    ]);
  }

  protected async onStop(): Promise<void> {
    this.stopped = true;
    for (const state of this.relayStates) {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      this.closeRelayWs(state);
    }
    this.relayStates = [];
    this.sk = null;
    this.pk = '';
    this.seenEventIds.clear();
  }

  // ── Send / React ─────────────────────────────────────────────────────────────

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.sk || !this.pk) throw new Error('Nostr plugin not running');
    const plaintext = fromUnifiedOutgoingToNostr(message);
    if (!plaintext) return '';

    const recipientPubkey = chatId; // chatId is the hex pubkey of the recipient
    const ciphertext = nip04Encrypt(this.sk, recipientPubkey, plaintext);
    const partial = {
      kind: 4,
      content: ciphertext,
      tags: [['p', recipientPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    };
    const signed = await signEvent(partial, this.sk);
    await this.publishToRelays(signed);
    return signed.id;
  }

  /**
   * Publish a kind:7 reaction event. emoji defaults to '+' (like).
   * chatId is the pubkey of the original sender; messageId is the event id.
   */
  async addReaction(chatId: string, messageId: string, emoji = '+'): Promise<void> {
    if (!this.sk || !this.pk) throw new Error('Nostr plugin not running');
    const partial = {
      kind: 7,
      content: emoji,
      tags: [
        ['e', messageId],
        ['p', chatId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    };
    const signed = await signEvent(partial, this.sk);
    await this.publishToRelays(signed);
  }

  getActiveUserCount(): number {
    return 0;
  }

  getBotInfo(): BotInfo | null {
    if (!this.pk) return null;
    const npub = hexToNpub(this.pk);
    return { id: this.pk, username: npub, displayName: npub };
  }

  async handleWebhookPayload(): Promise<void> {
    throw new Error('Nostr uses persistent WebSocket relays, not webhooks');
  }

  // ── Relay management ──────────────────────────────────────────────────────────

  /**
   * Open a WebSocket to the relay and subscribe. Returns a Promise that
   * resolves once the relay is connected (open event fired), or rejects on
   * error/close before open. Used by onStart to await the first live relay.
   * Reconnect logic (scheduleReconnect) still fires on subsequent closes.
   */
  private connectRelay(state: RelayState): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stopped) { reject(new Error('stopped')); return; }

      state.subId = makeSubId();
      const ws = new WebSocket(state.url);
      state.ws = ws;
      state.status = 'connecting';

      let settled = false;

      ws.on('open', () => {
        if (this.stopped || state.ws !== ws) return;
        state.status = 'connected';
        state.failureCount = 0;
        console.log(`[NostrPlugin] connected to ${state.url}`);

        // Subscribe to kind:4 DMs tagged to our pubkey.
        ws.send(buildReqMessage(state.subId, this.pk, this.since));

        if (!settled) { settled = true; resolve(); }
      });

    ws.on('message', (data: Buffer | string) => {
      if (this.stopped || state.ws !== ws) return;
      this.handleRelayMessage(String(data), state);
    });

    ws.on('error', (err: Error) => {
      if (this.stopped || state.ws !== ws) return;
      console.warn(`[NostrPlugin] relay error ${state.url}:`, err.message);
      if (!settled) { settled = true; reject(err); }
    });

    ws.on('close', () => {
      if (this.stopped || state.ws !== ws) return;
      console.warn(`[NostrPlugin] relay closed ${state.url}, scheduling reconnect`);
      state.status = 'down';
      state.ws = null;
      if (!settled) { settled = true; reject(new Error(`relay ${state.url} closed before open`)); }
      this.scheduleReconnect(state);
    });
    }); // end new Promise
  }

  private closeRelayWs(state: RelayState): void {
    const ws = state.ws;
    state.ws = null;
    state.status = 'down';
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        // ignore teardown errors
      }
    }
  }

  private scheduleReconnect(state: RelayState): void {
    if (this.stopped) return;
    if (state.reconnectTimer) return; // already scheduled

    state.failureCount += 1;

    if (state.failureCount > RECONNECT_BACKOFF_MAX_ATTEMPTS) {
      console.error(`[NostrPlugin] relay ${state.url} down after ${RECONNECT_BACKOFF_MAX_ATTEMPTS} attempts`);
      state.status = 'down';
      this.updatePluginStatus();
      return;
    }

    // Audit gemini MED1 2026-05-18: per-relay jitter (0-1000ms) to avoid
    // synchronized reconnect storms across multiple bots when a relay flaps.
    const delay = Math.min(
      RECONNECT_BACKOFF_START_MS * 2 ** (state.failureCount - 1),
      RECONNECT_BACKOFF_CAP_MS,
    ) + Math.floor(Math.random() * 1000);
    console.warn(
      `[NostrPlugin] relay ${state.url} attempt ${state.failureCount}/${RECONNECT_BACKOFF_MAX_ATTEMPTS} in ${delay}ms`,
    );
    this.setError(`Relay ${state.url} disconnected; retrying in ${Math.round(delay / 1000)}s`);

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (this.stopped) return;
      // Reconnect attempts: catch the rejection so it doesn't surface as an
      // unhandled rejection. scheduleReconnect will be called again from the
      // ws 'close' handler inside connectRelay if it fails.
      void this.connectRelay(state).catch((): undefined => undefined);
    }, delay);

    this.updatePluginStatus();
  }

  /**
   * Status='error' only if ALL relays are down. While at least one relay is
   * connected the plugin stays 'running' so the channel remains partially live.
   */
  private updatePluginStatus(): void {
    if (this.stopped) return;
    const allDown = this.relayStates.every((s) => s.status === 'down');
    if (allDown) {
      this.setStatus('error', 'All Nostr relays are down');
    }
  }

  // ── Inbound event handling ────────────────────────────────────────────────────

  private handleRelayMessage(raw: string, _state: RelayState): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw) as unknown;
    } catch {
      return; // unparseable relay message — silently drop
    }

    if (!Array.isArray(msg) || msg.length < 2) return;
    const type = msg[0] as string;

    if (type === 'EVENT' && msg.length >= 3) {
      const event = msg[2] as NostrEventLike;
      this.handleInboundEvent(event);
    }
    // NOTICE and EOSE are informational — no action needed.
  }

  private handleInboundEvent(event: NostrEventLike): void {
    if (!this.sk || !this.pk) return;

    // Deduplicate across relay fanout.
    if (this.seenEventIds.has(event.id)) return;
    this.seenEventIds.add(event.id);

    // Only kind:4 NIP-04 DMs.
    if (event.kind !== 4) return;

    // Self-echo filter.
    if (event.pubkey === this.pk) return;

    // Must be tagged to our pubkey.
    const targetsUs = event.tags.some((t) => t[0] === 'p' && t[1] === this.pk);
    if (!targetsUs) return;

    // Stale-event filter.
    if (event.created_at < this.since) return;

    let plaintext: string;
    try {
      plaintext = nip04Decrypt(this.sk, event.pubkey, event.content);
    } catch (err) {
      console.warn(`[NostrPlugin] NIP-04 decrypt failed for event ${event.id}:`, err);
      return;
    }

    if (!plaintext.trim()) return;

    const unified = toUnifiedIncomingFromNostr(event, plaintext);
    void this.emitMessage(unified).catch((err) =>
      console.error('[NostrPlugin] emitMessage failed:', err),
    );
  }

  // ── Publish helpers ───────────────────────────────────────────────────────────

  /**
   * Publish a signed event to all connected relays. Throws if no relay
   * accepts the publish (all relays down or all fail).
   */
  private async publishToRelays(event: NostrEventLike): Promise<void> {
    const connected = this.relayStates.filter((s) => s.status === 'connected' && s.ws);
    if (connected.length === 0) throw new Error('No Nostr relays connected');

    const wire = buildEventMessage(event);
    const results = await Promise.allSettled(
      connected.map((state) =>
        new Promise<void>((resolve, reject) => {
          if (!state.ws) { reject(new Error('ws gone')); return; }
          const okListener = (data: Buffer | string) => {
            try {
              const msg = JSON.parse(String(data)) as unknown[];
              if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
                state.ws!.off('message', okListener);
                if (msg[2] === true) resolve();
                else reject(new Error(String(msg[3] ?? 'relay rejected event')));
              }
            } catch {
              // keep waiting
            }
          };
          state.ws.on('message', okListener);
          // Resolve after 3s even without OK — relay may not send it.
          setTimeout(() => { state.ws?.off('message', okListener); resolve(); }, 3_000);
          try {
            state.ws.send(wire);
          } catch (err) {
            state.ws.off('message', okListener);
            reject(err);
          }
        }),
      ),
    );

    const anyOk = results.some((r) => r.status === 'fulfilled');
    if (!anyOk) {
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      throw new Error(`Failed to publish to any relay: ${firstErr?.reason instanceof Error ? firstErr.reason.message : String(firstErr?.reason)}`);
    }
  }

  // ── Static testConnection ─────────────────────────────────────────────────────

  /**
   * Validate credentials by deriving the pubkey from the private key, then
   * opening a WebSocket to the first relay and waiting for EOSE (end of stored
   * events) within TEST_CONNECT_TIMEOUT_MS. Returns botUsername as npub.
   *
   * Token is JSON-encoded: { privateKey: string, relays: string[] }.
   */
  static override async testConnection(
    token: string,
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let parsed: { privateKey?: string; relays?: string[] };
    try {
      parsed = JSON.parse(token) as typeof parsed;
    } catch {
      return { success: false, error: 'Invalid testConnection token (expected JSON)' };
    }

    const privateKey = parsed.privateKey?.trim() ?? '';
    if (!privateKey) return { success: false, error: 'Private key is required' };

    let sk: Uint8Array;
    let pk: string;
    try {
      sk = validatePrivateKey(privateKey);
      pk = derivePublicKey(privateKey);
      void sk; // used indirectly via derivePublicKey above
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const relays = Array.isArray(parsed.relays) && parsed.relays.length > 0
      ? parsed.relays
      : DEFAULT_RELAYS;

    const relayUrl = relays[0];

    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch { /* ignore */ }
        resolve({ success: false, error: `Relay did not respond within ${TEST_CONNECT_TIMEOUT_MS / 1000}s` });
      }, TEST_CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(relayUrl);

      ws.on('open', () => {
        const subId = makeSubId();
        const filter: NostrFilter = { kinds: [4], '#p': [pk], since: Math.floor(Date.now() / 1000), limit: 1 };
        ws.send(JSON.stringify(['REQ', subId, filter]));
      });

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(String(data)) as unknown[];
          if (Array.isArray(msg) && (msg[0] === 'EOSE' || msg[0] === 'EVENT' || msg[0] === 'NOTICE')) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.terminate(); } catch { /* ignore */ }
            resolve({ success: true, botUsername: hexToNpub(pk) });
          }
        } catch {
          // keep waiting
        }
      });

      ws.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });

      ws.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: 'Relay connection closed before EOSE' });
      });
    });
  }
}
