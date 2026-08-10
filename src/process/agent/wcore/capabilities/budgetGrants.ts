/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Budget grants: the half of the budget conversation Darhai never had.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A self-contained implementation of the engine's budget-grant exchange:
 * building `continue_with_budget`, tracking the request_ids it mints, decoding
 * `budget_grant_result`, and building `approval_resume`. It is a library plus
 * one {@link CapabilityHandler}. It wires nothing up and imports nothing from
 * the agent.
 *
 * WHAT IT REQUIRES - none of this is true yet
 * -------------------------------------------
 * Read the list below as a to-do for whoever merges the capabilities, NOT as a
 * description of the running system:
 *
 *  1. `budgetGrantsCapability` must be added to `HANDLERS` in
 *     `capabilities/index.ts`. That array is empty today, so nothing in this
 *     file runs in production - `dispatchCapabilityEvent` claims no types at
 *     all and every `budget_grant_result` falls straight through it.
 *  2. `budget_grant_result` should then be removed from
 *     `ACKNOWLEDGED_UNHANDLED_EVENTS` in `protocol.ts`, which still lists it.
 *     Dispatch runs before that check, so leaving it is not a live bug; it is a
 *     stale claim that this event is deliberately inert.
 *  3. Something must actually CALL {@link sendContinueWithBudget} - a button on
 *     the `budget_exceeded` notice is the obvious place. Nothing calls it today,
 *     which is why the send path carries its own delivery probe rather than
 *     assuming a healthy transport.
 *
 * WHAT IS TRUE TODAY, in the files named
 * --------------------------------------
 * `WCoreAgent.handleEvent` has a `budget_exceeded` arm that prints one info line
 * - "Budget exceeded: max_tokens_out (observed 8192, limit 4096)" - and then the
 * turn is simply over. The engine publishes a way back (`continue_with_budget`
 * out, `budget_grant_result` in) and Darhai speaks neither: `WCoreCommand` has
 * no `continue_with_budget`, and the answer sits in
 * `ACKNOWLEDGED_UNHANDLED_EVENTS`, i.e. is decoded to nothing on purpose. The
 * user's only recourse is to start again.
 *
 * WHAT IT OWNS
 * ------------
 *   - the ONLY sanctioned way to construct `continue_with_budget`, because that
 *     command is `additionalProperties: false` with an `anyOf` that JSON-Schema
 *     expresses and TypeScript cannot (see {@link buildContinueWithBudget});
 *   - the request_id ledger, because the manifest gives both budget types
 *     `"correlation": "request_id"` and the engine can answer
 *     `request_id_conflict`, which proves it tracks ids on its side too;
 *   - the decoder for `budget_grant_result`, including the nine refusal reasons
 *     that would otherwise be swallowed - "managed_policy" (an admin blocked it)
 *     has to read differently from "turn_in_progress" (try again in a moment).
 *
 * It also builds `approval_resume`. That is a COMMAND the contract publishes
 * and Darhai cannot send; the same-named EVENT already has an arm in the core
 * decoder, which is why this lives here rather than in `protocol.ts`.
 *
 * Money moves through here, so every judgement call below is made in the
 * direction of sending less, later, or not at all.
 */

import { randomBytes } from 'node:crypto';

import type { CapabilityContext, CapabilityHandler } from './types';

/**
 * The name this capability reports in logs and tests.
 *
 * Deliberately NOT read from `manifest.capabilities`: the manifest files both
 * budget types under capability `"available"`, which is its catch-all bucket
 * and not a negotiable id (there is no `budget_*` key in the engine's `ready`
 * contract block at all). Gating sends on `isCapabilityAvailable(..., 'available')`
 * would therefore be permanently closed and would hide the engine's own answer -
 * and the engine already has a refusal channel for exactly this question,
 * `host_not_authorized`. Let the engine refuse; do not guess on its behalf.
 */
export const BUDGET_GRANTS_CAPABILITY = 'budget_and_approval_resume';

/**
 * Every refusal the engine may answer with, verbatim from
 * `schema/core-event.schema.json` (budget_grant_result branch,
 * `properties.refusal_reason.enum`).
 *
 * One array, from which the type is derived - a hand-written union next to a
 * hand-written runtime list is two things that drift, and the drift shows up as
 * a refusal silently decoded as "unknown", i.e. as nothing.
 */
