/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The one property the memory subsystem exists to have: what a user path wrote
 * can afterwards be found.
 *
 * It did not hold. Every write path (quick-add, drag-drop ingest, the
 * importers, the auto-extractor) wrote into `~/.ijfw/memory/`, while the index
 * only ever read project roots listed in `~/.ijfw/registry.md` - a file nothing
 * in the app ever wrote. Saves returned `{ok: true}`, the bytes really landed
 * on disk, and `list-entries` returned `{"entries":[],"total":0}` forever.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IjfwArchiveService, type WatcherFactory } from '@process/services/memory/ijfwArchiveService';
import { GLOBAL_PROJECT_NAME, globalMemoryDir, registerProject } from '@process/services/memory/memoryRoots';

const noopWatcherFactory: WatcherFactory = () => ({ close: () => undefined });

const LATIN_TEXT = 'PROBE-LATIN-7431 Darhai memory must be recallable after it is stored';
const CYRILLIC_TEXT = 'PROBE-KIRILL-7431 Дархай санах ойн шалгалт: кирилл бичвэр эргэн олдох ёстой';

let home: string;
let originalHome: string | undefined;
let service: IjfwArchiveService;

function newService(): IjfwArchiveService {
  if (service) service.dispose();
  service = new IjfwArchiveService(noopWatcherFactory);
  return service;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-recall-'));
  originalHome = process.env.DARHAI_IJFW_HOME;
  process.env.DARHAI_IJFW_HOME = home;
});

afterEach(() => {
  if (service) service.dispose();
  if (originalHome === undefined) delete process.env.DARHAI_IJFW_HOME;
  else process.env.DARHAI_IJFW_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('quick-add store then recall', () => {
  it('recalls a Latin memory by a Latin query', async () => {
    const svc = newService();
    await svc.quickAdd(LATIN_TEXT, 'global');

    const found = await svc.listEntries({ search: 'PROBE-LATIN-7431' });
    expect(found.total).toBe(1);
    expect(found.entries[0].summary).toContain('PROBE-LATIN-7431');
  });

  it('recalls a Mongolian Cyrillic memory by a Mongolian Cyrillic query', async () => {
    const svc = newService();
    await svc.quickAdd(CYRILLIC_TEXT, 'global');

    for (const query of ['кирилл', 'Дархай', 'санах ойн', 'ЭРГЭН ОЛДОХ']) {
      const found = await svc.listEntries({ search: query });
      expect(found.total, `query ${query}`).toBe(1);
      expect(found.entries[0].summary).toContain('PROBE-KIRILL-7431');
    }
  });

  it('reports the stored entry in get-stats instead of an all-zero snapshot', async () => {
    const svc = newService();
    const before = await svc.getStats();
    expect(before.total).toBe(0);

    await svc.quickAdd(CYRILLIC_TEXT, 'global');

    const after = await svc.getStats();
    expect(after.total).toBe(1);
    expect(after.projects).toBeGreaterThan(0);
    expect(after.typeCounts.observation).toBe(1);
  });

  it('surfaces global entries under the global project filter', async () => {
    const svc = newService();
    await svc.quickAdd(CYRILLIC_TEXT, 'global');

    const scoped = await svc.listEntries({ project: GLOBAL_PROJECT_NAME });
    expect(scoped.total).toBe(1);
  });

  it('survives a restart: a fresh service over the same store still finds it', async () => {
    await newService().quickAdd(CYRILLIC_TEXT, 'global');

    // A brand-new instance reads the store from scratch, exactly as a relaunched
    // app does.
    const restarted = newService();
    const found = await restarted.listEntries({ search: 'PROBE-KIRILL-7431' });
    expect(found.total).toBe(1);
  });

  it('writes a project-scoped memory into the registered project and finds it there', async () => {
    const project = path.join(home, 'proj-mn');
    fs.mkdirSync(path.join(project, '.ijfw', 'memory'), { recursive: true });
    await registerProject(project);

    const svc = newService();
    await svc.quickAdd('PROBE-PROJ-7431 төслийн санах ой', 'project');

    expect(fs.existsSync(path.join(project, '.ijfw', 'memory', 'journal.md'))).toBe(true);
    const found = await svc.listEntries({ search: 'PROBE-PROJ-7431' });
    expect(found.total).toBe(1);
    expect(found.entries[0].project).toBe('proj-mn');
  });
});

describe('search relevance', () => {
  it('returns nothing for a gibberish query instead of the whole corpus', async () => {
    const svc = newService();
    await svc.quickAdd(LATIN_TEXT, 'global');
    await svc.quickAdd(CYRILLIC_TEXT, 'global');
    await svc.quickAdd('TELD цэнэглэгчийн протокол OCPP-д нийцэхгүй', 'global');

    expect((await svc.listEntries({})).total).toBe(3);

    for (const gibberish of ['zzzqqqxyzzy', 'qwrtplkjhgfdsazxcv', 'ббббвввггг']) {
      const found = await svc.listEntries({ search: gibberish });
      expect(found.total, `query ${gibberish}`).toBe(0);
      expect(found.entries).toEqual([]);
    }
  });

  it('returns only the matching entry for a real query', async () => {
    const svc = newService();
    await svc.quickAdd(LATIN_TEXT, 'global');
    await svc.quickAdd(CYRILLIC_TEXT, 'global');
    await svc.quickAdd('TELD цэнэглэгчийн протокол OCPP-д нийцэхгүй', 'global');

    expect((await svc.listEntries({ search: 'TELD' })).total).toBe(1);
    expect((await svc.listEntries({ search: 'Darhai' })).total).toBe(1);
    expect((await svc.listEntries({ search: 'кирилл' })).total).toBe(1);
  });
});

describe('files written by the importers', () => {
  it('indexes a dropped-*.md file, which the fixed six-name allowlist skipped', async () => {
    const dir = globalMemoryDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'dropped-1785512671892-sanamj.md'),
      [
        '---',
        'type: observation',
        'summary: INGEST-PROBE Хөх толбо бол монголчуудын өвөрмөц шинж юм',
        'stored: 2026-07-01T10:00:00.000Z',
        'tags: [global]',
        '---',
        'INGEST-PROBE Хөх толбо бол монголчуудын өвөрмөц шинж юм.',
        '',
      ].join('\n'),
      'utf8'
    );

    const svc = newService();
    expect((await svc.listEntries({ search: 'INGEST-PROBE' })).total).toBe(1);
    expect((await svc.listEntries({ search: 'Хөх толбо' })).total).toBe(1);
  });

  it('keeps an imported entry id stable across restarts', async () => {
    const dir = globalMemoryDir();
    fs.mkdirSync(dir, { recursive: true });
    // The importers write `created` (epoch millis), not `stored`. Falling
    // through to Date.now() gave the entry a new id on every index build.
    fs.writeFileSync(
      path.join(dir, 'dropped-1785533893930-sanamj.md'),
      [
        '---',
        'id: ab12cd34',
        'type: observation',
        'created: 1785533893930',
        'source: drag-drop',
        'summary: STABLE-ID-PROBE Хөх толбо',
        '---',
        'STABLE-ID-PROBE Хөх толбо',
        '',
      ].join('\n'),
      'utf8'
    );

    const first = await newService().listEntries({ search: 'STABLE-ID-PROBE' });
    const second = await newService().listEntries({ search: 'STABLE-ID-PROBE' });
    expect(first.total).toBe(1);
    expect(second.total).toBe(1);
    expect(second.entries[0].id).toBe(first.entries[0].id);
    expect(second.entries[0].storedAt).toBe(first.entries[0].storedAt);
  });
});
