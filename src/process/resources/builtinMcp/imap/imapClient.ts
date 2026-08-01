/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The IMAP primitives of the built-in email MCP server.
 *
 * `imapflow` only - there is deliberately NO `nodemailer`, no SMTP transport and
 * no socket to port 587/465 anywhere in this file or anything it imports. That
 * is the mechanical form of "this server cannot send mail": the capability is
 * absent from the dependency graph, not merely absent from the tool list.
 *
 * The one write this module can perform is `APPEND` into the mailbox the server
 * itself resolved as Drafts ({@link resolveDraftsMailbox}). The target is never
 * taken from a caller argument, so neither a model nor an email instructing a
 * model can append a forged message into INBOX or Sent.
 *
 * Connections are opened per operation and logged out in `finally`. A pooled
 * connection would be faster, but a desktop assistant makes a handful of calls
 * per turn and a stale pooled socket is a whole class of bug that a per-call
 * connect does not have.
 */

import { ImapFlow } from 'imapflow';
import { buildClientOptions, describeImapError } from './imapConfig';
import { ImapMcpError, MAX_BODY_CHARS, type AttachmentInfo, type ImapSettings, type MailboxInfo } from './types';

/** Names to try when the server declares no SPECIAL-USE `\Drafts` flag. */
const DRAFTS_FALLBACK_NAMES = ['drafts', 'draft', 'entwürfe', 'brouillons', 'ноорог'];

/**
 * Names to try when the server declares no SPECIAL-USE `\Sent` flag.
 *
 * Providers disagree loudly here - Gmail says "Sent Mail", Outlook "Sent
 * Items", Fastmail "Sent" - which is exactly why a missing Sent folder is NOT
 * an error: the message has already been delivered by the time we look, and
 * failing the tool over a filing problem would tell the user nothing was sent
 * when in fact it was.
 */
const SENT_FALLBACK_NAMES = ['sent', 'sent items', 'sent mail', 'sent messages', 'gesendet', 'envoyés', 'илгээсэн'];

/** Body parts larger than this are skipped rather than streamed into memory. */
const MAX_PART_BYTES = 2 * 1024 * 1024;

type BodyNode = {
  part?: string;
  type?: string;
  encoding?: string;
  size?: number;
  disposition?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: BodyNode[];
};

/** Run `task` against a freshly connected client and always log out after. */
export async function withClient<T>(settings: ImapSettings, task: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(buildClientOptions(settings));
  try {
    await client.connect();
  } catch (error) {
    throw new ImapMcpError(describeImapError(error));
  }
  try {
    return await task(client);
  } catch (error) {
    throw error instanceof ImapMcpError ? error : new ImapMcpError(describeImapError(error));
  } finally {
    try {
      await client.logout();
    } catch {
      // A failed logout after a successful read must not mask the result.
      client.close();
    }
  }
}

export async function listMailboxes(client: ImapFlow): Promise<MailboxInfo[]> {
  const boxes = await client.list();
  return boxes.map((box) => ({
    path: box.path,
    name: box.name,
    specialUse: box.specialUse ?? null,
    subscribed: box.subscribed === true,
  }));
}

/**
 * Find the Drafts mailbox.
 *
 * SPECIAL-USE (RFC 6154) is authoritative when the server publishes it. The
 * name fallback exists because plenty of self-hosted servers (and Proton
 * Bridge) do not, and "your draft was saved somewhere you cannot find" is a
 * worse failure than a heuristic.
 */
export async function resolveDraftsMailbox(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const flagged = boxes.find((box) => box.specialUse === '\\Drafts');
  if (flagged) return flagged.path;

  const byName = boxes.find((box) => DRAFTS_FALLBACK_NAMES.includes(box.name.toLocaleLowerCase()));
  if (byName) return byName.path;

  throw new ImapMcpError(
    'No Drafts mailbox found on this account. The server published no \\Drafts special-use flag ' +
      'and no folder is named "Drafts". Create one in your mail client, then try again.'
  );
}

