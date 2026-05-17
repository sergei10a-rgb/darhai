/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Email plugin backed by raw IMAP (inbound) + SMTP (outbound). This is the
 * "bring-your-own-inbox" sibling of the AgentMail plugin: instead of a SaaS
 * vendor signing webhooks, the operator points us at their own mailbox and we
 * connect with imapflow + nodemailer.
 *
 * Inbound: prefer IMAP IDLE when the server advertises it, fall back to a 30s
 * polling loop otherwise. Each new UNSEEN message in INBOX is converted to
 * IUnifiedIncomingMessage and marked seen so it isn't reprocessed.
 *
 * Outbound: SMTP via nodemailer.createTransport. By default the SMTP
 * credentials mirror the IMAP credentials; the form can opt-out and supply
 * distinct SMTP creds (e.g. Gmail with an app-password for IMAP + a custom
 * relay for outbound).
 *
 * Email has no edit / streaming / reaction / typing support so the plugin
 * declares pure-buffered capabilities.
 */

import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import type {
  BotInfo,
  IChannelPluginConfig,
  IPluginCapabilities,
  IUnifiedIncomingMessage,
  IUnifiedOutgoingMessage,
  PluginType,
} from '../../../types';
import { BasePlugin } from '../../BasePlugin';
import { buildSmtpEnvelope, parseImapMessage, type ImapMessageEnvelope } from './EmailImapAdapter';

/**
 * Polling interval when the server does not advertise IDLE. 30s mirrors the
 * usual gmail/outlook poll budget; aggressive enough for assistant UX, gentle
 * enough that big providers don't rate-limit us.
 */
const POLL_INTERVAL_MS = 30_000;

type ResolvedCredentials = {
  readonly imap: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly tls: boolean;
  };
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly tls: boolean;
  };
};

type ImapFetchMessage = {
  readonly uid: number;
  readonly envelope?: {
    readonly messageId?: string;
    readonly inReplyTo?: string;
    readonly subject?: string;
    readonly date?: Date;
    readonly from?: ReadonlyArray<{ readonly address?: string; readonly name?: string }>;
    readonly to?: ReadonlyArray<{ readonly address?: string; readonly name?: string }>;
  };
  readonly source?: Buffer;
};

export class EmailImapPlugin extends BasePlugin {
  readonly type: PluginType = 'email-imap';

  readonly capabilities: IPluginCapabilities = {
    canEdit: false,
    canStream: false,
    canReact: false,
    canTypingIndicator: false,
  };

  private creds: ResolvedCredentials | null = null;
  private client: ImapFlow | null = null;
  private smtp: Transporter | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private idleActive = false;
  private lastSeenUid = 0;
  private readonly activeUsers: Set<string> = new Set();

  protected async onInitialize(config: IChannelPluginConfig): Promise<void> {
    this.creds = resolveCredentials(config.credentials ?? {});
  }

  protected async onStart(): Promise<void> {
    if (!this.creds) throw new Error('Email-IMAP plugin not initialized');

    // Build outbound SMTP transport eagerly so send-failures surface here
    // rather than on the first agent reply.
    this.smtp = nodemailer.createTransport({
      host: this.creds.smtp.host,
      port: this.creds.smtp.port,
      secure: this.creds.smtp.port === 465,
      requireTLS: this.creds.smtp.tls && this.creds.smtp.port !== 465,
      auth: {
        user: this.creds.smtp.user,
        pass: this.creds.smtp.password,
      },
    });

    // Connect IMAP. logger:false silences imapflow's pino-style chatter.
    this.client = new ImapFlow({
      host: this.creds.imap.host,
      port: this.creds.imap.port,
      secure: this.creds.imap.tls,
      auth: {
        user: this.creds.imap.user,
        pass: this.creds.imap.password,
      },
      logger: false,
    });

    await this.client.connect();
    await this.client.mailboxOpen('INBOX');

    // Drain unread on startup, then start IDLE or fall back to polling.
    await this.fetchUnseen();

    if (this.client.serverInfo?.capability?.includes('IDLE')) {
      this.startIdleLoop();
    } else {
      this.startPollingLoop();
    }
  }

