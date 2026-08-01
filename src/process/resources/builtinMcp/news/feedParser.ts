/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RSS 2.0 / RSS 1.0 (RDF) / Atom -> `NewsItem[]`.
 *
 * Parsing is delegated to `xml2js` (a real SAX parser, already a direct
 * dependency) rather than regexes, because feeds in the wild nest markup
 * inside CDATA and a regex parser silently truncates those items.
 *
 * xml2js unwraps CDATA and decodes the five XML predefined entities. It does
 * NOT decode HTML entities such as `&nbsp;`, and it does not strip the HTML
 * that publishers put inside `<description>` - `toPlainText` finishes the job
 * so an agent gets readable prose rather than markup.
 */

import { parseStringPromise } from 'xml2js';
import { NewsParseError, type FeedResult, type NewsItem } from './types';

/** Summaries longer than this are truncated - agents want a gist, not the article. */
const MAX_SUMMARY_CHARS = 600;

type XmlNode = Record<string, unknown>;

/**
 * Parse a feed document into normalised items.
 * Throws `NewsParseError` when the document is not XML or not a feed.
 */
export async function parseFeed(xml: string, feedUrl: string): Promise<FeedResult> {
  const document = await parseDocument(xml, feedUrl);
  const rss = asNode(document.rss);
  if (rss) return fromRssChannel(asNode(rss.channel), feedUrl);

  const atom = asNode(document.feed);
  if (atom) return fromAtomFeed(atom, feedUrl);

  // RSS 1.0 / RDF: `<item>` elements are siblings of `<channel>`, not children.
  const rdf = asNode(document['rdf:RDF']) ?? asNode(document.RDF);
  if (rdf) {
    const channel = asNode(rdf.channel);
    return {
      feedUrl,
      feedTitle: text(channel?.title) || feedUrl,
      items: toArray(rdf.item).map((raw) => rssItem(raw, feedUrl, text(channel?.title) || feedUrl)),
    };
  }

  throw new NewsParseError(
    `${feedUrl} is XML but not a feed - expected a root <rss>, <feed> or <rdf:RDF> element, got <${Object.keys(document)[0] ?? '?'}>`
  );
}

async function parseDocument(xml: string, feedUrl: string): Promise<XmlNode> {
  if (xml.trim().length === 0) throw new NewsParseError(`${feedUrl} returned an empty document`);
  try {
    return (await parseStringPromise(xml, { explicitArray: false, trim: true })) as XmlNode;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new NewsParseError(`${feedUrl} is not valid XML: ${detail}`);
  }
}

function fromRssChannel(channel: XmlNode | null, feedUrl: string): FeedResult {
  if (!channel) throw new NewsParseError(`${feedUrl} has an <rss> root with no <channel>`);
  const feedTitle = text(channel.title) || feedUrl;
  return {
    feedUrl,
    feedTitle,
    items: toArray(channel.item).map((raw) => rssItem(raw, feedUrl, feedTitle)),
  };
}

function fromAtomFeed(feed: XmlNode, feedUrl: string): FeedResult {
  const feedTitle = text(feed.title) || feedUrl;
  return {
    feedUrl,
    feedTitle,
    items: toArray(feed.entry).map((raw) => atomEntry(raw, feedUrl, feedTitle)),
  };
}

function rssItem(raw: unknown, feedUrl: string, feedTitle: string): NewsItem {
  const node = asNode(raw) ?? {};
  const body = node.description ?? node['content:encoded'] ?? node.summary;
  return {
    title: toPlainText(text(node.title)) || '(untitled)',
    link: text(node.link) || text(node.guid) || '',
    publishedAt: toIsoDate(text(node.pubDate) || text(node['dc:date']) || text(node.date)),
    author: toPlainText(text(node.author) || text(node['dc:creator'])) || null,
    summary: truncate(toPlainText(text(body))),
    source: feedTitle,
    feedUrl,
  };
}

function atomEntry(raw: unknown, feedUrl: string, feedTitle: string): NewsItem {
  const node = asNode(raw) ?? {};
  const author = asNode(node.author);
  const body = node.summary ?? node.content;
  return {
    title: toPlainText(text(node.title)) || '(untitled)',
    link: atomLink(node.link) || text(node.id),
    publishedAt: toIsoDate(text(node.published) || text(node.updated)),
    author: toPlainText(text(author?.name) || text(node.author)) || null,
    summary: truncate(toPlainText(text(body))),
    source: feedTitle,
    feedUrl,
  };
}

/**
 * Atom links are attributes, and an entry may carry several (`alternate`,
 * `replies`, `enclosure`). Prefer the alternate/self HTML link; fall back to
 * the first href present.
 */
function atomLink(value: unknown): string {
  const links = toArray(value);
  const hrefs = links
    .map((link) => {
      const node = asNode(link);
      const attrs = asNode(node?.$);
      return { href: text(attrs?.href) || text(link), rel: text(attrs?.rel) };
    })
    .filter((entry) => entry.href.length > 0);
  return (hrefs.find((entry) => entry.rel === 'alternate' || entry.rel === '')?.href ?? hrefs[0]?.href) || '';
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
};

/**
 * Strip HTML and decode entities, leaving readable plain text.
 * Cyrillic passes through untouched: nothing here is ASCII-only.
 */
export function toPlainText(value: string): string {
  if (value.length === 0) return '';
  const withoutBlocks = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withBreaks = withoutBlocks.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ').replace(/<br\s*\/?>/gi, ' ');
  const withoutTags = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function truncate(value: string): string {
  return value.length <= MAX_SUMMARY_CHARS ? value : `${value.slice(0, MAX_SUMMARY_CHARS).trimEnd()}…`;
}

/** Feed dates come in RFC 822 and ISO 8601; both are `Date`-parseable. */
export function toIsoDate(value: string): string | null {
  if (value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// xml2js shape helpers
// ---------------------------------------------------------------------------

function asNode(value: unknown): XmlNode | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as XmlNode) : null;
}

/** xml2js with `explicitArray:false` collapses a single child to a bare value. */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Read the text of a node that may be a string, or an object carrying `_`
 * (element with attributes) - e.g. `<title type="html">…</title>`.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  const node = asNode(value);
  if (node && typeof node._ === 'string') return node._.trim();
  return '';
}
