/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Engine capability activation - what this engine build can actually do.
 *
 * WHAT THIS IS. Every start, the engine announces the activation lifecycle of
 * its own internal capabilities, one frame per step. MEASURED on the bundled
 * v0.12.26 binary (win32-x64, isolated empty `WAYLAND_HOME`, `--json-stream`,
 * empty stdin): 24 frames covering 8 capabilities. Six walk
 * `declared -> configured -> constructed -> ready`. Three stop at
 * `unavailable / disabled_by_config` (`pricing_refresher`, `learned_policy`,
 * `smart_handoff`) and one at `unavailable / isolation_not_enforced`
 * (`delegate_isolation`). Both captures live in
 * `tests/fixtures/engine-contract/desktop/v1/observed/`.
 *
 * WHY DROPPING IT IS THE BUG. Darhai currently lists `capability_activation` in
 * `ACKNOWLEDGED_UNHANDLED_EVENTS`, so all 24 frames are discarded in silence.
 * Two facts die with them:
 *
 *  - smart compaction is OFF for every user. `smart_handoff` reports
 *    `disabled_by_config`, and `[compact] smart_enabled = true` alone flips it
 *    to `ready` (MEASURED twice, in two isolated homes, single variable). Users
 *    hit compaction constantly; "why does smart compaction do nothing" is
 *    currently unanswerable because the engine's own answer is thrown away.
 *  - `delegate_isolation: isolation_not_enforced` is the engine saying delegate
 *    isolation is NOT being enforced on this platform, while Darhai advertises
 *    sub-agents. That is a safety statement the user cannot see today.
 *
 * WHAT THE CONTRACT SETTLES: ALMOST NOTHING. `capability_activation` is absent
 * from `manifest.json`, absent from `events/`, and absent from
 * `core-event.schema.json` (which therefore REJECTS every real frame - proved
 * in the tests). Its only appearance is `producer-complete.schema.json`
 * anyOf[76], "Non-Desktop producer inventory discriminator": `required: [type]`,
 * `additionalProperties: true`, ZERO declared properties. That schema accepts
 * `{type, capability: 42, stage: {}, reason: []}` - also proved in the tests.
 * `DEFERRED.md` says it outright: a host "can recognise the tag and can
 * validate NOTHING about the body". So every field name, stage value and reason
 * token below comes from running the binary, not from the contract, and every
 * one of them is re-checked at the decode boundary here. Schema validation
 * cannot do it for us.
 *
 * WHAT THIS MODULE DOES NOT DO. It sends no commands - there is no
 * `capability_activation` entry in the manifest, so there is no command surface
 * and nothing to gate on `contractNegotiation`. (Gating the READING of these
 * frames on the negotiated contract would be worse than useless: the engine
 * does not grade this event at all, so `gradeOf` answers `unavailable` and the
 * host would refuse to read frames it is demonstrably receiving.) It also never
 * faults the turn: a readiness readout is not worth losing a conversation over,
 * which is why an unreadable frame is declined rather than thrown on.
 *
 * WHAT THIS MODULE REQUIRES BEFORE IT DOES ANYTHING - NOT IN THIS FILE.
 *
 * As of this file, none of the three edits below has landed. The consequences
 * are present-tense and total: `dispatchCapabilityEvent` never routes here, so
 * `handle` is not called in the running app; and because
 * `WCoreManager`'s pass-through set is built from `claimedEventTypes()` - the
 * union of the REGISTERED handlers' `handles` - a `capability_activation` frame
 * emitted from here would be dropped there. Everything this module does is
 * therefore exercised by its tests and by nothing else, until:
 *
 *  1. `capabilities/index.ts` lists {@link capabilityActivationCapability} in
 *     `HANDLERS`. That, and only that, makes `dispatchCapabilityEvent` route
 *     here and puts `'capability_activation'` into `claimedEventTypes()`.
 *  2. `protocol.ts` DROPS `'capability_activation'` from
 *     `ACKNOWLEDGED_UNHANDLED_EVENTS` in the same change - a type may not be
 *     both claimed and knowingly-inert, and `wcore-capabilityDispatch.test.ts`
 *     enforces that. The guard for it is in this capability's own test file, so
 *     registering without the deletion goes red immediately.
 *  3. `wcore/index.ts`'s `case 'ready':` arm calls
 *     {@link resetCapabilityActivation}. `ready` has its own arm and never
 *     reaches the dispatcher, so a respawned engine would otherwise keep the
 *     previous process's readiness rows - the exact stale-picture failure this
 *     module exists to remove.
 */

