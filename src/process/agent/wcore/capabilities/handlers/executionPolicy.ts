/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Effective execution policy revisions - the engine's security posture receipt.
 *
 * WHAT THIS IS. `execution_policy` is the only event in the whole v1 manifest
 * graded `criticality: "safety"`, and the only one whose schema pins
 * `critical` to `const: true`. It is the engine's receipt of the posture it is
 * ACTUALLY enforcing - posture / approvals / sandbox / where the decision came
 * from / whether a managed floor clamped it - stamped with a `revision`, which
 * the manifest names as this event's `correlation` key. Revision 0 arrives
 * embedded in `ready`; every later change arrives as a standalone event.
 *
 * WHY DROPPING IT IS THE BUG. Darhai's mode selector shows what the user
 * PICKED; nothing has ever shown what the engine APPLIED. When
 * `managed_floor_active` clamps a chosen autopilot back to `approvals:
 * "prompt"`, or when `sandbox` is `bypass`, the UI silently misstates how
 * dangerous the session is. Before this module `execution_policy` and
 * `workspace_policy` sat in `ACKNOWLEDGED_UNHANDLED_EVENTS` - dropping a
 * safety-class event in silence is the exact failure that hid
 * `browser_policy_denied` for a whole engine release.
 *
 * WIRING - the full path, and where each step stands:
 *
 *  1. DONE. `capabilities/index.ts` builds {@link createExecutionPolicyCapability}
 *     into every capability set. The decoder's default arm dispatches through
 *     the set its own `WCoreAgent` owns (`wcore/index.ts`), so membership of
 *     that set is the whole routing step - a capability outside it is never
 *     reached. There is deliberately NO module singleton; see the note on the
 *     factory at the bottom of this file for why one would be a defect.
 *  2. DONE. Neither `execution_policy` nor `workspace_policy` remains in
 *     `ACKNOWLEDGED_UNHANDLED_EVENTS` in `protocol.ts`, so the decoder no
 *     longer counts as knowingly-ignored two events it now handles.
 *  3. DONE. `WCoreManager` forwards these frames ABOVE its
 *     `if (!data.msg_id) return;` guard. They carry `msg_id: ''` on purpose
 *     (see {@link announce}), so below that guard they would be dropped in
 *     silence - the same failure class this capability exists to close. The
 *     exemption is derived from `forwardableFrameTypes()` rather than
 *     hand-listed, so registration is what makes a frame survive. This module
 *     emits under `execution_policy`, a name it also consumes, so it needs no
 *     `emits` declaration - unlike the two capabilities that emit a projection
 *     under a name they never handle and were silently dropped for it.
 *  4. DONE. `EffectivePolicyBadge` (`platforms/wcore/WCoreSendBox.tsx`) renders
 *     the frame next to the mode selector, via `useWCoreMessage`'s
 *     `onExecutionPolicy`. It localizes {@link PolicyDecision.verdict}; the
 *     English {@link PolicyDecision.detail} below is shown as engine output,
 *     clearly labelled, never as the app's own explanation.
 *  5. DONE. The decoder's `ready` arm calls {@link
 *     ExecutionPolicyCapability.seedFromReady} through
 *     `WCoreAgent.seedCapabilitiesFromReady`. `ready` has its own arm and never
 *     falls through to the dispatcher, so revision 0 - the posture the session
 *     STARTS in - has no other way in, and without that call the badge stayed
 *     absent until the first standalone `execution_policy` event.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE, AND WHAT THIS MODULE CHOSE. The six
 * fixtures under `adversarial/policy/` declare INPUT only: there is no expected
 * verdict anywhere in the bundle, `manifest.json`'s `fixture_inventory` is a
 * bare path list, and no README states what a host owes a revision gap, a
 * same-revision conflict or a version mismatch. Every rule in
 * {@link PolicyRevisionTracker} is therefore derived from the schema, the
 * manifest's own grading, and the shape of the fixtures - and every rejection
 * follows one principle: NEVER adopt a policy the host cannot verify, keep the
 * last one it could verify, and mark the picture stale so the divergence is
 * visible rather than silent.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it never faults the turn or ends
 * the session. Nothing in the contract says a bad receipt should, and killing a
 * user's turn over a frame the engine may emit routinely would be a worse
 * failure than today's silence. Rejection is loud (a warn plus a stream frame),
 * not fatal.
 */

import type { CapabilityContext, CapabilityHandler } from '../types';

/**
 * Major version of the `execution_policy` subcontract this host understands.
 *
 * Source: `manifest.json` -> `subcontracts.execution_policy === "1.0"`. Only
 * the MAJOR component gates acceptance; see {@link PolicyRevisionTracker}.
 */
