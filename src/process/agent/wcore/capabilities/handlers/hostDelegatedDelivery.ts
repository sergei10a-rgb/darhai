/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-delegated delivery, provider failover receipts, and operator resolution
 * of an unknown tool effect.
 *
 * WHY THESE THREE LIVE TOGETHER. They are the three verbs where the ENGINE is
 * waiting on the HOST, or where the host is the only party that can say what
 * happened:
 *
 *  - `host_send_message_request` is the engine asking Darhai to put a message on
 *    a real channel and BLOCKING on `host_send_message_result` keyed by
 *    `call_id` (manifest `correlation: "call_id"`, `criticality: "safety"`);
 *  - `provider_failover_receipt` is the audit record of why a turn changed
 *    provider - including the case where NOTHING was selected and the turn is
 *    about to die with no explanation;
 *  - `unknown_tool_effect_resolved` / `resolve_unknown_tool_effect` is the
 *    operator settling "did that payment/email/deploy actually happen?" after an
 *    interrupted turn - the other half of turn recovery's `tool_outcome_unknown`
 *    (see {@link UNKNOWN_TOOL_EFFECT_RECONCILE_REASON}).
 *
 * All three names sit in `ACKNOWLEDGED_UNHANDLED_EVENTS` today, i.e. they are
 * decoded to nothing on purpose. For the failover receipt that means a provider
 * switch is invisible; for the delivery request it means the engine's
 * `send_message` tool can reach none of Darhai's configured channel plugins.
 *
 * THE ONE RULE THIS MODULE IS BUILT AROUND: EVERY REQUEST IS ANSWERED. A
 * `host_send_message_request` that this host cannot serve is answered
 * `ok:false` with a reason, immediately - never dropped, never left to a
 * timeout. The engine's own timeout string (measured in the bundled v0.12.26
 * binary: "host did not answer the delegated send within {}s (no
 * host_send_message_result); the message was NOT confirmed sent") proves the
 * turn does not hang forever, but it also proves that silence costs the user a
 * turn's worth of waiting and ends in an unconfirmed send. There is exactly ONE
 * path here that does not answer - a request with no usable `call_id`, which
 * cannot be answered because the answer is keyed on it - and it is loud.
 *
 * WIRING THIS MODULE REQUIRES, WHICH IT CANNOT CHECK FROM HERE. These are
 * requirements on the code around it, not claims about the running system:
 *
 *  1. {@link hostDelegatedDeliveryCapability} must be listed in `HANDLERS` in
 *     `capabilities/index.ts`. Unregistered, nothing routes here and no frame
 *     emitted here reaches a renderer (`WCoreManager` builds its
 *     `CAPABILITY_FRAME_TYPES` pass-through set from `claimedEventTypes()`).
 *  2. The three names must then leave `ACKNOWLEDGED_UNHANDLED_EVENTS` in
 *     `protocol.ts`, or the host reports as knowingly-inert three events it now
 *     handles.
 *  3. `WAYLAND_SEND_MESSAGE_HOST_DELEGATE=1` must be in the engine's spawn env
 *     (`envBuilder.buildEngineSpawnEnv`), or the engine never emits
 *     `host_send_message_request` at all and the delivery half is dead code.
 *     MEASURED, not inferred: the bundled binary carries "send_message runs
 *     host-delegated (WAYLAND_SEND_MESSAGE_HOST_DELEGATE=1): sends are fulfilled
 *     by the host, not the engine".
 *  4. Something must install a {@link MessageDeliverer} via
 *     {@link HostDelegatedDeliveryCapability.setMessageDeliverer} - the adapter
 *     from {@link DeliveryRequest} to a running channel plugin's
 *     `sendMessage(chatId, IUnifiedOutgoingMessage)`. Until it does, this module
 *     DECLINES every delivery with "no delivery transport is installed", which
 *     is the honest answer and not a stall.
 *  5. `resolve_unknown_tool_effect` needs a negotiated contract to be sendable.
 *     The gate reads it through {@link turnRecoveryCapability}, so the decoder's
 *     `ready` arm calling `turnRecoveryCapability.seedFromReady` arms both
 *     capabilities. With no seed the gate is SHUT - the deliberate fail-closed
 *     default.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE, AND WHAT THIS MODULE CHOSE:
 *
 *  - the delivery TIMEOUT is nowhere in the contract, and the engine's own is a
 *    runtime format argument that cannot be read from strings. So this host
 *    bounds its OWN wait ({@link DELIVERY_TIMEOUT_MS}) and answers `ok:false`
 *    rather than letting a plugin that never settles hold the turn;
 *  - `platform` is a bare `string` in the schema with no enum, so the mapping to
 *    Darhai plugin types is this host's construction; an unmapped platform is
 *    REFUSED with an explicit answer rather than guessed at
 *    (see {@link PLATFORM_PLUGIN_TYPES}, and {@link pluginTypesFor} for why the
 *    table is never read with a bare index);
 *  - where `tool_execution_id` comes from is UNDECLARED. Grepped: it appears
 *    only in the two unknown-tool-effect files and the schemas; no recovery
 *    event publishes one (`session_recovery_snapshot` publishes
 *    `pending_call_id`). So {@link buildResolveUnknownToolEffect} validates the
 *    field but this module never invents it - it must be supplied by the
 *    operator surface, and until that surface exists the command is built and
 *    gated, not guessed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never faults the turn, never retries a
 * delivery (a retried send is a DOUBLE send of a real email), and never
 * approves a delivery. Whether the model should be allowed to send mail through
 * the user's own accounts without a confirmation is a product decision flagged
 * in the research plan and NOT made here; this module only reports.
 */

import type { BuiltinPluginType } from '@process/channels/types';

import { gradeOf, isCapabilityAvailable, NO_CONTRACT } from '../contractNegotiation';
import type { NegotiatedContract } from '../contractNegotiation';
import type { CapabilityContext, CapabilityHandler } from '../types';
import { JOURNAL_DIGEST_PATTERN, RECOVERY_VERSION, turnRecoveryCapability } from './turnRecovery';
import type { WCoreJournalCursor, WCoreReconcileReason } from './turnRecovery';

/* ------------------------------- identity ------------------------------- */

/** `manifest.capabilities.host_delegated_delivery`. Also this handler's name. */
export const HOST_DELEGATED_DELIVERY_CAPABILITY = 'host_delegated_delivery';

/** `manifest.capabilities.semantic_failover_receipts`. */
export const SEMANTIC_FAILOVER_CAPABILITY = 'semantic_failover_receipts';

/** `manifest.capabilities.operator_tool_effect_resolution_v1`. */
export const OPERATOR_TOOL_EFFECT_CAPABILITY = 'operator_tool_effect_resolution_v1';

/** The three wire events this capability owns. */
export const HOST_DELEGATED_EVENT_TYPES = [
  'host_send_message_request',
  'provider_failover_receipt',
  'unknown_tool_effect_resolved',
] as const;

/**
 * The turn-recovery reason this capability exists to settle.
 *
 * Typed against `turnRecovery`'s own union rather than written as a bare
 * string: if that vocabulary ever loses the member, this file stops compiling
 * instead of silently referring to a reason the recovery surface no longer
 * publishes.
 */
export const UNKNOWN_TOOL_EFFECT_RECONCILE_REASON: WCoreReconcileReason = 'tool_outcome_unknown';

/**
 * `evidence.digest`, verbatim from the schema. Note the `sha256:` PREFIX, which
 * is exactly what {@link JOURNAL_DIGEST_PATTERN} (bare hex) does not have -
 * one command carries both forms and mixing them builds a message the engine
 * rejects mid-reconciliation, which is the worst possible moment to find out.
 *
 * TRANSCRIBED, WITH A GATE. `src/` must not read `tests/fixtures/` at runtime,
 * so this literal is a copy and copies drift. The drift gate is the test
 * "EVIDENCE_DIGEST_PATTERN is the schema's evidence pattern verbatim" in
 * `tests/unit/wcore-hostDelegatedDelivery.test.ts`.
 */
export const EVIDENCE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/* -------------------------------- bounds -------------------------------- */

/**
 * The longest engine-controlled identifier this host will accept or echo.
 *
 * A HOST-SIDE CHOICE; no schema here declares a `maxLength` on any of these
 * fields. The engine controls them and this host does long-lived things with
 * them: `call_id` becomes a `Map` key held until the delivery settles, and every
 * one of them is interpolated into a warning and into a frame the renderer
 * shows. 512 is far past anything the contract ships (`call-send-001` is 13
 * characters). At the bound the value is REFUSED, not truncated - a truncated
 * `call_id` would answer somebody else's delivery.
 */
export const MAX_WIRE_ID_LENGTH = 512;

/**
 * The longest `platform` name this host will look up.
 *
 * The engine's own vocabulary tops out at `wecom_callback` (14 characters), and
 * the value is used as a lookup key and quoted into an error the user reads. 64
 * is a CHOICE with a 4x margin. Past it the request is answered `ok:false`
 * rather than searched for.
 */
export const MAX_PLATFORM_LENGTH = 64;

/**
 * The longest `subject` this host will hand to a channel plugin.
 *
 * 998 is RFC 5322 §2.1.1's limit for one header field line, and `subject` is
 * documented in the engine's own tool description as the email subject. Past
 * that limit an SMTP server may fold, truncate or reject, and the host cannot
 * tell which - so the send is refused with an explicit answer rather than
 * delivered in a shape nobody can predict.
 */
export const MAX_SUBJECT_LENGTH = 998;

/**
 * The longest message body this host will deliver.
 *
 * A HOST-SIDE CHOICE - the schema puts no bound on `body` and the ENGINE
 * controls the string, which is the unbounded-size shape a wave-2 review found
 * everywhere. 256 KiB is far past any message a human reads and still small
 * enough to hold in memory per in-flight send.
 *
 * At the bound the send is REFUSED, never truncated: a truncated delivery is a
 * message the user believes was sent whole, which is worse than a failure they
 * can see.
 */