import type { CapabilityContext, CapabilityHandler } from '../types';

/**
 * Engine capability ids carried by `capability_activation`.
 *
 * MEASURED on wayland-core 0.12.26: these 8 appear at every start, in this
 * emission order. The contract declares no such list, so the wire type below
 * stays open - a bumped engine may add a ninth and this host must still record
 * it rather than drop it.
 */
export type EngineCapabilityId =
  | 'pricing_refresher'
  | 'mid_flight_monitor'
  | 'cooldown_tracker'
  | 'learned_policy'
  | 'smart_handoff'
  | 'delegate_isolation'
  | 'procedure_skill_drafting'
  | 'legacy_auto_skill_drafting';

/**
 * Activation lifecycle stage.
 *
 * MEASURED on the wire: `declared` | `configured` | `constructed` | `ready` |
 * `unavailable`. `reached` and `outcome_changed` are interned next to them in
 * the binary's variant table and match the engine TUI's "runtime path reached" /
 * "outcome changed" labels, so they are named here - but they were NOT observed
 * in any run, likely because an empty-stdin boot never runs a turn.
 */
export type CapabilityActivationStage =
  | 'declared'
  | 'configured'
  | 'constructed'
  | 'reached'
  | 'ready'
  | 'outcome_changed'
  | 'unavailable';

/**
 * Why a capability stopped at `stage: 'unavailable'`.
 *
 * Five tokens form one interned run in the binary; the TUI renders them as
 * "disabled by configuration", "required dependency unavailable", "no
 * production constructor", "runtime path not wired", "isolation not enforced".
 * The TUI carries a sixth phrase, "invalid activation evidence", with no wire
 * token found - hence the widening at the use site.
 */
export type CapabilityUnavailableReason =
  | 'disabled_by_config'
  | 'dependency_unavailable'
  | 'no_production_constructor'
  | 'runtime_path_unwired'
  | 'isolation_not_enforced';

/**
 * The event as it arrives.
 *
 * `capability` and `stage` are declared required here because 24/24 measured
 * frames carried them - but the CONTRACT requires only `type`, so this type is
 * a description of the engine we measured, never a promise the decoder may lean
 * on. {@link CapabilityActivationRecord.accept} re-checks both at the decode
 * boundary. Every member is widened with `(string & {})` because the contract
 * closes none of these sets.
 *
 * Deliberately NOT added to the `WCoreEvent` union in `protocol.ts`: a name may
 * not be both in that union and in `ACKNOWLEDGED_UNHANDLED_EVENTS`, and
 * `wcore-eventCoverage.test.ts` scans the union block by regex. It is a
 * standalone alias so the two existing coverage tests stay meaningful.
 */
export type WCoreCapabilityActivationEvent = {
  type: 'capability_activation';
  capability: EngineCapabilityId | (string & {});
  stage: CapabilityActivationStage | (string & {});
  /** MEASURED: present if and only if `stage === 'unavailable'`. */
  reason?: CapabilityUnavailableReason | (string & {});
};

/**
 * What this host can honestly say about a capability, from its stage alone.
 *
 * This is a THREE-valued grade rather than an `unavailable` boolean, and the
 * third value is the whole point. `outcome_changed` is the engine revising a
 * verdict it already gave. Graded `ok` it renders as a healthy step, which is
 * how a mid-session `delegate_isolation / isolation_not_enforced` regression
 * would become invisible again - the exact failure this module exists to
 * remove, reintroduced one layer lower. Graded `declined` it would claim the
 * engine refused to activate the capability, which the frame does not say.
 * Neither boolean answer is true, so there is no boolean.
 *
 *  - `ok`       - a lifecycle step (`declared`, `configured`, `constructed`,
 *                 `reached`, `ready`), or any stage a future engine adds that
 *                 this host has never been told is bad news.
 *  - `declined` - `stage: 'unavailable'`. The engine refused to activate it.
 *  - `changed`  - `stage: 'outcome_changed'`. An earlier verdict no longer
 *                 holds. The wire does NOT say in which direction, so a readout
 *                 must show the stage and the reason rather than a verdict of
 *                 its own.
 *
 * A readout keys its warning styling off THIS, not off `stage`: the stage set
 * is open and a host comparing against `'unavailable'` by hand is one engine
 * bump away from the same silence.
 */
