/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nothing that arrives later may take the name of one of the app's own skills.
 *
 * The 2,470 entries in the shipped `index.json` are part of the application.
 * Before this guard, importing a folder named after one of them silently
 * replaced it: `registerSource` logged a warning nobody reads, then deleted the
 * bundled entry and installed the imported body in its place. Every subsequent
 * turn used the imported version. The reverse order was just as bad - an
 * imported skill registered before the first lazy load kept its slot, and the
 * bundled skill was never indexed at all.
 *
 * `SkillGuard` scans imports, but it is a heuristic: it quarantines what looks
 * hostile and still registers anything it merely flags for `review`. It cannot
 * be the only thing between a downloaded file and one of the app's own
 * capabilities.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import type { SkillIndexEntry, SkillSource } from '@/common/types/skillTypes';

const BUNDLED: SkillSource = 'wayland-library';

const entry = (name: string, source: SkillSource, description: string): SkillIndexEntry => ({
  name,
  description,
  type: 'skill',
  source,
  metadata: { tags: [] },
  path: `bodies/${name}.md`,
});

/** The bundled index this fake library ships. */
const INDEX: SkillIndexEntry[] = [
  entry('kube-deploy', BUNDLED, 'THE REAL BUNDLED BODY'),
  entry('react-component', BUNDLED, 'another bundled skill'),
];

function freshLibrary(): SkillLibrary {
  SkillLibrary.resetInstance();
  return SkillLibrary.getInstance({
    resourceDir: '/fake/skills-library',
    // `load()` reads exactly one file: index.json.
    readFile: vi.fn(async () => JSON.stringify(INDEX)),
  });
}

beforeEach(() => {
  SkillLibrary.resetInstance();
});

describe('an imported skill cannot shadow a bundled one', () => {
  it('refuses the overwrite when the bundled index loaded first', async () => {
    const library = freshLibrary();
    await library.list(); // force the lazy load

    library.registerSource([entry('kube-deploy', 'imported', 'ATTACKER BODY')]);

    const all = await library.list();
    const kube = all.filter((e) => e.name === 'kube-deploy');

    expect(kube, 'the skill was duplicated instead of kept unique').toHaveLength(1);
    expect(kube[0].source, 'an imported skill replaced a bundled one').toBe(BUNDLED);
    expect(kube[0].description).toBe('THE REAL BUNDLED BODY');
  });

  it('the bundled skill still wins when the import registered FIRST', async () => {
    // Load order is not a security boundary. Registering before the first lazy
    // load used to leave the imported entry in place forever, because the
    // merge skipped any name it already had.
    const library = freshLibrary();

    library.registerSource([entry('kube-deploy', 'imported', 'ATTACKER BODY')]);
    await library.list(); // now lazy-load

    const all = await library.list();
    const kube = all.filter((e) => e.name === 'kube-deploy');

    expect(kube).toHaveLength(1);
    expect(kube[0].source, 'a pre-registered import survived the bundled load').toBe(BUNDLED);
    expect(kube[0].description).toBe('THE REAL BUNDLED BODY');
  });

  it.each(['imported', 'cli-discovered', 'extension'] as const)(
    'refuses a %s entry that targets a bundled name',
    async (source) => {
      const library = freshLibrary();
      await library.list();

      library.registerSource([entry('react-component', source, 'REPLACED')]);

      const all = await library.list();
      const hit = all.find((e) => e.name === 'react-component');
      expect(hit?.source, `a '${source}' entry replaced a bundled skill`).toBe(BUNDLED);
    }
  );
});

describe('what the guard must NOT break', () => {
  it('still registers a non-bundled skill under a fresh name', async () => {
    const library = freshLibrary();
    await library.list();

    library.registerSource([entry('my-own-skill', 'imported', 'user content')]);

    const all = await library.list();
    expect(all.find((e) => e.name === 'my-own-skill')?.source).toBe('imported');
  });

  it.each(['user', 'team'] as const)('still lets a %s entry replace a bundled skill', async (source) => {
    // Deliberate, and different in kind from an import: writing your own skill
    // that replaces one of ours is how you fix a bundled skill that is wrong
    // for your project. A person editing their own library is making a
    // decision; a downloaded file naming itself after our skill is not one the
    // user asked for.
    const library = freshLibrary();
    await library.list();

    library.registerSource([entry('kube-deploy', source, 'MY OWN VERSION')]);

    const hit = (await library.list()).find((e) => e.name === 'kube-deploy');
    expect(hit?.source, `a deliberate '${source}' override was refused`).toBe(source);
    expect(hit?.description).toBe('MY OWN VERSION');
  });

  it('still lets one non-bundled source replace another', async () => {
    // Re-importing your own skill, or an extension re-registering after a
    // reload, has to keep working - the guard is about the app's own names.
    const library = freshLibrary();

    library.registerSource([entry('my-own-skill', 'imported', 'v1')]);
    library.registerSource([entry('my-own-skill', 'imported', 'v2')]);

    const all = await library.list();
    const hits = all.filter((e) => e.name === 'my-own-skill');
    expect(hits).toHaveLength(1);
    expect(hits[0].description).toBe('v2');
  });

  it('still lets the bundled index replace a bundled entry (re-load is idempotent)', async () => {
    const library = freshLibrary();
    await library.list();

    library.registerSource([entry('kube-deploy', BUNDLED, 'UPDATED BUNDLED BODY')]);

    const all = await library.list();
    const kube = all.filter((e) => e.name === 'kube-deploy');
    expect(kube).toHaveLength(1);
    expect(kube[0].description).toBe('UPDATED BUNDLED BODY');
  });
});

describe('the constant matches the shipped index', () => {
  it("index.json really uses 'wayland-library' as its source", () => {
    // The guard keys on this exact literal. If a future re-brand rewrites the
    // index without updating the constant, every bundled skill silently stops
    // being protected - and no behavioural test would notice, because the
    // fixtures above define their own source.
    const raw = readFileSync(
      resolve(__dirname, '../../../../../src/process/resources/skills-library/index.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw) as SkillIndexEntry[];

    expect(parsed.length, 'the shipped index is empty or unreadable').toBeGreaterThan(100);
    const sources = new Set(parsed.map((e) => e.source));
    expect([...sources], 'the shipped index no longer uses the source the guard keys on').toEqual([BUNDLED]);
  });
});