export const MAX_BODY_LENGTH = 262144;

/**
 * How much of a failure reason travels back to the engine.
 *
 * Truncated rather than refused, unlike every id above: this string is PROSE
 * whose job is to identify what went wrong, not an identity that has to match
 * something. A plugin throwing a stack trace must not turn into a refusal to
 * answer at all. The true length is appended so a reader knows it was cut.
 */
export const MAX_ERROR_LENGTH = 1024;

/**
 * How much of one engine-controlled value a `detail` line may quote.
 *
 * Same reasoning as {@link MAX_WIRE_ID_LENGTH}, applied to values that are not
 * ids and so cannot be refused on length alone (an unknown platform, an
 * undeclared enum member). The longest legitimate value in this surface is a
 * 71-character prefixed digest, so a real value is never cut. 120 is a CHOICE
 * with roughly a 1.7x margin over that; past it the value is TRUNCATED with its
 * true length appended, because a detail line is prose about a fault and cutting
 * it loses nothing an operator can act on.
 *
 * IT IS THE ONLY BOUND ON SOME OF THESE VALUES. {@link unknownKeyFault} quotes a
 * joined list of unknown keys whose COUNT is wire-controlled and unbounded - an
 * engine sending 200 undeclared fields would otherwise put all 200 names into a
 * warning and into a frame the renderer displays.
 */
export const MAX_DETAIL_VALUE_LENGTH = 120;

/**
 * How many deliveries may be in flight at once.
 *
 * A HOST-SIDE CHOICE; the contract states no bound and the ENGINE decides how
 * many requests to make, so without this the pending map is wire-controlled and
 * unbounded. 32 concurrent real-world sends is already far past anything a
 * single turn does.
 *
 * At the cap the NEWEST request is refused, which is the opposite of what the
 * budget-grant ledger does and deliberately so: evicting an in-flight delivery
 * does not cancel the send that is already happening, so answering the OLD one
 * `ok:false` would report a message that may well arrive as a failure. Refusing
 * the new one is a true negative - nothing was sent under it.
 */
export const MAX_IN_FLIGHT_SENDS = 32;

/**
 * How long this host waits for a delivery before answering `ok:false`.
 *
 * NOT FROM THE CONTRACT, AND NOT MATCHED TO THE ENGINE'S OWN TIMEOUT. The
 * engine's message ("host did not answer the delegated send within {}s") proves
 * it has one, but `{}` is a runtime format argument: the number can only be
 * established by running the binary and stalling the answer. Guessing it and
 * sitting just inside it would be a number pretending to be a measurement.
 *
 * So this bound answers a different question - "how long may one channel plugin
 * hold a slot and a turn" - and 120 s is a CHOICE covering a slow SMTP
 * connect-and-send. Two consequences are accepted and stated:
 *  - the answer may arrive after the engine gave up. Measured, that is
 *    tolerated: the binary warns "host_send_message_result received for unknown
 *    call_id: {} (stale or timed-out send?)" rather than faulting;
 *  - a delivery that lands AFTER the timeout was reported as unconfirmed, not
 *    as failed - the error text says so, because the message may really have
 *    been sent and a retry would send it twice.
 */
export const DELIVERY_TIMEOUT_MS = 120000;

/**
 * How many failover candidates one receipt may carry.
 *
 * The schema puts no `maxItems` on `candidates`, so the WIRE controls the
 * length of a loop this module runs. A real router picks between a handful of
 * providers; 256 is a CHOICE two orders of magnitude past that. At the cap the
 * receipt is REFUSED rather than truncated - a partial candidate list read as
 * complete would tell the user "these were the options" when it was not.
 */
export const MAX_FAILOVER_CANDIDATES = 256;

/**
 * How many sent resolutions are remembered for correlation.
 *
 * The manifest correlates `resolve_unknown_tool_effect` and
 * `unknown_tool_effect_resolved` on `session_turn_tool_and_cursor`, so this host
 * keeps what it sent in order to say whether an arriving resolution is the echo
 * of its own command or somebody else's. Entries are added only by a deliberate
 * operator action, so 64 is far past a session's worth; the oldest is dropped at
 * the cap, and the only cost is that a very old echo reports as uncorrelated.
 */
export const MAX_TRACKED_RESOLUTIONS = 64;

/* ---------------------------- platform mapping --------------------------- */

/**
 * Engine platform vocabulary -> Darhai channel plugin types, in preference
 * order. An empty list means "the engine offers this platform and Darhai has no
 * plugin for it".
 *
 * THIS TABLE IS THIS HOST'S CONSTRUCTION, NOT THE CONTRACT'S. The schema
 * declares `platform: string` with no enum. The KEYS come from the bundled
 * v0.12.26 binary's own `send_message` tool description; the VALUES are typed
 * against {@link BuiltinPluginType} (`src/process/channels/types.ts`), so a
 * plugin type that does not exist is a compile error rather than a delivery
 * that silently finds nothing.
 *
 * Three names disagree between the two vocabularies and are mapped explicitly:
 *  - `feishu` -> `lark` (Feishu is Lark's Chinese-market name; Darhai's builtin
 *    is `lark`);
 *  - `email` -> `email-imap` then `email-agentmail` - the user's own IMAP/SMTP
 *    account is preferred over the hosted relay, because a message that must
 *    come from the user's address is the common case;
 *  - `sms` -> `sms-twilio`, Darhai's only SMS builtin;
 *  - `wecom_callback` -> `wecom`, the same plugin behind the engine's callback
 *    variant.
 *
 * Five platforms the engine names have NO Darhai builtin (`signal`,
 * `bluebubbles`, `qqbot`, `mattermost`, `homeassistant`) and are listed with an
 * empty candidate list rather than omitted. That distinction is load-bearing:
 * "the engine offers it and Darhai cannot" and "this host has never heard of
 * this platform" are different answers to the user, and a FUTURE engine
 * platform must land in the second case rather than being guessed into a plugin
 * name that happens to look similar.
 *
 * READ IT ONLY THROUGH {@link pluginTypesFor}. The declared
 * `Record<string, readonly BuiltinPluginType[]>` is a lie for every key this
 * literal inherits from `Object.prototype`, and `platform` is wire-controlled.
 */
export const PLATFORM_PLUGIN_TYPES: Readonly<Record<string, readonly BuiltinPluginType[]>> = {
  telegram: ['telegram'],
  discord: ['discord'],
  slack: ['slack'],
  whatsapp: ['whatsapp'],
  matrix: ['matrix'],
  dingtalk: ['dingtalk'],
  weixin: ['weixin'],
  wecom: ['wecom'],
  wecom_callback: ['wecom'],
  feishu: ['lark'],
  email: ['email-imap', 'email-agentmail'],
  sms: ['sms-twilio'],
  // Declared by the engine, unimplemented here. Not omitted - see above.
  signal: [],
  bluebubbles: [],
  qqbot: [],
  mattermost: [],
  homeassistant: [],
};

/**
 * Resolve a wire platform to plugin candidates, or `undefined` for "never heard
 * of it" - WITHOUT walking the prototype chain.
 *
 * A plain `PLATFORM_PLUGIN_TYPES[platform]` answers for every `Object.prototype`
 * member too, and `platform` comes off the wire. Measured against this module
 * before the guard existed: `platform: "constructor"` returned the `Object`
 * constructor - a function, so neither `=== undefined` nor `.length === 0`
 * caught it - and the deliverer was CALLED with `pluginTypes` set to a function,
 * which a real adapter iterating it turns into "the delivery failed: TypeError:
 * req.pluginTypes is not iterable". `hasOwnProperty`, `isPrototypeOf` and
 * `propertyIsEnumerable` behave the same; `__proto__` yielded `Object.prototype`
 * itself. `toString` and `valueOf` (arity 0) took the OTHER wrong branch and
 * answered "Darhai has no channel plugin for toString" - the sentence reserved
 * for a platform the engine offers and this host deliberately cannot serve.
 *
 * An own-property check collapses all of them back into the honest answer: this
 * host has never heard of that platform, so it will not guess a channel.
 */
function pluginTypesFor(platform: string): readonly BuiltinPluginType[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_PLUGIN_TYPES, platform)) return undefined;
  return PLATFORM_PLUGIN_TYPES[platform];
}

/* ------------------------------- wire types ------------------------------ */

/** `host_send_message_request`, as it goes on the wire. */
export type WCoreHostSendMessageRequest = {
  type: 'host_send_message_request';
  /**
   * Engine-minted correlation id, in its OWN namespace - it is not a tool
   * `call_id`. Measured: the binary mints `hsm-<n>` while the fixture uses
   * `call-send-001`, so no format is assumed anywhere in this module.
   */
  call_id: string;
  /** Engine platform vocabulary; see {@link PLATFORM_PLUGIN_TYPES}. */
  platform: string;
  body: string;
  /** Absent means "use the host's default channel for this platform". */
  chat_id?: string;
  thread_id?: string;
  /** Email subject line. */
  subject?: string;
  conversation_id?: string;
};

/** Shared by `receipt.reason`, `candidate.failure_reason`, `candidate.cooldown_reason`. */
export const PROVIDER_FAILURE_REASONS = [
  'auth',
  'auth_permanent',
  'format',
  'rate_limit',
  'overloaded',
  'billing',
  'timeout',
  'model_not_found',
  'session_expired',
  'context_overflow',
  'unknown',
] as const;

export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

export const FAILOVER_REJECT_REASONS = [
  'provider_not_allowed',
  'provider_denied',
  'region_not_allowed',
  'organization_mismatch',
  'tools_unsupported',
  'vision_unsupported',
  'structured_output_unsupported',
  'context_window_unknown',
  'context_window_too_small',
  'pricing_stale',
  'pricing_unavailable',
  'cooldown_active',
  'budget_denied',
] as const;

export type FailoverRejectReason = (typeof FAILOVER_REJECT_REASONS)[number];

