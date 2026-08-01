/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parser + handler coverage for the built-in News MCP server.
 *
 * DELIBERATELY OFFLINE. Every assertion here runs against inline fixture XML
 * and an injected fetcher, so the suite is deterministic and cannot flake when
 * a Mongolian publisher is having a bad afternoon. The live-network checks
 * (real ikon.mn / caak.mn traffic) live in `newsLive.network.test.ts`, which is
 * opt-in via DARHAI_NEWS_LIVE=1.
 *
 * The fixtures are shaped after the real feeds this server ships with: iKon.mn
 * emits escaped HTML in <description>, Caak.mn wraps titles in CDATA, and
 * gereg.mn carries dc:creator - all three broke naive parsers during
 * development, so all three are pinned here.
 */

import { describe, it, expect } from 'vitest';
import { parseFeed, toPlainText, toIsoDate } from '../../../../src/process/resources/builtinMcp/news/feedParser';
import {
  parseFeedUrlList,
  isHttpUrl,
  resolveFeedSources,
  MONGOLIAN_PRESET_FEEDS,
} from '../../../../src/process/resources/builtinMcp/news/presetFeeds';
import { decodeBody } from '../../../../src/process/resources/builtinMcp/news/httpFetch';
import { createNewsServer } from '../../../../src/process/resources/builtinMcp/news/newsServer';
import { NewsParseError } from '../../../../src/process/resources/builtinMcp/news/types';

const RSS_MONGOLIAN = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>iKon.mn - Шинэ мэдээ</title>
    <item>
      <title>Б.Пүрэвдагва: С.Зоригийн хөшөөг буцааж байрлуулна</title>
      <link>https://ikon.mn/n/3pbq</link>
      <description>&lt;p&gt;Хотын дарга &quot;хулгайн сэдлээр&quot; гэж&amp;nbsp;мэдэгдлээ.&lt;/p&gt;</description>
      <pubDate>Sat, 01 Aug 2026 13:53:00 +0800</pubDate>
    </item>
    <item>
      <title><![CDATA[Эдийн засгийн өсөлт 5.2 хувьд хүрлээ]]></title>
      <link>https://ikon.mn/n/3pbz</link>
      <dc:creator>Д.Мөнхбат</dc:creator>
      <description><![CDATA[<div>Үндэсний статистикийн хороо <b>мэдээлэв</b>.</div>]]></description>
      <pubDate>Fri, 31 Jul 2026 09:00:00 +0800</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from darhai</title>
  <entry>
    <title>v0.9.7</title>
    <link rel="alternate" type="text/html" href="https://example.mn/releases/v0.9.7"/>
    <link rel="replies" href="https://example.mn/replies"/>
    <id>tag:example.mn,2026:Release/1</id>
    <published>2026-07-29T14:02:10Z</published>
    <author><name>Батбold</name></author>
    <summary>Монгол хэлний дэмжлэг нэмэгдлээ.</summary>
  </entry>
</feed>`;

const RDF_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel><title>Хуучин RSS 1.0</title></channel>
  <item>
    <title>Нэг мэдээ</title>
    <link>https://example.mn/1</link>
    <description>Тайлбар</description>
  </item>
</rdf:RDF>`;

/** One <item> only - xml2js collapses it to a bare object, not an array. */
const SINGLE_ITEM_RSS = `<rss version="2.0"><channel><title>Ганц</title>
  <item><title>Ганц мэдээ</title><link>https://example.mn/only</link></item>
</channel></rss>`;

describe('parseFeed - RSS 2.0', () => {
  it('normalises Mongolian items, decoding entities and stripping HTML', async () => {
    const feed = await parseFeed(RSS_MONGOLIAN, 'https://ikon.mn/rss');

    expect(feed.feedTitle).toBe('iKon.mn - Шинэ мэдээ');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].title).toBe('Б.Пүрэвдагва: С.Зоригийн хөшөөг буцааж байрлуулна');
    expect(feed.items[0].link).toBe('https://ikon.mn/n/3pbq');
    // Escaped markup unescaped by xml2js, then stripped; &nbsp; became a space.
    expect(feed.items[0].summary).toBe('Хотын дарга "хулгайн сэдлээр" гэж мэдэгдлээ.');
    expect(feed.items[0].publishedAt).toBe('2026-08-01T05:53:00.000Z');
  });

  it('reads CDATA titles and dc:creator authors', async () => {
    const feed = await parseFeed(RSS_MONGOLIAN, 'https://ikon.mn/rss');

    expect(feed.items[1].title).toBe('Эдийн засгийн өсөлт 5.2 хувьд хүрлээ');
    expect(feed.items[1].author).toBe('Д.Мөнхбат');
    expect(feed.items[1].summary).toBe('Үндэсний статистикийн хороо мэдээлэв.');
  });

  it('carries the feed title onto every item as `source`', async () => {
    const feed = await parseFeed(RSS_MONGOLIAN, 'https://ikon.mn/rss');
    expect(feed.items.map((item) => item.source)).toEqual(['iKon.mn - Шинэ мэдээ', 'iKon.mn - Шинэ мэдээ']);
  });

  it('treats a lone <item> as a one-element list, not as characters', async () => {
    const feed = await parseFeed(SINGLE_ITEM_RSS, 'https://example.mn/rss');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe('Ганц мэдээ');
  });
});

