/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Anvil receipts, driven by the engine's own adversarial corpus.
 *
 * Eleven fixtures in `adversarial/anvil/` encode what a host must catch. Their
 * filenames are suggestive but are NOT the oracle - `duplicate-identical` is a
 * case a host should tolerate, and `noncritical` elsewhere in the bundle
 * describes a flag rather than a verdict. Every expectation below states the
 * verdict and justifies it against the manifest (`criticality: safety`,
 * `correlation: session_id_and_sequence`), the published JSON Schema, or the
 * fixture's measured shape.
 *
 * The fixtures go through `createDispatcher([...])` - the same factory
 * production uses - so routing proved here is the routing that ships.
 */

import { describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import {
  ANVIL_ALERT_FRAME,
  ANVIL_EVENT_TYPES,
  anvilReceiptsCapability,
  createAnvilLedger,
  createAnvilReceiptsCapability,
} from '@process/agent/wcore/capabilities/anvilReceipts';
import type { AnvilLedger, AnvilVerdict } from '@process/agent/wcore/capabilities/anvilReceipts';
import type { CapabilityContext, CapabilityStreamFrame } from '@process/agent/wcore/capabilities/types';
import {
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  surfaceOf,
  validateEvent,
} from '../helpers/engineContract';

const SESSION = 'session-desktop-001';
const RECEIPT = 'receipt-desktop-001';

const fx = (name: string) => readFixture(`adversarial/anvil/${name}.jsonl`);

/** The verdict codes a ledger produced for a whole fixture, in order. */
function drive(events: Record<string, unknown>[], ledger = createAnvilLedger()): AnvilVerdict[] {
  return events.map((event) => ledger.admit(event));
}

const labels = (verdicts: AnvilVerdict[]): string[] =>
  verdicts.map((v) => (v.outcome === 'rejected' ? `rejected/${v.code}` : v.outcome));

type Recorder = CapabilityContext & {
  frames: CapabilityStreamFrame[];
  logs: string[];
  warns: string[];
  commands: unknown[];
};

function makeContext(): Recorder {
  const frames: CapabilityStreamFrame[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const commands: unknown[] = [];
  return {
    frames,
    logs,
    warns,
    commands,
    sendCommand: (c) => commands.push(c),
    emit: (f) => frames.push(f),
    activeMsgId: () => 'msg-in-flight',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('contract surface', () => {
  /**
   * If the engine ever adds a third anvil event, this fails here - loudly and
   * with a name - instead of the new event being dropped into the
   * acknowledged-unhandled path where nobody looks.
   */
  it('claims exactly the events the manifest assigns to anvil_receipts', () => {
    const manifestTypes = surfaceOf('anvil_receipts')
      .events.map((e) => e.type)
      .toSorted();
    expect(manifestTypes).toEqual([...ANVIL_EVENT_TYPES].toSorted());
    expect([...anvilReceiptsCapability.handles].toSorted()).toEqual(manifestTypes);
  });

  it('claims no commands, because the capability has none', () => {
    expect(surfaceOf('anvil_receipts').commands).toEqual([]);
    expect(anvilReceiptsCapability.name).toBe('anvil_receipts');
  });

  /**
   * The grading is why the failure path is the whole product here: `safety`
   * says a host misbehaving on these events matters, and `session_id_and_sequence`
   * is the correlation key every ordering rule in the ledger is built on.
   */
  it('both events are graded safety and correlate on session_id_and_sequence', () => {
    for (const type of ANVIL_EVENT_TYPES) {
      const entry = entryFor('event', type);
      expect(entry?.criticality, type).toBe('safety');
      expect(entry?.correlation, type).toBe('session_id_and_sequence');
    }
  });

  it('the engine’s own example payloads pass the ledger and the schema', () => {
    for (const type of ANVIL_EVENT_TYPES) {
      expect(validateEvent(examplePayload('event', type)).valid, type).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('fixtures the ledger must admit', () => {
  /**
   * ACCEPT then INVALIDATE. The invalidation names a receipt already admitted
   * in this session and its `prior_artifact_digest` matches what that receipt
   * published, so the retraction is linked and the host can act on it.
   */
  it('valid-invalidation: a linked retraction is honoured', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('valid-invalidation'), ledger);
    expect(labels(verdicts)).toEqual(['accepted', 'invalidated']);
    expect(verdicts[1].detail).toContain('artifact_mutated');
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('invalidated');
  });

  /**
   * TOLERATE. Line 2 is byte-identical to line 1: same correlation key, same
   * event_id, same body. Any reconnecting at-least-once transport produces
   * this, and treating it as tampering would fill the UI with false alarms.
   * The state must not move - that is the part worth testing.
   */
  it('duplicate-identical: an identical retransmission changes nothing', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('duplicate-identical'), ledger);
    expect(labels(verdicts)).toEqual(['accepted', 'accepted_duplicate']);
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('accepted');
    expect(ledger.sessionIncomplete(SESSION)).toBe(false);
  });
});

describe('fixtures the ledger must refuse', () => {
  /**
   * REJECT. Measured: the two lines share receipt_id, event_id and sequence but
   * differ in `stamp` (verified -> conflicting) and `receipt_body_digest`
   * (2d5cf64d… -> a59a5cc8…). One correlation key cannot carry two bodies, so
   * the earlier verdict is no longer trustworthy either - hence quarantine
   * rather than "keep the first one".
   */
  it('duplicate-conflict: two bodies under one correlation key quarantine the receipt', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('duplicate-conflict'), ledger);
    expect(labels(verdicts)).toEqual(['accepted', 'rejected/body_conflict']);
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('quarantined');
  });

  /**
   * REJECT. The session's first anvil event carries sequence 1, so sequence 0
   * was never seen. For a safety-class log that is not a cosmetic hole: a later
   * invalidation could point at a receipt this host never observed. Fail closed
   * and remember the session is no longer provably continuous.
   */
  it('sequence-gap: a missing predecessor marks the session incomplete', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('sequence-gap'), ledger);
    expect(labels(verdicts)).toEqual(['rejected/sequence_gap']);
    expect(verdicts[0].detail).toContain('expected sequence 0');
    expect(ledger.sessionIncomplete(SESSION)).toBe(true);
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('unknown');
  });

  /**
   * REJECT the third line. Measured: line 3 reuses sequence 1 - already spent
   * by the invalidation - under a DIFFERENT identity (receipt-desktop-002 /
   * anvil-event-002). Two different messages claiming one slot is a different
   * failure from one message being altered, so it gets its own code.
   */
  it('out-of-order: a spent sequence reused by a different receipt is a slot conflict', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('out-of-order'), ledger);
    expect(labels(verdicts)).toEqual(['accepted', 'invalidated', 'rejected/sequence_conflict']);
    expect(ledger.receiptStatus(SESSION, 'receipt-desktop-002')).toBe('unknown');
    // The first receipt stays retracted; a contested slot does not un-revoke it.
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('invalidated');
  });

  /**
   * REJECT the third line, and - the part that matters - keep the receipt
   * retracted. Measured: line 3 is byte-identical to line 1, replayed after the
   * invalidation. A last-write-wins reducer would silently resurrect a revoked
   * verdict and tell the user a gate closed over bytes the engine had already
   * disowned.
   */
  it('stale-replay: replaying a receipt after its retraction does not restore it', () => {
    const ledger = createAnvilLedger();
    const verdicts = drive(fx('stale-replay'), ledger);
    expect(labels(verdicts)).toEqual(['accepted', 'invalidated', 'rejected/stale_replay']);
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('invalidated');
  });

  /**
   * REJECT. contract_version "2.0" against subcontract anvil_receipts "1.0"
   * (manifest.json). A major bump may redefine the fields; reading a v2 receipt
   * with v1 rules would assert a verdict the host did not actually check.
   */
  it('version-mismatch: a v2 receipt is refused against the v1 subcontract', () => {
    const ledger = createAnvilLedger();
    expect(labels(drive(fx('version-mismatch'), ledger))).toEqual(['rejected/version_mismatch']);
    // Refused before any state moved: the counter must not have advanced.
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('unknown');
    expect(ledger.sessionIncomplete(SESSION)).toBe(false);
  });

  /**
   * REJECT. `required_extensions: ['future-authority-v2']` names an extension
   * the receipt requires its READER to implement. This host implements none, so
   * accepting would mean displaying "verified" for verification rules it cannot
   * perform. The field is not in the schema's `properties` block and validates
   * only because the branch sets additionalProperties: true - so this rule
   * rests on the contract's prose, not on a declared field.
   */
  it('unknown-critical-extension: a receipt demanding an unimplemented extension is refused', () => {
    const verdicts = drive(fx('unknown-critical-extension'));
    expect(labels(verdicts)).toEqual(['rejected/unknown_critical_extension']);
    expect(verdicts[0].detail).toContain('future-authority-v2');
  });

  /**
   * REJECT. `terminal_state: 'tampered'` violates the schema's const
   * 'verified'. Measured with ajv against the bundle's own schema: this is the
   * ONLY anvil fixture the published schema rejects on its own.
   */
  it('altered-body: a terminal_state outside the schema const is malformed', () => {
    const [line] = fx('altered-body');
    expect(validateEvent(line).valid).toBe(false);
    const verdicts = drive([line]);
    expect(labels(verdicts)).toEqual(['rejected/malformed']);
    expect(verdicts[0].detail).toContain('terminal_state');
  });

  /**
   * REJECT, but only because the ledger remembers. Measured: this invalidation
   * differs from `valid-invalidation.jsonl`'s only in `reason`
   * (artifact_mutated -> gate_revoked) while carrying the identical
   * `invalidation_body_digest` bc267949…. The enum admits both reasons, so
   * standalone it is schema-VALID and no rule the contract states catches it.
   * The digest->body binding is what does.
   */
  it('altered-invalidation-body: is schema-valid and needs the binding table', () => {
    const altered = fx('altered-invalidation-body')[1];
    expect(validateEvent(altered).valid).toBe(true);

    const ledger = createAnvilLedger();
    drive(fx('valid-invalidation'), ledger);
    const verdict = ledger.admit(altered);
    expect(labels([verdict])).toEqual(['rejected/body_conflict']);
    expect(verdict.detail).toContain('already bound to a different body');
  });

  /**
   * The binding table on its own, with the ordering rules taken out of the
   * picture: the forged invalidation is replayed under a DIFFERENT session at
   * sequence 0, where no slot is occupied and no linkage exists yet. Only the
   * digest binding can reject it, so this is the mechanism under test rather
   * than the sequence rules standing in for it.
   */
  it('the digest binding catches a reused digest across sessions', () => {
    const ledger = createAnvilLedger();
    drive(fx('valid-invalidation'), ledger);
    const forged = { ...fx('altered-invalidation-body')[1], session_id: 'session-desktop-002', sequence: 0 };
    const verdict = ledger.admit(forged);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('body_conflict');
  });

  /**
   * IGNORE - by never reaching the ledger. The envelope's own `type` is
   * `sub_agent_event`; the receipt is nested under `inner`, published by an
   * agent named "untrusted-child". Routing on the envelope type is the whole
   * defence: a child agent that could get its claimed receipt into the ledger
   * could forge a verdict.
   */
  it('nested-receipt-inert: a receipt inside a sub_agent_event is not routed', () => {
    const [envelope] = fx('nested-receipt-inert');
    expect(envelope.type).toBe('sub_agent_event');
    expect((envelope.inner as Record<string, unknown>).type).toBe('anvil_receipt');

    const ledger = createAnvilLedger();
    const dispatch = createDispatcher([createAnvilReceiptsCapability(ledger)]);
    const ctx = makeContext();

    expect(dispatch(envelope, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns).toEqual([]);
    // Proof the ledger was never touched: sequence 0 is still free, so an
    // authentic receipt is accepted rather than colliding with the nested one.
    expect(labels(drive(fx('valid-invalidation'), ledger))).toEqual(['accepted', 'invalidated']);
  });

  /**
   * Fail closed if the envelope ever DOES reach the ledger by another route -
   * a future caller, a decoder change. The nested payload is not an anvil event
   * at the top level and must not be interpreted as one.
   */
  it('handing the nested envelope straight to the ledger is malformed, not accepted', () => {
    const [envelope] = fx('nested-receipt-inert');
    const verdict = createAnvilLedger().admit(envelope);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('malformed');
  });
});

