/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Engine capability activation, driven through frames MEASURED from the binary.
 *
 * This event is the hardest kind to test honestly: the contract bundle ships no
 * fixture for it, no schema for its body, and no manifest entry. So the frames
 * these tests replay were captured from the engine Darhai actually ships -
 * `resources/bundled-wayland-core/win32-x64/wayland-core.exe`, wayland-core
 * 0.12.26 - into
 * `tests/fixtures/engine-contract/desktop/v1/observed/`, whose README records
 * the exact commands. They are read through the same `readFixture` helper as
 * every vendored fixture. Hand-typing a payload that merely resembles the wire
 * would prove nothing about the engine, which is the whole reason the capture
 * exists.
 *
 * Two captures, one variable apart:
 *   - `capability_activation.default.jsonl`      - 24 frames, empty config
 *   - `capability_activation.smart-enabled.jsonl` - 26 frames, the only
 *     difference being `[compact] smart_enabled = true`
 *
 * Every verdict below is argued from the contract (or from its documented
 * SILENCE) and from those captures - never from a filename.
 *
 * WHAT THE CAPTURES CANNOT REACH. Neither capture contains an
 * `outcome_changed` frame: an empty-stdin boot never runs a turn, and that
 * stage is the engine revising a verdict mid-session. It is named in the
 * binary's variant table and in the module's own types, so the host will meet
 * it, and the frames that exercise it below are hand-built and labelled as
 * such. The same goes for anything past a bound - no real engine sends 64
 * capability ids. Where a test is not driven by a capture it says why the
 * capture could not do the job.
 *
 * Routing goes through `createDispatcher`, the same function production builds
 * its dispatcher from. It has to be handed a handler list: this capability is
 * not registered in `HANDLERS` yet, so `dispatchCapabilityEvent` would not
 * route to it. The registration invariant that must hold the day it is
 * registered is pinned at the bottom of this file.
 */

// The contract's schemas declare draft 2020-12; the default Ajv export only
// knows draft-07. Same import the shared helper uses. It is imported directly
// here because `engineContract.ts` exposes validators for `core-event` and
// `host-command` only, and the one schema that mentions this event is neither.
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ACKNOWLEDGED_UNHANDLED_EVENTS } from '@process/agent/wcore/protocol';
import { claimedEventTypes, createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  capabilityActivationCapability,
  createCapabilityActivationCapability,
  healthOf,
  MAX_ANNOUNCED_FRAMES,
  MAX_DETAIL_CHARS,
  MAX_FIELD_CHARS,
  MAX_TRACKED_CAPABILITIES,
  readCapabilityActivationSnapshot,
  remedyFor,
  resetCapabilityActivation,
} from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import type {
  CapabilityActivationCapability,
  CapabilityActivationFrame,
  CapabilityActivationRow,
  CapabilityHealth,
} from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import { CONTRACT_V1, entryFor, readFixture, readManifest, validateEvent } from '../helpers/engineContract';

const EVENT = 'capability_activation';
const DEFAULT_START = 'observed/capability_activation.default.jsonl';
const SMART_ENABLED_START = 'observed/capability_activation.smart-enabled.jsonl';

/** One `log`/`warn` call, message and detail both, so detail can be asserted. */
type Line = { message: string; detail: unknown };

type Recorder = CapabilityContext & {
  frames: { type: string; data: CapabilityActivationFrame; msg_id: string }[];
  logs: string[];
  warns: string[];
  logLines: Line[];
  warnLines: Line[];
};

function makeContext(msgId = ''): Recorder {
  const frames: Recorder['frames'] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const logLines: Line[] = [];
  const warnLines: Line[] = [];
  return {
    frames,
    logs,
    warns,
    logLines,
    warnLines,
    // This capability has no command surface at all - the manifest has no entry
    // for the event, so there is nothing to answer. A throw here means any
    // command send shows up as the dispatcher reporting the event unhandled.
    sendCommand: () => {
      throw new Error('capability_activation sends no commands - the contract declares none');
    },
    emit: (f) => frames.push(f as Recorder['frames'][number]),
    activeMsgId: () => msgId,
    // The real context hands `detail` straight to `console.log`/`console.warn`,
    // so what goes in it is as operator-visible as the message - and as
    // wire-controlled. Recorded rather than dropped for exactly that reason.
    log: (m, d) => {
      logs.push(m);
      logLines.push({ message: m, detail: d });
    },
    warn: (m, d) => {
      warns.push(m);
      warnLines.push({ message: m, detail: d });
    },
  };
}

type Replayed = { ctx: Recorder; cap: CapabilityActivationCapability; consumed: boolean[] };

/** Replay a message list through the real dispatcher against a fresh instance. */
function replayMessages(messages: Record<string, unknown>[], msgId = ''): Replayed {
  const cap = createCapabilityActivationCapability();
  const dispatch = createDispatcher([cap]);
  const ctx = makeContext(msgId);
  const consumed = messages.map((m) => dispatch(m, ctx));
  return { ctx, cap, consumed };
}

function replay(relPath: string): Replayed {
  return replayMessages(readFixture(relPath));
}

/**
 * One dispatch against a fresh instance; returns everything it produced.
 *
 * Takes `unknown` so the shapes this must REFUSE - a numeric `capability`, an
 * object `stage` - are expressible without a cast at every call site, exactly
 * as they arrive from a wire the contract does not validate.
 */
function dispatchOne(event: unknown): Replayed {
  return replayMessages([event as Record<string, unknown>]);
}

