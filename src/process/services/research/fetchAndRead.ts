/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one genuinely-new primitive the Deep Research loop needs.
 *
 * Darhai's `web_search` builtin returns snippets only - never a full page body.
 * `fetchAndRead` closes that gap: it turns a URL into readable text via one of
 * two paths, in preference order:
 *
 *   1. Firecrawl - when a `firecrawl` tool key is stored, POST the URL to
 *      Firecrawl's `/v1/scrape` endpoint (Bearer auth) and take the clean
 *      markdown it returns.
 *   2. Fallback - a plain `fetch` with a 10s abort budget, then a tiny
 *      tag-stripping readability pass (mirrors Odysseus `fetch_webpage_content`).
 *
 * The extracted text is capped at ~15k chars at a paragraph boundary so a huge
 * page can't blow up the extractor's context (mirrors deep_research.py:620-628).
 *
 * SAFETY: the returned `content` is UNTRUSTED input. This module only fetches +
 * cleans; it never feeds the text to a model. The {@link ResearchService} wraps
 * it with `wrapUntrusted` before the extractor ever sees it.
 */

const FETCH_TIMEOUT_MS = 10_000;
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
/** Hard cap on returned readable text (chars). Matches Odysseus max_content_chars. */
export const MAX_CONTENT_CHARS = 15_000;
/** Only snap to a paragraph boundary if it keeps at least this fraction of the cap. */
const PARA_BOUNDARY_MIN_RATIO = 0.8;

/** Result of a fetch attempt. `success` is false on any network / parse failure. */
export type FetchAndReadResult = {
  success: boolean;
  /** Best-effort page title (may be empty). */
  title: string;
  /** Readable body text, capped + cleaned. Empty when `success` is false. */
  content: string;
};

export type FetchAndReadDeps = {
  /** Stored Firecrawl key (enables the clean-markdown path). Absent -> fallback. */
  firecrawlKey?: string | undefined;
  /** Fetch implementation (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (defaults to 10_000). */
  timeoutMs?: number;
};

const EMPTY: FetchAndReadResult = { success: false, title: '', content: '' };

/**
 * Cap `text` at {@link MAX_CONTENT_CHARS}, preferring a paragraph boundary so the
 * cut lands between paragraphs rather than mid-sentence when one is close enough.
 */
export function capAtBoundary(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  const truncated = text.slice(0, MAX_CONTENT_CHARS);
  const lastPara = truncated.lastIndexOf('\n\n');
  if (lastPara > MAX_CONTENT_CHARS * PARA_BOUNDARY_MIN_RATIO) {
    return truncated.slice(0, lastPara);
  }
  return truncated;
}

/**
 * Strip HTML to readable text: drop script/style/noscript blocks, extract the
 * <title>, remove all remaining tags, decode a handful of common entities, and
 * collapse whitespace. Deliberately tiny (no DOM, no dependency) - the extractor
 * model does the real comprehension.
 */
export function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Turn block-level closers into paragraph breaks so capAtBoundary has anchors.
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?\s*>/gi, '\n');

  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim();

  return { title, text };
}

/** Decode the small set of HTML entities that actually matter for readable text. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    });
}

/**
 * Fetch a URL and return readable text. Never throws - any failure resolves to
 * `{ success: false }` so a single bad source never rejects the research round.
 */
export async function fetchAndRead(url: string, deps: FetchAndReadDeps = {}): Promise<FetchAndReadResult> {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) return EMPTY;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const key = deps.firecrawlKey?.trim();

  if (key) {
    const viaFirecrawl = await fetchViaFirecrawl(trimmed, key, fetchImpl, timeoutMs);
    if (viaFirecrawl.success) return viaFirecrawl;
    // Firecrawl failed (rate-limit / outage) - fall through to the direct path.
  }

  return fetchDirect(trimmed, fetchImpl, timeoutMs);
}

/** Firecrawl `/v1/scrape` path: returns clean markdown when available. */
async function fetchViaFirecrawl(
  url: string,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<FetchAndReadResult> {
  try {
    const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return EMPTY;
    const data = (await res.json()) as {
      data?: { markdown?: unknown; metadata?: { title?: unknown } };
    };
    const markdown = typeof data.data?.markdown === 'string' ? data.data.markdown : '';
    if (!markdown.trim()) return EMPTY;
    const title = typeof data.data?.metadata?.title === 'string' ? data.data.metadata.title : '';
    return { success: true, title, content: capAtBoundary(markdown) };
  } catch {
    return EMPTY;
  }
}

/** Direct fetch + HTML strip path (no key required). */
async function fetchDirect(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<FetchAndReadResult> {
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Darhai/1.0 (research)' },
      redirect: 'follow',
    });
    if (!res.ok) return EMPTY;
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();
    // Plain text / markdown responses need no stripping.
    if (/text\/(plain|markdown)/i.test(contentType) || !/</.test(raw.slice(0, 200))) {
      const text = raw.trim();
      return text ? { success: true, title: '', content: capAtBoundary(text) } : EMPTY;
    }
    const { title, text } = stripHtml(raw);
    if (!text) return EMPTY;
    return { success: true, title, content: capAtBoundary(text) };
  } catch {
    return EMPTY;
  }
}