export type CapabilityHealth = 'ok' | 'declined' | 'changed';

/**
 * What a host may honestly tell the user about a capability's stated reason.
 *
 * This is the one judgement this module makes, and it exists because the two
 * measured reason tokens are NOT the same kind of fact:
 *
 *  - `disabled_by_config` is an opt-out. Some config key turns it back on.
 *  - `isolation_not_enforced` is a platform statement. `delegate_isolation`
 *    stayed unavailable even with the workspace sandbox active
 *    (`workspace_policy` reported profile=strict, backend=appcontainer in the
 *    same run). Offering a switch for it would be offering a lie.
 *
 * Anything this host has never been told about grades `unknown`, which the UI
 * must treat exactly like `not_configurable`. Failing the other way - assuming
 * an unrecognised token is a toggle - is how a settings pane grows a control
 * that does nothing.
 *
 * `config` does NOT mean Darhai knows WHICH key. Only `smart_handoff`'s gate
 * was ever identified (`[compact] smart_enabled`); `pricing_refresher` and
 * `learned_policy` report the same token with a key that 20+ measured
 * candidates failed to find. Do not ship a toggle for those on a guess.
 */
export type CapabilityRemedy = 'config' | 'not_configurable' | 'unknown';

/** One capability's current activation state. */
export type CapabilityActivationRow = {
  capability: string;
  stage: string;
  /** Null when absent, unreadable, or over-long - never invented. */
  reason: string | null;
  /** This host's grade of {@link CapabilityActivationRow.stage}. */
  health: CapabilityHealth;
  /**
   * Graded from `reason` whenever the engine stated a readable one, at ANY
   * stage - not only at `unavailable`. A reason carried by an
   * `outcome_changed` frame is exactly as actionable as the same token on an
   * `unavailable` one, and dropping it there is how a regression loses its
   * explanation. `unknown` when no reason was stated or none could be read.
   */
  remedy: CapabilityRemedy;
  /** How many frames this capability has contributed since the last reset. */
  frames: number;
};

/**
 * The readiness record: one row per capability, in first-seen order.
 *
 * `overflowed` says the record is INCOMPLETE - more distinct capability ids
 * arrived than {@link MAX_TRACKED_CAPABILITIES} allows, so some are missing. A
 * readout that silently shows fewer rows than the engine announced would be the
 * same class of quiet lie this module exists to remove.
 */
export type CapabilityActivationSnapshot = {
  rows: readonly CapabilityActivationRow[];
  overflowed: boolean;
};

/** The frame forwarded to the task layer / renderer. */
export type CapabilityActivationFrame = {
  capability: string;
  stage: string;
  reason: string | null;
  /** What a readout keys its styling off. See {@link CapabilityHealth}. */
  health: CapabilityHealth;
  remedy: CapabilityRemedy;
};

/**
 * How many distinct capability ids one engine process may register.
 *
 * The wire chooses this key, so without a cap a buggy or hostile engine grows
 * the record without limit for the life of the process. MEASURED: 8. The cap is
 * 64 - eight times the observed set, room for several engine bumps, and small
 * enough that the worst case is a few kilobytes. It is a CHOICE, not a contract
 * value; nothing upstream bounds it.
 *
 * Past the cap, new ids are refused and existing rows keep updating. Refusing
 * the NEW ones keeps the eight capabilities a user actually cares about
 * readable instead of letting noise evict them. A refused frame is still
 * DESCRIBED to the operator - see the overflow branch of
 * {@link CapabilityActivationRecord.accept} - because the thing an engine most
 * plausibly pushes past the cap is the unavailability that matters.
 */
export const MAX_TRACKED_CAPABILITIES = 64;