export const BUDGET_REFUSAL_REASONS = [
  'host_not_authorized',
  'managed_policy',
  'no_exhausted_budget',
  'invalid_grant',
  'budget_tracker_unavailable',
  'persistence_failure',
  'request_id_conflict',
  'ledger_capacity_exceeded',
  'turn_in_progress',
] as const;

export type BudgetRefusalReason = (typeof BUDGET_REFUSAL_REASONS)[number];

/**
 * Is re-asking with the same amounts sensible?
 *
 * Only `turn_in_progress` names a transient state; it reads as "grants are
 * refused WHILE a turn is running", so the same request may succeed moments
 * later. The other eight describe a decision (`managed_policy`), a malformed
 * request (`invalid_grant`), or a broken subsystem (`persistence_failure`) -
 * none of which a blind retry improves, and a retry loop against
 * `host_not_authorized` would hammer the engine forever. The contract does not
 * classify them, so this is Darhai's reading, kept in one place.
 */
export function isRetryableRefusal(reason: BudgetRefusalReason): boolean {
  return reason === 'turn_in_progress';
}

/**
 * `request_id`, verbatim from the schema (identical on the command and on the
 * event). The pattern alone implies all three of the schema's string rules:
 * `minLength: 1` (one mandatory leading character), `maxLength: 128`
 * (1 + at most 127) and the character set. It is the single guard for that
 * field here, rather than three guards that could disagree with each other.
 *
 * Measured, and the reason a length check is not enough on its own:
 * `adversarial/commands/continue-with-budget-unicode-request-id.jsonl` is 128
 * code points (256 UTF-16 units, 512 bytes) of emoji - it PASSES `maxLength`
 * and is caught only by the ASCII character class.
 *
 * TRANSCRIBED, WITH A GATE. `src/` must not read `tests/fixtures/` at runtime,
 * so this literal is a copy of the schema's `pattern` and copies drift. The
 * drift gate is the test "REQUEST_ID_PATTERN is the schema's pattern verbatim"
 * in `tests/unit/wcore-budgetGrants.test.ts`, which compares this `.source`
 * against `schema/host-command.schema.json` and against the identical pattern on
 * the event branch. Change one and that test goes red.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The schema's `maximum` for `additional_tokens`, as an exact BigInt.
 *
 * MEASURED TRAP. `18446744073709551615` (2^64-1) and `18446744073709551616`
 * (2^64) are the SAME IEEE-754 double, so ajv accepts
 * `adversarial/commands/continue-with-budget-overflow-tokens.jsonl` - I ran the
 * contract's own host-command.schema.json over all ten fixtures and that one
 * came back valid. Any host guard written as `value <= 18446744073709551615`
 * is blind in exactly the place the fixture aims, and so is
 * `BigInt(18446744073709551615)` (the number is rounded to 2^64 before BigInt
 * ever sees it). Only a BigInt built from the exact digits holds the real bound.
 *
 * Side effect, accepted on purpose: the legal maximum, if a caller ever typed
 * it as a JS number, also rounds up to 2^64 and is refused. Real grants are
 * ~10^7, so refusing the top of a range nobody reaches is the cheap direction.
 *
 * Built from a STRING, not a `123n` literal: this repo targets ES6, where a
 * BigInt literal is a compile error (TS2737). The string is exact; a numeric
 * argument would not be.
 *
 * TRANSCRIBED, WITH A GATE - and the gate has to read the schema as TEXT.
 * `JSON.parse` on the schema file destroys this number before any comparison
 * can see it (it comes back as 18446744073709552000), so the test "the token
 * bound is the schema's maximum, digit for digit" in
 * `tests/unit/wcore-budgetGrants.test.ts` extracts the raw digits from the file
 * and compares BigInt to BigInt. Change either side and that test goes red.
 */
export const MAX_ADDITIONAL_TOKENS = BigInt('18446744073709551615');

