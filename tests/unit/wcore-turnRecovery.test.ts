/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turn recovery, driven through the real contract fixtures.
 *
 * All four recovery events and all three recovery commands are graded
 * `criticality: "safety"` in `manifest.json` - the same grade as
 * `execution_policy`, and the highest the contract hands out. The five
 * `adversarial/recovery/` fixtures declare INPUT only: nothing in the bundle
 * states the verdict a host owes any of them. So every test below states the
 * verdict AND the evidence: the manifest's `criticality`/`correlation`, the JSON
 * Schema, or the shape of the fixture itself. The filename is never the
 * justification - `valid-replay` is only "valid" because its `from` digest
 * matches the snapshot's cursor digest, and that is asserted, not assumed.
 *
 * Routing goes through `createDispatcher`, the same function production builds
 * its dispatcher from, over a handler list this file supplies. What these tests
 * prove is the reducer, the builders and the handler; that the capability is
 * reached in the running app is a registration step outside this file.
 *
 * The `counter-tests` block is the answer to "green but asserting nothing": it
 * builds two DELIBERATELY WEAKENED reducers and shows each one sails past the
 * fixture its weakness targets while still passing `valid-replay`. Without that,
 * a fixture expectation only proves the fixture was read.
 *
 * ON THE HEADLINE COUNT. A dozen or so tests here assert facts about the
 * VENDORED BUNDLE and would stay green if `turnRecovery.ts` were deleted: every
 * test in "the engine example payloads" and in "what schema validation alone
 * settles", the correlation/criticality gate, the approval_id producer search,
 * and the fixture inventory. They are deliberate contract-drift gates - the
 * rules below are argued FROM these facts, so a bump that moves `correlation`
 * off the cursor has to fail loudly rather than be inherited - and each says so
 * where it stands. They are not coverage of the implementation, and the total
 * test count should not be offered as if they were.
 *
 * WHY ALMOST EVERY TEST ASKS FIRST. Rule 3 refuses any `session_recovery_*`
 * whose `request_id` this host did not mint, with no "we have not asked yet"
 * escape. The engine's own fixtures all carry `recovery-request-001`, an id this
 * host never minted, so a test that feeds one straight in is testing the refusal
 * and nothing else. {@link arm} makes the ask through the real gate and
 * {@link answering} rewrites the fixture's placeholder id to the one that was
 * actually minted - the substitution is the ONLY change made to any fixture, and
 * `PLACEHOLDER_REQUEST_IDS` below pins what is being substituted so a bundle
 * that stops using placeholders cannot be silently rewritten.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  buildResolveInterruptedApproval,
  buildResumeTurn,
  buildSessionResync,
  createTurnRecoveryCapability,
  JOURNAL_DIGEST_PATTERN,
  MAX_CANONICAL_DEPTH,
  MAX_DETAIL_VALUE_LENGTH,
  MAX_OUTSTANDING_RESYNCS,
  MAX_REFUSED_SESSIONS,
  MAX_REPLAY_ITEMS,
  MAX_TRACKED_SESSIONS,
  MAX_TRACKED_TURNS,
  MAX_WIRE_ID_LENGTH,
  RECOVERY_EVENT_TYPES,
  RECOVERY_VERSION,
  SessionRecoveryTracker,
  TURN_RECOVERY_CAPABILITY,
  TURN_RECOVERY_SUBCONTRACT_VERSION,
  turnRecoveryCapability,
} from '@process/agent/wcore/capabilities/handlers/turnRecovery';
import type {
  RecoveryVerdict,
  TurnRecoveryCapability,
  TurnRecoveryFrame,
  WCoreJournalCursor,
} from '@process/agent/wcore/capabilities/handlers/turnRecovery';
import {
  adversarialFixtures,
  CONTRACT_V1,
  entryFor,
  examplePayload,
  readFixture,
  readManifest,
  surfaceOf,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

/** Digests as they appear in the fixtures, so assertions read like the wire. */
const D4 = '4'.repeat(64);
const D5 = '5'.repeat(64);
const D6 = '6'.repeat(64);
const DA = 'a'.repeat(64);
const DF = 'f'.repeat(64);

type SentCommand = { type: string } & Record<string, unknown>;

type Recorder = CapabilityContext & {
  frames: { type: string; data: TurnRecoveryFrame; msg_id: string }[];
  commands: SentCommand[];
  logs: string[];
  warns: string[];
};

function makeContext(): Recorder {
  const frames: Recorder['frames'] = [];
  const commands: SentCommand[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    frames,
    commands,
    logs,
    warns,
    sendCommand: (command) => commands.push(command as SentCommand),
    emit: (f) => frames.push(f as Recorder['frames'][number]),
    activeMsgId: () => 'msg-in-flight',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

/** The session every recovery fixture and example in the bundle is filed under. */
const SESSION = 'session-desktop-001';

/**
 * The `request_id`s the bundle ships. None of them was minted by this host, so
 * every one of them is `rejected_unsolicited` on arrival - which is the point of
 * the rule and the reason {@link answering} exists. Pinned here so a bundle that
 * starts shipping something else fails loudly instead of being rewritten
 * silently by the substitution.
 */
const PLACEHOLDER_REQUEST_IDS = ['recovery-request-001', 'recovery-request-003'];

/**
 * Ask through the real gate, and return the `request_id` the host minted.
 *
 * The ask goes through `seedFromReady` + `beginResync` - the production path,
 * gate included - so a test that arms itself has also proved the gate opens for
 * the engine it is pretending to be. The ask is made on a THROWAWAY recorder so
 * the caller's own `ctx` still starts with no commands, no logs and no warns.
 */
function arm(cap: TurnRecoveryCapability, sessionId: string = SESSION, ctx: Recorder = makeContext()): string {
  cap.seedFromReady({ ...examplePayload('event', 'ready'), session_id: sessionId }, ctx);
  const asked = cap.beginResync(ctx, sessionId);
  if (asked.ok === false) throw new Error(`arm(${sessionId}) could not ask: ${asked.reason}`);
  return asked.requestId;
}

/** A bare tracker with one ask on its ledger, for reducer-level tests. */
function armedTracker(sessionId: string = SESSION, requestId = 'recovery-request-001'): SessionRecoveryTracker {
  const tracker = new SessionRecoveryTracker(sessionId);
  tracker.noteResyncRequest(requestId);
  return tracker;
}

/**
 * The engine's message, quoting the id this host actually minted.
 *
 * The ONLY field ever changed on a fixture, and only when the fixture has one -
 * `turn_recovery_lifecycle` carries no `request_id` and is passed through
 * untouched.
 */
function answering(message: Record<string, unknown>, requestId: string): Record<string, unknown> {
  if (message.request_id === undefined) return message;
  expect(PLACEHOLDER_REQUEST_IDS, 'a fixture request_id changed; the substitution below would hide it').toContain(
    message.request_id
  );
  return { ...message, request_id: requestId };
}

type Replayed = { ctx: Recorder; cap: TurnRecoveryCapability; verdicts: RecoveryVerdict[] };

/**
 * Replay a fixture through the real dispatcher, reading each verdict from the
 * TRACKER rather than from whatever frame happened to be last.
 *
 * The handler stays deliberately quiet on `ignored_duplicate` and announces the
 * pending turn only once, so a helper that inferred verdicts from emitted frames
 * would credit one message's silence to another message's verdict - a sequence
 * that never happened. A bare tracker gives the verdict of the message that
 * caused it, and the dispatcher run beside it proves the handler consumed the
 * same message.
 */
function replay(relPath: string): Replayed {
  const cap = createTurnRecoveryCapability();
  const dispatch = createDispatcher([cap]);
  const ctx = makeContext();
  const verdicts: RecoveryVerdict[] = [];
  const trackers = new Map<string, SessionRecoveryTracker>();
  const requestId = arm(cap);

  for (const raw of readFixture(relPath)) {
    const message = answering(raw, requestId);
    const sessionId = String(message.session_id);
    let mirror = trackers.get(sessionId);
    if (!mirror) {
      mirror = armedTracker(sessionId, requestId);
      trackers.set(sessionId, mirror);
    }
    verdicts.push(mirror.accept(message).verdict);
    expect(dispatch(message, ctx), `${relPath}: dispatcher did not consume ${String(message.type)}`).toBe(true);
  }

  return { ctx, cap, verdicts };
}

/** An unmodelled sub-object `levels` deep, for the canonical-depth bound. */
const nest = (levels: number): unknown => (levels === 0 ? 'leaf' : { deeper: nest(levels - 1) });

/** Every `journal_digest` pattern the published schemas declare. */
function cursorDigestPatterns(schemaFile: string): string[] {
  const raw: unknown = JSON.parse(readFileSync(join(CONTRACT_V1, 'schema', schemaFile), 'utf-8'));
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const props = record.properties;
    if (props !== null && typeof props === 'object') {
      const digest = (props as Record<string, unknown>).journal_digest;
      if (digest !== null && typeof digest === 'object') {
        const pattern = (digest as Record<string, unknown>).pattern;
        if (typeof pattern === 'string') found.push(pattern);
      }
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(raw);
  return found;
}

/**
 * Where the module's constants meet the vendored bundle.
 *
 * Half of this block compares an exported constant against the contract (a
 * transcription gate); the other half - flagged on the tests themselves - reads
 * only the bundle and is a DRIFT GATE, not coverage: it would stay green if
 * `turnRecovery.ts` were deleted. Both belong here because every rule further
 * down is argued from these facts.
 */
describe('the contract bundle these rules are argued from', () => {
  /**
   * A contract bump that files a fifth verb under `turn_recovery_v1` fails here
   * instead of shipping as an unimplemented verb nobody noticed.
   */
  it('claims exactly the events the manifest files under turn_recovery_v1', () => {
    const surface = surfaceOf(TURN_RECOVERY_CAPABILITY);
    expect(surface.events.map((e) => e.type).toSorted()).toEqual([...RECOVERY_EVENT_TYPES].toSorted());
    expect(surface.commands.map((c) => c.type).toSorted()).toEqual([
      'resolve_interrupted_approval',
      'resume_turn',
      'session_resync',
    ]);
    expect([...turnRecoveryCapability.handles].toSorted()).toEqual([...RECOVERY_EVENT_TYPES].toSorted());
  });

  /**
   * DRIFT GATE - reads the bundle only, and is not coverage of the module.
   *
   * The grading the rules below are argued from. If an engine bump downgrades
   * `criticality` or moves `correlation` off the cursor, the case for refusing a
   * conflicting snapshot or a mis-stitched replay evaporates and has to be
   * re-derived rather than inherited.
   */
  it('is still safety-class, and still correlates the snapshot and replay on the cursor', () => {
    for (const type of RECOVERY_EVENT_TYPES) {
      expect(entryFor('event', type)?.criticality, type).toBe('safety');
    }
    expect(entryFor('event', 'session_recovery_snapshot')?.correlation).toBe('request_id_and_cursor');
    expect(entryFor('event', 'session_recovery_replay')?.correlation).toBe('request_id_and_cursor');
    expect(entryFor('event', 'session_recovery_unavailable')?.correlation).toBe('request_id_and_session_id');
    expect(entryFor('event', 'turn_recovery_lifecycle')?.correlation).toBe('turn_id_and_cursor');
    expect(entryFor('command', 'session_resync')?.correlation).toBe('request_id_and_session_id');
    expect(entryFor('command', 'resume_turn')?.correlation).toBe('request_id_and_cursor');
    expect(entryFor('command', 'resolve_interrupted_approval')?.correlation).toBe('request_id_cursor_and_approval_id');
  });

  it('is graded available, at the subcontract version this host implements', () => {
    expect(readManifest().capabilities.turn_recovery_v1).toBe('available');
    expect(readManifest().subcontracts.turn_recovery).toBe(TURN_RECOVERY_SUBCONTRACT_VERSION);
  });

  /**
   * `src/` cannot read `tests/fixtures/` at runtime, so the digest pattern in
   * the module is a TRANSCRIPTION of the schema's, and transcriptions drift.
   * This is the gate: change either side and it goes red.
   */
  it('JOURNAL_DIGEST_PATTERN is the schema cursor pattern verbatim, in both directions', () => {
    const patterns = [
      ...cursorDigestPatterns('core-event.schema.json'),
      ...cursorDigestPatterns('host-command.schema.json'),
    ];
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(pattern).toBe(JOURNAL_DIGEST_PATTERN.source);
  });

  it('pins recovery_version to the const the schema declares', () => {
    for (const type of RECOVERY_EVENT_TYPES) {
      expect(examplePayload('event', type).recovery_version, type).toBe(RECOVERY_VERSION);
    }
  });
});

/**
 * DRIFT GATES - every test in this block reads the bundle only and would stay
 * green if `turnRecovery.ts` were deleted. They pin what the reducer's rules
 * assume about the shipped payloads; they do not exercise the reducer.
 */
describe('the engine example payloads', () => {
  it.each([...RECOVERY_EVENT_TYPES])('%s validates against the published event schema', (type) => {
    expect(validateEvent(examplePayload('event', type)).valid).toBe(true);
  });

  /**
   * Assignability is the half a schema check cannot do: it catches a TS member
   * that omits a required field or invents one the engine never sends.
   */
  it('the snapshot example carries every field the reducer reads', () => {
    const snapshot = examplePayload('event', 'session_recovery_snapshot');
    expect(snapshot.session_id).toBe('session-desktop-001');
    expect(snapshot.state_digest).toBe(DA);
    expect(snapshot.cursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(snapshot.lifecycle).toBe('reconciliation_required');
    expect(snapshot.pending_turn).toEqual({
      turn_id: 'turn-002',
      lifecycle: 'reconciliation_required',
      msg_id: 'msg-002',
      pending_call_id: 'call-tool-002',
      reconcile_reason: 'tool_outcome_unknown',
    });
    expect(snapshot.budget).toEqual({
      tokens_used: 12000,
      cost_used_usd: 1.25,
      token_limit: 20000,
      cost_limit_usd: 5.0,
    });
  });

  /** The one unsolicited event, and the whole reason it exists: no `request_id`. */
  it('turn_recovery_lifecycle carries no request_id', () => {
    const lifecycle = examplePayload('event', 'turn_recovery_lifecycle');
    expect(lifecycle.request_id).toBeUndefined();
    expect(lifecycle.turn_id).toBe('turn-002');
    expect(lifecycle.cursor).toEqual({ journal_digest: D6, journal_sequence: 42 });
  });
});

describe('the commands this host builds', () => {
  const cursor: WCoreJournalCursor = { journal_digest: D6, journal_sequence: 42 };

  /**
   * `host-command.schema.json` sets `additionalProperties: false` on all three
   * of these, so a stray field invalidates the whole message - which is the
   * whole point of running what the CODE builds through the real validator
   * rather than checking the engine's own example.
   */
  it('session_resync with an after cursor validates', () => {
    const built = buildSessionResync({
      sessionId: 'session-desktop-001',
      requestId: 'recovery-request-001',
      after: { journal_digest: D4, journal_sequence: 40 },
    });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(validateCommand(built.command).errors).toEqual([]);
    expect(built.command).toEqual(examplePayload('command', 'session_resync'));
  });

  /**
   * The genesis form. `compat/commands/session_resync.genesis.json` is the
   * published proof that omitting `after` entirely is legal, and "entirely" is
   * the load-bearing word: `after: undefined` would be an extra key under a
   * schema that forbids extras if it ever survived serialisation.
   */
  it('session_resync without an after cursor omits the key entirely', () => {
    const built = buildSessionResync({ sessionId: 'session-desktop-001', requestId: 'recovery-request-genesis' });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(Object.keys(built.command).toSorted()).toEqual(['recovery_version', 'request_id', 'session_id', 'type']);
    expect('after' in built.command).toBe(false);
    expect(validateCommand(built.command).errors).toEqual([]);

    const genesis = readFixture('compat/commands/session_resync.genesis.json')[0];
    expect(validateCommand(genesis).valid).toBe(true);
    expect(Object.keys(genesis).toSorted()).toEqual(Object.keys(built.command).toSorted());
  });

  it('resume_turn validates and matches the engine example when given its ids', () => {
    const built = buildResumeTurn({
      sessionId: 'session-desktop-001',
      turnId: 'turn-002',
      cursor,
      action: 'reconcile',
      requestId: 'recovery-request-002',
    });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(validateCommand(built.command).errors).toEqual([]);
    expect(built.command).toEqual(examplePayload('command', 'resume_turn'));
  });

  /**
   * `continue` is the one action that could re-run or silently skip a side
   * effect whose status is unknown, and the contract says nothing about what any
   * of the three actions does. Refused at the type level AND at runtime, because
   * the value arrives from a renderer press over IPC where JSON erased the type.
   */
  it('resume_turn refuses the continue action the contract never explains', () => {
    const built = buildResumeTurn({
      sessionId: 'session-desktop-001',
      turnId: 'turn-002',
      cursor,
      action: 'continue' as unknown as 'cancel',
    });
    expect(built.ok).toBe(false);
    if (built.ok === true) return;
    expect(built.reason).toContain('reconcile');
  });

  it('resolve_interrupted_approval validates, answer included', () => {
    const built = buildResolveInterruptedApproval({
      sessionId: 'session-desktop-001',
      turnId: 'turn-002',
      cursor,
      approvalId: 'approval-002',
      decision: 'approve',
      answer: 'Proceed',
      requestId: 'recovery-request-003',
    });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(validateCommand(built.command).errors).toEqual([]);
    expect(built.command).toEqual(examplePayload('command', 'resolve_interrupted_approval'));
  });

  /**
   * DRIFT GATE - bundle only. `approval_id` HAS NO PRODUCER: grep the bundle and
   * it appears in exactly four places, none of them an engine event - this
   * command's own fixture, the manifest, and the two schemas. Until the id's
   * source is read off the wire, sending an approve/deny binds it to nothing, or
   * to the wrong approval. What this gate protects is the DECISION not to send
   * the command; the decision itself is enforced by the "sends nothing but
   * session_resync" test further down, which does drive the module.
   */
  it('no engine event in the contract produces an approval_id', () => {
    const producers = readManifest().events.filter((event) => {
      const payload = JSON.parse(readFileSync(join(CONTRACT_V1, event.path), 'utf-8')) as Record<string, unknown>;
      return JSON.stringify(payload).includes('approval_id');
    });
    expect(producers.map((e) => e.type)).toEqual([]);
  });

  it.each([
    ['an empty session_id', { sessionId: '', requestId: 'r-1' }],
    ['an empty request_id', { sessionId: 's-1', requestId: '' }],
  ])('session_resync refuses %s', (_label, input) => {
    expect(buildSessionResync(input).ok).toBe(false);
  });

  it.each([
    ['a short digest', 'abc'],
    ['uppercase hex', 'A'.repeat(64)],
    ['65 hex chars', 'a'.repeat(65)],
  ])('session_resync refuses an after cursor with %s', (_label, digest) => {
    const built = buildSessionResync({ sessionId: 's-1', requestId: 'r-1', after: { journal_digest: digest } });
    expect(built.ok).toBe(false);
    if (built.ok === true) return;
    expect(built.reason).toContain('journal_digest');
  });

  /**
   * The cursor subschema is the ONE object in this surface with
   * `additionalProperties: false`. It is also the compare-and-swap token this
   * host writes to disk, so a key it does not model may be part of the identity.
   */
  it('refuses an after cursor carrying a field the schema does not declare', () => {
    const built = buildSessionResync({
      sessionId: 's-1',
      requestId: 'r-1',
      after: { journal_digest: D4, shard: 2 } as unknown as WCoreJournalCursor,
    });
    expect(built.ok).toBe(false);
    if (built.ok === true) return;
    expect(built.reason).toContain('shard');
  });
});

describe('adversarial/recovery fixtures', () => {
  /**
   * valid-replay: a snapshot at cursor 4444..@40 with an interrupted turn, then
   * a replay whose `from` digest is that SAME 4444.. and whose two items step
   * 41 then 42, ending exactly where `through` claims. There is nothing left for
   * a host to object to, so both are adopted and the cursor ends at 6666..@42 -
   * the value that must reach disk as the next start's `after`.
   */
  it('valid-replay: adopts both and ends at the through cursor', () => {
    const { ctx, cap, verdicts } = replay('adversarial/recovery/valid-replay.jsonl');

    expect(verdicts).toEqual(['applied', 'applied']);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(cap.pendingTurnFor('session-desktop-001')).toEqual({
      turn_id: 'turn-002',
      lifecycle: 'reconciliation_required',
      msg_id: 'msg-002',
      pending_call_id: 'call-tool-002',
      reconcile_reason: 'tool_outcome_unknown',
    });
    expect(ctx.warns).toEqual([]);
    expect(ctx.commands).toEqual([]);

    // Exactly one ask-the-operator effect for one dead turn: the snapshot
    // discovered it, the replay only refined the cursor.
    expect(ctx.frames).toHaveLength(1);
    const frame = ctx.frames[0];
    expect(frame.msg_id).toBe('');
    expect(turnRecoveryCapability.handles).toContain(frame.type);
    expect(frame.data.verdict).toBe('applied');
    expect(frame.data.actionable).toBe(true);
    expect(frame.data.severity).toBe('info');
    expect(frame.data.pendingTurn?.reconcile_reason).toBe('tool_outcome_unknown');
    expect(frame.data.budget?.tokens_used).toBe(12000);
  });

  /**
   * cursor-digest-mismatch: the snapshot applies at 4444..@40; the replay's
   * `from` is ffff..@40 - the SAME journal_sequence, a DIFFERENT digest. This is
   * the fixture that proves the host stitches on the digest. A host comparing
   * sequences accepts a replay from a journal it has never seen and then adopts
   * that journal's `through` as its own position. The cursor must not move, and
   * no `resume_turn` may be produced against a state we cannot place.
   */
  it('cursor-digest-mismatch: refuses a replay that stitches only by sequence', () => {
    const { ctx, cap, verdicts } = replay('adversarial/recovery/cursor-digest-mismatch.jsonl');

    expect(verdicts).toEqual(['applied', 'rejected_digest_mismatch']);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(ctx.warns.join(' ')).toContain('rejected_digest_mismatch');
    expect(ctx.commands).toEqual([]);

    const frame = ctx.frames.at(-1);
    expect(frame?.data.verdict).toBe('rejected_digest_mismatch');
    expect(frame?.data.severity).toBe('warning');
    expect(frame?.data.cursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
    // The two cursors this fixture is built around, stated so the test fails if
    // the fixture is ever regenerated with a different trap.
    const messages = readFixture('adversarial/recovery/cursor-digest-mismatch.jsonl');
    expect((messages[0].cursor as WCoreJournalCursor).journal_sequence).toBe(40);
    expect((messages[1].from as WCoreJournalCursor).journal_sequence).toBe(40);
    expect((messages[1].from as WCoreJournalCursor).journal_digest).toBe(DF);
  });

  /**
   * cursor-gap: `from` matches this time, but the items jump 40 -> 42 and then
   * repeat 42, while `through` names 42 - so `through` is perfectly consistent
   * with the LAST item and journal entry 41 was never seen. A host that adopts
   * `through` without walking the chain loses that entry silently, which is
   * exactly the class of loss recovery exists to prevent.
   */
  it('cursor-gap: refuses a chain that skips a journal entry even though through fits', () => {
    const { ctx, cap, verdicts } = replay('adversarial/recovery/cursor-gap.jsonl');

    expect(verdicts).toEqual(['applied', 'rejected_cursor_gap']);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(ctx.warns.join(' ')).toContain('rejected_cursor_gap');

    const items = readFixture('adversarial/recovery/cursor-gap.jsonl')[1].items as { cursor: WCoreJournalCursor }[];
    expect(items.map((i) => i.cursor.journal_sequence)).toEqual([42, 42]);
    expect(ctx.frames.at(-1)?.data.detail).toContain('40');
  });

  /**
   * state-digest-conflict: two snapshots at the SAME request_id and the SAME
   * cursor, with state_digest aaaa.. then ffff... The manifest correlates this
   * event on `request_id_and_cursor`, so the cursor IS the snapshot's identity
   * and two bodies under one identity is a contradiction, not an update.
   * Last-write-wins is the wrong default here: it would let a single frame move
   * the host onto a state it never verified while claiming to be the one it
   * already holds. The first digest is kept and the session is refused from here
   * on, because nothing later says which of the two was true.
   */
  it('state-digest-conflict: keeps the first digest and refuses the session from then on', () => {
    const { ctx, verdicts } = replay('adversarial/recovery/state-digest-conflict.jsonl');

    expect(verdicts).toEqual(['applied', 'rejected_state_conflict']);
    expect(ctx.warns.join(' ')).toContain('rejected_state_conflict');
    expect(ctx.warns.join(' ')).toContain(DA.slice(0, 8));

    // The latch: a third, perfectly well-formed message is still refused.
    const tracker = armedTracker();
    const [first, second] = readFixture('adversarial/recovery/state-digest-conflict.jsonl');
    expect(tracker.accept(first).verdict).toBe('applied');
    expect(tracker.accept(second).verdict).toBe('rejected_state_conflict');
    expect(tracker.isUnusable).toBe(true);
    expect(tracker.accept(first).verdict).toBe('rejected_session_unusable');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });

    // A new engine process is the one sanctioned way out. `reset` also empties
    // the ask ledger, which is correct and not incidental: a new process has
    // asked nothing, so it must ask again before any answer counts.
    tracker.reset();
    expect(tracker.accept(first).verdict).toBe('rejected_unsolicited');
    tracker.noteResyncRequest('recovery-request-001');
    expect(tracker.accept(first).verdict).toBe('applied');
  });

  /**
   * version-mismatch: a lone snapshot with `recovery_version: 2` on a field the
   * schema pins to `const: 1`, and against an engine that publishes
   * `unsupported_version` as a refusal of its own. A version bump may redefine
   * what a cursor or a state digest MEANS, and both are things this host writes
   * to disk and hands back on the next start. Nothing is stored, nothing is
   * sent, and - because the event is safety-class - it is not dropped in
   * silence.
   */
  it('version-mismatch: stores nothing, sends nothing, and is not silent', () => {
    const { ctx, cap, verdicts } = replay('adversarial/recovery/version-mismatch.jsonl');

    expect(verdicts).toEqual(['rejected_version']);
    expect(cap.latestCursor('session-desktop-001')).toBeNull();
    expect(cap.pendingTurnFor('session-desktop-001')).toBeNull();
    expect(ctx.commands).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('rejected_version');

    const frame = ctx.frames.at(-1);
    expect(frame?.data.severity).toBe('warning');
    expect(frame?.data.actionable).toBe(false);
  });

  /**
   * DRIFT GATE - bundle only. The inventory guard: a future engine bump that
   * ships a sixth recovery fixture must break the build rather than sail past
   * untested.
   */
  it('every recovery fixture the bundle ships has a case above', () => {
    const covered = [
      'adversarial/recovery/cursor-digest-mismatch.jsonl',
      'adversarial/recovery/cursor-gap.jsonl',
      'adversarial/recovery/state-digest-conflict.jsonl',
      'adversarial/recovery/valid-replay.jsonl',
      'adversarial/recovery/version-mismatch.jsonl',
    ];
    expect(adversarialFixtures('recovery')).toEqual(covered);
    expect(readManifest().fixture_inventory.filter((p) => p.startsWith('adversarial/recovery/'))).toEqual(covered);
  });
});

/**
 * DRIFT GATES - bundle only, and the honest boundary of "we validated against
 * the contract". Four of the five adversarial payloads are perfectly valid JSON
 * Schema instances, so a host that only validated would accept every one of them
 * and lose a journal entry without a word. That is a fact about the fixtures;
 * the reducer that catches them is exercised in the block above.
 */
describe('what schema validation alone settles', () => {
  const linesOf = (relPath: string): Record<string, unknown>[] => readFixture(relPath);

  it('rejects only the version-mismatch fixture - recovery_version is the one field it pins', () => {
    expect(validateEvent(linesOf('adversarial/recovery/version-mismatch.jsonl')[0]).valid).toBe(false);
  });

  it('accepts the digest-mismatch, gap and conflict payloads, so only the reducer catches them', () => {
    for (const path of [
      'adversarial/recovery/cursor-digest-mismatch.jsonl',
      'adversarial/recovery/cursor-gap.jsonl',
      'adversarial/recovery/state-digest-conflict.jsonl',
      'adversarial/recovery/valid-replay.jsonl',
    ]) {
      for (const [index, message] of linesOf(path).entries()) {
        expect(validateEvent(message).valid, `${path}:${index + 1} unexpectedly failed schema validation`).toBe(true);
      }
    }
  });
});

/**
 * Counter-tests: prove the fixtures BITE.
 *
 * Each weakened reducer below is a plausible implementation someone would
 * actually write. If a weakened reducer sails past its fixture while the real
 * one refuses it, the fixture is doing work and so is the rule. If both agreed,
 * the expectation above would be green while asserting nothing - which is what
 * a green-but-empty gate always looks like from the outside.
 */
describe('counter-tests: the weakened reducers that these fixtures exist to catch', () => {
  type Weakness = 'sequence-only' | 'version-blind';

  function weakReduce(messages: Record<string, unknown>[], weakness: Weakness): string[] {
    let cursor: WCoreJournalCursor | null = null;
    const verdicts: string[] = [];

    for (const message of messages) {
      if (weakness !== 'version-blind' && message.recovery_version !== 1) {
        verdicts.push('rejected');
        continue;
      }
      if (message.type === 'session_recovery_snapshot') {
        cursor = message.cursor as WCoreJournalCursor;
        verdicts.push('applied');
        continue;
      }
      if (message.type === 'session_recovery_replay') {
        const from = message.from as WCoreJournalCursor | undefined;
        const stitches =
          weakness === 'sequence-only'
            ? from?.journal_sequence === cursor?.journal_sequence
            : from?.journal_digest === cursor?.journal_digest;
        if (!stitches) {
          verdicts.push('rejected');
          continue;
        }
        cursor = message.through as WCoreJournalCursor;
      }
      verdicts.push('applied');
    }
    return verdicts;
  }

  const realVerdicts = (relPath: string): RecoveryVerdict[] => {
    const tracker = armedTracker();
    return readFixture(relPath).map((m) => tracker.accept(m).verdict);
  };

  it('a sequence-only reducer passes valid-replay, so its weakness is not just breakage', () => {
    expect(weakReduce(readFixture('adversarial/recovery/valid-replay.jsonl'), 'sequence-only')).toEqual([
      'applied',
      'applied',
    ]);
    expect(realVerdicts('adversarial/recovery/valid-replay.jsonl')).toEqual(['applied', 'applied']);
  });

  it('and then accepts cursor-digest-mismatch, which the real reducer refuses', () => {
    expect(weakReduce(readFixture('adversarial/recovery/cursor-digest-mismatch.jsonl'), 'sequence-only')).toEqual([
      'applied',
      'applied',
    ]);
    expect(realVerdicts('adversarial/recovery/cursor-digest-mismatch.jsonl')).toEqual([
      'applied',
      'rejected_digest_mismatch',
    ]);
  });

  it('a version-blind reducer passes valid-replay, so its weakness is not just breakage', () => {
    expect(weakReduce(readFixture('adversarial/recovery/valid-replay.jsonl'), 'version-blind')).toEqual([
      'applied',
      'applied',
    ]);
  });

  it('and then accepts version-mismatch, which the real reducer refuses', () => {
    expect(weakReduce(readFixture('adversarial/recovery/version-mismatch.jsonl'), 'version-blind')).toEqual([
      'applied',
    ]);
    expect(realVerdicts('adversarial/recovery/version-mismatch.jsonl')).toEqual(['rejected_version']);
  });
});

describe('the contract gate on sending session_resync', () => {
  /**
   * The default. `NO_CONTRACT` grades everything unavailable, so a capability
   * that never saw `ready` sends nothing - the fail-closed direction. A resync
   * sent to a build that graded this capability `shape_only` waits for a reply
   * that never comes, with the start path blocked behind it.
   */
  it('refuses to ask before any ready has been seen', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();

    const outcome = cap.beginResync(ctx, 'session-desktop-001');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.reason).toContain('unavailable');
    expect(ctx.commands).toEqual([]);
  });

  it('asks once the engine grades it available with durable persistence', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();

    expect(cap.seedFromReady(examplePayload('event', 'ready'), ctx)).not.toBeNull();
    expect(cap.canResync('session-desktop-001')).toBe(true);

    const outcome = cap.beginResync(ctx, 'session-desktop-001', { journal_digest: D4, journal_sequence: 40 });
    expect(outcome.ok).toBe(true);
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0].type).toBe('session_resync');
    expect(validateCommand(ctx.commands[0]).errors).toEqual([]);
    expect(ctx.commands[0].after).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * The grade alone is not enough: with persistence off there is no journal to
   * resync against and the engine would answer `session_recovery_unavailable`
   * every time. `canRecoverSessions` checks both, which is why the gate lives
   * there rather than being re-derived in each caller.
   */
  it('refuses when the capability is available but the engine journals nothing', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const ready = { ...examplePayload('event', 'ready'), session_persistence: 'disabled_by_operator' };

    cap.seedFromReady(ready, ctx);
    expect(cap.canResync('session-desktop-001')).toBe(false);
    expect(cap.beginResync(ctx, 'session-desktop-001').ok).toBe(false);
    expect(ctx.commands).toEqual([]);
  });

  it('refuses when persistence is durable but the capability is only shape_only', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const ready = examplePayload('event', 'ready');
    const contract = ready.contract as { capabilities: Record<string, string> };
    cap.seedFromReady(
      {
        ...ready,
        contract: { ...contract, capabilities: { ...contract.capabilities, turn_recovery_v1: 'shape_only' } },
      },
      ctx
    );

    expect(cap.canResync('session-desktop-001')).toBe(false);
    const outcome = cap.beginResync(ctx, 'session-desktop-001');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.reason).toContain('shape_only');
    expect(ctx.commands).toEqual([]);
  });

  /**
   * `compat/events/ready.journaled-without-replay.json` still advertises
   * `turn_recovery_v1: available`. The name suggests a snapshot with no replay,
   * but the contract never says so - it could equally answer
   * `snapshot_unavailable`. The gate is deliberately conservative here and may
   * be leaving a working path unused; that is a MEASUREMENT, not a guess to
   * make, so it is pinned rather than assumed either way.
   */
  it('does not ask a journaled_without_replay engine, and this is the unmeasured choice', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const ready = readFixture('compat/events/ready.journaled-without-replay.json')[0];

    expect(ready.session_persistence).toBe('journaled_without_replay');
    expect((ready.contract as { capabilities: Record<string, string> }).capabilities.turn_recovery_v1).toBe(
      'available'
    );
    cap.seedFromReady(ready, ctx);
    expect(cap.canResync(String(ready.session_id))).toBe(false);
  });

  /** `ready.minimal.json` ships `session_id: null`. A supported engine, not a fault. */
  it('tolerates a ready with no session_id at all', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    expect(cap.seedFromReady(readFixture('compat/events/ready.minimal.json')[0], ctx)).toBeNull();
    expect(cap.seedFromReady(null, ctx)).toBeNull();
    expect(cap.seedFromReady('ready', ctx)).toBeNull();
    expect(ctx.warns).toEqual([]);
    expect(ctx.commands).toEqual([]);
  });
});