/**
 * `health` is spelled out at every call site rather than derived from `stage`
 * via `healthOf`. Deriving it would make every row assertion agree with the
 * module by construction - the grading would be asserted against itself and a
 * regression that called `outcome_changed` healthy would stay green.
 */
const row = (
  capability: string,
  stage: string,
  reason: string | null,
  health: CapabilityHealth,
  remedy: CapabilityActivationRow['remedy'],
  frames: number
): CapabilityActivationRow => ({ capability, stage, reason, health, remedy, frames });

/**
 * The terminal readiness record of a default v0.12.26 start, in emission order.
 *
 * Six ready, three `disabled_by_config`, one `isolation_not_enforced`. The
 * per-capability frame counts are part of the expectation on purpose: they are
 * what proves the 24 frames COLLAPSED into these rows rather than the last four
 * happening to look right.
 */
const DEFAULT_ROWS: CapabilityActivationRow[] = [
  row('pricing_refresher', 'unavailable', 'disabled_by_config', 'declined', 'config', 2),
  row('mid_flight_monitor', 'ready', null, 'ok', 'unknown', 4),
  row('cooldown_tracker', 'ready', null, 'ok', 'unknown', 4),
  row('learned_policy', 'unavailable', 'disabled_by_config', 'declined', 'config', 2),
  row('smart_handoff', 'unavailable', 'disabled_by_config', 'declined', 'config', 2),
  row('delegate_isolation', 'unavailable', 'isolation_not_enforced', 'declined', 'not_configurable', 2),
  row('procedure_skill_drafting', 'ready', null, 'ok', 'unknown', 4),
  row('legacy_auto_skill_drafting', 'ready', null, 'ok', 'unknown', 4),
];

/** A well-formed frame, for the rules no capture can reach. */
const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: EVENT,
  capability: 'smart_handoff',
  stage: 'unavailable',
  reason: 'disabled_by_config',
  ...over,
});

/** A healthy frame for a named capability - the shape the capture is full of. */
const ready = (capability: string): Record<string, unknown> => frame({ capability, stage: 'ready', reason: undefined });

describe('what the contract settles about capability_activation', () => {
  /**
   * Nothing. This is the premise every decode decision in the module rests on,
   * so it is asserted rather than assumed: if a future bundle DOES file this
   * event, the module's "trust no field" posture should be revisited against
   * the new schema instead of inherited.
   *
   * The capability-map check is the premise for the OTHER decision - not gating
   * reads on `contractNegotiation`. `manifest.capabilities` is what grading
   * answers from, and this event names no capability in it, so a host that
   * gated on a grade would refuse frames it is demonstrably receiving.
   */
  it('has no manifest entry in either direction and no capability to grade', () => {
    expect(entryFor('event', EVENT)).toBeUndefined();
    expect(entryFor('command', EVENT)).toBeUndefined();
    expect(Object.keys(readManifest().capabilities)).not.toContain(EVENT);
  });

  /**
   * `core-event.schema.json` is the schema a Desktop host validates events
   * against, and this event is not one of its 53 arms - so a REAL frame,
   * captured from the running engine, fails it. A host that validated first and
   * decoded second would throw away every activation frame the engine sends.
   */
  it('is rejected by the published event schema, so validation cannot gate it', () => {
    const first = readFixture(DEFAULT_START)[0];
    expect(first.type).toBe(EVENT);
    expect(validateEvent(first).valid).toBe(false);
  });

  /**
   * The one schema that names it declares a bare `type` and nothing else. The
   * proof that matters is not that it accepts a real frame - it is that it
   * accepts obvious garbage in every field this module reads. That is why
   * `capability`/`stage`/`reason` are re-checked at the decode boundary here
   * rather than delegated to a validator.
   */
  it('is accepted by producer-complete.schema.json even with every field wrong-typed', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv as unknown as Parameters<typeof addFormats>[0]);
    const schema = JSON.parse(
      readFileSync(join(CONTRACT_V1, 'schema/producer-complete.schema.json'), 'utf-8')
    ) as Record<string, unknown>;
    const validate = ajv.compile(schema);

    expect(validate(readFixture(DEFAULT_START)[0])).toBe(true);
    expect(validate({ type: EVENT })).toBe(true);
    expect(validate({ type: EVENT, capability: 42, stage: {}, reason: [] })).toBe(true);

    const arms = schema.anyOf as { properties?: Record<string, { enum?: string[] }> }[];
    const arm = arms.find((a) => a.properties?.type?.enum?.includes(EVENT));
    expect(arm, 'no producer-complete arm mentions the event').toBeDefined();
    // The whole risk in one assertion: the branch declares `type` and nothing else.
    expect(Object.keys(arm?.properties ?? {})).toEqual(['type']);
  });

  /** The bundle's own statement of the hole - the authoritative one, per the plan. */
  it('is listed in DEFERRED.md as a producer event with no Desktop payload schema', () => {
    const deferred = readFileSync(join(CONTRACT_V1, 'DEFERRED.md'), 'utf-8');
    expect(deferred).toContain('Producer events with NO Desktop payload schema');
    expect(deferred).toContain(`- \`${EVENT}\``);
  });
});

