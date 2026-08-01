/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single network primitive of the News MCP server.
 *
 * Three things it must get right, all of which have bitten feed readers before:
 *
 *  1. **Never hang.** Every request carries an AbortController deadline. A feed
 *     that stops responding mid-body fails with a readable message instead of
 *     wedging the agent's turn forever.
 *  2. **Charset.** Feeds routinely declare their encoding in the XML prolog and
 *     NOT in the HTTP header. Decoding such a document as UTF-8 turns Cyrillic
 *     into mojibake. We therefore read raw bytes and pick the label from the
 *     header first, the prolog second, UTF-8 last.
 *  3. **Courtesy.** Requests to one host are serialised with a minimum gap, so
 *     asking for six feeds never turns into six simultaneous hits on one
 *     publisher. A real User-Agent identifies Дархай so operators can see who
 *     we are.
 */

import { NewsFetchError } from './types';
import { isHttpUrl } from './presetFeeds';

export const DEFAULT_TIMEOUT_MS = 12_000;
export const MAX_TIMEOUT_MS = 60_000;
/** Feeds are text; anything past this is a misconfiguration, not an article list. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Minimum gap between two requests to the same host. */
const HOST_COOLDOWN_MS = 250;

export const NEWS_USER_AGENT = 'Darhai/1.0 (+https://github.com/sergei10a-rgb/darhai) news-mcp';

/** Tail of the in-flight chain per host, so same-host requests never overlap. */
const hostChains = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier task for the same host has settled, plus a
 * short cooldown. Failures do not poison the chain for later callers.
 */
export function withHostQueue<T>(url: string, task: () => Promise<T>): Promise<T> {
  const host = safeHost(url);
  const previous: Promise<unknown> = hostChains.get(host) ?? Promise.resolve();
  const run: Promise<T> = previous
    .catch((): void => undefined)
    .then(async (): Promise<T> => {
      const result = await task();
      await delay(HOST_COOLDOWN_MS);
      return result;
    });
  hostChains.set(
    host,
    run.catch((): void => undefined)
  );
  return run;
}

/**
 * Fetch a URL and return its body decoded with the right charset.
 * Throws `NewsFetchError` with a message safe to show a user; never hangs.
 */
export async function fetchText(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<string> {
  if (!isHttpUrl(url)) {
    throw new NewsFetchError(`Not an http(s) URL: ${url}`);
  }
  const budget = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);

  return withHostQueue(url, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': NEWS_USER_AGENT,
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.8, */*;q=0.5',
          'accept-language': 'mn,en;q=0.7',
        },
      });
      if (!response.ok) {
        throw new NewsFetchError(`${url} returned HTTP ${response.status} ${response.statusText}`.trim());
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) {
        throw new NewsFetchError(`${url} returned ${bytes.byteLength} bytes, over the ${MAX_BODY_BYTES}-byte cap`);
      }
      return decodeBody(bytes, response.headers.get('content-type'));
    } catch (error) {
      throw toFetchError(error, url, budget);
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Decode raw bytes using the header charset, then the XML prolog, then UTF-8. */
export function decodeBody(bytes: Buffer, contentType: string | null): string {
  const fromHeader = charsetFromContentType(contentType);
  const label = fromHeader ?? charsetFromProlog(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // Unknown/unsupported label (e.g. a typo'd charset): UTF-8 is the only
    // sane fallback and is right for the overwhelming majority of feeds.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Read `<?xml version="1.0" encoding="windows-1251"?>` from the first bytes.
 * The prolog is ASCII-compatible in every encoding we could plausibly meet,
 * so latin1-decoding the head to find it is safe.
 */
function charsetFromProlog(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 200).toString('latin1');
  const match = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  return match ? match[1].toLowerCase() : null;
}

/** Turn any thrown value into a NewsFetchError with an actionable message. */
function toFetchError(error: unknown, url: string, budget: number): NewsFetchError {
  if (error instanceof NewsFetchError) return error;
  if (error instanceof Error && error.name === 'AbortError') {
    return new NewsFetchError(`${url} did not respond within ${budget}ms`);
  }
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const detail = cause?.code ?? (error instanceof Error ? error.message : String(error));
  return new NewsFetchError(`${url} could not be reached: ${detail}`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
