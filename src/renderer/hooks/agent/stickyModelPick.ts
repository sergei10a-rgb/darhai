/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeping the model the user picked from being undone by a slower read.
 *
 * Every model picker holds the selection in local state and re-syncs it from an
 * `initialModel` prop whenever that prop changes. The sync was unconditional,
 * so a value that was already in flight when the user clicked would land
 * afterwards and quietly put the old model back. What the user saw was their
 * choice applying, then reverting about a second later - and the next message
 * went to a model they had not chosen, at a price they had not agreed to.
 *
 * The reproducible case is the channel settings modal. `initialModel` starts
 * `undefined` there; the restore reads the saved model, resolves it against the
 * provider list, and only then sets it. The Google Auth provider takes one or
 * two SWR cycles to appear, so that restore routinely lands a beat after the
 * modal opens. Pick a model inside that window and the restore overwrites it
 * with the previously saved one.
 *
 * The rule is therefore simple, and deliberately stricter than "ignore the
 * value we just replaced": **once the user has picked, the pick stands until a
 * sync confirms it.** The replaced-value test alone would not have covered the
 * case above, where nothing was selected before the pick and so there was no
 * old value to recognise.
 *
 * The cost of that strictness: a genuine change arriving from somewhere else,
 * between the pick and its confirmation, is ignored. That is the right trade
 * here because in both call sites the only writer of `initialModel` is the same
 * picker - the conversation record it reads is the one its own write updates,
 * and the settings restore is a one-shot. So a differing value in that window
 * is the stale read, not news. The guard is released the moment the sync agrees
 * with the pick, or when the write reports failure, so it never outlives the
 * question it was armed to answer.
 */

/** Identity of a provider/model pair, or null when there is no selection. */
export type ModelKey = string | null;

/** The pick that is waiting to be confirmed by a sync. */
export type PickGuard = { pick: ModelKey } | null;

/**
 * `${providerId}:${modelName}`, the shape both pickers compare on.
 *
 * Provider id and model name together are what identifies a selection: the same
 * model name can be served by two providers at different prices.
 */
export function modelKeyOf(model?: { id?: string; useModel?: string } | null): ModelKey {
  if (!model?.id || !model?.useModel) return null;
  return `${model.id}:${model.useModel}`;
}

/** Start guarding a pick, or nothing if the pick changed nothing. */
export function guardForPick(pick: ModelKey, replaced: ModelKey): PickGuard {
  // Re-picking what is already selected leaves nothing for a late read to undo.
  if (pick === replaced) return null;
  return { pick };
}

/** Whether an incoming `initialModel` sync may overwrite the local selection. */
export function shouldAcceptSync(incoming: ModelKey, guard: PickGuard): boolean {
  if (!guard) return true;
  // Only the pick's own value gets through. Anything else - including an empty
  // value mid-load - is a read that has not caught up yet.
  return incoming === guard.pick;
}

/**
 * The guard after handling a sync.
 *
 * Released as soon as a sync confirms the pick: the two sides agree, so there
 * is nothing left to protect.
 */
export function guardAfterSync(incoming: ModelKey, guard: PickGuard): PickGuard {
  if (!guard) return null;
  return incoming === guard.pick ? null : guard;
}
