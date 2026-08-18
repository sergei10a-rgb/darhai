/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Filesystem integration tests for IjfwArchiveService.editEntry / deleteEntry
 * (idea ported from upstream f55f934b6, #414, re-grounded in Darhai's own
 * service). The pure block transforms are tested in memoryEntryMutation.test.ts;
 * here we exercise the SERVICE glue: entry discovery, atomic write / unlink,
 * the awaited reindex, and - the load-bearing criterion - that the Cyrillic
 * lexical search lane sees the NEW text and no longer sees the OLD text
 * immediately after the mutation resolves.
 *
 * Hermetic isolation: `DARHAI_IJFW_HOME` redirects the whole memory subsystem
 * at a per-test scratch dir (see memoryRoots.ts), so no real user memory is
 * ever touched. The scratch dir lives inside the repo because the service
 * deliberately skips registry roots under '/tmp/' and 'Temp/'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IjfwArchiveService } from '@process/services/memory/ijfwArchiveService';
import type { WatcherFactory } from '@process/services/memory/ijfwArchiveService';

const noopWatcherFactory: WatcherFactory = () => ({ close: () => undefined });

const OLD_SUMMARY = 'Кэш стратегийг локал файлд хадгална';
const NEW_SUMMARY = 'Кэш стратегийг Redis рүү шилжүүлэв';
const KEEP_SUMMARY = 'Electron preload нь bridge-ээр л ярина';

function journalContent(): string {
  return [
    '<!-- ijfw-schema: v1 -->',
    '# Journal',
    '---',
    'type: decision',
    `summary: ${OLD_SUMMARY}`,
    'stored: 2026-05-01T10:00:00.000Z',
    'tags: [кэш, архитектур]',
    '---',
    'Локал файлын кэш ашиглана.',
    '---',
    'type: pattern',
    `summary: ${KEEP_SUMMARY}`,
    'stored: 2026-05-02T11:00:00.000Z',
    'tags: [electron]',
    '---',
    'Renderer нь Node API руу шууд хандахгүй.',
    '',
  ].join('\n');
}

