/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Anvil receipts - the engine's tamper-evident audit trail.
 *
 * `anvil_receipt` publishes a verdict over a run (artifact digest, gate closure
 * digest, checks passed/total, coverage, iterations, cost).
 * `anvil_receipt_invalidated` retracts one, with a reason. Both are graded
 * `criticality: safety` in the contract manifest and correlate on
 * `session_id_and_sequence`.
 *
 * WIRING STATUS - read this before believing anything below about delivery.
 * The decode path is wired: `capabilities/index.ts` lists this capability in
 * `HANDLERS`, and neither type name remains in `ACKNOWLEDGED_UNHANDLED_EVENTS`
 * in `../protocol.ts`, so both events now reach the ledger. The frame path is
 * wired too, but by a step that is easy to miss and was once missed here:
 * {@link ANVIL_ALERT_FRAME} is a PROJECTION - it is not one of the names this
 * module consumes, and `WCoreManager` drops any frame with no `msg_id` unless
 * its type is in `forwardableFrameTypes()`. That set unions each handler's
 * `handles` with its `emits`, so the `emits: [ANVIL_ALERT_FRAME]` declaration
 * below is load-bearing: without it the ledger works, these tests pass, and
 * every alert is discarded one process upstream of the user.
 *
 * WHAT IS STILL MISSING: nothing renders `anvil_receipt_alert`. The frame now
 * reaches the renderer's response stream and no surface reads it, so a
 * contradicted receipt is delivered and then ignored. That is the remaining
 * step for this capability, and it is a renderer change, not one in this file.
 *
 * WHY IT EXISTS. A tampered, replayed, conflicting or version-mismatched
 * receipt currently vanishes without so much as a console warning - the exact
 * failure a tamper-evident log exists to prevent. The value here is entirely in
 * the failure path: this module produces nothing for a healthy receipt, and
 * turns a verdict the host cannot trust into a frame a host can surface.
 *
 * WHAT THIS CANNOT DO, stated plainly so nobody builds on a false promise.
 * The contract does not publish the recipe for `receipt_body_digest` /
 * `invalidation_body_digest`. It was brute-forced against the fixture corpus
 * (RFC-8785-style canonical JSON minus the digest field; every subset of the
 * remaining keys; sorted vs insertion order; compact vs spaced separators;
 * trailing newline; 13 domain-separation prefixes; key=value line encodings) and
 * none reproduce the published values. So this host CANNOT recompute the
 * engine's digest and must never claim to. What it does instead is keep its own
 * canonical hash and a `declaredDigest -> hostHash` binding table: a digest that
 * is ever seen vouching for two different bodies is a contradiction the host CAN
 * prove. That catches an altered body on the SECOND sighting of a digest, not
 * the first. Wording shown to a user must not imply otherwise.
 *
 * SCOPE. `capabilities.anvil_receipts` is `publication_bound`, not `available`:
 * a receipt binds artifact state AT PUBLICATION ONLY. A later filesystem
 * mutation produces no invalidation event - the engine does not watch the
 * artifact over the receipt's lifetime. Nothing here may suggest ongoing
 * monitoring.
 *
 * The ledger is pure and lives in this module so the fixture tests drive the
 * same function production would, rather than a copy that keeps passing after
 * the real one changes.
 */

import { createHash } from 'node:crypto';

import type { CapabilityContext, CapabilityHandler } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Protocol types
//
// Derived field-by-field from `schema/core-event.schema.json` in the vendored
// contract bundle. Both branches set `additionalProperties: true`, so the wire
// may legitimately carry fields not listed here; the ledger hashes the whole
// body and interprets only what is declared.
// ─────────────────────────────────────────────────────────────────────────────