describe('the 24 measured frames of a default engine start', () => {
  it('collapses into an eight-row readiness record with the measured outcomes', () => {
    const { cap, consumed } = replay(DEFAULT_START);

    expect(consumed.every(Boolean), 'the dispatcher declined a real engine frame').toBe(true);
    expect(cap.snapshot().rows).toEqual(DEFAULT_ROWS);
    expect(cap.snapshot().overflowed).toBe(false);
  });

  /**
   * Four warnings, one per capability the engine declined - and none for the
   * six that reach `ready`. `types.ts` reserves `warn` for what an operator
   * should see; a start where everything worked must not produce a single one,
   * or the four that matter get scrolled past.
   */
  it('warns exactly once per unavailable capability and never for a healthy one', () => {
    const { ctx } = replay(DEFAULT_START);

    expect(ctx.warns).toHaveLength(4);
    for (const name of ['pricing_refresher', 'learned_policy', 'smart_handoff', 'delegate_isolation']) {
      expect(
        ctx.warns.filter((w) => w.includes(name)),
        name
      ).toHaveLength(1);
    }
    for (const name of ['mid_flight_monitor', 'cooldown_tracker', 'procedure_skill_drafting']) {
      expect(ctx.warns.join(' '), name).not.toContain(name);
    }
    // The 20 healthy steps are logged, not warned.
    expect(ctx.logs).toHaveLength(20);
  });

  /**
   * The engine re-states these outcomes on every start, and a reconnecting or
   * replaying host can see the same frames twice. Warning again would train the
   * operator to ignore the line. The rows must still count both deliveries, or
   * "no second warning" could be implemented by ignoring the frame entirely.
   */
  it('does not warn a second time when the same outcomes are delivered again', () => {
    const doubled = [...readFixture(DEFAULT_START), ...readFixture(DEFAULT_START)];
    const { ctx, cap } = replayMessages(doubled);

    expect(ctx.warns).toHaveLength(4);
    expect(cap.snapshot().rows).toEqual(
      DEFAULT_ROWS.map((r) => row(r.capability, r.stage, r.reason, r.health, r.remedy, r.frames * 2))
    );
  });

  /**
   * The rule the replayed start above depends on, stated on its own so a
   * failure names it: `declared` is a step on the way to an outcome, not a new
   * outcome. Only `ready` and the two stages this host will not call healthy
   * move the dedupe key, so re-walking the lifecycle to the SAME verdict is one
   * warning, not two.
   */
  it('treats a re-walked lifecycle to the same verdict as one outcome', () => {
    const { ctx } = replayMessages([
      frame({ stage: 'declared', reason: undefined }),
      frame(),
      frame({ stage: 'declared', reason: undefined }),
      frame(),
    ]);

    expect(ctx.warns).toHaveLength(1);
  });

  /**
   * A CHANGED outcome is not a repeat. If a capability that was
   * `disabled_by_config` comes back `isolation_not_enforced`, that is new
   * information about the engine's posture and must be said out loud.
   */
  it('warns again when the same capability reports a different reason', () => {
    const { ctx } = replayMessages([frame(), frame(), frame({ reason: 'runtime_path_unwired' })]);

    expect(ctx.warns).toHaveLength(2);
    expect(ctx.warns[1]).toContain('runtime_path_unwired');
  });

  /**
   * A capability that fails, recovers, then fails the same way again has
   * produced THREE outcomes, two of which the operator must see. Deduping on
   * "has this outcome ever been reported" instead of "was this the LAST
   * outcome" silences the second failure - and the second failure is the one
   * that says the recovery did not hold.
   *
   * No capture can reach this: one boot reports each capability once.
   */
  it('warns again when a capability fails, recovers, then fails the same way', () => {
    const down = frame({ capability: 'delegate_isolation', reason: 'isolation_not_enforced' });
    const { ctx, cap } = replayMessages([down, ready('delegate_isolation'), down]);

    expect(ctx.warns).toHaveLength(2);
    expect(ctx.warns[0]).toBe(ctx.warns[1]);
    expect(cap.snapshot().rows).toEqual([
      row('delegate_isolation', 'unavailable', 'isolation_not_enforced', 'declined', 'not_configurable', 3),
    ]);
  });

  /**
   * Every emitted frame carries a type this capability CLAIMS - which is the
   * half of the pass-through invariant this file can prove. `WCoreManager`
   * builds its set from `claimedEventTypes()`, i.e. from the REGISTERED
   * handlers' `handles`, and this module is not registered, so today every
   * frame it emits is dropped there and no assertion here can say otherwise.
   * What is checked is the local half: the emit name matches `handles`, so
   * registration is the only thing standing between these frames and the
   * renderer. The registration guard at the bottom of this file is what goes
   * red the day someone does half of that edit.
   */
  it('forwards one frame per accepted event, under a type it claims', () => {
    const { ctx, cap } = replay(DEFAULT_START);

    expect(ctx.frames).toHaveLength(24);
    for (const f of ctx.frames) expect(cap.handles).toContain(f.type);
    expect(ctx.frames.every((f) => f.msg_id === '')).toBe(true);

    const last = ctx.frames.at(-1);
    expect(last?.data).toEqual({
      capability: 'legacy_auto_skill_drafting',
      stage: 'ready',
      reason: null,
      health: 'ok',
      remedy: 'unknown',
    });

    // The frame that actually matters to a reader: `health` is what a readout
    // keys its warning styling off, so a frame that reports a dead capability
    // as fine is worse than no frame at all.
    const declined = ctx.frames.find((f) => f.data.capability === 'delegate_isolation' && f.data.health !== 'ok');
    expect(declined?.data).toEqual({
      capability: 'delegate_isolation',
      stage: 'unavailable',
      reason: 'isolation_not_enforced',
      health: 'declined',
      remedy: 'not_configurable',
    });
  });

  /**
   * The user-facing distinction, and the reason this module grades reasons at
   * all: `disabled_by_config` is an opt-out someone can turn back on;
   * `isolation_not_enforced` is the engine reporting a platform fact. A
   * settings pane that offered a delegate-isolation switch would be lying.
   */
  it('separates the opt-outs from the platform fact', () => {
    const rows = replay(DEFAULT_START).cap.snapshot().rows;
    const byName = new Map(rows.map((r) => [r.capability, r]));

    expect(byName.get('smart_handoff')?.remedy).toBe('config');
    expect(byName.get('pricing_refresher')?.remedy).toBe('config');
    expect(byName.get('learned_policy')?.remedy).toBe('config');
    expect(byName.get('delegate_isolation')?.remedy).toBe('not_configurable');
    expect(byName.get('delegate_isolation')?.reason).toBe('isolation_not_enforced');
  });
});