describe('session_recovery_unavailable and the single genesis retry', () => {
  type Armed = {
    cap: TurnRecoveryCapability;
    ctx: Recorder;
    dispatch: ReturnType<typeof createDispatcher>;
    requestId: string;
  };

  const seeded = (): Armed => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    return { cap, ctx, dispatch: createDispatcher([cap]), requestId: arm(cap) };
  };

  /**
   * The example fixture's reason is `cursor_digest_mismatch` - a bad `after`,
   * and the one class of failure a genesis ask actually repairs, because asking
   * with no `after` removes the only thing that was wrong.
   */
  it('retries once from genesis when the engine could not place our cursor', () => {
    const { ctx, dispatch, requestId } = seeded();
    const unavailable = examplePayload('event', 'session_recovery_unavailable');
    expect(unavailable.reason).toBe('cursor_digest_mismatch');

    expect(dispatch(answering(unavailable, requestId), ctx)).toBe(true);
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0].type).toBe('session_resync');
    expect('after' in ctx.commands[0]).toBe(false);
    expect(validateCommand(ctx.commands[0]).errors).toEqual([]);
  });

  /**
   * The once-flag. The second answer carries the request_id the retry minted, so
   * it is a legitimate answer to the retry and reaches the flag rather than
   * being turned away for some other reason - which is what makes this a test of
   * the flag and not of the correlation check.
   */
  it('does not retry a second time, so a failing genesis cannot loop', () => {
    const { ctx, dispatch, requestId } = seeded();
    const unavailable = examplePayload('event', 'session_recovery_unavailable');
    expect(dispatch(answering(unavailable, requestId), ctx)).toBe(true);
    const retryRequestId = ctx.commands[0].request_id;

    expect(dispatch({ ...unavailable, request_id: retryRequestId }, ctx)).toBe(true);
    expect(ctx.commands).toHaveLength(1);
  });

  /**
   * The other five reasons describe the journal itself or say nothing a host
   * could act on. `unsupported_version` in particular would fail identically the
   * second time; retrying is a round trip that changes nothing.
   */
  it.each([
    'session_not_found',
    'unsupported_version',
    'journal_corrupt',
    'snapshot_unavailable',
    'unknown_critical_state',
  ])('does not retry on %s', (reason) => {
    const { ctx, dispatch, requestId } = seeded();
    const unavailable = answering(examplePayload('event', 'session_recovery_unavailable'), requestId);
    expect(dispatch({ ...unavailable, reason }, ctx)).toBe(true);
    expect(ctx.commands).toEqual([]);
    expect(ctx.frames.at(-1)?.data.unavailableReason).toBe(reason);
  });

  /**
   * The cursor the host sent is the one `cursor_digest_mismatch` says the engine
   * could not place. Keeping it would send the same bad `after` at every future
   * start; clearing it makes the next start a genesis ask, which is always
   * answerable. The sink must be told, or the stale value survives on disk.
   */
  it('clears the held cursor and tells the durable sink when the reason indicts it', () => {
    const { cap, ctx, dispatch, requestId } = seeded();
    const writes: { sessionId: string; cursor: WCoreJournalCursor | null }[] = [];
    cap.setCursorSink((sessionId, cursor) => writes.push({ sessionId, cursor }));

    expect(dispatch(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toEqual({ journal_digest: D4, journal_sequence: 40 });

    const unavailable = answering(examplePayload('event', 'session_recovery_unavailable'), requestId);
    expect(unavailable.reason).toBe('cursor_digest_mismatch');
    expect(dispatch(unavailable, ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toBeNull();
    expect(writes.map((w) => w.cursor)).toEqual([{ journal_digest: D4, journal_sequence: 40 }, null]);
  });

  /**
   * The other five reasons say NOTHING about the cursor the host sent, and the
   * held cursor is the only durable journal position this capability exists to
   * maintain: a `snapshot_unavailable` the engine may answer perfectly well ten
   * seconds later must not cost the host its place in the journal, because
   * nothing in the reason tells a later start how to get it back.
   *
   * `state_digest` identity is checked alongside, because clearing it while
   * keeping the cursor would turn the next redelivery at that cursor into a
   * `rejected_state_conflict` and latch the session unusable - the same fault
   * one level along.
   */
  it.each(['session_not_found', 'unsupported_version', 'journal_corrupt', 'snapshot_unavailable'])(
    'keeps the held cursor on %s, which does not indict it',
    (reason) => {
      const { cap, ctx, dispatch, requestId } = seeded();
      const writes: (WCoreJournalCursor | null)[] = [];
      cap.setCursorSink((_sessionId, cursor) => writes.push(cursor));
      const snapshot = answering(examplePayload('event', 'session_recovery_snapshot'), requestId);

      expect(dispatch(snapshot, ctx)).toBe(true);
      const unavailable = answering(examplePayload('event', 'session_recovery_unavailable'), requestId);
      expect(dispatch({ ...unavailable, reason }, ctx)).toBe(true);

      expect(cap.latestCursor(SESSION)).toEqual({ journal_digest: D4, journal_sequence: 40 });
      expect(cap.pendingTurnFor(SESSION)?.turn_id).toBe('turn-002');
      // Nothing was written after the snapshot's own cursor: no null reached disk.
      expect(writes).toEqual([{ journal_digest: D4, journal_sequence: 40 }]);

      // ...and the snapshot's identity is intact, so a redelivery is still a
      // duplicate rather than a conflict. The refusal answers a SECOND ask,
      // because the first one's id is retired by a terminal answer and the
      // redelivery below has to reach the identity check to prove anything.
      const tracker = armedTracker(SESSION, requestId);
      tracker.noteResyncRequest('ask-two');
      expect(tracker.accept(snapshot).verdict).toBe('applied');
      expect(tracker.accept({ ...unavailable, reason, request_id: 'ask-two' }).verdict).toBe('unavailable');
      expect(tracker.accept(snapshot).verdict).toBe('ignored_duplicate');
    }
  );

  /**
   * `unavailable` is the one TERMINAL answer, so the id it quotes is retired.
   * Without that, an id stays valid for the life of the process and a stale
   * duplicate replayed minutes later still passes rule 3 and is graded on
   * content alone - which matters most right here, because the genesis retry has
   * already moved the exchange onto a NEW id.
   *
   * A snapshot's id is deliberately NOT retired: one ask may be answered by a
   * snapshot and a replay, and the `valid-replay` fixture is exactly that.
   */
  it('retires the request_id a terminal unavailable answer quotes', () => {
    const { cap, ctx, dispatch, requestId } = seeded();
    const unavailable = answering(examplePayload('event', 'session_recovery_unavailable'), requestId);

    expect(dispatch({ ...unavailable, reason: 'snapshot_unavailable' }, ctx)).toBe(true);
    expect(ctx.commands).toEqual([]);

    // The same id now buys nothing: the ask it answered is closed.
    expect(dispatch(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toBeNull();
    expect(ctx.warns.join(' ')).toContain('rejected_unsolicited');
  });

  it('does not retire the id a snapshot answers, so its replay still lands', () => {
    const { cap, ctx, dispatch, requestId } = seeded();
    const [snapshot, replayMessage] = readFixture('adversarial/recovery/valid-replay.jsonl');

    expect(dispatch(answering(snapshot, requestId), ctx)).toBe(true);
    expect(dispatch(answering(replayMessage, requestId), ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(ctx.warns).toEqual([]);
  });

  it('refuses an undeclared unavailable reason rather than showing one it cannot map', () => {
    const tracker = armedTracker(SESSION, 'recovery-request-003');
    const decision = tracker.accept({ ...examplePayload('event', 'session_recovery_unavailable'), reason: 'gremlins' });
    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.retryGenesis).toBe(false);
  });
});

/**
 * The engine NEVER volunteers a snapshot: every `session_recovery_*` carries a
 * `request_id` and the only thing that mints one is this host's own
 * `session_resync`. So an answer to a question nobody asked is either a reply to
 * a dead process or something else entirely, and adopting its cursor would move
 * this session onto a journal position it never requested.
 */
describe('answers are correlated to the asks this host made', () => {
  it('refuses a snapshot whose request_id this host never minted', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    cap.seedFromReady(examplePayload('event', 'ready'), ctx);

    const asked = cap.beginResync(ctx, 'session-desktop-001');
    expect(asked.ok).toBe(true);

    expect(dispatch(examplePayload('event', 'session_recovery_snapshot'), ctx)).toBe(true);
    expect(cap.latestCursor('session-desktop-001')).toBeNull();
    expect(ctx.warns.join(' ')).toContain('rejected_unsolicited');
  });

  it('accepts the same snapshot once it answers the request_id that was minted', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    cap.seedFromReady(examplePayload('event', 'ready'), ctx);

    const asked = cap.beginResync(ctx, 'session-desktop-001');
    expect(asked.ok).toBe(true);
    if (asked.ok === false) return;

    const snapshot = { ...examplePayload('event', 'session_recovery_snapshot'), request_id: asked.requestId };
    expect(dispatch(snapshot, ctx)).toBe(true);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(ctx.warns).toEqual([]);
  });

  /**
   * The ask ledger only grows by a deliberate host action, but a host bug that
   * asked in a loop must not leak - and the oldest id is the one least likely to
   * still be answered. Evicting it means an answer to that ask is then treated
   * as unsolicited, which is the conservative direction.
   */
  it('bounds the ledger of outstanding asks and forgets the oldest', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    for (let index = 0; index <= MAX_OUTSTANDING_RESYNCS; index += 1) {
      tracker.noteResyncRequest(`ask-${index}`);
    }

    expect(tracker.outstandingRequests).toHaveLength(MAX_OUTSTANDING_RESYNCS);
    expect(tracker.outstandingRequests).not.toContain('ask-0');
    expect(tracker.outstandingRequests).toContain(`ask-${MAX_OUTSTANDING_RESYNCS}`);

    const snapshot = examplePayload('event', 'session_recovery_snapshot');
    expect(tracker.accept({ ...snapshot, request_id: 'ask-0' }).verdict).toBe('rejected_unsolicited');
    expect(tracker.accept({ ...snapshot, request_id: `ask-${MAX_OUTSTANDING_RESYNCS}` }).verdict).toBe('applied');
  });

  /**
   * THE GATE AND THE GUARD ARE THE SAME DECISION.
   *
   * An earlier version armed this rule only after a successful ask, which
   * disarmed it in precisely the case it exists for: when the contract gate
   * refuses to let this host ask, nothing is ever minted, so an empty ledger
   * meant "accept everything". That is backwards for a safety-class capability -
   * a `shape_only` build is one this host decided it cannot talk to, and
   * adopting its volunteered journal position (and writing it to disk for the
   * next start) is the one outcome that must not follow from that decision.
   *
   * All three answer-shaped events are driven, because the guard sits above the
   * fork between them and a fix that only covered the snapshot would leave the
   * cursor-clearing path on `unavailable` wide open.
   */
  it.each(['session_recovery_snapshot', 'session_recovery_replay', 'session_recovery_unavailable'])(
    'refuses a volunteered %s from an engine the gate will not let it ask',
    (type) => {
      const cap = createTurnRecoveryCapability();
      const ctx = makeContext();
      const dispatch = createDispatcher([cap]);
      const writes: (WCoreJournalCursor | null)[] = [];
      cap.setCursorSink((_sessionId, cursor) => writes.push(cursor));

      const ready = examplePayload('event', 'ready');
      const contract = ready.contract as { capabilities: Record<string, string> };
      cap.seedFromReady(
        {
          ...ready,
          contract: { ...contract, capabilities: { ...contract.capabilities, turn_recovery_v1: 'shape_only' } },
        },
        ctx
      );
      expect(cap.canResync(SESSION)).toBe(false);

      expect(dispatch(examplePayload('event', type), ctx)).toBe(true);
      expect(cap.latestCursor(SESSION)).toBeNull();
      expect(cap.pendingTurnFor(SESSION)).toBeNull();
      expect(writes).toEqual([]);
      expect(ctx.commands).toEqual([]);
      expect(ctx.warns.join(' ')).toContain('rejected_unsolicited');
      expect(ctx.frames.at(-1)?.data.actionable).toBe(false);
    }
  );

  /**
   * The same thing with no `ready` at all - the fail-closed default, and the
   * state every engine is in before its first event is decoded.
   */
  it('refuses a volunteered snapshot when no ready was ever seen', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);

    expect(dispatch(examplePayload('event', 'session_recovery_snapshot'), ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toBeNull();
    expect(ctx.warns.join(' ')).toContain('rejected_unsolicited');
  });

  /**
   * And the reason every other test has to arm itself: the ids the bundle ships
   * are the engine's, not this host's. If this ever passes without arming, the
   * rule has been weakened back.
   */
  it('treats every request_id the bundle ships as one this host never minted', () => {
    for (const type of ['session_recovery_snapshot', 'session_recovery_replay', 'session_recovery_unavailable']) {
      const message = examplePayload('event', type);
      expect(PLACEHOLDER_REQUEST_IDS, type).toContain(message.request_id);
      expect(new SessionRecoveryTracker(SESSION).accept(message).verdict, type).toBe('rejected_unsolicited');
    }
  });

  /** The lifecycle feed carries no `request_id` and is never subject to the rule. */
  it('does not apply the rule to the unsolicited lifecycle feed', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    expect(tracker.accept(examplePayload('event', 'turn_recovery_lifecycle')).verdict).toBe('applied');
  });
});

describe('the live cursor feed', () => {
  const lifecycle = (): Record<string, unknown> => examplePayload('event', 'turn_recovery_lifecycle');

  /**
   * The whole reason this event matters: it is the only thing that leaves an
   * up-to-date `after` on disk for the NEXT start. Without a durable sink the
   * capability is inert across the crash it exists to survive, so the absence is
   * logged rather than left as an empty trace.
   */
  it('advances the cursor and hands it to the durable sink', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const writes: (WCoreJournalCursor | null)[] = [];
    cap.setCursorSink((_sessionId, cursor) => writes.push(cursor));

    expect(dispatch(lifecycle(), ctx)).toBe(true);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(writes).toEqual([{ journal_digest: D6, journal_sequence: 42 }]);
  });

  it('says so when no durable sink is installed', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    expect(createDispatcher([cap])(lifecycle(), ctx)).toBe(true);
    expect(ctx.logs.join(' ')).toContain('memory only');
  });

  /** A persistence hiccup must never take down the decode path. */
  it('survives a sink that throws', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    cap.setCursorSink(() => {
      throw new Error('disk on fire');
    });

    expect(createDispatcher([cap])(lifecycle(), ctx)).toBe(true);
    expect(cap.latestCursor('session-desktop-001')).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(ctx.warns.join(' ')).toContain('disk on fire');
  });

  /**
   * A regressing `after` is worse than a stale one: the next start would send a
   * cursor the engine has already moved past, and the plainest reading of
   * `cursor_ahead` / `history_gap` is that the engine refuses it. Sequences are
   * compared only when both sides carry one, because the schema makes the field
   * optional.
   */
  it('refuses to move the cursor backwards', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    expect(tracker.accept(lifecycle()).verdict).toBe('applied');

    const older = { ...lifecycle(), cursor: { journal_digest: D5, journal_sequence: 41 } };
    expect(tracker.accept(older).verdict).toBe('ignored_duplicate');
    expect(tracker.currentCursor).toEqual({ journal_digest: D6, journal_sequence: 42 });

    const newer = { ...lifecycle(), cursor: { journal_digest: D4, journal_sequence: 43 } };
    expect(tracker.accept(newer).verdict).toBe('applied');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 43 });
  });

  /**
   * The OTHER half of that comparison, and the one a `<` would silently lose: an
   * equal sequence with a DIFFERENT digest. It is not a regression and not a
   * redelivery - it is a contradiction, two different journal entries claiming
   * one position. Adopting it writes an `after` the next start cannot place,
   * which is the `cursor_invalid` loop this refusal exists to avoid. The
   * backwards test above passes under `<` as well as `<=`, so without this one
   * the strictness of the comparison is unverified.
   */
  it('refuses an equal sequence carrying a different digest', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    expect(tracker.accept(lifecycle()).verdict).toBe('applied');

    const contradiction = { ...lifecycle(), cursor: { journal_digest: D5, journal_sequence: 42 } };
    expect(tracker.accept(contradiction).verdict).toBe('ignored_duplicate');
    expect(tracker.currentCursor).toEqual({ journal_digest: D6, journal_sequence: 42 });
  });

  /**
   * And the mirror: the SAME digest at a higher sequence must still advance.
   * `sameCursor` compares sequences only when both sides carry one; a version
   * that stopped comparing them (or returned "same" on a digest match alone)
   * would grade this a duplicate and pin `after` at the first cursor for ever,
   * which is exactly the silence this capability exists to end.
   */
  it('advances on the same digest at a higher sequence', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    expect(tracker.accept(lifecycle()).verdict).toBe('applied');

    const later = { ...lifecycle(), cursor: { journal_digest: D6, journal_sequence: 43 } };
    expect(tracker.accept(later).verdict).toBe('applied');
    expect(tracker.currentCursor).toEqual({ journal_digest: D6, journal_sequence: 43 });
  });

  it('treats an exact redelivery as a duplicate, without warning', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    expect(dispatch(lifecycle(), ctx)).toBe(true);
    expect(dispatch(lifecycle(), ctx)).toBe(true);
    expect(ctx.warns).toEqual([]);
    // Announced once: the second frame changed nothing to announce.
    expect(ctx.frames).toHaveLength(1);
  });

  /**
   * Without `journal_sequence` there is nothing to order on and no
   * previous-digest field to chain against - the schema requires only the
   * digest. Frames arrive over one ordered pipe, so a later frame is a later
   * position; refusing to advance would pin `after` at the first cursor for
   * ever, which is the silence this capability exists to end.
   */
  it('still advances when the engine omits journal_sequence', () => {
    const tracker = new SessionRecoveryTracker('session-desktop-001');
    const first = { ...lifecycle(), cursor: { journal_digest: D5 } };
    const second = { ...lifecycle(), cursor: { journal_digest: D6 } };

    expect(tracker.accept(first).verdict).toBe('applied');
    expect(tracker.accept(second).verdict).toBe('applied');
    expect(tracker.currentCursor).toEqual({ journal_digest: D6 });
  });

  /**
   * The live feed drives what the user is told a turn is doing. A lifecycle
   * value outside the declared set cannot be mapped to anything sayable, so it
   * is refused rather than carried through as a bare string - and the cursor it
   * arrived with is not adopted either, because the frame is not understood.
   */
  it('refuses a lifecycle value it cannot map, and does not take its cursor', () => {
    const tracker = new SessionRecoveryTracker('session-desktop-001');
    const decision = tracker.accept({ ...lifecycle(), lifecycle: 'vibing' });
    expect(decision.verdict).toBe('rejected_malformed');
    expect(tracker.currentCursor).toBeNull();
    expect(tracker.trackedTurns.size).toBe(0);
  });

  /**
   * `turn_id` is wire-controlled and the emission rate of this event is
   * UNMEASURED - it may be one frame per journal entry, several per tool call.
   * The map is bounded and the oldest turn drops; only the most recent turns can
   * matter to a recovery decision.
   */
  it('bounds the per-turn record map and drops the oldest turn', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    for (let index = 0; index <= MAX_TRACKED_TURNS; index += 1) {
      const digest = index.toString(16).padStart(64, '0');
      tracker.accept({
        ...lifecycle(),
        turn_id: `turn-${index}`,
        cursor: { journal_digest: digest, journal_sequence: 100 + index },
      });
    }

    expect(tracker.trackedTurns.size).toBe(MAX_TRACKED_TURNS);
    expect(tracker.trackedTurns.has('turn-0')).toBe(false);
    expect(tracker.trackedTurns.has(`turn-${MAX_TRACKED_TURNS}`)).toBe(true);
  });

  /**
   * "Oldest" must mean least-recently-SEEN, not first-inserted. A `Map` keeps a
   * re-`set` key in its original position, so without the `delete` that precedes
   * the `set` a long-running turn that is still emitting frames is the one
   * evicted - the exact opposite of the intent, and invisible to the bound test
   * above because that one never touches a key twice.
   */
  it('refreshes a turn that is seen again, so the eviction order is least-recently-seen', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    const touch = (index: number, sequence: number): void => {
      tracker.accept({
        ...lifecycle(),
        turn_id: `turn-${index}`,
        cursor: { journal_digest: sequence.toString(16).padStart(64, '0'), journal_sequence: 1000 + sequence },
      });
    };

    // One short of the bound, so re-seeing turn-0 cannot evict-and-reinsert it -
    // which is what makes this a test of the ORDER rather than of the bound. At
    // the bound the two implementations agree by accident: the mutant evicts
    // turn-0 and then immediately puts it back as the newest key.
    for (let index = 0; index < MAX_TRACKED_TURNS - 1; index += 1) touch(index, index);
    expect(tracker.trackedTurns.size).toBe(MAX_TRACKED_TURNS - 1);

    // turn-0 is the oldest by insertion. Seeing it again must move it to newest.
    touch(0, MAX_TRACKED_TURNS);
    touch(MAX_TRACKED_TURNS - 1, MAX_TRACKED_TURNS + 1);
    expect(tracker.trackedTurns.size).toBe(MAX_TRACKED_TURNS);

    // Now one more turn forces an eviction, and it must not be the turn that was
    // seen most recently.
    touch(MAX_TRACKED_TURNS, MAX_TRACKED_TURNS + 2);
    expect(tracker.trackedTurns.has('turn-0')).toBe(true);
    expect(tracker.trackedTurns.has('turn-1')).toBe(false);
    expect(tracker.trackedTurns.size).toBe(MAX_TRACKED_TURNS);
  });

  it('records the reconcile reason against the turn it belongs to', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    tracker.accept(lifecycle());
    expect(tracker.trackedTurns.get('turn-002')).toEqual({
      lifecycle: 'reconciliation_required',
      reconcileReason: 'tool_outcome_unknown',
      cursor: { journal_digest: D6, journal_sequence: 42 },
    });
  });

  /**
   * The live feed announces only when the engine names a reason - and never as
   * actionable. Reconciling a turn the engine is still running is a different
   * question from reconciling one that died, and nothing in the contract says
   * `resume_turn` is legal mid-turn.
   */
  it('announces a live reconcile reason but never marks it actionable', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);

    expect(dispatch(lifecycle(), ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].data.actionable).toBe(false);
    expect(ctx.frames[0].data.lifecycle).toBe('reconciliation_required');

    const quiet: Record<string, unknown> = { ...lifecycle(), cursor: { journal_digest: D5, journal_sequence: 43 } };
    delete quiet.reconcile_reason;
    expect(dispatch(quiet, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
  });

  /**
   * THE PAIRING, with a snapshot already applied - which is the case the test
   * above cannot reach, because with no snapshot there is no pending turn and
   * `actionable` is false for a reason that has nothing to do with the live
   * feed.
   *
   * Here the session HAS an interrupted turn (turn-002, found at 4444..@40) and
   * the engine is running a DIFFERENT turn (turn-999) whose live cursor has
   * moved to 6666..@42. A frame that married the held pending turn to the live
   * cursor would tell the UI it may offer reconcile/cancel for a turn the engine
   * is still running, and hand `resume_turn` - a compare-and-swap - a journal
   * position belonging to a different turn than the `turn_id` beside it.
   */
  it('does not marry the held pending turn to the live cursor', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const requestId = arm(cap);

    expect(dispatch(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].data.actionable).toBe(true);
    expect(ctx.frames[0].data.cursor).toEqual({ journal_digest: D4, journal_sequence: 40 });

    expect(dispatch({ ...lifecycle(), turn_id: 'turn-999' }, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(2);
    const live = ctx.frames[1].data;
    expect(live.cursor).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(live.pendingTurn?.turn_id).toBe('turn-002');
    expect(live.actionable).toBe(false);
  });

  /**
   * The other half of the same fault, on the API a UI press actually reads. The
   * live feed has moved `latestCursor` on; the compare-and-swap token for
   * turn-002 is still where the engine reported it. If these two ever return the
   * same thing, `buildResumeTurn` is being handed the wrong cursor.
   */
  it('keeps the resume_turn cursor at the position the pending turn was reported at', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const requestId = arm(cap);

    expect(dispatch(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(true);
    expect(dispatch({ ...lifecycle(), turn_id: 'turn-999' }, ctx)).toBe(true);

    expect(cap.latestCursor(SESSION)).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(cap.pendingTurnCursorFor(SESSION)).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(cap.pendingTurnCursorFor(SESSION)).not.toEqual(cap.latestCursor(SESSION));

    const pending = cap.pendingTurnFor(SESSION);
    const cursor = cap.pendingTurnCursorFor(SESSION);
    if (pending === null || cursor === null) throw new Error('the snapshot should have left both');
    const built = buildResumeTurn({ sessionId: SESSION, turnId: pending.turn_id, cursor, action: 'reconcile' });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(built.command.cursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(built.command.turn_id).toBe('turn-002');
    expect(validateCommand(built.command).errors).toEqual([]);
  });

  /** A snapshot with no interrupted turn leaves no compare-and-swap token either. */
  it('holds no pending-turn cursor when the snapshot named no pending turn', () => {
    const tracker = armedTracker();
    const snapshot: Record<string, unknown> = { ...examplePayload('event', 'session_recovery_snapshot') };
    delete snapshot.pending_turn;

    expect(tracker.accept(snapshot).verdict).toBe('applied');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
    expect(tracker.currentPendingTurnCursor).toBeNull();
  });
});

describe('bounds on everything the wire controls', () => {
  const snapshot = (): Record<string, unknown> => examplePayload('event', 'session_recovery_snapshot');
  const replayPayload = (): Record<string, unknown> => examplePayload('event', 'session_recovery_replay');

  /**
   * `items` has no `maxItems` in the schema and no bound in the manifest, so the
   * WIRE controls the length of a loop this host runs. Refused, not truncated:
   * truncating would adopt `through` after checking only part of the chain,
   * which is precisely the hole the chain check exists to find.
   */
  it('refuses a replay carrying more items than it will verify', () => {
    const tracker = armedTracker();
    expect(tracker.accept(snapshot()).verdict).toBe('applied');

    const items = Array.from({ length: MAX_REPLAY_ITEMS + 1 }, (_unused, index) => ({
      cursor: { journal_digest: D5, journal_sequence: 41 + index },
      kind: 'state_advanced',
    }));
    const decision = tracker.accept({ ...replayPayload(), items });

    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.detail).toContain(String(MAX_REPLAY_ITEMS));
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  it('accepts a replay exactly at the bound', () => {
    const tracker = armedTracker();
    expect(tracker.accept(snapshot()).verdict).toBe('applied');

    const items = Array.from({ length: MAX_REPLAY_ITEMS }, (_unused, index) => ({
      cursor: { journal_digest: D5, journal_sequence: 41 + index },
      kind: 'state_advanced',
    }));
    const through = { journal_digest: D5, journal_sequence: 40 + MAX_REPLAY_ITEMS };
    expect(tracker.accept({ ...replayPayload(), items, through }).verdict).toBe('applied');
  });

  /**
   * `session_id` is wire-controlled and `HANDLERS` is a module singleton, so the
   * session map is wire-controlled too. Eviction keeps the newest conversation
   * working instead of letting one runaway engine disable recovery for everyone.
   */
  it('evicts the oldest session rather than growing without bound', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);

    for (let index = 0; index <= MAX_TRACKED_SESSIONS; index += 1) {
      expect(dispatch({ ...snapshot(), session_id: `session-${index}` }, ctx)).toBe(true);
    }

    expect(cap.trackedSessions()).toHaveLength(MAX_TRACKED_SESSIONS);
    expect(cap.trackedSessions()).not.toContain('session-0');
    expect(cap.trackedSessions()).toContain(`session-${MAX_TRACKED_SESSIONS}`);
    expect(ctx.warns.join(' ')).toContain('evicted recovery state');
  });

  /**
   * The module-singleton hazard, made concrete: one handler instance serves
   * every live `WCoreAgent`, so a bad frame in one conversation must not touch
   * another's journal position.
   */
  it('keeps two sessions apart when their events interleave', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const askedForA = arm(cap, 'A');
    const [snapA, replayA] = readFixture('adversarial/recovery/valid-replay.jsonl');
    const [badB] = readFixture('adversarial/recovery/version-mismatch.jsonl');
    const forA = (m: Record<string, unknown>): Record<string, unknown> => ({
      ...answering(m, askedForA),
      session_id: 'A',
    });

    expect(dispatch(forA(snapA), ctx)).toBe(true);
    expect(dispatch({ ...badB, session_id: 'B' }, ctx)).toBe(true);
    expect(dispatch(forA(replayA), ctx)).toBe(true);
    expect(dispatch({ ...badB, session_id: 'B' }, ctx)).toBe(true);

    expect(cap.latestCursor('A')).toEqual({ journal_digest: D6, journal_sequence: 42 });
    expect(cap.pendingTurnFor('A')?.turn_id).toBe('turn-002');
    expect(cap.latestCursor('B')).toBeNull();
  });

  /**
   * Eviction must take the session's CONTRACT with it. The contract is what the
   * gate reads, so a stale one left behind would let a session this module has
   * forgotten everything else about still be asked - with a fresh, empty tracker
   * underneath it. Trackers and contracts are keyed by the same wire-controlled
   * id and have to be evicted together or not at all.
   */
  it('evicts the session contract along with the tracker', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);

    cap.seedFromReady(examplePayload('event', 'ready'), ctx);
    expect(cap.canResync(SESSION)).toBe(true);

    for (let index = 0; index < MAX_TRACKED_SESSIONS; index += 1) {
      expect(dispatch({ ...snapshot(), session_id: `flood-${index}` }, ctx)).toBe(true);
    }

    expect(cap.trackedSessions()).not.toContain(SESSION);
    expect(cap.canResync(SESSION)).toBe(false);
    expect(cap.contractFor(SESSION).grades.size).toBe(0);
  });

  /**
   * Recursion over `additionalProperties: true` structure the engine controls.
   * Refusing past the cap is loud; comparing only down to it would grade two
   * snapshots that differ below the cap as an identical redelivery - the one
   * verdict that warns about nothing.
   *
   * The pair is the cap EXACTLY, not a comfortable distance either side: a
   * comparison off by one in either direction moves the boundary between these
   * two payloads and turns one of them red.
   */
  it('compares to exactly the depth it declares and refuses past it', () => {
    const shallow = armedTracker();
    expect(shallow.accept({ ...snapshot(), extra: nest(MAX_CANONICAL_DEPTH - 1) }).verdict).toBe('applied');

    const deep = armedTracker();
    const decision = deep.accept({ ...snapshot(), extra: nest(MAX_CANONICAL_DEPTH) });
    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.detail).toContain('nests deeper');
    expect(deep.currentCursor).toBeNull();
  });

  /**
   * `session_id` is a wire string with no `maxLength` anywhere in the schema, and
   * it becomes a `Map` key this module holds until eviction. Refusing it in the
   * handler - BEFORE `trackerFor` - is what keeps it from being retained at all,
   * which is why the assertion is on `trackedSessions()` and not just on the
   * verdict.
   */
  it('declines a session_id longer than it will hold on to, without allocating for it', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const huge = 'x'.repeat(MAX_WIRE_ID_LENGTH + 1);

    expect(dispatch({ ...snapshot(), session_id: huge }, ctx)).toBe(false);
    expect(cap.trackedSessions()).toEqual([]);
    expect(ctx.frames).toEqual([]);

    // One character shorter is a session id, and is kept.
    const allowed = 'x'.repeat(MAX_WIRE_ID_LENGTH);
    expect(dispatch({ ...snapshot(), session_id: allowed }, ctx)).toBe(true);
    expect(cap.trackedSessions()).toEqual([allowed]);
  });

  it('refuses a request_id longer than it will hold on to', () => {
    const tracker = armedTracker();
    const huge = 'r'.repeat(MAX_WIRE_ID_LENGTH + 1);
    const decision = tracker.accept({ ...snapshot(), request_id: huge });

    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.detail).toContain(String(MAX_WIRE_ID_LENGTH));
    expect(tracker.currentCursor).toBeNull();
  });

  it('refuses a turn_id longer than it will hold on to', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    const decision = tracker.accept({
      ...examplePayload('event', 'turn_recovery_lifecycle'),
      turn_id: 't'.repeat(MAX_WIRE_ID_LENGTH + 1),
    });

    expect(decision.verdict).toBe('rejected_malformed');
    expect(tracker.trackedTurns.size).toBe(0);
  });

  /**
   * The values that CANNOT be refused on length alone - an undeclared enum
   * member has to be reported so a human can see what arrived - are truncated
   * instead. The detail goes into a warning and into the frame the renderer
   * shows, so an engine-controlled string of arbitrary length there is the same
   * unbounded-input problem paid in bytes.
   */
  it('truncates an engine-controlled value rather than quoting it whole', () => {
    const tracker = new SessionRecoveryTracker(SESSION);
    const shout = 'l'.repeat(50_000);
    const decision = tracker.accept({ ...examplePayload('event', 'turn_recovery_lifecycle'), lifecycle: shout });

    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.detail.length).toBeLessThan(MAX_DETAIL_VALUE_LENGTH * 3);
    expect(decision.detail).toContain('50002 chars');
    expect(decision.detail).not.toContain(shout);
  });
});