/**
 * Longest wire string this host will store for `capability`, `stage` or
 * `reason`.
 *
 * MEASURED longest values: `legacy_auto_skill_drafting` (26),
 * `outcome_changed` (15), `no_production_constructor` (25). 128 is ~5x the
 * longest observed. Also a CHOICE. An over-long value is refused rather than
 * truncated, because a truncated id silently merges two capabilities into one
 * row - a wrong record is worse than a missing one.
 */
export const MAX_FIELD_CHARS = 128;

/**
 * Longest DESCRIPTION of an unreadable wire value this host will put in a log
 * line.
 *
 * The engine controls these strings and nothing upstream bounds their length: a
 * `capability` of 10 MB is a legal `producer-complete` frame, and the host's
 * `warn` hands its detail straight to `console.warn`, which serialises a string
 * in full. An unbounded id would therefore be a log-file-sized write per frame,
 * repeated for every such frame, from a path that exists purely to explain a
 * frame this host is throwing away.
 *
 * At the bound the value is TRUNCATED with its true length appended, not
 * refused - the opposite of {@link MAX_FIELD_CHARS}, and for the opposite
 * reason: nothing keys on this text, it is a human hint, and "the id started
 * like this and was 10485760 chars long" is the useful thing to print. 64 is a
 * CHOICE: 2.4x the longest measured id (26 chars), enough to recognise a
 * mangled or typo'd one at a glance.
 */
export const MAX_DETAIL_CHARS = 64;

/**
 * How many frames one engine process may forward to the renderer.
 *
 * The wire controls how many frames arrive, and each accepted frame costs an
 * IPC hop. MEASURED: 24 per start (26 with `[compact] smart_enabled = true`).
 * The budget is 256, ~10x the observed start, so every real start announces in
 * full. Past it, frames are still RECORDED - the record is bounded by row count
 * already - but no longer announced, and the budget exhaustion is warned once.
 *
 * Note there is no loop over a wire value anywhere in this module: the event
 * carries no array and no count. Frame volume, distinct-id count and field
 * length are the only things the wire controls, and all three are bounded here.
 */
export const MAX_ANNOUNCED_FRAMES = 256;

/** The stage at which a capability has given up. */
const UNAVAILABLE: CapabilityActivationStage = 'unavailable';

/** The stage at which the engine revises a verdict it already gave. */
const OUTCOME_CHANGED: CapabilityActivationStage = 'outcome_changed';

/** The one stage MEASURED to mean "this capability is working". */
const READY: CapabilityActivationStage = 'ready';

/**
 * Reason tokens that are NOT an opt-out.
 *
 * `dependency_unavailable` is in here deliberately: something else is missing,
 * so there is no switch on THIS capability to offer, whatever the operator may
 * eventually do about the dependency.
 */
const NOT_CONFIGURABLE_REASONS: ReadonlySet<string> = new Set<CapabilityUnavailableReason>([
  'dependency_unavailable',
  'no_production_constructor',
  'runtime_path_unwired',
  'isolation_not_enforced',
]);

/**
 * A wire string this host is willing to store, or null.
 *
 * Blank and whitespace-only values are refused: a row keyed on `'   '` is not a
 * capability, it is a decoding accident wearing one's clothes.
 */
function readWireString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  if (value.trim().length === 0) return null;
  return value;
}

/**
 * A bounded, human-readable description of a value this host refused.
 *
 * Never the value itself past {@link MAX_DETAIL_CHARS}, and never a
 * `JSON.stringify` of it: the wire owns both the length and the shape, so a
 * non-string is named by its type rather than expanded. See MAX_DETAIL_CHARS
 * for why truncating is right here and refusing is right at the decode
 * boundary.
 */
function describeWireValue(value: unknown): string {
  if (value === undefined) return '<absent>';
  if (value === null) return '<null>';
  if (typeof value !== 'string') return `<${typeof value}>`;
  if (value.length <= MAX_DETAIL_CHARS) return value;
  return `${value.slice(0, MAX_DETAIL_CHARS)}... (${value.length} chars)`;
}