/** Rust `Result` serialized externally-tagged; exactly one key is present. */
export type FailoverDisposition = { Ok: null } | { Err: FailoverRejectReason };

export type FailoverPricing = {
  source: string;
  age_seconds: number | null;
  stale: boolean;
  priced: boolean;
  estimated_microcents: number | null;
};

export type FailoverCandidate = {
  provider: string;
  model: string;
  region: string | null;
  disposition: FailoverDisposition;
  failure_reason: ProviderFailureReason | null;
  cooldown_reason: ProviderFailureReason | null;
  retry_after_ms: number | null;
  pricing: FailoverPricing;
};

export type ProviderFailoverReceipt = {
  reason: ProviderFailureReason;
  failed_provider: string;
  failed_model: string;
  candidates: FailoverCandidate[];
  /** null = no candidate survived; the turn is about to fail. Distinct from absent. */
  selected_provider: string | null;
  selected_model: string | null;
};

export const UNKNOWN_TOOL_EFFECT_OUTCOMES = ['succeeded', 'failed', 'not_started'] as const;
export type UnknownToolEffectOutcome = (typeof UNKNOWN_TOOL_EFFECT_OUTCOMES)[number];

export const TOOL_EFFECT_EVIDENCE_SOURCES = [
  'tool_receipt',
  'provider_receipt',
  'process_observation',
  'external_system_record',
] as const;
export type ToolEffectEvidenceSource = (typeof TOOL_EFFECT_EVIDENCE_SOURCES)[number];

export type ToolEffectEvidence = {
  source: ToolEffectEvidenceSource;
  /** minLength 1, maxLength 256 in the schema; both enforced. */
  reference_id: string;
  /** minimum 1 in the schema. */
  observed_at_unix_ms: number;
  /** `sha256:`-prefixed, unlike `cursor.journal_digest`. */
  digest: string;
};

/**
 * The body shared by `unknown_tool_effect_resolved` (event) and
 * `resolve_unknown_tool_effect` (command) - the schemas are identical apart
 * from the `type` discriminator, which is why one decoder and one builder serve
 * both.
 */
export type UnknownToolEffectResolution = {
  recovery_version: number;
  session_id: string;
  turn_id: string;
  cursor: WCoreJournalCursor;
  tool_execution_id: string;
  outcome: UnknownToolEffectOutcome;
  operator_id: string;
  evidence: ToolEffectEvidence;
};

/* -------------------------------- commands ------------------------------- */

/** `host_send_message_result`. Must echo the request's `call_id` verbatim. */
export type HostSendMessageResultCommand = {
  type: 'host_send_message_result';
  call_id: string;
  ok: boolean;
  message_id?: string;
  error?: string;
};

/** `resolve_unknown_tool_effect`. `additionalProperties: false` - never spread into this. */
export type ResolveUnknownToolEffectCommand = {
  type: 'resolve_unknown_tool_effect';
  recovery_version: number;
  session_id: string;
  turn_id: string;
  cursor: WCoreJournalCursor;
  tool_execution_id: string;
  outcome: UnknownToolEffectOutcome;
  operator_id: string;
  evidence: ToolEffectEvidence;
};

/**
 * Built or refused, with a reason a human can act on.
 *
 * Refusing is a first-class outcome rather than a throw: the caller is either a
 * UI press or the decode path, and "the command was not sent because X" has to
 * reach a person, not an unhandled rejection in the main process.
 */
export type BuildOutcome<T> = { ok: true; command: T } | { ok: false; reason: string };

/* -------------------------------- helpers -------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Quote one engine-controlled value for a message, bounded. */
function quoteWire(value: unknown): string {
  const encoded = JSON.stringify(value) ?? String(value);
  if (encoded.length <= MAX_DETAIL_VALUE_LENGTH) return encoded;
  return `${encoded.slice(0, MAX_DETAIL_VALUE_LENGTH)}...(${encoded.length} chars)`;
}

/** A non-empty identifier this host is willing to hold on to or echo. */
function isWireId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WIRE_ID_LENGTH;
}

/**
 * {@link isWireId} minus the non-empty requirement.
 *
 * For inbound fields the CONTRACT declares as a bare `{"type": "string"}` with
 * no `minLength`: `""` is legal there, so refusing it would report a
 * contract-conforming message as malformed. The length bound still applies -
 * it is this host's, not the schema's, and the reason is unchanged
 * ({@link MAX_WIRE_ID_LENGTH}).
 */
function isBoundedWireString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_WIRE_ID_LENGTH;
}

/** Fault text for an optional string field, or undefined when it is acceptable. */
function optionalStringFault(field: string, value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return `${field} must be a string, got ${describeType(value)}`;
  // Empty IS allowed: no schema here sets a `minLength` on these, and an engine
  // that means "no thread" by sending "" must not have its send refused.
  if (value.length > max) return `${field} is ${value.length} characters, above the ${max} this host will deliver`;
  return undefined;
}

