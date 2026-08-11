/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Copy for the engine's tamper-evident audit alerts.
 *
 * Its two sibling notice builders (`describeFailover`, `describeDelivery`) live
 * inside `useWCoreMessage`; this one does not, for one reason: the anvil
 * capability reports eleven distinct verdicts and each needs its own sentence
 * AND its own grade, and folding that table into the stream hook pushed the
 * hook past 800 lines. Everything here is pure - a frame and a `t` in, a
 * sentence and a severity out - so the tests drive it without a React tree.
 */

import type { IMessageTips } from '@/common/chat/chatLib';
import type {
  AnvilAlertPayload,
  AnvilInvalidationReason,
  AnvilRejectCode,
} from '@process/agent/wcore/capabilities/handlers/anvilReceipts';
import type { TFunction } from 'i18next';

/** What a capability notice looks like once it is copy rather than a frame. */
export type AnvilNoticeCopy = { content: string; severity: IMessageTips['content']['type'] };

/**
 * The frame `anvilReceiptsCapability` projects a distrusted verdict under.
 *
 * A named constant rather than a bare literal in `useWCoreMessage`'s `switch`,
 * so a test can pin it to the capability's own `ANVIL_ALERT_FRAME`. Renaming
 * the projection in the main process and leaving this arm behind reproduces
 * exactly the failure this surface exists to end - the frame arrives on the
 * response stream and nothing reads it - and nothing at runtime would say so.
 */
export const ANVIL_ALERT_MESSAGE_TYPE = 'anvil_receipt_alert';

/**
 * Severity per reject code, and the exhaustive list of reject codes with it.
 *
 * `Record<AnvilRejectCode, …>` is the mechanical half: a code added to the
 * capability's union stops this file compiling until it is given a grade and a
 * sentence, rather than silently showing its own wire name to a user reading a
 * safety-class readout.
 *
 * The grading splits on "did this host PROVE the record is wrong" versus "could
 * this host merely not read it". `malformed`, `sequence_conflict` and
 * `body_conflict` are contradictions the host demonstrated - a record that
 * breaks the engine's own schema, two records in one correlation slot, one
 * digest vouching for two bodies. The rest are limits of this host: a contract
 * version it does not implement, an extension it does not implement, a hole in
 * what reached it, a replay it declined to act on. Grading those `error` too
 * would spend the loudest colour the surface has on the host's own blind spots,
 * and a user who learns to discount it there will discount it when a digest
 * really does contradict itself.
 */
const ANVIL_REFUSAL_SEVERITY: Record<AnvilRejectCode, AnvilNoticeCopy['severity']> = {
  malformed: 'error',
  sequence_conflict: 'error',
  body_conflict: 'error',
  version_mismatch: 'warning',
  unknown_critical_extension: 'warning',
  sequence_gap: 'warning',
  stale_replay: 'warning',
  invalidation_unlinked: 'warning',
};

/**
 * Severity per retraction reason.
 *
 * A retraction is the ENGINE speaking rather than this host inferring: it
 * published a verdict and then took it back. `superseded` is the one benign
 * member - a later receipt replaced this one - so it sits below the two that
 * say what the receipt certified no longer holds.
 */
const ANVIL_RETRACTION_SEVERITY: Record<AnvilInvalidationReason, AnvilNoticeCopy['severity']> = {
  artifact_mutated: 'error',
  gate_revoked: 'error',
  superseded: 'warning',
};

/**
 * The table's own key when the wire carried one of them, otherwise undefined.
 *
 * `hasOwnProperty` rather than a truthiness check on the lookup: a wire value
 * of `constructor` or `toString` would otherwise resolve through the prototype
 * and be treated as a code this host has copy for.
 */
function knownKey<K extends string>(table: Record<K, unknown>, value: string): K | undefined {
  return Object.prototype.hasOwnProperty.call(table, value) ? (value as K) : undefined;
}

/**
 * The engine's own identifiers for the record, verbatim.
 *
 * The artifact digest is NOT shortened here, although the capability's log line
 * shortens it: this is the value a user compares against a hash of the file on
 * disk, and a truncated one cannot be compared. The notice wraps on word
 * boundaries, so the cost is a line, and the alternative is a field that looks
 * informative and answers nothing.
 */