  protected async onStop(): Promise<void> {
    this.idleActive = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch (err) {
        console.warn('[email-imapPlugin] logout failed:', err);
      }
      this.client = null;
    }
    if (this.smtp) {
      this.smtp.close();
      this.smtp = null;
    }
    this.creds = null;
    this.activeUsers.clear();
    this.lastSeenUid = 0;
  }

  getActiveUserCount(): number {
    return this.activeUsers.size;
  }

  getBotInfo(): BotInfo | null {
    if (!this.creds) return null;
    return {
      id: this.creds.imap.user,
      username: this.creds.imap.user,
      displayName: this.creds.imap.user,
    };
  }

  async editMessage(): Promise<void> {
    throw new Error('Email does not support editing messages');
  }

  async handleWebhookPayload(): Promise<void> {
    throw new Error('IMAP plugin uses pull/IDLE, not webhooks');
  }

  async sendMessage(chatId: string, message: IUnifiedOutgoingMessage): Promise<string> {
    if (!this.smtp || !this.creds) {
      throw new Error('Email-IMAP plugin not started');
    }
    const envelope = buildSmtpEnvelope(message, chatId, this.creds.imap.user, message.replyToMessageId);

    const info = await this.smtp.sendMail({
      from: envelope.from,
      to: envelope.to,
      subject: envelope.subject,
      text: envelope.text,
      ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
      ...(envelope.references ? { references: envelope.references } : {}),
    });

    const id = typeof info.messageId === 'string' ? info.messageId : '';
    if (!id) {
      throw new Error('SMTP send returned no Message-ID');
    }
    return id;
  }

  /**
   * IDLE loop: when the server pushes "new message", drain the unseen set and
   * re-arm IDLE. We don't use imapflow's higher-level helpers because they
   * conflict with manual fetchUnseen() — explicit drain → re-arm is simpler
   * and easier to reason about.
   */
  private startIdleLoop(): void {
    if (!this.client) return;
    this.idleActive = true;

    const client = this.client;
    client.on('exists', () => {
      // Server says "new message exists". Drain on next tick so we are not
      // holding the IDLE lock while running our own FETCH.
      void this.fetchUnseen().catch((err) =>
        console.error('[email-imapPlugin] fetch on exists failed:', err)
      );
    });

    // Kick off the long-lived IDLE call. imapflow returns when IDLE ends
    // (server timeout or our stop()); we just re-arm until idleActive=false.
    void (async () => {
      while (this.idleActive && this.client) {
        try {
          await this.client.idle();
        } catch (err) {
          if (this.idleActive) {
            console.warn('[email-imapPlugin] IDLE error, sleeping 5s before re-arm:', err);
            await sleep(5000);
          }
        }
      }
    })();
  }

  private startPollingLoop(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.pollInFlight) return;
      void this.fetchUnseen().catch((err) =>
        console.error('[email-imapPlugin] poll fetch failed:', err)
      );
    }, POLL_INTERVAL_MS);
  }

  /**
   * FETCH all UNSEEN messages > lastSeenUid, project each into the unified
   * shape, dispatch through messageHandler, and mark seen so the same message
   * is not reprocessed on the next IDLE/poll cycle.
   */
  private async fetchUnseen(): Promise<void> {
    if (!this.client) return;
    if (this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const search = { seen: false };
      // Use the high-level fetch generator with envelope + source body so we
      // get both the parsed envelope and the raw text for the adapter.
      const messages = this.client.fetch(search, { envelope: true, source: true, uid: true });

      // Iterate sequentially — order matters for lastSeenUid bookkeeping.
      for await (const raw of messages as AsyncIterable<ImapFetchMessage>) {
        const projected = toEnvelopeForAdapter(raw);
        const unified = parseImapMessage(projected);
        if (!unified) {
          console.warn('[email-imapPlugin] dropping message with missing uid/from/messageId');
          continue;
        }
        this.activeUsers.add(unified.user.id);
        try {
          await this.dispatch(unified);
        } catch (err) {
          console.error('[email-imapPlugin] handler threw:', err);
        }
        if (raw.uid > this.lastSeenUid) this.lastSeenUid = raw.uid;

        // Mark this UID as seen so subsequent IDLE/poll iterations skip it.
        try {
          await this.client.messageFlagsAdd(`${raw.uid}`, ['\\Seen'], { uid: true });
        } catch (err) {
          console.warn(`[email-imapPlugin] failed to mark uid=${raw.uid} seen:`, err);
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async dispatch(message: IUnifiedIncomingMessage): Promise<void> {
    await this.emitMessage(message);
  }

  // ==================== Static Methods ====================

  /**
   * Validate credentials by opening an IMAP connection + SELECTing INBOX.
   * Signature mirrors BasePlugin.testConnection (single `token` string) so the
   * Settings IPC layer can call it generically. The token is the JSON-encoded
   * credentials block from the renderer, identical to Matrix + WhatsApp.
   */
  static override async testConnection(
    token: string
  ): Promise<{ success: boolean; botUsername?: string; error?: string }> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(token) as Record<string, unknown>;
    } catch {
      return { success: false, error: 'Invalid testConnection token (expected JSON)' };
    }

    let creds: ResolvedCredentials;
    try {
      creds = resolveCredentials(parsed as Parameters<typeof resolveCredentials>[0]);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port,
      secure: creds.imap.tls,
      auth: {
        user: creds.imap.user,
        pass: creds.imap.password,
      },
      logger: false,
    });

    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      await client.mailboxClose();
      return { success: true, botUsername: creds.imap.user };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore logout failures during test
      }
    }
  }
}

