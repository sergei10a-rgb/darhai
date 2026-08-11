/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turn recovery: telling the user their turn died, and asking what to do.
 *
 * WHAT IS BROKEN TODAY. `WCoreManager.handleProcessExit` prints "Agent process
 * exited unexpectedly (code N)", emits finish, and that is the whole story. The
 * next open of the conversation spawns a fresh engine that knows nothing about
 * the turn that was in flight. If the dead turn was mid-`Bash` or mid-`Write`,
 * the effect may or may not have landed and Darhai has no way to even ask.
 *
 * HOW THE CONTRACT SAYS TO FIX IT. Recovery is HOST-INITIATED and START-PATH
 * ONLY. The engine never volunteers a snapshot: `session_recovery_snapshot`,
 * `_replay` and `_unavailable` all carry a `request_id`, and the only thing that
 * mints one is the host's own `session_resync`. So the flow is:
 *
 *   spawn -> `ready` -> (gate) -> `session_resync {session_id, after?}`
 *         -> `session_recovery_snapshot` (+ optional `session_recovery_replay`)
 *         -> host asks the user -> `resume_turn {turn_id, cursor, action}`
 *
 * `turn_recovery_lifecycle` is the one UNSOLICITED event (it has no
 * `request_id`). It is the live cursor feed during a normal turn, and its only
 * job is to keep an up-to-date `after` on disk so the NEXT start has something
 * to resync from. Without a durable `after` the whole capability is inert - see
 * {@link TurnRecoveryCapability.setCursorSink}.
 *
 * WHAT THIS FILE IS. The reducer, the decoders, the three command builders, and
 * one {@link CapabilityHandler}. Pure except for what it does through the
 * narrow `CapabilityContext`: no Electron, no child process, no clock beyond
 * `Date.now()` for eviction ages. That is what makes all five adversarial
 * fixtures drivable against the same code production runs.
 *
 * WHAT THIS MODULE REQUIRES OF ITS CALLERS, and where each requirement stands.
 * This file cannot observe any of them at runtime; the status notes below were
 * checked by reading the callers and must be re-checked when they move:
 *
 *  1. DONE. `turnRecoveryCapability` is listed in `HANDLERS` in
 *     `capabilities/index.ts`. Dispatch only reaches a registered handler, and
 *     `forwardableFrameTypes()` - which `WCoreManager` builds its frame
 *     pass-through set from - only contains a registered handler's types.
 *     Unregistered, this module would decide nothing and its frames would reach
 *     no renderer. This module emits only under names it also handles, so it
 *     needs no `emits` declaration; a capability that emits a PROJECTION under
 *     a fresh name must declare it there or the frame is silently dropped.
 *  2. DONE. None of `session_recovery_snapshot`, `session_recovery_replay`,
 *     `session_recovery_unavailable`, `turn_recovery_lifecycle` remains in
 *     `ACKNOWLEDGED_UNHANDLED_EVENTS` in `protocol.ts`, so the host no longer
 *     reports as knowingly-inert four events it now handles.
 *  3. DONE. The decoder's `ready` arm calls {@link
 *     TurnRecoveryCapability.seedFromReady}, through
 *     `WCoreAgent.seedCapabilitiesFromReady`. `ready` has its own arm and never
 *     reaches the dispatcher, so the negotiated contract - which is the GATE on
 *     every command below - has no other way in. Without that call the gate
 *     stayed shut, which is the deliberate fail-closed default, so recovery was
 *     inert rather than wrong.
 *  4. STILL OPEN. `WCoreAgent.start()` does not call {@link
 *     TurnRecoveryCapability.beginResync} after `ready` and before the first
 *     `message`, and installs no durable cursor sink via {@link
 *     TurnRecoveryCapability.setCursorSink}. Without the ask, rule 3 below
 *     refuses every answer the engine sends; without the sink, the journal
 *     position dies with the process.
 *  5. REQUIREMENT ON A SURFACE THAT DOES NOT EXIST YET. The `resume_turn`
 *     cursor a UI press sends must come from the frame that was marked
 *     `actionable` (or from {@link
 *     TurnRecoveryCapability.pendingTurnCursorFor}), NOT from {@link
 *     TurnRecoveryCapability.latestCursor} - the live feed moves that one past
 *     the position the pending turn was reported at.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE, AND WHAT THIS MODULE CHOSE. The five
 * `adversarial/recovery/` fixtures declare INPUT only - no expected verdict
 * exists anywhere in the bundle. Every rule below is derived from the JSON
 * Schema, from `manifest.json` (all four events and all three commands are
 * graded `criticality: "safety"`; the snapshot and replay correlate on
 * `request_id_and_cursor`), or from the shape of the fixture itself. The
 * filename is never the justification. Each judgement call is made in one
 * direction: NEVER adopt a journal position the host cannot verify, keep the
 * last one it could, and say so out loud.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *  - it never sends `resolve_interrupted_approval`. `approval_id` is required by
 *    that command and NO engine event in the whole bundle produces one (the
 *    snapshot carries `pending_call_id`, `approval_required` carries `call_id`
 *    and `resume_token`). The builder exists so one place owns the shape; the
 *    send path is deliberately absent until the id's producer is measured off
 *    the wire. Guessing it sends an approve/deny that binds to nothing, or to
 *    the wrong thing.
 *  - it never offers `resume_turn` with `action: 'continue'`. The contract gives
 *    the enum and not one word of semantics; for a `tool_outcome_unknown` turn
 *    the difference between the three is whether a tool that may already have
 *    written a file gets re-run, assumed successful, or abandoned. The engine's
 *    own example uses `reconcile`, which is the only reason to prefer it.
 *  - it never faults the turn or ends the session. Rejection is loud (a warn
 *    plus a stream frame), not fatal.
 */

import { randomBytes } from 'node:crypto';

import { canRecoverSessions, gradeOf, negotiateContract, NO_CONTRACT } from '../contractNegotiation';
import type { NegotiatedContract } from '../contractNegotiation';
import type { CapabilityContext, CapabilityHandler } from '../types';

/** Contract capability id. `manifest.capabilities.turn_recovery_v1`. */
export const TURN_RECOVERY_CAPABILITY = 'turn_recovery_v1';

/** `manifest.json` -> `subcontracts.turn_recovery === "1.0"`. */
export const TURN_RECOVERY_SUBCONTRACT_VERSION = '1.0';

/**
 * The only `recovery_version` this host speaks.
 *
 * The schema pins it to `const: 1` on all four events and all three commands,
 * and the engine publishes `unsupported_version` as a refusal reason of its
 * own - so both sides treat this number as a hard gate, not a hint.
 */
export const RECOVERY_VERSION = 1;

/**
 * `journal_digest`, verbatim from the schema's cursor subschema.
 *
 * TRANSCRIBED, WITH A GATE. `src/` must not read `tests/fixtures/` at runtime,
 * so this literal is a copy and copies drift. The drift gate is the test
 * "JOURNAL_DIGEST_PATTERN is the schema's cursor pattern verbatim" in
 * `tests/unit/wcore-turnRecovery.test.ts`, which compares this `.source` against
 * every cursor subschema in `core-event.schema.json` and `host-command.schema.json`.
 */
export const JOURNAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The four wire events this capability owns. */
export const RECOVERY_EVENT_TYPES = [
  'session_recovery_snapshot',
  'session_recovery_replay',
  'session_recovery_unavailable',
  'turn_recovery_lifecycle',
] as const;

/**
 * The `type` this capability emits its user-visible frame under.
 *
 * It MUST be one of {@link RECOVERY_EVENT_TYPES}, or else declared in this
 * handler's `emits`. `WCoreManager` forwards a system-level frame (empty
 * `msg_id`) to the renderer only when its type is in its
 * `CAPABILITY_FRAME_TYPES` set, which it builds from `forwardableFrameTypes()`
 * - the union of every registered handler's `handles` and `emits`. A frame
 * emitted under an invented type such as `turn_recovery`, declared in neither,
 * would be dropped by the `if (!data.msg_id) return;` guard below it, in
 * silence, which is the exact failure class this capability exists to close.
 * Staying inside the claimed names is the cheaper half of that rule, so that is
 * what this module does. Of the four claimed names this is the one that
 * describes the state of a turn rather than a request/response, so it is the
 * one a renderer would expect to carry the notice.
 */
export const TURN_RECOVERY_FRAME_TYPE = 'turn_recovery_lifecycle';

/* ------------------------------------------------------------------ *
 * Wire types. Field-for-field from the JSON Schema; see contractPath  *
 * notes in docs/architecture/engine-capabilities/turn_recovery_v1.json *
 * ------------------------------------------------------------------ */

export type WCoreJournalCursor = {
  /** 64 lowercase hex chars (`^[0-9a-f]{64}$`). The cursor's identity. */
  journal_digest: string;
  /** Schema marks this OPTIONAL - only the digest is required. Gap detection needs it. */
  journal_sequence?: number;
};

export type WCoreTurnLifecycle =
  | 'ready'
  | 'streaming'
  | 'awaiting_approval'
  | 'tool_in_flight'
  | 'reconciliation_required'
  | 'suspended'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type WCoreReconcileReason =
  | 'approval_expired'
  | 'provider_outcome_unknown'
  | 'tool_outcome_unknown'
  | 'effect_requires_operator'
  | 'budget_exhausted'
  | 'context_unrestorable'
  | 'cancellation_ambiguous'
  | 'unknown_critical_state';

export type WCoreRecoveryUnavailableReason =
  | 'session_not_found'
  | 'unsupported_version'
  | 'cursor_invalid'
  | 'cursor_ahead'
  | 'cursor_digest_mismatch'
  | 'history_gap'
  | 'journal_corrupt'
  | 'snapshot_unavailable'
  | 'unknown_critical_state';

export type WCoreReplayItemKind =
  | 'state_advanced'
  | 'turn_started'
  | 'stream_started'
  | 'stream_committed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'tool_started'
  | 'tool_committed'
  | 'effect_uncertain'
  | 'cancellation_requested'
  | 'turn_completed'
  | 'turn_cancelled'
  | 'turn_failed';

export type WCoreRecoveryBudget = {
  tokens_used: number;
  cost_used_usd: number;
  token_limit?: number;
  cost_limit_usd?: number;
};

