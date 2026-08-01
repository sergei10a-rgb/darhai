/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Environment -> connection settings for the built-in IMAP MCP server.
 *
 * The normalisation rules are copied deliberately from
 * `channels/plugins/tier1/email-imap/EmailImapPlugin.ts#resolveCredentials`,
 * which is the code path that already works against real mail hosts in this
 * app - most importantly the whitespace stripping, because Gmail and Outlook
 * display app passwords in four-character groups and users paste them verbatim.
 * Re-deriving that rule from scratch is how a server ends up rejecting a
 * perfectly good password.
 *
 * The password is NOT stored anywhere but the returned object, which lives only
 * in the spawned subprocess. It never crosses back over stdio.
 */

import { ImapMcpError, IMAP_HOST_ENV, IMAP_PASSWORD_ENV, IMAP_PORT_ENV, IMAP_TLS_ENV, IMAP_USER_ENV } from './types';
import type { ImapSettings } from './types';

const DEFAULT_PORT = 993;

export type ImapConfigResult = { ok: true; settings: ImapSettings } | { ok: false; missing: string[]; message: string };

/**
 * Read the settings out of the environment.
 *
 * Missing configuration is reported, not thrown: the stdio entrypoint must
 * still start and answer `tools/list` so a configuration gap cannot be mistaken
 * for a bundle that failed to load.
 */
export function readImapConfig(env: NodeJS.ProcessEnv = process.env): ImapConfigResult {
  const host = trimmed(env[IMAP_HOST_ENV]);
  const user = trimmed(env[IMAP_USER_ENV]);
  // App passwords are shown in 4-char groups ("yahr vkqu tevs rjvy"). The
  // spaces are cosmetic and never part of the secret.
  const password = (env[IMAP_PASSWORD_ENV] ?? '').replace(/\s+/g, '');

  const missing: string[] = [];
  if (!host) missing.push(IMAP_HOST_ENV);
  if (!user) missing.push(IMAP_USER_ENV);
  if (!password) missing.push(IMAP_PASSWORD_ENV);

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message:
        `Email is not configured yet: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
        'Open Settings -> MCP -> Email (IMAP) and fill them in. Use an app-specific password, ' +
        'not your main account password.',
    };
  }

  return {
    ok: true,
    settings: {
      host,
      port: readPort(env[IMAP_PORT_ENV]),
      user,
      password,
      tls: readBool(env[IMAP_TLS_ENV], true),
    },
  };
}

/** ImapFlow constructor options. `logger:false` silences its pino chatter. */
export function buildClientOptions(settings: ImapSettings) {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.tls,
    auth: { user: settings.user, pass: settings.password },
    logger: false as const,
    // Generous but finite: an unreachable host must error, not spin forever.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 90_000,
  };
}

/**
 * Turn an imapflow/socket failure into a sentence that names the cause.
 *
 * Same shape as `EmailImapShared.describeImapError` - imapflow surfaces an
 * opaque "Command failed" for a LOGIN that returns NO, which tells a user
 * nothing about whether the password or the hostname is wrong.
 */
export function describeImapError(err: unknown): string {
  const e = err as {
    authenticationFailed?: boolean;
    responseText?: string;
    serverResponseCode?: string;
    code?: string;
    message?: string;
  };
  if (e?.authenticationFailed) {
    const detail = e.responseText || e.serverResponseCode || 'invalid credentials';
    return `Authentication failed: check ${IMAP_USER_ENV} and ${IMAP_PASSWORD_ENV} (${detail})`;
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') {
    return `Could not resolve the IMAP host (${e.code}): check ${IMAP_HOST_ENV}`;
  }
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET') {
    return `Could not reach the IMAP server (${e.code}): check ${IMAP_HOST_ENV} and ${IMAP_PORT_ENV}`;
  }
  return e?.responseText || e?.serverResponseCode || e?.message || 'IMAP connection failed';
}

/** Convenience for handlers: settings or a thrown, user-readable error. */
export function requireSettings(result: ImapConfigResult): ImapSettings {
  if (result.ok === true) return result.settings;
  throw new ImapMcpError(result.message);
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
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
