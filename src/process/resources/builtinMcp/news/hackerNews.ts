/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hacker News via the public Firebase API (`hacker-news.firebaseio.com/v0`).
 *
 * No key, no account, no rate-limit header - but it is one story per request,
 * so a naive "top 30" is 31 requests. `fetchText` serialises per host, which
 * keeps us from hammering the API and is exactly the courtesy we want; the
 * limit cap below keeps the worst case bounded.
 */

import { NewsFetchError, type HackerNewsList, type NewsItem, type TextFetcher } from './types';

const API_BASE = 'https://hacker-news.firebaseio.com/v0';
export const MAX_HN_STORIES = 30;
export const DEFAULT_HN_STORIES = 10;

/** Story ids, most recent/highest first, per HN's own ordering. */
const LIST_PATHS: Readonly<Record<HackerNewsList, string>> = {
  top: 'topstories',
  new: 'newstories',
  best: 'beststories',
};

type HnStory = {
  id?: number;
  title?: string;
  url?: string;
  by?: string;
  time?: number;
  score?: number;
  descendants?: number;
  type?: string;
};

/**
 * Read one of the Hacker News lists and return it as normalised `NewsItem`s.
 * A story that fails to load individually is skipped rather than failing the
 * whole call - a single 500 on one item should not lose the other 29.
 */
export async function fetchHackerNews(
  fetchText: TextFetcher,
  list: HackerNewsList = 'top',
  limit: number = DEFAULT_HN_STORIES,
  timeoutMs?: number
): Promise<NewsItem[]> {
  const count = Math.min(Math.max(Math.trunc(limit), 1), MAX_HN_STORIES);
  const ids = await fetchStoryIds(fetchText, list, timeoutMs);

  const items: NewsItem[] = [];
  for (const id of ids.slice(0, count)) {
    const story = await fetchStory(fetchText, id, list, timeoutMs);
    if (story) items.push(story);
  }
  return items;
}

async function fetchStoryIds(fetchText: TextFetcher, list: HackerNewsList, timeoutMs?: number): Promise<number[]> {
  const path = LIST_PATHS[list] as string | undefined;
  if (!path) throw new NewsFetchError(`Unknown Hacker News list '${list}' - use top, new or best`);

  const body = await fetchText(`${API_BASE}/${path}.json`, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new NewsFetchError('Hacker News returned a response that is not JSON');
  }
  if (!Array.isArray(parsed)) throw new NewsFetchError('Hacker News returned no story list');
  return parsed.filter((id): id is number => typeof id === 'number');
}

async function fetchStory(
  fetchText: TextFetcher,
  id: number,
  list: HackerNewsList,
  timeoutMs?: number
): Promise<NewsItem | null> {
  let story: HnStory;
  try {
    story = JSON.parse(await fetchText(`${API_BASE}/item/${id}.json`, timeoutMs)) as HnStory;
  } catch {
    return null;
  }
  if (!story || typeof story.title !== 'string') return null;

  return {
    title: story.title,
    // Ask HNs (no external url) link to the discussion thread itself.
    link: story.url ?? `https://news.ycombinator.com/item?id=${id}`,
    publishedAt: typeof story.time === 'number' ? new Date(story.time * 1000).toISOString() : null,
    author: story.by ?? null,
    summary: `${story.score ?? 0} points, ${story.descendants ?? 0} comments - https://news.ycombinator.com/item?id=${id}`,
    source: 'Hacker News',
    feedUrl: `${API_BASE}/${LIST_PATHS[list]}.json`,
  };
}