/** How a host should describe an `unavailable` reason. See {@link CapabilityRemedy}. */
export function remedyFor(reason: string | null): CapabilityRemedy {
  if (reason === 'disabled_by_config') return 'config';
  if (reason !== null && NOT_CONFIGURABLE_REASONS.has(reason)) return 'not_configurable';
  return 'unknown';
}

/**
 * This host's grade of one stage. See {@link CapabilityHealth}.
 *
 * Exported because the record, the forwarded frame and any readout must all use
 * the same grading. A second copy of this rule anywhere is how one of them ends
 * up calling a regression healthy.
 */
export function healthOf(stage: string): CapabilityHealth {
  if (stage === UNAVAILABLE) return 'declined';
  if (stage === OUTCOME_CHANGED) return 'changed';
  return 'ok';
}

/**
 * The operator-facing sentence for a stage this host will not call healthy, or
 * null when the stage is a healthy step.
 *
 * `declined` and `changed` get different words on purpose: "is unavailable" is
 * a statement about the engine's decision, "revised its outcome" is a statement
 * that a decision was replaced. Printing the second as the first would tell the
 * operator something the wire never said.
 */
function concernFor(
  capability: string,
  stage: string,
  reason: string | null,
  reasonUnreadable: boolean
): string | null {
  const health = healthOf(stage);
  if (health === 'ok') return null;
  const what =
    health === 'declined'
      ? `engine capability "${capability}" is unavailable`
      : `engine capability "${capability}" revised its outcome after activation`;
  return reasonUnreadable
    ? `${what}; the engine stated a reason this host could not read`
    : `${what} (${reason ?? 'no reason stated'})`;
}

/** Internal row: the public shape plus the warn-dedup key. */
type TrackedRow = CapabilityActivationRow & {
  /**
   * `stage|reason` of the last OUTCOME this capability reported - a concern
   * that was warned about, or the `ready` that revoked one. Empty until the
   * capability reaches either.
   */
  lastWarned: string;
};

/**
 * The reducer: 24 frames in, an 8-row readiness record out.
 *
 * Last-write-wins per capability. That is right for the measured stream because
 * each capability's frames arrive contiguously and in lifecycle order, so the
 * last one IS the terminal state - and it is right for `outcome_changed` too,
 * which is by definition the engine's newest word about a capability, replacing
 * an earlier one. Keeping a per-capability history instead was rejected: it
 * grows without bound on a stream the wire controls, and nothing in the UI
 * needs the path, only the destination.
 *
 * Pure and dependency-free, so the measured captures drive the same code
 * production runs.
 */
export class CapabilityActivationRecord {
  private readonly rows = new Map<string, TrackedRow>();
  private overflowed = false;
  private announced = 0;
  private budgetWarned = false;

  /** Forget everything. For a NEW engine process only. */
  reset(): void {
    this.rows.clear();
    this.overflowed = false;
    this.announced = 0;
    this.budgetWarned = false;
  }

  /** The readiness record, in the order capabilities were first seen. */
  snapshot(): CapabilityActivationSnapshot {
    const rows = [...this.rows.values()].map(
      ({ capability, stage, reason, health, remedy, frames }): CapabilityActivationRow => ({
        capability,
        stage,
        reason,
        health,
        remedy,
        frames,
      })
    );
    return { rows, overflowed: this.overflowed };
  }

