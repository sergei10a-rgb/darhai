/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable goals - the engine's long-running objective, journalled so it
 * survives a restart.
 *
 * WHAT THIS IS. A goal is an objective plus an iteration ceiling, a loop-owner
 * lease, and a task list with dependencies, all written to the engine's
 * journal. Darhai is not the durable store here; the engine is. The host's job
 * is to read the three events the engine publishes (`goal_snapshot`,
 * `goal_transition`, `goal_control_refused`) and to send the five control
 * commands (`goal_open`, `goal_declare_task`, `goal_advance`, `goal_cancel`,
 * `goal_resync`) with a cursor the engine will accept.
 *
 * WHY DROPPING IT WAS THE BUG. All three events used to sit in
 * `ACKNOWLEDGED_UNHANDLED_EVENTS`, and one of them - `goal_control_refused` -
 * is graded `criticality: "safety"` in the manifest. So when Darhai sent a goal
 * command the engine refused (`reason: "cursor_stale"`), nothing told the user:
 * the command silently did nothing and the UI kept showing a goal that was not
 * moving. All three now route here instead.
 *
 * THE ONE INVARIANT A HOST CAN ACTUALLY GET WRONG IS THE CURSOR.
 * `goal_advance` and `goal_cancel` both list `cursor` in their schema
 * `required` block, and the host cannot mint one - a cursor is a position in
 * the engine's journal. It can only ECHO the last cursor the engine published.
 * Everything in {@link GoalCursorRegistry} exists to make sure the cursor a
 * command carries is one the engine actually announced, and to refuse to build
 * a command at all when it is not.
 *
 * MEASURED, NOT GUESSED - which cursor gets echoed. `events/goal_snapshot.json`
 * carries TWO cursors: a top-level one (`sha256:goalcursor`, sequence 22) and a
 * second one inside `goal` (`9999...`, sequence 22). They disagree.
 * `commands/goal_advance.json` and `commands/goal_cancel.json` both carry the
 * TOP-LEVEL one, digit for digit. So the top-level cursor is the one a control
 * command echoes and `goal.cursor` is not; that is read off the contract's own
 * payloads and pinned by a test that deep-equals the built command against the
 * shipped example.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE, AND WHAT THIS MODULE CHOSE. There are
 * ZERO adversarial fixtures for durable goals - `manifest.subcontracts` has no
 * `durable_goals` entry at all, and `compat/` contains no goal payload. So
 * duplicate delivery, replay and out-of-order behaviour are undeclared. Every
 * rule in {@link GoalCursorRegistry} is derived from the manifest's own
 * `correlation` grading (`goal_id_and_cursor` for the two observational
 * events, `request_id_goal_id_and_cursor` for advance/cancel), from the JSON
 * Schema, and from the shape of the payloads - never from a fixture filename.
 * Each one is named at its rule below. The direction of every choice is the
 * same: never send a control command on a cursor the host cannot vouch for.
 *
 * WIRING - STATUS, checked against the files named rather than assumed:
 *
 *  1. DONE. `capabilities/index.ts` lists {@link durableGoalsCapability} in
 *     `HANDLERS`, so `dispatchCapabilityEvent` routes goal events here.
 *  2. DONE. The three goal types have left `ACKNOWLEDGED_UNHANDLED_EVENTS` in
 *     `protocol.ts`. Both halves matter together:
 *     `tests/unit/wcore-capabilityDispatch.test.ts` fails a type that is both
 *     claimed and listed inert.
 *  3. DONE. Every frame below carries an EMPTY `msg_id` - a goal outlives the
 *     turn that opened it - and `WCoreManager` drops such a frame unless its
 *     type is in `CAPABILITY_FRAME_TYPES`, built from
 *     `forwardableFrameTypes()`. That set is `handles` UNION `emits`; this
 *     module emits only under the three types it declares in `handles`, so it
 *     needs no `emits`. Emitting under an invented name would be dropped two
 *     processes upstream with every test still green - the failure that cost
 *     the workflow card a whole wave. `tests/unit/wcore-capabilityFrameForwarding.test.ts`
 *     scans this file for exactly that mistake.
 *  4. DONE. Mission Control renders these frames; it takes capability
 *     availability from `wcoreEngine.capabilitySnapshot`, NOT from
 *     `capability_activation` - see the note on {@link DURABLE_GOALS_CAPABILITY}.
 */

import { randomBytes } from 'node:crypto';

import { isCapabilityAvailable } from '../contractNegotiation';
import type { NegotiatedContract } from '../contractNegotiation';
import type { CapabilityContext, CapabilityHandler } from '../types';

/**
 * The capability id the engine grades in `ready.contract.capabilities`.
 *
 * That map is the ONLY place this name appears. It is NOT an id the engine
 * announces in `capability_activation` - MEASURED against the vendored
 * captures, those frames name eight engine-INTERNAL subsystems
 * (`delegate_isolation`, `learned_policy`, ...) and the two namespaces do not
 * intersect. A reader that waits for an activation frame named
 * `durable_goals_v1` waits forever; the renderer therefore takes availability
 * from `wcoreEngine.capabilitySnapshot`, which carries the contract grades.
 * `tests/unit/wcore-engineCapabilitySnapshot.test.ts` pins the disjointness so
 * this stops being folklore.
 */
export const DURABLE_GOALS_CAPABILITY = 'durable_goals_v1';

/**
 * The three event types this capability claims, exactly the set the manifest
 * files under `capability: "durable_goals_v1"`.
 *
 * One array, from which `handles` is built - a second hand-written list next to
 * this one is two things that drift, and the drift shows up as an event routed
 * nowhere.
 */
export const GOAL_EVENT_TYPES = ['goal_snapshot', 'goal_transition', 'goal_control_refused'] as const;

/**
 * `goal_version` when the host has never seen one for this goal.
 *
 * A GUESS, AND SAID SO. Every fixture in the bundle says `1`, but nothing
 * declares what the field means: `manifest.subcontracts` lists eight
 * subcontracts and `durable_goals` is not among them, so unlike
 * `recovery_version` there is no published version for goals at all. If it is
 * instead a per-goal optimistic-concurrency revision, a host that hardcodes 1
 * has every command refused.
 *
 * The mitigation is to hardcode as little as possible: every command built for
 * a goal the host has already SEEN echoes the `goal_version` the engine last
 * published for it (see {@link GoalState.goalVersion}), which is correct under
 * both readings. This constant is only reached by `goal_open`, where no prior
 * event exists to echo.
 */
export const DEFAULT_GOAL_VERSION = 1;

/**
 * How many goals the registry holds at once.
 *
 * A HOST-SIDE BOUND, not a contract number - nothing in the bundle limits how
 * many goals a session may open. It is needed because `HANDLERS` in
 * `capabilities/index.ts` is a module singleton shared by every `WCoreAgent` in
 * the main process, and there is no teardown hook on `CapabilityHandler` for
 * agent exit. Without a cap, a long-lived main process leaks one entry per
 * conversation for ever.
 *
 * Eviction is LEAST-RECENTLY-OBSERVED and NOT lifecycle-driven. `lifecycle.state`
 * is a free string in the schema and the only value anywhere in the bundle is
 * `"running"`, so nothing states which state means "finished". Guessing a
 * terminal name and evicting on it would drop the cursor needed to CANCEL a
 * goal that is still alive; holding a finished goal costs one bounded slot.
 * Insertion order would be the wrong tiebreak for the same reason: it drops the
 * OLDEST goal, which is the longest-running one and the most likely to still
 * need cancelling. So every observation moves its goal to the back of the queue
 * and a goal is only evicted once 63 others have been observed more recently
 * than it. At the bound the evicted goal's cursor is gone and control commands
 * for it refuse until a `goal_resync`, which is why eviction is REPORTED
 * ({@link GoalCursorDecision.evictedGoalId}) rather than silent.
 *
 * Only an observation may allocate a slot. A `goal_control_refused` names a
 * wire-controlled `goal_id` and must never allocate one, or 64 refusals naming
 * goals that do not exist would evict every real cursor.
 */
export const MAX_TRACKED_GOALS = 64;

/**
 * How many task entries are kept per goal.
 *
 * `goal.tasks` is a wire-controlled array with no `maxItems` in the schema, and
 * the registry retains what it decodes for the life of the process. Copying an
 * unbounded array into long-lived state is the leak; the loop itself is bounded
 * by the payload the JSON parser already materialised. 256 is a pick - four
 * times the goal cap - and truncation is REPORTED on the frame
 * (`tasksTruncated`) rather than being silent, so a goal with more tasks than
 * this shows as incomplete instead of looking complete.
 */
export const MAX_TASKS_PER_GOAL = 256;

/**
 * How many `depends_on` entries are kept per task.
 *
 * THE SAME RULE AS `tasks`, WHICH THIS FIELD PREVIOUSLY ESCAPED.
 * `task.depends_on` has no `maxItems` in the schema either, and it is copied
 * into {@link GoalState.record} for the life of the process AND onto the frame
 * that crosses the IPC boundary to the renderer - so an engine that sends
 * 50,000 dependencies on one task sizes both. The engine can send any number;
 * beyond this one the tail is dropped and the drop is REPORTED on the frame
 * (`dependsOnTruncated`), never silently. 32 is a choice: every shipped fixture
 * declares at most one dependency, and a task with more than 32 is already past
 * what a dependency list in a UI can show.
 */
export const MAX_DEPENDS_ON_PER_TASK = 32;