export type WCorePendingTurn = {
  turn_id: string;
  lifecycle: WCoreTurnLifecycle;
  msg_id?: string;
  pending_call_id?: string;
  reconcile_reason?: WCoreReconcileReason;
};

export type WCoreRecoveryReplayItem = {
  cursor: WCoreJournalCursor;
  kind: WCoreReplayItemKind;
  turn_id?: string;
};

/** `session_recovery_snapshot`, as it goes on the wire. */
export type WCoreSessionRecoverySnapshot = {
  type: 'session_recovery_snapshot';
  recovery_version: number;
  request_id: string;
  session_id: string;
  cursor: WCoreJournalCursor;
  /** 64 lowercase hex chars. Bound to `cursor`: two snapshots at one cursor must agree. */
  state_digest: string;
  lifecycle: WCoreTurnLifecycle;
  budget: WCoreRecoveryBudget;
  pending_turn?: WCorePendingTurn;
};

/** `session_recovery_replay`, as it goes on the wire. */
export type WCoreSessionRecoveryReplay = {
  type: 'session_recovery_replay';
  recovery_version: number;
  request_id: string;
  session_id: string;
  /** Cursor after the last item. Adopt this only if every item validated. */
  through: WCoreJournalCursor;
  items: WCoreRecoveryReplayItem[];
  /** Absent for a genesis resync (no `after` was sent). */
  from?: WCoreJournalCursor;
};

/** `session_recovery_unavailable`, as it goes on the wire. */
export type WCoreSessionRecoveryUnavailable = {
  type: 'session_recovery_unavailable';
  recovery_version: number;
  request_id: string;
  session_id: string;
  reason: WCoreRecoveryUnavailableReason;
};

/** `turn_recovery_lifecycle`, as it goes on the wire. NOTE: no `request_id`. */
export type WCoreTurnRecoveryLifecycle = {
  type: 'turn_recovery_lifecycle';
  recovery_version: number;
  session_id: string;
  turn_id: string;
  cursor: WCoreJournalCursor;
  lifecycle: WCoreTurnLifecycle;
  reconcile_reason?: WCoreReconcileReason;
};

export type WCoreRecoveryEvent =
  | WCoreSessionRecoverySnapshot
  | WCoreSessionRecoveryReplay
  | WCoreSessionRecoveryUnavailable
  | WCoreTurnRecoveryLifecycle;

/* ---------------------------- commands ---------------------------- */

/** `session_resync`. `additionalProperties: false` - never spread into this. */
export type SessionResyncCommand = {
  type: 'session_resync';
  recovery_version: number;
  request_id: string;
  session_id: string;
  /** Omit ENTIRELY for a genesis resync; `compat/commands/session_resync.genesis.json` proves that form. */
  after?: WCoreJournalCursor;
};

/** `resume_turn`. `cursor` is the compare-and-swap token. */
export type ResumeTurnCommand = {
  type: 'resume_turn';
  recovery_version: number;
  request_id: string;
  session_id: string;
  turn_id: string;
  cursor: WCoreJournalCursor;
  action: 'continue' | 'reconcile' | 'cancel';
};

/** `resolve_interrupted_approval`. Built here, never sent - see the file header. */
export type ResolveInterruptedApprovalCommand = {
  type: 'resolve_interrupted_approval';
  recovery_version: number;
  request_id: string;
  session_id: string;
  turn_id: string;
  cursor: WCoreJournalCursor;
  approval_id: string;
  decision: 'approve' | 'deny';
  answer?: string;
};

export type TurnRecoveryCommand = SessionResyncCommand | ResumeTurnCommand | ResolveInterruptedApprovalCommand;

/**
 * The only `resume_turn` actions this host will build.
 *
 * `continue` is excluded at the TYPE level, not just refused at runtime, so a
 * caller cannot reach it by accident. See the file header for why.
 */
export type HostResumeAction = 'reconcile' | 'cancel';

/**
 * Built or refused, with a reason a human can act on.
 *
 * Refusing is a first-class outcome rather than a throw: the caller is a UI
 * press, and "the command was not sent because X" has to reach the person who
 * pressed it, not an unhandled rejection in the main process.
 */
export type RecoveryBuildOutcome<T> = { ok: true; command: T } | { ok: false; reason: string };

/* ----------------------------- bounds ----------------------------- */

/**
 * How many replay items one `session_recovery_replay` may carry.
 *
 * A HOST-SIDE CHOICE. The schema puts no `maxItems` on `items` and the manifest
 * states no bound, so the WIRE controls the length of a loop this module runs -
 * exactly the unbounded-loop shape that shipped in wave 1. 4096 items at the
 * fixture's ~180 bytes each is ~700 KB, comfortably inside a frame the stdout
 * decoder already buffers whole, while a session's journal between two host
 * starts realistically runs to tens of entries (the fixtures carry two).
 *
 * At the cap the whole replay is REFUSED, not truncated. Truncating would mean
 * adopting `through` after verifying only part of the chain - precisely the
 * silent journal hole the cursor rules exist to catch.
 */
export const MAX_REPLAY_ITEMS = 4096;

/**
 * How many sessions this module tracks at once.
 *
 * `HANDLERS` in `capabilities/index.ts` is a module-level singleton, so ONE
 * handler instance serves every live `WCoreAgent`. State is therefore keyed by
 * the event's own `session_id` - a wire-controlled string, which makes the map
 * itself wire-controlled and unbounded without this. Darhai runs a handful of
 * conversations at a time; 32 is far past that and is stated as a pick, not read
 * off the contract. At the cap the OLDEST session is evicted, loudly, so the
 * newest conversation keeps working rather than the feature dying for everyone.
 */
export const MAX_TRACKED_SESSIONS = 32;

/**
 * How many turns' lifecycle states one session remembers.
 *
 * `turn_recovery_lifecycle` arrives keyed by `turn_id` - again wire-controlled -
 * and its emission rate is UNKNOWN (it may be one per journal entry, i.e.
 * several per tool call). Only the most recent turns can matter to a recovery
 * decision, so the map is bounded and the oldest entry drops.
 */
export const MAX_TRACKED_TURNS = 256;

/**
 * How many resync `request_id`s one session may have outstanding.
 *
 * The host asks once per start, plus at most one genesis retry, so two is the
 * real number; 8 leaves room for a chunked exchange without letting the ledger
 * grow. See {@link SessionRecoveryTracker} for why the ledger exists at all.
 */
export const MAX_OUTSTANDING_RESYNCS = 8;

/**
 * How deep {@link canonicalJson} descends before refusing to compare.
 *
 * The deepest shape the contract describes is a replay: event -> `items` ->
 * item -> `cursor` -> scalar, four levels. Both the snapshot and the replay item
 * are `additionalProperties: true`, so an engine may hang unmodelled structure
 * below that and NOTHING in the bundle bounds how deep. 8 is a CHOICE - double
 * what the contract describes.
 *
 * At the cap the message is refused as malformed, not compared down to the cap.
 * A truncated comparison would grade two snapshots that differ only below the
 * cap as an identical redelivery, which is the silent duplicate this
 * canonicaliser exists to prevent.
 */
export const MAX_CANONICAL_DEPTH = 8;

/**
 * The longest `session_id`, `request_id`, `turn_id`, `msg_id` or
 * `pending_call_id` this host will accept off the wire.
 *
 * A HOST-SIDE CHOICE; no schema here declares a `maxLength`. The engine controls
 * these strings and this host does long-lived things with them: `session_id`
 * becomes a `Map` key held until eviction, `request_id` enters the ask ledger,
 * and all of them are interpolated into warnings and into the frame the renderer
 * shows. An unbounded string in any of those places is the same class of problem
 * as an unbounded loop, just paid in bytes instead of iterations. 512 is far
 * past anything the contract ships (`session-desktop-001` is 19 characters, this
 * host's own minted `request_id` is 26) so no real id is ever near it. At the
 * bound the message is REFUSED as malformed rather than truncated: a truncated
 * id would silently alias a different session or a different ask.
 */
export const MAX_WIRE_ID_LENGTH = 512;

/**
 * How much of one engine-controlled value a `detail` line may quote.
 *
 * Same reasoning as {@link MAX_WIRE_ID_LENGTH} and the same absence of a schema
 * bound, but this applies to values that are NOT ids and so cannot be refused on
 * length alone - an unknown `lifecycle`, an undeclared cursor key, a whole
 * rejected value rendered by `JSON.stringify`. 120 characters is a CHOICE: the
 * longest legitimate value in this surface is a 64-character digest, so a real
 * value is never cut. Past the bound the text is truncated and the true length
 * is appended, because a detail line exists to identify what was wrong, not to
 * reproduce it.
 */
export const MAX_DETAIL_VALUE_LENGTH = 120;

/**
 * How many evicted-but-refused sessions this module remembers.
 *
 * The `unusable` latch lives on a tracker, and trackers are evicted under a
 * wire-controlled `session_id` ({@link MAX_TRACKED_SESSIONS}) - so without a
 * tombstone an engine could erase its own refusal by naming 32 new sessions and
 * then repeating the conflicting snapshot. Only the id is kept, so 256 of them
 * is a few kilobytes at {@link MAX_WIRE_ID_LENGTH} each in the worst case. It is
 * a CHOICE, not a contract number. At the bound the OLDEST refusal is forgotten,
 * loudly - that session can then be reopened, which is the honest cost of not
 * letting the set grow without limit.
 */
export const MAX_REFUSED_SESSIONS = 256;

/* ---------------------------- verdicts ---------------------------- */

/**
 * What the host decided about one recovery message.
 *
 * `applied` and `ignored_duplicate` are the only non-rejecting values. Every
 * other one means the message was NOT adopted and the host's journal position is
 * whatever it was before.
 */
export type RecoveryVerdict =
  /** Adopted: the cursor moved (or was seeded) and the state below it is trusted. */
  | 'applied'
  /** An exact redelivery of something already applied. No state change, benign. */
  | 'ignored_duplicate'
  /** `recovery_version` was not 1, on a field the schema pins to `const: 1`. */
  | 'rejected_version'
  /** Structurally unreadable: missing required field, wrong type, unknown enum, bad digest. */
  | 'rejected_malformed'
  /** A `request_id` this host never minted - the engine does not volunteer these. */
  | 'rejected_unsolicited'
  /** A replay whose `from` does not stitch onto the cursor actually held. */
  | 'rejected_digest_mismatch'
  /** Replay items skip, repeat, or do not end where `through` claims. */
  | 'rejected_cursor_gap'
  /** Two snapshots at one cursor disagree. Recovery for the session is now refused. */
  | 'rejected_state_conflict'
  /** Something earlier made this session's recovery untrustworthy. */
  | 'rejected_session_unusable'
  /** The engine answered `session_recovery_unavailable`. Not a host-side rejection. */
  | 'unavailable';

