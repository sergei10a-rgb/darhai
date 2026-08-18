/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The /refine rule store: wires the pure transforms in `rule.ts` to Darhai's
 * two persistence lanes.
 *
 *  - SESSION rules live only in memory, keyed by session id. They are never
 *    written to disk, so they cannot leak into the cross-session global store.
 *  - GLOBAL rules are mirrored to the on-disk archive through the injected
 *    `persistGlobal` / `removeGlobal` deps (the real wiring below uses the
 *    existing quickAdd / listEntries / deleteEntry paths).
 *
 * Collaborators are injected so the store unit-tests with no disk / archive:
 * the tests assert that a session refinement touches NEITHER disk dep, and a
 * global one touches them exactly as its applied edits describe.
 */

import log from 'electron-log';
import { getIjfwArchiveService } from '../ijfwArchiveService';
import {
  applyRuleEdits,
  emptyRuleState,
  rollbackRuleResult,
  type RefineResult,
  type RefineRule,
  type RuleEdit,
  type RuleScope,
  type RuleState,
} from './rule';

/** Native memory type a persisted global rule is stored under. */
const GLOBAL_RULE_TYPE = 'decision';

export type RefineStoreDeps = {
  /** Persist one accepted global rule to disk. */
  persistGlobal: (rule: RefineRule) => Promise<void>;
  /** Remove one global rule from disk (rollback / explicit remove). */
  removeGlobal: (rule: RefineRule) => Promise<void>;
  /** Clock, injectable for deterministic ids/tests. */
  now?: () => number;
};

/** Generate a sortable, unique refinement id (prime's `refine_<ts>` shape). */
function makeRefinementId(now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 8);
  return `refine_${stamp}_${rand}`;
}

export class RefineRuleStore {
  private readonly deps: RefineStoreDeps;
  private readonly now: () => number;

  /** Session-scoped rules, per session id. Never persisted. */
  private readonly sessionStates = new Map<string, RuleState>();
  /** The single global rule set, mirrored to disk. */
  private globalState: RuleState = emptyRuleState();
  /** Completed passes, by result id, so a rollback can find its target. */
  private readonly results = new Map<string, RefineResult>();

  constructor(deps: RefineStoreDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Current rules for a scope (session rules are per-session). */
  getRules(scope: RuleScope, sessionId: string): readonly RefineRule[] {
    return this.stateFor(scope, sessionId).rules;
  }

  private stateFor(scope: RuleScope, sessionId: string): RuleState {
    if (scope === 'global') return this.globalState;
    return this.sessionStates.get(sessionId) ?? emptyRuleState();
  }

  private setState(scope: RuleScope, sessionId: string, state: RuleState): void {
    if (scope === 'global') this.globalState = state;
    else this.sessionStates.set(sessionId, state);
  }

  /**
   * Run one refinement pass over `requestedScope`. The gate inside
   * `applyRuleEdits` refuses any edit whose scope differs from `requestedScope`,
   * so a session pass physically cannot admit a global edit. Only a global pass
   * ever reaches the disk deps.
   */
  async refine(edits: readonly RuleEdit[], requestedScope: RuleScope, sessionId: string): Promise<RefineResult> {
    const id = makeRefinementId(this.now());
    const before = this.stateFor(requestedScope, sessionId);
    const { state, result } = applyRuleEdits(before, edits, {
      id,
      requestedScope,
      refinementId: id,
      now: this.now,
    });
    this.setState(requestedScope, sessionId, state);
    this.results.set(result.id, result);

    if (requestedScope === 'global') {
      await this.reflectToDisk(result);
    }
    return result;
  }

  /**
   * Roll back a completed pass by id. Restores the exact rules it added or
   * removed and mirrors the reversal to disk when the pass was global. Returns
   * null when the id is unknown.
   */
  async rollback(resultId: string, sessionId: string): Promise<RefineResult | null> {
    const target = this.results.get(resultId);
    if (!target) return null;

    const id = makeRefinementId(this.now());
    const before = this.stateFor(target.scope, sessionId);
    const { state, result } = rollbackRuleResult(before, target, {
      id,
      refinementId: id,
      now: this.now,
    });
    this.setState(target.scope, sessionId, state);
    this.results.set(result.id, result);

    if (target.scope === 'global') {
      await this.reflectToDisk(result);
    }
    return result;
  }

  /**
   * Mirror a global result's applied edits to disk. Failures are logged, not
   * thrown: the in-memory rule set is the source of truth for the session, and
   * a disk hiccup must not crash the refinement.
   */
  private async reflectToDisk(result: RefineResult): Promise<void> {
    for (const edit of result.applied) {
      if (!edit.applied) continue;
      try {
        if (edit.after) {
          // eslint-disable-next-line no-await-in-loop
          await this.deps.persistGlobal(edit.after);
        } else if (edit.before) {
          // eslint-disable-next-line no-await-in-loop
          await this.deps.removeGlobal(edit.before);
        }
      } catch (err) {
        log.warn('[refine] disk mirror failed for edit', { id: edit.id, err });
      }
    }
  }
}

// ===== Real wiring =====

/**
 * Persist a global rule through the existing quickAdd path. The rule text lands
 * as an inert scalar (sanitizeYamlScalar clamps it), tagged so the Memory panel
 * can surface it as a global refinement.
 */
async function persistGlobalRule(rule: RefineRule): Promise<void> {
  await getIjfwArchiveService().quickAdd(rule.text, 'global', GLOBAL_RULE_TYPE);
}

/**
 * Remove a global rule from disk. quickAdd stores the rule text as the entry
 * summary, so we locate the matching global entry by exact summary and delete
 * it. A rule that is not found on disk (already gone) is a no-op.
 */
async function removeGlobalRule(rule: RefineRule): Promise<void> {
  const archive = getIjfwArchiveService();
  const { entries } = await archive.listEntries({ project: 'global', search: rule.text, limit: 25 });
  const match = entries.find((e) => e.summary === rule.text);
  if (!match) return;
  await archive.deleteEntry(match.id);
}

/** Build the store wired to Darhai's real archive collaborators. */
export function createRefineRuleStore(): RefineRuleStore {
  return new RefineRuleStore({
    persistGlobal: persistGlobalRule,
    removeGlobal: removeGlobalRule,
  });
}
