/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIVE NETWORK CHECK for the built-in News MCP server. OPT-IN ONLY.
 *
 *     DARHAI_NEWS_LIVE=1 node ./node_modules/vitest/vitest.mjs run \
 *       tests/unit/process/resources/newsLive.network.test.ts
 *
 * Why it is opt-in: these tests talk to real Mongolian publishers. A publisher
 * outage is not a Дархай regression, and a suite that goes red when caak.mn is
 * down teaches everyone to ignore red. The DETERMINISTIC coverage - parsing,
 * charset, Cyrillic search, failure handling - lives in
 * `newsFeedParser.test.ts` and always runs.
 *
 * What this file is for: catching the thing fixtures structurally cannot, i.e.
 * a preset feed that has gone away or changed shape since it was verified.
 * Run it before a release.
 */

import { describe, it, expect } from 'vitest';
import { createNewsServer } from '../../../../src/process/resources/builtinMcp/news/newsServer';
import { MONGOLIAN_PRESET_FEEDS } from '../../../../src/process/resources/builtinMcp/news/presetFeeds';

const LIVE = process.env.DARHAI_NEWS_LIVE === '1';
const TIMEOUT_MS = 60_000;

describe.skipIf(!LIVE)('News MCP against the live internet', () => {
  it(
    'reads every curated Mongolian feed and returns Cyrillic headlines',
    async () => {
      const server = createNewsServer({ env: {} });
      const result = await server.headlines({ limit: 40, perFeedLimit: 10 });

      expect(result.failures, `live feeds failed: ${JSON.stringify(result.failures)}`).toEqual([]);
      expect(result.feedsRead).toBe(MONGOLIAN_PRESET_FEEDS.length);
      expect(result.items.length).toBeGreaterThan(10);

      // Cyrillic must survive the whole path: bytes -> charset decode -> XML ->
      // entity decode. Mojibake would show up as Latin-1 gibberish here.
      const cyrillic = result.items.filter((item) => /[Ѐ-ӿ]/.test(item.title));
      expect(cyrillic.length).toBeGreaterThan(5);
      expect(result.items.every((item) => item.link.startsWith('http'))).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'finds Mongolian articles for a Cyrillic keyword',
    async () => {
      const server = createNewsServer({ env: {} });
      // "Монгол" appears constantly across Mongolian outlets; if this returns
      // nothing, matching (not the news cycle) is broken.
      const result = await server.search({ query: 'монгол', limit: 5 });

      expect(result.feedsRead).toBeGreaterThan(0);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items[0].title.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS
  );

  it(
    'reads Hacker News without any credentials',
    async () => {
      const server = createNewsServer({ env: {} });
      const result = await server.hackerNews({ list: 'top', limit: 3 });

      expect(result.items).toHaveLength(3);
      expect(result.items.every((item) => item.link.startsWith('http'))).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'fails fast on an unreachable host instead of hanging',
    async () => {
      const server = createNewsServer({ env: {} });
      const started = Date.now();

      await expect(
        server.fetchFeed({ url: 'https://this-host-does-not-exist-darhai-test.mn/rss', timeoutMs: 5_000 })
      ).rejects.toThrow(/could not be reached|did not respond/);

      expect(Date.now() - started).toBeLessThan(20_000);
    },
    TIMEOUT_MS
  );
});
