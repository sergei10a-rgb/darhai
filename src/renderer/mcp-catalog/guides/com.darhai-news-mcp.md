---
guideVersion: 2.0.0
estimatedMinutes: 1
steps:
  - id: install
    title: Install the MCP server
    estSeconds: 30
    autoCompletedByInstall: true
    body: |
      Дархай bundles the News server as `builtin-mcp-news.js` - nothing to
      download, no account, no API key at any point.

      It is ready the moment it is installed: ask for the news and you get
      today's Mongolian headlines from iKon.mn, Caak.mn, Sonin.mn, Sport.mn,
      Gereg and ITOIM. Hacker News and any RSS or Atom feed on the web work
      the same way, with no credentials.
  - id: feeds
    title: (Optional) Add your own feeds
    estSeconds: 30
    inputs:
      - { name: DARHAI_NEWS_FEEDS, label: 'Extra feed URLs (comma or newline separated)', secret: false }
    body: |
      Leave this blank unless you want to follow something beyond the curated
      Mongolian outlets.

      Paste any RSS 2.0 or Atom feed URLs, separated by commas or newlines:

      ```
      https://news.ycombinator.com/rss
      https://blog.mn/feed
      ```

      Your feeds are ADDED to the Mongolian ones - they never replace them.
      You can also hand a one-off feed URL straight to the `news_fetch_feed`
      tool without saving anything here.
---

# News & RSS setup

No key. No account. Nothing to configure.

## What you get immediately

| Tool               | What it does                                                  |
| ------------------ | ------------------------------------------------------------- |
| `news_headlines`   | Today's Mongolian news across all curated feeds, newest first |
| `news_search`      | Keyword search across those feeds - Mongolian Cyrillic works  |
| `news_list_feeds`  | Shows exactly which feeds are being read                      |
| `news_fetch_feed`  | Any single RSS 2.0, RSS 1.0 or Atom URL you name              |
| `news_hacker_news` | Hacker News top / new / best, via the public API              |

Every tool is read-only: the server can fetch pages, and nothing else.

## The curated Mongolian feeds

`https://ikon.mn/rss`, `https://caak.mn/rss`, `https://sonin.mn/rss`,
`https://sport.mn/rss`, `https://gereg.mn/feed`, `https://itoim.mn/rss.xml`

These were each verified live before shipping.

Some large Mongolian outlets - news.mn, montsame.mn, gogo.mn, eagle.mn,
unuudur.mn, mnb.mn - publish no RSS feed at all. They are absent on purpose:
this server reads feeds publishers chose to publish and never scrapes a site
that has not offered one.

## Step 2 - your own feeds (optional)

Set `DARHAI_NEWS_FEEDS` to any feed URLs you want added to the list. Skipping
this step costs you nothing - the Mongolian feeds and Hacker News work either
way.