/**
 * Validate + normalize the raw credentials shape coming from either the
 * persisted IChannelPluginConfig or the renderer's testConnection token.
 * Throws on missing required fields so onInitialize / testConnection can
 * surface a clear message.
 */
function resolveCredentials(creds: Record<string, unknown>): ResolvedCredentials {
  const imapHost = readString(creds.imapHost);
  const imapUser = readString(creds.imapUser);
  const imapPassword = readString(creds.imapPassword);
  if (!imapHost) throw new Error('IMAP host is required');
  if (!imapUser) throw new Error('IMAP user is required');
  if (!imapPassword) throw new Error('IMAP password is required');

  const imapPort = readNumber(creds.imapPort, 993);
  const imapTls = readBool(creds.imapTls, true);

  const useSameAuth = readBool(creds.useSameAuth, true);
  const smtpHost = readString(creds.smtpHost) || imapHost;
  const smtpPort = readNumber(creds.smtpPort, 587);
  const smtpTls = readBool(creds.smtpTls, true);
  const smtpUser = useSameAuth ? imapUser : readString(creds.smtpUser);
  const smtpPassword = useSameAuth ? imapPassword : readString(creds.smtpPassword);
  if (!smtpUser) throw new Error('SMTP user is required');
  if (!smtpPassword) throw new Error('SMTP password is required');

  return {
    imap: { host: imapHost, port: imapPort, user: imapUser, password: imapPassword, tls: imapTls },
    smtp: { host: smtpHost, port: smtpPort, user: smtpUser, password: smtpPassword, tls: smtpTls },
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return fallback;
}

function toEnvelopeForAdapter(raw: ImapFetchMessage): ImapMessageEnvelope {
  const envelope = raw.envelope ?? {};
  const firstFrom = envelope.from?.[0];
  const text = raw.source ? raw.source.toString('utf8') : undefined;
  return {
    uid: raw.uid,
    messageId: envelope.messageId,
    inReplyTo: envelope.inReplyTo,
    subject: envelope.subject,
    date: envelope.date,
    from: firstFrom ? { address: firstFrom.address, name: firstFrom.name } : undefined,
    to: envelope.to?.map((t) => ({ address: t.address, name: t.name })),
    text,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
