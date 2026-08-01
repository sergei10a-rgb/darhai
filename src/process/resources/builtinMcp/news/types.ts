/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared shapes for the built-in News / RSS MCP server.
 *
 * Everything here is normalised OUTPUT: whatever a feed calls its fields
 * (`pubDate` vs `published` vs `dc:date`, `description` vs `summary` vs
 * `content:encoded`), an agent only ever sees this one shape.
 */

/** One normalised article, whatever kind of feed it came from. */
export type NewsItem = {
  title: string;
  link: string;
  /** ISO 8601, or null when the feed omitted the date or it was unparseable. */
  publishedAt: string | null;
  author: string | null;
  /** Plain text - HTML tags and entities already stripped. */
  summary: string;
  /** Human-readable name of the feed this came from. */
  source: string;
  feedUrl: string;
};

/** A single feed, parsed. */
export type FeedResult = {
  feedUrl: string;
  feedTitle: string;
  items: NewsItem[];
};

/** A feed that could not be read, reported alongside the ones that worked. */
export type FeedFailure = {
  feedUrl: string;
  error: string;
};

/** A feed the server knows about, either curated or added by the user. */
export type FeedSource = {
  url: string;
  label: string;
  origin: 'preset' | 'user';
};

/** Which Hacker News list to read. */
export type HackerNewsList = 'top' | 'new' | 'best';

/**
 * Fetches a URL and returns decoded text. Injected so the parser and the
 * server can be unit-tested against fixtures with no network at all.
 */
export type TextFetcher = (url: string, timeoutMs?: number) => Promise<string>;

/** Thrown when a feed cannot be retrieved. Message is always user-readable. */
export class NewsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewsFetchError';
  }
}

/** Thrown when a document was retrieved but is not a feed we understand. */
export class NewsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewsParseError';
  }
}