export const EXECUTION_POLICY_SUBCONTRACT_VERSION = '1.0';

/** Engine-wide posture. Schema enum, `policy.posture`. */
export type WCorePolicyPosture = 'smart' | 'managed' | 'dangerous';

/** How tool calls are gated. Schema enum, `policy.approvals`. */
export type WCorePolicyApprovals = 'prompt' | 'auto_edit' | 'bypass';

/** Whether execution is confined. Schema enum, `policy.sandbox`. */
export type WCorePolicySandbox = 'required' | 'bypass';

/** Which layer decided the policy. Schema enum, `policy.source`. */
export type WCorePolicySource =
  | 'default'
  | 'managed'
  | 'user_config'
  | 'project'
  | 'environment'
  | 'local_cli_launch'
  | 'desktop_local_launch'
  | 'protocol'
  | 'acp'
  | 'tui'
  | 'resume'
  | 'child';

/** Why this revision exists. Schema enum, `reason`. */
export type WCorePolicyReason = 'launch' | 'mode_change' | 'resume' | 'expiry';

/**
 * The posture the engine reports it is enforcing.
 *
 * Field-for-field from `schema/core-event.schema.json` ->
 * `oneOf[type=execution_policy].properties.policy`; required there are
 * `posture`, `approvals`, `sandbox`, `source`, `managed_floor_active`. The two
 * `dangerous_*` fields are declared but not required - they are present only
 * while a `dangerous` posture activation is live.
 *
 * The schema sets `additionalProperties: true` on this object. Unknown keys are
 * intentionally NOT carried here: a field this host has never been told about
 * cannot be rendered or reasoned over safely, and inventing a slot for it would
 * be a guess. A future engine field is a deliberate protocol change, not
 * something to absorb silently. Unknown keys are not IGNORED either - they take
 * part in the identity comparison; see {@link canonicalize}.
 */
export type WCoreEffectivePolicy = {
  posture: WCorePolicyPosture;
  approvals: WCorePolicyApprovals;
  sandbox: WCorePolicySandbox;
  source: WCorePolicySource;
  managed_floor_active: boolean;
  /** Present only while a `dangerous` posture activation is live. */
  dangerous_activation_id?: string;
  dangerous_expires_at_unix_ms?: number;
};

/**
 * One policy receipt, as the engine stamps it.
 *
 * This is the object the standalone `execution_policy` event carries minus its
 * `type` discriminator, and exactly the object `ready.execution_policy`
 * carries. `critical` is pinned to `true` here because the schema pins it to
 * `const: true` - a receipt a host may act on always claims to be critical.
 */
export type WCoreExecutionPolicyReceipt = {
  critical: true;
  contract_version: string;
  revision: number;
  reason: WCorePolicyReason;
  effective_at_unix_ms: number;
  policy: WCoreEffectivePolicy;
};

/**
 * A receipt as ANNOUNCED, before the host decides whether to honour it.
 *
 * `critical` is widened to `boolean` here for one reason: the
 * `adversarial/policy/noncritical.jsonl` fixture exists, so a receipt claiming
 * `critical: false` is a real thing on the wire and must be representable in
 * order to be rejected. The exported {@link WCoreExecutionPolicyReceipt} keeps
 * `true` because that is what the schema promises of a receipt worth acting on.
 */
export type AnnouncedPolicyReceipt = Omit<WCoreExecutionPolicyReceipt, 'critical'> & { critical: boolean };

/**
 * What the host decided about one receipt.
 *
 * `applied` and `idempotent` are the only non-rejecting verdicts. Every other
 * value means the receipt was NOT adopted and the host's picture of the
 * engine's posture is now provably behind it.
 */
export type PolicyVerdict =
  /** Adopted: either the first receipt of the session, or exactly `previous + 1`. */
  | 'applied'
  /** A replay of the receipt already held, unchanged to the byte. No state change, benign. */
  | 'idempotent'
  /** `revision` jumped forward by more than one - at least one receipt was never seen. */
  | 'gap'
  /** Same `revision`, different body - two receipts claim the same authority. */
  | 'conflict'
  /** `contract_version` major differs from the subcontract this host implements. */
  | 'version_mismatch'
  /** `critical` was not `true`, on a field the schema pins to `const: true`. */
  | 'not_critical'
  /** `revision` moved backwards. */
  | 'regression'
  /** Structurally unreadable: missing required field, wrong type, unknown enum, or uncomparable. */
  | 'malformed';