describe('IjfwArchiveService edit/delete (reindex-through-search)', () => {
  let tmpHome: string;
  let memDir: string;
  let journalPath: string;
  let svc: IjfwArchiveService;
  let origIjfwHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-memmut-'));
    memDir = path.join(tmpHome, '.ijfw', 'memory');
    journalPath = path.join(memDir, 'journal.md');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(journalPath, journalContent(), 'utf8');

    origIjfwHome = process.env.DARHAI_IJFW_HOME;
    process.env.DARHAI_IJFW_HOME = tmpHome;
    svc = new IjfwArchiveService(noopWatcherFactory);
  });

  afterEach(() => {
    svc.dispose();
    if (origIjfwHome === undefined) delete process.env.DARHAI_IJFW_HOME;
    else process.env.DARHAI_IJFW_HOME = origIjfwHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function idOf(summary: string): Promise<string> {
    const { entries } = await svc.listEntries({ search: summary });
    expect(entries.length).toBe(1);
    return entries[0].id;
  }

  it('editEntry rewrites the block and the search index: NEW text found, OLD text gone', async () => {
    const id = await idOf(OLD_SUMMARY);

    const result = await svc.editEntry(id, { summary: NEW_SUMMARY, body: 'Redis кэш нь restart даван гарна.' });
    expect(result.ok).toBe(true);

    // THE core criterion: the awaited reindex means the very next search sees
    // the new Cyrillic text and no longer sees the old one.
    const foundNew = await svc.listEntries({ search: 'Redis рүү шилжүүлэв' });
    expect(foundNew.total).toBe(1);
    expect(foundNew.entries[0].summary).toBe(NEW_SUMMARY);

    const foundOld = await svc.listEntries({ search: 'локал файлд хадгална' });
    expect(foundOld.total).toBe(0);

    // The new body is searchable too (bodyPreview feeds the lexical lane).
    const foundBody = await svc.listEntries({ search: 'restart даван гарна' });
    expect(foundBody.total).toBe(1);

    // On disk: old text gone, new text present, sibling untouched verbatim.
    const onDisk = fs.readFileSync(journalPath, 'utf8');
    expect(onDisk).toContain(NEW_SUMMARY);
    expect(onDisk).not.toContain(OLD_SUMMARY);
    expect(onDisk).toContain(`summary: ${KEEP_SUMMARY}`);
    expect(onDisk).toContain('Renderer нь Node API руу шууд хандахгүй.');
  });

  it('editEntry returns the new id when the summary changes; the old id stops resolving', async () => {
    const oldId = await idOf(OLD_SUMMARY);

    const result = await svc.editEntry(oldId, { summary: NEW_SUMMARY });
    expect(result.ok).toBe(true);
    expect(result.newId).toBeDefined();
    expect(result.newId).not.toBe(oldId);

    expect(await svc.getEntry(result.newId as string)).not.toBeNull();
    expect(await svc.getEntry(oldId)).toBeNull();
  });

  it('editEntry keeps the id stable when only body/tags change', async () => {
    const id = await idOf(KEEP_SUMMARY);
    const result = await svc.editEntry(id, { tags: ['electron', 'ipc'] });
    expect(result.ok).toBe(true);
    expect(result.newId).toBe(id);
    const entry = await svc.getEntry(id);
    expect(entry?.tags).toEqual(['electron', 'ipc']);
  });

  it('editEntry refuses a rename that collides with a sibling summary', async () => {
    const id = await idOf(OLD_SUMMARY);
    const result = await svc.editEntry(id, { summary: KEEP_SUMMARY });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('summary_collision');
    // Nothing changed on disk.
    expect(fs.readFileSync(journalPath, 'utf8')).toContain(`summary: ${OLD_SUMMARY}`);
  });

  it('editEntry returns not_found for an unknown id', async () => {
    await svc.init();
    const result = await svc.editEntry('doesnotexist', { body: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });

  it('deleteEntry removes the block; the entry disappears from search and list', async () => {
    const id = await idOf(OLD_SUMMARY);

    const result = await svc.deleteEntry(id);
    expect(result.ok).toBe(true);

    const found = await svc.listEntries({ search: 'Кэш стратегийг' });
    expect(found.total).toBe(0);
    expect(await svc.getEntry(id)).toBeNull();

    // Sibling survives on disk and in the index.
    const onDisk = fs.readFileSync(journalPath, 'utf8');
    expect(onDisk).toContain(`summary: ${KEEP_SUMMARY}`);
    expect(onDisk).not.toContain(OLD_SUMMARY);
    const kept = await svc.listEntries({ search: 'Electron preload' });
    expect(kept.total).toBe(1);
  });

  it('deleteEntry unlinks the file when the last entry is removed', async () => {
    const soloPath = path.join(memDir, 'solo.md');
    fs.writeFileSync(
      soloPath,
      [
        '---',
        'type: observation',
        'summary: Ганцаараа байгаа бичлэг',
        'stored: 2026-05-03T12:00:00.000Z',
        'tags: []',
        '---',
        'Файлын цорын ганц бичлэг.',
        '',
      ].join('\n'),
      'utf8'
    );
    await svc.rebuildNow();

    const id = await idOf('Ганцаараа байгаа бичлэг');
    const result = await svc.deleteEntry(id);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(soloPath)).toBe(false);
    expect((await svc.listEntries({ search: 'Ганцаараа' })).total).toBe(0);
  });

  it('deleteEntry returns not_found for an unknown id', async () => {
    await svc.init();
    const result = await svc.deleteEntry('doesnotexist');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });

  it('editEntry refuses a body with a lone --- line and leaves the file byte-identical (C1)', async () => {
    const id = await idOf(OLD_SUMMARY);
    const before = fs.readFileSync(journalPath);

    const result = await svc.editEntry(id, { body: 'line one\n---\nline two' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('body_contains_separator');

    // The refusal must be a true no-op on disk: byte-for-byte identical.
    const after = fs.readFileSync(journalPath);
    expect(after.equals(before)).toBe(true);

    // Both entries are still fully indexed - nothing was swallowed.
    const first = await svc.listEntries({ search: OLD_SUMMARY });
    expect(first.total).toBe(1);
    const second = await svc.listEntries({ search: KEEP_SUMMARY });
    expect(second.total).toBe(1);
  });
});
