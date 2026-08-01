/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extension-contributed skills must reach the SkillLibrary, because that is the
 * index every retrieval path reads. Before `syncExtensionSkills` existed they
 * stopped at `ExtensionRegistry.getSkills()`: a user with 75 extension skills
 * saw `skills.list` report `{ 'wayland-library': 2267 }` and nothing else, so
 * those skills were advertised once in the first-message index and never ranked
 * per turn or auto-loaded again.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { syncExtensionSkills } from '@process/extensions/resolvers/SkillResolver';
import { SkillRetriever } from '@process/services/skills/SkillRetriever';

/** Library with an empty on-disk index, so only what we register is present. */
function makeEmptyLibrary(): SkillLibrary {
  return SkillLibrary.getInstance({
    resourceDir: '/fake/skills-library',
    bundledWorkflowsDir: '/fake/bundled-workflows',
    readFile: async (p: string) => {
      if (p.includes('bundled-workflows')) throw new Error('no workflows');
      if (p.endsWith('index.json')) return '[]';
      throw new Error(`Not found: ${p}`);
    },
  });
}

describe('syncExtensionSkills', () => {
  beforeEach(() => {
    SkillLibrary.resetInstance();
  });

  it('registers extension skills into the library under the extension source', async () => {
    const lib = makeEmptyLibrary();
    await lib.list(); // force the lazy index load first

    syncExtensionSkills([
      { name: 'invoice-drafter', description: 'Draft an invoice from a job sheet', location: '/ext/a/SKILL.md' },
      { name: 'payroll-check', description: 'Check a payroll run for anomalies', location: '/ext/b/SKILL.md' },
    ]);

    const entries = await lib.list({ type: 'skill' });
    expect(entries.map((e) => e.name).sort()).toEqual(['invoice-drafter', 'payroll-check']);
    expect(entries.every((e) => e.source === 'extension')).toBe(true);
    // Absolute paths, so loadBody reads the extension's own file.
    expect(entries.map((e) => e.path)).toEqual(['/ext/a/SKILL.md', '/ext/b/SKILL.md']);

    const stats = await lib.stats({ type: 'skill' });
    expect(stats.bySource.extension).toBe(2);
  });

  it('replaces rather than appends, so disabling an extension removes its skills', async () => {
    const lib = makeEmptyLibrary();
    await lib.list();

    syncExtensionSkills([
      { name: 'invoice-drafter', description: 'Draft an invoice', location: '/ext/a/SKILL.md' },
      { name: 'payroll-check', description: 'Check payroll', location: '/ext/b/SKILL.md' },
    ]);
    expect((await lib.list({ type: 'skill' })).length).toBe(2);

    // The user disables the extension that contributed payroll-check.
    syncExtensionSkills([{ name: 'invoice-drafter', description: 'Draft an invoice', location: '/ext/a/SKILL.md' }]);

    const entries = await lib.list({ type: 'skill' });
    expect(entries.map((e) => e.name)).toEqual(['invoice-drafter']);

    // And disabling every skill-contributing extension empties the source.
    syncExtensionSkills([]);
    expect((await lib.list({ type: 'skill' })).length).toBe(0);
  });

  it('makes extension skills rankable by the per-turn retriever', async () => {
    const lib = makeEmptyLibrary();
    await lib.list();

    syncExtensionSkills([
      { name: 'invoice-drafter', description: 'Draft an invoice from a job sheet', location: '/ext/a/SKILL.md' },
      { name: 'kube-deploy', description: 'Deploy an application to a Kubernetes cluster', location: '/ext/b/SKILL.md' },
    ]);

    const entries = await lib.list({ type: 'skill' });
    const retriever = new SkillRetriever({ entries });
    retriever.buildIndex(entries);

    const hits = retriever.retrieve('draft invoice from job sheet');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('invoice-drafter');
  });

  it('drops duplicate names instead of registering a skill twice', async () => {
    const lib = makeEmptyLibrary();
    await lib.list();

    syncExtensionSkills([
      { name: 'dupe', description: 'first wins', location: '/ext/a/SKILL.md' },
      { name: 'dupe', description: 'second ignored', location: '/ext/b/SKILL.md' },
    ]);

    const entries = await lib.list({ type: 'skill' });
    expect(entries.length).toBe(1);
    expect(entries[0].description).toBe('first wins');
  });
});
