/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment -> outbound (SMTP) settings for the built-in Email MCP server.
 *
 * Two decisions are load-bearing here.
 *
 * **1. `SMTP_HOST` is required, and there is no guess.**
 * `imap.gmail.com` -> `smtp.gmail.com` is right often enough to be tempting and
 * wrong often enough to be dangerous: a silent guess that resolves to somebody
 * else's server would hand them the user's mail and their app password. So a
 * user who has not filled in `SMTP_HOST` simply has no send capability, and
 * `email_send` says exactly that. Reading mail keeps working - the server is
 * read-and-draft until the user opts in to sending by configuring an outbound
 * host on purpose.
 *
 * **2. TLS is never silently downgraded.**
 * Port 465 means implicit TLS. Anything else means STARTTLS is REQUIRED
 * (`requireTLS`), so a server that does not offer it fails the connection
 * instead of quietly sending the password and the message in the clear. The
 * only way to plaintext is the user setting `SMTP_TLS=false` themselves, which
 * exists for local bridges (Proton Bridge listens on 127.0.0.1:1025) and is
 * the same explicit opt-out `IMAP_TLS` already has.
 *
 * Credentials default to the IMAP ones because that is true for essentially
 * every provider, and asking a user to paste the same app password twice is how
 * you get one of them wrong.
 */

import { readImapConfig } from './imapConfig';
import { ImapMcpError } from './types';

export const SMTP_HOST_ENV = 'SMTP_HOST';
export const SMTP_PORT_ENV = 'SMTP_PORT';
export const SMTP_USER_ENV = 'SMTP_USER';
export const SMTP_PASSWORD_ENV = 'SMTP_PASSWORD';
export const SMTP_TLS_ENV = 'SMTP_TLS';

/** Every env var the outbound path reads - pinned by the security test. */
export const SMTP_ENV_VARS = [SMTP_HOST_ENV, SMTP_PORT_ENV, SMTP_USER_ENV, SMTP_PASSWORD_ENV, SMTP_TLS_ENV] as const;

/** Implicit-TLS submission port. Everything else negotiates with STARTTLS. */
const IMPLICIT_TLS_PORT = 465;
const DEFAULT_PORT = 587;

export type SmtpSettings = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** True for implicit TLS (465). False means STARTTLS or explicit plaintext. */
  readonly secure: boolean;
  /** When true a server without STARTTLS is refused rather than downgraded. */
  readonly requireTls: boolean;
};

export type SmtpConfigResult = { ok: true; settings: SmtpSettings } | { ok: false; message: string };

export function readSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfigResult {
  const host = (env[SMTP_HOST_ENV] ?? '').trim();
  if (!host) {
    return {
      ok: false,
      message:
        `Sending is not set up: ${SMTP_HOST_ENV} is empty, so Дархай has no outbound mail server to use. ` +
        'Open Settings -> MCP -> Email and fill in your provider\'s SMTP host (for example "smtp.gmail.com"). ' +
        'Reading mail and saving drafts keep working without it.',
    };
  }

  // Credentials fall back to the inbound ones: same account, same app password
  // at essentially every provider.
  const imap = readImapConfig(env);
  const imapUser = imap.ok ? imap.settings.user : '';
  const imapPassword = imap.ok ? imap.settings.password : '';

  const user = (env[SMTP_USER_ENV] ?? '').trim() || imapUser;
  // App passwords are shown in 4-char groups; the spaces are cosmetic.
  const password = (env[SMTP_PASSWORD_ENV] ?? '').replace(/\s+/g, '') || imapPassword;

  if (!user || !password) {
    return {
      ok: false,
      message:
        `Sending is not set up: no username or password is available for ${host}. ` +
        `Fill in ${SMTP_USER_ENV} / ${SMTP_PASSWORD_ENV}, or complete the IMAP settings so they can be reused.`,
    };
  }

  const port = readPort(env[SMTP_PORT_ENV]);
  const tlsEnabled = readBool(env[SMTP_TLS_ENV], true);
  const secure = tlsEnabled && port === IMPLICIT_TLS_PORT;

  return {
    ok: true,
    settings: {
      host,
      port,
      user,
      password,
      secure,
      // STARTTLS is mandatory on every non-implicit port unless the user
      // explicitly turned TLS off for a local bridge.
      requireTls: tlsEnabled && !secure,
    },
  };
}

/** Settings, or a thrown user-readable error. Mirrors `requireSettings`. */
export function requireSmtpSettings(result: SmtpConfigResult): SmtpSettings {
  if (result.ok === true) return result.settings;
  throw new ImapMcpError(result.message);
}

/**
 * Describe the TLS posture in one line, for the confirmation dialog.
 *
 * The user is about to hand a message to a server; they are entitled to see
 * whether that hop is encrypted before they press the button.
 */
export function describeTransportSecurity(settings: SmtpSettings): string {
  if (settings.secure) return `${settings.host}:${settings.port} (TLS)`;
  if (settings.requireTls) return `${settings.host}:${settings.port} (STARTTLS required)`;
  return `${settings.host}:${settings.port} (NO ENCRYPTION - plaintext, because SMTP_TLS is set to false)`;
}

function readPort(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65_536 ? parsed : DEFAULT_PORT;
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}