/**
 * The longest engine-supplied PROSE string this host retains or forwards.
 *
 * A COUNT CAP ALONE LEAVES THE PRODUCT UNBOUNDED. `objective`, `state_digest`
 * and `reason` are engine-controlled strings with no `maxLength` anywhere in the
 * schema; `objective` and the identity digest are held in {@link GoalState} for
 * the life of the process, and `reason` is copied three times per refusal (a
 * log line, a warning, and the frame). One unbounded string is the same class of
 * leak as one unbounded loop. The engine may send any length; past this one the
 * value is clamped, the clamp is reported (`textClamped`, or a note in the
 * refusal detail), and nothing is silently rewritten. 4096 is a choice - roomy
 * for an objective a person typed, and ~160x the longest string in any shipped
 * goal payload.
 *
 * The cost is stated rather than hidden: two `state_digest` values that agree on
 * their first 4096 characters would compare equal and a `state_conflict` would
 * be missed. Every digest the contract ships is 71 characters.
 */
export const MAX_GOAL_TEXT = 4096;

/**
 * The longest engine-supplied IDENTIFIER this host retains or forwards.
 *
 * `task_id`, `status`, `idempotency_key`, `lifecycle.state` and each
 * `depends_on` entry are ids and enum-ish tokens, not prose, and they are the
 * fields multiplied by {@link MAX_TASKS_PER_GOAL} and
 * {@link MAX_DEPENDS_ON_PER_TASK}, so their cap is what actually bounds
 * retention. 128 is NOT invented: it is the engine's own ceiling for an
 * identifier, from the `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` pattern it
 * publishes for `continue_with_budget.request_id` (see {@link GOAL_ID_PATTERN}).
 * Past it the value is clamped and the clamp is reported.
 *
 * The three caps together are the ceiling on what one engine can make this
 * module hold: 64 goals x 256 tasks x (3 ids + 32 dependencies) x 128
 * characters is roughly 73 MB in the absolute worst case, where it was
 * previously unbounded.
 */
export const MAX_GOAL_ID_TEXT = 128;

/**
 * The longest `journal_digest` this host will adopt as a cursor.
 *
 * THIS ONE FAILS CLOSED INSTEAD OF CLAMPING, and that asymmetry is the point: a
 * cursor is echoed back to the engine verbatim on `goal_advance`/`goal_cancel`,
 * so a clamped digest would be a command carrying a cursor the engine never
 * published - exactly the failure this module exists to prevent. Past this
 * length the cursor is not adopted, the last complete cursor is kept, and the
 * frame reports `uncursored`, which is the same answer a half cursor gets. 512
 * is a choice: the shipped digests are 71 characters (`sha256:` + hex) and a
 * hex SHA-512 with a prefix is 135, so this is roughly 4x the largest digest any
 * plausible hash produces.
 */
export const MAX_CURSOR_DIGEST_TEXT = 512;

/**
 * How many sent goal commands are remembered for correlating a refusal.
 *
 * `goal_control_refused` carries `request_id`, and the manifest correlates it
 * on `request_id_and_goal_id` - BOTH fields, which is why each entry keeps the
 * session and goal it was sent for and {@link GoalCursorRegistry.refuse} checks
 * them rather than trusting the id alone. Unlike a budget grant, SUCCESS has no
 * acknowledgement: a `goal_advance` that works produces a `goal_snapshot` with
 * no `request_id` in it, so an entry can never be retired on success. This is
 * therefore a short ring, not a ledger of outstanding work.
 *
 * Eviction here is SILENT, unlike goal eviction. Dropping an entry costs only
 * the ability to NAME a later refusal - the refusal is still warned about and
 * still framed, as "an unremembered goal command" - whereas dropping a goal
 * costs its cursor and with it the advance and cancel buttons. Warning on the
 * ordinary case (64 commands sent with no refusal in between) would train the
 * operator to ignore the log.
 */
export const MAX_RECENT_GOAL_REQUESTS = 64;

/**
 * `request_id` and the id fields this host is willing to put on the wire.
 *
 * BORROWED, AND SAID SO. The five goal command branches declare `request_id`,
 * `goal_id` and `task_id` as bare `type: string` - no pattern, no `minLength`.
 * The engine DOES publish a pattern for the same field on
 * `continue_with_budget` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), together with
 * four adversarial fixtures aimed at empty, whitespace-only, over-long and
 * emoji request ids. That is the engine's own statement of what it polices for
 * a correlation id, so it is reused here rather than inventing a second rule.
 *
 * It matters because `goal_control_refused` is correlated back to a sent
 * command by `request_id` and `goal_id`: an empty or whitespace-only id is a
 * refusal nobody can match to the command that caused it, which is exactly the
 * silent drop this capability exists to close.
 *
 * IT DOES NOT COVER `idempotency_key`, and borrowing it there was wrong. That
 * argument is about ids the HOST mints to correlate a reply; `idempotency_key`
 * is supplied by the caller, is never correlated on, and is commonly a hash or
 * base64 - `sha256:abc/def+ghi=` fails this pattern for no reason the contract
 * states. See {@link idempotencyKeyFault}.
 */
export const GOAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * How long an `idempotency_key` this host will put on the wire.
 *
 * The schema declares the field a bare `type: string` - no pattern, no
 * `maxLength` - so the only bound is the one the host chooses. The caller
 * controls this string and it is written to the engine's stdin, so an unbounded
 * one is an unbounded write. At the bound the command is REFUSED with the
 * reason rather than being truncated: a truncated idempotency key is a
 * different key, and silently changing it would defeat the field's whole
 * purpose. 512 is a choice - 8x a hex SHA-256, 11x a base64 32-byte digest.
 */
export const MAX_IDEMPOTENCY_KEY_TEXT = 512;

// ============================================
// Wire types - engine -> Desktop
// ============================================

/**
 * A position in the engine's journal.
 *
 * The schema marks NEITHER field required and sets `additionalProperties: true`
 * on the object, so optional here is the faithful mapping. Every shipped
 * fixture populates both.
 */
export type GoalCursor = {
  journal_digest?: string;
  journal_sequence?: number;
};

/** Free string in the schema. Only `'running'` appears in any fixture. */
export type GoalLifecycle = {
  state?: string;
};

/** `goal_snapshot.goal.authority`. No field inside is schema-required. */
export type GoalAuthority = {
  strategy?: string;
  snapshot_digest?: string;
  parent_envelope_digest?: string;
  effective_limits?: { max_tokens?: number };
  loop_policy?: { kind?: string; iterations?: number };
};

/** `goal_snapshot.goal.loop_owner` - the lease that says who drives the loop. */
export type GoalLoopOwner = {
  epoch?: number;
  lease_expires_unix_ms?: number;
  strategy?: string;
};

/**
 * One entry of `goal_snapshot.goal.tasks`.
 *
 * The schema's `tasks.items` is an `anyOf` of TWO shapes: one carrying
 * `outcome` and no `depends_on` (a completed task), one carrying `depends_on`
 * and no `outcome` (a blocked task). Both are `additionalProperties: true` with
 * no required list, so the merged all-optional shape is exactly what the schema
 * permits. This is deliberately NOT a discriminated union - there is no
 * discriminant to switch on.
 */
export type GoalTaskEntry = {
  task_id?: string;
  status?: string;
  attempts?: number;
  epoch?: number;
  dependency_releases?: number;
  idempotency_key?: string;
  last_transition_seq?: number;
  depends_on?: string[];
  outcome?: { state?: string };
};

/** `goal_snapshot.goal` - no field inside is schema-required. */
export type GoalRecord = {
  goal_id?: string;
  objective?: string;
  lifecycle?: GoalLifecycle;
  cursor?: GoalCursor;
  authority?: GoalAuthority;
  loop_owner?: GoalLoopOwner;
  loop_owner_epochs?: number;
  iteration_ceiling?: number;
  iterations_started?: number;
  opened_at_unix_ms?: number;
  resume_count?: number;
  tasks?: GoalTaskEntry[];
};

/**
 * The three goal events, as they appear on the wire.
 *
 * Declared HERE and not in `protocol.ts` on purpose: the capability seam routes
 * through the decoder's `default` arm, so a type added to `WCoreEvent` would
 * get a `case` arm above that default and never reach the dispatcher at all.
 */
export type WCoreGoalEvent =
  | {
      type: 'goal_snapshot';
      goal_version: number;
      session_id: string;
      goal_id: string;
      cursor: GoalCursor;
      state_digest: string;
      goal: GoalRecord;
    }
  | {
      type: 'goal_transition';
      goal_version: number;
      session_id: string;
      goal_id: string;
      cursor: GoalCursor;
      transition: string;
      lifecycle: GoalLifecycle;
    }
  | {
      type: 'goal_control_refused';
      goal_version: number;
      request_id: string;
      session_id: string;
      goal_id: string;
      reason: string;
    };

// ============================================
// Wire types - Desktop -> engine
// ============================================

export type GoalOpenCommand = {
  type: 'goal_open';
  goal_version: number;
  request_id: string;
  session_id: string;
  goal_id: string;
  objective: string;
  iterations: number;
  strategy: string;
  max_tokens: number;
};

export type GoalDeclareTaskCommand = {
  type: 'goal_declare_task';
  goal_version: number;
  request_id: string;
  session_id: string;
  goal_id: string;
  task_id: string;
  /** NOT in the schema's required list, though the example payload sends both. */
  depends_on?: string[];
  idempotency_key?: string;
};

export type GoalAdvanceCommand = {
  type: 'goal_advance';
  goal_version: number;
  request_id: string;
  session_id: string;
  goal_id: string;
  cursor: GoalCursor;
};

export type GoalCancelCommand = {
  type: 'goal_cancel';
  goal_version: number;
  request_id: string;
  session_id: string;
  goal_id: string;
  cursor: GoalCursor;
};

export type GoalResyncCommand = {
  type: 'goal_resync';
  goal_version: number;
  request_id: string;
  session_id: string;
  /**
   * `goal_id` is NOT in this command's required list, unlike every other goal
   * command, although the example payload sends it. Omitting it plausibly means
   * "resync every goal in the session" - the contract does not say, so the
   * builder emits the field only when a caller supplies one and never invents
   * a goal id to satisfy a rule the schema does not state.
   */
  goal_id?: string;
};

