/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AGENTS.md: "A single directory must not exceed 10 direct children (files +
 * subdirectories). Split by responsibility when approaching this limit."
 *
 * `Messages/components/` reached 23 and then took two more files in one wave -
 * a rule that only exists in prose gets pushed past, not split at. So it is a
 * test now, over the conversation page tree this surface lives in.
 *
 * `KNOWN_DEBT` is empty and stays empty. It used to pin `components/` (12) and
 * `Preview/components/viewers/` (12) at their then-current size, which bought
 * time but left two directories the guard could not actually fail on. Both have
 * since been split by responsibility - `components/` into `navigation`/`skills`/
 * `title`, `viewers/` into `text`/`office`/`web`/`media` - so the cap applies to
 * every directory under ROOT with no exemptions. The map is kept rather than
 * deleted because it is the seam a future wave would reach for, and the
 * "must never be listed as debt" assertion below is what stops that reach.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../../src/renderer/pages/conversation');
const LIMIT = 10;

/** Directories exempted from the limit. Empty - the two former entries were split, not re-pinned. */
const KNOWN_DEBT: Record<string, number> = {};

/**
 * Directories that exist because an over-limit one was split by responsibility.
 * Named so the split cannot be undone by moving files back and quietly adding a
 * debt entry: each must exist, be within the limit, and never be exempted.
 */
const SPLIT_SURFACES = [
  // Wave that split Messages/components (25 children).
  'Messages/components',
  'Messages/components/cards',
  'Messages/components/text',
  // Wave that paid off the two KNOWN_DEBT entries (12 children each).
  'components',
  'components/navigation',
  'components/skills',
  'components/title',
  'Preview/components/viewers',
  'Preview/components/viewers/media',
  'Preview/components/viewers/office',
  'Preview/components/viewers/text',
  'Preview/components/viewers/web',
];

function walk(dir: string, found: Array<{ rel: string; count: number }>): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rel = path.relative(ROOT, dir).split(path.sep).join('/');
  found.push({ rel: rel === '' ? '.' : rel, count: entries.length });
  for (const entry of entries) {
    if (entry.isDirectory()) walk(path.join(dir, entry.name), found);
  }
}

describe('conversation page directories stay splittable', () => {
  const dirs: Array<{ rel: string; count: number }> = [];
  walk(ROOT, dirs);

  it('scans the tree it claims to guard', () => {
    // A walk that found nothing is green and worthless.
    expect(dirs.length).toBeGreaterThan(20);
    expect(dirs.some((d) => d.rel === 'Messages/components')).toBe(true);
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

  it.each(SPLIT_SURFACES)('%s is inside the limit, not merely capped', (rel) => {
    const dir = dirs.find((d) => d.rel === rel);
    expect(dir, `${rel} not found`).toBeTruthy();
    expect(rel in KNOWN_DEBT, `${rel} must never be listed as debt`).toBe(false);
    expect(dir!.count).toBeLessThanOrEqual(LIMIT);
  });
});