/** The outcome of feeding one receipt to {@link PolicyRevisionTracker.accept}. */
export type PolicyDecision = {
  verdict: PolicyVerdict;
  /** True only when the tracker's state moved to this receipt. */
  applied: boolean;
  /** The policy the host should act on AFTER this decision - last known-good on rejection. */
  policy: WCoreEffectivePolicy | null;
  /** Revision of {@link policy}; null before any receipt was ever adopted. */
  appliedRevision: number | null;
  /** Revision this receipt announced; null when it was too malformed to read one. */
  announcedRevision: number | null;
  /**
   * Whether the host's picture is provably behind the engine's.
   *
   * True whenever the highest revision the engine has ANNOUNCED - across every
   * receipt, adopted or refused - is above the revision the host holds. It is
   * therefore not cleared by merely adopting something; it is cleared by
   * catching up. See {@link PolicyRevisionTracker.highestAnnouncedRevision}.
   */
  stale: boolean;
  /**
   * Why, in one line. Goes into the operator-facing warning and the stream
   * frame.
   *
   * ENGLISH ENGINE PROSE, never a user-facing string on its own. It is built
   * here out of schema vocabulary ("critical is not true, on a field the schema
   * pins to const: true") and the main process has no locale, so a renderer
   * must not put it where the app's own copy would go. `EffectivePolicyBadge`
   * localizes {@link verdict} - a closed enum, and therefore translatable - and
   * shows this behind an "engine says" label, as a quotation.
   */
  detail: string;
};

/** The frame this capability forwards to the task layer. */
export type ExecutionPolicyFrame = {
  verdict: PolicyVerdict;
  stale: boolean;
  detail: string;
  announcedRevision: number | null;
  announcedReason: WCorePolicyReason | null;
  announcedEffectiveAtUnixMs: number | null;
  appliedRevision: number | null;
  policy: WCoreEffectivePolicy | null;
};

const POSTURES: ReadonlySet<string> = new Set<WCorePolicyPosture>(['smart', 'managed', 'dangerous']);
const APPROVALS: ReadonlySet<string> = new Set<WCorePolicyApprovals>(['prompt', 'auto_edit', 'bypass']);
const SANDBOXES: ReadonlySet<string> = new Set<WCorePolicySandbox>(['required', 'bypass']);
const REASONS: ReadonlySet<string> = new Set<WCorePolicyReason>(['launch', 'mode_change', 'resume', 'expiry']);
const SOURCES: ReadonlySet<string> = new Set<WCorePolicySource>([
  'default',
  'managed',
  'user_config',
  'project',
  'environment',
  'local_cli_launch',
  'desktop_local_launch',
  'protocol',
  'acp',
  'tui',
  'resume',
  'child',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode `policy`, or say why it could not be decoded.
 *
 * Unknown ENUM values are rejected, not carried through. That is the strict
 * reading, and it is deliberate: `approvals` and `sandbox` are how the rest of
 * the app decides whether this session can edit files or escape its sandbox. A
 * value outside the declared set cannot be mapped to a safety level, and
 * widening the type to `string` so it could be stored would push the guess into
 * every consumer instead of catching it here. The cost is that a future engine
 * adding an enum member is refused until this host learns it - a refusal that
 * is loud, keeps the last verified policy, and shows up as stale. The
 * alternative, silently displaying an unknown posture as if understood, is the
 * failure mode this capability exists to remove.
 */
function parsePolicy(raw: unknown): { policy: WCoreEffectivePolicy } | { error: string } {
  if (!isRecord(raw)) return { error: 'policy is not an object' };

  const { posture, approvals, sandbox, source, managed_floor_active: floor } = raw;
  if (typeof posture !== 'string' || !POSTURES.has(posture))
    return { error: `unknown posture ${JSON.stringify(posture)}` };
  if (typeof approvals !== 'string' || !APPROVALS.has(approvals)) {
    return { error: `unknown approvals ${JSON.stringify(approvals)}` };
  }
  if (typeof sandbox !== 'string' || !SANDBOXES.has(sandbox))
    return { error: `unknown sandbox ${JSON.stringify(sandbox)}` };
  if (typeof source !== 'string' || !SOURCES.has(source)) return { error: `unknown source ${JSON.stringify(source)}` };
  if (typeof floor !== 'boolean') return { error: 'managed_floor_active is not a boolean' };

  const policy: WCoreEffectivePolicy = {
    posture: posture as WCorePolicyPosture,
    approvals: approvals as WCorePolicyApprovals,
    sandbox: sandbox as WCorePolicySandbox,
    source: source as WCorePolicySource,
    managed_floor_active: floor,
  };

  // The two `dangerous_*` fields say when a dangerous activation expires. A
  // wrong-typed expiry is worse than an absent one - it would be rendered as a
  // deadline nobody can trust - so a malformed value fails the whole receipt
  // rather than being quietly dropped.
  const activationId = raw.dangerous_activation_id;
  if (activationId !== undefined) {
    if (typeof activationId !== 'string') return { error: 'dangerous_activation_id is not a string' };
    policy.dangerous_activation_id = activationId;
  }
  const expiresAt = raw.dangerous_expires_at_unix_ms;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) {
      return { error: 'dangerous_expires_at_unix_ms is not an integer' };
    }
    policy.dangerous_expires_at_unix_ms = expiresAt;
  }

  return { policy };
}