/**
 * The second capture. One config line apart from the first, and it is the only
 * gate that was ever identified by measurement.
 */
describe('the same engine with [compact] smart_enabled = true', () => {
  it('records smart_handoff reaching ready instead of disabled_by_config', () => {
    const rows = replay(SMART_ENABLED_START).cap.snapshot().rows;
    const smart = rows.find((r) => r.capability === 'smart_handoff');

    expect(smart).toEqual(row('smart_handoff', 'ready', null, 'ok', 'unknown', 4));
    // The other seven are untouched by the flag - that is what makes it a
    // single-variable measurement rather than a coincidence.
    expect(rows.filter((r) => r.health === 'declined').map((r) => r.capability)).toEqual([
      'pricing_refresher',
      'learned_policy',
      'delegate_isolation',
    ]);
  });

  /**
   * 24 is the path length of eight capabilities under one config, not a
   * contract: turning one flag on makes it 26. Nothing here may assert a frame
   * count, so this test asserts the counts DIFFER while the row count does not.
   */
  it('changes the frame count but not the capability count', () => {
    const withFlag = replay(SMART_ENABLED_START);
    const without = replay(DEFAULT_START);

    expect(withFlag.ctx.frames.length).not.toBe(without.ctx.frames.length);
    expect(withFlag.cap.snapshot().rows).toHaveLength(without.cap.snapshot().rows.length);
    expect(withFlag.ctx.warns).toHaveLength(3);
  });
});

/**
 * The stage no capture contains, and the one the module's own reducer docstring
 * names as a capability ceasing to be what it was. Every frame here is
 * hand-built: an empty-stdin boot never runs a turn, so the engine never
 * revises a verdict during one.
 */
describe('outcome_changed - the engine revising a verdict it already gave', () => {
  const regression = [
    ready('delegate_isolation'),
    frame({ capability: 'delegate_isolation', stage: 'outcome_changed', reason: 'isolation_not_enforced' }),
  ];

  /**
   * The failure this whole module exists to remove, one layer lower. A
   * capability that was `ready` and now carries `isolation_not_enforced` is the
   * exact safety statement the acknowledged-unhandled list used to swallow. If
   * the decoder grades it as a healthy step, the readout shows a working
   * delegate isolation and the user is told a lie by a feature built to stop
   * exactly that.
   */
  it('warns about a mid-session regression instead of logging it as a healthy step', () => {
    const { ctx, cap } = replayMessages(regression);

    expect(ctx.warns).toHaveLength(1);
    expect(ctx.warns[0]).toContain('delegate_isolation');
    expect(ctx.warns[0]).toContain('isolation_not_enforced');
    expect(ctx.logs.join(' ')).not.toContain('outcome_changed');
    expect(cap.snapshot().rows).toEqual([
      row('delegate_isolation', 'outcome_changed', 'isolation_not_enforced', 'changed', 'not_configurable', 2),
    ]);
  });

  /**
   * And it reaches the renderer graded, not as a boolean guess. `changed` is
   * neither `ok` nor `declined` because the wire says neither: the engine
   * revised a verdict and did not say in which direction. A frame that claimed
   * either would be this host inventing the direction.
   */
  it('forwards it as changed, not as healthy and not as a declination', () => {
    const { ctx } = replayMessages(regression);

    expect(ctx.frames.at(-1)?.data).toEqual({
      capability: 'delegate_isolation',
      stage: 'outcome_changed',
      reason: 'isolation_not_enforced',
      health: 'changed',
      remedy: 'not_configurable',
    });
    // The words matter as much as the grade: "is unavailable" would report a
    // refusal the engine never stated.
    expect(ctx.warns[0]).toContain('revised its outcome');
    expect(ctx.warns[0]).not.toContain('is unavailable');
  });

  /**
   * The grading table for stages, the counterpart of the reason table below.
   * An unrecognised stage grades `ok` deliberately: the measured lifecycle is
   * four healthy steps and one refusal, so a stage nobody has seen is far more
   * likely to be a sixth step than a sixth way to fail, and warning on every
   * one of them would put noise in front of the four that matter. The stage
   * string is forwarded verbatim, so a readout can still show what it was.
   */
  it.each([
    ['declared', 'ok'],
    ['configured', 'ok'],
    ['constructed', 'ok'],
    ['reached', 'ok'],
    ['ready', 'ok'],
    ['unavailable', 'declined'],
    ['outcome_changed', 'changed'],
    ['a_stage_a_future_engine_adds', 'ok'],
  ])('grades stage %s as %s', (stage, expected) => {
    expect(healthOf(stage)).toBe(expected);
  });

  /**
   * Same rule as an unavailable frame with an unreadable reason: the fact that
   * the verdict CHANGED outranks the explanation of why, so the row is kept and
   * the reason recorded as null.
   */
  it('keeps the changed row when the reason is unreadable, and says so', () => {
    const { ctx, cap } = dispatchOne(frame({ stage: 'outcome_changed', reason: 7 }));

    expect(cap.snapshot().rows[0]).toEqual(row('smart_handoff', 'outcome_changed', null, 'changed', 'unknown', 1));
    expect(ctx.warns.join(' ')).toContain('could not read');
  });

  /**
   * All 24 measured frames arrive before any turn, so `activeMsgId()` is `''`
   * in every capture. The value is passed through rather than hard-coded so
   * that a late `outcome_changed` during a turn lands on that turn - the turn
   * is what caused it.
   */
  it('stamps a frame that does arrive mid-turn with the turn it arrived during', () => {
    const { ctx } = replayMessages([frame({ stage: 'outcome_changed', reason: undefined })], 'msg-7');

    expect(ctx.frames.at(-1)?.msg_id).toBe('msg-7');
    expect(ctx.frames.at(-1)?.data.health).toBe('changed');
  });
});