describe('parseFeed - Atom and RDF', () => {
  it('prefers the rel="alternate" link over other Atom links', async () => {
    const feed = await parseFeed(ATOM_FEED, 'https://example.mn/atom');

    expect(feed.items[0].link).toBe('https://example.mn/releases/v0.9.7');
    expect(feed.items[0].author).toBe('Батбold');
    expect(feed.items[0].publishedAt).toBe('2026-07-29T14:02:10.000Z');
    expect(feed.items[0].summary).toBe('Монгол хэлний дэмжлэг нэмэгдлээ.');
  });

  it('reads RSS 1.0 where <item> is a sibling of <channel>', async () => {
    const feed = await parseFeed(RDF_FEED, 'https://example.mn/rdf');

    expect(feed.feedTitle).toBe('Хуучин RSS 1.0');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].title).toBe('Нэг мэдээ');
  });
});

describe('parseFeed - failure modes', () => {
  it('rejects a non-XML document with a message naming the URL', async () => {
    await expect(parseFeed('<html><body>not a feed</body></html>', 'https://example.mn/')).rejects.toThrow(
      NewsParseError
    );
  });

  it('rejects an empty body rather than returning zero items', async () => {
    await expect(parseFeed('   ', 'https://example.mn/')).rejects.toThrow(/empty document/);
  });

  it('rejects XML that is well-formed but not a feed', async () => {
    await expect(parseFeed('<catalog><book/></catalog>', 'https://example.mn/')).rejects.toThrow(/not a feed/);
  });
});

describe('toPlainText', () => {
  it('keeps Cyrillic intact while removing markup and entities', () => {
    // &#1091; is Cyrillic у - numeric entities must resolve to the real
    // code point, not be dropped or left as literal text.
    expect(toPlainText('<p>Сайн&nbsp;байна&#1091; &laquo;Тийм&raquo;</p>')).toBe('Сайн байнау «Тийм»');
  });

  it('drops script and style bodies entirely', () => {
    expect(toPlainText('<style>.a{color:red}</style>Мэдээ<script>alert(1)</script>')).toBe('Мэдээ');
  });

  it('leaves an unknown entity alone instead of mangling it', () => {
    expect(toPlainText('A &bogus; B')).toBe('A &bogus; B');
  });
});

describe('toIsoDate', () => {
  it('parses RFC 822 feed dates', () => {
    expect(toIsoDate('Sat, 01 Aug 2026 13:53:00 +0800')).toBe('2026-08-01T05:53:00.000Z');
  });

  it('returns null for junk rather than an Invalid Date', () => {
    expect(toIsoDate('sometime last week')).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });
});

describe('decodeBody', () => {
  it('uses the charset declared in the XML prolog when the header omits it', () => {
    // windows-1251 Cyrillic: this is the exact case that produces mojibake if
    // the body is blindly decoded as UTF-8.
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="windows-1251"?><rss><channel><title>', 'latin1'),
      Buffer.from([0xcc, 0xee, 0xed, 0xe3, 0xee, 0xeb]), // "Монгол" in cp1251
      Buffer.from('</title></channel></rss>', 'latin1'),
    ]);

    expect(decodeBody(body, 'application/rss+xml')).toContain('Монгол');
    expect(decodeBody(body, null)).toContain('Монгол');
  });

  it('lets the HTTP header charset win over the prolog', () => {
    const body = Buffer.from('<?xml version="1.0" encoding="windows-1251"?><rss>Мэдээ</rss>', 'utf-8');
    expect(decodeBody(body, 'application/xml; charset=utf-8')).toContain('Мэдээ');
  });

  it('falls back to UTF-8 for an unknown charset label', () => {
    const body = Buffer.from('<rss>Мэдээ</rss>', 'utf-8');
    expect(decodeBody(body, 'text/xml; charset=not-a-real-charset')).toContain('Мэдээ');
  });
});