/** The outcome of feeding one message to {@link SessionRecoveryTracker.accept}. */
export type RecoveryDecision = {
  verdict: RecoveryVerdict;
  /** True only when the tracker's state moved. */
  applied: boolean;
  /** The journal position the host holds AFTER this decision. */
  cursor: WCoreJournalCursor | null;
  /** The turn the user must be asked about, or null. */
  pendingTurn: WCorePendingTurn | null;
  /**
   * The cursor the engine named ALONGSIDE {@link pendingTurn}, or null.
   *
   * Kept separate from {@link cursor} because the two drift: the live
   * `turn_recovery_lifecycle` feed and an accepted replay both move `cursor`
   * forward while `pendingTurn` still describes the turn a snapshot reported at
   * an OLDER position. `resume_turn`'s cursor is a compare-and-swap token
   * correlated `request_id_and_cursor`, so handing it a position that belongs to
   * a different turn than the `turn_id` beside it is exactly the mistake the
   * compare-and-swap exists to prevent. This is the only cursor the engine ever
   * stated in the same breath as the pending turn.
   */
  pendingTurnCursor: WCoreJournalCursor | null;
  /** The lifecycle the host now believes the session/turn is in. */
  lifecycle: WCoreTurnLifecycle | null;
  budget: WCoreRecoveryBudget | null;
  /** Set only by `session_recovery_unavailable`. */
  unavailableReason: WCoreRecoveryUnavailableReason | null;
  /** True once recovery for this session can no longer be trusted. */
  unusable: boolean;
  /** The reducer asks the host to re-ask from genesis. Guarded to fire once. */
  retryGenesis: boolean;
  /**
   * False when a replay's order could NOT be checked because `journal_sequence`
   * was absent. The schema makes that field optional and there is no
   * previous-digest field to chain on, so gap detection silently degrades - the
   * host must be able to say so rather than report a verified chain it did not
   * verify.
   */
  sequencesVerified: boolean;
  /** Why, in one line. Goes into the warning and the stream frame. */
  detail: string;
};

/** The frame this capability forwards to the task layer. */
export type TurnRecoveryFrame = {
  capability: typeof TURN_RECOVERY_CAPABILITY;
  sessionId: string;
  verdict: RecoveryVerdict;
  severity: 'info' | 'warning';
  detail: string;
  cursor: WCoreJournalCursor | null;
  lifecycle: WCoreTurnLifecycle | null;
  pendingTurn: WCorePendingTurn | null;
  budget: WCoreRecoveryBudget | null;
  unavailableReason: WCoreRecoveryUnavailableReason | null;
  /**
   * True when the host may offer the user reconcile/cancel for `pendingTurn`,
   * using THIS frame's `cursor` as the compare-and-swap token.
   *
   * The rule is a pairing check, not a list of event names: the frame must have
   * been ADOPTED (`verdict === 'applied'`), must carry a pending turn, and its
   * `cursor` must be the same position the engine reported that pending turn at.
   * Only a snapshot ever states both together, so only a snapshot can satisfy
   * it - which is what makes this FALSE for the live `turn_recovery_lifecycle`
   * feed and for a replay. The live feed advances the cursor past the snapshot's
   * position while the pending turn stays where it was; offering reconcile there
   * would ask the user about a turn the engine is still running AND hand
   * `resume_turn` a journal position belonging to a different turn. Nothing in
   * the contract says `resume_turn` is legal mid-turn either.
   *
   * A `session` that was refused cannot reach this: rule 2 turns every message
   * on an unusable session into a rejection, so `verdict === 'applied'` already
   * carries "usable" with it.
   */
  actionable: boolean;
};

/* ---------------------------- decoding ---------------------------- */

const LIFECYCLES: ReadonlySet<string> = new Set<WCoreTurnLifecycle>([
  'ready',
  'streaming',
  'awaiting_approval',
  'tool_in_flight',
  'reconciliation_required',
  'suspended',
  'completed',
  'cancelled',
  'failed',
]);

const RECONCILE_REASONS: ReadonlySet<string> = new Set<WCoreReconcileReason>([
  'approval_expired',
  'provider_outcome_unknown',
  'tool_outcome_unknown',
  'effect_requires_operator',
  'budget_exhausted',
  'context_unrestorable',
  'cancellation_ambiguous',
  'unknown_critical_state',
]);

const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set<WCoreRecoveryUnavailableReason>([
  'session_not_found',
  'unsupported_version',
  'cursor_invalid',
  'cursor_ahead',
  'cursor_digest_mismatch',
  'history_gap',
  'journal_corrupt',
  'snapshot_unavailable',
  'unknown_critical_state',
]);

const REPLAY_ITEM_KINDS: ReadonlySet<string> = new Set<WCoreReplayItemKind>([
  'state_advanced',
  'turn_started',
  'stream_started',
  'stream_committed',
  'approval_requested',
  'approval_resolved',
  'tool_started',
  'tool_committed',
  'effect_uncertain',
  'cancellation_requested',
  'turn_completed',
  'turn_cancelled',
  'turn_failed',
]);

/**
 * The unavailable reasons that INDICT the `after` this host sent.
 *
 * All four describe a cursor the engine could not place, and that one fact
 * drives BOTH consequences:
 *
 *  - a genesis retry can repair it, because asking again with no `after` at all
 *    removes the only thing that was wrong, and the genesis form is a published,
 *    compat-proven shape (`compat/commands/session_resync.genesis.json`);
 *  - the held cursor must be dropped, because keeping it would send the same bad
 *    `after` at every future start.
 *
 * The other five reasons get NEITHER. `session_not_found` and `journal_corrupt`
 * describe the journal itself, `unsupported_version` would fail identically the
 * second time, and `snapshot_unavailable` / `unknown_critical_state` say nothing
 * a host could act on. Retrying any of them costs a round trip and changes
 * nothing - and DROPPING the cursor on them would destroy the only durable
 * journal position this capability exists to maintain, over an answer that never
 * said the position was wrong. A transient `snapshot_unavailable` must not cost
 * the host its place in the journal.
 */
const CURSOR_INDICTED: ReadonlySet<string> = new Set<WCoreRecoveryUnavailableReason>([
  'cursor_invalid',
  'cursor_ahead',
  'cursor_digest_mismatch',
  'history_gap',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A non-empty identifier this host is willing to hold on to.
 *
 * Length matters here and not in {@link isNonEmptyString} because these values
 * outlive the message: see {@link MAX_WIRE_ID_LENGTH} for the bound and why it
 * refuses rather than truncates.
 */
function isWireId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WIRE_ID_LENGTH;
}

/** {@link isWireId} without the non-empty requirement, for optional id fields. */
function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_WIRE_ID_LENGTH;
}

/**
 * Quote one engine-controlled value for a `detail` line, bounded.
 *
 * See {@link MAX_DETAIL_VALUE_LENGTH}. `JSON.stringify` returns `undefined` for
 * `undefined` and for a function, so the fallback keeps the result a string.
 */
function quoteWire(value: unknown): string {
  const encoded = JSON.stringify(value) ?? String(value);
  if (encoded.length <= MAX_DETAIL_VALUE_LENGTH) return encoded;
  return `${encoded.slice(0, MAX_DETAIL_VALUE_LENGTH)}...(${encoded.length} chars)`;
}

type Parsed<T> = { value: T } | { error: string };

/**
 * Decode a cursor, or say why it cannot be one.
 *
 * UNKNOWN KEYS ARE REFUSED, unlike almost everywhere else in this file. The
 * cursor subschema is the only one here with `additionalProperties: false`, and
 * this object is the compare-and-swap token the host writes to disk and hands
 * back to the engine on the next start. A key this host does not model may be
 * part of the cursor's identity; adopting a position we only half understand is
 * how a `cursor_invalid` loop starts.
 */
function parseCursor(raw: unknown, where: string): Parsed<WCoreJournalCursor> {
  if (!isRecord(raw)) return { error: `${where} is not an object (got ${describeType(raw)})` };

  const digest = raw.journal_digest;
  if (typeof digest !== 'string' || !JOURNAL_DIGEST_PATTERN.test(digest)) {
    return { error: `${where}.journal_digest is not 64 lowercase hex chars` };
  }

  const unknown = Object.keys(raw).filter((key) => key !== 'journal_digest' && key !== 'journal_sequence');
  if (unknown.length > 0) {
    // The key NAMES are engine-controlled and there can be any number of them,
    // so the list is quoted through the bounded helper rather than joined raw.
    return { error: `${where} carries unknown field(s): ${quoteWire(unknown.toSorted().join(', '))}` };
  }

  const cursor: WCoreJournalCursor = { journal_digest: digest };
  const sequence = raw.journal_sequence;
  if (sequence !== undefined) {
    if (!Number.isInteger(sequence)) return { error: `${where}.journal_sequence is not an integer` };
    cursor.journal_sequence = sequence as number;
  }
  return { value: cursor };
}

/**
 * `budget` is `additionalProperties: true`, so unknown keys are tolerated: this
 * object is displayed, never acted on, and refusing a snapshot because the
 * engine added a spend field would throw away the interrupted turn with it.
 */
function parseBudget(raw: unknown): Parsed<WCoreRecoveryBudget> {
  if (!isRecord(raw)) return { error: `budget is not an object (got ${describeType(raw)})` };
  if (!Number.isInteger(raw.tokens_used)) return { error: 'budget.tokens_used is not an integer' };
  if (typeof raw.cost_used_usd !== 'number' || !Number.isFinite(raw.cost_used_usd)) {
    return { error: 'budget.cost_used_usd is not a finite number' };
  }

  const budget: WCoreRecoveryBudget = {
    tokens_used: raw.tokens_used as number,
    cost_used_usd: raw.cost_used_usd,
  };
  if (raw.token_limit !== undefined) {
    if (!Number.isInteger(raw.token_limit)) return { error: 'budget.token_limit is not an integer' };
    budget.token_limit = raw.token_limit as number;
  }
  if (raw.cost_limit_usd !== undefined) {
    if (typeof raw.cost_limit_usd !== 'number' || !Number.isFinite(raw.cost_limit_usd)) {
      return { error: 'budget.cost_limit_usd is not a finite number' };
    }
    budget.cost_limit_usd = raw.cost_limit_usd;
  }
  return { value: budget };
}