/**
 * The result of reading a receipt off the wire.
 *
 * The failure arm carries `revision` when that ONE field was readable, even
 * though the rest of the receipt was not. That is not cosmetic: the revision is
 * what tells the tracker how far ahead the engine has moved, and a receipt
 * whose `policy` carries an enum this host does not know still announces its
 * position in the chain perfectly well. Discarding it would let a later, older
 * receipt look like it had caught the host up.
 */
type ReceiptParse = { receipt: AnnouncedPolicyReceipt } | { error: string; revision: number | null };

/**
 * Decode a receipt from either carrier: the standalone `execution_policy` event
 * or the `execution_policy` object embedded in `ready`. The `type`
 * discriminator is not part of the receipt, so both normalise to the same
 * object and a revision-0 seed can be compared against a standalone revision-0
 * frame on equal terms.
 */
function parseReceipt(raw: unknown): ReceiptParse {
  if (!isRecord(raw)) return { error: 'receipt is not an object', revision: null };

  const { critical, contract_version: version, reason } = raw;
  const effectiveAt = raw.effective_at_unix_ms;

  // `revision` is `type: integer` with no `minimum` in the schema. Requiring
  // one here would invent a rule the contract does not state, so only
  // integer-ness is enforced. Read first so every failure below can still
  // report where in the chain this receipt claimed to sit.
  const rawRevision = raw.revision;
  const revision = typeof rawRevision === 'number' && Number.isInteger(rawRevision) ? rawRevision : null;

  if (typeof critical !== 'boolean') return { error: 'critical is not a boolean', revision };
  if (typeof version !== 'string' || version.length === 0) {
    return { error: 'contract_version is not a string', revision };
  }
  if (revision === null) return { error: 'revision is not an integer', revision: null };
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return { error: `unknown reason ${JSON.stringify(reason)}`, revision };
  }
  if (typeof effectiveAt !== 'number' || !Number.isInteger(effectiveAt)) {
    return { error: 'effective_at_unix_ms is not an integer', revision };
  }

  const parsed = parsePolicy(raw.policy);
  if ('error' in parsed) return { error: parsed.error, revision };

  return {
    receipt: {
      critical,
      contract_version: version,
      revision,
      reason: reason as WCorePolicyReason,
      effective_at_unix_ms: effectiveAt,
      policy: parsed.policy,
    },
  };
}

/** Major component of a `major.minor` version string; `''` when unreadable. */
function majorOf(version: string): string {
  return version.split('.')[0] ?? '';
}

/**
 * How deep {@link canonicalize} will descend before refusing to compare.
 *
 * The receipt this host models is three levels: the receipt object, its
 * `policy` object, and scalars. The schema sets `additionalProperties: true` on
 * both, so an engine may hang unmodelled structure below that, and NOTHING in
 * the bundle bounds how deep. 8 is therefore a CHOICE - a margin of five levels
 * over the three the contract actually describes - not a number read off the
 * contract.
 *
 * At the cap the receipt is refused as `malformed`, not compared down to the
 * cap and no further. A truncated comparison would grade two receipts that
 * differ only below the cap as `idempotent`, which is precisely the silent
 * duplicate this canonicaliser exists to prevent; refusing is loud, keeps the
 * last verified policy, and shows as stale. It also keeps the recursion bounded
 * on input the engine controls.
 */
const MAX_CANONICAL_DEPTH = 8;

/**
 * Serialise a JSON value with object keys in sorted order, or `null` when it
 * nests past {@link MAX_CANONICAL_DEPTH}.
 *
 * `undefined` is encoded as `null` to mirror what `JSON.stringify` does inside
 * arrays; it cannot arrive from the wire, only from a hand-built object.
 */