/** Subcontract `anvil_receipts` v1.0 (manifest.json -> subcontracts). */
export type AnvilReceiptEvent = {
  type: 'anvil_receipt';
  // The schema's `required` array holds 12 entries, `type` among them.
  receipt_id: string;
  event_id: string;
  origin: 'core/anvil';
  contract_version: string;
  session_id: string;
  run_id: string;
  task_id: string;
  sequence: number;
  artifact_digest: string;
  gate_closure_digest: string;
  receipt_body_digest: string;
  // Declared in `properties`, absent from `required`.
  artifact_scope?: string;
  checks_passed?: number;
  checks_total?: number;
  cost_microcents?: number;
  coverage?: string;
  digest_algorithm?: 'sha256';
  engine_version?: string;
  issued_at_unix_ms?: number;
  iterations?: number;
  priced?: boolean;
  stamp?: string;
  supersedes_receipt_id?: string;
  /**
   * The schema pins this to the const 'verified'. Any other value is a schema
   * violation, which is how `adversarial/anvil/altered-body.jsonl`
   * (terminal_state: 'tampered') is caught - measured against the bundle's own
   * schema with ajv, not assumed.
   */
  terminal_state?: 'verified';
  valve_fires?: number;
  /**
   * NOT in the schema's `properties` block. It exists in exactly one file in
   * the whole bundle - adversarial/anvil/unknown-critical-extension.jsonl - and
   * validates only because `additionalProperties` is true. A non-empty value
   * names an extension the receipt REQUIRES its reader to implement. This host
   * implements none, so any entry means reject.
   */
  required_extensions?: string[];
};

export type AnvilInvalidationReason = 'artifact_mutated' | 'gate_revoked' | 'superseded';

export type AnvilReceiptInvalidatedEvent = {
  type: 'anvil_receipt_invalidated';
  // The schema's `required` array holds 12 entries, `type` among them - the
  // same count as the receipt branch, over a different field set.
  receipt_id: string;
  event_id: string;
  origin: 'core/anvil';
  contract_version: string;
  session_id: string;
  run_id: string;
  task_id: string;
  sequence: number;
  reason: AnvilInvalidationReason;
  prior_artifact_digest: string;
  invalidation_body_digest: string;
  // Declared in `properties`, absent from `required`.
  issued_at_unix_ms?: number;
  observed_artifact_digest?: string;
  /** Same story as on the receipt: undeclared, and a reason to refuse. */
  required_extensions?: string[];
};

/** The two event types this capability owns, exactly as they appear on the wire. */
export const ANVIL_EVENT_TYPES = ['anvil_receipt', 'anvil_receipt_invalidated'] as const;

/**
 * The stream frame this capability produces for a verdict a host cannot trust.
 * A structured payload rather than a sentence: the main process has no renderer
 * i18n, and inventing an English string here would hard-code user-facing text
 * in the wrong process. Whichever layer consumes the frame decides presentation.
 */
export const ANVIL_ALERT_FRAME = 'anvil_receipt_alert';