describe('the legacy receipt shape', () => {
  /**
   * REJECT. `compat/events/anvil_receipt.legacy.json` is only
   * {type, sequence, stamp, terminal_state} - measured with ajv against the
   * bundle's own core-event.schema.json, it FAILS validation, because the
   * current branch requires receipt_id, event_id, origin, contract_version,
   * session_id, run_id, task_id, artifact_digest, gate_closure_digest and
   * receipt_body_digest. This is the case where a host could most easily be
   * fooled into showing "verified" for a receipt carrying no digest at all.
   */
  it('is refused rather than shown as a verified receipt', () => {
    const legacy = readFixture('compat/events/anvil_receipt.legacy.json')[0];
    expect(legacy.terminal_state).toBe('verified');
    expect(validateEvent(legacy).valid).toBe(false);

    const verdict = createAnvilLedger().admit(legacy);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('malformed');
  });

  it('still reaches the user as an alert instead of being dropped', () => {
    const legacy = readFixture('compat/events/anvil_receipt.legacy.json')[0];
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    expect(dispatch(legacy, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].type).toBe(ANVIL_ALERT_FRAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('routing through the real dispatcher', () => {
  it('says nothing to the user about a healthy receipt', () => {
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    const [receipt] = fx('valid-invalidation');
    expect(dispatch(receipt, ctx)).toBe(true);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns).toEqual([]);
    expect(ctx.logs.join(' ')).toContain('accepted');
  });

  it('says nothing about an identical retransmission either', () => {
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    for (const event of fx('duplicate-identical')) dispatch(event, ctx);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns).toEqual([]);
  });

  /**
   * The whole visible surface of the capability, fixture by fixture: one alert
   * and one warning per non-accepted verdict, nothing at all otherwise.
   * Silence where a row expects an alert is the regression this module exists
   * to prevent; noise where a row expects none is what makes an alert
   * ignorable.
   *
   * `altered-invalidation-body` expects a plain `invalidated` on purpose. Read
   * standalone it is a linked, schema-valid retraction and NO rule the contract
   * states can tell it from the authentic one - the digest binding only catches
   * it once the ledger has seen the real invalidation. That row records the
   * limitation rather than hiding it.
   */
  it.each([
    ['valid-invalidation', ['invalidated']],
    ['duplicate-identical', []],
    ['duplicate-conflict', ['rejected']],
    ['sequence-gap', ['rejected']],
    ['out-of-order', ['invalidated', 'rejected']],
    ['stale-replay', ['invalidated', 'rejected']],
    ['version-mismatch', ['rejected']],
    ['unknown-critical-extension', ['rejected']],
    ['altered-body', ['rejected']],
    ['altered-invalidation-body', ['invalidated']],
  ])('%s surfaces exactly %j', (name, expected) => {
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    for (const event of fx(name)) expect(dispatch(event, ctx)).toBe(true);

    const alerts = ctx.frames.filter((f) => f.type === ANVIL_ALERT_FRAME);
    const payloads = alerts.map((a) => a.data as { outcome: string; code: string | null });
    expect(payloads.map((p) => p.outcome)).toEqual(expected);
    expect(ctx.warns).toHaveLength(expected.length);
    for (const payload of payloads) {
      if (payload.outcome === 'rejected') expect(payload.code, name).not.toBeNull();
    }
  });

  /**
   * The frame belongs to the session, not to whichever turn happened to be in
   * flight - the same shape `sub_agent_event`, `session_cost` and `mcp_failed`
   * already travel as. `activeMsgId()` returning a live id must not change it.
   */
  it('emits a session-level frame with the correlation fields a host needs', () => {
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    for (const event of fx('duplicate-conflict')) dispatch(event, ctx);

    const [alert] = ctx.frames;
    expect(alert.msg_id).toBe('');
    expect(alert.data).toMatchObject({
      receiptId: RECEIPT,
      sequence: 0,
      outcome: 'rejected',
      code: 'body_conflict',
      artifactDigest: expect.stringContaining('sha256:'),
    });
  });

  /**
   * Returning false would hand the event back to the acknowledged-unhandled
   * check, and the safety event would go quiet again - the exact behaviour this
   * capability replaced.
   */
  it('never declines an event it claims, whatever the verdict', () => {
    const dispatch = createDispatcher([createAnvilReceiptsCapability()]);
    const ctx = makeContext();
    for (const name of adversarialFixtures('anvil')) {
      for (const event of readFixture(name)) {
        if (event.type !== 'anvil_receipt' && event.type !== 'anvil_receipt_invalidated') continue;
        expect(dispatch(event, ctx), `${name} ${String(event.type)}`).toBe(true);
      }
    }
  });

  it('covers every adversarial anvil fixture in this file', () => {
    // A new fixture appearing in the bundle should fail here rather than sit
    // undriven while the suite stays green.
    expect(adversarialFixtures('anvil')).toHaveLength(11);
  });

  /** A ledger bug must cost the audit readout, not the conversation. */
  it('a throwing ledger is contained by the dispatcher', () => {
    const exploding: AnvilLedger = {
      admit: () => {
        throw new Error('ledger bug');
      },
      receiptStatus: () => 'unknown',
      sessionIncomplete: () => false,
    };
    const dispatch = createDispatcher([createAnvilReceiptsCapability(exploding)]);
    const ctx = makeContext();
    const [receipt] = fx('valid-invalidation');
    expect(() => dispatch(receipt, ctx)).not.toThrow();
    expect(dispatch(receipt, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain('anvil_receipts');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counter-checks: proof the guards can fail.
 *
 * Every case above passes with the real corpus. These mutate an authentic
 * receipt in memory so each rule is exercised by an input that differs from a
 * good one in exactly one way - a gate that cannot be made to fire is not a
 * gate.
 */
describe('each guard rejects a single-field mutation of a good receipt', () => {
  const good = () => ({ ...fx('valid-invalidation')[0] });

  it('the unmutated receipt is accepted, so the mutations below are the cause', () => {
    expect(validateEvent(good()).valid).toBe(true);
    expect(labels(drive([good()]))).toEqual(['accepted']);
  });

  it.each([
    ['sequence jumped to 5', { sequence: 5 }, 'sequence_gap'],
    ['origin blanked', { origin: '' }, 'malformed'],
    ['origin forged to a child agent', { origin: 'child/agent' }, 'malformed'],
    ['contract_version bumped to 2.0', { contract_version: '2.0' }, 'version_mismatch'],
    ['terminal_state tampered', { terminal_state: 'tampered' }, 'malformed'],
    ['digest_algorithm swapped', { digest_algorithm: 'md5' }, 'malformed'],
    ['an extension demanded', { required_extensions: ['future-authority-v2'] }, 'unknown_critical_extension'],
    ['receipt_body_digest removed', { receipt_body_digest: undefined }, 'malformed'],
    ['artifact_digest removed', { artifact_digest: undefined }, 'malformed'],
    ['sequence negative', { sequence: -1 }, 'malformed'],
    ['sequence fractional', { sequence: 0.5 }, 'malformed'],
    ['checks_passed sent as a string', { checks_passed: '14' }, 'malformed'],
  ])('%s -> %s', (_name, patch, code) => {
    const mutated: Record<string, unknown> = { ...good(), ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete mutated[key];
    const verdict = createAnvilLedger().admit(mutated);
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe(code);
  });

  /**
   * A retraction naming a receipt this host never admitted, and one that
   * disagrees with the receipt about what was published. Both are claims the
   * host cannot check, so both are refused rather than shown as retractions.
   */
  it.each([
    ['an unknown receipt', { receipt_id: 'receipt-nobody-saw' }],
    ['a mismatched prior_artifact_digest', { prior_artifact_digest: `sha256:${'d'.repeat(64)}` }],
  ])('an invalidation naming %s is unlinked', (_name, patch) => {
    const ledger = createAnvilLedger();
    const [receipt, invalidation] = fx('valid-invalidation');
    ledger.admit(receipt);
    const verdict = ledger.admit({ ...invalidation, ...patch });
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('invalidation_unlinked');
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('accepted');
  });

  /**
   * Irreversibility on its own axis. Replaying the receipt at a FRESH sequence
   * after the retraction cannot be caught by the ordering rules - only by the
   * ledger refusing to restore a dead verdict.
   */
  it('a retracted receipt republished at a later sequence stays retracted', () => {
    const ledger = createAnvilLedger();
    drive(fx('valid-invalidation'), ledger);
    const verdict = ledger.admit({ ...fx('valid-invalidation')[0], sequence: 2 });
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('stale_replay');
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('invalidated');
  });

  /**
   * One receipt id carries one verdict. A second, different body under the same
   * id at a fresh sequence is not supersession - the contract expects a
   * superseding receipt to arrive under its own id, with `supersedes_receipt_id`
   * pointing back (no fixture exercises it).
   */
  it('a receipt id republished with a different body at a later sequence is a conflict', () => {
    const ledger = createAnvilLedger();
    // Only the receipt, deliberately: leave it live so this exercises the
    // one-id-one-verdict rule rather than the retraction rule above it.
    ledger.admit(fx('valid-invalidation')[0]);
    const verdict = ledger.admit({ ...fx('duplicate-conflict')[1], sequence: 1 });
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.code).toBe('body_conflict');
    expect(ledger.receiptStatus(SESSION, RECEIPT)).toBe('quarantined');
  });
});