export type WCoreGoalCommand =
  | GoalOpenCommand
  | GoalDeclareTaskCommand
  | GoalAdvanceCommand
  | GoalCancelCommand
  | GoalResyncCommand;

// ============================================
// Decoding
// ============================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

function optionalInteger(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

/**
 * What one decode had to shorten, so the frame can say so instead of showing a
 * clipped goal as a whole one.
 */
export type GoalParseNotes = {
  /** `goal.tasks` was longer than {@link MAX_TASKS_PER_GOAL}. */
  tasksTruncated: boolean;
  /** Some task's `depends_on` was longer than {@link MAX_DEPENDS_ON_PER_TASK}. */
  dependsOnTruncated: boolean;
  /** Some engine string was longer than its cap and was cut to it. */
  textClamped: boolean;
};

function newParseNotes(): GoalParseNotes {
  return { tasksTruncated: false, dependsOnTruncated: false, textClamped: false };
}

/**
 * A string this host is willing to hold on to, cut to its cap.
 *
 * Non-strings return `undefined` - the schema types every field below as
 * `type: string`, and a wire value that is not one is absent rather than
 * coerced. Clamping is recorded so it can be reported; a silently clipped
 * objective would read as the objective.
 */
function clampedString(raw: unknown, max: number, notes: GoalParseNotes): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length <= max) return raw;
  notes.textClamped = true;
  return raw.slice(0, max);
}

/** Clamp one engine string outside the record decoder, e.g. a refusal `reason`. */
function clampText(value: string, max: number): { text: string; clamped: boolean } {
  if (value.length <= max) return { text: value, clamped: false };
  return { text: value.slice(0, max), clamped: true };
}

/**
 * A cursor this host is willing to echo back to the engine.
 *
 * FAIL-CLOSED CHOICE ON A SILENT SCHEMA. Neither `journal_digest` nor
 * `journal_sequence` is required, so `cursor: {}` is a legal payload. It is
 * also useless: without a sequence the host cannot tell a replay from an
 * advance, and without a digest it cannot tell two different journal states at
 * one sequence apart. A half-cursor put on `goal_advance` is the shape most
 * likely to draw `cursor_stale` back. So a cursor is TRACKABLE only when it
 * carries both halves, and when the digest is inside
 * {@link MAX_CURSOR_DIGEST_TEXT}; anything less is reported and the last
 * complete cursor is kept. The alternative - echoing whatever arrived - would
 * look like it worked right up to the point the engine refused.
 */
export type TrackableCursor = { journal_digest: string; journal_sequence: number };

function parseCursor(raw: unknown): TrackableCursor | null {
  if (!isRecord(raw)) return null;
  const digest = optionalString(raw.journal_digest);
  const sequence = optionalInteger(raw.journal_sequence);
  if (digest === undefined || digest.length === 0 || sequence === undefined) return null;
  // Not clamped - see MAX_CURSOR_DIGEST_TEXT. A cursor is echoed back verbatim,
  // so an over-long digest is refused rather than shortened into a cursor the
  // engine never published.
  if (digest.length > MAX_CURSOR_DIGEST_TEXT) return null;
  return { journal_digest: digest, journal_sequence: sequence };
}

function parseTask(raw: unknown, notes: GoalParseNotes): GoalTaskEntry {
  if (!isRecord(raw)) return {};
  const task: GoalTaskEntry = {};
  task.task_id = clampedString(raw.task_id, MAX_GOAL_ID_TEXT, notes);
  task.status = clampedString(raw.status, MAX_GOAL_ID_TEXT, notes);
  task.attempts = optionalInteger(raw.attempts);
  task.epoch = optionalInteger(raw.epoch);
  task.dependency_releases = optionalInteger(raw.dependency_releases);
  task.idempotency_key = clampedString(raw.idempotency_key, MAX_GOAL_ID_TEXT, notes);
  task.last_transition_seq = optionalInteger(raw.last_transition_seq);
  if (Array.isArray(raw.depends_on)) {
    // `slice` bounds what is COPIED into long-lived state; the source array was
    // already materialised by the JSON parser, so bounding the loop is not the
    // point - bounding what survives it is.
    if (raw.depends_on.length > MAX_DEPENDS_ON_PER_TASK) notes.dependsOnTruncated = true;
    const kept: string[] = [];
    for (const entry of raw.depends_on.slice(0, MAX_DEPENDS_ON_PER_TASK)) {
      // The schema types these `string`; a non-string entry is dropped rather
      // than forwarded to the renderer as a dependency it cannot resolve.
      const id = clampedString(entry, MAX_GOAL_ID_TEXT, notes);
      if (id !== undefined) kept.push(id);
    }
    task.depends_on = kept;
  }
  if (isRecord(raw.outcome)) task.outcome = { state: clampedString(raw.outcome.state, MAX_GOAL_ID_TEXT, notes) };
  return task;
}

/**
 * Decode `goal_snapshot.goal`.
 *
 * Every nested object is `additionalProperties: true` with NO required list, so
 * a live payload may legally omit `lifecycle`, `cursor` or the whole `tasks`
 * array. Nothing here dereferences without checking, because a decoder that
 * does would throw on a payload the engine considers perfectly valid - and a
 * throwing handler is swallowed by the dispatcher, which turns a decode bug
 * into a silently unhandled safety-class event.
 */
function parseGoalRecord(raw: unknown): { record: GoalRecord; notes: GoalParseNotes; reportedTaskCount?: number } {
  const notes = newParseNotes();
  // An unreadable goal payload is a goal this host learned NOTHING about, so it
  // reports no count at all. Returning 0 here would hand the renderer a number
  // it can only read as "the engine says this goal has no tasks".
  if (!isRecord(raw)) return { record: {}, notes };

  const record: GoalRecord = {
    goal_id: clampedString(raw.goal_id, MAX_GOAL_ID_TEXT, notes),
    objective: clampedString(raw.objective, MAX_GOAL_TEXT, notes),
    loop_owner_epochs: optionalInteger(raw.loop_owner_epochs),
    iteration_ceiling: optionalInteger(raw.iteration_ceiling),
    iterations_started: optionalInteger(raw.iterations_started),
    opened_at_unix_ms: optionalInteger(raw.opened_at_unix_ms),
    resume_count: optionalInteger(raw.resume_count),
  };

  if (isRecord(raw.lifecycle))
    record.lifecycle = { state: clampedString(raw.lifecycle.state, MAX_GOAL_ID_TEXT, notes) };
  if (isRecord(raw.cursor)) {
    // `goal.cursor` is NOT the cursor a command echoes (the top-level one is),
    // so it is display-only and may be clamped like any other retained string.
    record.cursor = {
      journal_digest: clampedString(raw.cursor.journal_digest, MAX_CURSOR_DIGEST_TEXT, notes),
      journal_sequence: optionalInteger(raw.cursor.journal_sequence),
    };
  }
  if (isRecord(raw.authority)) {
    const authority = raw.authority;
    const decoded: GoalAuthority = {
      strategy: clampedString(authority.strategy, MAX_GOAL_ID_TEXT, notes),
      snapshot_digest: clampedString(authority.snapshot_digest, MAX_CURSOR_DIGEST_TEXT, notes),
      parent_envelope_digest: clampedString(authority.parent_envelope_digest, MAX_CURSOR_DIGEST_TEXT, notes),
    };
    if (isRecord(authority.effective_limits)) {
      decoded.effective_limits = { max_tokens: optionalInteger(authority.effective_limits.max_tokens) };
    }
    if (isRecord(authority.loop_policy)) {
      decoded.loop_policy = {
        kind: clampedString(authority.loop_policy.kind, MAX_GOAL_ID_TEXT, notes),
        iterations: optionalInteger(authority.loop_policy.iterations),
      };
    }
    record.authority = decoded;
  }
  if (isRecord(raw.loop_owner)) {
    record.loop_owner = {
      epoch: optionalInteger(raw.loop_owner.epoch),
      lease_expires_unix_ms: optionalInteger(raw.loop_owner.lease_expires_unix_ms),
      strategy: clampedString(raw.loop_owner.strategy, MAX_GOAL_ID_TEXT, notes),
    };
  }

  // Counted BEFORE the slice. `record.tasks.length` measures this host's buffer,
  // not the goal: past the cap it is always exactly MAX_TASKS_PER_GOAL, so a
  // 900-task goal would report 256 - a number that reads as a measurement of the
  // goal while being a measurement of the ceiling.
  //
  // Left UNDEFINED when the array is absent, which this schema makes legal (see
  // the block comment above). `0` is the engine saying "this goal has no tasks";
  // silence is the engine saying nothing, and the renderer prints a different
  // sentence for each. Seeding this at 0 made every silent payload claim the
  // first - the same buffer-length-as-measurement error one level up.
  let reportedTaskCount: number | undefined;
  if (Array.isArray(raw.tasks)) {
    reportedTaskCount = raw.tasks.length;
    notes.tasksTruncated = raw.tasks.length > MAX_TASKS_PER_GOAL;
    record.tasks = raw.tasks.slice(0, MAX_TASKS_PER_GOAL).map((task) => parseTask(task, notes));
  }

  return { record, notes, reportedTaskCount };
}

// ============================================
// Cursor discipline
// ============================================

/** What the registry decided about one event's cursor. */
export type GoalCursorVerdict =
  /** First cursor seen for this goal. Adopted. */
  | 'seeded'
  /** `journal_sequence` moved forward. Adopted; `skipped` says how far. */
  | 'advanced'
  /** Same cursor, same identity payload - a benign replay. No state change. */
  | 'unchanged'
  /** `journal_sequence` moved backwards. Refused; the newer cursor is kept. */
  | 'stale_replay'
  /** Same sequence, different `journal_digest`. Refused; needs a resync. */
  | 'digest_conflict'
  /** Same cursor, different `state_digest`/`transition`. Refused; needs a resync. */
  | 'state_conflict'
  /** The cursor lacks a digest or a sequence, so it cannot be echoed or ordered. */
  | 'uncursored';