export type AnvilAlertPayload = {
  receiptId: string;
  sequence: number;
  outcome: AnvilOutcome;
  code: AnvilRejectCode | null;
  reason?: string;
  artifactDigest?: string;
  detail?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts
// ─────────────────────────────────────────────────────────────────────────────

export type AnvilOutcome = 'accepted' | 'accepted_duplicate' | 'invalidated' | 'rejected';

export type AnvilRejectCode =
  | 'malformed'
  | 'version_mismatch'
  | 'unknown_critical_extension'
  | 'sequence_gap'
  | 'sequence_conflict'
  | 'stale_replay'
  | 'body_conflict'
  | 'invalidation_unlinked';

export type AnvilVerdict = {
  outcome: AnvilOutcome;
  code: AnvilRejectCode | null;
  receiptId: string;
  sequence: number;
  detail?: string;
};

/** What the ledger currently believes about one receipt id. */
export type AnvilReceiptStatus = 'unknown' | 'accepted' | 'invalidated' | 'quarantined';

export type AnvilLedger = {
  admit(event: Record<string, unknown>): AnvilVerdict;
  /** Exposed so tests can prove a revoked verdict is never restored. */
  receiptStatus(sessionId: string, receiptId: string): AnvilReceiptStatus;
  /** True once a sequence gap proved the host missed an event it cannot recover. */
  sessionIncomplete(sessionId: string): boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * manifest.json -> subcontracts.anvil_receipts is "1.0". A major bump may
 * redefine what the fields mean, and interpreting a v2 receipt with v1 rules
 * would be asserting a verdict this host cannot actually check. Fail closed.
 */
const SUBCONTRACT_MAJOR = 1;

/**
 * INFERRED, not stated by the contract: the valid fixtures start at sequence 0
 * and `sequence-gap.jsonl` is the fixture that starts at 1. If the engine ever
 * opens a session at a non-zero anvil sequence (a resume, say), this ledger
 * will call it a gap and refuse a legitimate receipt. That is the conservative
 * direction - a false alert beats a silently incomplete audit log - but it is a
 * guess, and only the wayland-core binary settles it.
 */
const FIRST_SEQUENCE = 0;

/** From the schema's `required` arrays, minus `type` and `sequence`. */
const RECEIPT_REQUIRED_STRINGS = [
  'receipt_id',
  'event_id',
  'origin',
  'contract_version',
  'session_id',
  'run_id',
  'task_id',
  'artifact_digest',
  'gate_closure_digest',
  'receipt_body_digest',
] as const;

const INVALIDATION_REQUIRED_STRINGS = [
  'receipt_id',
  'event_id',
  'origin',
  'contract_version',
  'session_id',
  'run_id',
  'task_id',
  'reason',
  'prior_artifact_digest',
  'invalidation_body_digest',
] as const;

/** Declared `type: integer` in the schema. Present-but-wrong-type is malformed. */
const OPTIONAL_INTEGER_FIELDS = [
  'checks_passed',
  'checks_total',
  'cost_microcents',
  'issued_at_unix_ms',
  'iterations',
  'valve_fires',
] as const;

/** Declared `type: string` in the schema. */
const OPTIONAL_STRING_FIELDS = [
  'artifact_scope',
  'coverage',
  'engine_version',
  'stamp',
  'supersedes_receipt_id',
  'observed_artifact_digest',
] as const;

const INVALIDATION_REASONS: ReadonlySet<string> = new Set(['artifact_mutated', 'gate_revoked', 'superseded']);

// ─────────────────────────────────────────────────────────────────────────────
// Host canonical hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable serialisation of a decoded JSON value: keys sorted, no whitespace.
 *
 * This only has to be stable within one host process - it is NOT an attempt to
 * reproduce the engine's digest recipe (see the module header). Deliberately
 * simple for that reason: no float normalisation, because every numeric field
 * in the anvil branch is declared `integer`.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The host's own hash over the body, excluding the field that carries the
 * engine's declared digest - a digest cannot cover itself.
 */
function hostBodyHash(event: Record<string, unknown>, digestField: string): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === digestField) continue;
    body[key] = value;
  }
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 20)}…` : digest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable failure, or null when the event matches the schema
 * branch closely enough to reason about.
 *
 * This repeats what the published JSON Schema says on purpose. The schema is a
 * test-time artifact; nothing validates the live wire against it at runtime, and
 * a safety-class event is the last place to trust an unchecked shape.
 */
function shapeFailure(event: Record<string, unknown>): string | null {
  const type = event.type;
  if (type !== 'anvil_receipt' && type !== 'anvil_receipt_invalidated') {
    return `type "${String(type)}" is not an anvil event`;
  }

  const required = type === 'anvil_receipt' ? RECEIPT_REQUIRED_STRINGS : INVALIDATION_REQUIRED_STRINGS;
  for (const field of required) {
    const value = event[field];
    if (typeof value !== 'string' || value.length === 0) {
      return `required field "${field}" is missing or not a non-empty string`;
    }
  }

  // `origin` is a schema const. A receipt that did not come from core/anvil has
  // no authority to publish a verdict, whatever else it says.
  if (event.origin !== 'core/anvil') return `origin "${String(event.origin)}" is not core/anvil`;

  const sequence = event.sequence;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) return 'sequence is not an integer';
  // The schema declares `integer` with no minimum. A negative value is nonsense
  // for a monotonic correlation counter, and admitting one would corrupt every
  // ordering rule below it. Fail closed rather than guess an intent.
  if (sequence < 0) return `sequence ${sequence} is negative`;

  // Checked for BOTH branches, deliberately. This field is not in either
  // schema's `properties` block; it rides in only because both set
  // additionalProperties: true. The reject rule in `admit` fires on
  // `Array.isArray(x) && x.length > 0`, so a NON-array value would slip past it
  // silently - an event could demand a reader extension in a shape the reject
  // rule cannot see, and be admitted. Gating the shape here closes that for the
  // invalidation branch as well as the receipt branch.
  const extensions = event.required_extensions;
  if (extensions !== undefined && (!Array.isArray(extensions) || extensions.some((e) => typeof e !== 'string'))) {
    return 'required_extensions is not an array of strings';
  }

  if (type === 'anvil_receipt') {
    // Schema const 'verified'. This is what catches altered-body.jsonl.
    if (event.terminal_state !== undefined && event.terminal_state !== 'verified') {
      return `terminal_state "${String(event.terminal_state)}" is not the schema const "verified"`;
    }
    if (event.digest_algorithm !== undefined && event.digest_algorithm !== 'sha256') {
      return `digest_algorithm "${String(event.digest_algorithm)}" is not the schema const "sha256"`;
    }
    if (event.priced !== undefined && typeof event.priced !== 'boolean') return 'priced is not a boolean';
  } else if (!INVALIDATION_REASONS.has(event.reason as string)) {
    return `reason "${String(event.reason)}" is outside the schema enum`;
  }

  for (const field of OPTIONAL_INTEGER_FIELDS) {
    const value = event[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value))) {
      return `"${field}" is present but not an integer`;
    }
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = event[field];
    if (value !== undefined && typeof value !== 'string') return `"${field}" is present but not a string`;
  }

  return null;
}

/**
 * The only contract_version shape this host recognises: `MAJOR.MINOR`, both
 * components plain non-negative integers, no leading zeros.
 *
 * Every `contract_version` in the vendored bundle is "1.0" or "2.0", and every
 * value in manifest.json -> subcontracts is two dot-separated integers. That is
 * the whole observed universe, so it is the whole accepted universe.
 */
const CONTRACT_VERSION_FORM = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * The MAJOR component of a contract version, or -1 when the string is not in
 * the form above. -1 can never be a real major, so an unrecognised version
 * always lands on the version_mismatch branch.
 *
 * This VALIDATES rather than parses, which is the point. `Number.parseInt` is
 * lenient by design - it reads the longest numeric prefix and throws the rest
 * away - so the previous implementation mapped '1x2', '1-2', '1..0', '01.0',
 * '+1.0' and '1e0' all onto major 1, i.e. it read six malformed version strings
 * as the v1 it knows and asserted verdicts over them.
 *
 * A three-component '1.0.1' is refused too. That is a deliberate choice, not an
 * oversight: the contract has never published such a string, and a version
 * whose shape this host has never seen is exactly the case where guessing the
 * major would assert a verdict it cannot back. Refusing surfaces a
 * version_mismatch an operator can act on; guessing would silently accept.
 */
function majorOf(contractVersion: string): number {
  const match = CONTRACT_VERSION_FORM.exec(contractVersion);
  return match ? Number(match[1]) : -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

type AdmittedSlot = {
  type: string;
  receiptId: string;
  eventId: string;
  declaredDigest: string;
  hostHash: string;
};

type ReceiptRecord = {
  status: Exclude<AnvilReceiptStatus, 'unknown'>;
  artifactDigest: string;
};

type SessionLedger = {
  /** -1 until the session admits its first anvil event. */
  lastAdmitted: number;
  incomplete: boolean;
  /**
   * Admitted slots indexed by sequence.
   *
   * An array rather than a map on purpose. Entries are only ever appended, and
   * only at `lastAdmitted + 1`, so `admitted.length === lastAdmitted + 1` holds
   * and every sequence in 0..lastAdmitted has an entry. That makes "an admitted
   * sequence with no recorded slot" unrepresentable instead of a defensive
   * branch no test could ever reach.
   */
  admitted: AdmittedSlot[];
  receipts: Map<string, ReceiptRecord>;
};

/**
 * A contested verdict is no longer trustworthy.
 *
 * Only ever downgrades a live receipt: an already-invalidated one stays
 * invalidated, because "the engine retracted this" is a stronger and more
 * useful statement than "the host stopped trusting it".
 */
function quarantine(session: SessionLedger, receiptId: string): void {
  const record = session.receipts.get(receiptId);
  if (record?.status === 'accepted') record.status = 'quarantined';
}

/**
 * Build a receipt ledger.
 *
 * In-memory by design. The binding table that makes tamper detection work is
 * exactly the state the contract's deferred `anvil_desktop_replay_reducer`
 * would persist; persisting it here would be a design decision the contract
 * does not authorise. The honest consequence: after an app restart a replayed
 * receipt is indistinguishable from a first sighting.
 */
export function createAnvilLedger(): AnvilLedger {
  const sessions = new Map<string, SessionLedger>();
  /**
   * declaredDigest -> hostHash, global across sessions. Only written for events
   * the ledger actually admitted, so a rejected event cannot poison it.
   */
  const bindings = new Map<string, string>();

  const sessionFor = (sessionId: string): SessionLedger => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { lastAdmitted: -1, incomplete: false, admitted: [], receipts: new Map() };
      sessions.set(sessionId, session);
    }
    return session;
  };

  const admit = (event: Record<string, unknown>): AnvilVerdict => {
    const receiptId = typeof event.receipt_id === 'string' ? event.receipt_id : '';
    const sequence = typeof event.sequence === 'number' && Number.isInteger(event.sequence) ? event.sequence : -1;
    const reject = (code: AnvilRejectCode, detail: string): AnvilVerdict => ({
      outcome: 'rejected',
      code,
      receiptId,
      sequence,
      detail,
    });

    // (1) SHAPE.
    const shape = shapeFailure(event);
    if (shape) return reject('malformed', shape);

    const type = event.type as 'anvil_receipt' | 'anvil_receipt_invalidated';
    const sessionId = event.session_id as string;
    const eventId = event.event_id as string;
    const contractVersion = event.contract_version as string;
    const isReceipt = type === 'anvil_receipt';

    // (2) VERSION. Checked before anything touches session state, so a receipt
    // this host cannot interpret never advances the sequence counter.
    const major = majorOf(contractVersion);
    if (major !== SUBCONTRACT_MAJOR) {
      return reject(
        'version_mismatch',
        `contract_version "${contractVersion}" against subcontract ${SUBCONTRACT_MAJOR}.x`
      );
    }

    // (3) UNKNOWN-CRITICAL EXTENSION. The field names extensions the event
    // REQUIRES its reader to implement; this host implements none, so accepting
    // would mean showing "verified" for rules the host does not know. Applies
    // to both branches - an invalidation demanding an extension is no more
    // readable than a receipt doing so.
    //
    // `Array.isArray` here is the type narrowing that gives `.join` a string[],
    // not a second shape check: `shapeFailure` has already refused any
    // `required_extensions` that is not an array of strings.
    const extensions = event.required_extensions;
    if (Array.isArray(extensions) && extensions.length > 0) {
      return reject(
        'unknown_critical_extension',
        `requires ${extensions.join(', ')}; this host implements no anvil extensions`
      );
    }

    const session = sessionFor(sessionId);
    const digestField = isReceipt ? 'receipt_body_digest' : 'invalidation_body_digest';
    const declaredDigest = event[digestField] as string;
    const hostHash = hostBodyHash(event, digestField);

    // (4) IRREVERSIBILITY. Once retracted or contested, a verdict is never
    // restored. `stale-replay.jsonl` replays line 1 byte-for-byte after the
    // invalidation; a last-write-wins reducer would quietly resurrect a revoked
    // receipt, and the user would be told a gate closed over bytes the engine
    // had already disowned.
    //
    // Ordered ahead of the binding and sequence rules deliberately. Both of
    // those would also reject a replayed dead receipt, so this rule does not
    // change WHETHER it is refused - it decides what the user is told. "This
    // receipt was already retracted" is actionable; "digest conflict" sends
    // them looking for tampering that did not happen.
    if (isReceipt) {
      const prior = session.receipts.get(receiptId);
      if (prior && prior.status !== 'accepted') {
        return reject('stale_replay', `receipt is already ${prior.status}; a retracted verdict is never restored`);
      }
    }

    // (5) BINDING TABLE. A digest is a commitment to one body. Seeing it vouch
    // for a second, different body is a contradiction the host can prove
    // without knowing the engine's digest recipe - and it is the ONLY mechanism
    // that catches `altered-invalidation-body.jsonl`, whose sole change
    // (reason artifact_mutated -> gate_revoked) leaves it schema-valid.
    // Checked ahead of the ordering rules because it is a content invariant,
    // not a sequencing one.
    const bound = bindings.get(declaredDigest);
    if (bound !== undefined && bound !== hostHash) {
      quarantine(session, receiptId);
      return reject('body_conflict', `digest ${shortDigest(declaredDigest)} is already bound to a different body`);
    }

    // (6) SEQUENCE, keyed by session_id per manifest `correlation:
    // session_id_and_sequence`, one counter shared by both event types.
    // (The corpus cannot distinguish per-session from per-run or per-task
    // numbering - every fixture uses one session, one run and one task - so the
    // manifest is the only authority available.)
    const expectedNext = session.lastAdmitted + 1;
    if (sequence > expectedNext) {
      // Fail closed and remember it: a missing predecessor means later
      // invalidations may point at receipts this host never saw, so the ledger
      // is no longer provably continuous.
      session.incomplete = true;
      return reject(
        'sequence_gap',
        `expected sequence ${session.lastAdmitted < 0 ? FIRST_SEQUENCE : expectedNext}, got ${sequence}`
      );
    }
    if (sequence <= session.lastAdmitted) {
      // ANY already-admitted sequence, not only the newest one.
      //
      // This used to split: `sequence === lastAdmitted` consulted the recorded
      // slot and tolerated an identical repeat, while `sequence < lastAdmitted`
      // went straight to `stale_replay`. An at-least-once transport that
      // redelivers a BATCH - the ordinary case after a reconnect - therefore
      // got one quiet duplicate and a tamper alert for every older event in the
      // same batch, all of them byte-identical to what the ledger already held.
      // Those alerts were false, and false alerts on a safety-class readout are
      // how a real one gets ignored. The slot comparison below is what decides;
      // how old the sequence is decides nothing on its own.
      //
      // A genuinely stale replay is still caught, just by the rule that
      // actually knows: a retracted receipt is refused at (4) above, before the
      // sequence rules run at all.
      const slot = session.admitted[sequence];

      // Same correlation key AND same identity: a retransmission. Rejecting it
      // would turn any reconnecting at-least-once transport into a stream of
      // false tamper alerts, so an identical repeat is tolerated - and changes
      // nothing, which is the part that matters.
      const sameIdentity = slot.type === type && slot.receiptId === receiptId && slot.eventId === eventId;
      if (!sameIdentity) {
        quarantine(session, receiptId);
        return reject(
          'sequence_conflict',
          `sequence ${sequence} already carries ${slot.type} ${slot.receiptId}/${slot.eventId}`
        );
      }
      if (slot.declaredDigest === declaredDigest && slot.hostHash === hostHash) {
        return { outcome: 'accepted_duplicate', code: null, receiptId, sequence, detail: 'identical retransmission' };
      }
      quarantine(session, receiptId);
      return reject('body_conflict', `sequence ${sequence} was republished with a different body`);
    }

    // sequence === expectedNext from here on.
    if (isReceipt) {
      // A receipt id is published once. Reaching here with an existing record
      // means the id carries a second, different verdict at a later sequence.
      // No fixture exercises supersession (`supersedes_receipt_id` and
      // `reason: 'superseded'` appear in no fixture in the bundle), and a
      // superseding receipt is expected to arrive under its OWN id, so refusing
      // a re-publication does not block that path.
      const prior = session.receipts.get(receiptId);
      if (prior) {
        quarantine(session, receiptId);
        return reject('body_conflict', `receipt ${receiptId} was already published in this session`);
      }
      session.receipts.set(receiptId, { status: 'accepted', artifactDigest: event.artifact_digest as string });
    } else {
      // (7) INVALIDATION LINKAGE. A retraction must name a receipt this host
      // actually admitted and agree with it about what was published; anything
      // else is a retraction of something the host never saw, which is a claim
      // it cannot check.
      const target = session.receipts.get(receiptId);
      if (!target) return reject('invalidation_unlinked', `no receipt ${receiptId} admitted in this session`);
      if (target.artifactDigest !== (event.prior_artifact_digest as string)) {
        return reject(
          'invalidation_unlinked',
          `prior_artifact_digest ${shortDigest(event.prior_artifact_digest as string)} does not match the published ${shortDigest(target.artifactDigest)}`
        );
      }
      if (target.status !== 'accepted') {
        return reject('stale_replay', `receipt is already ${target.status}; there is no live verdict to retract`);
      }
      target.status = 'invalidated';
    }

    // `push` lands at index `admitted.length`, which is `lastAdmitted + 1`, which
    // is `sequence` on every path that reaches here - the invariant the
    // `admitted` array's indexing relies on.
    session.admitted.push({ type, receiptId, eventId, declaredDigest, hostHash });
    session.lastAdmitted = sequence;
    bindings.set(declaredDigest, hostHash);

    return isReceipt
      ? { outcome: 'accepted', code: null, receiptId, sequence }
      : { outcome: 'invalidated', code: null, receiptId, sequence, detail: `reason ${String(event.reason)}` };
  };

  return {
    admit,
    receiptStatus: (sessionId, receiptId) => sessions.get(sessionId)?.receipts.get(receiptId)?.status ?? 'unknown',
    sessionIncomplete: (sessionId) => sessions.get(sessionId)?.incomplete ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the capability over a ledger.
 *
 * The factory exists so tests get a fresh ledger per case without a
 * reset-for-tests back door in production code, and so the dispatcher's
 * containment guarantee can be exercised with a ledger that throws.
 */
export function createAnvilReceiptsCapability(ledger: AnvilLedger = createAnvilLedger()): CapabilityHandler {
  return {
    name: 'anvil_receipts',
    handles: ANVIL_EVENT_TYPES,
    // Projection frame: folded from the wire events above, so it must be
    // declared or WCoreManager drops it at the msg_id guard.
    emits: [ANVIL_ALERT_FRAME],

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      const verdict = ledger.admit(event);

      if (verdict.outcome === 'accepted' || verdict.outcome === 'accepted_duplicate') {
        // Nothing is surfaced for a healthy receipt. The engine grades this
        // capability `publication_bound`, so a receipt proves what was true at
        // publication and nothing since - surfacing it as a standing guarantee
        // would overstate what the engine measured.
        ctx.log(`receipt ${verdict.receiptId} seq ${verdict.sequence}: ${verdict.outcome}`, verdict.detail);
        return true;
      }

      const label = verdict.code ?? verdict.outcome;
      ctx.warn(
        `receipt ${verdict.receiptId || '<unnamed>'} seq ${verdict.sequence}: ${label}${verdict.detail ? ` (${verdict.detail})` : ''}`,
        event
      );

      const artifactDigest =
        typeof event.artifact_digest === 'string'
          ? event.artifact_digest
          : typeof event.prior_artifact_digest === 'string'
            ? event.prior_artifact_digest
            : undefined;
      const payload: AnvilAlertPayload = {
        receiptId: verdict.receiptId,
        sequence: verdict.sequence,
        outcome: verdict.outcome,
        code: verdict.code,
        reason: typeof event.reason === 'string' ? event.reason : undefined,
        artifactDigest,
        detail: verdict.detail,
      };
      // msg_id '' matches how `sub_agent_event`, `session_cost` and
      // `mcp_failed` already travel in `../index.ts`: system-level frames that
      // belong to the session, not to whichever turn happened to be in flight.
      ctx.emit({ type: ANVIL_ALERT_FRAME, data: payload, msg_id: '' });
      return true;
    },
  };
}

/**
 * A ready-to-register instance, sharing one ledger across the process.
 *
 * NOT registered today - see the WIRING STATUS note at the top of this file.
 * Adding it to `HANDLERS` in `./index.ts` is what makes it live.
 *
 * `handle` always answers `true`, including for every rejection. Returning
 * `false` would hand the event back to the dispatcher's caller as unhandled,
 * which for these two type names means the acknowledged-unhandled path - so a
 * safety-class event would be dropped as silently as it is dropped today.
 */
export const anvilReceiptsCapability: CapabilityHandler = createAnvilReceiptsCapability();
