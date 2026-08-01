/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool bodies for the built-in News / RSS MCP server.
 *
 * Returns a plain handler object (no transport), the same shape as
 * `createSearchSkillsServer`, so the stdio entrypoint stays thin and every
 * behaviour here is unit-testable against fixtures by injecting `fetchText`.
 *
 * READ-ONLY BY CONSTRUCTION: the only side effect any handler can have is an
 * HTTP GET. Nothing writes to disk, to config, or to the app.
 */

import { fetchText as defaultFetchText, DEFAULT_TIMEOUT_MS } from './httpFetch';
import { parseFeed } from './feedParser';
import { fetchHackerNews, DEFAULT_HN_STORIES } from './hackerNews';
import { isHttpUrl, resolveFeedSources } from './presetFeeds';
import {
  NewsFetchError,
  type FeedFailure,
  type FeedSource,
  type HackerNewsList,
  type NewsItem,
  type TextFetcher,
} from './types';

export const MAX_ITEMS = 100;
export const DEFAULT_ITEMS = 20;
/** Per feed, before merging - keeps one high-volume feed from crowding out the rest. */
const DEFAULT_PER_FEED = 15;

export type NewsServerDeps = {
  fetchText?: TextFetcher;
  env?: NodeJS.ProcessEnv;
};

export type MultiFeedResult = {
  items: NewsItem[];
  feedsRead: number;
  failures: FeedFailure[];
  message?: string;
};

export const createNewsServer = (deps: NewsServerDeps = {}) => {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const env = deps.env ?? process.env;

  /** Read + parse one feed. Errors are the caller's to catch. */
  const readFeed = async (url: string, timeoutMs: number) => parseFeed(await fetchText(url, timeoutMs), url);

  /**
   * Read several feeds, keeping partial success: a dead feed lands in
   * `failures` and the working ones still return their articles.
   *
   * `allSettled` looks like it hammers everything at once, but `fetchText`
   * serialises per host, so this is "one host at a time, hosts in parallel" -
   * which is the courtesy behaviour we want, not a thundering herd.
   */
  const readMany = async (urls: readonly string[], perFeed: number, timeoutMs: number): Promise<MultiFeedResult> => {
    const failures: FeedFailure[] = [];
    const items: NewsItem[] = [];
    let feedsRead = 0;

    const settled = await Promise.allSettled(urls.map((url) => readFeed(url, timeoutMs)));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failures.push({ feedUrl: urls[index], error: errorText(outcome.reason) });
        return;
      }
      feedsRead += 1;
      items.push(...outcome.value.items.slice(0, perFeed));
    });

    return { items: sortByDateDesc(items), feedsRead, failures };
  };

  return {
    /** The feeds the zero-config tools read, and where each one came from. */
    listFeeds(): { feeds: FeedSource[]; envVar: string } {
      return { feeds: resolveFeedSources(env), envVar: 'DARHAI_NEWS_FEEDS' };
    },

    /** One feed, any RSS 2.0 / RSS 1.0 / Atom URL. */
    async fetchFeed({ url, limit = DEFAULT_ITEMS, timeoutMs = DEFAULT_TIMEOUT_MS }: FetchFeedInput) {
      if (!isHttpUrl(url)) throw new NewsFetchError(`'${url}' is not an http(s) feed URL`);
      const feed = await readFeed(url, timeoutMs);
      return { ...feed, items: feed.items.slice(0, clampLimit(limit)) };
    },

    /** Latest across every configured feed (Mongolian preset by default). */
    async headlines({
      feeds,
      limit = DEFAULT_ITEMS,
      perFeedLimit = DEFAULT_PER_FEED,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }: HeadlinesInput = {}): Promise<MultiFeedResult> {
      const urls = selectUrls(feeds, env);
      const result = await readMany(urls, clampLimit(perFeedLimit), timeoutMs);
      return withMessage({ ...result, items: result.items.slice(0, clampLimit(limit)) }, urls.length);
    },

    /**
     * Keyword filter across the configured feeds. All whitespace-separated
     * terms must appear somewhere in title, summary or author. Matching is
     * case-insensitive via `toLocaleLowerCase`, which is correct for Cyrillic.
     */
    async search({
      query,
      feeds,
      limit = DEFAULT_ITEMS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }: SearchInput): Promise<MultiFeedResult & { query: string }> {
      const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) throw new NewsFetchError('Search query is empty');

      const urls = selectUrls(feeds, env);
      const result = await readMany(urls, MAX_ITEMS, timeoutMs);
      const matches = result.items.filter((item) => matchesAllTerms(item, terms));
      // `withMessage` owns the total-failure message; only describe the match
      // count when at least one feed actually produced articles, otherwise
      // "0 matched" would hide the real cause (every feed was unreachable).
      const scanned = { ...result, items: matches.slice(0, clampLimit(limit)) };

      return {
        ...withMessage(scanned, urls.length),
        query,
        ...(result.feedsRead > 0
          ? { message: `${matches.length} of ${result.items.length} articles matched '${query}'.` }
          : {}),
      };
    },

    /** Hacker News top / new / best - public API, no key. */
    async hackerNews({
      list = 'top',
      limit = DEFAULT_HN_STORIES,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }: HackerNewsInput = {}) {
      return { list, items: await fetchHackerNews(fetchText, list, limit, timeoutMs) };
    },
  };
};

export type FetchFeedInput = { url: string; limit?: number; timeoutMs?: number };
export type HeadlinesInput = { feeds?: string[]; limit?: number; perFeedLimit?: number; timeoutMs?: number };
export type SearchInput = { query: string; feeds?: string[]; limit?: number; timeoutMs?: number };
export type HackerNewsInput = { list?: HackerNewsList; limit?: number; timeoutMs?: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ad-hoc feed list wins; otherwise the preset + the user's env additions. */
function selectUrls(feeds: string[] | undefined, env: NodeJS.ProcessEnv): string[] {
  const explicit = (feeds ?? []).filter(isHttpUrl);
  return explicit.length > 0 ? explicit : resolveFeedSources(env).map((source) => source.url);
}

function matchesAllTerms(item: NewsItem, terms: readonly string[]): boolean {
  const haystack = `${item.title} ${item.summary} ${item.author ?? ''}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Newest first; undated items sink to the bottom rather than jumping to the top. */
function sortByDateDesc(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const left = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
    const right = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
    return right - left;
  });
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || DEFAULT_ITEMS, 1), MAX_ITEMS);
}

/** Make total feed failure loud instead of returning a silent empty list. */
function withMessage(result: MultiFeedResult, requested: number): MultiFeedResult {
  if (result.feedsRead > 0) return result;
  const detail = result.failures.map((failure) => `${failure.feedUrl}: ${failure.error}`).join('; ');
  return { ...result, message: `None of the ${requested} configured feed(s) could be read. ${detail}`.trim() };
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