export type GoalCursorDecision = {
  verdict: GoalCursorVerdict;
  /** True only when the registry moved this goal's cursor to the announced one. */
  adopted: boolean;
  /** The cursor a control command would carry AFTER this decision. */
  cursor: TrackableCursor | null;
  /** How many journal positions the sequence jumped, on `advanced`. */
  skipped: number;
  /** True while a `goal_resync` is owed before advance/cancel may be built. */
  needsResync: boolean;
  /**
   * The goal dropped to make room for this one, or null.
   *
   * Reaching {@link MAX_TRACKED_GOALS} costs a real cursor, and a cursor that
   * vanishes silently looks like a bug in the control buttons. Reported so the
   * handler can say which goal stopped being controllable and why.
   */
  evictedGoalId: string | null;
  detail: string;
};

/** One goal, as far as this host can vouch for it. */
type GoalState = {
  /**
   * The goal this state belongs to.
   *
   * Kept alongside the key rather than parsed back out of it: the only reader
   * is the eviction message, which names a goal whose state is being dropped,
   * and splitting a key on its NUL separator to recover a field the state
   * already knows is a decoding step that can go wrong for no gain.
   */
  readonly goalId: string;
  cursor: TrackableCursor | null;
  /** `state_digest` of the last adopted snapshot, or the last adopted `transition`. */
  identity: string | null;
  goalVersion: number;
  lifecycleState: string | null;
  objective: string | null;
  needsResync: boolean;
  record: GoalRecord | null;
};

/** What an adopted observation contributes to the held state. */
export type GoalObservationUpdate = {
  record?: GoalRecord;
  lifecycleState?: string;
};

/** One command this host sent, kept only so a refusal can name it. */
export type RecentRequest = {
  readonly requestId: string;
  readonly commandType: WCoreGoalCommand['type'];
  readonly sessionId: string;
  /** Absent for a session-wide `goal_resync`, the one command that omits it. */
  readonly goalId: string | undefined;
  readonly at: number;
};

/**
 * What {@link GoalCursorRegistry.refuse} could establish about one refusal.
 *
 * Three outcomes rather than "matched or not", because they call for three
 * different sentences to the operator and only one of them is an ordinary day.
 */
export type GoalRefusalOutcome = {
  /** Set when `request_id`, `session_id` and `goal_id` all agree with a sent command. */
  matched?: RecentRequest;
  /**
   * Set when a command with this `request_id` was sent for a DIFFERENT goal or
   * session. The engine and this host disagree about what that id names, so
   * neither the command nor the goal may be reported as answered.
   */
  mismatched?: RecentRequest;
  /** True when the host held state for the refused goal and has now locked it. */
  locked: boolean;
  /**
   * True when the goal the MISMATCHED command was sent for was locked as well.
   *
   * A refusal came back for a command sent against that goal's cursor, so that
   * cursor is not known-good either, whichever side of the contradiction is
   * right. Locking both is the fail-closed reading; each clears on its own
   * `goal_resync`.
   */
  lockedSender: boolean;
};

/**
 * Key on session AND goal.
 *
 * `HANDLERS` is a module singleton shared by every `WCoreAgent` in the main
 * process, so a goal-id-only key would let two conversations that both opened
 * `goal-001` overwrite each other's cursor - and the cursor is what decides
 * whether a `goal_cancel` reaches the right goal. NUL separates because it
 * cannot appear in a JSON string value, so no pair of ids can collide by
 * containing the separator.
 */
function keyOf(sessionId: string, goalId: string): string {
  return `${sessionId}\u0000${goalId}`;
}

/**
 * The reducer: what a host may believe about a goal's position in the journal.
 *
 * RULES, in the order they are applied. None of them is quoted from the
 * contract - the bundle ships no adversarial goal fixtures at all - so each one
 * names the evidence it rests on:
 *
 *  0. cursor missing a digest or a sequence -> `uncursored` (not adopted)
 *  1. no cursor held                        -> `seeded` (adopted)
 *  1b. a resync is owed, sequence >= held   -> `seeded` (adopted, clears the flag)
 *  1c. a resync is owed, sequence <  held   -> `stale_replay` (refused, flag kept)
 *  2. same sequence, different digest       -> `digest_conflict` (refused)
 *  3. same cursor, different identity       -> `state_conflict` (refused)
 *  4. same cursor, same identity            -> `unchanged` (benign replay)
 *  5. sequence below the held one           -> `stale_replay` (refused)
 *  6. sequence above the held one           -> `advanced` (adopted)
 *
 * Rules 2 and 3 rest on the manifest grading both observational goal events
 * `correlation: "goal_id_and_cursor"`: the cursor IS the identity of a goal
 * observation, so two different journal digests at one sequence, or two
 * different states at one cursor, is a contradiction rather than an update.
 * Last-write-wins is the wrong default for exactly the reason it is wrong for
 * execution policy - it would let a single frame move the host's idea of the
 * goal while claiming to be the observation it already holds.
 *
 * Rule 6 accepts ANY forward jump, and that is a deliberate difference from the
 * revision chain in `executionPolicy`. A policy `revision` is a counter owned by
 * that one subsystem, so `previous + 2` means a receipt was lost. A goal cursor
 * is a position in the engine's WHOLE journal, which every other subsystem also
 * writes to; two consecutive goal snapshots are expected to sit many sequences
 * apart. Refusing a gap here would refuse ordinary operation. The distance is
 * reported as `skipped` instead of being treated as a fault.
 *
 * RECOVERY IS THE OTHER DELIBERATE DIFFERENCE. `executionPolicy` can never
 * advance again after a gap, and accepts that cost because it has no command to
 * recover with. Goals do: `goal_resync` is published for exactly this. So a
 * contradiction sets {@link GoalState.needsResync}, which blocks advance/cancel,
 * and the next observation AT OR AHEAD OF the held sequence re-seeds and clears
 * it. Refusing to re-seed at all would deadlock the goal for the life of the
 * session, which is why an equal sequence with a new digest is accepted here -
 * restating the truth at one position is what a resync is for.
 *
 * RE-SEEDING IS NOT UNCONDITIONAL, and calling it "the answer to our own
 * resync" would be wishful. The flag is set by EVERY refusal and every
 * contradiction, not only after the host actually sent `goal_resync`, and the
 * answer carries no `request_id` to correlate on - so the next observation to
 * arrive may be an ordinary duplicate or out-of-order snapshot, which the
 * contract leaves undeclared. A cursor STRICTLY BEHIND the held one can never be
 * the recovery: it would arm a position the engine has already moved past, and
 * the next `goal_advance` on it draws the very `cursor_stale` that set the flag
 * - refusal, backwards re-seed, refusal, for as long as the user keeps pressing.
 * So a backwards cursor is refused as `stale_replay` and the lock is KEPT.
 */
export class GoalCursorRegistry {
  private readonly goals = new Map<string, GoalState>();
  private readonly recent = new Map<string, RecentRequest>();

  /** Forget every goal and every remembered request. For a new engine process. */
  reset(): void {
    this.goals.clear();
    this.recent.clear();
  }

  /** The cursor a control command for this goal would echo, or null. */
  cursorFor(sessionId: string, goalId: string): TrackableCursor | null {
    return this.goals.get(keyOf(sessionId, goalId))?.cursor ?? null;
  }

  /** The `goal_version` the engine last published for this goal, or null. */
  goalVersionFor(sessionId: string, goalId: string): number | null {
    const state = this.goals.get(keyOf(sessionId, goalId));
    return state ? state.goalVersion : null;
  }

  /** True while a `goal_resync` is owed before advance/cancel may be built. */
  needsResync(sessionId: string, goalId: string): boolean {
    return this.goals.get(keyOf(sessionId, goalId))?.needsResync === true;
  }

  /** The decoded record of the last adopted snapshot, or null. */
  recordFor(sessionId: string, goalId: string): GoalRecord | null {
    return this.goals.get(keyOf(sessionId, goalId))?.record ?? null;
  }

  /** The objective of the last adopted snapshot, or null. */
  objectiveFor(sessionId: string, goalId: string): string | null {
    return this.goals.get(keyOf(sessionId, goalId))?.objective ?? null;
  }

  /**
   * The lifecycle state last adopted for this goal, or null.
   *
   * Fed by BOTH events - `goal_transition` carries `lifecycle` and no `goal`
   * record, so a host that only read snapshots would show a state one
   * transition out of date.
   */
  lifecycleStateFor(sessionId: string, goalId: string): string | null {
    return this.goals.get(keyOf(sessionId, goalId))?.lifecycleState ?? null;
  }

  /** Tracked `session\u0000goal` keys, least-recently-observed first. For tests. */
  trackedKeys(): readonly string[] {
    return [...this.goals.keys()];
  }

  /** Remembered request ids, oldest first. For diagnostics and tests. */
  recentRequestIds(): readonly string[] {
    return [...this.recent.keys()];
  }

  /**
   * Feed one observation.
   *
   * `identity` is the payload field that must not change under one cursor:
   * `state_digest` for a snapshot, `transition` for a transition. Both are
   * required by their branches of the schema, so the caller always has one.
   */
  observe(
    sessionId: string,
    goalId: string,
    goalVersion: number,
    rawCursor: unknown,
    identity: string,
    update: GoalObservationUpdate
  ): GoalCursorDecision {
    const { state, evictedGoalId } = this.ensure(sessionId, goalId);
    const decision = this.reduce(state, goalVersion, rawCursor, identity, update);
    return evictedGoalId === null ? decision : { ...decision, evictedGoalId };
  }