/**
 * APPEND a built draft into the resolved Drafts mailbox.
 *
 * `mailbox` is the value {@link resolveDraftsMailbox} returned, never caller
 * input - see the module comment for why that restriction is load-bearing.
 */
export async function appendDraft(client: ImapFlow, mailbox: string, mime: Buffer): Promise<{ uid: number | null }> {
  const result = await client.append(mailbox, mime, ['\\Draft', '\\Seen'], new Date());
  const uid = result && typeof result === 'object' ? (result as { uid?: number }).uid : undefined;
  return { uid: typeof uid === 'number' ? uid : null };
}

/**
 * Find the Sent mailbox, or null when the account has none.
 *
 * Null rather than a throw, deliberately: this is only ever called AFTER a
 * message has already gone out, and turning "I could not find where to file
 * the copy" into a tool failure would report a successful send as a failure -
 * the single most dangerous lie this server could tell, because the obvious
 * user response is to send it again.
 */
export async function resolveSentMailbox(client: ImapFlow): Promise<string | null> {
  try {
    const boxes = await client.list();
    const flagged = boxes.find((box) => box.specialUse === '\\Sent');
    if (flagged) return flagged.path;
    const byName = boxes.find((box) => SENT_FALLBACK_NAMES.includes(box.name.toLocaleLowerCase()));
    return byName?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * APPEND a sent message into the resolved Sent mailbox, flagged `\Seen`.
 *
 * Like {@link appendDraft}, `mailbox` is what {@link resolveSentMailbox}
 * returned and never caller input. Failure is reported, not thrown, for the
 * reason given on `resolveSentMailbox`.
 */
export async function appendSentCopy(
  client: ImapFlow,
  mailbox: string,
  mime: Buffer
): Promise<{ uid: number | null; error: string | null }> {
  try {
    const result = await client.append(mailbox, mime, ['\\Seen'], new Date());
    const uid = result && typeof result === 'object' ? (result as { uid?: number }).uid : undefined;
    return { uid: typeof uid === 'number' ? uid : null, error: null };
  } catch (error) {
    return { uid: null, error: describeImapError(error) };
  }
}

export type SearchCriteria = {
  mailbox: string;
  query?: string;
  from?: string;
  unseenOnly?: boolean;
  sinceIsoDate?: string;
  limit: number;
};

/**
 * Search a mailbox and return header summaries, newest UID first.
 *
 * `client.search` with no criteria is invalid on some servers, so an empty
 * filter set falls back to `{ all: true }`.
 */
export async function searchSummaries(client: ImapFlow, criteria: SearchCriteria) {
  const lock = await client.getMailboxLock(criteria.mailbox);
  try {
    const search: Record<string, unknown> = {};
    if (criteria.query) search.or = [{ subject: criteria.query }, { body: criteria.query }];
    if (criteria.from) search.from = criteria.from;
    if (criteria.unseenOnly) search.seen = false;
    if (criteria.sinceIsoDate) {
      const since = new Date(criteria.sinceIsoDate);
      if (Number.isNaN(since.getTime())) {
        throw new ImapMcpError(`'${criteria.sinceIsoDate}' is not a parseable date. Use YYYY-MM-DD.`);
      }
      search.since = since;
    }

    // imapflow returns `false` (not an empty array) when the mailbox is closed
    // or the server rejects the criteria, so a bare spread would throw.
    const uids = await client.search(Object.keys(search).length > 0 ? search : { all: true }, { uid: true });
    const found: number[] = Array.isArray(uids) ? uids : [];
    const newestFirst = [...found].sort((a, b) => b - a).slice(0, criteria.limit);
    if (newestFirst.length === 0) return [];

    const rows: Array<{ uid: number; envelope?: unknown; flags?: Set<string>; bodyStructure?: BodyNode }> = [];
    for await (const message of client.fetch(
      newestFirst,
      { uid: true, envelope: true, flags: true, bodyStructure: true },
      { uid: true }
    )) {
      rows.push(message as (typeof rows)[number]);
    }
    return rows;
  } finally {
    lock.release();
  }
}

/** Fetch one message's envelope + body structure, without downloading parts. */
export async function fetchStructure(client: ImapFlow, mailbox: string, uid: number) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const message = await client.fetchOne(
      String(uid),
      { uid: true, envelope: true, flags: true, bodyStructure: true },
      { uid: true }
    );
    if (!message) throw new ImapMcpError(`No message with UID ${uid} in '${mailbox}'.`);
    return message as { uid: number; envelope?: unknown; flags?: Set<string>; bodyStructure?: BodyNode };
  } finally {
    lock.release();
  }
}