/**
 * Decode `pending_turn`.
 *
 * An unknown `lifecycle` or `reconcile_reason` is REFUSED rather than carried
 * through as a string. Both drive what the user is told and which action is
 * offered; a value outside the declared set cannot be mapped to either, and
 * widening the type so it could be stored would push the guess into every
 * consumer instead of catching it here. The cost - a future engine adding an
 * enum member stalls recovery until this host learns it - is loud, keeps the
 * last verified position, and is the safe direction for a `criticality: safety`
 * event.
 */
function parsePendingTurn(raw: unknown): Parsed<WCorePendingTurn> {
  if (!isRecord(raw)) return { error: `pending_turn is not an object (got ${describeType(raw)})` };
  if (!isWireId(raw.turn_id)) {
    return { error: `pending_turn.turn_id is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters` };
  }
  if (typeof raw.lifecycle !== 'string' || !LIFECYCLES.has(raw.lifecycle)) {
    return { error: `pending_turn.lifecycle is not a declared lifecycle (${quoteWire(raw.lifecycle)})` };
  }

  const turn: WCorePendingTurn = { turn_id: raw.turn_id, lifecycle: raw.lifecycle as WCoreTurnLifecycle };
  // `msg_id` and `pending_call_id` are optional, so an engine that sent a NUMBER
  // for either would otherwise reach the renderer as one - and both are ids a
  // host correlates on. EMPTY is still allowed (the schema sets no `minLength`
  // and this host has never seen an engine omit them by sending ""); only the
  // type and the length bound are enforced.
  if (raw.msg_id !== undefined) {
    if (!isBoundedString(raw.msg_id)) {
      return { error: `pending_turn.msg_id is not a string of at most ${MAX_WIRE_ID_LENGTH} characters` };
    }
    turn.msg_id = raw.msg_id;
  }
  if (raw.pending_call_id !== undefined) {
    if (!isBoundedString(raw.pending_call_id)) {
      return { error: `pending_turn.pending_call_id is not a string of at most ${MAX_WIRE_ID_LENGTH} characters` };
    }
    turn.pending_call_id = raw.pending_call_id;
  }
  if (raw.reconcile_reason !== undefined) {
    if (typeof raw.reconcile_reason !== 'string' || !RECONCILE_REASONS.has(raw.reconcile_reason)) {
      return { error: `pending_turn.reconcile_reason is not declared (${quoteWire(raw.reconcile_reason)})` };
    }
    turn.reconcile_reason = raw.reconcile_reason as WCoreReconcileReason;
  }
  return { value: turn };
}

/**
 * Serialise with object keys sorted, or `null` past {@link MAX_CANONICAL_DEPTH}.
 *
 * Runs on the RAW wire object, not on the decoded form. Both the snapshot and
 * the replay item are `additionalProperties: true`, so the decoded form is
 * LOSSY: two snapshots at one cursor that disagree only in a field this host
 * does not model would reduce to the same object and be graded an identical
 * redelivery - the one verdict that emits nothing and warns nothing. Comparing
 * raw bodies means a difference this host cannot interpret is still one it can
 * REPORT. Key order is normalised because JSON key order is not semantic and
 * treating a re-serialised replay as a conflict would refuse a position we hold.
 */