/**
 * How many grants may await an answer at once.
 *
 * A HOST-SIDE CHOICE, not a contract number. The contract publishes
 * `ledger_capacity_exceeded` as a refusal reason, which says the ENGINE bounds
 * its own ledger, but it never states that bound - there is no capacity field in
 * the manifest, the schemas, or any fixture (grepped: the string appears only in
 * the two `refusal_reason` enums). So this number cannot be derived; 64 is
 * picked and stated as a pick.
 *
 * What the engine can actually send: nothing that grows this map. Only
 * {@link sendContinueWithBudget} adds an entry and every entry is one deliberate
 * user press, so 64 outstanding presses in one session is already far past
 * anything a human does - the map only reaches the cap when the engine has
 * stopped answering, which is exactly the leak this bounds.
 *
 * What happens at the cap: the OLDEST entry is dropped, with a warning naming it
 * and its age. Refusing new grants instead would let one unanswered request
 * disable the feature for the rest of the session; dropping the oldest keeps the
 * newest press working. If an evicted grant is answered later, the answer meets
 * the unknown-request_id path in {@link budgetGrantsCapability} and is discarded
 * with a warning rather than settling somebody else's grant.
 */
export const MAX_PENDING_GRANTS = 64;

/** `continue_with_budget`, exactly as it goes on the wire. */
export type ContinueWithBudgetCommand = {
  type: 'continue_with_budget';
  request_id: string;
  additional_tokens?: number;
  additional_cost_usd?: number;
};

/** `approval_resume`, exactly as it goes on the wire. */
export type ApprovalResumeCommand = {
  type: 'approval_resume';
  resume_token: string;
  approved: boolean;
  modifications?: { answer: string };
};

/** What a caller asks for. Converted field-by-field; never spread. */
export type ContinueWithBudgetInput = {
  requestId: string;
  additionalTokens?: number;
  additionalCostUsd?: number;
};

export type ApprovalResumeInput = {
  resumeToken: string;
  approved: boolean;
  /**
   * The free-form answer channel. `tool_approve` cannot express it, which is
   * the one thing this command can do that the existing approval path cannot.
   */
  answer?: string;
};

/**
 * Built or refused, with the reason a human can act on.
 *
 * Refusing is a first-class outcome rather than a throw: the caller is a UI
 * press, and "the grant was not sent because X" has to reach the person who
 * pressed, not an unhandled rejection in the main process.
 */
export type BuildOutcome<T> = { ok: true; command: T } | { ok: false; reason: string };

/** A decoded `budget_grant_result`. */
export type BudgetGrantResult = {
  requestId: string;
  /** Tokens the engine ACTUALLY granted - it may be fewer than asked for. */
  additionalTokens: number;
  /** USD the engine ACTUALLY granted. */
  additionalCostUsd: number;
  outcome: 'granted' | 'refused';
  refusalReason?: BudgetRefusalReason;
};

/**
 * What the task layer receives. Carries the requested amounts beside the
 * granted ones because the schema lets the engine grant less than was asked
 * for, and a host that shows the requested figure as if it were granted
 * misreports spend in the one place users check it.
 */
export type BudgetGrantFrameData = BudgetGrantResult & {
  requestedTokens?: number;
  requestedCostUsd?: number;
  /** Refused for a transient reason - the same grant may work shortly. */
  retryable: boolean;
};

type PendingGrant = {
  readonly requestId: string;
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly at: number;
};

/**
 * Grants awaiting an answer, keyed by request_id.
 *
 * Module-scoped because `CapabilityContext` has nowhere to put state and the
 * dispatcher itself is a module singleton - a capability that must correlate
 * has to hold its own ledger. `resetBudgetGrants()` is the seam for session
 * restart (and for tests, which drive this exact object rather than a copy).
 */
const pendingGrants = new Map<string, PendingGrant>();

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function requestIdFault(field: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return `${field} must be a string, got ${describeType(value)}`;
  if (!REQUEST_ID_PATTERN.test(value)) return `${field} must match ${REQUEST_ID_PATTERN.source}`;
  return undefined;
}

