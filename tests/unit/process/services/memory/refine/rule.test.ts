/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure tests for the /refine rule primitives: the pre-gate, apply, and
 * rollback. These are the pieces Darhai's memory layer lacked (session scope,
 * validation before admission, rollback). Rule text is Mongolian Cyrillic
 * because Darhai's corpus is Cyrillic-first.
 */

import { describe, expect, it } from 'vitest';
import {
  applyRuleEdits,
  emptyRuleState,
  invertResult,
  makeRuleId,
  rollbackRuleResult,
  validateRuleEdit,
  RULE_MAX_CHARS,
  RULE_MIN_CHARS,
  type RuleEdit,
  type RuleState,
} from '@process/services/memory/refine/rule';

const FIXED_NOW = () => 1_700_000_000_000;

function apply(state: RuleState, edits: RuleEdit[], requestedScope: 'session' | 'global') {
  return applyRuleEdits(state, edits, {
    id: 'refine_test',
    requestedScope,
    refinementId: 'refine_test',
    now: FIXED_NOW,
  });
}

// ===== Pre-gate =====

describe('validateRuleEdit (pre-gate)', () => {
  it('rejects a global edit during a session refinement (leak guard)', () => {
    // The core of session isolation: a session pass must never touch global.
    const err = validateRuleEdit(
      { action: 'add', scope: 'global', text: 'Монголоор хариул' },
      'session',
      emptyRuleState()
    );
    expect(err).toBe('scope_mismatch');
  });

  it('rejects a session edit during a global refinement', () => {
    const err = validateRuleEdit(
      { action: 'add', scope: 'session', text: 'Монголоор хариул' },
      'global',
      emptyRuleState()
    );
    expect(err).toBe('scope_mismatch');
  });

  it('accepts a matching-scope add', () => {
    expect(
      validateRuleEdit({ action: 'add', scope: 'session', text: 'Монголоор хариул' }, 'session', emptyRuleState())
    ).toBeUndefined();
  });

  it('rejects an unsupported action and scope', () => {
    expect(
      validateRuleEdit(
        { action: 'destroy' as never, scope: 'session', text: 'x'.repeat(10) },
        'session',
        emptyRuleState()
      )
    ).toBe('unsupported_action');
    expect(
      validateRuleEdit(
        { action: 'add', scope: 'project' as never, text: 'x'.repeat(10) },
        'project' as never,
        emptyRuleState()
      )
    ).toBe('unsupported_scope');
  });

  it('rejects missing/short/long text', () => {
    expect(validateRuleEdit({ action: 'add', scope: 'session', text: '   ' }, 'session', emptyRuleState())).toBe(
      'missing_text'
    );
    expect(
      validateRuleEdit(
        { action: 'add', scope: 'session', text: 'a'.repeat(RULE_MIN_CHARS - 1) },
        'session',
        emptyRuleState()
      )
    ).toBe('too_short');
    expect(
      validateRuleEdit(
        { action: 'add', scope: 'session', text: 'a'.repeat(RULE_MAX_CHARS + 1) },
        'session',
        emptyRuleState()
      )
    ).toBe('too_long');
  });

  it('rejects a duplicate add', () => {
    const { state } = apply(
      emptyRuleState(),
      [{ action: 'add', scope: 'session', text: 'Монголоор хариул' }],
      'session'
    );
    expect(validateRuleEdit({ action: 'add', scope: 'session', text: 'монголоор  ХАРИУЛ' }, 'session', state)).toBe(
      'already_exists'
    ); // normalized identity: whitespace + case collapse
  });

  it('rejects a remove with no/unknown id', () => {
    expect(validateRuleEdit({ action: 'remove', scope: 'session' }, 'session', emptyRuleState())).toBe('missing_id');
    expect(validateRuleEdit({ action: 'remove', scope: 'session', id: 'nope' }, 'session', emptyRuleState())).toBe(
      'not_found'
    );
  });
});

// ===== Apply =====