  private reduce(
    state: GoalState,
    goalVersion: number,
    rawCursor: unknown,
    identity: string,
    update: GoalObservationUpdate
  ): GoalCursorDecision {
    // Echoed on every command built for this goal afterwards, whatever the
    // cursor verdict below turns out to be: `goal_version` is required on all
    // three events, so the engine has just restated it.
    state.goalVersion = goalVersion;

    const announced = parseCursor(rawCursor);
    if (announced === null) {
      // Not a schema violation - neither cursor field is required - but a
      // cursor that cannot be ordered or identified is one this host will not
      // put on a command. Keep whatever complete cursor is already held.
      return this.decide(
        state,
        'uncursored',
        false,
        0,
        'cursor carries no journal_sequence/journal_digest pair this host can echo'
      );
    }

    if (state.cursor === null) {
      return this.adopt(
        state,
        announced,
        identity,
        update,
        'seeded',
        0,
        `seeded at sequence ${announced.journal_sequence}`
      );
    }

    const held = state.cursor;
    if (state.needsResync) {
      // A resync is owed. Only a cursor at or ahead of the held one can answer
      // it - see the note on re-seeding above. Equal is allowed on purpose: a
      // resync restating one position with a new digest is the recovery from
      // `digest_conflict`, and refusing it would deadlock the goal.
      if (announced.journal_sequence >= held.journal_sequence) {
        return this.adopt(
          state,
          announced,
          identity,
          update,
          'seeded',
          0,
          `re-seeded at sequence ${announced.journal_sequence} after a resync was owed`
        );
      }
      return this.decide(
        state,
        'stale_replay',
        false,
        0,
        `sequence ${announced.journal_sequence} is behind the held sequence ${held.journal_sequence}, so it cannot be the resync this goal is owed`
      );
    }

    if (announced.journal_sequence === held.journal_sequence) {
      if (announced.journal_digest !== held.journal_digest) {
        return this.decide(
          state,
          'digest_conflict',
          true,
          0,
          `sequence ${announced.journal_sequence} re-announced with a different journal_digest`
        );
      }
      if (identity !== state.identity) {
        return this.decide(
          state,
          'state_conflict',
          true,
          0,
          `cursor ${announced.journal_sequence} re-announced with a different state`
        );
      }
      return this.decide(state, 'unchanged', false, 0, `cursor ${announced.journal_sequence} re-announced unchanged`);
    }

    if (announced.journal_sequence < held.journal_sequence) {
      // Echoing an older cursor than the newest one seen is the one thing
      // guaranteed to draw `cursor_stale` back from the engine.
      return this.decide(
        state,
        'stale_replay',
        false,
        0,
        `sequence ${announced.journal_sequence} is behind the held sequence ${held.journal_sequence}`
      );
    }

    const skipped = announced.journal_sequence - held.journal_sequence - 1;
    return this.adopt(
      state,
      announced,
      identity,
      update,
      'advanced',
      skipped,
      `advanced to sequence ${announced.journal_sequence}${skipped > 0 ? ` (${skipped} journal position(s) apart)` : ''}`
    );
  }

  /**
   * Record that the engine refused a control command.
   *
   * EVERY refusal sets `needsResync`, not just `cursor_stale`. The bundle
   * enumerates no refusal reasons at all - `reason` is a free string and
   * `"cursor_stale"` is the only value that appears anywhere - so this host
   * cannot tell a transient refusal from a permanent one, and cannot tell a
   * cursor problem from an authorisation one. After any refusal the held cursor
   * is not known-good, and `goal_resync` is the only published way to make it
   * good again. The cost of this choice is one extra resync after a refusal
   * that had nothing to do with the cursor; the cost of the alternative is
   * repeating a control command against a cursor the engine has already
   * rejected.
   *
   * CORRELATION IS ON `request_id` AND `goal_id`, WHICH IS WHAT THE MANIFEST
   * GRADES (`request_id_and_goal_id`) - and the session too, since the registry
   * is keyed by both and one `HANDLERS` singleton serves every agent. Matching
   * on the id alone is worse than useless: a refusal naming another goal would
   * be reported as the answer to a command that goal never sent, would retire
   * the remembered entry so the REAL refusal later reads "an unremembered goal
   * command", and would lock the wrong goal. When the two disagree they are
   * reported as a mismatch, nothing is retired, and BOTH goals are locked - the
   * one the engine named and the one the host sent that request_id for, since a
   * refusal came back for a command carrying the latter's cursor and neither
   * cursor is vouchable until a resync says otherwise.
   *
   * A `goal_resync` sent WITHOUT a `goal_id` is session-wide - the only command
   * whose schema permits that - so it correlates to a refusal naming any goal in
   * its session, and is NOT retired: one session-wide command may draw one
   * refusal per goal, and retiring on the first would make the rest unnameable.
   *
   * ONLY A GOAL THE HOST ALREADY TRACKS IS LOCKED. `goal_id` here is
   * wire-controlled and this method must not allocate a slot for it (see
   * {@link MAX_TRACKED_GOALS}). Nothing is lost: a goal with no held state has
   * no cursor to invalidate, control commands for it already refuse with "no
   * cursor has been published", and its first snapshot seeds from scratch.
   */
  refuse(sessionId: string, goalId: string, goalVersion: number, requestId: string): GoalRefusalOutcome {
    const state = this.goals.get(keyOf(sessionId, goalId));
    if (state) {
      state.goalVersion = goalVersion;
      state.needsResync = true;
    }
    const locked = state !== undefined;

    const remembered = this.recent.get(requestId);
    if (remembered === undefined) return { locked, lockedSender: false };
    const sessionAgrees = remembered.sessionId === sessionId;
    // A `goal_resync` with no `goal_id` was sent for the whole session, so any
    // goal in that session is one it was sent for.
    if (sessionAgrees && (remembered.goalId === undefined || remembered.goalId === goalId)) {
      // Retire only an exactly-scoped entry: a session-wide resync may draw one
      // refusal per goal and must stay nameable for all of them.
      if (remembered.goalId !== undefined) this.recent.delete(requestId);
      return { matched: remembered, locked, lockedSender: false };
    }

    // Contradiction. The entry is KEPT - the refusal that really answers it may
    // still arrive - and the goal it was sent for is locked too, because a
    // refusal came back for a command carrying that goal's cursor.
    const sender =
      remembered.goalId === undefined ? undefined : this.goals.get(keyOf(remembered.sessionId, remembered.goalId));
    if (sender) sender.needsResync = true;
    return { mismatched: remembered, locked, lockedSender: sender !== undefined };
  }

  /** Remember a sent command so a later refusal can name it. */
  remember(command: WCoreGoalCommand): void {
    if (this.recent.size >= MAX_RECENT_GOAL_REQUESTS) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
    this.recent.set(command.request_id, {
      requestId: command.request_id,
      commandType: command.type,
      sessionId: command.session_id,
      goalId: 'goal_id' in command ? command.goal_id : undefined,
      at: Date.now(),
    });
  }

  /**
   * The state for one goal, allocating a slot if this is the first observation.
   *
   * Called ONLY from {@link observe}: an observation is the engine publishing a
   * goal, which is the one thing that earns a slot.
   */
  private ensure(sessionId: string, goalId: string): { state: GoalState; evictedGoalId: string | null } {
    const key = keyOf(sessionId, goalId);
    const existing = this.goals.get(key);
    if (existing) {
      // Move to the back: Map iterates in insertion order, so re-inserting is
      // what turns "oldest" into "least recently observed" and keeps a goal that
      // is still publishing out of the eviction seat.
      this.goals.delete(key);
      this.goals.set(key, existing);
      return { state: existing, evictedGoalId: null };
    }

    let evictedGoalId: string | null = null;
    if (this.goals.size >= MAX_TRACKED_GOALS) {
      const stalest = this.goals.keys().next().value;
      if (stalest !== undefined) {
        evictedGoalId = this.goals.get(stalest)?.goalId ?? null;
        this.goals.delete(stalest);
      }
    }
    const state: GoalState = {
      goalId,
      cursor: null,
      identity: null,
      goalVersion: DEFAULT_GOAL_VERSION,
      lifecycleState: null,
      objective: null,
      needsResync: false,
      record: null,
    };
    this.goals.set(key, state);
    return { state, evictedGoalId };
  }

  private adopt(
    state: GoalState,
    cursor: TrackableCursor,
    identity: string,
    update: GoalObservationUpdate,
    verdict: GoalCursorVerdict,
    skipped: number,
    detail: string
  ): GoalCursorDecision {
    state.cursor = cursor;
    state.identity = identity;
    state.needsResync = false;
    // Absent fields are LEFT ALONE rather than nulled. A `goal_transition`
    // carries no `goal` record at all, so overwriting the objective with
    // `undefined` on every transition would blank a field the engine never
    // retracted.
    if (update.record) {
      state.record = update.record;
      if (update.record.objective !== undefined) state.objective = update.record.objective;
    }
    if (update.lifecycleState !== undefined) state.lifecycleState = update.lifecycleState;
    // `evictedGoalId` is filled in by observe(), the only caller that knows
    // whether this observation cost another goal its slot.
    return { verdict, adopted: true, cursor, skipped, needsResync: false, evictedGoalId: null, detail };
  }

  private decide(
    state: GoalState,
    verdict: GoalCursorVerdict,
    setNeedsResync: boolean,
    skipped: number,
    detail: string
  ): GoalCursorDecision {
    if (setNeedsResync) state.needsResync = true;
    return {
      verdict,
      adopted: false,
      cursor: state.cursor,
      skipped,
      needsResync: state.needsResync,
      evictedGoalId: null,
      detail,
    };
  }
}

// ============================================
// Command construction
// ============================================

/**
 * Built or refused, with the reason a human can act on.
 *
 * Refusing is a first-class outcome rather than a throw: the caller is a UI
 * press, and "the goal was not advanced because X" has to reach the person who
 * pressed it, not an unhandled rejection in the main process.
 */
export type BuildOutcome<T> = { ok: true; command: T } | { ok: false; reason: string };