function tokensFault(value: unknown): string | undefined {
  // `Number.isInteger` is false for NaN and both infinities, so this one check
  // also keeps values JSON cannot represent off the wire (`JSON.stringify`
  // turns them into `null`, which the engine would reject as a type error far
  // from where the bug was introduced).
  if (!Number.isInteger(value)) return `additional_tokens must be an integer, got ${describeType(value)}`;
  const tokens = value as number;
  if (tokens < 0) return 'additional_tokens must be >= 0';
  if (BigInt(tokens) > MAX_ADDITIONAL_TOKENS) return `additional_tokens must be <= ${MAX_ADDITIONAL_TOKENS}`;
  return undefined;
}

function costFault(value: unknown): string | undefined {
  if (typeof value !== 'number') return `additional_cost_usd must be a number, got ${describeType(value)}`;
  if (!Number.isFinite(value)) return 'additional_cost_usd must be finite';
  if (value < 0) return 'additional_cost_usd must be >= 0';
  return undefined;
}

/**
 * Mint a request_id for one grant.
 *
 * Fresh per press, never derived from the cap that triggered it. The contract
 * is silent on id lifetime, but it publishes `request_id_conflict`, so a
 * derived-and-therefore-stable id risks a permanent conflict against an engine
 * that remembers the first attempt; a fresh id risks double-granting if the
 * user presses twice, which is a HOST problem and is solved on the host side
 * (the caller de-dupes the dialog). Between "cannot ever grant again" and
 * "de-dupe upstream", the second is recoverable.
 *
 * Shape: `budget-<base36 ms>-<8 hex>` = 24 ASCII chars, always inside the
 * pattern and well under `maxLength: 128`.
 */