describe('frames the decoder must decline', () => {
  /**
   * The contract marks ONLY `type` required and validates no body, so these are
   * the real wire risk rather than a hypothetical. Declining sends the frame to
   * the acknowledged-unhandled check, which is where a frame this host cannot
   * read belongs - inventing a row for it would put a nameless entry in a
   * readout the user is meant to trust.
   */
  it.each([
    ['no capability at all', { type: EVENT, stage: 'ready' }],
    ['no stage at all', { type: EVENT, capability: 'smart_handoff' }],
    ['a numeric capability', frame({ capability: 42 })],
    ['an object stage', frame({ stage: {} })],
    ['an empty capability', frame({ capability: '' })],
    ['a whitespace-only capability', frame({ capability: '   ' })],
    ['a null stage', frame({ stage: null })],
    ['an over-long capability', frame({ capability: 'x'.repeat(MAX_FIELD_CHARS + 1) })],
    ['an over-long stage', frame({ stage: 'x'.repeat(MAX_FIELD_CHARS + 1) })],
  ])('declines a frame with %s, records nothing and says why', (_label, event) => {
    const { ctx, cap, consumed } = dispatchOne(event);

    expect(consumed[0]).toBe(false);
    expect(cap.snapshot().rows).toEqual([]);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('no readable capability/stage');
  });

  /**
   * The counter-check for the length bound: one character under the cap is
   * still a capability, so the bound is refusing over-long values rather than
   * refusing everything long.
   */
  it('accepts an id exactly at the length bound', () => {
    const id = 'x'.repeat(MAX_FIELD_CHARS);
    const { cap, consumed } = dispatchOne(frame({ capability: id, stage: 'ready', reason: undefined }));

    expect(consumed[0]).toBe(true);
    expect(cap.snapshot().rows[0].capability).toBe(id);
  });

  /**
   * What the DECLINE line says about the value it refused. The real context
   * hands `detail` to `console.warn`, which prints a string in full, and the
   * engine owns that string's length - `producer-complete.schema.json` accepts
   * a 10 MB `capability`. Passing the refused value through would turn one
   * anomalous frame into a log-file-sized write, per frame, from the path whose
   * entire job is to explain a frame being thrown away. So it is described:
   * truncated with its true length, never `JSON.stringify`d, and a non-string
   * named by its type rather than expanded.
   */
  it('describes an over-long refused value instead of logging it', () => {
    const huge = 'x'.repeat(10_000);
    const { ctx } = dispatchOne(frame({ capability: huge }));

    expect(ctx.warnLines.at(-1)?.detail).toEqual({
      capability: `${'x'.repeat(MAX_DETAIL_CHARS)}... (10000 chars)`,
      stage: 'unavailable',
    });
  });

  it.each([
    ['a numeric capability', frame({ capability: 42 }), { capability: '<number>', stage: 'unavailable' }],
    ['an object stage', frame({ stage: {} }), { capability: 'smart_handoff', stage: '<object>' }],
    ['an absent capability', { type: EVENT, stage: 'ready' }, { capability: '<absent>', stage: 'ready' }],
    ['a null stage', frame({ stage: null }), { capability: 'smart_handoff', stage: '<null>' }],
  ])('names the type of %s rather than expanding it', (_label, event, expected) => {
    const { ctx } = dispatchOne(event);

    expect(ctx.warnLines.at(-1)?.detail).toEqual(expected);
  });
});