function canonicalJson(value: unknown, depth: number): string | null {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? null;
  if (depth >= MAX_CANONICAL_DEPTH) return null;

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      const encoded = canonicalJson(item, depth + 1);
      if (encoded === null) return null;
      items.push(encoded);
    }
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    const encoded = canonicalJson(record[key], depth + 1);
    if (encoded === null) return null;
    fields.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${fields.join(',')}}`;
}

function sameCursor(a: WCoreJournalCursor | null, b: WCoreJournalCursor | null): boolean {
  if (!a || !b) return false;
  if (a.journal_digest !== b.journal_digest) return false;
  // Sequences are compared only when BOTH sides carry one; the schema makes the
  // field optional, so an absent sequence is not a difference.
  if (a.journal_sequence === undefined || b.journal_sequence === undefined) return true;
  return a.journal_sequence === b.journal_sequence;
}

function describeCursor(cursor: WCoreJournalCursor | null): string {
  if (!cursor) return 'none';
  const short = cursor.journal_digest.slice(0, 8);
  return cursor.journal_sequence === undefined ? short : `${short}@${cursor.journal_sequence}`;
}

/* --------------------------- the reducer -------------------------- */

type TurnRecord = {
  lifecycle: WCoreTurnLifecycle;
  reconcileReason?: WCoreReconcileReason;
  cursor: WCoreJournalCursor;
};

/**
 * One session's recovery state and every rule that changes it.
 *
 * Pure and dependency-free: no engine, no window, no socket - the precedent set
 * by `src/process/task/wcoreApprovalGate.ts`, and what makes the five
 * adversarial fixtures drivable against production code rather than a stand-in.
 *
 * RULES, in the order applied. None is quoted from the contract; each names the
 * evidence it rests on:
 *
 *  1. `recovery_version !== 1`               -> `rejected_version`
 *  2. session already unusable               -> `rejected_session_unusable`
 *  3. a `request_id` never minted here       -> `rejected_unsolicited`
 *  4. unreadable body / bad digest / bad enum-> `rejected_malformed`
 *  5. snapshot at the held cursor, identical -> `ignored_duplicate`
 *  6. snapshot at the held cursor, different -> `rejected_state_conflict` (+ unusable)
 *  7. replay whose `from` != held cursor     -> `rejected_digest_mismatch`
 *  8. replay items that skip/repeat/mis-end  -> `rejected_cursor_gap`
 *  9. otherwise                              -> `applied`, cursor := new position
 *
 * Rule 1 rests on the schema pinning `recovery_version` to `const: 1` on every
 * recovery verb, and on the engine publishing `unsupported_version` as its own
 * refusal reason. A version bump may redefine what a cursor or a state digest
 * MEANS, and both are things this host writes to disk and hands back.
 *
 * Rule 3 rests on the plainest fact of the design: the engine never volunteers a
 * snapshot, so a `request_id` nobody here minted is either a reply to a dead
 * process or something else entirely. It has NO precondition - an empty ledger
 * refuses everything, which is what a host that has not asked should do. The
 * only way in is {@link noteResyncRequest}, and the only caller of that is
 * {@link TurnRecoveryCapability.beginResync}, which is gated on the contract.
 * So an engine this host will not talk to is also an engine this host will not
 * listen to.
 *
 * Rules 5-6 rest on `manifest.json` correlating both the snapshot and the replay
 * on `request_id_and_cursor`: the cursor is the snapshot's IDENTITY, so two
 * bodies at one cursor is a contradiction, not a later update. Keeping the first
 * digest and refusing the rest is the conservative half; the alternative
 * (last-write-wins) would let one frame silently move the host onto a state it
 * cannot verify, which is the whole failure this event exists to remove.
 *
 * Rule 7 compares DIGESTS, never sequence numbers. That is what
 * `adversarial/recovery/cursor-digest-mismatch.jsonl` is built to catch: its
 * `from` carries the SAME `journal_sequence` (40) and a DIFFERENT digest, so a
 * host that chained on sequence would accept a replay from a journal it has
 * never seen.
 *
 * ON REJECTION the last verified cursor is KEPT and nothing is written to disk.
 * The cost is real: after a state conflict this session can never recover again,
 * because nothing later says which of the two snapshots was true.
 * {@link reset} exists for the one case where starting over is provably fine - a
 * new engine process.
 */
export class SessionRecoveryTracker {
  private cursor: WCoreJournalCursor | null = null;
  private stateDigest: string | null = null;
  private lifecycle: WCoreTurnLifecycle | null = null;
  private budget: WCoreRecoveryBudget | null = null;
  private pendingTurn: WCorePendingTurn | null = null;
  /** The cursor {@link pendingTurn} was reported at. See `RecoveryDecision`. */
  private pendingTurnCursor: WCoreJournalCursor | null = null;
  /** Canonical raw body of the applied snapshot, for the redelivery check. */
  private snapshotCanonical: string | null = null;
  private unusable = false;
  private genesisRetryUsed = false;
  private readonly outstanding = new Set<string>();
  private readonly turns = new Map<string, TurnRecord>();

  constructor(readonly sessionId: string) {}

  get currentCursor(): WCoreJournalCursor | null {
    return this.cursor;
  }

  get currentPendingTurn(): WCorePendingTurn | null {
    return this.pendingTurn;
  }

  /**
   * The cursor {@link currentPendingTurn} was reported at - the compare-and-swap
   * token a `resume_turn` for that turn must carry. NOT {@link currentCursor},
   * which the live feed moves on.
   */
  get currentPendingTurnCursor(): WCoreJournalCursor | null {
    return this.pendingTurnCursor;
  }

  get currentLifecycle(): WCoreTurnLifecycle | null {
    return this.lifecycle;
  }

  get isUnusable(): boolean {
    return this.unusable;
  }

  /** Lifecycle records from the live feed, newest last. */
  get trackedTurns(): ReadonlyMap<string, TurnRecord> {
    return this.turns;
  }

  /**
   * request_ids this host minted and has not retired.
   *
   * Only `session_recovery_unavailable` retires one - see
   * {@link acceptUnavailable}. A snapshot's id survives being answered because
   * ONE ask may be answered by a snapshot AND a replay under the same id, so
   * retiring on first use would refuse the second half of a legal exchange.
   */
  get outstandingRequests(): readonly string[] {
    return [...this.outstanding];
  }

  /**
   * Record that the host asked. Called by {@link TurnRecoveryCapability.beginResync}.
   *
   * Bounded at {@link MAX_OUTSTANDING_RESYNCS}: ids are minted here, never
   * received, so the set can only grow by a deliberate host action - but a host
   * bug that asked in a loop must not leak, and the oldest id is the one least
   * likely to still be answered. The cost of that eviction is stated where the
   * bound is: a genuine late answer to an evicted ask is graded unsolicited.
   */
  noteResyncRequest(requestId: string): void {
    if (this.outstanding.size >= MAX_OUTSTANDING_RESYNCS) {
      const oldest = this.outstanding.values().next().value as string | undefined;
      if (oldest !== undefined) this.outstanding.delete(oldest);
    }
    this.outstanding.add(requestId);
  }

  /**
   * Forget everything. For a NEW engine process only.
   *
   * A fresh engine restarts from its own journal head, which rules 5-8 would
   * otherwise refuse against state belonging to the dead one - and an `unusable`
   * latch would keep recovery off for the life of the app.
   */
  reset(): void {
    this.cursor = null;
    this.stateDigest = null;
    this.lifecycle = null;
    this.budget = null;
    this.pendingTurn = null;
    this.pendingTurnCursor = null;
    this.snapshotCanonical = null;
    this.unusable = false;
    this.genesisRetryUsed = false;
    this.outstanding.clear();
    this.turns.clear();
  }

  /**
   * Re-latch a session whose refusal outlived its tracker.
   *
   * {@link createTurnRecoveryCapability} evicts trackers keyed by a
   * WIRE-CONTROLLED `session_id`, so without this an engine could erase its own
   * `rejected_state_conflict` latch by naming {@link MAX_TRACKED_SESSIONS} fresh
   * sessions and then repeating the conflicting snapshot. Host-called only: the
   * wire can reach {@link accept} and nothing else.
   */
  markRefused(): void {
    this.unusable = true;
  }

  /**
   * Feed one recovery message.
   *
   * Takes the RAW wire object rather than a typed event so the shapes this must
   * refuse - `recovery_version: 2`, a truncated digest, an unknown lifecycle -
   * are representable without a cast, in production and in tests alike.
   */
  accept(raw: unknown): RecoveryDecision {
    if (!isRecord(raw)) return this.reject('rejected_malformed', `event is not an object (${describeType(raw)})`);

    const type = raw.type;
    if (typeof type !== 'string' || !(RECOVERY_EVENT_TYPES as readonly string[]).includes(type)) {
      return this.reject('rejected_malformed', `not a recovery event: ${quoteWire(type)}`);
    }

    // Rule 1 first, and before ANY other field is read: on a version this host
    // does not speak, the meaning of every field below is exactly what is in
    // question.
    if (raw.recovery_version !== RECOVERY_VERSION) {
      return this.reject(
        'rejected_version',
        `recovery_version ${quoteWire(raw.recovery_version)} is not ${RECOVERY_VERSION}`
      );
    }

    if (!isWireId(raw.session_id)) {
      return this.reject(
        'rejected_malformed',
        `session_id is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters`
      );
    }

    if (this.unusable) {
      return this.reject(
        'rejected_session_unusable',
        `recovery for session ${quoteWire(this.sessionId)} was refused earlier and cannot be trusted again in this process`
      );
    }

    if (type === 'turn_recovery_lifecycle') return this.acceptLifecycle(raw);

    // The other three are ANSWERS, so they must answer something we asked.
    if (!isWireId(raw.request_id)) {
      return this.reject(
        'rejected_malformed',
        `request_id is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters`
      );
    }
    // Rule 3, with NO precondition. An earlier version only checked the ledger
    // once this process had successfully asked, which armed the guard exactly
    // where it was least needed and disarmed it exactly where it was needed
    // most: when the contract gate refuses to let this host ask at all (a
    // `shape_only` build, a non-durable engine, or a `ready` that was never
    // seeded) NOTHING was ever minted, so every volunteered snapshot was adopted
    // - cursor written to disk and all - from precisely the builds this host
    // decided it could not talk to. The engine never volunteers these three, so
    // an empty ledger means every answer is unsolicited, and that is the
    // fail-closed reading rather than a reason to stop checking.
    if (!this.outstanding.has(raw.request_id)) {
      return this.reject(
        'rejected_unsolicited',
        `request_id ${quoteWire(raw.request_id)} was never minted here; the engine does not volunteer recovery snapshots`
      );
    }

    if (type === 'session_recovery_snapshot') return this.acceptSnapshot(raw);
    if (type === 'session_recovery_replay') return this.acceptReplay(raw);
    return this.acceptUnavailable(raw);
  }

  private acceptSnapshot(raw: Record<string, unknown>): RecoveryDecision {
    const cursor = parseCursor(raw.cursor, 'cursor');
    if ('error' in cursor) return this.reject('rejected_malformed', cursor.error);

    const digest = raw.state_digest;
    if (typeof digest !== 'string' || !JOURNAL_DIGEST_PATTERN.test(digest)) {
      return this.reject('rejected_malformed', 'state_digest is not 64 lowercase hex chars');
    }

    if (typeof raw.lifecycle !== 'string' || !LIFECYCLES.has(raw.lifecycle)) {
      return this.reject('rejected_malformed', `lifecycle is not declared (${quoteWire(raw.lifecycle)})`);
    }

    const budget = parseBudget(raw.budget);
    if ('error' in budget) return this.reject('rejected_malformed', budget.error);

    let pending: WCorePendingTurn | null = null;
    if (raw.pending_turn !== undefined) {
      const parsed = parsePendingTurn(raw.pending_turn);
      if ('error' in parsed) return this.reject('rejected_malformed', parsed.error);
      pending = parsed.value;
    }

    const canonical = canonicalJson(raw, 0);
    if (canonical === null) {
      return this.reject(
        'rejected_malformed',
        `snapshot nests deeper than ${MAX_CANONICAL_DEPTH} levels and cannot be compared for identity`
      );
    }

    // Rules 5 and 6: the cursor is the snapshot's identity per the manifest's
    // `request_id_and_cursor` correlation.
    if (this.cursor && this.cursor.journal_digest === cursor.value.journal_digest) {
      if (canonical === this.snapshotCanonical) {
        return this.duplicate(`snapshot at ${describeCursor(this.cursor)} redelivered unchanged`);
      }
      const where =
        digest === this.stateDigest
          ? 'a different body outside state_digest'
          : `state_digest ${digest.slice(0, 8)} against the held ${String(this.stateDigest).slice(0, 8)}`;
      this.unusable = true;
      return this.reject(
        'rejected_state_conflict',
        `two snapshots at cursor ${describeCursor(this.cursor)} disagree: ${where}. The held snapshot is kept and recovery for this session is refused from here on`
      );
    }

    this.cursor = cursor.value;
    this.stateDigest = digest;
    this.lifecycle = raw.lifecycle as WCoreTurnLifecycle;
    this.budget = budget.value;
    this.pendingTurn = pending;
    // The snapshot is the only message that states a pending turn and a cursor
    // together, so this is the only place the pair can be recorded.
    this.pendingTurnCursor = pending ? cursor.value : null;
    this.snapshotCanonical = canonical;

    const suffix = pending
      ? `; turn ${pending.turn_id} was interrupted (${pending.lifecycle}${pending.reconcile_reason ? `/${pending.reconcile_reason}` : ''})`
      : '';
    return this.applied(`snapshot adopted at ${describeCursor(this.cursor)}${suffix}`);
  }

  private acceptReplay(raw: Record<string, unknown>): RecoveryDecision {
    const through = parseCursor(raw.through, 'through');
    if ('error' in through) return this.reject('rejected_malformed', through.error);

    let from: WCoreJournalCursor | null = null;
    if (raw.from !== undefined) {
      const parsed = parseCursor(raw.from, 'from');
      if ('error' in parsed) return this.reject('rejected_malformed', parsed.error);
      from = parsed.value;
    }

    if (!Array.isArray(raw.items)) {
      return this.reject('rejected_malformed', `items is not an array (got ${describeType(raw.items)})`);
    }
    if (raw.items.length > MAX_REPLAY_ITEMS) {
      // Refuse rather than truncate: adopting `through` after checking only part
      // of the chain is exactly the hole the chain check exists to find.
      return this.reject(
        'rejected_malformed',
        `replay carries ${raw.items.length} items, above the ${MAX_REPLAY_ITEMS} this host will verify`
      );
    }

    // Rule 7. `from` is the stitch point and it is compared by DIGEST.
    if (from) {
      if (!this.cursor) {
        // The contract never says a replay may arrive before a snapshot. With no
        // held position there is nothing to stitch onto, and adopting `through`
        // would mean trusting a chain whose start we never saw. Fail closed.
        return this.reject(
          'rejected_digest_mismatch',
          `replay stitches onto ${describeCursor(from)} but this host holds no cursor for the session`
        );
      }
      if (from.journal_digest !== this.cursor.journal_digest) {
        return this.reject(
          'rejected_digest_mismatch',
          `replay.from ${describeCursor(from)} does not match the held cursor ${describeCursor(this.cursor)}`
        );
      }
    } else if (this.cursor) {
      // A genesis replay (no `from`) after a cursor is already held. The
      // contract does not say whether that is legal, so adopting `through` would
      // move the position with no verified link to the one we hold. Fail closed.
      return this.reject(
        'rejected_digest_mismatch',
        `replay carries no "from" while this host holds ${describeCursor(this.cursor)}, so there is nothing to stitch onto`
      );
    }

    let previous: WCoreJournalCursor | null = from ?? this.cursor;
    let sequencesVerified = true;

    for (const [index, rawItem] of (raw.items as unknown[]).entries()) {
      if (!isRecord(rawItem)) {
        return this.reject('rejected_malformed', `items[${index}] is not an object`);
      }
      if (typeof rawItem.kind !== 'string' || !REPLAY_ITEM_KINDS.has(rawItem.kind)) {
        // An unknown kind cannot be told to the user - `effect_uncertain` is the
        // one that raises the "did this tool run?" question at all - so it is
        // refused rather than shown as something this host understands.
        return this.reject('rejected_malformed', `items[${index}].kind is not declared (${quoteWire(rawItem.kind)})`);
      }
      const itemCursor = parseCursor(rawItem.cursor, `items[${index}].cursor`);
      if ('error' in itemCursor) return this.reject('rejected_malformed', itemCursor.error);

      if (previous) {
        const prevSeq = previous.journal_sequence;
        const nextSeq = itemCursor.value.journal_sequence;
        if (prevSeq !== undefined && nextSeq !== undefined) {
          if (nextSeq !== prevSeq + 1) {
            return this.reject(
              'rejected_cursor_gap',
              `items[${index}] jumps from sequence ${prevSeq} to ${nextSeq}; journal entries in between were never seen`
            );
          }
        } else {
          // No sequence on one side: the schema makes the field optional and
          // there is no previous-digest field to chain on, so ORDER cannot be
          // verified. A repeated digest is still provably not forward motion,
          // which is the one check that survives.
          sequencesVerified = false;
          if (itemCursor.value.journal_digest === previous.journal_digest) {
            return this.reject('rejected_cursor_gap', `items[${index}] repeats the previous cursor without advancing`);
          }
        }
      }
      previous = itemCursor.value;
    }

    // `through` is the position the engine claims the replay ends at. Adopting
    // it without checking the last item would make every chain check above
    // decorative: `cursor-gap.jsonl` ends at a `through` that is perfectly
    // consistent with its last item and still skipped entry 41.
    if (!sameCursor(previous, through.value)) {
      const what = raw.items.length === 0 ? 'an empty replay' : 'the last item';
      return this.reject(
        'rejected_cursor_gap',
        `${what} ends at ${describeCursor(previous)} but "through" claims ${describeCursor(through.value)}`
      );
    }

    if (raw.items.length === 0) {
      return this.duplicate(`empty replay at ${describeCursor(through.value)} moved nothing`);
    }

    this.cursor = through.value;
    return this.applied(
      `replay of ${raw.items.length} item(s) adopted; cursor now ${describeCursor(this.cursor)}`,
      sequencesVerified
    );
  }

  private acceptUnavailable(raw: Record<string, unknown>): RecoveryDecision {
    if (typeof raw.reason !== 'string' || !UNAVAILABLE_REASONS.has(raw.reason)) {
      return this.reject('rejected_malformed', `reason is not declared (${quoteWire(raw.reason)})`);
    }
    const reason = raw.reason as WCoreRecoveryUnavailableReason;

    // This answer ENDS the exchange, so the id it quotes is retired: a snapshot
    // or replay arriving later under the same id is then unsolicited, which
    // matters most for the genesis retry - the retry mints a new id, and without
    // this a stale duplicate under the refused one would still be graded on
    // content alone. Rule 3 already proved this id is in the set.
    if (typeof raw.request_id === 'string') this.outstanding.delete(raw.request_id);

    // ONLY the four reasons that indict the `after` this host sent drop the held
    // position - see {@link CURSOR_INDICTED}. On the other five the engine said
    // nothing about our cursor, and throwing away the one durable journal
    // position this capability exists to maintain over a transient
    // `snapshot_unavailable` is not recoverable from the reason itself. Note
    // that `snapshotCanonical` and `stateDigest` are cleared with the cursor and
    // never separately: keeping a cursor whose snapshot identity was forgotten
    // would grade the next redelivery at that cursor a state CONFLICT and latch
    // the session unusable.
    const indicted = CURSOR_INDICTED.has(reason);
    if (indicted) {
      this.cursor = null;
      this.stateDigest = null;
      this.snapshotCanonical = null;
      this.pendingTurn = null;
      this.pendingTurnCursor = null;
    }

    const retry = indicted && !this.genesisRetryUsed;
    if (retry) this.genesisRetryUsed = true;

    const kept = indicted
      ? ''
      : `; the held cursor ${describeCursor(this.cursor)} is kept - that reason does not indict it`;
    return {
      verdict: 'unavailable',
      applied: false,
      cursor: this.cursor,
      pendingTurn: this.pendingTurn,
      pendingTurnCursor: this.pendingTurnCursor,
      lifecycle: this.lifecycle,
      budget: this.budget,
      unavailableReason: reason,
      unusable: this.unusable,
      retryGenesis: retry,
      sequencesVerified: true,
      detail: retry
        ? `engine refused the resync (${reason}); asking once more from genesis`
        : `engine refused the resync (${reason}); no retry can repair that${kept}`,
    };
  }

  private acceptLifecycle(raw: Record<string, unknown>): RecoveryDecision {
    if (!isWireId(raw.turn_id)) {
      return this.reject(
        'rejected_malformed',
        `turn_id is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters`
      );
    }
    if (typeof raw.lifecycle !== 'string' || !LIFECYCLES.has(raw.lifecycle)) {
      return this.reject('rejected_malformed', `lifecycle is not declared (${quoteWire(raw.lifecycle)})`);
    }
    const cursor = parseCursor(raw.cursor, 'cursor');
    if ('error' in cursor) return this.reject('rejected_malformed', cursor.error);

    let reconcileReason: WCoreReconcileReason | undefined;
    if (raw.reconcile_reason !== undefined) {
      if (typeof raw.reconcile_reason !== 'string' || !RECONCILE_REASONS.has(raw.reconcile_reason)) {
        return this.reject(
          'rejected_malformed',
          `reconcile_reason is not declared (${quoteWire(raw.reconcile_reason)})`
        );
      }
      reconcileReason = raw.reconcile_reason as WCoreReconcileReason;
    }

    const record: TurnRecord = { lifecycle: raw.lifecycle as WCoreTurnLifecycle, cursor: cursor.value };
    if (reconcileReason !== undefined) record.reconcileReason = reconcileReason;

    // Bounded: `turn_id` is wire-controlled and the emission rate of this event
    // is unmeasured (it may be one per journal entry). Deleting before setting
    // refreshes insertion order, so the oldest key genuinely is the oldest turn.
    this.turns.delete(raw.turn_id);
    if (this.turns.size >= MAX_TRACKED_TURNS) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
    this.turns.set(raw.turn_id, record);
    this.lifecycle = record.lifecycle;

    const advanced = this.advanceLiveCursor(cursor.value);
    const detail = `turn ${raw.turn_id} is ${record.lifecycle}${reconcileReason ? ` (${reconcileReason})` : ''} at ${describeCursor(cursor.value)}${advanced ? '' : '; cursor not advanced'}`;

    return {
      verdict: advanced ? 'applied' : 'ignored_duplicate',
      applied: advanced,
      cursor: this.cursor,
      // The pending turn a SNAPSHOT found is still pending, so it is reported -
      // but it is NOT re-paired with this live cursor. `pendingTurnCursor` still
      // names the position the engine reported it at, which is what stops
      // `toFrame` marking this frame actionable.
      pendingTurn: this.pendingTurn,
      pendingTurnCursor: this.pendingTurnCursor,
      lifecycle: record.lifecycle,
      budget: this.budget,
      unavailableReason: null,
      unusable: false,
      retryGenesis: false,
      sequencesVerified: true,
      detail,
    };
  }

  /**
   * Move the live cursor forward, or refuse to.
   *
   * `turn_recovery_lifecycle` is the live feed and its whole job is to leave a
   * good `after` on disk. Two cases are handled differently on purpose:
   *
   *  - both cursors carry a `journal_sequence`: only a strictly greater sequence
   *    advances. A lower one is a regression and an equal one with a different
   *    digest is a contradiction; adopting either would write an `after` that
   *    the next start cannot place.
   *  - a sequence is missing: frames arrive over ONE ordered stdout pipe, so a
   *    later frame is a later journal position and there is nothing else to
   *    order on. Refusing to advance here would pin `after` at the first cursor
   *    for ever, which is the silence this capability exists to end.
   */
  private advanceLiveCursor(next: WCoreJournalCursor): boolean {
    if (!this.cursor) {
      this.cursor = next;
      return true;
    }
    if (sameCursor(this.cursor, next)) return false;

    const held = this.cursor.journal_sequence;
    const incoming = next.journal_sequence;
    if (held !== undefined && incoming !== undefined && incoming <= held) return false;

    this.cursor = next;
    return true;
  }

  private applied(detail: string, sequencesVerified = true): RecoveryDecision {
    return {
      verdict: 'applied',
      applied: true,
      cursor: this.cursor,
      pendingTurn: this.pendingTurn,
      pendingTurnCursor: this.pendingTurnCursor,
      lifecycle: this.lifecycle,
      budget: this.budget,
      unavailableReason: null,
      unusable: false,
      retryGenesis: false,
      sequencesVerified,
      detail,
    };
  }

  private duplicate(detail: string): RecoveryDecision {
    return {
      verdict: 'ignored_duplicate',
      applied: false,
      cursor: this.cursor,
      pendingTurn: this.pendingTurn,
      pendingTurnCursor: this.pendingTurnCursor,
      lifecycle: this.lifecycle,
      budget: this.budget,
      unavailableReason: null,
      unusable: this.unusable,
      retryGenesis: false,
      sequencesVerified: true,
      detail,
    };
  }

  private reject(verdict: RecoveryVerdict, detail: string): RecoveryDecision {
    return {
      verdict,
      applied: false,
      cursor: this.cursor,
      pendingTurn: this.pendingTurn,
      pendingTurnCursor: this.pendingTurnCursor,
      lifecycle: this.lifecycle,
      budget: this.budget,
      unavailableReason: null,
      unusable: this.unusable,
      retryGenesis: false,
      sequencesVerified: true,
      detail,
    };
  }
}

/* -------------------------- command builders ---------------------- */

/**
 * Mint a `request_id` for one recovery exchange.
 *
 * Fresh per ask, never derived from the session. The contract never states id
 * lifetime, but it correlates every recovery answer on `request_id`, so a
 * derived-and-therefore-stable id would make a second ask indistinguishable from
 * the first. Shape: `recovery-<base36 ms>-<8 hex>` = 26 ASCII chars.
 */
export function mintRecoveryRequestId(): string {
  return `recovery-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Build `session_resync`, or refuse and say why.
 *
 * The only sanctioned constructor, because `host-command.schema.json` sets
 * `additionalProperties: false` on this command: one stray key invalidates the
 * whole message. So it is assembled field-by-field from named inputs and caller
 * objects are NEVER spread. `after` is omitted ENTIRELY when absent rather than
 * set to undefined - `compat/commands/session_resync.genesis.json` is the
 * published proof that the no-`after` form is legal, and `after: undefined`
 * survives `JSON.stringify` as an absent key only by luck of implementation.
 */