/** Shorten prose for the wire. See {@link MAX_ERROR_LENGTH}. */
function boundError(text: string): string {
  if (text.length <= MAX_ERROR_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_LENGTH)}...(${text.length} chars)`;
}

type Parsed<T> = { value: T } | { error: string };

/**
 * The ONE unknown-key rule, for every sub-object the schema closes.
 *
 * Written once rather than per-decoder because a rule spelled out in five
 * places is a rule that will hold in four: a wave-3 review found exactly that -
 * the cursor and the resolution refused unknown keys and cited
 * `additionalProperties: false` as the reason, while the failover receipt,
 * its candidates and their pricing carried the same schema constraint, the
 * same `criticality: safety` grading, and no check at all.
 *
 * The fault names the field(s), bounded by {@link quoteWire}: the COUNT of
 * unknown keys is wire-controlled and unbounded, so the joined list is the one
 * detail in this module that a hostile engine could otherwise make arbitrarily
 * long.
 */
function unknownKeyFault(
  raw: Record<string, unknown>,
  declared: ReadonlySet<string>,
  where: string
): string | undefined {
  const unknown = Object.keys(raw).filter((key) => !declared.has(key));
  if (unknown.length === 0) return undefined;
  return `${where} carries unknown field(s): ${quoteWire(unknown.toSorted().join(', '))}`;
}

const CURSOR_KEYS: ReadonlySet<string> = new Set(['journal_digest', 'journal_sequence']);

/**
 * Decode a journal cursor, or say why it cannot be one.
 *
 * UNKNOWN KEYS ARE REFUSED: the cursor subschema is `additionalProperties:
 * false`, and this object is the compare-and-swap token the engine matches a
 * resolution against. A key this host does not model may be part of the
 * cursor's identity.
 *
 * The pattern is imported from `turnRecovery` rather than re-declared - that
 * module owns the journal cursor, and two copies of a 64-hex regex are two
 * things that drift.
 */
function parseJournalCursor(raw: unknown, where: string): Parsed<WCoreJournalCursor> {
  if (!isRecord(raw)) return { error: `${where} is not an object (got ${describeType(raw)})` };

  const digest = raw.journal_digest;
  if (typeof digest !== 'string' || !JOURNAL_DIGEST_PATTERN.test(digest)) {
    return { error: `${where}.journal_digest is not 64 lowercase hex chars` };
  }

  const unknown = unknownKeyFault(raw, CURSOR_KEYS, where);
  if (unknown !== undefined) return { error: unknown };

  const cursor: WCoreJournalCursor = { journal_digest: digest };
  const sequence = raw.journal_sequence;
  if (sequence !== undefined) {
    if (!Number.isInteger(sequence)) return { error: `${where}.journal_sequence is not an integer` };
    cursor.journal_sequence = sequence as number;
  }
  return { value: cursor };
}

/* --------------------------- delivery: decoding -------------------------- */

/** What a {@link MessageDeliverer} is asked to do. */
export type DeliveryRequest = {
  /** Echoed into the answer verbatim. Never parsed, never reformatted. */
  callId: string;
  /** The engine's platform name, for messages the user reads. */
  platform: string;
  /**
   * Darhai plugin types to try, in preference order, resolved from
   * {@link PLATFORM_PLUGIN_TYPES} through {@link pluginTypesFor}. Always an
   * array and never empty - an unmapped platform, and every inherited
   * `Object.prototype` name that a bare index read would have answered for, is
   * refused before a deliverer is ever called.
   */
  pluginTypes: readonly BuiltinPluginType[];
  body: string;
  /** Absent means "the host's default channel for this platform". */
  chatId?: string;
  threadId?: string;
  subject?: string;
  conversationId?: string;
};

/** What a delivery attempt produced. */
export type DeliveryOutcome = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * The seam between this capability and Darhai's channel fleet.
 *
 * It is a function rather than a direct `PluginManager` reference for two
 * reasons: a `CapabilityHandler` may only speak through what it is handed, and
 * everything below stays drivable in a unit test without a plugin process. The
 * implementation is expected to pick the first RUNNING plugin among
 * {@link DeliveryRequest.pluginTypes} and call
 * `sendMessage(chatId, { type: 'text', text: body, subject })`, whose return
 * value is the platform message id - exactly `host_send_message_result.message_id`.
 *
 * It MUST NOT throw for an ordinary failure (answer `ok:false` instead), but a
 * throw and a rejection are both contained here anyway.
 */
export type MessageDeliverer = (request: DeliveryRequest) => Promise<DeliveryOutcome>;

/**
 * Decode `host_send_message_request`.
 *
 * The event branch is `additionalProperties: true`, so unknown top-level keys
 * are TOLERATED - the opposite direction from the recovery command below, and
 * deliberately: an engine that adds a delivery hint must not turn every send
 * into a refusal, and nothing here acts on a field it does not model.
 */
export function decodeHostSendMessageRequest(raw: unknown): Parsed<WCoreHostSendMessageRequest> {
  if (!isRecord(raw)) return { error: `event is not an object (got ${describeType(raw)})` };
  if (raw.type !== 'host_send_message_request') {
    return { error: `not a host_send_message_request: ${quoteWire(raw.type)}` };
  }
  if (!isWireId(raw.call_id)) {
    return { error: `call_id is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters` };
  }
  if (typeof raw.platform !== 'string' || raw.platform.length === 0) {
    return { error: `platform is not a non-empty string (got ${quoteWire(raw.platform)})` };
  }
  if (raw.platform.length > MAX_PLATFORM_LENGTH) {
    return {
      error: `platform is ${raw.platform.length} characters, above the ${MAX_PLATFORM_LENGTH} this host accepts`,
    };
  }
  if (typeof raw.body !== 'string') return { error: `body must be a string, got ${describeType(raw.body)}` };
  if (raw.body.length > MAX_BODY_LENGTH) {
    return { error: `body is ${raw.body.length} characters, above the ${MAX_BODY_LENGTH} this host will deliver` };
  }

  const request: WCoreHostSendMessageRequest = {
    type: 'host_send_message_request',
    call_id: raw.call_id,
    platform: raw.platform,
    body: raw.body,
  };

  // Optional ids: an engine that sent a NUMBER for one of these would otherwise
  // reach a channel plugin as one, and `chat_id` decides WHO receives the
  // message.
  for (const field of ['chat_id', 'thread_id', 'conversation_id'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const fault = optionalStringFault(field, value, MAX_WIRE_ID_LENGTH);
    if (fault) return { error: fault };
    request[field] = value as string;
  }

  if (raw.subject !== undefined) {
    const fault = optionalStringFault('subject', raw.subject, MAX_SUBJECT_LENGTH);
    if (fault) return { error: fault };
    request.subject = raw.subject as string;
  }

  return { value: request };
}

/**
 * Build `host_send_message_result`, or refuse and say why.
 *
 * The only sanctioned constructor. Assembled field-by-field from named inputs
 * and caller objects are NEVER spread, so a stray key cannot ride along.
 *
 * Two rules are STRICTER than the schema, and both are stated because the
 * contract is silent rather than permissive by accident:
 *
 *  - a failure must carry a non-empty `error`. `compat/commands/
 *    host_send_message_result.minimal.json` proves the ENGINE tolerates a bare
 *    `{call_id, ok:false}`, but every failure path in this module knows why it
 *    failed, and "no channel is configured for slack" is a configuration
 *    problem only the user can fix. This host never sends an unexplained
 *    failure;
 *  - `message_id` is refused on a failure. It is the receipt of a delivered
 *    message; attaching one to a failure would let a UI offer a link to
 *    something that does not exist.
 *
 * On success `error: ''` is included, which is what the engine's own example
 * (`commands/host_send_message_result.json`) does - byte-identical to the
 * contract rather than merely valid against it.
 */
export function buildHostSendMessageResult(input: {
  callId: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}): BuildOutcome<HostSendMessageResultCommand> {
  if (!isWireId(input.callId)) {
    return { ok: false, reason: `call_id must be a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters` };
  }
  // Never coerce: a truthy string here would report a failed delivery as sent.
  if (typeof input.ok !== 'boolean') {
    return { ok: false, reason: `ok must be a boolean, got ${describeType(input.ok)}` };
  }
  if (input.messageId !== undefined) {
    if (!isWireId(input.messageId)) {
      return { ok: false, reason: `message_id must be a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters` };
    }
    if (input.ok === false) return { ok: false, reason: 'a failed delivery has no platform message_id' };
  }
  if (input.error !== undefined && typeof input.error !== 'string') {
    return { ok: false, reason: `error must be a string, got ${describeType(input.error)}` };
  }
  if (input.ok === false && (input.error === undefined || input.error.length === 0)) {
    return { ok: false, reason: 'a failed delivery must carry a non-empty error for the user to act on' };
  }

  const command: HostSendMessageResultCommand = {
    type: 'host_send_message_result',
    call_id: input.callId,
    ok: input.ok,
  };
  if (input.messageId !== undefined) command.message_id = input.messageId;
  command.error = input.error === undefined ? '' : boundError(input.error);
  return { ok: true, command };
}

/**
 * What the task layer is told about one delivery.
 *
 * `ok` and `severity` are LITERALS, not the general `boolean`/union they were:
 * only failures are announced (see {@link emitDeliveryFrame}), so the success
 * arm of both was unreachable by construction - a branch that reports as
 * covered and that no test could ever kill. The field is kept rather than
 * dropped because a renderer switching on `frame.ok` should keep compiling; it
 * simply cannot be told a lie about which arm it is in.
 */
export type HostDeliveryFrame = {
  capability: typeof HOST_DELEGATED_DELIVERY_CAPABILITY;
  callId: string;
  platform: string;
  ok: false;
  /** Why it failed, in the words that went to the engine. */
  error: string;
  /** True when nothing was even attempted - a configuration problem, not a send failure. */
  unconfigured: boolean;
  severity: 'warning';
};

/**
 * Put the answer on the wire.
 *
 * `sendCommand` drops silently when the engine is gone and THROWS when the
 * stream dies mid-write. The throw is contained here because this runs inside
 * the decode path (and inside a timer callback): losing the turn - or an
 * unhandled rejection in the main process - over a write that failed for a
 * connection that is already gone would be a worse outcome than the send the
 * engine is waiting on.
 */
function writeAnswer(ctx: CapabilityContext, command: HostSendMessageResultCommand): void {
  try {
    ctx.sendCommand(command);
  } catch (cause) {
    ctx.warn(`host_send_message_result for "${command.call_id}" failed to reach the engine: ${String(cause)}`);
  }
}

/**
 * Only failures are announced.
 *
 * A successful delivery is already visible to the user - the agent reports
 * its own tool result - and a frame per sent message would be noise. A
 * FAILURE is different: "no Slack plugin is running" is a configuration
 * problem the agent's tool error cannot fix and the user must see.
 *
 * SO THERE IS NO `ok` PARAMETER. It used to take one, and the single call site
 * has always passed `false`, which made `severity: ok ? 'info' : 'warning'` a
 * ternary with a dead arm: mutating it to the constant `'warning'` survived the
 * whole suite. The parameter is gone rather than tested, because the only test
 * that could have killed the mutant would have had to call this function with
 * an argument the module never produces.
 */
function emitDeliveryFrame(
  ctx: CapabilityContext,
  callId: string,
  platform: string,
  error: string,
  unconfigured: boolean
): void {
  const data: HostDeliveryFrame = {
    capability: HOST_DELEGATED_DELIVERY_CAPABILITY,
    callId,
    platform,
    ok: false,
    error,
    unconfigured,
    severity: 'warning',
  };
  ctx.emit({ type: 'host_send_message_request', data, msg_id: ctx.activeMsgId() });
}

/**
 * Write the answer the engine is waiting for, and tell the renderer when it
 * is bad news.
 *
 * THE `built.ok === true` SHAPE IS A NARROWING, NOT A GUARD, and it is written
 * this way round on purpose. {@link buildHostSendMessageResult} can refuse for
 * exactly four reasons, and every one of them is prevented before this function
 * is reached: an unusable `call_id` is refused in `handleSendRequest` before any
 * delivery starts, `ok` is a literal here, `message_id` is only ever passed on
 * the success arm and is validated by {@link readDeliveryOutcome}, and a failure
 * always carries a non-empty error for the same reason. So there is no
 * second-chance answer path below - only a bug report. An earlier draft had a
 * build-then-rebuild fallback here; it was unreachable by construction, which
 * made it decoration no test could ever kill, and it is gone.
 *
 * The same reasoning removed a second piece of decoration a wave-3 review
 * caught still standing: `built.command.error ?? ''`. The builder assigns
 * `error` unconditionally on every arm, so the coalesce could not fire, and
 * deleting it survived the suite. It is read straight now.
 */
function answer(
  ctx: CapabilityContext,
  callId: string,
  platform: string,
  outcome: DeliveryOutcome,
  unconfigured: boolean
): void {
  const built =
    outcome.ok === false
      ? buildHostSendMessageResult({ callId, ok: false, error: outcome.error })
      : buildHostSendMessageResult({ callId, ok: true, messageId: outcome.messageId });

  if (built.ok === true) {
    writeAnswer(ctx, built.command);
    const errorText = built.command.error;
    if (outcome.ok === false) {
      ctx.warn(`delivery on ${quoteWire(platform)} failed for "${callId}": ${errorText}`);
      emitDeliveryFrame(ctx, callId, platform, errorText, unconfigured);
      return;
    }
    ctx.log(
      `delivered on ${quoteWire(platform)} for "${callId}"${outcome.messageId ? ` as ${outcome.messageId}` : ''}`
    );
    return;
  }

  ctx.warn(`host bug: no host_send_message_result could be built for "${callId}": ${built.reason}`);
}

/** Normalise whatever the deliverer returned; it is host code, but its answer becomes a wire command. */
function readDeliveryOutcome(raw: unknown): DeliveryOutcome {
  if (!isRecord(raw)) return { ok: false, error: `the delivery transport returned ${describeType(raw)}` };
  if (raw.ok === true) {
    if (raw.messageId === undefined) return { ok: true };
    if (!isWireId(raw.messageId)) {
      return {
        ok: false,
        error: `the delivery transport reported success with an unusable message id (${quoteWire(raw.messageId)})`,
      };
    }
    return { ok: true, messageId: raw.messageId };
  }
  if (raw.ok !== false) {
    return { ok: false, error: `the delivery transport returned ok=${quoteWire(raw.ok)}` };
  }
  const error = typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : 'the delivery transport failed';
  return { ok: false, error };
}

/* --------------------------- failover: decoding -------------------------- */

/** `receipt`, `receipt.candidates[]` and `.pricing` are all `additionalProperties: false`. */
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'reason',
  'failed_provider',
  'failed_model',
  'candidates',
  'selected_provider',
  'selected_model',
]);

const CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  'region',
  'disposition',
  'failure_reason',
  'cooldown_reason',
  'retry_after_ms',
  'pricing',
]);

const PRICING_KEYS: ReadonlySet<string> = new Set(['source', 'age_seconds', 'stale', 'priced', 'estimated_microcents']);

function parsePricing(raw: unknown, where: string): Parsed<FailoverPricing> {
  if (!isRecord(raw)) return { error: `${where} is not an object (got ${describeType(raw)})` };
  const unknown = unknownKeyFault(raw, PRICING_KEYS, where);
  if (unknown !== undefined) return { error: unknown };
  if (typeof raw.source !== 'string' || raw.source.length > MAX_WIRE_ID_LENGTH) {
    return { error: `${where}.source is not a string of at most ${MAX_WIRE_ID_LENGTH} characters` };
  }
  if (typeof raw.stale !== 'boolean') return { error: `${where}.stale is not a boolean` };
  if (typeof raw.priced !== 'boolean') return { error: `${where}.priced is not a boolean` };

  const numbers: Record<'age_seconds' | 'estimated_microcents', number | null> = {
    age_seconds: null,
    estimated_microcents: null,
  };
  for (const field of ['age_seconds', 'estimated_microcents'] as const) {
    const value = raw[field];
    if (value === null) continue;
    // `minimum: 0` on both, and a negative age or price would be rendered.
    if (!Number.isInteger(value) || (value as number) < 0) {
      return { error: `${where}.${field} is not a non-negative integer or null` };
    }
    numbers[field] = value as number;
  }

  return {
    value: {
      source: raw.source,
      age_seconds: numbers.age_seconds,
      stale: raw.stale,
      priced: raw.priced,
      estimated_microcents: numbers.estimated_microcents,
    },
  };
}

/** `null` or a declared failure reason; anything else is a fault. */
function parseNullableFailureReason(raw: unknown, where: string): Parsed<ProviderFailureReason | null> {
  if (raw === null) return { value: null };
  if (typeof raw !== 'string' || !PROVIDER_FAILURE_REASONS.includes(raw as ProviderFailureReason)) {
    return { error: `${where} is not a declared failure reason or null (${quoteWire(raw)})` };
  }
  return { value: raw as ProviderFailureReason };
}

/**
 * Decode the externally-tagged `Result` the Rust side serializes.
 *
 * Exactly ONE key must be present. An object carrying both `Ok` and `Err`, or
 * neither, does not say whether the candidate was accepted, and picking either
 * half would be a guess about which provider the turn is now using.
 */
function parseDisposition(raw: unknown, where: string): Parsed<FailoverDisposition> {
  if (!isRecord(raw)) return { error: `${where} is not an object (got ${describeType(raw)})` };
  const keys = Object.keys(raw);
  if (keys.length !== 1) {
    return { error: `${where} must carry exactly one of Ok/Err, got ${quoteWire(keys.toSorted().join(', '))}` };
  }
  if (keys[0] === 'Ok') {
    if (raw.Ok !== null) return { error: `${where}.Ok must be null, got ${quoteWire(raw.Ok)}` };
    return { value: { Ok: null } };
  }
  if (keys[0] !== 'Err') return { error: `${where} carries neither Ok nor Err (${quoteWire(keys[0])})` };
  const reason = raw.Err;
  if (typeof reason !== 'string' || !FAILOVER_REJECT_REASONS.includes(reason as FailoverRejectReason)) {
    return { error: `${where}.Err is not a declared reject reason (${quoteWire(reason)})` };
  }
  return { value: { Err: reason as FailoverRejectReason } };
}

function parseCandidate(raw: unknown, where: string): Parsed<FailoverCandidate> {
  if (!isRecord(raw)) return { error: `${where} is not an object (got ${describeType(raw)})` };
  const unknown = unknownKeyFault(raw, CANDIDATE_KEYS, where);
  if (unknown !== undefined) return { error: unknown };
  if (!isWireId(raw.provider)) return { error: `${where}.provider is not a usable provider name` };
  if (!isWireId(raw.model)) return { error: `${where}.model is not a usable model name` };
  if (raw.region !== null && (typeof raw.region !== 'string' || raw.region.length > MAX_WIRE_ID_LENGTH)) {
    return { error: `${where}.region is not a string of at most ${MAX_WIRE_ID_LENGTH} characters or null` };
  }

  const disposition = parseDisposition(raw.disposition, `${where}.disposition`);
  if ('error' in disposition) return { error: disposition.error };

  const failure = parseNullableFailureReason(raw.failure_reason, `${where}.failure_reason`);
  if ('error' in failure) return { error: failure.error };

  const cooldown = parseNullableFailureReason(raw.cooldown_reason, `${where}.cooldown_reason`);
  if ('error' in cooldown) return { error: cooldown.error };

  let retryAfterMs: number | null = null;
  if (raw.retry_after_ms !== null) {
    if (!Number.isInteger(raw.retry_after_ms) || (raw.retry_after_ms as number) < 0) {
      return { error: `${where}.retry_after_ms is not a non-negative integer or null` };
    }
    retryAfterMs = raw.retry_after_ms as number;
  }

  const pricing = parsePricing(raw.pricing, `${where}.pricing`);
  if ('error' in pricing) return { error: pricing.error };

  return {
    value: {
      provider: raw.provider,
      model: raw.model,
      region: raw.region as string | null,
      disposition: disposition.value,
      failure_reason: failure.value,
      cooldown_reason: cooldown.value,
      retry_after_ms: retryAfterMs,
      pricing: pricing.value,
    },
  };
}

/**
 * Decode `provider_failover_receipt`.
 *
 * Strict on every field it models, because the alternative is telling the user
 * a provider story that is only partly true. A receipt that fails to decode is
 * NOT swallowed: the handler still emits a frame saying the engine reported a
 * failover this host could not read - which is strictly more than today's
 * silence, and the reason this decoder can afford to be strict at all.
 *
 * `selected_provider` and `selected_model` must AGREE about whether anything
 * was selected. The schema allows one null and one not; the contract says
 * nothing about what that would mean, and it is precisely the field pair that
 * decides whether the turn is about to fail. Fail closed.
 *
 * THE TWO LEVELS ARE DELIBERATELY DIFFERENT. The EVENT is
 * `additionalProperties: true`, so a future top-level hint is tolerated and the
 * failover is still reported. `receipt` and everything under it are
 * `additionalProperties: false`, and are held to it - see
 * {@link unknownKeyFault}.
 */
export function decodeProviderFailoverReceipt(raw: unknown): Parsed<ProviderFailoverReceipt> {
  if (!isRecord(raw)) return { error: `event is not an object (got ${describeType(raw)})` };
  const receipt = raw.receipt;
  if (!isRecord(receipt)) return { error: `receipt is not an object (got ${describeType(receipt)})` };

  const unknownReceiptKey = unknownKeyFault(receipt, RECEIPT_KEYS, 'receipt');
  if (unknownReceiptKey !== undefined) return { error: unknownReceiptKey };

  const reason = receipt.reason;
  if (typeof reason !== 'string' || !PROVIDER_FAILURE_REASONS.includes(reason as ProviderFailureReason)) {
    return { error: `receipt.reason is not a declared failure reason (${quoteWire(reason)})` };
  }
  if (!isWireId(receipt.failed_provider)) return { error: 'receipt.failed_provider is not a usable provider name' };
  if (!isWireId(receipt.failed_model)) return { error: 'receipt.failed_model is not a usable model name' };

  if (!Array.isArray(receipt.candidates)) {
    return { error: `receipt.candidates is not an array (got ${describeType(receipt.candidates)})` };
  }
  if (receipt.candidates.length > MAX_FAILOVER_CANDIDATES) {
    return {
      error: `receipt carries ${receipt.candidates.length} candidates, above the ${MAX_FAILOVER_CANDIDATES} this host will read`,
    };
  }

  const candidates: FailoverCandidate[] = [];
  for (const [index, rawCandidate] of (receipt.candidates as unknown[]).entries()) {
    const parsed = parseCandidate(rawCandidate, `receipt.candidates[${index}]`);
    if ('error' in parsed) return { error: parsed.error };
    candidates.push(parsed.value);
  }

  for (const field of ['selected_provider', 'selected_model'] as const) {
    const value = receipt[field];
    if (value === null) continue;
    if (!isWireId(value)) return { error: `receipt.${field} is not a usable name or null` };
  }
  const selectedProvider = receipt.selected_provider as string | null;
  const selectedModel = receipt.selected_model as string | null;
  if ((selectedProvider === null) !== (selectedModel === null)) {
    return {
      error: `receipt names ${quoteWire(selectedProvider)} as the selected provider and ${quoteWire(selectedModel)} as the selected model; one is null and the other is not, so this host cannot say whether the turn has a provider`,
    };
  }

  return {
    value: {
      reason: reason as ProviderFailureReason,
      failed_provider: receipt.failed_provider,
      failed_model: receipt.failed_model,
      candidates,
      selected_provider: selectedProvider,
      selected_model: selectedModel,
    },
  };
}

/** What the task layer is told about one failover. */
export type ProviderFailoverFrame = {
  capability: typeof SEMANTIC_FAILOVER_CAPABILITY;
  /** `switched` - a provider was chosen; `exhausted` - none was; `malformed` - unreadable. */
  verdict: 'switched' | 'exhausted' | 'malformed';
  severity: 'info' | 'warning' | 'error';
  detail: string;
  reason: ProviderFailureReason | null;
  failedProvider: string | null;
  failedModel: string | null;
  /** null is preserved as null - it is the "nothing survived" signal. */
  selectedProvider: string | null;
  selectedModel: string | null;
  candidates: FailoverCandidate[];
  rejectedCount: number;
};

/** Human-readable "why this candidate was not used", for the frame's detail line. */
function describeRejection(candidate: FailoverCandidate): string {
  const disposition = 'Err' in candidate.disposition ? candidate.disposition.Err : 'accepted';
  return `${candidate.provider}/${candidate.model}: ${disposition}`;
}

function handleFailoverReceipt(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
  const decoded = decodeProviderFailoverReceipt(event);
  if ('error' in decoded) {
    const frame: ProviderFailoverFrame = {
      capability: SEMANTIC_FAILOVER_CAPABILITY,
      verdict: 'malformed',
      severity: 'warning',
      detail: `the engine reported a provider failover this host could not read: ${decoded.error}`,
      reason: null,
      failedProvider: null,
      failedModel: null,
      selectedProvider: null,
      selectedModel: null,
      candidates: [],
      rejectedCount: 0,
    };
    // Warned AND announced. A safety-class receipt that cannot be read still
    // tells the user their turn changed provider for reasons nobody can see,
    // which is strictly more than the silence this event has today.
    ctx.warn(frame.detail, event);
    ctx.emit({ type: 'provider_failover_receipt', data: frame, msg_id: ctx.activeMsgId() });
    return true;
  }

  const receipt = decoded.value;
  const rejected = receipt.candidates.filter((candidate) => 'Err' in candidate.disposition);
  const exhausted = receipt.selected_provider === null;
  const detail = exhausted
    ? `${receipt.failed_provider}/${receipt.failed_model} failed (${receipt.reason}) and no provider survived: ${
        rejected.length === 0 ? 'no candidate was even considered' : rejected.map(describeRejection).join('; ')
      }`
    : `${receipt.failed_provider}/${receipt.failed_model} failed (${receipt.reason}), switched to ${receipt.selected_provider}/${receipt.selected_model}`;

  const frame: ProviderFailoverFrame = {
    capability: SEMANTIC_FAILOVER_CAPABILITY,
    verdict: exhausted ? 'exhausted' : 'switched',
    // `exhausted` is the case where the turn is about to die with no
    // explanation - today indistinguishable from a generic error. It is the
    // one this event exists to surface, so it is graded error, not warning.
    severity: exhausted ? 'error' : 'info',
    detail,
    reason: receipt.reason,
    failedProvider: receipt.failed_provider,
    failedModel: receipt.failed_model,
    selectedProvider: receipt.selected_provider,
    selectedModel: receipt.selected_model,
    candidates: receipt.candidates,
    rejectedCount: rejected.length,
  };

  // Always warned, whichever way it went: the manifest grades this event
  // `criticality: safety`, and a silent provider switch is a change of who
  // saw the user's conversation.
  ctx.warn(`provider_failover_receipt: ${detail}`, receipt);
  ctx.emit({ type: 'provider_failover_receipt', data: frame, msg_id: ctx.activeMsgId() });
  return true;
}

/* ----------------------- unknown tool effect: decoding ------------------- */

/** Every key the schema lets the resolution body carry, `type` included. */
const RESOLUTION_KEYS: ReadonlySet<string> = new Set([
  'type',
  'recovery_version',
  'session_id',
  'turn_id',
  'cursor',
  'tool_execution_id',
  'outcome',
  'operator_id',
  'evidence',
]);

const EVIDENCE_KEYS: ReadonlySet<string> = new Set(['source', 'reference_id', 'observed_at_unix_ms', 'digest']);

/** The command half of the pair; the discriminator that says which way a decode is going. */
export const RESOLVE_UNKNOWN_TOOL_EFFECT_TYPE = 'resolve_unknown_tool_effect';

/**
 * The four identifiers whose strictness depends on the DIRECTION of travel.
 *
 * MEASURED AGAINST THE SCHEMAS, both of them: `session_id`, `turn_id`,
 * `tool_execution_id` and `operator_id` are declared `{"type": "string"}` with
 * NO `minLength` in `core-event.schema.json` and in `host-command.schema.json`
 * alike. So `operator_id: ""` is a CONTRACT-LEGAL `unknown_tool_effect_resolved`,
 * and an earlier draft of this decoder reported it as malformed - refusing a
 * safety-class inbound event for a shape the engine is entitled to send.
 *
 * Inbound (`unknown_tool_effect_resolved`) is therefore held to the contract:
 * bounded, possibly empty. Outbound (`resolve_unknown_tool_effect`) is held to
 * this host's stricter rule, and the asymmetry is the safe direction - the host
 * can READ anything it can BUILD, never the reverse. It is stricter because a
 * command it mints with an empty `operator_id` leaves "who settled this payment
 * question" unanswerable, and one with an empty `tool_execution_id` names
 * nothing in the correlation tuple the manifest keys the pair on
 * (`session_turn_tool_and_cursor`).
 */
const RESOLUTION_ID_FIELDS = ['session_id', 'turn_id', 'tool_execution_id', 'operator_id'] as const;

/** Schema: `reference_id` is 1..256 characters. */
export const MAX_EVIDENCE_REFERENCE_LENGTH = 256;

export function parseToolEffectEvidence(raw: unknown): Parsed<ToolEffectEvidence> {
  if (!isRecord(raw)) return { error: `evidence is not an object (got ${describeType(raw)})` };

  const unknown = unknownKeyFault(raw, EVIDENCE_KEYS, 'evidence');
  if (unknown !== undefined) return { error: unknown };

  const source = raw.source;
  if (typeof source !== 'string' || !TOOL_EFFECT_EVIDENCE_SOURCES.includes(source as ToolEffectEvidenceSource)) {
    return { error: `evidence.source is not a declared source (${quoteWire(source)})` };
  }
  const reference = raw.reference_id;
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > MAX_EVIDENCE_REFERENCE_LENGTH) {
    return { error: `evidence.reference_id is not 1..${MAX_EVIDENCE_REFERENCE_LENGTH} characters` };
  }
  const observedAt = raw.observed_at_unix_ms;
  if (!Number.isInteger(observedAt) || (observedAt as number) < 1) {
    return { error: `evidence.observed_at_unix_ms is not an integer >= 1 (${quoteWire(observedAt)})` };
  }
  const digest = raw.digest;
  if (typeof digest !== 'string' || !EVIDENCE_DIGEST_PATTERN.test(digest)) {
    return { error: 'evidence.digest is not sha256: followed by 64 lowercase hex chars' };
  }

  return {
    value: {
      source: source as ToolEffectEvidenceSource,
      reference_id: reference,
      observed_at_unix_ms: observedAt as number,
      digest,
    },
  };
}

/**
 * Decode the shared resolution body from either carrier.
 *
 * UNKNOWN TOP-LEVEL KEYS ARE REFUSED here, unlike on the delivery request: both
 * schemas are `additionalProperties: false`, the manifest grades both
 * `criticality: safety`, and this message is an authoritative claim about
 * whether a real-world side effect happened. A key this host does not model may
 * be the half that qualifies the claim, and there is no safe way to settle a
 * question about a payment from a message that was only partly read.
 *
 * THE FOUR IDENTIFIERS ARE JUDGED BY DIRECTION, and `type` is what says which
 * way this call is going. See {@link RESOLUTION_ID_FIELDS}.
 */
export function decodeUnknownToolEffectResolution(raw: unknown, type: string): Parsed<UnknownToolEffectResolution> {
  if (!isRecord(raw)) return { error: `event is not an object (got ${describeType(raw)})` };
  if (raw.type !== type) return { error: `not a ${type}: ${quoteWire(raw.type)}` };

  const unknown = unknownKeyFault(raw, RESOLUTION_KEYS, type);
  if (unknown !== undefined) return { error: unknown };

  // The schema pins `recovery_version` to `const: 1`, and the engine publishes
  // `unsupported_version` as a refusal of its own - both sides treat this as a
  // hard gate. Checked before any other field, because on a version this host
  // does not speak the meaning of every field below is what is in question.
  if (raw.recovery_version !== RECOVERY_VERSION) {
    return { error: `recovery_version ${quoteWire(raw.recovery_version)} is not ${RECOVERY_VERSION}` };
  }

  const minting = type === RESOLVE_UNKNOWN_TOOL_EFFECT_TYPE;
  for (const field of RESOLUTION_ID_FIELDS) {
    const value = raw[field];
    if (minting ? !isWireId(value) : !isBoundedWireString(value)) {
      return {
        error: minting
          ? `${field} is not a non-empty string of at most ${MAX_WIRE_ID_LENGTH} characters`
          : `${field} is not a string of at most ${MAX_WIRE_ID_LENGTH} characters`,
      };
    }
  }

  const cursor = parseJournalCursor(raw.cursor, 'cursor');
  if ('error' in cursor) return { error: cursor.error };

  const outcome = raw.outcome;
  if (typeof outcome !== 'string' || !UNKNOWN_TOOL_EFFECT_OUTCOMES.includes(outcome as UnknownToolEffectOutcome)) {
    return { error: `outcome is not a declared outcome (${quoteWire(outcome)})` };
  }

  const evidence = parseToolEffectEvidence(raw.evidence);
  if ('error' in evidence) return { error: evidence.error };

  return {
    value: {
      recovery_version: RECOVERY_VERSION,
      session_id: raw.session_id as string,
      turn_id: raw.turn_id as string,
      cursor: cursor.value,
      tool_execution_id: raw.tool_execution_id as string,
      outcome: outcome as UnknownToolEffectOutcome,
      operator_id: raw.operator_id as string,
      evidence: evidence.value,
    },
  };
}

/** What a caller asks for. Converted field-by-field; never spread. */
export type ResolveUnknownToolEffectInput = {
  sessionId: string;
  turnId: string;
  toolExecutionId: string;
  operatorId: string;
  outcome: UnknownToolEffectOutcome;
  cursor: WCoreJournalCursor;
  evidence: {
    source: ToolEffectEvidenceSource;
    referenceId: string;
    observedAtUnixMs: number;
    digest: string;
  };
};

/**
 * Build `resolve_unknown_tool_effect`, or refuse and say why.
 *
 * PURE, and the only sanctioned constructor. The command is
 * `additionalProperties: false` with two differently-shaped regex-constrained
 * digests, so it is assembled field-by-field from named inputs; a caller object
 * is never spread, which makes a stray key unrepresentable rather than merely
 * checked for.
 *
 * The validation runs through the same decoder the incoming event uses, on its
 * command arm - which is stricter on the four bare-string identifiers and
 * identical everywhere else (see {@link RESOLUTION_ID_FIELDS}). That asymmetry
 * only ever runs one way: this host cannot build a command it would itself
 * refuse to read.
 */
export function buildResolveUnknownToolEffect(
  input: ResolveUnknownToolEffectInput
): BuildOutcome<ResolveUnknownToolEffectCommand> {
  if (!isRecord(input)) return { ok: false, reason: `input is not an object (got ${describeType(input)})` };
  // Typed as a bag rather than as `ToolEffectEvidence`: a caller reaching this
  // over IPC has lost the declared types, so an absent or non-object `evidence`
  // must be REPRESENTABLE here in order to be refused below.
  const evidence: Record<string, unknown> = isRecord(input.evidence) ? input.evidence : {};

  const candidate = {
    type: RESOLVE_UNKNOWN_TOOL_EFFECT_TYPE,
    recovery_version: RECOVERY_VERSION,
    session_id: input.sessionId,
    turn_id: input.turnId,
    cursor: input.cursor,
    tool_execution_id: input.toolExecutionId,
    outcome: input.outcome,
    operator_id: input.operatorId,
    evidence: {
      source: evidence.source,
      reference_id: evidence.referenceId,
      observed_at_unix_ms: evidence.observedAtUnixMs,
      digest: evidence.digest,
    },
  };

  const decoded = decodeUnknownToolEffectResolution(candidate, RESOLVE_UNKNOWN_TOOL_EFFECT_TYPE);
  if ('error' in decoded) return { ok: false, reason: decoded.error };

  const body = decoded.value;
  return {
    ok: true,
    command: {
      type: 'resolve_unknown_tool_effect',
      recovery_version: body.recovery_version,
      session_id: body.session_id,
      turn_id: body.turn_id,
      cursor: body.cursor,
      tool_execution_id: body.tool_execution_id,
      outcome: body.outcome,
      operator_id: body.operator_id,
      evidence: body.evidence,
    },
  };
}

/** What the task layer is told about one resolved effect. */
export type UnknownToolEffectFrame = {
  capability: typeof OPERATOR_TOOL_EFFECT_CAPABILITY;
  verdict: 'accepted' | 'malformed';
  severity: 'info' | 'warning';
  detail: string;
  resolution: UnknownToolEffectResolution | null;
  /**
   * True when this echoes a `resolve_unknown_tool_effect` THIS host sent.
   *
   * The manifest correlates the pair on `session_turn_tool_and_cursor`, so the
   * key is that tuple. An uncorrelated resolution is still shown - nothing in
   * the contract says this host is the only party that can resolve an effect,
   * and dropping a safety-class event because we did not ask for it is the
   * silence this capability exists to end - but it is flagged and warned about.
   */
  correlated: boolean;
};

/** The correlation key the manifest names: `session_turn_tool_and_cursor`. */
function resolutionKey(body: {
  session_id: string;
  turn_id: string;
  tool_execution_id: string;
  cursor: WCoreJournalCursor;
}): string {
  // JSON-encoded rather than joined on a separator: every component is a
  // WIRE-CONTROLLED string, so any literal delimiter could appear inside one and
  // let two different tuples collide on one key.
  return JSON.stringify([body.session_id, body.turn_id, body.tool_execution_id, body.cursor.journal_digest]);
}

/* ------------------------------ the capability --------------------------- */

/** Where the negotiated contract for a session is read from. */
export type ContractSource = (sessionId: string) => NegotiatedContract;

export type ResolveSendOutcome = { ok: true; key: string } | { ok: false; reason: string };

export type HostDelegatedDeliveryCapability = CapabilityHandler & {
  /**
   * Install the adapter to Darhai's channel fleet, or `null` to remove it.
   *
   * WITHOUT ONE EVERY DELIVERY IS DECLINED, immediately and with a reason. That
   * is the deliberate default: the engine learns at once that this build cannot
   * deliver, instead of waiting out its own timeout for an answer that was never
   * coming.
   */
  setMessageDeliverer(deliverer: MessageDeliverer | null): void;
  /**
   * Override where the negotiated contract comes from. Defaults to
   * {@link turnRecoveryCapability}, so ONE `ready` seed arms both capabilities;
   * `null` restores that default.
   */
  setContractSource(source: ContractSource | null): void;
  /** The contract seen for a session, or {@link NO_CONTRACT} - which gates shut. */
  contractFor(sessionId: string): NegotiatedContract;
  /**
   * Send `resolve_unknown_tool_effect`. The ONLY sanctioned send path: it gates
   * on the negotiated grade and on there being no turn in flight.
   */
  sendResolveUnknownToolEffect(ctx: CapabilityContext, input: ResolveUnknownToolEffectInput): ResolveSendOutcome;
  /** Deliveries awaiting an answer, oldest first. For diagnostics and tests. */
  inFlightCallIds(): readonly string[];
  /** Correlation keys of resolutions this host sent. For diagnostics and tests. */
  pendingResolutionKeys(): readonly string[];
  /** Forget all in-flight deliveries and sent resolutions. For a NEW engine process. */
  reset(): void;
};

/**
 * One delivery awaiting an answer.
 *
 * There is no `settled` flag: PRESENCE IN THE MAP IS THE LATCH. A separate
 * boolean would have been a second guard for the same invariant that no input
 * could ever exercise on its own - `settle` deletes the entry before it
 * answers, so a second settle finds nothing whatever the flag said.
 */
type InFlightSend = {
  readonly callId: string;
  readonly platform: string;
  readonly startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Build a capability bound to its own state.
 *
 * A factory rather than a bare object because the in-flight ledger is
 * per-engine: one shared map across two engine processes would let one
 * session's `call_id` answer the other's. {@link hostDelegatedDeliveryCapability}
 * is the instance meant for the registry.
 */
export function createHostDelegatedDeliveryCapability(): HostDelegatedDeliveryCapability {
  const inFlight = new Map<string, InFlightSend>();
  const sentResolutions = new Map<string, number>();
  let deliverer: MessageDeliverer | null = null;
  let contractSource: ContractSource | null = null;

  function contractFor(sessionId: string): NegotiatedContract {
    const source = contractSource ?? ((id: string) => turnRecoveryCapability.contractFor(id));
    // A source that throws must not take the decode path down with it; an
    // unreadable contract is the fail-closed empty one.
    try {
      return source(sessionId) ?? NO_CONTRACT;
    } catch {
      return NO_CONTRACT;
    }
  }

  /**
   * Settle one in-flight delivery exactly once.
   *
   * The latch is the whole point: a deliverer that answers AFTER this host timed
   * out must not produce a second `host_send_message_result`. The engine treats
   * an unmatched answer as stale ("host_send_message_result received for unknown
   * call_id"), so a duplicate is not fatal - but it is a lie about a real-world
   * send, and the user was already told the delivery was unconfirmed.
   */
  function settle(ctx: CapabilityContext, callId: string, outcome: DeliveryOutcome): void {
    const entry = inFlight.get(callId);
    if (!entry) {
      ctx.warn(
        `late delivery answer for "${callId}" ignored - the engine was already told this send was not confirmed`
      );
      return;
    }
    // Deleted BEFORE the answer is written: the entry is the latch, so removing
    // it first is what makes a re-entrant or late second settle a no-op.
    inFlight.delete(callId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    // The elapsed time is the useful half of a delivery log: a channel that
    // answers in milliseconds and one that only just beat the timeout look
    // identical without it.
    ctx.log(`delivery "${callId}" settled after ${Date.now() - entry.startedAt}ms`);
    answer(ctx, callId, entry.platform, outcome, false);
  }

  function startDelivery(ctx: CapabilityContext, request: DeliveryRequest, transport: MessageDeliverer): void {
    const entry: InFlightSend = {
      callId: request.callId,
      platform: request.platform,
      startedAt: Date.now(),
      timer: null,
    };
    inFlight.set(request.callId, entry);

    entry.timer = setTimeout(() => {
      settle(ctx, request.callId, {
        ok: false,
        error: `no answer from the ${request.platform} channel within ${DELIVERY_TIMEOUT_MS}ms; the message was NOT confirmed sent and was NOT retried`,
      });
    }, DELIVERY_TIMEOUT_MS);

    let promise: Promise<unknown>;
    try {
      promise = transport(request) as Promise<unknown>;
    } catch (cause) {
      // A deliverer that throws SYNCHRONOUSLY never returns a promise, so the
      // `.catch` below would never run and the send would sit until the timeout.
      settle(ctx, request.callId, { ok: false, error: `the delivery transport threw: ${String(cause)}` });
      return;
    }
    if (typeof (promise as Promise<unknown>)?.then !== 'function') {
      settle(ctx, request.callId, {
        ok: false,
        error: `the delivery transport did not return a promise (got ${describeType(promise)})`,
      });
      return;
    }

    void promise.then(
      (value) => settle(ctx, request.callId, readDeliveryOutcome(value)),
      (cause: unknown) => settle(ctx, request.callId, { ok: false, error: `the delivery failed: ${String(cause)}` })
    );
  }

  /**
   * `host_send_message_request`: resolve, deliver, and ALWAYS answer.
   *
   * Returns false only when there is no `call_id` to answer under. Every other
   * path - unknown platform, no transport, malformed field, cap reached - writes
   * a `host_send_message_result` before returning.
   */
  function handleSendRequest(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
    const callId = event.call_id;
    if (!isWireId(callId)) {
      // THE ONE UNANSWERABLE CASE. `host_send_message_result` is keyed on
      // `call_id` (manifest `correlation: "call_id"`); with no usable id there
      // is nothing to answer under, and inventing one would settle somebody
      // else's delivery. Loud, and reported as unhandled rather than swallowed.
      ctx.warn(
        `host_send_message_request carries no usable call_id (non-empty, at most ${MAX_WIRE_ID_LENGTH} characters); it cannot be answered`,
        event
      );
      return false;
    }

    if (inFlight.has(callId)) {
      // A redelivery of a request already being served. Sending it a second
      // time would deliver the message twice, and answering it separately would
      // settle the in-flight one early - so it is logged and left to the answer
      // the in-flight delivery still owes under this same id.
      ctx.log(`host_send_message_request "${callId}" is already in flight; not delivering it twice`);
      return true;
    }

    const decoded = decodeHostSendMessageRequest(event);
    if ('error' in decoded) {
      answer(ctx, callId, 'unknown', { ok: false, error: `the request could not be read: ${decoded.error}` }, false);
      return true;
    }
    const request = decoded.value;

    // THE GRADE IS REPORTED, NOT ENFORCED - the one deliberate exception to
    // "gate every command on the capability grade". The engine ASKED and is
    // blocked on the answer; a host that withheld it because a grade disagreed
    // would cause exactly the hang the grade gate exists to prevent. So a
    // mismatch is logged and the send is served.
    //
    // The session key is best-effort: `conversation_id` is the only
    // session-shaped field on this event, and the contract never says it is the
    // `ready.session_id` the contract map is keyed by (the fixture's
    // `session-desktop-001` matches the recovery fixtures' `session_id`, which
    // is evidence, not a guarantee). Nothing branches on the result, so a wrong
    // key costs one log line and never a delivery.
    const grade = gradeOf(contractFor(request.conversation_id ?? ''), HOST_DELEGATED_DELIVERY_CAPABILITY);
    if (grade !== 'available') {
      ctx.log(`serving a delegated send on a build that graded host_delegated_delivery "${grade}"`);
    }

    const candidates = pluginTypesFor(request.platform);
    if (candidates === undefined) {
      answer(
        ctx,
        callId,
        request.platform,
        {
          ok: false,
          error: `this host does not know the platform ${quoteWire(request.platform)}, so it will not guess a channel to deliver through`,
        },
        true
      );
      return true;
    }
    if (candidates.length === 0) {
      answer(
        ctx,
        callId,
        request.platform,
        { ok: false, error: `Darhai has no channel plugin for ${request.platform}` },
        true
      );
      return true;
    }

    if (deliverer === null) {
      answer(
        ctx,
        callId,
        request.platform,
        { ok: false, error: 'no delivery transport is installed in this build, so nothing was sent' },
        true
      );
      return true;
    }

    if (inFlight.size >= MAX_IN_FLIGHT_SENDS) {
      // Refuse the NEWEST rather than evicting an older one - see
      // MAX_IN_FLIGHT_SENDS. Nothing was sent under this call_id, so this is a
      // true negative.
      answer(
        ctx,
        callId,
        request.platform,
        {
          ok: false,
          error: `${MAX_IN_FLIGHT_SENDS} deliveries are already in flight on this host; nothing was sent`,
        },
        false
      );
      return true;
    }

    const delivery: DeliveryRequest = {
      callId: request.call_id,
      platform: request.platform,
      pluginTypes: candidates,
      body: request.body,
    };
    // Assembled field-by-field so an absent `chat_id` stays ABSENT: the engine's
    // own tool doc says a bare platform means "use the host's default channel",
    // and a `chatId: undefined` key would let a deliverer read it as an explicit
    // empty target.
    if (request.chat_id !== undefined) delivery.chatId = request.chat_id;
    if (request.thread_id !== undefined) delivery.threadId = request.thread_id;
    if (request.subject !== undefined) delivery.subject = request.subject;
    if (request.conversation_id !== undefined) delivery.conversationId = request.conversation_id;

    startDelivery(ctx, delivery, deliverer);
    return true;
  }

  function handleUnknownToolEffect(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
    const decoded = decodeUnknownToolEffectResolution(event, 'unknown_tool_effect_resolved');
    if ('error' in decoded) {
      const frame: UnknownToolEffectFrame = {
        capability: OPERATOR_TOOL_EFFECT_CAPABILITY,
        verdict: 'malformed',
        severity: 'warning',
        detail: `an unknown_tool_effect_resolved could not be read: ${decoded.error}`,
        resolution: null,
        correlated: false,
      };
      ctx.warn(frame.detail, event);
      ctx.emit({ type: 'unknown_tool_effect_resolved', data: frame, msg_id: '' });
      return true;
    }

    const body = decoded.value;
    const key = resolutionKey(body);
    const correlated = sentResolutions.delete(key);
    if (!correlated) {
      ctx.warn(
        `unknown_tool_effect_resolved for ${body.tool_execution_id} does not match any resolve_unknown_tool_effect this host sent; it is reported, not dropped`
      );
    }

    const frame: UnknownToolEffectFrame = {
      capability: OPERATOR_TOOL_EFFECT_CAPABILITY,
      verdict: 'accepted',
      severity: correlated ? 'info' : 'warning',
      detail: `${body.tool_execution_id} in turn ${body.turn_id} was resolved as ${body.outcome} by ${body.operator_id} (${body.evidence.source} ${body.evidence.reference_id})`,
      resolution: body,
      correlated,
    };
    ctx.log(frame.detail);
    // `msg_id` is empty on purpose: a settled tool effect is a SESSION fact that
    // arrives during reconciliation, before any turn is open, and filing it
    // under whatever message happened to be active would attach it to the wrong
    // one.
    ctx.emit({ type: 'unknown_tool_effect_resolved', data: frame, msg_id: '' });
    return true;
  }

  function sendResolveUnknownToolEffect(
    ctx: CapabilityContext,
    input: ResolveUnknownToolEffectInput
  ): ResolveSendOutcome {
    const sessionId = isRecord(input) ? input.sessionId : '';
    // THE GRADE GATE. A build that graded this capability anything but
    // `available` will not act on the command, and the operator would be left
    // believing a payment question was settled. The default source is
    // NO_CONTRACT until `ready` is seeded, so an unseeded host is refused too:
    // fail closed.
    const contract = contractFor(typeof sessionId === 'string' ? sessionId : '');
    if (!isCapabilityAvailable(contract, OPERATOR_TOOL_EFFECT_CAPABILITY)) {
      return {
        ok: false,
        reason: `${OPERATOR_TOOL_EFFECT_CAPABILITY} is "${gradeOf(contract, OPERATOR_TOOL_EFFECT_CAPABILITY)}" on this engine, so the resolution would not be acted on`,
      };
    }

    // THE ACTIVE-TURN GATE, measured rather than inferred: the bundled binary
    // carries "resolve_unknown_tool_effect refused during active turn; resync
    // and retry after the turn stops". Sending it mid-turn is a guaranteed
    // no-op, so it is refused here where the reason can reach the operator.
    // `activeMsgId()` is '' outside a turn - the only signal a capability has.
    const activeMsgId = ctx.activeMsgId();
    if (typeof activeMsgId === 'string' && activeMsgId.length > 0) {
      return {
        ok: false,
        reason: `a turn is in flight (${activeMsgId}); the engine refuses resolve_unknown_tool_effect during an active turn - retry once the turn stops`,
      };
    }

    const built = buildResolveUnknownToolEffect(input);
    // `=== false` rather than `!built.ok`: this repo compiles without
    // strictNullChecks, where only an explicit comparison narrows a
    // discriminated union.
    if (built.ok === false) {
      ctx.warn(`refusing to send a malformed resolve_unknown_tool_effect: ${built.reason}`);
      return { ok: false, reason: built.reason };
    }

    try {
      ctx.sendCommand(built.command);
    } catch (cause) {
      // Leave the ledger untouched so a later echo cannot be matched to a
      // command that never went out.
      const reason = `resolve_unknown_tool_effect was not sent: ${String(cause)}`;
      ctx.warn(reason);
      return { ok: false, reason };
    }

    const key = resolutionKey(built.command);
    if (sentResolutions.size >= MAX_TRACKED_RESOLUTIONS && !sentResolutions.has(key)) {
      const oldest = sentResolutions.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        sentResolutions.delete(oldest);
        ctx.warn(
          `forgetting the oldest sent resolution - ${MAX_TRACKED_RESOLUTIONS} were tracked; its echo will report as uncorrelated`
        );
      }
    }
    sentResolutions.set(key, Date.now());
    ctx.log(`resolve_unknown_tool_effect sent for ${built.command.tool_execution_id} (${built.command.outcome})`);
    return { ok: true, key };
  }

  return {
    name: HOST_DELEGATED_DELIVERY_CAPABILITY,
    handles: [...HOST_DELEGATED_EVENT_TYPES],

    handle(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
      if (event.type === 'host_send_message_request') return handleSendRequest(event, ctx);
      if (event.type === 'provider_failover_receipt') return handleFailoverReceipt(event, ctx);
      if (event.type === 'unknown_tool_effect_resolved') return handleUnknownToolEffect(event, ctx);
      // Unreachable through the dispatcher, which routes on `handles`. Kept
      // because `handle` is exported and directly callable: answering "not
      // mine" is honest, inventing a decode for it is not.
      return false;
    },

    setMessageDeliverer(next: MessageDeliverer | null): void {
      deliverer = next;
    },

    setContractSource(source: ContractSource | null): void {
      contractSource = source;
    },

    contractFor,
    sendResolveUnknownToolEffect,

    inFlightCallIds(): readonly string[] {
      return [...inFlight.keys()];
    },

    pendingResolutionKeys(): readonly string[] {
      return [...sentResolutions.keys()];
    },

    reset(): void {
      for (const entry of inFlight.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer);
      }
      inFlight.clear();
      sentResolutions.clear();
    },
  };
}

/**
 * The instance intended for the capability registry.
 *
 * Being exported is not being registered: dispatch only reaches handlers listed
 * in `HANDLERS` in `capabilities/index.ts`, and this module cannot see that
 * list - see requirement (1) in the file header.
 */
export const hostDelegatedDeliveryCapability: HostDelegatedDeliveryCapability = createHostDelegatedDeliveryCapability();