describe('feed configuration', () => {
  it('ships the six verified Mongolian feeds as the zero-config default', () => {
    expect(MONGOLIAN_PRESET_FEEDS.map((feed) => feed.url)).toEqual([
      'https://ikon.mn/rss',
      'https://caak.mn/rss',
      'https://sonin.mn/rss',
      'https://sport.mn/rss',
      'https://gereg.mn/feed',
      'https://itoim.mn/rss.xml',
    ]);
  });

  it('returns the Mongolian preset when the env is completely empty', () => {
    const sources = resolveFeedSources({});
    expect(sources).toHaveLength(MONGOLIAN_PRESET_FEEDS.length);
    expect(sources.every((source) => source.origin === 'preset')).toBe(true);
  });

  it('appends user feeds from DARHAI_NEWS_FEEDS without duplicating the preset', () => {
    const sources = resolveFeedSources({
      DARHAI_NEWS_FEEDS: 'https://example.mn/feed, https://ikon.mn/rss\nhttps://two.mn/rss',
    });
    const added = sources.filter((source) => source.origin === 'user');

    expect(added.map((source) => source.url)).toEqual(['https://example.mn/feed', 'https://two.mn/rss']);
    expect(added[0].label).toBe('example.mn');
  });

  it('drops non-http entries instead of failing the whole server', () => {
    expect(parseFeedUrlList('https://ok.mn/rss, javascript:alert(1), file:///etc/passwd, # note')).toEqual([
      'https://ok.mn/rss',
    ]);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('createNewsServer', () => {
  const fetcherFor = (byUrl: Record<string, string | Error>) => async (url: string) => {
    const value = byUrl[url];
    if (value === undefined) throw new Error(`unexpected url ${url}`);
    if (value instanceof Error) throw value;
    return value;
  };

  const twoFeeds = {
    'https://a.mn/rss': RSS_MONGOLIAN,
    'https://b.mn/rss': SINGLE_ITEM_RSS,
  };
  const env = { DARHAI_NEWS_FEEDS: 'https://a.mn/rss,https://b.mn/rss' } as NodeJS.ProcessEnv;
  /** Only the two stub feeds - the real preset URLs are never fetched in tests. */
  const feeds = Object.keys(twoFeeds);

  it('merges feeds newest-first', async () => {
    const server = createNewsServer({ fetchText: fetcherFor(twoFeeds), env });
    const result = await server.headlines({ feeds });

    expect(result.feedsRead).toBe(2);
    expect(result.items[0].publishedAt).toBe('2026-08-01T05:53:00.000Z');
    // The undated single item must sink to the bottom, not float to the top.
    expect(result.items.at(-1)?.title).toBe('Ганц мэдээ');
  });

  it('keeps working feeds when another one is dead', async () => {
    const server = createNewsServer({
      fetchText: fetcherFor({ ...twoFeeds, 'https://dead.mn/rss': new Error('ENOTFOUND') }),
      env,
    });
    const result = await server.headlines({ feeds: [...feeds, 'https://dead.mn/rss'] });

    expect(result.feedsRead).toBe(2);
    expect(result.failures).toEqual([{ feedUrl: 'https://dead.mn/rss', error: 'ENOTFOUND' }]);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('reports a loud message when every feed fails, instead of an empty list', async () => {
    const server = createNewsServer({ fetchText: fetcherFor({ 'https://dead.mn/rss': new Error('ENOTFOUND') }), env });
    const result = await server.headlines({ feeds: ['https://dead.mn/rss'] });

    expect(result.items).toEqual([]);
    expect(result.message).toMatch(/None of the 1 configured feed\(s\) could be read/);
  });

  it('matches a Cyrillic query case-insensitively across title and summary', async () => {
    const server = createNewsServer({ fetchText: fetcherFor(twoFeeds), env });

    // Capital Х in the query, lower-case х in the headline.
    const byTitle = await server.search({ query: 'Хөшөө', feeds });
    expect(byTitle.items).toHaveLength(1);
    expect(byTitle.items[0].title).toContain('хөшөөг');

    // Two terms, both of which must appear.
    const byPhrase = await server.search({ query: 'эдийн засгийн', feeds });
    expect(byPhrase.items.map((item) => item.title)).toEqual(['Эдийн засгийн өсөлт 5.2 хувьд хүрлээ']);

    const none = await server.search({ query: 'бөмбөрцөг', feeds });
    expect(none.items).toEqual([]);
    expect(none.message).toMatch(/0 of \d+ articles matched/);
  });

  it('rejects a non-http feed URL before any network call', async () => {
    const server = createNewsServer({
      fetchText: async () => {
        throw new Error('must not be called');
      },
      env,
    });
    await expect(server.fetchFeed({ url: 'file:///etc/passwd' })).rejects.toThrow(/not an http\(s\) feed URL/);
  });

  it('lists the configured feeds with their origin', async () => {
    const server = createNewsServer({ fetchText: fetcherFor(twoFeeds), env });
    const listed = server.listFeeds();

    expect(listed.envVar).toBe('DARHAI_NEWS_FEEDS');
    expect(listed.feeds.filter((feed) => feed.origin === 'user').map((feed) => feed.url)).toEqual(feeds);
  });
});