describe('applyRuleEdits', () => {
  it('admits a valid add and derives its id', () => {
    const { state, result } = apply(
      emptyRuleState(),
      [{ action: 'add', scope: 'session', text: 'Кодны хариултыг богино байлга' }],
      'session'
    );
    expect(state.rules).toHaveLength(1);
    expect(result.applied[0].applied).toBe(true);
    expect(result.applied[0].id).toBe(makeRuleId('session', 'Кодны хариултыг богино байлга'));
    expect(result.applied[0].after?.text).toBe('Кодны хариултыг богино байлга');
  });

  it('rejects a scope-mismatched edit but records it as failed', () => {
    const { state, result } = apply(
      emptyRuleState(),
      [{ action: 'add', scope: 'global', text: 'Диск рүү бичих ёсгүй дүрэм' }],
      'session'
    );
    expect(state.rules).toHaveLength(0); // never admitted
    expect(result.applied[0].applied).toBe(false);
    expect(result.applied[0].error).toBe('scope_mismatch');
  });

  it('applies a batch in order: add then remove sees the added rule', () => {
    const id = makeRuleId('session', 'Түр дүрэм');
    const { state, result } = apply(
      emptyRuleState(),
      [
        { action: 'add', scope: 'session', text: 'Түр дүрэм' },
        { action: 'remove', scope: 'session', id },
      ],
      'session'
    );
    expect(state.rules).toHaveLength(0);
    expect(result.applied.every((e) => e.applied)).toBe(true);
  });

  it('does not mutate the input state (immutable)', () => {
    const before = emptyRuleState();
    apply(before, [{ action: 'add', scope: 'session', text: 'Шинэ дүрэм нэмэх' }], 'session');
    expect(before.rules).toHaveLength(0);
  });
});

// ===== Rollback =====

describe('rollbackRuleResult', () => {
  it('reverts an added rule (add -> remove)', () => {
    const { state: afterAdd, result } = apply(
      emptyRuleState(),
      [{ action: 'add', scope: 'session', text: 'Буруу дүрэм байсан' }],
      'session'
    );
    expect(afterAdd.rules).toHaveLength(1);

    const { state: rolledBack, result: rb } = rollbackRuleResult(afterAdd, result, {
      id: 'rb',
      refinementId: 'rb',
      now: FIXED_NOW,
    });
    expect(rolledBack.rules).toHaveLength(0);
    expect(rb.rollbackOf).toBe(result.id);
    expect(rb.applied[0].applied).toBe(true);
  });

  it('restores a removed rule (remove -> add) with its original text', () => {
    const seeded = apply(emptyRuleState(), [{ action: 'add', scope: 'global', text: 'Хадгалагдсан дүрэм' }], 'global');
    const id = seeded.result.applied[0].id;

    const { state: afterRemove, result: removeResult } = apply(
      seeded.state,
      [{ action: 'remove', scope: 'global', id }],
      'global'
    );
    expect(afterRemove.rules).toHaveLength(0);

    const { state: restored } = rollbackRuleResult(afterRemove, removeResult, {
      id: 'rb',
      refinementId: 'rb',
      now: FIXED_NOW,
    });
    expect(restored.rules).toHaveLength(1);
    expect(restored.rules[0].text).toBe('Хадгалагдсан дүрэм');
  });

  it('inverts a multi-edit pass in reverse order', () => {
    const { result } = apply(
      emptyRuleState(),
      [
        { action: 'add', scope: 'session', text: 'Эхний дүрэм нэмэх' },
        { action: 'add', scope: 'session', text: 'Хоёр дахь дүрэм нэмэх' },
      ],
      'session'
    );
    const inverse = invertResult(result);
    expect(inverse).toHaveLength(2);
    expect(inverse.every((e) => e.action === 'remove')).toBe(true);
    // Reversed: the second add is undone first.
    expect(inverse[0].id).toBe(result.applied[1].id);
  });

  it('rolls back as a no-op when the target rule was already removed', () => {
    const { state: afterAdd, result } = apply(
      emptyRuleState(),
      [{ action: 'add', scope: 'session', text: 'Аль хэдийн устсан дүрэм' }],
      'session'
    );
    // Someone else removes it first.
    const manual = apply(afterAdd, [{ action: 'remove', scope: 'session', id: result.applied[0].id }], 'session');
    expect(manual.state.rules).toHaveLength(0);

    // Rolling back the original add now finds nothing to remove: no crash.
    const { state, result: rb } = rollbackRuleResult(manual.state, result, {
      id: 'rb',
      refinementId: 'rb',
      now: FIXED_NOW,
    });
    expect(state.rules).toHaveLength(0);
    expect(rb.applied[0].applied).toBe(false);
    expect(rb.applied[0].error).toBe('not_found');
  });
});
