/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The curated Mongolian feed preset - the reason this server exists.
 *
 * Дархай is a Mongolian-first product, so a user who installs the News MCP and
 * configures NOTHING must still get Mongolian headlines on the first call.
 * Every URL below was verified live before it was added; each one serves a
 * well-formed RSS 2.0 document over HTTPS with UTF-8 Cyrillic.
 *
 * DELIBERATELY ABSENT: news.mn, montsame.mn, gogo.mn, eagle.mn, unuudur.mn and
 * mnb.mn publish no RSS at all - neither at the conventional paths nor via a
 * `<link rel="alternate">` declaration in their HTML. They are not missing by
 * oversight and must NOT be added by scraping their HTML: this server reads
 * feeds that publishers chose to publish, and nothing else.
 *
 * zarig.mn belongs in that list for a subtler reason worth writing down, because
 * a future reader WILL retry it. `https://zarig.mn/rss` answers `200 OK` - but
 * with `Content-Type: text/html` and an article page as the body. The site
 * serves a page for every unrecognised path, so a status-code check alone says
 * "the feed is fine" and the parser then yields nothing, forever, silently.
 * Verified 2026-08-01: /rss, /feed, /rss.xml and /feed/ all fail this way or
 * 404, and the homepage declares no alternate feed link.
 *
 * The rule this encodes: a feed is only added after its BODY parses into items.
 * A 200 proves a server answered, not that it published a feed.
 */

import { NEWS_FEEDS_ENV } from '../constants';
import type { FeedSource } from './types';

/** Verified-live Mongolian feeds, ordered by editorial breadth. */
export const MONGOLIAN_PRESET_FEEDS: readonly FeedSource[] = [
  { url: 'https://ikon.mn/rss', label: 'iKon.mn', origin: 'preset' },
  { url: 'https://caak.mn/rss', label: 'Caak.mn', origin: 'preset' },
  { url: 'https://sonin.mn/rss', label: 'Sonin.mn', origin: 'preset' },
  { url: 'https://sport.mn/rss', label: 'Sport.mn', origin: 'preset' },
  { url: 'https://gereg.mn/feed', label: 'Gereg', origin: 'preset' },
  { url: 'https://itoim.mn/rss.xml', label: 'ITOIM', origin: 'preset' },
] as const;

/**
 * Split the user's extra-feeds env var into URLs.
 * Accepts newline, comma or semicolon separation, ignores blanks and comments,
 * and silently drops anything that is not an absolute http(s) URL rather than
 * failing the whole server over one typo.
 */
export function parseFeedUrlList(raw: string | undefined): string[] {
  if (!raw) return [];
  const urls: string[] = [];
  for (const chunk of raw.split(/[\n,;]+/)) {
    const candidate = chunk.trim();
    if (candidate.length === 0 || candidate.startsWith('#')) continue;
    if (isHttpUrl(candidate)) urls.push(candidate);
  }
  return urls;
}

/** True for absolute http(s) URLs only - blocks file:, data: and friends. */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The feed list the tools operate on: the Mongolian preset plus anything the
 * user added via `DARHAI_NEWS_FEEDS`, de-duplicated with the preset winning
 * (so a user re-listing ikon.mn does not get every article twice).
 */
export function resolveFeedSources(env: NodeJS.ProcessEnv = process.env): FeedSource[] {
  const sources: FeedSource[] = [...MONGOLIAN_PRESET_FEEDS];
  const seen = new Set(sources.map((source) => source.url));

  for (const url of parseFeedUrlList(env[NEWS_FEEDS_ENV])) {
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, label: hostLabel(url), origin: 'user' });
  }

  return sources;
}

/** Fallback display name for a user-added feed, before we have read its title. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