function canonicalJson(value: unknown, depth: number): string | null {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? null;
  }
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

/**
 * The comparison form used to tell a benign replay from a real conflict.
 *
 * It runs on the RAW wire object, not on the parsed receipt, and that choice is
 * the whole point. Both the receipt and its `policy` are
 * `additionalProperties: true`, so the parsed form is a LOSSY view: two
 * receipts under one revision that disagree only in a field this host does not
 * model reduce to the same parsed object. Comparing parsed forms would grade
 * that pair `idempotent` - the one verdict that emits nothing, warns nothing
 * and leaves `stale` alone - so a genuine contradiction would read as a
 * duplicate and vanish. Comparing raw bodies means a difference this host
 * cannot interpret is still a difference it can REPORT.
 *
 * Two normalisations make that safe rather than noisy:
 *
 *  - keys are sorted recursively, so a re-serialised replay with different key
 *    ordering is still recognised as the same receipt. JSON key order is not
 *    semantic, and treating it as a conflict would make the host refuse a
 *    policy it already holds;
 *  - the top-level `type` discriminator is dropped, because it belongs to the
 *    event envelope and not to the receipt. Without that, the revision-0
 *    receipt embedded in `ready` could never match the same receipt
 *    re-announced standalone.
 *
 * Returns `null` when the body nests past {@link MAX_CANONICAL_DEPTH}, which
 * the caller turns into `malformed`.
 */
function canonicalize(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const body = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'type'));
  return canonicalJson(body, 0);
}

/**
 * The reducer: what a host does with a stream of policy receipts.
 *
 * Pure and dependency-free on purpose - no Electron, no child process, no
 * clock. That is what makes all six adversarial fixtures drivable in a plain
 * unit test against the same code production runs.
 *
 * RULES, in the order they are applied. Each one names the evidence it rests
 * on, because none of them is quoted from the contract - the fixtures declare
 * input only:
 *
 *  0. unreadable or uncomparable body -> `malformed`      (reject)
 *  1. `critical !== true`             -> `not_critical`   (reject)
 *  2. `contract_version` major differs -> `version_mismatch` (reject)
 *  3. no prior revision               -> `applied` (seed)
 *  4. same revision, identical body   -> `idempotent`     (no change)
 *  5. same revision, different body   -> `conflict`       (reject)
 *  6. revision < previous             -> `regression`     (reject)
 *  7. revision === previous + 1       -> `applied`
 *  8. revision > previous + 1         -> `gap`            (reject)
 *
 * Rule 1 rests on the schema pinning `critical` to `const: true` and the
 * manifest grading this event `criticality: "safety"`: a frame that disclaims
 * criticality while carrying the only safety-class posture receipt is either a
 * shape this host does not know or an attempt to downgrade one it does.
 *
 * Rule 2 rests on `manifest.json -> subcontracts.execution_policy === "1.0"`.
 * A MAJOR bump may redefine what `approvals` or `sandbox` mean; adopting a
 * posture this host may be misreading is precisely the risk this event exists
 * to remove. A minor bump is accepted - the schema sets
 * `additionalProperties: true`, so minors are additive by construction.
 *
 * Rules 4-8 rest on `manifest.json` naming `revision` as this event's
 * `correlation` key: revision is the identity of a receipt, so two bodies under
 * one revision is a contradiction (not last-write-wins), and a forward jump
 * means at least one receipt never arrived. "Same body" is judged on the raw
 * wire object, unmodelled fields included; see {@link canonicalize}.
 *
 * ON REJECTION the last verified policy is KEPT. The alternative - adopting the
 * newer receipt anyway - would usually give the right answer, since the newest
 * receipt is the current reality. It was rejected because a host that adopts
 * any forward jump has no working notion of a lost frame at all, and the honest
 * report ("I hold revision N and the engine is past it") is more useful to a
 * user deciding whether to trust the session than a confident wrong answer. The
 * cost is real and deliberate: after a gap this tracker cannot advance again
 * for the life of the session, because the missing predecessor never arrives.
 * {@link reset} exists for the one case where that is provably fine - a new
 * engine process.
 *
 * STALENESS is a separate question from adoption, and conflating the two was a
 * real bug here. `stale` means "the engine has announced a revision above the
 * one I hold", so it is decided against
 * {@link highestAnnouncedRevision} - the highest revision seen in ANY receipt,
 * refused ones included - and not against whether the last receipt happened to
 * fit. Clearing it on any successful apply would let a receipt the host already
 * knows to be old (revision 5, after the engine announced 9) report the picture
 * as current.
 */
