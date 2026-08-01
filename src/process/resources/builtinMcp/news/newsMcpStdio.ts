/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stdio MCP subprocess entrypoint for the built-in News / RSS server.
 *
 * Bundled by `scripts/build-mcp-servers.js` into `out/main/builtin-mcp-news.js`,
 * unpacked from the asar by `electron-builder.yml`, and spawned as a plain
 * `node` child. It needs nothing from the Electron app - only outbound HTTPS -
 * so, unlike `builtin-mcp-personal-data.js`, there is no loopback bridge here.
 *
 * Zero configuration required: with no env at all the tools read the curated
 * Mongolian feed preset. `DARHAI_NEWS_FEEDS` appends the user's own feeds.
 * NO API KEY IS EVER REQUIRED, for any tool.
 *
 * NOTE: stdout is the MCP transport. Diagnostics must go to stderr only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_NEWS_NAME, NEWS_FEEDS_ENV } from '../constants';
import { createNewsServer, MAX_ITEMS, DEFAULT_ITEMS } from './newsServer';
import { MAX_HN_STORIES, DEFAULT_HN_STORIES } from './hackerNews';
import { MONGOLIAN_PRESET_FEEDS } from './presetFeeds';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './httpFetch';

const PRESET_SUMMARY = MONGOLIAN_PRESET_FEEDS.map((feed) => feed.label).join(', ');

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_ITEMS)
  .optional()
  .describe(`Optional. Maximum articles to return (default ${DEFAULT_ITEMS}, max ${MAX_ITEMS}).`);

const feedsSchema = z
  .array(z.string().url())
  .optional()
  .describe('Optional. Feed URLs to read INSTEAD of the configured ones. Any RSS 2.0 or Atom URL works.');

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    `Optional. Per-request deadline in milliseconds (default ${DEFAULT_TIMEOUT_MS}). A slow feed always fails with an error rather than hanging.`
  );

/** Every tool answers with pretty JSON; failures answer with `isError` text. */
async function respond(toolName: string, run: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `${toolName} error: ${message}` }], isError: true };
  }
}

function registerTools(server: McpServer, handler: ReturnType<typeof createNewsServer>): void {
  server.tool(
    'news_list_feeds',
    `List the feeds this server reads. Out of the box these are curated Mongolian outlets (${PRESET_SUMMARY}); a user can append their own by setting ${NEWS_FEEDS_ENV} to a comma- or newline-separated list of feed URLs. Read-only, no network access.`,
    {},
    async () => respond('news_list_feeds', async () => handler.listFeeds())
  );

  server.tool(
    'news_headlines',
    `Latest articles across every configured feed, newest first. With no arguments this returns current MONGOLIAN news (${PRESET_SUMMARY}) - no API key and no setup needed. Each article has title, link, publishedAt (ISO 8601), author, summary and source. Feeds that fail are reported in \`failures\` while the rest still return.`,
    {
      feeds: feedsSchema,
      limit: limitSchema,
      perFeedLimit: z
        .number()
        .int()
        .positive()
        .max(MAX_ITEMS)
        .optional()
        .describe('Optional. Max articles taken from each feed before merging (default 15).'),
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('news_headlines', async () => handler.headlines(args))
  );

  server.tool(
    'news_search',
    'Keyword search across the configured feeds. All whitespace-separated terms must appear in an article title, summary or author. Matching is case-insensitive and works for Cyrillic as well as Latin script, so a Mongolian query such as "эдийн засаг" matches Mongolian headlines directly.',
    {
      query: z.string().min(1).describe('Keywords to match. Mongolian Cyrillic is fully supported.'),
      feeds: feedsSchema,
      limit: limitSchema,
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('news_search', async () => handler.search(args))
  );

  server.tool(
    'news_fetch_feed',
    'Fetch and parse ONE feed by URL - RSS 2.0, RSS 1.0 (RDF) or Atom. Use this for a feed that is not in the configured list. Returns the feed title plus normalised articles. Never modifies anything.',
    {
      url: z.string().url().describe('Absolute http(s) URL of an RSS or Atom feed.'),
      limit: limitSchema,
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('news_fetch_feed', async () => handler.fetchFeed(args))
  );

  server.tool(
    'news_hacker_news',
    `Hacker News stories from the public Firebase API - no account or key. \`list\` picks top (front page), new (most recent) or best (highest rated). Returns up to ${MAX_HN_STORIES} stories with score and comment count.`,
    {
      list: z.enum(['top', 'new', 'best']).optional().describe('Which list to read (default "top").'),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_HN_STORIES)
        .optional()
        .describe(`Optional. Number of stories (default ${DEFAULT_HN_STORIES}, max ${MAX_HN_STORIES}).`),
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('news_hacker_news', async () => handler.hackerNews(args))
  );
}

async function main(): Promise<void> {
  const server = new McpServer({ name: BUILTIN_NEWS_NAME, version: '1.0.0' });
  registerTools(server, createNewsServer());
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('[NewsMCP] Fatal error:', error);
  process.exit(1);
});