/**
 * Download the readable body of one message: text/plain if the sender provided
 * it, otherwise text/html converted to text. Attachment parts are never
 * downloaded here - see {@link collectAttachments}.
 */
export async function fetchBodyText(
  client: ImapFlow,
  mailbox: string,
  uid: number,
  structure: BodyNode | undefined
): Promise<{ text: string; truncated: boolean; contentType: string }> {
  const chosen = pickTextPart(structure);
  if (!chosen) return { text: '', truncated: false, contentType: 'none' };

  const lock = await client.getMailboxLock(mailbox);
  try {
    const download = await client.download(String(uid), chosen.part, { uid: true, maxBytes: MAX_PART_BYTES });
    if (!download?.content) return { text: '', truncated: false, contentType: chosen.type };
    const raw = await streamToString(download.content);
    const text = chosen.type === 'text/html' ? htmlToPlainText(raw) : raw;
    const truncated = text.length > MAX_BODY_CHARS;
    return {
      text: truncated ? `${text.slice(0, MAX_BODY_CHARS)}\n[... truncated ...]` : text,
      truncated,
      contentType: chosen.type,
    };
  } finally {
    lock.release();
  }
}

/**
 * Describe every attachment WITHOUT retrieving any of them.
 *
 * Returning metadata only is the whole design: an agent can tell the user
 * "there is a 2.4 MB invoice.pdf" without this server ever writing a file to
 * disk or pulling attacker-controlled bytes into the turn.
 */
export function collectAttachments(structure: BodyNode | undefined): AttachmentInfo[] {
  const found: AttachmentInfo[] = [];
  walk(structure, (node) => {
    const disposition = (node.disposition ?? '').toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    const isAttachment = disposition === 'attachment' || (disposition === 'inline' && Boolean(filename));
    if (!isAttachment || !node.part) return;
    found.push({
      partId: node.part,
      filename,
      contentType: node.type ?? 'application/octet-stream',
      sizeBytes: typeof node.size === 'number' ? node.size : null,
      disposition: node.disposition ?? null,
    });
  });
  return found;
}

export function hasAttachments(structure: BodyNode | undefined): boolean {
  return collectAttachments(structure).length > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** text/plain wins; text/html is the fallback; attachments are never chosen. */
function pickTextPart(structure: BodyNode | undefined): { part: string; type: string } | null {
  let plain: { part: string; type: string } | null = null;
  let html: { part: string; type: string } | null = null;
  walk(structure, (node) => {
    const disposition = (node.disposition ?? '').toLowerCase();
    if (disposition === 'attachment' || !node.part) return;
    if (node.type === 'text/plain' && !plain) plain = { part: node.part, type: node.type };
    if (node.type === 'text/html' && !html) html = { part: node.part, type: node.type };
  });
  // A single-part message has no childNodes and imapflow addresses it as '1'.
  if (!plain && !html && structure?.type?.startsWith('text/')) {
    return { part: structure.part ?? '1', type: structure.type };
  }
  return plain ?? html;
}

function walk(node: BodyNode | undefined, visit: (node: BodyNode) => void): void {
  if (!node) return;
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_PART_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Minimal HTML -> text for email bodies.
 *
 * Deliberately NOT `news/feedParser.toPlainText`: that one collapses all
 * whitespace, which is right for a one-line feed summary and wrong for an email
 * where paragraph breaks carry meaning. Scripts and styles are dropped outright
 * so their contents can never be presented to a model as message text.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