function anvilEngineRecord(frame: AnvilAlertPayload, t: TFunction): string {
  const receipt = frame.receiptId || t('conversation.anvilAlert.noReceiptId');
  // -1 is the ledger's stand-in for a record whose `sequence` was absent or not
  // an integer, i.e. one it could not place in the session at all. Printing
  // "position -1" would read as a real position the engine had assigned.
  const position = frame.sequence >= 0 ? String(frame.sequence) : t('conversation.anvilAlert.noPosition');
  return frame.artifactDigest
    ? t('conversation.anvilAlert.engineRecordArtifact', { receipt, position, artifact: frame.artifactDigest })
    : t('conversation.anvilAlert.engineRecord', { receipt, position });
}

/**
 * Turn an `anvil_receipt_alert` frame into user-facing copy.
 *
 * WHAT WEIGHT, AND WHY. A centred transcript notice - the same surface the
 * failover and delivery receipts use - and deliberately neither of the two
 * neighbours it could have been. Not a chat bubble: the assistant did not say
 * this, and the synthetic `msg_id` below keeps it from ever replacing a reply.
 * Not a modal: on a FIRST sighting this host cannot prove tampering at all (it
 * cannot recompute the engine's digest - see the module header of
 * `anvilReceipts.ts`), and half the reject codes describe limits of this host
 * rather than a defect in the record, so blocking the user on an unprovable
 * claim would be the wrong trade. What an audit alert does need is to stay:
 * a toast would be gone before the run it questions is finished, whereas this
 * sits in the transcript beside the turn it belongs to, permanently, and
 * expands to the full record on demand.
 *
 * HONESTY. The copy keeps two things apart on purpose, because conflating them
 * is how a host ends up asserting a verdict it cannot back. The engine's own
 * words are the receipt id, the position and the artifact digest, plus the
 * retraction reason when the engine retracted. Everything else is this host
 * talking: the sentence naming what Darhai refused and why, and the raw
 * diagnostic on the last line. No sentence here claims the engine's digest was
 * recomputed, and none suggests the artifact is being watched after publication
 * - `capabilities.anvil_receipts` is graded `publication_bound`, and
 * `publicationScope` says so where a user is most likely to assume otherwise.
 */
export function describeAnvilAlert(frame: AnvilAlertPayload, t: TFunction): AnvilNoticeCopy {
  // `=== 'invalidated'` and not `code === null`: a retraction and a refusal are
  // two different speakers, and the outcome is the field that says which.
  const retraction = frame.outcome === 'invalidated';
  const reason = knownKey(ANVIL_RETRACTION_SEVERITY, frame.reason || '');
  const code = knownKey(ANVIL_REFUSAL_SEVERITY, frame.code || '');

  const headline = retraction
    ? reason === undefined
      ? t('conversation.anvilAlert.retracted.unknown', { reason: frame.reason || t('conversation.anvilAlert.noValue') })
      : t(`conversation.anvilAlert.retracted.${reason}`)
    : code === undefined
      ? t('conversation.anvilAlert.refused.unknown', { code: frame.code || frame.outcome })
      : t(`conversation.anvilAlert.refused.${code}`);

  // An unrecognised reason or code is graded `warning`, not `error`: the host
  // does not know what it is looking at, and that is the definition of the
  // quieter grade here.
  const severity = retraction
    ? reason === undefined
      ? 'warning'
      : ANVIL_RETRACTION_SEVERITY[reason]
    : code === undefined
      ? 'warning'
      : ANVIL_REFUSAL_SEVERITY[code];

  const lines = [headline, anvilEngineRecord(frame, t)];
  if (reason === 'artifact_mutated') lines.push(t('conversation.anvilAlert.publicationScope'));
  // `detail` is this host's own English diagnostic, so it is labelled as such
  // rather than shown as something the engine said. Omitted for a retraction,
  // where it only restates `reason` - which the headline has already said in
  // the reader's language.
  if (!retraction && frame.detail) lines.push(t('conversation.anvilAlert.hostReason', { detail: frame.detail }));

  return { content: lines.join('\n'), severity };
}

/**
 * One transcript line per distinct alert.
 *
 * Not `uuid()` like the failover arm: a rejected event is never recorded in the
 * ledger's admitted slots, so an at-least-once transport redelivering a batch
 * re-runs the same refusal and would stack an identical line every time - and a
 * safety readout that repeats itself is how the one that matters gets skipped.
 * Not the receipt id alone either: a rejection does not advance the sequence
 * counter, so several genuinely different refusals can share one receipt id AND
 * one position. The key therefore carries every field that makes two alerts
 * different facts, `detail` included - two events agreeing on all of them are
 * the same fact restated, which is exactly what should collapse.
 */
export function anvilAlertKey(frame: AnvilAlertPayload): string {
  return ['anvil', frame.receiptId, frame.sequence, frame.outcome, frame.code || '', frame.detail || ''].join(':');
}