export function buildSessionResync(input: {
  sessionId: string;
  requestId: string;
  after?: WCoreJournalCursor;
}): RecoveryBuildOutcome<SessionResyncCommand> {
  if (!isNonEmptyString(input.sessionId)) return { ok: false, reason: 'session_id must be a non-empty string' };
  if (!isNonEmptyString(input.requestId)) return { ok: false, reason: 'request_id must be a non-empty string' };

  const command: SessionResyncCommand = {
    type: 'session_resync',
    recovery_version: RECOVERY_VERSION,
    request_id: input.requestId,
    session_id: input.sessionId,
  };

  if (input.after !== undefined) {
    const cursor = parseCursor(input.after, 'after');
    if ('error' in cursor) return { ok: false, reason: cursor.error };
    command.after = cursor.value;
  }
  return { ok: true, command };
}

/**
 * Build `resume_turn`, or refuse and say why.
 *
 * `action` is typed {@link HostResumeAction} and checked again at runtime,
 * because the value arrives from a renderer press over IPC where JSON has
 * erased the declared type. `continue` is refused rather than passed through:
 * the contract gives the enum and no semantics, and for a
 * `tool_outcome_unknown` turn `continue` is the one action that might re-run or
 * silently skip a side effect whose status is unknown.
 */
export function buildResumeTurn(input: {
  sessionId: string;
  turnId: string;
  cursor: WCoreJournalCursor;
  action: HostResumeAction;
  requestId?: string;
}): RecoveryBuildOutcome<ResumeTurnCommand> {
  if (!isNonEmptyString(input.sessionId)) return { ok: false, reason: 'session_id must be a non-empty string' };
  if (!isNonEmptyString(input.turnId)) return { ok: false, reason: 'turn_id must be a non-empty string' };
  if (input.action !== 'reconcile' && input.action !== 'cancel') {
    return { ok: false, reason: `action must be "reconcile" or "cancel", got ${JSON.stringify(input.action)}` };
  }
  const cursor = parseCursor(input.cursor, 'cursor');
  if ('error' in cursor) return { ok: false, reason: cursor.error };

  return {
    ok: true,
    command: {
      type: 'resume_turn',
      recovery_version: RECOVERY_VERSION,
      request_id: isNonEmptyString(input.requestId) ? input.requestId : mintRecoveryRequestId(),
      session_id: input.sessionId,
      turn_id: input.turnId,
      cursor: cursor.value,
      action: input.action,
    },
  };
}

