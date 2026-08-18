/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Continual-harness rule primitives (ported in spirit from prime-agent's
 * /refine, `packages/coding-agent/src/core/refinement/refinement.ts`, MIT).
 *
 * WHAT DARHAI ALREADY HAS (do not duplicate):
 *  - `memoryExtractor` turns a transcript into durable *facts* and writes them
 *    to the native store (project/global scope).
 *  - `memoryEntryMutation` (applyEdit/applyDelete) surgically rewrites one entry.
 *  - `ijfwArchiveService` (quickAdd/editEntry/deleteEntry) is the disk write path.
 *
 * WHAT THIS MODULE ADDS (the missing /refine pieces):
 *  1. SCOPE-AWARE rules: `session` rules live only for the current session and
 *     must NEVER leak to the cross-session `global` store; `global` rules are
 *     durable cross-session lessons. Darhai's memory scope was only
 *     project/global with no session-only lane.
 *  2. A PRE-GATE: a rule is validated *before* it is admitted (shape, length,
 *     scope containment, duplicate), instead of the extractor's after-the-fact
 *     dedupe-only check.
 *  3. ROLLBACK: a whole refinement pass can be reverted, restoring the exact
 *     rules it added or removed.
 *
 * Everything here is PURE (no I/O, no clock unless injected). `refineStore.ts`
 * wires these transforms to the session map and the on-disk archive.
 */

import { createHash } from 'node:crypto';

/**
 * Where a rule lives. `session` is the default editable store, local to one
 * Darhai session (temporary blockers, current-run coordination). `global` is
 * the durable cross-session store. The gate refuses to let a session-scoped
 * refinement write global rules, so session rules never leak across sessions.
 */
export type RuleScope = 'session' | 'global';

export type RuleEditAction = 'add' | 'remove';

/** A single admitted rule. `id` is derived from `scope` + normalized `text`. */
export type RefineRule = {
  id: string;
  scope: RuleScope;
  /** The rule text (Cyrillic-first, like the rest of Darhai's corpus). */
  text: string;
  createdAt: number;
  /** The refinement pass that produced this rule (used to roll it back). */
  refinementId: string;
};

/** A proposed change to the rule set, before the gate accepts it. */
export type RuleEdit = {
  action: RuleEditAction;
  scope: RuleScope;
  /** Required for `add`. */
  text?: string;
  /** Required for `remove`. */
  id?: string;
  /** Why the model proposed this edit (kept for review, never load-bearing). */
  reason?: string;
};

/** Reasons the pre-gate can reject a single edit. */
export type RuleGateError =
  | 'unsupported_action'
  | 'unsupported_scope'
  | 'scope_mismatch'
  | 'missing_text'
  | 'too_short'
  | 'too_long'
  | 'already_exists'
  | 'missing_id'
  | 'not_found';

/** One edit after the gate ran, carrying the snapshots rollback needs. */
export type AppliedRuleEdit = RuleEdit & {
  /** The id the edit resolved to (derived for `add`, echoed for `remove`). */
  id: string;
  applied: boolean;
  error?: RuleGateError;
  /** Present when a rule was removed (or updated); the pre-image. */
  before?: RefineRule;
  /** Present when a rule was added; the post-image. */
  after?: RefineRule;
};

/** The immutable rule set a refinement transforms. */
export type RuleState = {
  rules: readonly RefineRule[];
};

/** The outcome of one refinement (or rollback) pass. */
export type RefineResult = {
  id: string;
  /** The scope this pass was allowed to touch. */
  scope: RuleScope;
  applied: readonly AppliedRuleEdit[];
  /** Set when this pass reverts an earlier one. */
  rollbackOf?: string;
};

export type ApplyOptions = {
  id: string;
  requestedScope: RuleScope;
  refinementId: string;
  now?: () => number;
  rollbackOf?: string;
};

// A rule shorter than this is noise (the extractor uses 5 for a raw fact; a
// behavioral rule needs a bit more to be actionable). Longer than the cap is
// almost always a pasted transcript slice, not a rule.
export const RULE_MIN_CHARS = 8;
export const RULE_MAX_CHARS = 500;

/** An empty rule set. */
export function emptyRuleState(): RuleState {
  return { rules: [] };
}

/** Collapse whitespace and lowercase for a stable identity of a rule's text. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable id for a rule: a hash of its scope and normalized text. Two adds of
 * the same rule in the same scope resolve to the same id, so the gate's
 * duplicate check is exact and rollback can target a rule unambiguously.
 */
export function makeRuleId(scope: RuleScope, text: string): string {
  return createHash('sha1')
    .update(`${scope}:${normalizeText(text)}`)
    .digest('hex')
    .slice(0, 12);
}

function isScope(value: unknown): value is RuleScope {
  return value === 'session' || value === 'global';
}

function isAction(value: unknown): value is RuleEditAction {
  return value === 'add' || value === 'remove';
}

