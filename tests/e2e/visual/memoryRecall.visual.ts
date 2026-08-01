/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Memory has to be readable after it is written - by the real app, through the
 * real bridge, in Mongolian Cyrillic, and after a restart.
 *
 * The defect this guards: every user-facing save path returned `{ok: true}`,
 * wrote a real file to `~/.ijfw/memory/`, and was then never findable, because
 * the index built its roots exclusively from `~/.ijfw/registry.md` - a file
 * nothing in Darhai ever wrote and which does not exist on a fresh machine.
 * `memory.get-stats` reported an all-zero snapshot forever while the bytes sat
 * on disk. Search had an independent defect: the vector lane returned its
 * entire result list whenever its top hit cleared a threshold, so every query -
 * including gibberish - returned the whole corpus.
 *
 * `DARHAI_IJFW_HOME` points the whole subsystem at a throwaway directory so
 * this spec exercises the production code path without writing into (or reading
 * from) the developer's own memory store.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, quitVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

/** Distinct per run so a leftover store can never make an assertion pass. */
const RUN_TAG = `MEM${Date.now().toString(36).toUpperCase()}`;
const LATIN_TEXT = `${RUN_TAG}-LATIN Darhai memory must be recallable after it is stored`;
const CYRILLIC_TEXT = `${RUN_TAG}-KIRILL Дархай санах ойн шалгалт: кирилл бичвэр эргэн олдох ёстой`;

const QUICK_ADD = 'memory.set-quick-add';
const LIST_ENTRIES = 'memory.list-entries';
const GET_STATS = 'memory.get-stats';
const INGEST_FILES = 'memory.ingest-files';

type ListResult = { entries: Array<{ summary: string; project: string }>; total: number };
type StatsResult = { ok: boolean; stats?: { total: number; projects: number } };

let ijfwHome: string;
let visual: VisualApp;

async function search(query: string): Promise<ListResult> {
  return invokeBridge<ListResult>(visual.page, LIST_ENTRIES, { search: query }, 30_000);
}

test.beforeAll(async () => {
  ijfwHome = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-ijfw-home-'));
  visual = await launchVisualApp({ DARHAI_IJFW_HOME: ijfwHome });
  await waitForSettle(visual.page);
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
  fs.rmSync(ijfwHome, { recursive: true, force: true });
});

test('the app bootstraps its own memory store - the user never writes registry.md', async () => {
  await invokeBridge(visual.page, GET_STATS, undefined, 30_000);

  expect(fs.existsSync(path.join(ijfwHome, '.ijfw', 'memory'))).toBe(true);
  expect(fs.existsSync(path.join(ijfwHome, '.ijfw', 'registry.md'))).toBe(true);
});

test('a quick-added Latin memory is findable by a Latin query', async () => {
  const saved = await invokeBridge<{ ok: boolean }>(
    visual.page,
    QUICK_ADD,
    { content: LATIN_TEXT, scope: 'global' },
    30_000
  );
  expect(saved.ok).toBe(true);

  const found = await search(`${RUN_TAG}-LATIN`);
  expect(found.total).toBe(1);
  expect(found.entries[0].summary).toContain(`${RUN_TAG}-LATIN`);
});

test('a quick-added Mongolian Cyrillic memory is findable by a Mongolian Cyrillic query', async () => {
  const saved = await invokeBridge<{ ok: boolean }>(
    visual.page,
    QUICK_ADD,
    { content: CYRILLIC_TEXT, scope: 'global' },
    30_000
  );
  expect(saved.ok).toBe(true);

  for (const query of ['кирилл', 'Дархай', 'санах ойн', 'ЭРГЭН ОЛДОХ']) {
    const found = await search(query);
    expect(found.total, `query ${query}`).toBe(1);
    expect(found.entries[0].summary).toContain(`${RUN_TAG}-KIRILL`);
  }
});

test('a drag-dropped file becomes recallable memory', async () => {
  const ingested = await invokeBridge<{ ok: boolean; ingested: number }>(
    visual.page,
    INGEST_FILES,
    {
      files: [
        {
          name: 'sanamj.md',
          content: `${RUN_TAG}-INGEST Хөх толбо бол монголчуудын өвөрмөц шинж юм.`,
          scope: 'global',
        },
      ],
    },
    30_000
  );
  expect(ingested.ok).toBe(true);
  expect(ingested.ingested).toBe(1);

  expect((await search(`${RUN_TAG}-INGEST`)).total).toBe(1);
  expect((await search('Хөх толбо')).total).toBe(1);
});

test('a gibberish query returns nothing rather than the whole corpus', async () => {
  const everything = await invokeBridge<ListResult>(visual.page, LIST_ENTRIES, {}, 30_000);
  expect(everything.total).toBeGreaterThanOrEqual(3);

  for (const gibberish of ['zzzqqqxyzzy', 'qwrtplkjhgfdsazxcv', 'ббббвввггг']) {
    const found = await search(gibberish);
    expect(found.total, `query ${gibberish}`).toBe(0);
    expect(found.entries).toEqual([]);
  }
});

test('get-stats reports what is actually stored', async () => {
  const stats = await invokeBridge<StatsResult>(visual.page, GET_STATS, undefined, 30_000);
  expect(stats.ok).toBe(true);
  expect(stats.stats?.total).toBeGreaterThanOrEqual(3);
  expect(stats.stats?.projects).toBeGreaterThanOrEqual(1);
});

test('memory survives a restart of the app', async () => {
  await quitVisualApp(visual);
  visual = await launchVisualApp({ DARHAI_IJFW_HOME: ijfwHome }, { reuseRunRoot: visual.runRoot });
  await waitForSettle(visual.page);

  expect((await search(`${RUN_TAG}-KIRILL`)).total).toBe(1);
  expect((await search('кирилл')).total).toBe(1);
  expect((await search(`${RUN_TAG}-LATIN`)).total).toBe(1);
  expect((await search(`${RUN_TAG}-INGEST`)).total).toBe(1);
  expect((await search('zzzqqqxyzzy')).total).toBe(0);
});
