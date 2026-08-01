/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The security re-scan path (`skills.scan` / `skills.rescanAll`) must actually
 * read a bundled skill's body.
 *
 * `rescanIfStale` used to join `<resourceDir>/<entry.path>` with no `bodies/`
 * fallback. Every vendored index entry stores its path WITHOUT that prefix, so
 * the read threw for all 2,4xx bundled skills, the catch returned the stale
 * entry, and `SkillGuard.scan` never ran - pinning the Skills page health cards
 * at `verified: 0` forever.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { SkillLibrary } from '@process/services/skills/SkillLibrary';
import { SKILL_SCANNER_VERSION, type SkillIndexEntry } from '@/common/types/skillTypes';

const BUNDLED_DIR = path.resolve(__dirname, '../../../../../src/process/resources/skills-library');

describe('SkillLibrary.rescanIfStale', () => {
  beforeEach(() => {
    SkillLibrary.resetInstance();
  });

  it('resolves a vendored body through the bodies/ fallback and scans it', async () => {
    const index: SkillIndexEntry[] = [
      {
        name: 'vendored-skill',
        description: 'A vendored skill whose body lives under bodies/',
        type: 'skill',
        source: 'wayland-library',
        metadata: { tags: [], category: 'dev' },
        // Exactly the vendored shape: no `bodies/` prefix in the index entry.
        path: 'skills/dev/vendored-skill/SKILL.md',
      },
    ];

    const lib = SkillLibrary.getInstance({
      resourceDir: '/fake/skills-library',
      bundledWorkflowsDir: '/fake/bundled-workflows',
      readFile: async (p: string) => {
        if (p.endsWith('index.json')) {
          if (p.includes('bundled-workflows')) throw new Error('no workflows');
          return JSON.stringify(index);
        }
        // Only the bodies/-prefixed path exists, like the real library.
        if (p.replace(/\\/g, '/').endsWith('/bodies/skills/dev/vendored-skill/SKILL.md')) {
          return '# vendored-skill\n\nDo something harmless.\n';
        }
        throw new Error(`Not found: ${p}`);
      },
    });

    const report = await lib.rescanIfStale('vendored-skill');

    expect(report).not.toBeNull();
    expect(report!.scannerVersion).toBe(SKILL_SCANNER_VERSION);
    expect(report!.scannedAt).toBeGreaterThan(0);
    expect(report!.verdict).toBe('clean');
  });

  it('marks real bundled skills verified (the count that was stuck at 0)', async () => {
    if (!existsSync(path.join(BUNDLED_DIR, 'index.json'))) {
      throw new Error(`Bundled skills library missing at ${BUNDLED_DIR}`);
    }

    const lib = SkillLibrary.getInstance({
      resourceDir: BUNDLED_DIR,
      bundledWorkflowsDir: path.join(BUNDLED_DIR, '__no_workflows__'),
      readFile: (p: string) => readFile(p, 'utf-8'),
    });

    const all = await lib.list({ type: 'skill' });
    expect(all.length).toBeGreaterThan(100);
    // Precondition: the shipped index stores every skill as unscanned.
    expect(all.every((e) => (e.security?.scannerVersion ?? 0) < SKILL_SCANNER_VERSION)).toBe(true);
    expect((await lib.stats({ type: 'skill' })).verified).toBe(0);

    // Scan a sample rather than all ~2.4k bodies - the defect was all-or-nothing.
    const sample = all.slice(0, 40);
    for (const entry of sample) {
      await lib.rescanIfStale(entry.name);
    }

    const scanned = sample.filter((e) => (e.security?.scannerVersion ?? 0) === SKILL_SCANNER_VERSION);
    expect(scanned.length).toBe(sample.length);

    const stats = await lib.stats({ type: 'skill' });
    expect(stats.verified).toBeGreaterThan(0);
    expect(stats.verified + stats.flagged).toBe(sample.length);
  });
});
