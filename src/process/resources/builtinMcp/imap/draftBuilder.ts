/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build an RFC 5322 message for APPENDing to the user's Drafts folder.
 *
 * Written by hand rather than with `nodemailer`'s MailComposer, and that is the
 * point: nodemailer is an SMTP client. Keeping it out of this bundle turns "the
 * email server cannot send" from a claim about the tool list into a claim about
 * the dependency graph - there is no code in the shipped file that can open an
 * SMTP connection, so no future edit can accidentally expose one without adding
 * a dependency first.
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
  from?: string;
  /** Message-ID of the message being replied to, for correct threading. */
  inReplyTo?: string;
  references?: string[];
};

export type BuiltDraft = {
  /** Full RFC 5322 bytes, ready for IMAP APPEND. */
  mime: Buffer;
  /** The Message-ID this draft carries, so the caller can report it. */
  messageId: string;
  headerSummary: Record<string, string>;
};

/** Characters that would let a value break out of its header line. */
const HEADER_INJECTION = /[\r\n]/;

export function buildDraft(input: DraftInput, now: Date = new Date()): BuiltDraft {
  const to = normaliseAddressList(input.to, 'to');
  if (to.length === 0) throw new ImapMcpError('A draft needs at least one recipient in `to`.');
  const cc = normaliseAddressList(input.cc ?? [], 'cc');
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
    headerSummary: Object.fromEntries(headers.filter(([k]) => k !== 'Content-Transfer-Encoding')),
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

function normaliseAddressList(values: readonly string[], field: string): string[] {
  return values
    .map((value) => assertHeaderSafe(String(value ?? '').trim(), field))
    .filter((value) => value.length > 0)
    .map((value) => {
      if (!value.includes('@')) throw new ImapMcpError(`'${value}' in \`${field}\` is not an email address.`);
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