export function mintBudgetRequestId(): string {
  return `budget-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Build `continue_with_budget`, or refuse and say why.
 *
 * This is the only sanctioned constructor for the command, for two reasons the
 * type system cannot cover:
 *
 *  1. `additionalProperties: false`. One stray key invalidates the whole
 *     message, so the command is assembled field-by-field from named inputs and
 *     caller objects are never spread. `adversarial/.../unknown-field.jsonl`
 *     (`future_authority: true`) is that failure, and it is unrepresentable
 *     here rather than merely checked for.
 *  2. The `anyOf`: at least one of `additional_tokens >= 1` or
 *     `additional_cost_usd > 0`. TypeScript has no way to state "one of these
 *     two optional numbers must be present AND positive", so a grant of nothing
 *     - `adversarial/.../empty.jsonl` - is refused here or nowhere.
 */
export function buildContinueWithBudget(input: ContinueWithBudgetInput): BuildOutcome<ContinueWithBudgetCommand> {
  const idFault = requestIdFault('request_id', input.requestId);
  if (idFault) return { ok: false, reason: idFault };

  // Values arrive from a renderer press over IPC, where JSON erases the
  // declared types - `"1"` survives the trip as a string. Check at runtime.
  const tokens = input.additionalTokens;
  if (tokens !== undefined) {
    const fault = tokensFault(tokens);
    if (fault) return { ok: false, reason: fault };
  }

  const cost = input.additionalCostUsd;
  if (cost !== undefined) {
    const fault = costFault(cost);
    if (fault) return { ok: false, reason: fault };
  }

  const tokensQualify = typeof tokens === 'number' && tokens >= 1;
  const costQualify = typeof cost === 'number' && cost > 0;
  if (!tokensQualify && !costQualify) {
    return { ok: false, reason: 'a grant must add at least 1 token or more than $0' };
  }

  const command: ContinueWithBudgetCommand = { type: 'continue_with_budget', request_id: input.requestId };
  if (tokens !== undefined) command.additional_tokens = tokens;
  if (cost !== undefined) command.additional_cost_usd = cost;
  return { ok: true, command };
}

/**
 * Build `approval_resume`.
 *
 * DO NOT rewire the existing tool-approval path onto this. `approval_required`
 * carries BOTH `call_id` and `resume_token`, and the contract publishes both
 * answers (`tool_approve` and this) without ever saying whether they are
 * alternatives or a superset. Darhai answers tool approvals with `tool_approve`
 * today and that is measured to work; sending both would double-answer one
 * approval. This exists for what `tool_approve` genuinely cannot express - a
 * `modifications.answer`, and the `suspend` event, which carries a resume_token
 * and has no answer path at all.
 *
 * The schema allows extra keys here (`additionalProperties: true`, unlike
 * `continue_with_budget`) and allows extra keys inside `modifications`. Only
 * `answer` is exposed, because it is the only one the schema names and there is
 * no consumer for the rest; passing through unnamed keys would be inventing
 * wire fields on the engine's behalf.
 */
export function buildApprovalResume(input: ApprovalResumeInput): BuildOutcome<ApprovalResumeCommand> {
  if (typeof input.resumeToken !== 'string' || input.resumeToken.length === 0) {
    // The schema only says `type: string`, but a suspension is routed by this
    // token alone: an empty one is an answer the engine cannot match to
    // anything, and the turn stays suspended with no sign that we replied.
    return { ok: false, reason: 'resume_token must be a non-empty string' };
  }
  if (typeof input.approved !== 'boolean') {
    // Never coerce. A truthy string here would approve a tool the human denied.
    return { ok: false, reason: `approved must be a boolean, got ${describeType(input.approved)}` };
  }
  if (input.answer !== undefined && typeof input.answer !== 'string') {
    return { ok: false, reason: `answer must be a string, got ${describeType(input.answer)}` };
  }

  const command: ApprovalResumeCommand = {
    type: 'approval_resume',
    resume_token: input.resumeToken,
    approved: input.approved,
  };
  if (input.answer !== undefined) command.modifications = { answer: input.answer };
  return { ok: true, command };
}

export type SendGrantOutcome = { ok: true; requestId: string } | { ok: false; reason: string };

/**
 * Answers "would a command written right now actually leave this process?".
 *
 * WHY THIS IS A REQUIRED ARGUMENT AND NOT AN OPTION WITH A DEFAULT.
 * `CapabilityContext.sendCommand` returns `void`, and the implementation behind
 * it drops the command in silence when the engine is gone -
 * `WCoreAgent.sendCommand` is literally
 * `if (!this.childProcess?.stdin?.writable) return;` followed by the write. So
 * a capability that only has the context CANNOT tell a delivered command from a
 * discarded one, and a ledger entry written for a discarded command is a
 * request_id that can never be answered: the dialog spins forever and the slot
 * is held until eviction.
 *
 * This module refuses to guess. The caller has the agent and therefore has the
 * answer, so it must hand it in. Wiring this to `() => true` would be a lie with
 * a signature, and it would be visible as one in review.
 *
 * A probe cannot close the window completely - the stream can die between the
 * check and the write - which is why the write is also wrapped: see
 * {@link sendContinueWithBudget}.
 */
export type EngineReachable = () => boolean;

/** Drop the oldest pending grant to make room, loudly. See {@link MAX_PENDING_GRANTS}. */
function evictOldestGrant(ctx: CapabilityContext): void {
  // Map iterates in insertion order, so the first key is the oldest send.
  const oldest = pendingGrants.entries().next().value;
  if (oldest === undefined) return;
  pendingGrants.delete(oldest[0]);
  // The age is the useful part of this warning: an engine that answers in
  // milliseconds and one that never answers look identical without it.
  const ageMs = Date.now() - oldest[1].at;
  ctx.warn(`evicted unanswered budget grant "${oldest[0]}" after ${ageMs}ms - ${MAX_PENDING_GRANTS} were pending`);
}

/**
 * Send one grant and remember it until the engine answers.
 *
 * Takes a {@link CapabilityContext} rather than reaching for the agent: a
 * capability may only speak through the context it is handed, and this keeps
 * the whole path unit-testable without an engine process. It takes
 * {@link EngineReachable} separately because the context cannot answer that
 * question - see the type's own note.
 *
 * ORDER MATTERS. Probe, send, and only then record. Every failure mode leaves
 * the ledger exactly as it found it, so the outcome the caller gets and the
 * state the module is in agree: `ok: false` means nothing is pending and the
 * user may press again, `ok: true` means the command was written and an answer
 * is owed.
 *
 * Nothing here waits. Handlers are synchronous by design, so the answer arrives
 * later as `budget_grant_result` and is emitted as a frame - a promise racing a
 * timeout inside the decode path would be the slow thing this layer forbids.
 */
export function sendContinueWithBudget(
  ctx: CapabilityContext,
  input: ContinueWithBudgetInput,
  canReachEngine: EngineReachable
): SendGrantOutcome {
  const built = buildContinueWithBudget(input);
  // `=== false` rather than `!built.ok`: this repo compiles without
  // strictNullChecks, where only an explicit comparison narrows a discriminated
  // union - `!built.ok` leaves `built.reason` a type error.
  if (built.ok === false) {
    ctx.warn(`refusing to send a malformed continue_with_budget: ${built.reason}`);
    return { ok: false, reason: built.reason };
  }

  const requestId = built.command.request_id;
  if (pendingGrants.has(requestId)) {
    // The engine answers `request_id_conflict` for this; producing the conflict
    // ourselves would spend twice on one press if the engine were lenient.
    return { ok: false, reason: `request_id "${requestId}" is already awaiting an answer` };
  }

  if (!canReachEngine()) {
    const reason = 'the engine cannot be reached, so the grant was not sent';
    ctx.warn(`refusing to send continue_with_budget "${requestId}": ${reason}`);
    return { ok: false, reason };
  }

  try {
    ctx.sendCommand(built.command);
  } catch (cause) {
    // The probe said yes and the write still failed - a stream that died in
    // between throws EPIPE/ERR_STREAM_DESTROYED rather than returning. Report
    // the press as not sent; an unsent grant is one the user can repeat, a
    // recorded-but-unsent grant is a spinner nothing will ever stop.
    const reason = `the grant was not sent: ${String(cause)}`;
    ctx.warn(`continue_with_budget "${requestId}" failed to reach the engine: ${String(cause)}`);
    return { ok: false, reason };
  }

  if (pendingGrants.size >= MAX_PENDING_GRANTS) evictOldestGrant(ctx);

  pendingGrants.set(requestId, {
    requestId,
    tokens: built.command.additional_tokens,
    costUsd: built.command.additional_cost_usd,
    at: Date.now(),
  });
  return { ok: true, requestId };
}

/** request_ids still awaiting an answer, in the order they were sent. */
export function pendingBudgetGrantIds(): readonly string[] {
  return [...pendingGrants.keys()];
}

/**
 * Forget every pending grant.
 *
 * For session restart: an id minted against a dead engine can never be
 * answered, and keeping it would only make a fresh grant look like a conflict.
 */
export function resetBudgetGrants(): void {
  pendingGrants.clear();
}

/**
 * Every key the schema lets `budget_grant_result` carry - the branch's
 * `properties`, of which its `required` list is a subset.
 *
 * One list, used by the unknown-key check below. Kept beside the decoder rather
 * than derived from the type, because a TypeScript type is erased at runtime and
 * this check has to happen at runtime.
 */
const BUDGET_GRANT_RESULT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'request_id',
  'additional_tokens',
  'additional_cost_usd',
  'outcome',
  'refusal_reason',
]);

/**
 * Decode `budget_grant_result`, or say why it cannot be trusted.
 *
 * The schema's two `allOf` rules bind `refusal_reason` to `outcome` - required
 * when refused, FORBIDDEN when granted - and both directions are enforced here.
 * A "granted" that also carries a refusal is not a message with a harmless
 * extra field; it is a message whose two halves disagree about whether money
 * was spent, and picking either half would be a guess.
 *
 * UNKNOWN TOP-LEVEL KEYS ARE REFUSED, and this is the one event class where
 * that is the right direction. Elsewhere (`negotiateContract` over `ready`)
 * Darhai tolerates unknown keys, because an unrecognised key there is
 * indistinguishable from an engine upgrade and refusing it would turn an
 * additive change into a dead feature. Here the schema branch is
 * `additionalProperties: false` and the manifest grades the type
 * `criticality: safety`: this message is the answer to a question about money,
 * and a key this host does not model may be the half that says how much. There
 * is no safe way to settle a spend answer that is only partly understood.
 *
 * The cost is real and is accepted deliberately: an engine that adds a field to
 * this event stalls grant answers until Darhai is taught the field. It is not
 * silent - the reason names the offending keys, the pending entry survives so a
 * well-formed answer can still settle it, and the caller's own
 * `budget_grant_result` fixtures fail the moment the contract bundle changes.
 * Between "stall loudly" and "credit an amount from a message we half-read",
 * this event class gets the first.
 */
export function decodeBudgetGrantResult(
  event: Record<string, unknown>
): { ok: true; value: BudgetGrantResult } | { ok: false; reason: string } {
  if (event.type !== 'budget_grant_result')
    return { ok: false, reason: `not a budget_grant_result: ${describeType(event.type)}` };

  const unknownKeys = Object.keys(event).filter((key) => !BUDGET_GRANT_RESULT_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `budget_grant_result carries unknown field(s): ${unknownKeys.toSorted().join(', ')}` };
  }

  const idFault = requestIdFault('request_id', event.request_id);
  if (idFault) return { ok: false, reason: idFault };

  const tokenFault = tokensFault(event.additional_tokens);
  if (tokenFault) return { ok: false, reason: tokenFault };

  const usdFault = costFault(event.additional_cost_usd);
  if (usdFault) return { ok: false, reason: usdFault };

  const outcome = event.outcome;
  if (outcome !== 'granted' && outcome !== 'refused') {
    return { ok: false, reason: `outcome must be "granted" or "refused", got ${JSON.stringify(outcome)}` };
  }

  const rawReason = event.refusal_reason;
  if (outcome === 'granted') {
    if (rawReason !== undefined) return { ok: false, reason: 'a granted result must not carry refusal_reason' };
    return {
      ok: true,
      value: {
        requestId: event.request_id as string,
        additionalTokens: event.additional_tokens as number,
        additionalCostUsd: event.additional_cost_usd as number,
        outcome,
      },
    };
  }

  // Refused. An unrecognised reason is refused rather than passed through: the
  // enum is how the UI decides between "an admin blocked this" and "try again",
  // and a string that means neither must not reach that decision.
  if (!BUDGET_REFUSAL_REASONS.includes(rawReason as BudgetRefusalReason)) {
    return { ok: false, reason: `unknown refusal_reason ${JSON.stringify(rawReason)}` };
  }

  return {
    ok: true,
    value: {
      requestId: event.request_id as string,
      additionalTokens: event.additional_tokens as number,
      additionalCostUsd: event.additional_cost_usd as number,
      outcome,
      refusalReason: rawReason as BudgetRefusalReason,
    },
  };
}

/**
 * The capability itself - inert until something registers it (see the file
 * header's REQUIRES list).
 *
 * It declares `budget_grant_result` and nothing else. `budget_exceeded` has its
 * own arm in `WCoreAgent.handleEvent` today (a first-class event that predates
 * this layer), and `approval_resume` as an EVENT has an arm there too - claiming
 * either type here would either be dead code or a second answer to one question,
 * and the registry rejects two claims on one type outright.
 */
export const budgetGrantsCapability: CapabilityHandler = {
  name: BUDGET_GRANTS_CAPABILITY,
  handles: ['budget_grant_result'],

  handle(event, ctx) {
    const decoded = decodeBudgetGrantResult(event);
    if (decoded.ok === false) {
      ctx.warn(`ignoring malformed budget_grant_result: ${decoded.reason}`, event);
      return false;
    }

    const result = decoded.value;
    const request = pendingGrants.get(result.requestId);
    if (!request) {
      // Never settle a neighbour. Correlation is `request_id` per the manifest,
      // and an answer we cannot place is either a duplicate of one already
      // settled or a reply to a previous session - both mean "do nothing",
      // because the alternative is crediting one grant's tokens to another.
      ctx.warn(`budget_grant_result for unknown request_id "${result.requestId}" - dropped`);
      return false;
    }

    pendingGrants.delete(result.requestId);
    ctx.log(`grant ${result.requestId} ${result.outcome}${result.refusalReason ? ` (${result.refusalReason})` : ''}`, {
      tokens: result.additionalTokens,
      costUsd: result.additionalCostUsd,
    });

    const data: BudgetGrantFrameData = {
      ...result,
      requestedTokens: request.tokens,
      requestedCostUsd: request.costUsd,
      retryable: result.refusalReason !== undefined && isRetryableRefusal(result.refusalReason),
    };
    ctx.emit({ type: 'budget_grant_result', data, msg_id: ctx.activeMsgId() });
    return true;
  },
};