  /**
   * Fold one frame in. Returns the row to announce, or null when the frame was
   * too unreadable to be worth a row.
   *
   * `reason` is handled differently from `capability`/`stage` on purpose. An
   * unreadable capability or stage leaves nothing to say. An unreadable REASON
   * still leaves the safety-relevant fact - this capability is unavailable - so
   * the row is kept and the reason is recorded as null rather than the whole
   * frame being dropped. Null means "not stated", and it grades `unknown`, so
   * no caller can mistake it for an opt-out.
   */
  accept(event: Record<string, unknown>): { row: CapabilityActivationRow; warn: string | null } | null {
    const capability = readWireString(event.capability, MAX_FIELD_CHARS);
    const stage = readWireString(event.stage, MAX_FIELD_CHARS);
    // The contract marks ONLY `type` required and validates no body at all, so
    // this is the real wire risk, not a hypothetical. Returning null lets the
    // handler decline the frame instead of inventing a row for it.
    if (capability === null || stage === null) return null;

    // A reason on a non-unavailable stage is TOLERATED and recorded:
    // `additionalProperties: true` means the engine may say more than it does
    // today, and refusing a frame for carrying extra truth would be a host
    // deciding it knows the protocol better than the producer.
    const reason =
      event.reason === undefined || event.reason === null ? null : readWireString(event.reason, MAX_FIELD_CHARS);
    const unreadableReason = event.reason !== undefined && event.reason !== null && reason === null;
    const concern = concernFor(capability, stage, reason, unreadableReason);

    const existing = this.rows.get(capability);
    if (existing === undefined && this.rows.size >= MAX_TRACKED_CAPABILITIES) {
      const first = !this.overflowed;
      this.overflowed = true;
      // A refused frame still gets ITS OWN verdict, not the generic overflow
      // line. The wire picks the `capability` key, so an engine that emits 64
      // ids before the real ones pushes every genuine unavailability down this
      // path; logging those at info level next to `mid_flight_monitor -> ready`
      // would drop the one signal the cap is not there to suppress.
      //
      // No dedupe here, unlike the recorded path: a refused capability keeps no
      // row, so there is nowhere to remember what was already said, and a
      // second wire-keyed map to hold it would be exactly the unbounded growth
      // the cap exists to prevent. One line per frame is what this module does
      // for every frame anyway.
      return {
        row: { capability, stage, reason, health: healthOf(stage), remedy: remedyFor(reason), frames: 0 },
        warn:
          concern !== null
            ? `${concern}; it is NOT recorded - the capability record is full at ${MAX_TRACKED_CAPABILITIES} entries`
            : first
              ? `capability record is full at ${MAX_TRACKED_CAPABILITIES} entries; "${capability}" and any further new capability are NOT recorded`
              : null,
      };
    }

    // Warn ONCE per distinct outcome, not once per frame: the engine re-states
    // an unavailable capability on every start, and a host that warns each time
    // teaches the operator to scroll past the one line that matters.
    //
    // The key is the LAST OUTCOME reported, not every outcome ever reported, so
    // a capability that fails, recovers and fails again warns twice - three
    // real events, two of which the operator must see. Only the two stages that
    // ARE an outcome move the key: a concern sets it, `ready` (the one measured
    // stage meaning "working") revokes it, and the mid-lifecycle steps
    // (`declared`/`configured`/`constructed`/`reached`) leave it alone - which
    // is what keeps a replayed or re-delivered start from warning twice about
    // the same unchanged outcome.
    const outcome = `${stage}|${reason ?? ''}`;
    const previous = existing?.lastWarned ?? '';
    const warn = concern !== null && previous !== outcome ? concern : null;

    const row: TrackedRow = {
      capability,
      stage,
      reason,
      health: healthOf(stage),
      remedy: remedyFor(reason),
      frames: (existing?.frames ?? 0) + 1,
      lastWarned: concern !== null || stage === READY ? outcome : previous,
    };

    this.rows.set(capability, row);
    return {
      row: {
        capability,
        stage,
        reason,
        health: row.health,
        remedy: row.remedy,
        frames: row.frames,
      },
      warn,
    };
  }

  /**
   * May another frame be forwarded? Consumes one unit of the budget.
   *
   * Returns the warning to raise the first time the budget runs out, so the
   * exhaustion is visible exactly once.
   */
  takeAnnounceBudget(): { allowed: boolean; warn: string | null } {
    if (this.announced < MAX_ANNOUNCED_FRAMES) {
      this.announced += 1;
      return { allowed: true, warn: null };
    }
    if (this.budgetWarned) return { allowed: false, warn: null };
    this.budgetWarned = true;
    return {
      allowed: false,
      warn: `engine announced more than ${MAX_ANNOUNCED_FRAMES} capability_activation frames; further frames are recorded but no longer forwarded`,
    };
  }
}

/** The capability, plus the seams a decoder and a diagnostics readout need. */
export type CapabilityActivationCapability = CapabilityHandler & {
  /** The record this handler folds into. */
  readonly record: CapabilityActivationRecord;
  /** The readiness record. */
  snapshot(): CapabilityActivationSnapshot;
  /** Forget everything; for a new engine process. */
  reset(): void;
};