describe('the reason field, which the contract describes not at all', () => {
  /**
   * MEASURED: `reason` appears only with `stage: 'unavailable'`. But
   * `additionalProperties: true` means the engine may say more than it does
   * today, and a host that refused a frame for carrying extra truth would be
   * deciding it knows the protocol better than the producer. Recorded, not
   * refused - and not warned about, because a healthy capability explaining
   * itself is not an operator problem.
   */
  it('tolerates and records a reason on a stage that is not unavailable', () => {
    const { ctx, cap } = dispatchOne(frame({ stage: 'configured', reason: 'dependency_unavailable' }));

    expect(cap.snapshot().rows[0]).toEqual(
      row('smart_handoff', 'configured', 'dependency_unavailable', 'ok', 'not_configurable', 1)
    );
    expect(ctx.warns).toEqual([]);
  });

  /**
   * Contract silent, resolved fail-closed: `unavailable` with no reason keeps
   * the safety-relevant fact and records the reason as null. Null grades
   * `unknown`, so no caller can mistake "not stated" for "you can switch it on".
   */
  it('keeps an unavailable row that states no reason, and refuses to guess one', () => {
    const { ctx, cap } = dispatchOne({ type: EVENT, capability: 'delegate_isolation', stage: 'unavailable' });

    expect(cap.snapshot().rows[0]).toEqual(row('delegate_isolation', 'unavailable', null, 'declined', 'unknown', 1));
    expect(ctx.warns.join(' ')).toContain('no reason stated');
  });

  /**
   * An unreadable reason is treated the same way, and for the same reason: the
   * fact that the capability is DOWN outranks the explanation of why. Dropping
   * the whole frame would hide the outage to protect a string.
   */
  it.each([
    ['a numeric reason', frame({ reason: 7 })],
    ['an array reason', frame({ reason: [] })],
    ['an over-long reason', frame({ reason: 'x'.repeat(MAX_FIELD_CHARS + 1) })],
    ['a blank reason', frame({ reason: '  ' })],
  ])('keeps the unavailable row when the reason is %s, and says the reason was unreadable', (_label, event) => {
    const { ctx, cap } = dispatchOne(event);

    expect(cap.snapshot().rows[0]).toEqual(row('smart_handoff', 'unavailable', null, 'declined', 'unknown', 1));
    expect(ctx.warns.join(' ')).toContain('could not read');
  });

  /**
   * The grading table. `config` is the ONLY value that says a switch exists,
   * and an unrecognised token must never reach it - a sixth TUI phrase
   * ("invalid activation evidence") has no wire token anyone has found, so an
   * unknown reason is a thing that will happen.
   */
  it.each([
    ['disabled_by_config', 'config'],
    ['dependency_unavailable', 'not_configurable'],
    ['no_production_constructor', 'not_configurable'],
    ['runtime_path_unwired', 'not_configurable'],
    ['isolation_not_enforced', 'not_configurable'],
    ['invalid_activation_evidence', 'unknown'],
    ['something_a_future_engine_says', 'unknown'],
  ])('grades %s as %s', (reason, expected) => {
    expect(remedyFor(reason)).toBe(expected);
  });

  it('grades an absent reason as unknown, never as a switch', () => {
    expect(remedyFor(null)).toBe('unknown');
  });
});

describe('bounds on what the wire controls', () => {
  /** 64 healthy rows, which is the record exactly full and not yet overflowed. */
  const fillToCap = (): Record<string, unknown>[] =>
    Array.from({ length: MAX_TRACKED_CAPABILITIES }, (_, i) => ready(`cap_${i}`));

  /**
   * The wire chooses the `capability` key, so the record would otherwise grow
   * without limit for the life of the engine process. MEASURED: 8 distinct ids.
   * The cap is 64 - a documented CHOICE, not a contract value.
   */
  it('records up to the cap, then refuses new capabilities and says the record is incomplete', () => {
    const many = Array.from({ length: MAX_TRACKED_CAPABILITIES + 5 }, (_, i) => ready(`cap_${i}`));
    const { ctx, cap, consumed } = replayMessages(many);

    expect(consumed.every(Boolean)).toBe(true);
    expect(cap.snapshot().rows).toHaveLength(MAX_TRACKED_CAPABILITIES);
    expect(cap.snapshot().overflowed).toBe(true);
    // Loud once, not once per frame: five refusals, one warning.
    expect(ctx.warns.filter((w) => w.includes('record is full'))).toHaveLength(1);
    expect(cap.snapshot().rows.map((r) => r.capability)).not.toContain(`cap_${MAX_TRACKED_CAPABILITIES}`);
  });

  /**
   * The other half of the bound. Evicting or freezing the capabilities a user
   * cares about because a noisy id arrived later would make the cap worse than
   * no cap at all.
   */
  it('keeps updating the capabilities it already knows once the record is full', () => {
    const fill = Array.from({ length: MAX_TRACKED_CAPABILITIES }, (_, i) =>
      frame({ capability: `cap_${i}`, stage: 'declared', reason: undefined })
    );
    const { cap } = replayMessages([...fill, ready('cap_0'), ready('overflowing')]);

    const first = cap.snapshot().rows.find((r) => r.capability === 'cap_0');
    expect(first).toEqual(row('cap_0', 'ready', null, 'ok', 'unknown', 2));
    expect(cap.snapshot().overflowed).toBe(true);
  });

  /**
   * What the cap must NOT cost: the signal. The wire picks the `capability`
   * key, so an engine that emits 64 ids before the real ones pushes every
   * genuine unavailability past the cap. The generic "record is full" line
   * fires once per process, so once it is spent, an unavailable capability
   * arriving later would otherwise be an info log reading exactly like
   * `mid_flight_monitor -> ready` - the same invisibility this module was
   * written to end, produced by the bound meant to protect it.
   *
   * The first over-cap frame here is a healthy one, deliberately: it consumes
   * the single "record is full" warning, so what is asserted afterwards is not
   * borrowing that warning's loudness.
   */
  it('still says an unavailable capability is unavailable once the record is full', () => {
    const { ctx, cap } = replayMessages([
      ...fillToCap(),
      ready('noise'),
      frame({ capability: 'delegate_isolation', reason: 'isolation_not_enforced' }),
    ]);

    const last = ctx.warns.at(-1) ?? '';
    expect(last).toContain('delegate_isolation');
    expect(last).toContain('isolation_not_enforced');
    expect(last).toContain('NOT recorded');
    // It really is absent from the record: the warning is the only place the
    // fact survives, which is why it has to be a warning.
    expect(cap.snapshot().rows.map((r) => r.capability)).not.toContain('delegate_isolation');
    expect(ctx.logs.join(' ')).not.toContain('delegate_isolation');
  });

  /**
   * The refused frame is still forwarded to the renderer, so its grade and its
   * remedy are user-visible even though no row exists. A refused capability
   * graded `unknown` would hide an opt-out a settings pane could act on; graded
   * `ok` it would render as healthy. `frames: 0` is the row's own statement
   * that it contributed nothing to the record - the number a reader uses to
   * tell a refused row from a recorded one.
   */
  it('grades the refused frame it forwards, and reports it as contributing no frames', () => {
    const { ctx } = replayMessages([
      ...fillToCap(),
      frame({ capability: 'delegate_isolation', reason: 'isolation_not_enforced' }),
    ]);

    expect(ctx.frames.at(-1)?.data).toEqual({
      capability: 'delegate_isolation',
      stage: 'unavailable',
      reason: 'isolation_not_enforced',
      health: 'declined',
      remedy: 'not_configurable',
    });
    expect(ctx.warnLines.at(-1)?.detail).toEqual(
      row('delegate_isolation', 'unavailable', 'isolation_not_enforced', 'declined', 'not_configurable', 0)
    );
  });

  /**
   * Frame VOLUME is wire-controlled too, and every announced frame costs an IPC
   * hop to the renderer. 256 is ~10x a measured start, so a real engine never
   * reaches it. Past the budget the frames are still RECORDED - the record is
   * bounded by row count already - so the readiness picture stays correct while
   * the renderer stops being fed.
   */
  it('stops forwarding past the announce budget, keeps recording, and warns once', () => {
    const flood = Array.from({ length: MAX_ANNOUNCED_FRAMES + 3 }, () => ready('mid_flight_monitor'));
    const { ctx, cap } = replayMessages(flood);

    expect(ctx.frames).toHaveLength(MAX_ANNOUNCED_FRAMES);
    expect(cap.snapshot().rows[0].frames).toBe(MAX_ANNOUNCED_FRAMES + 3);
    expect(ctx.warns.filter((w) => w.includes('no longer forwarded'))).toHaveLength(1);
  });

  it('leaves a normal start far below both bounds', () => {
    const { ctx, cap } = replay(DEFAULT_START);
    expect(ctx.frames.length).toBeLessThan(MAX_ANNOUNCED_FRAMES);
    expect(cap.snapshot().rows.length).toBeLessThan(MAX_TRACKED_CAPABILITIES);
  });
});