export class PolicyRevisionTracker {
  private policy: WCoreEffectivePolicy | null = null;
  private lastRevision: number | null = null;
  /** Canonical raw form of the accepted receipt, for the duplicate-identity check. */
  private lastCanonical: string | null = null;
  /** Modelled form of the accepted receipt, used only to explain a conflict. */
  private lastModelled: string | null = null;
  /** Highest revision the engine has announced, whether or not it was adopted. */
  private highWater: number | null = null;
  private isStale = false;

  /** The policy the host should be acting on, or null before the first receipt. */
  get current(): WCoreEffectivePolicy | null {
    return this.policy;
  }

  /** Revision of {@link current}, or null before the first receipt. */
  get revision(): number | null {
    return this.lastRevision;
  }

  /**
   * The highest revision any receipt has ANNOUNCED this session - including
   * receipts that were refused, and receipts too malformed to read anything but
   * their revision. Null before any receipt announced a readable revision.
   *
   * This is the yardstick {@link stale} is measured against: the host is behind
   * exactly when {@link revision} is below this.
   */
  get highestAnnouncedRevision(): number | null {
    return this.highWater;
  }

  /** True while the engine has announced a revision above the one held here. */
  get stale(): boolean {
    return this.isStale;
  }

  /**
   * Forget everything. For a NEW engine process only.
   *
   * A fresh engine restarts revisions at 0, which rule 6 would otherwise refuse
   * as a regression - and the high-water mark would keep the picture stale for
   * ever. Whether a mid-session `reason: "resume"` also restarts numbering is
   * not stated anywhere in the contract and cannot be settled without running
   * the binary, so this is not called on `resume` - a wrong reset would
   * silently accept a stale policy as authoritative.
   */
  reset(): void {
    this.policy = null;
    this.lastRevision = null;
    this.lastCanonical = null;
    this.lastModelled = null;
    this.highWater = null;
    this.isStale = false;
  }

  /**
   * Feed one receipt, from either carrier.
   *
   * Takes the RAW wire object rather than a typed receipt so that the shapes
   * this must refuse - `critical: false`, a 2.0 contract version, a missing
   * field - are representable without a cast, in production and in tests alike.
   */
  accept(raw: unknown): PolicyDecision {
    const parsed = parseReceipt(raw);
    if ('error' in parsed) {
      return this.reject('malformed', parsed.revision, parsed.error);
    }
    const receipt = parsed.receipt;

    const canonical = canonicalize(raw);
    if (canonical === null) {
      return this.reject(
        'malformed',
        receipt.revision,
        `receipt nests deeper than ${MAX_CANONICAL_DEPTH} levels and cannot be compared for identity`
      );
    }

    if (receipt.critical !== true) {
      return this.reject(
        'not_critical',
        receipt.revision,
        'critical is not true, on a field the schema pins to const: true'
      );
    }

    const announcedMajor = majorOf(receipt.contract_version);
    const knownMajor = majorOf(EXECUTION_POLICY_SUBCONTRACT_VERSION);
    if (announcedMajor !== knownMajor) {
      // The revision still counts towards the high-water mark. Whether a 2.0
      // engine numbers revisions in the same space is unknowable from here, and
      // assuming it does not would clear `stale` on the strength of a guess.
      return this.reject(
        'version_mismatch',
        receipt.revision,
        `contract_version ${receipt.contract_version} is not major ${knownMajor}`
      );
    }

    if (this.lastRevision === null) {
      return this.apply(receipt, canonical, `seeded at revision ${receipt.revision} (${receipt.reason})`);
    }

    if (receipt.revision === this.lastRevision) {
      if (canonical === this.lastCanonical) {
        // A benign replay. State is unchanged and nothing is warned about: a
        // host that treats an identical re-announcement as a conflict would
        // cry wolf on every reconnect.
        return {
          verdict: 'idempotent',
          applied: false,
          policy: this.policy,
          appliedRevision: this.lastRevision,
          announcedRevision: receipt.revision,
          stale: this.isStale,
          detail: `revision ${receipt.revision} re-announced unchanged`,
        };
      }
      // Say WHERE the two bodies disagree. When the modelled forms match, the
      // difference is in a field this host does not model - still two receipts
      // under one identity, but an operator reading the warning should know
      // that nothing they can see on screen changed.
      const modelled = JSON.stringify(receipt);
      const where =
        modelled === this.lastModelled ? 'a different body outside the fields this host models' : 'a different body';
      return this.reject('conflict', receipt.revision, `revision ${receipt.revision} re-announced with ${where}`);
    }

    if (receipt.revision < this.lastRevision) {
      return this.reject(
        'regression',
        receipt.revision,
        `revision ${receipt.revision} is behind the held revision ${this.lastRevision}`
      );
    }

    if (receipt.revision === this.lastRevision + 1) {
      return this.apply(receipt, canonical, `revision ${receipt.revision} applied (${receipt.reason})`);
    }

    return this.reject(
      'gap',
      receipt.revision,
      `revision ${receipt.revision} skips ${receipt.revision - this.lastRevision - 1} revision(s) after ${this.lastRevision}`
    );
  }