/**
 * The PRE-GATE. Validate one edit against the requested scope and current
 * state WITHOUT mutating anything. Returns the error, or undefined when the
 * edit is admissible.
 *
 * The scope-containment rule is the leak guard: an edit whose scope differs
 * from the refinement pass's `requestedScope` is refused. A session refinement
 * therefore can never add or remove a global rule (the direction that would
 * leak a session-only rule into the cross-session store), and a global
 * refinement can never silently mint a session rule.
 */
export function validateRuleEdit(
  edit: RuleEdit,
  requestedScope: RuleScope,
  state: RuleState
): RuleGateError | undefined {
  if (!isAction(edit.action)) return 'unsupported_action';
  if (!isScope(edit.scope)) return 'unsupported_scope';
  if (edit.scope !== requestedScope) return 'scope_mismatch';

  if (edit.action === 'add') {
    if (typeof edit.text !== 'string' || edit.text.trim().length === 0) return 'missing_text';
    const trimmed = edit.text.trim();
    if (trimmed.length < RULE_MIN_CHARS) return 'too_short';
    if (trimmed.length > RULE_MAX_CHARS) return 'too_long';
    const id = makeRuleId(edit.scope, trimmed);
    if (state.rules.some((r) => r.id === id)) return 'already_exists';
    return undefined;
  }

  // remove
  if (typeof edit.id !== 'string' || edit.id.length === 0) return 'missing_id';
  if (!state.rules.some((r) => r.id === edit.id)) return 'not_found';
  return undefined;
}

/**
 * Apply a batch of edits through the pre-gate. Pure: returns a NEW state and a
 * result; never mutates the input. Each edit sees the state left by the edits
 * before it in the batch (so an add followed by a remove of the same rule both
 * apply in order).
 */
export function applyRuleEdits(
  state: RuleState,
  edits: readonly RuleEdit[],
  options: ApplyOptions
): { state: RuleState; result: RefineResult } {
  const clock = options.now ?? (() => Date.now());
  let rules: RefineRule[] = [...state.rules];
  const applied: AppliedRuleEdit[] = [];

  for (const edit of edits) {
    const working: RuleState = { rules };
    const error = validateRuleEdit(edit, options.requestedScope, working);
    if (error) {
      const id =
        edit.action === 'add' && typeof edit.text === 'string'
          ? makeRuleId(edit.scope, edit.text.trim())
          : (edit.id ?? '');
      applied.push({ ...edit, id, applied: false, error });
      continue;
    }

    if (edit.action === 'add') {
      const text = (edit.text as string).trim();
      const rule: RefineRule = {
        id: makeRuleId(edit.scope, text),
        scope: edit.scope,
        text,
        createdAt: clock(),
        refinementId: options.refinementId,
      };
      rules = [...rules, rule];
      applied.push({ ...edit, id: rule.id, applied: true, after: rule });
      continue;
    }

    // remove
    const target = rules.find((r) => r.id === edit.id);
    // `target` is guaranteed by the gate's not_found check, but narrow anyway.
    if (!target) {
      applied.push({ ...edit, id: edit.id ?? '', applied: false, error: 'not_found' });
      continue;
    }
    rules = rules.filter((r) => r.id !== edit.id);
    applied.push({ ...edit, id: target.id, applied: true, before: target });
  }

  return {
    state: { rules },
    result: {
      id: options.id,
      scope: options.requestedScope,
      applied,
      rollbackOf: options.rollbackOf,
    },
  };
}

/**
 * Build the inverse edits for a completed refinement: every applied `add`
 * becomes a `remove`, every applied `remove` becomes an `add` restoring the
 * pre-image. Reversed so the batch undoes in the opposite order it was applied.
 */
export function invertResult(target: RefineResult): RuleEdit[] {
  const edits: RuleEdit[] = [];
  for (const edit of [...target.applied].reverse()) {
    if (!edit.applied) continue;
    if (edit.after) {
      edits.push({ action: 'remove', scope: edit.after.scope, id: edit.after.id, reason: `Rollback ${target.id}` });
    } else if (edit.before) {
      edits.push({ action: 'add', scope: edit.before.scope, text: edit.before.text, reason: `Rollback ${target.id}` });
    }
  }
  return edits;
}

/**
 * Roll back a refinement pass. Pure: applies the inverse edits through the same
 * gate (so a rule someone else already removed rolls back as a no-op, not a
 * crash) and returns a new state plus a result tagged `rollbackOf`.
 */
export function rollbackRuleResult(
  state: RuleState,
  target: RefineResult,
  options: { id: string; refinementId: string; now?: () => number }
): { state: RuleState; result: RefineResult } {
  return applyRuleEdits(state, invertResult(target), {
    id: options.id,
    requestedScope: target.scope,
    refinementId: options.refinementId,
    now: options.now,
    rollbackOf: target.id,
  });
}