/**
 * `WCoreAgent` respawns the engine. Without a reset on the new `ready`, the
 * readout would show the dead process's outcomes - the stale picture this
 * module exists to remove. `ready` never reaches the dispatcher, so this is the
 * only way the record can be cleared.
 *
 * Four pieces of state get cleared and each is asserted separately, because
 * replaying a healthy capture proves only the first: that capture never
 * overflows and never exhausts the budget, so for the other three the
 * pre-reset state already equals the post-reset state and the assertion cannot
 * fail.
 */
describe('per-engine state', () => {
  const flood = (): Record<string, unknown>[] =>
    Array.from({ length: MAX_ANNOUNCED_FRAMES + 1 }, () => ready('mid_flight_monitor'));

  it('reset clears the rows', () => {
    const { cap } = replay(DEFAULT_START);
    expect(cap.snapshot().rows).toHaveLength(8);

    cap.reset();
    expect(cap.snapshot()).toEqual({ rows: [], overflowed: false });

    const dispatch = createDispatcher([cap]);
    expect(dispatch(frame(), makeContext())).toBe(true);
    expect(cap.snapshot().rows[0].frames).toBe(1);
  });

  /**
   * Without this the UI keeps telling a healthy engine's user that the
   * readiness record is incomplete, forever, because one dead process once
   * announced too many ids.
   */
  it('reset clears the overflow flag and makes room for new capabilities again', () => {
    const { cap } = replayMessages(Array.from({ length: MAX_TRACKED_CAPABILITIES + 1 }, (_, i) => ready(`cap_${i}`)));
    expect(cap.snapshot().overflowed).toBe(true);

    cap.reset();
    expect(cap.snapshot().overflowed).toBe(false);

    createDispatcher([cap])(frame(), makeContext());
    expect(cap.snapshot().rows).toHaveLength(1);
  });

  /**
   * The budget is per engine process, or a long-lived app stops forwarding
   * activation frames after enough respawns - the readout would simply go blank
   * for the fourth engine of the session and stay that way.
   */
  it('reset restores the announce budget', () => {
    const { cap, ctx } = replayMessages(flood());
    const dispatch = createDispatcher([cap]);
    expect(ctx.frames).toHaveLength(MAX_ANNOUNCED_FRAMES);

    expect(dispatch(frame(), ctx)).toBe(true);
    expect(ctx.frames, 'the budget was not exhausted before the reset').toHaveLength(MAX_ANNOUNCED_FRAMES);

    cap.reset();
    expect(dispatch(frame(), ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(MAX_ANNOUNCED_FRAMES + 1);
  });

  /**
   * And the once-per-process exhaustion warning is re-armed with it. A new
   * engine that floods must say so; inheriting "already warned" from the dead
   * process means the second flood is silent.
   */
  it('reset re-arms the budget-exhaustion warning', () => {
    const { cap, ctx } = replayMessages(flood());
    expect(ctx.warns.filter((w) => w.includes('no longer forwarded'))).toHaveLength(1);

    cap.reset();
    const dispatch = createDispatcher([cap]);
    for (const message of flood()) dispatch(message, ctx);

    expect(ctx.warns.filter((w) => w.includes('no longer forwarded'))).toHaveLength(2);
  });

  it('two instances do not share a record', () => {
    const a = createCapabilityActivationCapability();
    const b = createCapabilityActivationCapability();
    createDispatcher([a])(frame(), makeContext());

    expect(a.snapshot().rows).toHaveLength(1);
    expect(b.snapshot().rows).toEqual([]);
    // The exposed reducer is per instance too - a diagnostics readout that
    // reached for a shared one would report the wrong engine's readiness. And
    // it is the SAME reducer the handler folds into, not a second one kept
    // beside it: a readout reading `record` would otherwise always see zero
    // rows.
    expect(a.record).not.toBe(b.record);
    expect(a.record.snapshot().rows).toHaveLength(1);
    expect(b.record.snapshot().rows).toEqual([]);
  });

  /**
   * The module-level accessors are what `wcore/index.ts` and a diagnostics
   * readout will call, so they must actually reach the registry instance rather
   * than a fresh one.
   */
  it('the module-level snapshot and reset operate on the registry instance', () => {
    resetCapabilityActivation();
    expect(readCapabilityActivationSnapshot()).toEqual({ rows: [], overflowed: false });

    createDispatcher([capabilityActivationCapability])(frame(), makeContext());
    expect(readCapabilityActivationSnapshot().rows).toEqual([
      row('smart_handoff', 'unavailable', 'disabled_by_config', 'declined', 'config', 1),
    ]);

    resetCapabilityActivation();
    expect(readCapabilityActivationSnapshot().rows).toEqual([]);
  });
});

describe('routing, through the dispatcher production uses', () => {
  beforeEach(() => {
    resetCapabilityActivation();
  });

  /**
   * Claiming a type must not widen the dispatcher into consuming anything else.
   * `unknown-noncritical` is the shape the bundle uses for a future
   * observational event; it must still fall through to the acknowledged-unhandled
   * check. Relevant here because activation frames carry no `critical` field at
   * all (MEASURED), i.e. they are non-critical by omission - a decoder that
   * routed on that property rather than on `type` would swallow this one.
   */
  it('declines the unknown-noncritical fixture', () => {
    const [event] = readFixture('adversarial/events/unknown-noncritical.jsonl');
    const { consumed, ctx } = dispatchOne(event);

    expect(event.critical).toBe(false);
    expect(consumed[0]).toBe(false);
    expect(ctx.warns).toEqual([]);
  });

  /**
   * The one that must never be swallowed: an unknown CRITICAL event has to
   * reach the reject path. If claiming `capability_activation` had widened the
   * dispatcher, this is where it would show.
   */
  it('declines the unknown-critical fixture so it still reaches the reject path', () => {
    const [event] = readFixture('adversarial/events/unknown-critical.jsonl');
    const { consumed, ctx } = dispatchOne(event);

    expect(event.critical).toBe(true);
    expect(consumed[0]).toBe(false);
    expect(ctx.frames).toEqual([]);
  });

  /**
   * No command is ever sent, and this proves it rather than asserting it: the
   * recorder's `sendCommand` throws, the dispatcher swallows a throwing handler
   * and reports the event UNHANDLED, so a `true` here is only reachable if
   * nothing was sent. There is nothing to gate on `contractNegotiation` because
   * the engine grades no capability for this event at all.
   */
  it('sends no commands while consuming a whole engine start', () => {
    const cap = createCapabilityActivationCapability();
    const dispatch = createDispatcher([cap]);
    const ctx = makeContext();

    for (const event of readFixture(DEFAULT_START)) {
      expect(dispatch(event, ctx), String(event.capability)).toBe(true);
    }
  });

  /**
   * THE REGISTRATION GUARD. This capability is not in `HANDLERS` yet, and
   * `'capability_activation'` is still in `ACKNOWLEDGED_UNHANDLED_EVENTS`.
   * Exactly one of those must be true at any time: a type that is both claimed
   * and knowingly-inert makes the acknowledged list lie about what the host
   * does, and `wcore-capabilityDispatch.test.ts` fails on the overlap. So the
   * day someone adds this module to `HANDLERS` without deleting the
   * acknowledged entry, this goes red and names the missing edit.
   */
  it('is either claimed by a registered capability or listed inert - never both, never neither', () => {
    const claimed = new Set(claimedEventTypes()).has(EVENT);
    const inert = ACKNOWLEDGED_UNHANDLED_EVENTS.has(EVENT);

    expect(
      claimed !== inert,
      claimed
        ? `${EVENT} is claimed AND listed inert - delete it from ACKNOWLEDGED_UNHANDLED_EVENTS`
        : `${EVENT} is neither claimed nor listed inert - the decoder will warn on all 24 frames every start`
    ).toBe(true);
  });

  /**
   * The name is not decoration: `createDispatcher` prefixes every log and warn
   * line this module produces with `[${handler.name}]`, so it is the string an
   * operator greps for when asking why smart compaction does nothing. It
   * matches the event type because that is the name the engine uses for the
   * same subject.
   */
  it('claims exactly the one event type it decodes, and logs under that name', () => {
    const { ctx } = dispatchOne(ready('mid_flight_monitor'));

    expect(capabilityActivationCapability.handles).toEqual([EVENT]);
    expect(capabilityActivationCapability.name).toBe(EVENT);
    expect(ctx.logs[0]).toContain(`[${EVENT}]`);
  });
});
