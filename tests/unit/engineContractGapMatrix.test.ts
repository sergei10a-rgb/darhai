/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The gap matrix must be generated, and it must be able to say "no".
 *
 * `tests/fixtures/engine-contract/gap-matrix.json` describes itself, in the
 * bundle's own README, as "generated: what Darhai implements vs what the
 * contract defines". Nothing generated it and nothing read it, so it rotted:
 * all 34 of its `gaps` rows still said `implemented: false`, including
 * `continue_with_budget` and `budget_grant_result`, while
 * `docs/architecture/engine-capabilities/README.md` - updated in the SAME
 * commit - marked waves 1-4 landed. A status artifact that disagrees with the
 * status is worse than no artifact.
 *
 * Two tests, and the second is the one that matters. The first pins the file to
 * the derivation. The second proves the derivation can still report a gap: with
 * every row currently implemented, a green first test on its own is exactly the
 * shape of a check that has stopped checking.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveGapMatrix, serialiseGapMatrix, MATRIX_PATH } from '../../scripts/gapMatrix.mjs';

describe('engine-contract gap matrix', () => {
  it('is what the code says it is', () => {
    const derived = serialiseGapMatrix(deriveGapMatrix());
    const committed = readFileSync(MATRIX_PATH, 'utf8');
    // The whole file, not a row count: a matrix that is right about totals and
    // wrong about which verb is which is the failure it exists to prevent.
    expect(committed, 'gap-matrix.json is stale - regenerate it with: node scripts/gapMatrix.mjs --write').toBe(
      derived
    );
  });

  it('still reports a gap for a verb nothing implements', () => {
    // The counter-check. Every row in the real manifest is implemented today,
    // so the assertion above would pass just as happily against a derivation
    // that had quietly started marking everything true.
    const synthetic = {
      events: [
        {
          type: 'a_verb_no_darhai_build_has_ever_seen',
          capability: 'invented_for_this_test',
          criticality: 'safety',
          correlation: 'session',
          path: 'events/nope.json',
        },
      ],
      commands: [
        {
          type: 'another_verb_nothing_sends',
          capability: 'invented_for_this_test',
          criticality: 'safety',
          correlation: 'request_id',
          path: 'commands/nope.json',
        },
      ],
    };

    const matrix = deriveGapMatrix(synthetic);

    expect(matrix.implemented).toEqual([]);
    expect(matrix.gaps.map((row: { type: string }) => row.type)).toEqual([
      'a_verb_no_darhai_build_has_ever_seen',
      'another_verb_nothing_sends',
    ]);
    expect(matrix.gaps.every((row: { implemented: boolean }) => row.implemented === false)).toBe(true);
  });
});