  /** Record that the engine claimed this revision exists, adopted or not. */
  private noteAnnounced(revision: number | null): void {
    if (revision === null) return;
    if (this.highWater === null || revision > this.highWater) this.highWater = revision;
  }

  private apply(receipt: AnnouncedPolicyReceipt, canonical: string, detail: string): PolicyDecision {
    this.noteAnnounced(receipt.revision);
    this.policy = receipt.policy;
    this.lastRevision = receipt.revision;
    this.lastCanonical = canonical;
    this.lastModelled = JSON.stringify(receipt);
    // Adoption alone does not make the picture current. The host is caught up
    // only once what it holds reaches the highest revision the engine has ever
    // announced; until then this receipt is provably old, however neatly it fit
    // the chain.
    const behind = this.highWater !== null && receipt.revision < this.highWater;
    this.isStale = behind;
    return {
      verdict: 'applied',
      applied: true,
      policy: this.policy,
      appliedRevision: this.lastRevision,
      announcedRevision: receipt.revision,
      stale: behind,
      detail: behind ? `${detail}; still behind revision ${this.highWater} announced earlier` : detail,
    };
  }

  private reject(verdict: PolicyVerdict, announcedRevision: number | null, detail: string): PolicyDecision {
    this.noteAnnounced(announcedRevision);
    this.isStale = true;
    return {
      verdict,
      applied: false,
      policy: this.policy,
      appliedRevision: this.lastRevision,
      announcedRevision,
      stale: true,
      detail,
    };
  }
}

/**
 * The capability, plus the two seams a decoder needs that a plain
 * `CapabilityHandler` cannot express.
 *
 * `ready` is NOT claimed by this handler, and could not usefully be: `ready` is
 * a first-class event with its own arm in the decoder (that is where
 * `capabilities` and the negotiated contract are read), and the dispatcher only
 * runs from the decoder's default arm, so a handler claiming `ready` would
 * register a type that never routes. The revision-0 seed is therefore pushed in
 * by that arm calling {@link seedFromReady} - see step 5 of the WIRING note at
 * the top of this file.
 */
export type ExecutionPolicyCapability = CapabilityHandler & {
  /** The reducer this handler feeds. Exposed so the agent can read `current`/`stale`. */
  readonly tracker: PolicyRevisionTracker;
  /**
   * Seed from a `ready` payload. Returns null when the payload carries no
   * `execution_policy` at all - `compat/events/ready.minimal.json` ships
   * exactly that, even though the core-event schema marks the field required,
   * so an absent receipt is a supported engine, not an error. The tracker then
   * stays uninitialised rather than assuming a revision 0 nobody sent. The
   * absence is LOGGED through `ctx` when one is given: "no receipt" and "a
   * receipt this host refused" look identical from outside otherwise.
   */
  seedFromReady(ready: unknown, ctx?: CapabilityContext): PolicyDecision | null;
  /**
   * Forget all revisions, for a new engine process behind the SAME agent; see
   * {@link PolicyRevisionTracker.reset}.
   *
   * Safe only because every `WCoreAgent` owns its own instance. Calling this on
   * an instance two conversations shared would rewind a tracker the other
   * conversation is still advancing, and a rewound tracker refuses that
   * conversation's next legal receipt as a forward gap - permanently, per
   * {@link PolicyRevisionTracker}'s own rule. That is why there is no module
   * singleton to call it on.
   */
  reset(): void;
};

function toFrame(decision: PolicyDecision, receipt: unknown): ExecutionPolicyFrame {
  const parsed = parseReceipt(receipt);
  const announced = 'error' in parsed ? null : parsed.receipt;
  return {
    verdict: decision.verdict,
    stale: decision.stale,
    detail: decision.detail,
    announcedRevision: decision.announcedRevision,
    announcedReason: announced?.reason ?? null,
    announcedEffectiveAtUnixMs: announced?.effective_at_unix_ms ?? null,
    appliedRevision: decision.appliedRevision,
    policy: decision.policy,
  };
}