describe('the handler through the real dispatcher', () => {
  /**
   * Without a `session_id` there is no state to key, so this handler cannot own
   * the event. Returning false lets it fall through to the acknowledged-inert
   * check and be reported, which is the honest answer - swallowing it would be
   * the same silence this capability exists to remove.
   */
  it('declines an event it cannot attribute to a session', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const orphan = { ...examplePayload('event', 'session_recovery_snapshot'), session_id: '' };

    expect(dispatch(orphan, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain('session_id');
    expect(cap.trackedSessions()).toEqual([]);
  });

  /**
   * `WCoreManager` forwards a system-level frame to the renderer only when its
   * type is in `CAPABILITY_FRAME_TYPES`, which is built from
   * `claimedEventTypes()`. A frame emitted under any other type is dropped by
   * the `if (!data.msg_id) return;` guard, in silence.
   */
  it('emits under a type it claims, with an empty msg_id', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const requestId = arm(cap);

    expect(dispatch(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(cap.handles).toContain(ctx.frames[0].type);
    // Session-scoped fact: it must not be filed under whatever turn is open.
    expect(ctx.frames[0].msg_id).toBe('');
    expect(ctx.activeMsgId()).toBe('msg-in-flight');
  });

  /**
   * The only command any code path in this module sends is `session_resync`.
   * `resolve_interrupted_approval` in particular must never leave the process
   * while `approval_id` has no producer in the contract.
   */
  it('sends nothing but session_resync across every fixture and example the bundle ships', () => {
    const commands: SentCommand[] = [];
    const run = (messages: Record<string, unknown>[]): void => {
      // A fresh capability per run: the state-digest-conflict fixture latches
      // its session unusable, and sharing one instance would turn every later
      // message into a refusal - making this assertion vacuously true.
      const cap = createTurnRecoveryCapability();
      const ctx = makeContext();
      const dispatch = createDispatcher([cap]);
      const requestId = arm(cap);
      for (const message of messages) dispatch(answering(message, requestId), ctx);
      commands.push(...ctx.commands);
    };

    for (const path of adversarialFixtures('recovery')) run(readFixture(path));
    for (const type of RECOVERY_EVENT_TYPES) run([examplePayload('event', type)]);

    // The unavailable example legitimately produces a genesis retry, so the set
    // is non-empty and this is a real filter rather than "nothing was sent".
    expect(commands.length).toBeGreaterThan(0);
    expect(new Set(commands.map((c) => c.type))).toEqual(new Set(['session_resync']));
  });

  it('two capability instances do not share recovery state', () => {
    const a = createTurnRecoveryCapability();
    const b = createTurnRecoveryCapability();
    const ctx = makeContext();
    const requestId = arm(a);

    expect(createDispatcher([a])(answering(examplePayload('event', 'session_recovery_snapshot'), requestId), ctx)).toBe(
      true
    );
    expect(a.latestCursor(SESSION)).not.toBeNull();
    expect(b.latestCursor(SESSION)).toBeNull();
  });

  /**
   * THE LATCH MUST OUTLIVE ITS TRACKER.
   *
   * `rejected_state_conflict` is the one verdict that refuses a session for the
   * life of the process, and it lives on a tracker evicted under a
   * WIRE-CONTROLLED `session_id`. So an engine that had a snapshot refused could
   * name {@link MAX_TRACKED_SESSIONS} fresh sessions, push the refusal out of
   * the map, and repeat the conflicting body into a clean tracker - undoing a
   * host decision using nothing but strings it chose itself.
   *
   * The host re-asks after the flood, because that is what a start path does and
   * because without it the repeat would be refused as unsolicited for an
   * unrelated reason - which would make this test green on a broken latch.
   */
  it('remembers a refused session across eviction driven by wire-supplied ids', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const requestId = arm(cap);
    const [first, second] = readFixture('adversarial/recovery/state-digest-conflict.jsonl');

    expect(dispatch(answering(first, requestId), ctx)).toBe(true);
    expect(dispatch(answering(second, requestId), ctx)).toBe(true);
    expect(ctx.warns.join(' ')).toContain('rejected_state_conflict');

    for (let index = 0; index <= MAX_TRACKED_SESSIONS; index += 1) {
      expect(dispatch({ ...first, session_id: `flood-${index}` }, ctx)).toBe(true);
    }
    expect(cap.trackedSessions()).not.toContain(SESSION);

    const askedAgain = arm(cap);
    ctx.warns.length = 0;
    expect(dispatch(answering(first, askedAgain), ctx)).toBe(true);

    expect(ctx.warns.join(' ')).toContain('rejected_session_unusable');
    expect(cap.latestCursor(SESSION)).toBeNull();
    expect(ctx.frames.at(-1)?.data.verdict).toBe('rejected_session_unusable');
  });

  /**
   * A new engine process is the one sanctioned way back, so `resetSession` has
   * to clear the tombstone too - otherwise a session refused once could never
   * recover for the life of the app. This is host-called and unreachable from
   * the wire, which is the whole difference from eviction above.
   */
  it('lets a new engine process clear a remembered refusal', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const requestId = arm(cap);
    const [first, second] = readFixture('adversarial/recovery/state-digest-conflict.jsonl');

    expect(dispatch(answering(first, requestId), ctx)).toBe(true);
    expect(dispatch(answering(second, requestId), ctx)).toBe(true);
    for (let index = 0; index <= MAX_TRACKED_SESSIONS; index += 1) {
      dispatch({ ...first, session_id: `flood-${index}` }, ctx);
    }

    cap.resetSession(SESSION);
    const askedAgain = arm(cap);
    expect(dispatch(answering(first, askedAgain), ctx)).toBe(true);
    expect(cap.latestCursor(SESSION)).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * The tombstone set is itself keyed by a wire string, so it is bounded too -
   * and at the bound a refusal IS forgotten and that session can be reopened.
   * That is the honest cost of not letting the set grow without limit, and the
   * only acceptable version of it is the loud one.
   */
  it('says so when it forgets the oldest remembered refusal', () => {
    const cap = createTurnRecoveryCapability();
    const ctx = makeContext();
    const dispatch = createDispatcher([cap]);
    const [first, second] = readFixture('adversarial/recovery/state-digest-conflict.jsonl');

    // Each session is refused, then pushed out of the tracker map by the next
    // ones, which is what moves it into the remembered-refusal set. `arm` shares
    // the recorder here because that is where the eviction happens, and the
    // warning is the thing under test.
    for (let index = 0; index <= MAX_REFUSED_SESSIONS + MAX_TRACKED_SESSIONS + 2; index += 1) {
      const sessionId = `doomed-${index}`;
      const requestId = arm(cap, sessionId, ctx);
      dispatch({ ...answering(first, requestId), session_id: sessionId }, ctx);
      dispatch({ ...answering(second, requestId), session_id: sessionId }, ctx);
    }

    expect(ctx.warns.join(' ')).toContain('forgetting that recovery for session');
  });
});

/**
 * Counter-checks on the rules no shipped fixture reaches. Each is fired on a
 * hand-built message so it is proven to do work, rather than being green because
 * nothing exercised it.
 */
describe('the rules no fixture exercises', () => {
  const snapshot = (): Record<string, unknown> => examplePayload('event', 'session_recovery_snapshot');
  const replayPayload = (): Record<string, unknown> => examplePayload('event', 'session_recovery_replay');

  const seeded = (): SessionRecoveryTracker => {
    const tracker = armedTracker();
    expect(tracker.accept(snapshot()).verdict).toBe('applied');
    return tracker;
  };

  /**
   * The sibling subsystems each ship both halves of the pair
   * (`adversarial/policy/` has duplicate-identical AND duplicate-conflict);
   * `adversarial/recovery/` ships only the conflict. So "tolerate an identical
   * redelivery" is inferred from the siblings, not proven for recovery - and
   * without this test the tolerate branch would be code no fixture touches.
   */
  it('tolerates an identical snapshot redelivery, which no recovery fixture covers', () => {
    const tracker = seeded();
    const decision = tracker.accept(snapshot());
    expect(decision.verdict).toBe('ignored_duplicate');
    expect(decision.cursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * The other half of the same rule, and the reason identity is judged on the
   * RAW body: both the snapshot and its `pending_turn` are
   * `additionalProperties: true`, so two snapshots at one cursor differing only
   * in a field this host does not model would otherwise reduce to the same
   * object and be graded a benign duplicate.
   */
  it('refuses a second body at one cursor even when it differs only outside state_digest', () => {
    const tracker = seeded();
    const decision = tracker.accept({ ...snapshot(), emitted_by: 'engine-b' });
    expect(decision.verdict).toBe('rejected_state_conflict');
    expect(decision.detail).toContain('outside state_digest');
  });

  it('accepts a reordered redelivery as the same snapshot', () => {
    const tracker = seeded();
    const original = snapshot();
    const reordered = Object.fromEntries(Object.entries(original).toSorted(([a], [b]) => b.localeCompare(a)));
    expect(tracker.accept(reordered).verdict).toBe('ignored_duplicate');
  });

  /**
   * The contract never says a replay may arrive before a snapshot, and with no
   * held position there is nothing to stitch onto. Adopting `through` would mean
   * trusting a chain whose start was never seen - fail closed.
   */
  it('refuses a replay that arrives before any snapshot', () => {
    const tracker = armedTracker();
    const decision = tracker.accept(replayPayload());
    expect(decision.verdict).toBe('rejected_digest_mismatch');
    expect(decision.detail).toContain('holds no cursor');
  });

  /**
   * The mirror case, also unsettled: a genesis replay (no `from`) after a cursor
   * is already held. Adopting `through` would move the position with no verified
   * link to the one held, so it is refused and the silence is recorded here.
   */
  it('refuses a genesis replay when a cursor is already held', () => {
    const tracker = seeded();
    const genesis = { ...replayPayload() };
    delete genesis.from;
    const decision = tracker.accept(genesis);
    expect(decision.verdict).toBe('rejected_digest_mismatch');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * `through` is the position the engine claims the replay ends at. Adopting it
   * without checking the last item would make every chain check decorative.
   */
  it('refuses a replay whose through does not match its last item', () => {
    const tracker = seeded();
    const decision = tracker.accept({
      ...replayPayload(),
      through: { journal_digest: D5, journal_sequence: 99 },
    });
    expect(decision.verdict).toBe('rejected_cursor_gap');
    expect(decision.detail).toContain('through');
  });

  /**
   * `journal_sequence` is OPTIONAL in the schema and gap detection is impossible
   * without it - there is no previous-digest field to chain on. The defence
   * degrades to "a repeat is not forward motion", and the host must SAY it could
   * not verify the order rather than report a chain it never checked.
   */
  it('reports that a sequence-less replay could not be order-checked', () => {
    const tracker = armedTracker();
    expect(tracker.accept({ ...snapshot(), cursor: { journal_digest: D4 } }).verdict).toBe('applied');

    const decision = tracker.accept({
      ...replayPayload(),
      from: { journal_digest: D4 },
      items: [
        { cursor: { journal_digest: D5 }, kind: 'tool_started', turn_id: 'turn-002' },
        { cursor: { journal_digest: D6 }, kind: 'effect_uncertain', turn_id: 'turn-002' },
      ],
      through: { journal_digest: D6 },
    });

    expect(decision.verdict).toBe('applied');
    expect(decision.sequencesVerified).toBe(false);
  });

  it('still catches a repeated cursor when there are no sequences to compare', () => {
    const tracker = armedTracker();
    expect(tracker.accept({ ...snapshot(), cursor: { journal_digest: D4 } }).verdict).toBe('applied');

    const decision = tracker.accept({
      ...replayPayload(),
      from: { journal_digest: D4 },
      items: [
        { cursor: { journal_digest: D5 }, kind: 'tool_started' },
        { cursor: { journal_digest: D5 }, kind: 'effect_uncertain' },
      ],
      through: { journal_digest: D5 },
    });
    expect(decision.verdict).toBe('rejected_cursor_gap');
  });

  /**
   * An unknown item kind cannot be told to the user - `effect_uncertain` is what
   * raises the "did this tool actually run?" question at all - so it is refused
   * rather than displayed as something this host understood. The cost is real: a
   * future engine adding a kind stalls recovery until this host learns it.
   */
  it.each([
    ['an unknown item kind', { items: [{ cursor: { journal_digest: D5, journal_sequence: 41 }, kind: 'teleported' }] }],
    ['a non-array items', { items: 'none' }],
    ['a truncated item digest', { items: [{ cursor: { journal_digest: 'abc' }, kind: 'tool_started' }] }],
  ])('refuses a replay with %s', (_label, patch) => {
    const tracker = seeded();
    expect(tracker.accept({ ...replayPayload(), ...patch }).verdict).toBe('rejected_malformed');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * Every optional field the decoder checks, driven with a value the check is
   * the only thing standing between and the renderer. `budget` in particular is
   * "displayed, never acted on", which is an argument for tolerating unknown
   * KEYS - not for tolerating a `cost_used_usd` that is a string, or a
   * `token_limit` that is a fraction of a token.
   *
   * `1e999` is the reachable path to a non-finite number: `JSON.parse` turns it
   * into `Infinity`, so an engine can put one on the wire even though JSON has
   * no literal for it.
   */
  it.each([
    ['an unknown lifecycle', { lifecycle: 'vibing' }],
    ['an unknown reconcile_reason', { pending_turn: { turn_id: 't', lifecycle: 'failed', reconcile_reason: 'why' } }],
    ['an unknown pending_turn lifecycle', { pending_turn: { turn_id: 't', lifecycle: 'vibing' } }],
    ['a pending_turn with no turn_id', { pending_turn: { lifecycle: 'failed' } }],
    ['a pending_turn msg_id that is not a string', { pending_turn: { turn_id: 't', lifecycle: 'failed', msg_id: 7 } }],
    [
      'a pending_turn pending_call_id that is not a string',
      { pending_turn: { turn_id: 't', lifecycle: 'failed', pending_call_id: { id: 'c-1' } } },
    ],
    ['a truncated state_digest', { state_digest: 'abcd' }],
    ['a missing cursor', { cursor: undefined }],
    ['a cursor carrying a field the schema does not declare', { cursor: { journal_digest: D4, shard: 2 } }],
    ['a missing budget', { budget: undefined }],
    ['a non-integer tokens_used', { budget: { tokens_used: 1.5, cost_used_usd: 1 } }],
    ['a cost_used_usd that is not a number', { budget: { tokens_used: 1, cost_used_usd: 'free' } }],
    ['a non-finite cost_used_usd', { budget: JSON.parse('{"tokens_used":1,"cost_used_usd":1e999}') as unknown }],
    ['a non-integer token_limit', { budget: { tokens_used: 1, cost_used_usd: 1, token_limit: 1.5 } }],
    [
      'a non-finite cost_limit_usd',
      { budget: JSON.parse('{"tokens_used":1,"cost_used_usd":1,"cost_limit_usd":-1e999}') as unknown },
    ],
    ['a session_id that is not a string', { session_id: 7 }],
    ['a missing request_id', { request_id: undefined }],
  ])('refuses a snapshot with %s', (_label, patch) => {
    const tracker = armedTracker();
    const decision = tracker.accept({ ...snapshot(), ...patch });
    expect(decision.verdict).not.toBe('applied');
    expect(tracker.currentCursor).toBeNull();
  });

  /**
   * The cursor subschema is the ONE `additionalProperties: false` object in this
   * surface, and the refusal has to apply to every cursor that crosses the wire -
   * not only to the outbound `after` a builder assembles. An INBOUND cursor is
   * the one this host adopts, writes to disk, and hands back as a
   * compare-and-swap token, so a key it does not model is exactly as dangerous
   * there. Driven at all four inbound positions, because a check placed on one
   * of them reads identical to a check placed on all of them.
   */
  it.each([
    ['the snapshot cursor', { cursor: { journal_digest: D4, journal_sequence: 40, shard: 2 } }],
    ['the replay through cursor', { through: { journal_digest: D6, journal_sequence: 42, shard: 2 } }],
    ['a replay from cursor', { from: { journal_digest: D4, journal_sequence: 40, shard: 2 } }],
    [
      'a replay item cursor',
      { items: [{ cursor: { journal_digest: D5, journal_sequence: 41, shard: 2 }, kind: 'tool_started' }] },
    ],
  ])('refuses an unknown field on %s', (label, patch) => {
    const tracker = seeded();
    const base = label === 'the snapshot cursor' ? snapshot() : replayPayload();
    const decision = tracker.accept({ ...base, ...patch });

    expect(decision.verdict).toBe('rejected_malformed');
    expect(decision.detail).toContain('shard');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * `through` is compared with the same `sameCursor` the live feed uses, and
   * that comparison must include the sequence when both sides carry one. A
   * digest-only comparison accepts a `through` that names a DIFFERENT journal
   * entry of the same content hash and adopts it as the host's position - and
   * the chain walk above cannot catch it, because the walk stops at the last
   * item.
   */
  it('refuses a through that matches the last item by digest but not by sequence', () => {
    const tracker = seeded();
    const decision = tracker.accept({
      ...replayPayload(),
      items: [{ cursor: { journal_digest: D5, journal_sequence: 41 }, kind: 'tool_started' }],
      through: { journal_digest: D5, journal_sequence: 42 },
    });

    expect(decision.verdict).toBe('rejected_cursor_gap');
    expect(tracker.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  /**
   * An empty replay is legal by the schema (`items` has no `minItems`). It may
   * not move the cursor, so the only honest outcomes are "nothing happened" when
   * `through` equals where we already are, and a gap when it does not.
   */
  it('handles an empty replay in both directions', () => {
    const stayed = seeded();
    const same = stayed.accept({
      ...replayPayload(),
      items: [],
      through: { journal_digest: D4, journal_sequence: 40 },
    });
    expect(same.verdict).toBe('ignored_duplicate');
    expect(stayed.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });

    const jumped = seeded();
    expect(jumped.accept({ ...replayPayload(), items: [] }).verdict).toBe('rejected_cursor_gap');
    expect(jumped.currentCursor).toEqual({ journal_digest: D4, journal_sequence: 40 });
  });

  it('refuses a message that is not a recovery event at all', () => {
    const tracker = armedTracker();
    expect(tracker.accept({ type: 'ready', session_id: 's', recovery_version: 1 }).verdict).toBe('rejected_malformed');
    expect(tracker.accept(null).verdict).toBe('rejected_malformed');
    expect(tracker.accept('snapshot').verdict).toBe('rejected_malformed');
  });

  /**
   * The version gate runs BEFORE any other field is read, on purpose: on a
   * version this host does not speak, the meaning of every field below is
   * exactly what is in question.
   */
  it('reports a version mismatch even when the rest of the message is also broken', () => {
    const tracker = armedTracker();
    const decision = tracker.accept({ ...snapshot(), recovery_version: 2, cursor: 'nonsense' });
    expect(decision.verdict).toBe('rejected_version');
  });
});
