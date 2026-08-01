/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The ONLY module in this bundle that can put a message on the wire.
 *
 * It is the single file under `imap/` that imports an SMTP client, and it has a
 * single caller: `sendGate.ts`, which asks the user first. That shape is the
 * whole security argument, and `tests/unit/process/resources/builtinMcp/
 * imapSecurity.test.ts` pins both halves of it - one file imports nodemailer,
 * one file imports this one. The read and draft tools cannot reach here at all.
 *
 * The runtime half of the argument is {@link sendApprovedMessage}'s first two
 * statements. An approval is not a flag, it is a RECEIPT for specific bytes:
 *
 *   - `approval.approved` must be exactly `true`, and
 *   - `approval.fingerprint` must equal a hash this function recomputes over
 *     the envelope and the MIME it was handed.
 *
 * So consent obtained for "Hi mum, running late" cannot be spent on a wire
 * transfer request, however the two got separated - a refactor, a retry, a
 * cached approval, an attacker who controls the text between the dialog and the
 * socket. The dialog showed those bytes; only those bytes may leave.
 *
 * Credentials: `settings.password` is handed to nodemailer and referenced
 * nowhere else. SMTP error objects echo the failing command, which for AUTH
 * carries the credential, so every error leaving this module is rewritten to a
 * short sentence and the caller additionally runs the password-bound redactor
 * over it.
 */

import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import type { SmtpSettings } from './smtpConfig';
import { ImapMcpError } from './types';

/** The exact bytes and recipients a send is about. */
export type OutgoingMessage = {
  /** Envelope MAIL FROM. */
  from: string;
  /** Envelope RCPT TO - to + cc + bcc, already validated. */
  recipients: readonly string[];
  /** Full RFC 5322 bytes, built by `draftBuilder`. Sent verbatim. */
  mime: Buffer;
};

/**
 * What the user's press produced.
 *
 * Structurally identical to the gate's approved outcome, restated here so this
 * module depends on the SHAPE of an approval rather than on the gate's module
 * graph - it must be impossible to satisfy by calling something in this file.
 */
export type ApprovalReceipt = {
  approved: boolean;
  requestId: string;
  fingerprint: string;
};

export type SendResult = {
  accepted: string[];
  rejected: string[];
  response: string;
  smtpMessageId: string | null;
};

/**
 * Hash of exactly what would go on the wire.
 *
 * Recipients are sorted so the same send fingerprints the same way regardless
 * of the order the to/cc/bcc lists were assembled in, and the MIME goes in
 * verbatim - Message-ID, Date, subject, body and all. Any change to any of them
 * changes the hash, which is the point.
 */
export function fingerprintOutgoing(message: OutgoingMessage): string {
  const hash = createHash('sha256');
  hash.update(`from:${message.from}\n`);
  hash.update(`rcpt:${[...message.recipients].sort().join(',')}\n`);
  hash.update(message.mime);
  return hash.digest('hex');
}

/**
 * Transmit a message the user has approved.
 *
 * Throws {@link ImapMcpError} when the receipt does not authorise these exact
 * bytes. Never sends on a missing, false or mismatched approval.
 */
export async function sendApprovedMessage(
  approval: ApprovalReceipt,
  settings: SmtpSettings,
  message: OutgoingMessage
): Promise<SendResult> {
  if (!approval || approval.approved !== true) {
    throw new ImapMcpError('Refusing to send: this message was not approved by the user.');
  }
  const expected = fingerprintOutgoing(message);
  if (approval.fingerprint !== expected) {
    throw new ImapMcpError(
      'Refusing to send: the message changed after the user approved it. ' +
        'Nothing was sent. Ask for confirmation again with the message you actually want to send.'
    );
  }
  if (message.recipients.length === 0) {
    throw new ImapMcpError('Refusing to send: the message has no recipients.');
  }

  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // Implicit TLS on 465. On every other port `requireTLS` makes STARTTLS
    // mandatory, so a server that cannot offer it fails instead of silently
    // carrying the password and the message in clear text.
    secure: settings.secure,
    requireTLS: settings.requireTls,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 90_000,
    logger: false,
  });

  try {
    const info = await transport.sendMail({
      envelope: { from: message.from, to: [...message.recipients] },
      // Raw bytes: the headers the user approved are the headers transmitted.
      // Nothing is re-composed here, so nodemailer cannot add or reorder a
      // header between the dialog and the wire.
      raw: message.mime,
    });
    return {
      accepted: toAddressList(info.accepted),
      rejected: toAddressList(info.rejected),
      response: typeof info.response === 'string' ? info.response : '',
      smtpMessageId: typeof info.messageId === 'string' ? info.messageId : null,
    };
  } catch (error) {
    throw new ImapMcpError(describeSmtpError(error));
  } finally {
    transport.close();
  }
}

/** nodemailer reports addresses as strings or `{address}` records. */
function toAddressList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((entry) =>
    typeof entry === 'string' ? entry : String((entry as { address?: unknown })?.address ?? '')
  );
}

/**
 * Turn an SMTP failure into a sentence that names the cause and carries no
 * credential.
 *
 * Same shape as `describeImapError`. The `command` / `response` fields are the
 * ones that have been observed echoing an AUTH line, so they are never
 * concatenated wholesale - only the response CODE and a fixed explanation.
 */
export function describeSmtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; command?: string; message?: string };
  if (e?.responseCode === 535 || e?.code === 'EAUTH') {
    return 'The mail server rejected the login (535). Check SMTP_USER and SMTP_PASSWORD - most providers need an app-specific password.';
  }
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') {
    return `Could not resolve the SMTP host (${e.code}): check SMTP_HOST.`;
  }
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' || e?.code === 'ESOCKET') {
    return `Could not reach the SMTP server (${e.code}): check SMTP_HOST and SMTP_PORT.`;
  }
  if (e?.code === 'ETLS') {
    return 'The SMTP server would not start TLS, and Дархай will not send mail in clear text. Nothing was sent.';
  }
  if (typeof e?.responseCode === 'number') {
    return `The mail server refused the message (SMTP ${e.responseCode}). Nothing was sent.`;
  }
  return `The message could not be sent (${e?.code ?? e?.message ?? 'unknown SMTP failure'}). Nothing was sent.`;
}
