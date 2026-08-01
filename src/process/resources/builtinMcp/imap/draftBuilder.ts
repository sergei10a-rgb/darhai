/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build an RFC 5322 message - for APPENDing to Drafts, and for handing to the
 * confirmation-gated sender as raw bytes.
 *
 * Written by hand rather than with `nodemailer`'s MailComposer. That is still
 * the point after `email_send` exists: this file has no SMTP client and no way
 * to open a socket, so the ONE module that can transmit
 * (`smtpSender.ts`) is reachable from exactly one caller (`sendGate.ts`), and
 * that caller asks the user first. Building the bytes and sending them stay
 * separate concerns in separate files precisely so the second can be gated
 * while the first is shared with the draft path.
 *
 * Everything the caller supplies is header-injection-checked before it is
 * written: a subject containing a bare CRLF would otherwise let a model (or an
 * email instructing a model) forge extra headers such as `Bcc:`.
 */

import { ImapMcpError } from './types';

export type DraftInput = {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  /**
   * Blind recipients. Validated like every other address, but NEVER written as
   * a header - a `Bcc:` line in the transmitted bytes would show every blind
   * recipient to all the others, which is the one thing Bcc must not do. They
   * travel in the SMTP envelope instead (see {@link BuiltDraft.recipients}).
   */
  bcc?: string[];
  from?: string;
  /** Message-ID of the message being replied to, for correct threading. */
  inReplyTo?: string;
  references?: string[];
};

export type BuiltDraft = {
  /** Full RFC 5322 bytes, ready for IMAP APPEND or for the SMTP envelope. */
  mime: Buffer;
  /** The Message-ID this draft carries, so the caller can report it. */
  messageId: string;
  headerSummary: Record<string, string>;
  /**
   * Normalised addresses, after validation.
   *
   * The SMTP envelope must be built from THESE and not from the raw input:
   * they are the same values that were header-checked and the same ones the
   * confirmation dialog is given, so what the user approved and what the
   * server is told to deliver to cannot drift apart.
   */
  recipients: { to: string[]; cc: string[]; bcc: string[] };
};

/** Characters that would let a value break out of its header line. */
const HEADER_INJECTION = /[\r\n]/;

export function buildDraft(input: DraftInput, now: Date = new Date()): BuiltDraft {
  const to = normaliseAddressList(input.to, 'to');
  if (to.length === 0) throw new ImapMcpError('A draft needs at least one recipient in `to`.');
  const cc = normaliseAddressList(input.cc ?? [], 'cc');
  const bcc = normaliseAddressList(input.bcc ?? [], 'bcc');
  const subject = assertHeaderSafe(input.subject ?? '', 'subject');
  const from = input.from ? assertHeaderSafe(input.from, 'from') : '';

  const messageId = `<${randomToken()}.${now.getTime()}@darhai.local>`;
  const headers: Array<[string, string]> = [
    ['Date', now.toUTCString()],
    ['Message-ID', messageId],
    ...(from ? ([['From', from]] as Array<[string, string]>) : []),
    ['To', to.join(', ')],
    ...(cc.length > 0 ? ([['Cc', cc.join(', ')]] as Array<[string, string]>) : []),
    ['Subject', encodeHeaderValue(subject)],
    ...(input.inReplyTo
      ? ([['In-Reply-To', assertHeaderSafe(input.inReplyTo, 'inReplyTo')]] as Array<[string, string]>)
      : []),
    ...(input.references && input.references.length > 0
      ? ([['References', input.references.map((r) => assertHeaderSafe(r, 'references')).join(' ')]] as Array<
          [string, string]
        >)
      : []),
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset=utf-8'],
    // base64 keeps Mongolian Cyrillic intact regardless of how the IMAP server
    // and the user's mail client disagree about 8-bit transport.
    ['Content-Transfer-Encoding', 'base64'],
  ];

  const encodedBody = wrap(Buffer.from(input.body ?? '', 'utf8').toString('base64'), 76);
  const mime = Buffer.from(`${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${encodedBody}\r\n`, 'utf8');

  return {
    mime,
    messageId,
    // Bcc is summarised (the user must SEE who they are blind-copying) but is
    // deliberately absent from `headers`, so it never reaches the wire bytes.
    headerSummary: {
      ...Object.fromEntries(headers.filter(([k]) => k !== 'Content-Transfer-Encoding')),
      ...(bcc.length > 0 ? { Bcc: bcc.join(', ') } : {}),
    },
    recipients: { to, cc, bcc },
  };
}

/**
 * Build the `Subject:` for a reply, without stacking `Re: Re: Re:`.
 * Exported so the reply path and its tests share one rule.
 */
export function replySubject(original: string): string {
  const base = (original ?? '').trim();
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive every mail client. */
export function encodeHeaderValue(value: string): string {
  // Printable US-ASCII passes through verbatim; anything else (Mongolian
  // Cyrillic, emoji, accents) must be encoded or mail clients show mojibake.
  if (/^[\u0020-\u007e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * One array element must be ONE bare address - no display name, no comma list.
 *
 * This got stricter when `email_send` arrived, and the reason is specific: the
 * SMTP envelope is built from these same strings. `["a@x.mn, attacker@evil"]`
 * used to pass (it contains an `@`), which would put two recipients in the
 * visible `To:` header and one nonsense string in the envelope - a mismatch
 * between what the user was shown and what the server is asked to deliver to.
 * `Name <a@x.mn>` is rejected for the same reason: the envelope needs the bare
 * addr-spec, and quietly sending the display-name form is how a message goes
 * to nobody.
 */
const BARE_ADDRESS = /^[^\s,;<>@]+@[^\s,;<>@]+$/;

function normaliseAddressList(values: readonly string[], field: string): string[] {
  return values
    .map((value) => assertHeaderSafe(String(value ?? '').trim(), field))
    .filter((value) => value.length > 0)
    .map((value) => {
      if (!BARE_ADDRESS.test(value)) {
        throw new ImapMcpError(
          `'${value}' in \`${field}\` is not an email address. ` +
            'Give one plain address per entry, with no display name and no comma-separated list.'
        );
      }
      return value;
    });
}

/**
 * Reject any value carrying a CR or LF.
 *
 * This is the header-injection gate. It matters more here than in most places:
 * the body of an incoming email can reach this function through a model that
 * was asked to "draft a reply", so a raw newline in a subject is a plausible
 * injection vector rather than a theoretical one.
 */
function assertHeaderSafe(value: string, field: string): string {
  if (HEADER_INJECTION.test(value)) {
    throw new ImapMcpError(`\`${field}\` contains a line break. Header values must be a single line.`);
  }
  return value;
}

function wrap(value: string, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines.join('\r\n');
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 12);
}