/**
 * Announce a decision to the task layer.
 *
 * `msg_id` is empty because a policy revision is session-scoped, not
 * turn-scoped: it can arrive between turns, and attaching it to whatever turn
 * happened to be open would file a session-wide fact under one message.
 *
 * That choice puts a REQUIREMENT on the layer above, and it is met:
 * `WCoreManager` drops frames with no `msg_id` (`if (!data.msg_id) return;`),
 * so it checks `CAPABILITY_FRAME_TYPES` ABOVE that guard, next to the
 * `sub_agent_event` pass-through. That set is derived from
 * `forwardableFrameTypes()`, so this frame survives because the capability is
 * in the set - see step 3 of the WIRING note at the top of this file. Were the
 * check to move below the guard, every frame emitted here would be discarded
 * silently again; `wcore-capabilityFrameForwarding.test.ts` pins the order.
 */
function announce(ctx: CapabilityContext, decision: PolicyDecision, receipt: unknown): void {
  ctx.emit({ type: 'execution_policy', data: toFrame(decision, receipt), msg_id: '' });
}

/**
 * Build a capability bound to its own tracker.
 *
 * A factory and NOTHING ELSE - there is deliberately no module singleton to
 * import, because the tracker is per-engine state and Darhai runs several
 * engines at once: `WorkerTaskManager.taskList` holds one `WCoreManager` (hence
 * one `WCoreAgent`, hence one engine child) per open conversation. A shared
 * instance let one session's revisions reject the other's, and the `reset()`
 * that a new `ready` performs rewound the tracker the other conversation was
 * still advancing - after which its next legal receipt reads as a forward gap
 * and, by this tracker's own rule, it can never advance again for the life of
 * the session. The badge in the untouched conversation then showed the OTHER
 * conversation's posture, permanently orange, with a "policy update never
 * arrived" warning fabricated entirely by a second conversation existing.
 *
 * So the only way to get one is to build one, and `createCapabilitySet()` in
 * `capabilities/index.ts` builds exactly one per agent.
 */
export function createExecutionPolicyCapability(): ExecutionPolicyCapability {
  const tracker = new PolicyRevisionTracker();

  return {
    name: 'effective_execution_policy_revisions',
    // `workspace_policy` rides along: the running engine emits it, but it
    // appears in NO manifest entry and NO payload schema - only as a bare `type`
    // discriminator in producer-complete.schema.json, with
    // `additionalProperties: true` and zero declared properties. It is claimed
    // here so that, once this capability is registered, it stops being an
    // unexplained warn; nothing is read from its body, because there is nothing
    // in the contract to read it against.
    handles: ['execution_policy', 'workspace_policy'],
    tracker,

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      if (event.type === 'workspace_policy') {
        ctx.log('workspace_policy observed; the contract declares no payload for it, so no field is read');
        return true;
      }

      const decision = tracker.accept(event);
      if (decision.verdict === 'idempotent') {
        // Nothing changed and nothing is wrong; emitting would churn the UI and
        // warning would train the operator to ignore this event.
        ctx.log(decision.detail);
        return true;
      }
      if (decision.applied) {
        ctx.log(decision.detail, decision.policy);
      } else {
        ctx.warn(`execution_policy rejected (${decision.verdict}): ${decision.detail}`, {
          heldRevision: decision.appliedRevision,
          announcedRevision: decision.announcedRevision,
        });
      }
      announce(ctx, decision, event);
      return true;
    },

    seedFromReady(ready: unknown, ctx?: CapabilityContext): PolicyDecision | null {
      if (!isRecord(ready)) {
        ctx?.log('ready payload is not an object; there is no execution_policy to seed from');
        return null;
      }
      const receipt = ready.execution_policy;
      if (receipt === undefined || receipt === null) {
        // Not a fault - `compat/events/ready.minimal.json` is exactly this - but
        // it must not be invisible either. Without this line an engine that
        // never sends a receipt and an engine whose receipt was refused both
        // leave the same empty trace.
        ctx?.log('ready carries no execution_policy; the tracker stays uninitialised rather than inventing revision 0');
        return null;
      }

      const decision = tracker.accept(receipt);
      if (ctx) {
        if (decision.applied) ctx.log(decision.detail, decision.policy);
        else if (decision.verdict !== 'idempotent') {
          ctx.warn(`ready.execution_policy rejected (${decision.verdict}): ${decision.detail}`);
        }
        if (decision.verdict !== 'idempotent') announce(ctx, decision, receipt);
      }
      return decision;
    },

    reset(): void {
      tracker.reset();
    },
  };
}