/**
 * Build `resolve_interrupted_approval`.
 *
 * NOTHING IN THIS MODULE SENDS IT, on purpose. `approval_id` is required and no
 * engine event in the bundle produces one - the string appears only in this
 * command's own fixture, `manifest.json`, and the two schemas. The candidates
 * (`pending_turn.pending_call_id`, `approval_required.resume_token`, an
 * undeclared field on a replay item of kind `approval_requested`) can only be
 * settled by driving the binary through an interrupted approval and reading the
 * wire. Guessing sends an approve/deny that binds to nothing, or to the wrong
 * approval. The builder exists so the shape has one owner and one schema test.
 */
export function buildResolveInterruptedApproval(input: {
  sessionId: string;
  turnId: string;
  cursor: WCoreJournalCursor;
  approvalId: string;
  decision: 'approve' | 'deny';
  answer?: string;
  requestId?: string;
}): RecoveryBuildOutcome<ResolveInterruptedApprovalCommand> {
  if (!isNonEmptyString(input.sessionId)) return { ok: false, reason: 'session_id must be a non-empty string' };
  if (!isNonEmptyString(input.turnId)) return { ok: false, reason: 'turn_id must be a non-empty string' };
  if (!isNonEmptyString(input.approvalId)) return { ok: false, reason: 'approval_id must be a non-empty string' };
  if (input.decision !== 'approve' && input.decision !== 'deny') {
    return { ok: false, reason: `decision must be "approve" or "deny", got ${JSON.stringify(input.decision)}` };
  }
  if (input.answer !== undefined && typeof input.answer !== 'string') {
    return { ok: false, reason: `answer must be a string, got ${describeType(input.answer)}` };
  }
  const cursor = parseCursor(input.cursor, 'cursor');
  if ('error' in cursor) return { ok: false, reason: cursor.error };

  const command: ResolveInterruptedApprovalCommand = {
    type: 'resolve_interrupted_approval',
    recovery_version: RECOVERY_VERSION,
    request_id: isNonEmptyString(input.requestId) ? input.requestId : mintRecoveryRequestId(),
    session_id: input.sessionId,
    turn_id: input.turnId,
    cursor: cursor.value,
    approval_id: input.approvalId,
    decision: input.decision,
  };
  if (input.answer !== undefined) command.answer = input.answer;
  return { ok: true, command };
}

/* --------------------------- the capability ----------------------- */

/**
 * Where an accepted cursor is written so it survives the process.
 *
 * `null` clears the stored cursor. Installed by the wiring step; see
 * {@link TurnRecoveryCapability.setCursorSink}.
 */
export type RecoveryCursorSink = (sessionId: string, cursor: WCoreJournalCursor | null) => void;

export type SendResyncOutcome = { ok: true; requestId: string } | { ok: false; reason: string };

export type TurnRecoveryCapability = CapabilityHandler & {
  /**
   * Read the negotiated contract out of a `ready` payload and remember it for
   * that session. Returns null when `ready` carries no usable `session_id` -
   * `compat/events/ready.minimal.json` ships `session_id: null`, so that is a
   * supported engine, not an error.
   *
   * `ready` is NOT claimed by this handler and could not be: it has its own arm
   * in the decoder and never reaches the dispatcher, so a handler claiming it
   * would register a type that never routes.
   */
  seedFromReady(ready: unknown, ctx?: CapabilityContext): NegotiatedContract | null;
  /** The contract seen for a session, or {@link NO_CONTRACT} - which gates everything shut. */
  contractFor(sessionId: string): NegotiatedContract;
  /** May this host send `session_resync` for this session? */
  canResync(sessionId: string): boolean;
  /** Ask the engine to resync. The ONLY sanctioned way to send `session_resync`. */
  beginResync(ctx: CapabilityContext, sessionId: string, after?: WCoreJournalCursor): SendResyncOutcome;
  /** The journal position currently held for a session. */
  latestCursor(sessionId: string): WCoreJournalCursor | null;
  /** The interrupted turn a user should be asked about, or null. */
  pendingTurnFor(sessionId: string): WCorePendingTurn | null;
  /**
   * The compare-and-swap cursor a `resume_turn` for {@link pendingTurnFor} must
   * carry - the position the engine reported that turn at.
   *
   * THIS, not {@link latestCursor}, is what {@link buildResumeTurn} should be
   * given: the live `turn_recovery_lifecycle` feed moves `latestCursor` on while
   * the pending turn stays where the snapshot found it, so pairing the newest
   * cursor with the pending `turn_id` hands a safety-class compare-and-swap a
   * position belonging to a different turn.
   */
  pendingTurnCursorFor(sessionId: string): WCoreJournalCursor | null;
  /**
   * Install the durable cursor store.
   *
   * WITHOUT ONE THIS CAPABILITY IS INERT ACROSS A CRASH. The whole point of
   * `turn_recovery_lifecycle` is to leave an `after` on disk, and an in-memory
   * cursor is gone at exactly the moment it is needed. The store itself
   * (a `ProcessConfig` key, modelled on `ApprovalPersistence`) is a separate
   * file and is not part of this change - this is the seam it plugs into. The
   * sink is called fire-and-forget and a throw from it is swallowed: a
   * persistence hiccup must never take down the decode path.
   */
  setCursorSink(sink: RecoveryCursorSink | null): void;
  /** Forget one session. For a NEW engine process. */
  resetSession(sessionId: string): void;
  /** Forget everything. For tests and for app shutdown. */
  resetAll(): void;
  /** Sessions currently tracked, oldest first. For diagnostics and tests. */
  trackedSessions(): readonly string[];
};

/**
 * Build a capability bound to its own state.
 *
 * A factory rather than a bare object because {@link turnRecoveryCapability} is
 * a module-level singleton shared by every live `WCoreAgent` - tests that need
 * isolation build their own instance rather than fighting over the shared one.
 * Even within one instance, all state is keyed by the event's `session_id`, so
 * two concurrent engines cannot cross-contaminate.
 */
