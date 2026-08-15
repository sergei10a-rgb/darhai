/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AGENTS.md: "A single directory must not exceed 10 direct children (files +
 * subdirectories). Split by responsibility when approaching this limit."
 *
 * `src/process/bridge/` reached 85 direct children. Every new IPC surface added
 * one more file to a flat list, and a rule that only exists in prose gets
 * pushed past rather than split at - so it is a test now, mirroring
 * `tests/unit/renderer/conversation/Messages/conversationDirectoryLimit.test.ts`
 * over the bridge tree.
 *
 * `KNOWN_DEBT` is empty and stays empty. Pinning a directory at its current
 * size buys time but leaves a directory the guard cannot actually fail on; the
 * whole tree was split by responsibility instead, so the cap applies everywhere
 * under ROOT with no exemptions. The map is kept rather than deleted because it
 * is the seam a future wave would reach for, and the "must never be listed as
 * debt" assertion below is what stops that reach - for the root `.` as much as
 * for the directories the split created. `.` is the one that actually held the
 * 85, so a debt entry there would re-open precisely this regression; it is the
 * first name in `NEVER_EXEMPT` for that reason.
 *
 * Scope: ROOT is `src/process/bridge`, not the repository. AGENTS.md does not
 * scope the cap to `src/`, and this file is itself the 21st child of
 * `tests/unit/process/bridge/` - but `tests/unit/` has 409 direct children and
 * 20 directories in that tree (itself included) are over the cap, so guarding
 * one test directory would be cosmetic while its parents stay 40x over. The
 * precedent guard (`conversationDirectoryLimit.test.ts`) points ROOT at `src/`
 * for the same reason. Named here so it reads as a known exclusion rather than
 * an oversight; a guard over `tests/` is a separate, tree-wide piece of work.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../src/process/bridge');
const LIMIT = 10;

/** Directories exempted from the limit. Empty - the flat root was split, not re-pinned. */
const KNOWN_DEBT: Record<string, number> = {};

/**
 * Directories that exist because the over-limit root was split by
 * responsibility. Named so the split cannot be undone by moving files back to
 * the root and quietly adding a debt entry: each must exist, be within the
 * limit, and never be exempted.
 */
const SPLIT_SURFACES = [
  'conversation',
  'agent',
  'agent/orchestration',
  'model',
  'model/providers',
  'engine',
  'engine/extensions',
  'workspace',
  'knowledge',
  'knowledge/records',
  'desktop',
  'media',
  'media/voice',
  'remote',
];

/**
 * Directories the guard must always be able to fail on. The root `.` leads:
 * exempting it would restore the flat 85-file directory this file exists to
 * prevent, and nothing else here would notice.
 */
const NEVER_EXEMPT = ['.', ...SPLIT_SURFACES];

/** Every responsibility directory documents why its files belong together. */
const BARREL = 'index.ts';

/**
 * A directory sitting exactly on the cap has zero headroom, and that is
 * invisible until someone adds a file and the guard fires at them. The barrel
 * has to say so, so the constraint is read before the file is written.
 */
const AT_CAP_NOTE = 'at the 10-child cap';

function walk(dir: string, found: Array<{ rel: string; count: number }>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rel = path.relative(ROOT, dir).split(path.sep).join('/');
  found.push({ rel: rel === '' ? '.' : rel, count: entries.length });
  for (const entry of entries) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name), found);
  }
}

describe('process bridge directories stay splittable', () => {
  const dirs: Array<{ rel: string; count: number }> = [];
  walk(ROOT, dirs);

  it('scans the tree it claims to guard', () => {
    // A walk that found nothing is green and worthless.
    expect(dirs.length).toBeGreaterThan(10);
    expect(dirs.some((d) => d.rel === '.')).toBe(true);
    expect(dirs.some((d) => d.rel === 'conversation')).toBe(true);
  });

  it.each(dirs.map((d) => [d.rel, d.count] as const))('%s holds at most its budget', (rel, count) => {
    const budget = KNOWN_DEBT[rel] ?? LIMIT;
    expect(
      count,
      rel in KNOWN_DEBT
        ? `${rel} is known debt at ${budget} children and must not grow - split it instead`
        : `${rel} has ${count} direct children, over AGENTS.md's limit of ${LIMIT} - split by responsibility`
    ).toBeLessThanOrEqual(budget);
  });

  it.each(NEVER_EXEMPT)('%s is inside the limit, not merely capped', (rel) => {
    const dir = dirs.find((d) => d.rel === rel);
    expect(dir, `${rel} not found`).toBeTruthy();
    expect(rel in KNOWN_DEBT, `${rel} must never be listed as debt`).toBe(false);
    expect(dir!.count).toBeLessThanOrEqual(LIMIT);
  });

  it('directories sitting on the cap say so in their barrel', () => {
    // Not `it.each`: the at-cap set is data, and a set that empties out should
    // leave the test standing rather than silently deleting itself.
    for (const dir of dirs.filter((d) => d.count === LIMIT)) {
      const barrel = path.join(ROOT, dir.rel, BARREL);
      expect(fs.existsSync(barrel), `${dir.rel} is at the cap but has no ${BARREL} to say so`).toBe(true);
      expect(
        fs.readFileSync(barrel, 'utf8').includes(AT_CAP_NOTE),
        `${dir.rel} has ${dir.count}/${LIMIT} children and no headroom - say "${AT_CAP_NOTE}" in ${dir.rel}/${BARREL} so the next surface knows it has to open a subdirectory`
      ).toBe(true);
    }
  });

  // Only SPLIT_SURFACES: the root barrel wires the tree together rather than
  // explaining why sibling files were grouped, so a grouping rationale there
  // would be prose with nothing to justify.
  it.each(SPLIT_SURFACES)('%s has a barrel that says why its files belong together', (rel) => {
    const barrel = path.join(ROOT, rel, BARREL);
    expect(fs.existsSync(barrel), `${rel}/${BARREL} is missing`).toBe(true);
    const header = fs.readFileSync(barrel, 'utf8').split('*/')[1] ?? '';
    // A barrel with only the licence header explains nothing; the grouping
    // rationale is the thing a future split has to read.
    expect(header.length, `${rel}/${BARREL} has no grouping rationale`).toBeGreaterThan(300);
  });
});