/**
 * Mint a request_id for one goal command.
 *
 * Fresh per press. The engine routes `goal_control_refused` back by this id, so
 * reusing one would make two refusals indistinguishable. Shape:
 * `goal-<verb>-<base36 ms>-<8 hex>` - ASCII, comfortably inside
 * {@link GOAL_ID_PATTERN} and far under the 128 characters the engine polices
 * on its other correlation ids.
 */
export function mintGoalRequestId(verb: string): string {
  return `goal-${verb}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function idFault(field: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return `${field} must be a string, got ${describeType(value)}`;
  if (!GOAL_ID_PATTERN.test(value)) return `${field} "${value}" is not a usable correlation id`;
  return undefined;
}

/** True for any ASCII control character, including DEL. No regex, so no lint dance. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * What this host refuses to send as an `idempotency_key`, and nothing more.
 *
 * NOT {@link GOAL_ID_PATTERN}, which was borrowed here and should not have
 * been. That pattern is the engine's rule for a correlation id the HOST mints;
 * this field is supplied by the caller, is never correlated on, and the schema
 * declares it a bare `type: string`. Enforcing the charset refused
 * `sha256:abc/def+ghi=` and `idem publish` - both of which the contract permits
 * and both of which are ordinary shapes for an idempotency key.
 *
 * Three things are still refused, each for a reason the contract leaves to the
 * host: a non-string cannot be serialised as one; an empty or whitespace-only
 * key is a UI bug reaching the engine as a key that identifies nothing; and a
 * control character would break every log line and readout the key appears in.
 * Length is bounded by {@link MAX_IDEMPOTENCY_KEY_TEXT}.
 */
function idempotencyKeyFault(value: unknown): string | undefined {
  if (typeof value !== 'string') return `idempotency_key must be a string, got ${describeType(value)}`;
  if (value.trim().length === 0) return 'idempotency_key must not be empty or whitespace-only';
  if (hasControlCharacter(value)) return 'idempotency_key must not contain control characters';
  if (value.length > MAX_IDEMPOTENCY_KEY_TEXT) {
    return `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_TEXT} characters, got ${value.length}`;
  }
  return undefined;
}

/**
 * The gate every builder passes through first.
 *
 * A goal command sent to a build that graded `durable_goals_v1` as anything but
 * `available` waits for a reply that never comes: `ready.contract.capabilities`
 * is the only declared gate for this capability, and
 * `compat/events/ready.minimal.json` ships a `ready` with NO `contract` block at
 * all - an older engine that must be left alone rather than spoken to.
 * `isCapabilityAvailable` accepts only `available`, so `shape_only`,
 * `publication_bound` and a missing grade all close it.
 */
function gateFault(contract: NegotiatedContract): string | undefined {
  if (!isCapabilityAvailable(contract, DURABLE_GOALS_CAPABILITY)) {
    return `the engine did not grade ${DURABLE_GOALS_CAPABILITY} as available`;
  }
  return undefined;
}

export type GoalOpenInput = {
  sessionId: string;
  goalId: string;
  objective: string;
  iterations: number;
  strategy: string;
  maxTokens: number;
  /** Only for a caller that knows better than {@link DEFAULT_GOAL_VERSION}. */
  goalVersion?: number;
};

export type GoalDeclareTaskInput = {
  sessionId: string;
  goalId: string;
  taskId: string;
  dependsOn?: string[];
  idempotencyKey?: string;
};

export type GoalControlInput = {
  sessionId: string;
  goalId: string;
};

export type GoalResyncInput = {
  sessionId: string;
  /** Omitted deliberately means "the whole session"; the schema does not require it. */
  goalId?: string;
};

/**
 * Build `goal_open`.
 *
 * Assembled field-by-field from named inputs; caller objects are never spread.
 * The schema sets `additionalProperties: true` on every goal command branch, so
 * unlike `continue_with_budget` a stray key would be ACCEPTED by validation and
 * arrive at the engine as a field it never declared. The schema cannot catch
 * that here - only this constructor can.
 *
 * `strategy` is passed through unchecked against a value set on purpose: it is
 * a free string in the schema and `"fleet"` is the only value shown anywhere.
 * Refusing everything else would hard-code a guess about the engine's strategy
 * catalogue into the host; the engine has its own refusal channel for a
 * strategy it does not know.
 */
export function buildGoalOpen(contract: NegotiatedContract, input: GoalOpenInput): BuildOutcome<GoalOpenCommand> {
  const gate = gateFault(contract);
  if (gate) return { ok: false, reason: gate };

  for (const [field, value] of [
    ['session_id', input.sessionId],
    ['goal_id', input.goalId],
  ] as const) {
    const fault = idFault(field, value);
    if (fault) return { ok: false, reason: fault };
  }
  if (typeof input.objective !== 'string' || input.objective.trim().length === 0) {
    return { ok: false, reason: 'objective must be a non-empty string' };
  }
  // `iterations` is the ceiling on how many times the engine may loop on this
  // goal. Zero or negative is not a smaller job, it is a job the engine cannot
  // run; a non-integer is a type error the engine would report far from here.
  if (!Number.isInteger(input.iterations) || input.iterations < 1) {
    return { ok: false, reason: `iterations must be an integer >= 1, got ${String(input.iterations)}` };
  }
  if (typeof input.strategy !== 'string' || input.strategy.length === 0) {
    return { ok: false, reason: 'strategy must be a non-empty string' };
  }
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
    return { ok: false, reason: `max_tokens must be an integer >= 1, got ${String(input.maxTokens)}` };
  }

  return {
    ok: true,
    command: {
      type: 'goal_open',
      goal_version: input.goalVersion ?? DEFAULT_GOAL_VERSION,
      request_id: mintGoalRequestId('open'),
      session_id: input.sessionId,
      goal_id: input.goalId,
      objective: input.objective,
      iterations: input.iterations,
      strategy: input.strategy,
      max_tokens: input.maxTokens,
    },
  };
}

/**
 * Build `goal_declare_task`.
 *
 * `depends_on` and `idempotency_key` are omitted when absent rather than sent
 * empty: neither is in the schema's required list, and an empty `depends_on`
 * array is a positive statement ("this task depends on nothing") that a caller
 * who simply did not supply one never made.
 */
export function buildGoalDeclareTask(
  registry: GoalCursorRegistry,
  contract: NegotiatedContract,
  input: GoalDeclareTaskInput
): BuildOutcome<GoalDeclareTaskCommand> {
  const gate = gateFault(contract);
  if (gate) return { ok: false, reason: gate };

  for (const [field, value] of [
    ['session_id', input.sessionId],
    ['goal_id', input.goalId],
    ['task_id', input.taskId],
  ] as const) {
    const fault = idFault(field, value);
    if (fault) return { ok: false, reason: fault };
  }

  const command: GoalDeclareTaskCommand = {
    type: 'goal_declare_task',
    goal_version: registry.goalVersionFor(input.sessionId, input.goalId) ?? DEFAULT_GOAL_VERSION,
    request_id: mintGoalRequestId('task'),
    session_id: input.sessionId,
    goal_id: input.goalId,
    task_id: input.taskId,
  };

  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn) || input.dependsOn.some((d) => typeof d !== 'string')) {
      return { ok: false, reason: 'depends_on must be an array of strings' };
    }
    command.depends_on = [...input.dependsOn];
  }
  if (input.idempotencyKey !== undefined) {
    const fault = idempotencyKeyFault(input.idempotencyKey);
    if (fault) return { ok: false, reason: fault };
    command.idempotency_key = input.idempotencyKey;
  }

  return { ok: true, command };
}

function buildControl(
  registry: GoalCursorRegistry,
  contract: NegotiatedContract,
  input: GoalControlInput,
  type: 'goal_advance' | 'goal_cancel',
  verb: string
): BuildOutcome<GoalAdvanceCommand | GoalCancelCommand> {
  const gate = gateFault(contract);
  if (gate) return { ok: false, reason: gate };

  for (const [field, value] of [
    ['session_id', input.sessionId],
    ['goal_id', input.goalId],
  ] as const) {
    const fault = idFault(field, value);
    if (fault) return { ok: false, reason: fault };
  }

  if (registry.needsResync(input.sessionId, input.goalId)) {
    return {
      ok: false,
      reason: `goal "${input.goalId}" needs a goal_resync before it can be controlled again`,
    };
  }

  const cursor = registry.cursorFor(input.sessionId, input.goalId);
  if (cursor === null) {
    // The schema REQUIRES `cursor` on both control commands and a host cannot
    // mint one - it is a position in the engine's journal. Refusing is the only
    // honest answer; the alternative, an invented or empty cursor, is a command
    // the engine answers with `cursor_stale` at best.
    return {
      ok: false,
      reason: `no cursor has been published for goal "${input.goalId}"; send goal_resync first`,
    };
  }

  return {
    ok: true,
    command: {
      type,
      goal_version: registry.goalVersionFor(input.sessionId, input.goalId) ?? DEFAULT_GOAL_VERSION,
      request_id: mintGoalRequestId(verb),
      session_id: input.sessionId,
      goal_id: input.goalId,
      // A fresh object: handing out the stored cursor would let a caller mutate
      // the registry's idea of where the goal is.
      cursor: { journal_digest: cursor.journal_digest, journal_sequence: cursor.journal_sequence },
    } as GoalAdvanceCommand | GoalCancelCommand,
  };
}

/** Build `goal_advance`, echoing the cursor the engine last published. */
export function buildGoalAdvance(
  registry: GoalCursorRegistry,
  contract: NegotiatedContract,
  input: GoalControlInput
): BuildOutcome<GoalAdvanceCommand> {
  return buildControl(registry, contract, input, 'goal_advance', 'advance') as BuildOutcome<GoalAdvanceCommand>;
}

/** Build `goal_cancel`, echoing the cursor the engine last published. */
export function buildGoalCancel(
  registry: GoalCursorRegistry,
  contract: NegotiatedContract,
  input: GoalControlInput
): BuildOutcome<GoalCancelCommand> {
  return buildControl(registry, contract, input, 'goal_cancel', 'cancel') as BuildOutcome<GoalCancelCommand>;
}

/**
 * Build `goal_resync` - the one control command that does NOT need a cursor,
 * and therefore the only way out of a contradicted one.
 *
 * `goal_id` is omitted when the caller supplies none, because it is the only
 * goal command whose schema does not require it. The example payload sends one;
 * the required list does not. Following the required list rather than the
 * example is what lets a host ask for the whole session at once, and inventing
 * a goal id to fill the field would be a guess with a side effect.
 */
export function buildGoalResync(
  registry: GoalCursorRegistry,
  contract: NegotiatedContract,
  input: GoalResyncInput
): BuildOutcome<GoalResyncCommand> {
  const gate = gateFault(contract);
  if (gate) return { ok: false, reason: gate };

  const sessionFault = idFault('session_id', input.sessionId);
  if (sessionFault) return { ok: false, reason: sessionFault };

  const command: GoalResyncCommand = {
    type: 'goal_resync',
    // Session-wide resync has no goal to echo a version from, so it falls back
    // to the default; a goal-scoped one echoes what the engine last published.
    goal_version: DEFAULT_GOAL_VERSION,
    request_id: mintGoalRequestId('resync'),
    session_id: input.sessionId,
  };

  if (input.goalId !== undefined) {
    const fault = idFault('goal_id', input.goalId);
    if (fault) return { ok: false, reason: fault };
    command.goal_id = input.goalId;
    command.goal_version = registry.goalVersionFor(input.sessionId, input.goalId) ?? DEFAULT_GOAL_VERSION;
  }

  return { ok: true, command };
}

// ============================================
// Sending
// ============================================

/**
 * Answers "would a command written right now actually leave this process?".
 *
 * A REQUIRED ARGUMENT, NOT AN OPTION WITH A DEFAULT - for the same reason
 * `budgetGrants` requires it. `CapabilityContext.sendCommand` returns `void`
 * and `WCoreAgent.sendCommand` drops the write in silence when the engine's
 * stdin is gone, so a capability holding only the context cannot tell a
 * delivered command from a discarded one. Here that matters because a
 * discarded `goal_advance` looks exactly like a goal that stopped moving.
 */
export type EngineReachable = () => boolean;

export type SendGoalOutcome = { ok: true; requestId: string } | { ok: false; reason: string };

/**
 * Send one goal command and remember its request_id.
 *
 * Takes the {@link BuildOutcome} rather than a bare command so the contract
 * gate in the builders cannot be stepped around: there is no other way to
 * obtain the argument.
 *
 * ORDER MATTERS. Probe, send, then remember. Every failure path leaves the
 * registry exactly as it found it, so `ok: false` means nothing was sent and
 * the user may press again.
 */
export function sendGoalCommand(
  ctx: CapabilityContext,
  registry: GoalCursorRegistry,
  built: BuildOutcome<WCoreGoalCommand>,
  canReachEngine: EngineReachable
): SendGoalOutcome {
  // `=== false` rather than `!built.ok`: this repo compiles without
  // strictNullChecks, where only an explicit comparison narrows a discriminated
  // union - `!built.ok` leaves `built.reason` a type error.
  if (built.ok === false) {
    ctx.warn(`refusing to send a goal command: ${built.reason}`);
    return { ok: false, reason: built.reason };
  }

  const command = built.command;
  if (!canReachEngine()) {
    const reason = 'the engine cannot be reached, so the goal command was not sent';
    ctx.warn(`refusing to send ${command.type} "${command.request_id}": ${reason}`);
    return { ok: false, reason };
  }

  try {
    ctx.sendCommand(command);
  } catch (cause) {
    // The probe said yes and the write still failed - a stream that died in
    // between throws rather than returning. Report it as not sent: an unsent
    // command is one the user can repeat.
    const reason = `the goal command was not sent: ${String(cause)}`;
    ctx.warn(`${command.type} "${command.request_id}" failed to reach the engine: ${String(cause)}`);
    return { ok: false, reason };
  }

  registry.remember(command);
  ctx.log(`sent ${command.type} "${command.request_id}"`);
  return { ok: true, requestId: command.request_id };
}

// ============================================
// The capability
// ============================================

/** One task as the renderer sees it. */
export type GoalTaskSummary = {
  taskId?: string;
  status?: string;
  attempts?: number;
  dependsOn?: string[];
  outcomeState?: string;
};

/** The frame emitted for `goal_snapshot`. */
export type GoalSnapshotFrame = {
  sessionId: string;
  goalId: string;
  goalVersion: number;
  verdict: GoalCursorVerdict;
  adopted: boolean;
  needsResync: boolean;
  detail: string;
  cursor: TrackableCursor | null;
  stateDigest: string;
  objective?: string;
  lifecycleState?: string;
  iterationCeiling?: number;
  iterationsStarted?: number;
  loopOwnerEpoch?: number;
  loopOwnerLeaseExpiresUnixMs?: number;
  /**
   * How many tasks the ENGINE listed, which is not how many `tasks` carries:
   * that array stops at {@link MAX_TASKS_PER_GOAL}. When the two differ,
   * `tasksTruncated` is true and this is the larger, true number.
   *
   * OPTIONAL, and the distinction is the point: `goal.tasks` has no `required`
   * entry, so a snapshot that omits it - or a `goal` that is unreadable - is the
   * engine reporting no list, which is not a list of length zero. Absent means
   * unknown; `0` is a measurement the engine actually published.
   */
  taskCount?: number;
  tasksTruncated: boolean;
  /** Some task listed more dependencies than {@link MAX_DEPENDS_ON_PER_TASK}. */
  dependsOnTruncated: boolean;
  /** Some engine string was longer than its cap and is shown cut to it. */
  textClamped: boolean;
  tasks: GoalTaskSummary[];
};

/** The frame emitted for `goal_transition`. */
export type GoalTransitionFrame = {
  /** Some engine string was longer than its cap and is shown cut to it. */
  textClamped: boolean;
  sessionId: string;
  goalId: string;
  goalVersion: number;
  verdict: GoalCursorVerdict;
  adopted: boolean;
  needsResync: boolean;
  detail: string;
  cursor: TrackableCursor | null;
  transition: string;
  lifecycleState?: string;
};

/** The frame emitted for `goal_control_refused` - the safety-class one. */
export type GoalControlRefusedFrame = {
  sessionId: string;
  goalId: string;
  goalVersion: number;
  requestId: string;
  /** The engine's reason, cut to {@link MAX_GOAL_TEXT} if it was longer. */
  reason: string;
  /** The command this refusal answers, when the host still remembers sending it. */
  refusedCommand?: WCoreGoalCommand['type'];
  /**
   * True when a command with this `request_id` was sent, but for a different
   * goal or session than the refusal names.
   *
   * Never set together with `refusedCommand`: the two are contradictory claims
   * about what that id means, and reporting a mismatch AS the answer is the
   * defect this field exists to make visible instead.
   */
  correlationMismatch: boolean;
  /**
   * True when the host held state for this goal and has locked it.
   *
   * False means the refusal named a goal this host tracks no cursor for, so
   * there was nothing to invalidate - control commands for it already refuse
   * with "no cursor has been published". It is NOT a claim that the goal is
   * controllable.
   */
  needsResync: boolean;
  detail: string;
};

export type DurableGoalsCapability = CapabilityHandler & {
  /** The reducer this handler feeds. Exposed so callers can build commands. */
  readonly goals: GoalCursorRegistry;
  /** Forget every goal. For a new engine process. */
  reset(): void;
};

function toTaskSummaries(tasks: GoalTaskEntry[] | undefined): GoalTaskSummary[] {
  if (!tasks) return [];
  return tasks.map((task) => {
    const summary: GoalTaskSummary = {
      taskId: task.task_id,
      status: task.status,
      attempts: task.attempts,
    };
    if (task.depends_on) summary.dependsOn = task.depends_on;
    if (task.outcome?.state !== undefined) summary.outcomeState = task.outcome.state;
    return summary;
  });
}

/**
 * The fields every goal event shares, or the reason the event is unreadable.
 *
 * Returning a reason rather than throwing keeps the failure visible: the
 * dispatcher swallows a throwing handler and reports the event as unhandled, so
 * a decode bug would look exactly like an event nobody claims.
 */
function parseEnvelope(
  event: Record<string, unknown>
): { sessionId: string; goalId: string; goalVersion: number } | { error: string } {
  const sessionId = event.session_id;
  const goalId = event.goal_id;
  const goalVersion = event.goal_version;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { error: `session_id is not a non-empty string (${describeType(sessionId)})` };
  }
  if (typeof goalId !== 'string' || goalId.length === 0) {
    return { error: `goal_id is not a non-empty string (${describeType(goalId)})` };
  }
  // `goal_version` is `type: integer` and REQUIRED on all three event branches.
  // Its MEANING is undeclared (see DEFAULT_GOAL_VERSION), which is a reason to
  // echo it rather than to police its value - so only integer-ness is checked.
  if (typeof goalVersion !== 'number' || !Number.isInteger(goalVersion)) {
    return { error: `goal_version is not an integer (${describeType(goalVersion)})` };
  }
  return { sessionId, goalId, goalVersion };
}

/**
 * Warn, then decline.
 *
 * Declining lets the event reach the decoder's acknowledged-unhandled check,
 * which is the honest destination for a payload this host could not read -
 * returning `true` would report it as handled. The warn is what stops the
 * decline being silent: the three goal types are no longer listed inert, so a
 * declined event now falls through to the unhandled path with nothing else to
 * explain it.
 */
function declineMalformed(ctx: CapabilityContext, type: string, reason: string): boolean {
  ctx.warn(`${type} could not be decoded and was not handled: ${reason}`);
  return false;
}

/**
 * Build a capability bound to its own registry.
 *
 * A factory rather than a bare object because the registry is per-engine state:
 * one shared instance across two engine processes would let one session's
 * cursors answer for the other's. {@link durableGoalsCapability} is the
 * instance meant for the registry in `capabilities/index.ts`.
 */
export function createDurableGoalsCapability(): DurableGoalsCapability {
  const goals = new GoalCursorRegistry();

  return {
    name: DURABLE_GOALS_CAPABILITY,
    handles: [...GOAL_EVENT_TYPES],
    goals,

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      const type = event.type;
      if (typeof type !== 'string') return false;

      const envelope = parseEnvelope(event);
      if ('error' in envelope) return declineMalformed(ctx, type, envelope.error);
      const { sessionId, goalId, goalVersion } = envelope;

      if (type === 'goal_control_refused') {
        const requestId = event.request_id;
        const reason = event.reason;
        if (typeof requestId !== 'string' || requestId.length === 0) {
          return declineMalformed(ctx, type, 'request_id is not a non-empty string');
        }
        if (typeof reason !== 'string' || reason.length === 0) {
          return declineMalformed(ctx, type, 'reason is not a non-empty string');
        }

        // The engine controls this string and it is about to be copied three
        // times - a log line, a warning and a frame. Cut once, before the first.
        const clamped = clampText(reason, MAX_GOAL_TEXT);
        const shown = clamped.clamped ? `${clamped.text} (reason clamped from ${reason.length} characters)` : reason;

        const outcome = goals.refuse(sessionId, goalId, goalVersion, requestId);
        let detail: string;
        if (outcome.matched) {
          detail = `the engine refused ${outcome.matched.commandType} "${requestId}": ${shown}`;
        } else if (outcome.mismatched) {
          // Both claims are on the record. Naming one of them as the answer
          // would report a command this goal never sent as refused.
          const sent = outcome.mismatched;
          detail =
            `the engine refused "${requestId}" for goal "${goalId}", but this host sent that request_id as ` +
            `${sent.commandType} for ${sent.goalId === undefined ? 'the whole session' : `goal "${sent.goalId}"`} ` +
            `in session "${sent.sessionId}": ${shown}`;
          if (outcome.lockedSender) {
            detail += `; goal "${sent.goalId}" is locked too, since a refusal came back for a command carrying its cursor`;
          }
        } else {
          detail = `the engine refused an unremembered goal command "${requestId}": ${shown}`;
        }
        if (!outcome.locked) {
          detail += ` (this host tracks no cursor for goal "${goalId}", so there was nothing to lock)`;
        }
        // Safety-class in the manifest. This is the event whose silence would
        // leave a user staring at a goal that quietly stopped responding.
        ctx.warn(detail, { goalId, requestId, reason: clamped.text });

        const frame: GoalControlRefusedFrame = {
          sessionId,
          goalId,
          goalVersion,
          requestId,
          reason: clamped.text,
          correlationMismatch: outcome.mismatched !== undefined,
          needsResync: outcome.locked,
          detail,
        };
        if (outcome.matched) frame.refusedCommand = outcome.matched.commandType;
        ctx.emit({ type: 'goal_control_refused', data: frame, msg_id: '' });
        return true;
      }

      if (type === 'goal_transition') {
        const transition = event.transition;
        if (typeof transition !== 'string' || transition.length === 0) {
          return declineMalformed(ctx, type, 'transition is not a non-empty string');
        }
        // `transition` is RETAINED as this goal's identity and `lifecycle.state`
        // is retained as its state, so both fall under the same cap as the
        // record fields - the transition arm decodes them by hand rather than
        // through parseGoalRecord, which is how they escaped it.
        const notes = newParseNotes();
        const identity = clampedString(transition, MAX_GOAL_TEXT, notes) ?? transition;
        const lifecycleState = isRecord(event.lifecycle)
          ? clampedString(event.lifecycle.state, MAX_GOAL_ID_TEXT, notes)
          : undefined;

        const decision = goals.observe(sessionId, goalId, goalVersion, event.cursor, identity, { lifecycleState });
        const frame: GoalTransitionFrame = {
          sessionId,
          goalId,
          goalVersion,
          verdict: decision.verdict,
          adopted: decision.adopted,
          needsResync: decision.needsResync,
          detail: decision.detail,
          cursor: decision.cursor,
          transition: identity,
          lifecycleState,
          textClamped: notes.textClamped,
        };
        if (notes.textClamped) {
          ctx.warn(`goal "${goalId}" reported a field longer than this host retains; the text shown is clamped`);
        }
        announce(ctx, decision, 'goal_transition', frame, goalId);
        return true;
      }

      if (type === 'goal_snapshot') {
        const stateDigest = event.state_digest;
        if (typeof stateDigest !== 'string' || stateDigest.length === 0) {
          return declineMalformed(ctx, type, 'state_digest is not a non-empty string');
        }
        const parsed = parseGoalRecord(event.goal);
        // `state_digest` is RETAINED as this goal's identity, so it is capped
        // like every other engine string. The cost is stated at MAX_GOAL_TEXT:
        // two digests agreeing on their first 4096 characters would compare
        // equal. Every digest the contract ships is 71.
        const identity = clampedString(stateDigest, MAX_GOAL_TEXT, parsed.notes) ?? stateDigest;
        const decision = goals.observe(sessionId, goalId, goalVersion, event.cursor, identity, {
          record: parsed.record,
          lifecycleState: parsed.record.lifecycle?.state,
        });

        const frame: GoalSnapshotFrame = {
          sessionId,
          goalId,
          goalVersion,
          verdict: decision.verdict,
          adopted: decision.adopted,
          needsResync: decision.needsResync,
          detail: decision.detail,
          cursor: decision.cursor,
          stateDigest: identity,
          objective: parsed.record.objective,
          lifecycleState: parsed.record.lifecycle?.state,
          iterationCeiling: parsed.record.iteration_ceiling,
          iterationsStarted: parsed.record.iterations_started,
          loopOwnerEpoch: parsed.record.loop_owner?.epoch,
          loopOwnerLeaseExpiresUnixMs: parsed.record.loop_owner?.lease_expires_unix_ms,
          taskCount: parsed.reportedTaskCount,
          tasksTruncated: parsed.notes.tasksTruncated,
          dependsOnTruncated: parsed.notes.dependsOnTruncated,
          textClamped: parsed.notes.textClamped,
          tasks: toTaskSummaries(parsed.record.tasks),
        };
        // Each cap says out loud that what follows is a cut-down view. A goal
        // shown short without saying so reads as a goal that IS short.
        if (parsed.notes.tasksTruncated) {
          ctx.warn(`goal "${goalId}" reported more than ${MAX_TASKS_PER_GOAL} tasks; the list shown is truncated`);
        }
        if (parsed.notes.dependsOnTruncated) {
          ctx.warn(
            `goal "${goalId}" reported more than ${MAX_DEPENDS_ON_PER_TASK} dependencies on a task; the list shown is truncated`
          );
        }
        if (parsed.notes.textClamped) {
          ctx.warn(`goal "${goalId}" reported a field longer than this host retains; the text shown is clamped`);
        }
        announce(ctx, decision, 'goal_snapshot', frame, goalId);
        return true;
      }

      // A type in `handles` with no arm above cannot happen today, but saying so
      // out loud beats returning `true` for something nothing read.
      return declineMalformed(ctx, type, 'no decoder arm claims this type');
    },

    reset(): void {
      goals.reset();
    },
  };
}

/**
 * Announce one observation to the task layer.
 *
 * `msg_id` is empty because a goal outlives any turn - it is journalled to
 * survive a whole process restart - so filing it under whatever turn happened
 * to be open would attach a session-wide fact to one message. That REQUIRES
 * this capability to be registered: `WCoreManager` forwards an empty-`msg_id`
 * frame only when its type is in `CAPABILITY_FRAME_TYPES`, which it builds from
 * the capability registry. It is registered - `HANDLERS` in
 * `capabilities/index.ts` lists {@link durableGoalsCapability} - so these frames
 * are forwarded (see item 3 of the wiring status at the top of this file).
 */
function announce(
  ctx: CapabilityContext,
  decision: GoalCursorDecision,
  type: 'goal_snapshot' | 'goal_transition',
  frame: GoalSnapshotFrame | GoalTransitionFrame,
  goalId: string
): void {
  if (decision.evictedGoalId !== null) {
    // The user loses the ability to advance or cancel that goal at this moment.
    // Saying which goal and why beats a control button that quietly stops
    // working with "no cursor has been published".
    ctx.warn(
      `stopped tracking goal "${decision.evictedGoalId}" to make room for "${goalId}" (${MAX_TRACKED_GOALS} goal limit); ` +
        `its cursor is gone and it needs a goal_resync before it can be controlled again`
    );
  }
  if (decision.adopted) ctx.log(`goal "${goalId}" ${decision.detail}`);
  else if (decision.verdict === 'unchanged') ctx.log(`goal "${goalId}" ${decision.detail}`);
  else ctx.warn(`goal "${goalId}" ${decision.verdict}: ${decision.detail}`);
  ctx.emit({ type, data: frame, msg_id: '' });
}

/**
 * The instance the capability registry dispatches to.
 *
 * REGISTERED: `HANDLERS` in `capabilities/index.ts` imports and lists it, so
 * `dispatchCapabilityEvent` routes the three goal events here and the frames
 * below reach the renderer in the running app. One instance only - registering
 * a second would trip `assertNoOverlap`, which refuses two handlers claiming the
 * same event type. See the wiring status at the top of this file.
 */
export const durableGoalsCapability: DurableGoalsCapability = createDurableGoalsCapability();

/** Forget every goal the shared instance holds. For tests and engine restart. */
export function resetGoalState(): void {
  durableGoalsCapability.reset();
}