export function createTurnRecoveryCapability(): TurnRecoveryCapability {
  const trackers = new Map<string, SessionRecoveryTracker>();
  const contracts = new Map<string, NegotiatedContract>();
  /** Sessions whose `unusable` latch outlived their tracker. See below. */
  const refused = new Set<string>();
  let cursorSink: RecoveryCursorSink | null = null;

  /**
   * Remember that a session was refused, so eviction cannot un-refuse it.
   *
   * Bounded at {@link MAX_REFUSED_SESSIONS}; at the bound the oldest refusal is
   * forgotten and that session becomes recoverable again, which is said out loud
   * because it is the one way back into the hole this set exists to close.
   */
  function rememberRefusal(sessionId: string, ctx?: CapabilityContext): void {
    if (refused.has(sessionId)) return;
    if (refused.size >= MAX_REFUSED_SESSIONS) {
      const oldest = refused.values().next().value as string | undefined;
      if (oldest !== undefined) {
        refused.delete(oldest);
        ctx?.warn(
          `forgetting that recovery for session ${quoteWire(oldest)} was refused - ${MAX_REFUSED_SESSIONS} refusals were remembered, so that session can be reopened`
        );
      }
    }
    refused.add(sessionId);
  }

  function trackerFor(sessionId: string, ctx?: CapabilityContext): SessionRecoveryTracker {
    const existing = trackers.get(sessionId);
    if (existing) return existing;

    if (trackers.size >= MAX_TRACKED_SESSIONS) {
      // Map iterates in insertion order, so the first key is the oldest session.
      const oldest = trackers.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        // The `unusable` latch is the conservative half of the state-conflict
        // rule and it must NOT be erasable by an engine that names 32 fresh
        // sessions - `session_id` is a wire-controlled string, so eviction is
        // wire-controlled too. Only the id survives the tracker.
        if (trackers.get(oldest)?.isUnusable === true) rememberRefusal(oldest, ctx);
        trackers.delete(oldest);
        contracts.delete(oldest);
        ctx?.warn(
          `evicted recovery state for session ${quoteWire(oldest)} - ${MAX_TRACKED_SESSIONS} sessions were tracked`
        );
      }
    }
    const created = new SessionRecoveryTracker(sessionId);
    if (refused.has(sessionId)) {
      created.markRefused();
      ctx?.warn(
        `session ${quoteWire(sessionId)} was refused earlier in this process; its recovery state is re-created already refused`
      );
    }
    trackers.set(sessionId, created);
    return created;
  }

  function persist(sessionId: string, cursor: WCoreJournalCursor | null, ctx: CapabilityContext): void {
    if (!cursorSink) {
      // Not a fault - the store is wired separately - but it must not be
      // invisible either, or "recovery does nothing after a crash" and "recovery
      // is not wired up" leave the same empty trace.
      ctx.log('no cursor sink installed; the journal position is held in memory only and dies with this process');
      return;
    }
    try {
      cursorSink(sessionId, cursor);
    } catch (cause) {
      ctx.warn(`failed to persist the recovery cursor for "${sessionId}": ${String(cause)}`);
    }
  }

  function toFrame(sessionId: string, decision: RecoveryDecision): TurnRecoveryFrame {
    const rejected = decision.verdict !== 'applied' && decision.verdict !== 'ignored_duplicate';
    return {
      capability: TURN_RECOVERY_CAPABILITY,
      sessionId,
      verdict: decision.verdict,
      severity: rejected ? 'warning' : 'info',
      detail: decision.detail,
      cursor: decision.cursor,
      lifecycle: decision.lifecycle,
      pendingTurn: decision.pendingTurn,
      budget: decision.budget,
      unavailableReason: decision.unavailableReason,
      // See `TurnRecoveryFrame.actionable`. The pairing check is what makes this
      // false for the live feed and for a replay; there is deliberately no test
      // on `event.type` here, because the property that matters is "this cursor
      // is the one the engine named this turn at", not "this message was called
      // a snapshot". `!decision.unusable` used to be a fourth term and was
      // removed: `applied()` hardcodes `unusable: false` and rule 2 rejects
      // every message on a refused session, so it could never be anything else -
      // an unreachable term reads like a guard and is not one.
      actionable:
        decision.verdict === 'applied' &&
        decision.pendingTurn !== null &&
        decision.cursor !== null &&
        sameCursor(decision.pendingTurnCursor, decision.cursor),
    };
  }

  function contractFor(sessionId: string): NegotiatedContract {
    return contracts.get(sessionId) ?? NO_CONTRACT;
  }

  /**
   * Ask the engine to resync. Declared as a local function, not only as a method
   * on the returned object, because {@link CapabilityHandler.handle} calls it for
   * the genesis retry and a `this`-bound call there would break the moment the
   * handler were destructured or wrapped.
   */
  function beginResync(ctx: CapabilityContext, sessionId: string, after?: WCoreJournalCursor): SendResyncOutcome {
    if (!isNonEmptyString(sessionId)) return { ok: false, reason: 'session_id must be a non-empty string' };

    // THE GATE. A `session_resync` sent to a build that graded this capability
    // `shape_only` - or that journals nothing - waits for a reply that never
    // comes, and the start path is blocked behind it. The default is
    // NO_CONTRACT, so an engine whose `ready` was never seeded is refused too:
    // fail closed.
    const contract = contractFor(sessionId);
    if (!canRecoverSessions(contract)) {
      return {
        ok: false,
        reason: `turn_recovery_v1 is "${gradeOf(contract, TURN_RECOVERY_CAPABILITY)}" and session_persistence is "${contract.sessionPersistence ?? 'unstated'}"; a resync would wait for an answer that never comes`,
      };
    }

    const requestId = mintRecoveryRequestId();
    const built = buildSessionResync({ sessionId, requestId, after });
    // `=== false` rather than `!built.ok`: this repo compiles without
    // strictNullChecks, where only an explicit comparison narrows a
    // discriminated union.
    if (built.ok === false) {
      ctx.warn(`refusing to send a malformed session_resync: ${built.reason}`);
      return { ok: false, reason: built.reason };
    }

    try {
      ctx.sendCommand(built.command);
    } catch (cause) {
      // `sendCommand` drops silently when the engine is gone and throws when the
      // stream dies mid-write. Report the ask as not made, and leave the ledger
      // untouched so a later answer cannot be matched to an ask never sent.
      const reason = `session_resync was not sent: ${String(cause)}`;
      ctx.warn(reason);
      return { ok: false, reason };
    }

    trackerFor(sessionId, ctx).noteResyncRequest(requestId);
    ctx.log(`session_resync "${requestId}" sent for "${sessionId}" (after: ${describeCursor(after ?? null)})`);
    return { ok: true, requestId };
  }

  return {
    name: TURN_RECOVERY_CAPABILITY,
    handles: [...RECOVERY_EVENT_TYPES],

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      const sessionId = event.session_id;
      if (!isWireId(sessionId)) {
        // Without a usable session id there is no state to key, so this handler
        // cannot own the event. Returning false is the honest answer: it falls
        // through to the acknowledged-unhandled check and is reported, not
        // swallowed. The LENGTH half matters as much as the empty half: the id
        // becomes a `Map` key held until eviction, so checking it here is what
        // keeps a wire string from being retained at all.
        ctx.warn(
          `recovery event carries no usable session_id (non-empty, at most ${MAX_WIRE_ID_LENGTH} characters); it cannot be attributed to a session`,
          event
        );
        return false;
      }

      const tracker = trackerFor(sessionId, ctx);
      const decision = tracker.accept(event);

      if (decision.verdict === 'applied') {
        ctx.log(decision.detail);
        persist(sessionId, decision.cursor, ctx);
      } else if (decision.verdict === 'ignored_duplicate') {
        // Nothing changed and nothing is wrong. Warning here would train the
        // operator to ignore the one event class that matters.
        ctx.log(decision.detail);
      } else {
        ctx.warn(`${decision.verdict}: ${decision.detail}`);
        // Write on `unavailable` ONLY when the reducer actually dropped the
        // position (see `CURSOR_INDICTED`). Writing null unconditionally is how
        // a transient `snapshot_unavailable` used to erase the durable `after`
        // that the next start depends on.
        if (decision.verdict === 'unavailable' && decision.cursor === null) persist(sessionId, null, ctx);
      }

      if (!decision.sequencesVerified) {
        ctx.warn(
          'replay cursors carried no journal_sequence, so the item order could not be verified; a skipped journal entry would not be detected'
        );
      }

      if (decision.retryGenesis) {
        // Exactly one retry, guarded by a once-flag inside the tracker, so a
        // genesis resync that also fails cannot loop against the engine.
        const retried = beginResync(ctx, sessionId);
        if (retried.ok === false) ctx.warn(`genesis retry not sent: ${retried.reason}`);
      }

      // The interrupted-turn notice belongs to the SNAPSHOT that discovered it.
      // A replay that follows only refines the cursor, and the tracker still
      // carries the pending turn - announcing on both would ask the user the
      // same question twice about one dead turn.
      const announcesPendingTurn =
        decision.verdict === 'applied' && decision.pendingTurn !== null && event.type === 'session_recovery_snapshot';
      // Every non-adopting verdict, `unavailable` included: the user has to
      // learn that the app could NOT establish what happened, which is exactly
      // the silence this capability exists to end.
      const isRejection = decision.verdict !== 'applied' && decision.verdict !== 'ignored_duplicate';
      const announcesLiveReconcile =
        event.type === 'turn_recovery_lifecycle' && event.reconcile_reason !== undefined && decision.applied;

      if (announcesPendingTurn || isRejection || announcesLiveReconcile) {
        // `msg_id` is empty because an interrupted turn is a SESSION fact that
        // arrives before any turn is open; filing it under whatever message
        // happened to be active would attach it to the wrong one.
        ctx.emit({ type: TURN_RECOVERY_FRAME_TYPE, data: toFrame(sessionId, decision), msg_id: '' });
      }
      return true;
    },

    seedFromReady(ready: unknown, ctx?: CapabilityContext): NegotiatedContract | null {
      if (!isRecord(ready)) {
        ctx?.log('ready payload is not an object; no recovery contract to read');
        return null;
      }
      const sessionId = ready.session_id;
      if (!isNonEmptyString(sessionId)) {
        // `compat/events/ready.minimal.json` ships `session_id: null` alongside
        // `session_persistence: "disabled_by_operator"`. A supported engine, and
        // one with nothing to recover.
        ctx?.log('ready carries no session_id; recovery stays gated shut for this engine');
        return null;
      }

      const contract = negotiateContract(ready);
      contracts.set(sessionId, contract);
      trackerFor(sessionId, ctx);

      if (!canRecoverSessions(contract)) {
        ctx?.log(
          `recovery is not usable on this engine: turn_recovery_v1 is "${gradeOf(contract, TURN_RECOVERY_CAPABILITY)}" and session_persistence is "${contract.sessionPersistence ?? 'unstated'}"`
        );
      }
      return contract;
    },

    contractFor,

    canResync(sessionId: string): boolean {
      return canRecoverSessions(contractFor(sessionId));
    },

    beginResync,

    latestCursor(sessionId: string): WCoreJournalCursor | null {
      return trackers.get(sessionId)?.currentCursor ?? null;
    },

    pendingTurnFor(sessionId: string): WCorePendingTurn | null {
      return trackers.get(sessionId)?.currentPendingTurn ?? null;
    },

    pendingTurnCursorFor(sessionId: string): WCoreJournalCursor | null {
      return trackers.get(sessionId)?.currentPendingTurnCursor ?? null;
    },

    setCursorSink(sink: RecoveryCursorSink | null): void {
      cursorSink = sink;
    },

    resetSession(sessionId: string): void {
      trackers.get(sessionId)?.reset();
      contracts.delete(sessionId);
      // A NEW engine process is the one sanctioned way out of a refusal, so the
      // tombstone goes with it - otherwise a session refused once could never
      // recover for the life of the app. This is host-called; the wire cannot
      // reach it, which is the whole difference from eviction.
      refused.delete(sessionId);
    },

    resetAll(): void {
      trackers.clear();
      contracts.clear();
      refused.clear();
    },

    trackedSessions(): readonly string[] {
      return [...trackers.keys()];
    },
  };
}

/**
 * The instance intended for the capability registry.
 *
 * Being exported is not being registered: dispatch only reaches handlers listed
 * in `HANDLERS` in `capabilities/index.ts`. This module cannot see that list, so
 * it makes no claim about it - see requirement (1) in the file header.
 */
export const turnRecoveryCapability: TurnRecoveryCapability = createTurnRecoveryCapability();
