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
 * KNOWN DEBT rather than a blanket exemption: the two directories below are
 * already over the limit and belong to surfaces this wave does not own. They
 * are pinned at their CURRENT size, so they can be split (the cap is an upper
 * bound, not an equality) but cannot grow. That is the specific failure this
 * test exists to stop.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../../../src/renderer/pages/conversation');
const LIMIT = 10;

/** Directories already over the limit when this guard was written. */
const KNOWN_DEBT: Record<string, number> = {
  components: 12,
  'Preview/components/viewers': 12,
};

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

  it('the surface this wave rebuilt is inside the limit, not merely capped', () => {
    // Named explicitly so the split cannot be undone by moving files back and
    // quietly adding a debt entry.
    for (const rel of ['Messages/components', 'Messages/components/cards', 'Messages/components/text']) {
      const dir = dirs.find((d) => d.rel === rel);
      expect(dir, `${rel} not found`).toBeTruthy();
      expect(rel in KNOWN_DEBT, `${rel} must never be listed as debt`).toBe(false);
      expect(dir!.count).toBeLessThanOrEqual(LIMIT);
    }
  });
});