/**
 * Build a capability bound to its own record.
 *
 * A factory because the record is per-engine state: one shared instance across
 * two engine processes would show one process's readiness for the other's.
 */
export function createCapabilityActivationCapability(): CapabilityActivationCapability {
  const record = new CapabilityActivationRecord();

  return {
    name: 'capability_activation',
    handles: ['capability_activation'],
    record,

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      const accepted = record.accept(event);
      if (accepted === null) {
        // Declining is the honest answer: the frame named no capability or no
        // stage, so there is nothing to record and nothing to show. `false`
        // sends it to the acknowledged-unhandled check, which is where an
        // engine frame this host cannot read belongs.
        //
        // This warns on EVERY such frame, unlike the once-per-outcome warning
        // below, and deliberately so. An unavailable capability is re-announced
        // structurally on every single start, so warning per frame would be
        // noise; a frame naming no capability at all is something the measured
        // engine never emits, and once it starts, per-frame detail is exactly
        // what an operator needs. The decoder's default arm will warn about the
        // same frame too - two lines for a genuinely anomalous frame is a price
        // worth paying, and suppressing this one would not silence that one.
        //
        // The offending values are DESCRIBED, never passed through: they are
        // the two fields this host just refused, so their length and shape are
        // whatever the engine chose. See {@link describeWireValue}.
        ctx.warn('capability_activation frame carries no readable capability/stage; declining it', {
          capability: describeWireValue(event.capability),
          stage: describeWireValue(event.stage),
        });
        return false;
      }

      if (accepted.warn !== null) ctx.warn(accepted.warn, accepted.row);
      else ctx.log(`${accepted.row.capability} -> ${accepted.row.stage}`, accepted.row);

      const budget = record.takeAnnounceBudget();
      if (budget.warn !== null) ctx.warn(budget.warn);
      if (budget.allowed) {
        const frame: CapabilityActivationFrame = {
          capability: accepted.row.capability,
          stage: accepted.row.stage,
          reason: accepted.row.reason,
          health: accepted.row.health,
          remedy: accepted.row.remedy,
        };
        // The type MUST be one this handler `handles`. `WCoreManager` forwards
        // a frame only when its type is in the set built from
        // `claimedEventTypes()`, and drops anything else below the msg_id guard
        // - silently. That set is built from the REGISTERED handlers, which
        // today do not include this one, so every frame emitted here is dropped
        // there until step 1 of the wiring note at the top of this file lands.
        // Emitting under a type this handler does not claim would keep it
        // dropped afterwards too, which is why the name is repeated rather than
        // taken from the event.
        //
        // `activeMsgId()` rather than a hard-coded '': every measured frame
        // arrives before any turn, so in practice this IS ''. The one case
        // where it is not is a late `outcome_changed` during a turn - and an
        // outcome that changes mid-turn was caused by that turn, so filing it
        // there is more informative, not less.
        ctx.emit({ type: 'capability_activation', data: frame, msg_id: ctx.activeMsgId() });
      }

      return true;
    },

    snapshot(): CapabilityActivationSnapshot {
      return record.snapshot();
    },

    reset(): void {
      record.reset();
    },
  };
}

/**
 * The instance intended for the capability registry.
 *
 * NOT registered - see WHAT THIS MODULE REQUIRES at the top of this file. Until
 * `HANDLERS` lists it, nothing in the running app dispatches here.
 */
export const capabilityActivationCapability: CapabilityActivationCapability = createCapabilityActivationCapability();

/** The registry instance's readiness record. For diagnostics and the UI wave. */
export function readCapabilityActivationSnapshot(): CapabilityActivationSnapshot {
  return capabilityActivationCapability.snapshot();
}

/**
 * Clear the registry instance's record.
 *
 * MUST be called from `wcore/index.ts`'s `case 'ready':` arm - it is not called
 * from anywhere in `src/` today. `ready` never reaches the dispatcher, so this
 * is the only way a respawned engine's record can start empty; without that
 * call the readout shows the dead process's outcomes.
 */
export function resetCapabilityActivation(): void {
  capabilityActivationCapability.reset();
}
