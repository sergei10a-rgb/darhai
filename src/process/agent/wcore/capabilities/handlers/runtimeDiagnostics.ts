/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime diagnostics + MCP lifecycle: Darhai's first two REQUEST/RESPONSE verbs.
 *
 * WHAT THIS IS
 * ------------
 * Two round-trips the host has no path for today, both correlated on
 * `request_id` (`manifest.json` states that for all five types; every other
 * command Darhai speaks is fire-and-forget):
 *
 *   get_runtime_diagnostics -> runtime_diagnostics_snapshot
 *                           |  runtime_diagnostics_unavailable
 *   remove_mcp_server       -> mcp_removal_result
 *
 * The snapshot is the engine grading ITSELF: which config file is actually in
 * effect (`role`/`disposition`/`precedence`/`display_path`), which env override
 * it ignored, and per MCP server whether the executable resolved
 * (`not_found` vs `permission_denied` vs `probe_timed_out`), whether the server
 * was exposed or hidden (`hidden_no_tools`), and what to do about it
 * (`remediation: ['install_executable']`). Today a broken MCP server produces a
 * one-line `mcp_failed` toast with a free-text reason and the user guesses.
 *
 * `remove_mcp_server` closes a hole with a sharper edge: `InstalledPage`
 * promises "this will also uninstall it from all CLI agents" while the running
 * engine keeps serving the tools until the conversation is killed. This verb is
 * the only way to take a server back out of a live session, and its reply names
 * the tools that actually disappeared.
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 *   - the only sanctioned constructors for both commands (both are
 *     `additionalProperties: false`, so one stray key invalidates the message);
 *   - the request_id ledger, because `request_id` is the declared correlation
 *     key and a reply that matches nothing must be DROPPED, never applied to a
 *     neighbour;
 *   - the decoders for all three replies, including the per-entry salvage that
 *     keeps one unreadable MCP row from destroying a whole snapshot.
 *
 * WHAT IT DOES NOT OWN, AND WHAT IT REQUIRES
 * ------------------------------------------
 * This module decodes, correlates and emits. It does not register itself, does
 * not press a button, and does not own the engine process. Three things outside
 * it are REQUIRED before any of the above is reachable at runtime; none of them
 * is asserted here as done:
 *
 *  1. REGISTRATION. {@link runtimeDiagnosticsCapability} must appear in
 *     `HANDLERS` in `capabilities/index.ts`. Without it `dispatchCapabilityEvent`
 *     claims none of these three types and every reply falls through to the
 *     acknowledged-inert check in `protocol.ts`. Registration is also what makes
 *     the emitted frames reach the renderer: `WCoreManager` builds its exemption
 *     set from `claimedEventTypes()`, so a registered type is forwarded past its
 *     `if (!data.msg_id) return;` guard - and every frame here is deliberately
 *     msg_id-less (see {@link emitDiagnosticsFrame}).
 *  2. AN ACKNOWLEDGED-INERT REMOVAL. `runtime_diagnostics_snapshot`,
 *     `runtime_diagnostics_unavailable` and `mcp_removal_result` must leave
 *     `ACKNOWLEDGED_UNHANDLED_EVENTS`, or that list keeps declaring them
 *     knowingly ignored while a handler exists for them.
 *  3. A CALLER. Nothing in this module can originate a round-trip: a handler
 *     only runs when an event arrives. Whatever presses the button calls
 *     {@link sendGetRuntimeDiagnostics} / {@link sendRemoveMcpServer} with the
 *     agent's `contract` and a reachability probe, and calls
 *     {@link resetRuntimeRequests} when the engine process is replaced.
 *
 * The contract dependency itself is satisfiable: `WCoreAgent.contract` starts as
 * `NO_CONTRACT` (which grades everything `unavailable`, so both verbs refuse to
 * send) and the `ready` arm assigns `negotiateContract(event)`. That direction
 * is deliberate - a command sent to a build that graded the capability
 * `shape_only` waits for a reply that never comes.
 *
 * WHAT NEVER REACHES THE LOG, AND WHY THE FRAME IS BOUNDED
 * --------------------------------------------------------
 * Two properties this module is responsible for, both of them about strings the
 * ENGINE sizes and chooses:
 *
 *   - REDACTION. No free-form engine string is interpolated into a log MESSAGE.
 *     Every refusal is host-authored and names a FIELD, a TYPE, a COUNT or a
 *     LENGTH: `display_path`, `profile_name` and `executable_basename` may carry
 *     a real home directory, and so may an unknown enum member
 *     (`working_directory`'s own enum contains `explicit`, i.e. "a path was
 *     configured"). The engine's own value travels in the frame instead - see
 *     {@link UnreadableSnapshotEntry.offending} - which the renderer may show to
 *     the user who asked for it. Engine text that must be quoted at all goes
 *     through a filter first ({@link idForLog}, {@link textForLog}); the ONE
 *     deliberate exception is the name-mismatch warning in
 *     {@link handleRemoval}, where the two names ARE the finding and are passed
 *     as structured detail, both bounded, rather than spliced into a line.
 *   - SIZE. Bounding the NUMBER of entries bounds the loop, not the frame: no
 *     string on any of these five types except `remove_mcp_server.name` has a
 *     `maxLength`, so 256 schema-valid servers with 100k-character names are a
 *     25 MB structured clone across the renderer IPC boundary. Every string
 *     carried out is length-bounded, every echoed value is clipped, and the
 *     unreadable list reaching the log is capped - see
 *     {@link MAX_ENGINE_NAME_LENGTH} and the three constants after it.
 *
 * NO PROMISES, NO TIMERS, BY DESIGN
 * ---------------------------------
 * `CapabilityHandler.handle` is synchronous and runs inside the readline `line`
 * handler; a timer or an await here would sit on the decode path for the whole
 * event stream. So the send functions return immediately and the answer arrives
 * later as an emitted frame, exactly like `budgetGrants`. A promise API with a
 * timeout belongs to `WCoreAgent`, which owns the child process and can tell a
 * dead engine from a slow one; this module records `at` on every pending entry
 * so that layer (and the eviction warning below) can talk about age.
 *
 * WHAT THE CONTRACT DOES NOT SETTLE, AND WHAT WAS CHOSEN
 * ------------------------------------------------------
 *   - `mcp_removal_result.outcome` has NO enum in either schema - it is
 *     `{"type":"string"}`, and 'removed' is the only value the bundle exhibits.
 *     What the engine says for "no such server" or "refused" is unknown, so
 *     `outcome` is carried through VERBATIM and nothing here compares it to a
 *     literal. See {@link decodeMcpRemovalResult}.
 *   - there is no negative reply for the lifecycle verb at all (no
 *     `mcp_removal_refused`). An engine that silently ignores an unknown name
 *     leaves the pending entry in place for ever; this module bounds that with
 *     {@link MAX_PENDING_RUNTIME_REQUESTS}, not with a timeout it cannot honour.
 *   - `get_runtime_diagnostics.diagnostics_version` is `const 1`, yet
 *     `runtime_diagnostics_unavailable` can answer `unsupported_version` and its
 *     fixture carries version 2. A schema-conformant host can therefore never
 *     provoke that branch; it is decoded because an engine may still send it,
 *     not because Darhai can cause it.
 *   - redaction is contract PROSE, not schema: `display_path` and
 *     `executable_basename` are free-form strings and may carry a real home
 *     directory. Nothing here logs them - see {@link summariseSnapshot}.
 */

import { randomBytes } from 'node:crypto';

import { gradeOf, isCapabilityAvailable } from '../contractNegotiation';
import type { NegotiatedContract } from '../contractNegotiation';
import type { CapabilityContext, CapabilityHandler } from '../types';

/**
 * The name this handler reports in logs and in the registry.
 *
 * It is NOT a manifest capability id, and that is deliberate: the manifest
 * files these five types under TWO ids (`runtime_diagnostics_v1` and
 * `runtime_mcp_lifecycle_v1`) while `CapabilityHandler` has one name. Splitting
 * the module in two would put one request_id ledger behind two handlers, and
 * the two verbs share that ledger's key space. So one handler, one ledger, and
 * each verb gated on its OWN manifest id - see the two constants below.
 */
export const RUNTIME_DIAGNOSTICS_HANDLER_NAME = 'runtime_diagnostics_and_mcp_lifecycle';

/** Manifest capability id gating `get_runtime_diagnostics`. */
export const RUNTIME_DIAGNOSTICS_CAPABILITY = 'runtime_diagnostics_v1';

/** Manifest capability id gating `remove_mcp_server`. */
export const RUNTIME_MCP_LIFECYCLE_CAPABILITY = 'runtime_mcp_lifecycle_v1';

/**
 * Subcontract version this host implements, from
 * `manifest.json -> subcontracts.runtime_diagnostics`.
 *
 * Unlike `execution_policy`, no runtime-diagnostics payload carries a
 * `contract_version` field, so there is nothing on the wire to compare this
 * against. It is published for the drift test and for whoever bumps the bundle.
 */
export const RUNTIME_DIAGNOSTICS_SUBCONTRACT_VERSION = '1.0';

/**
 * `diagnostics_version` on the command.
 *
 * `const: 1` in host-command.schema.json - the host cannot legally ask for any
 * other version, so this is a transcription of a rule, not a choice.
 */
export const DIAGNOSTICS_VERSION = 1;

/**
 * `lifecycle_version` on `remove_mcp_server`.
 *
 * NOT a rule: the schema says `integer 0..65535` and the contract never states
 * what the engine does with any other value, nor what an engine lacking
 * `runtime_mcp_lifecycle_v1` does with the command at all. 1 is the fixture
 * value. Sending it is copying the contract's own example, which is the closest
 * thing to evidence available without running the binary.
 */
export const MCP_LIFECYCLE_VERSION = 1;

/**
 * How many replies may be outstanding at once.
 *
 * A HOST-SIDE CHOICE. The contract publishes no ledger bound for these verbs
 * and, unlike budget grants, no `request_id_conflict`-style refusal, so nothing
 * can be derived. Every entry is one deliberate user action - a Settings pane
 * press, or one server removal - and 32 unanswered actions in a session already
 * means the engine has stopped replying, which is exactly the leak this bounds.
 *
 * At the cap the OLDEST entry is evicted with a warning naming its age.
 * Refusing new requests instead would let one unanswered diagnostics press
 * disable removal for the rest of the session.
 */
export const MAX_PENDING_RUNTIME_REQUESTS = 32;

/**
 * Per-array decode bounds for the snapshot.
 *
 * WHY BOUNDS AT ALL: every array here is sized by the ENGINE, none has a
 * `maxItems` in the schema, and the decode loop runs synchronously inside the
 * readline handler - so a 100k-entry `mcp_servers` would stall the whole event
 * stream, not just the diagnostics readout. The JSON is already parsed by the
 * time this module sees it, so these caps bound the LOOP and the emitted frame,
 * not the parse.
 *
 * WHY REFUSE RATHER THAN TRUNCATE: a diagnostics list rendered as complete when
 * it is not is the silent wrong answer this capability exists to remove. Over
 * the cap the whole snapshot is refused, loudly, with the count and the cap in
 * the reason.
 *
 * The numbers are CHOICES, each an order of magnitude above anything observed:
 * the `role` enum has 7 values and nested project configs may repeat a role
 * (64); a Windows process environment commonly carries 60-120 variables, of
 * which only ignored ones appear here (256); Darhai's own MCP library ships
 * about 20 servers (256).
 */
export const MAX_CONFIG_SOURCES = 64;
export const MAX_UNSUPPORTED_OVERRIDES = 256;
export const MAX_MCP_SERVERS = 256;

/**
 * Remediation hints kept per server.
 *
 * Only ten values are legal and the schema sets no `uniqueItems`, so repeats
 * are legal too. 32 leaves room for a repeat-heavy but sincere list while still
 * bounding a hostile one.
 */
export const MAX_REMEDIATION_HINTS = 32;

/**
 * Tool names carried out of `mcp_removal_result`.
 *
 * This one TRUNCATES rather than refuses, and the asymmetry is deliberate:
 * refusing the removal reply would leave the caller's request unsettled for a
 * removal that already happened - the UI would spin over a completed action.
 * The exact count and an explicit `toolsTruncated` flag travel with the frame,
 * so nothing is silently short. 512 is a choice: the largest MCP servers
 * observed expose ~100 tools.
 */
export const MAX_REMOVED_TOOLS = 512;

/**
 * Longest engine-controlled NAME this host carries out of a reply.
 *
 * WHAT THE ENGINE CAN SEND: any length at all. `mcp_servers[].name`,
 * `unsupported_overrides[].name`, `executable_basename`, `process.profile_name`,
 * `mcp_removal_result.outcome` and every entry of `removed_tools` are
 * `{"type":"string"}` in `core-event.schema.json` with NO `maxLength`. Capping
 * the number of entries therefore bounds the LOOP and nothing else: 256 servers
 * each carrying a 100k-character name is a schema-VALID snapshot and a 25 MB
 * frame, structured-cloned to the renderer and summarised into a log file that
 * rotates at 10 MB.
 *
 * AT THE BOUND the entry is refused - one unreadable row inside a snapshot
 * list, the whole reply for `mcp_removal_result`, which has no per-entry
 * salvage - and the reason names the field and the length, never the text.
 *
 * THE NUMBER IS A CHOICE, but not an arbitrary one: 256 is the only bound the
 * contract states for any string on these five types (`remove_mcp_server.name`:
 * `maxLength: 256` plus `x-maxUtf8Bytes: 256`). A server whose name is longer
 * than that cannot be named in a removal command at all, so a row rendered from
 * it would be a row the user cannot act on. `executable_basename` is a file
 * name, where NAME_MAX is 255 on Linux and 255 UTF-16 units on Windows - the
 * same order.
 */
export const MAX_ENGINE_NAME_LENGTH = 256;

/**
 * Longest `display_path` carried out of a snapshot.
 *
 * Separate from {@link MAX_ENGINE_NAME_LENGTH} because a path is legitimately
 * longer than a name: `PATH_MAX` is 4096 bytes on Linux, and a Windows
 * extended-length path reaches 32767 UTF-16 units. 4096 is a CHOICE sitting at
 * the Linux limit - it refuses only the pathological end of the Windows range,
 * and at the bound the config source becomes one unreadable row naming the
 * length, never the path. Worst case for the frame is
 * {@link MAX_CONFIG_SOURCES} * 4096 = 256 KB.
 */
export const MAX_ENGINE_PATH_LENGTH = 4096;

/**
 * Longest engine value echoed back beside a refusal.
 *
 * An unknown enum member is worth showing ("the engine said X") but the engine
 * chooses X's length, and a refusal is produced PER ROW: 576 rows carrying a
 * 100k-character value each is a 57 MB frame. So the value is clipped to this
 * and travels in {@link UnreadableSnapshotEntry.offending}, which the frame
 * carries and the log never does.
 *
 * 128 is a CHOICE: long enough to read a mistyped enum member or a renamed
 * field whole, short enough that the entire unreadable list stays well under a
 * megabyte at the per-list caps. At the bound the value is cut - never through
 * a surrogate pair, see {@link clip} - and its true length is appended.
 */
export const MAX_FAULT_DETAIL_LENGTH = 128;

/**
 * How many unknown field names one refusal echoes.
 *
 * Key names are engine-controlled text too, and a JSON object may carry
 * thousands of them. The first few identify an engine upgrade; the rest are
 * noise of a size this host does not choose. Over the bound the total count is
 * still reported. 8 is a CHOICE: the widest object here (`mcp_servers[]`)
 * declares 15 fields, so an engine that adds a section is named in full.
 */
export const MAX_NAMED_UNKNOWN_KEYS = 8;

/**
 * How many unreadable-row reasons reach the LOG.
 *
 * The frame carries every hole (bounded by the per-list caps at 64 + 256 + 256).
 * The log is a rotating 10 MB file that gets attached to bug reports, and 576
 * reasons in one line would push out the forensic history this capability
 * exists to provide. 20 is a CHOICE - enough to see whether the holes share a
 * cause - and the line always states the true total, so nothing is silently
 * short.
 */
export const MAX_LOGGED_UNREADABLE_REASONS = 20;

/**
 * `request_id` character rule for ids DARHAI MINTS. Never applied inbound.
 *
 * The schema imposes NO pattern on either verb's `request_id` - only
 * `minLength: 1` and a maximum (128 for diagnostics, 256 for the lifecycle
 * verb, the latter also byte-capped). So this is a host restriction on the SEND
 * path, and there it costs nothing: unlike an MCP server `name`, the id is ours
 * to choose, and restricting it to printable ASCII removes the UTF-8-byte
 * question and the lone-surrogate question for that field entirely. The length
 * cap in the pattern is the LARGER of the two; the per-verb maximum is checked
 * separately.
 *
 * ON THE RECEIVE PATH it is NOT a validity rule - imposing a host character
 * class on a schema-conformant reply would report an engine that reformatted
 * the correlation key as "malformed" when the honest answer is "an id this host
 * never minted". Inbound ids are checked against the schema only
 * ({@link inboundRequestIdFault}); the pattern is reused for one narrower
 * question - {@link idForLog}, "could this host have minted it", i.e. is it safe
 * to print into a line-oriented log verbatim.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** `maxLength` on `get_runtime_diagnostics.request_id` and both diagnostics replies. */
export const MAX_DIAGNOSTICS_REQUEST_ID_LENGTH = 128;

/** `maxLength` on `remove_mcp_server.request_id` / `mcp_removal_result.request_id`. */
export const MAX_LIFECYCLE_REQUEST_ID_LENGTH = 256;

/**
 * `name` limits on `remove_mcp_server`.
 *
 * TWO SEPARATE CAPS, and conflating them is the live bug this constant pair
 * exists to prevent: `maxLength: 256` counts UTF-16 code units while
 * `x-maxUtf8Bytes: 256` counts BYTES. A 200-character Cyrillic server name is
 * 200 code units and 400 bytes - it passes a `.length` check and is still a
 * schema-invalid command. Darhai's own UI is Mongolian Cyrillic, so this is a
 * live path rather than a theoretical one.
 */
export const MAX_MCP_NAME_LENGTH = 256;
export const MAX_MCP_NAME_UTF8_BYTES = 256;

// -- commands -----------------------------------------------------------------

/** `get_runtime_diagnostics`, exactly as it goes on the wire. */
export type GetRuntimeDiagnosticsCommand = {
  type: 'get_runtime_diagnostics';
  diagnostics_version: 1;
  request_id: string;
};

/** `remove_mcp_server`, exactly as it goes on the wire. */
export type RemoveMcpServerCommand = {
  type: 'remove_mcp_server';
  lifecycle_version: number;
  request_id: string;
  name: string;
};

/** Built, or refused with a reason a human can act on. */
export type BuildOutcome<T> = { ok: true; command: T } | { ok: false; reason: string };

// -- snapshot payload ---------------------------------------------------------
//
// Every union below is transcribed from `schema/core-event.schema.json`, branch
// `runtime_diagnostics_snapshot`. The runtime Set is derived from the same
// array, so a hand-written union and a hand-written membership list cannot
// drift apart - the drift would show up as an engine value silently decoded as
// "unknown", i.e. as nothing.

export const PROFILE_BINDINGS = [
  'unknown',
  'default_home',
  'explicit_home',
  'bound_profile',
  'unbound_profile',
] as const;
export type RuntimeProfileBinding = (typeof PROFILE_BINDINGS)[number];

export const ENGINE_MODES = ['unknown', 'standard', 'raw'] as const;
export type RuntimeEngineMode = (typeof ENGINE_MODES)[number];

export const WORKSPACE_KINDS = ['unknown', 'none', 'project', 'temporary', 'profile_home'] as const;
export type RuntimeWorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const CONFIG_SOURCE_ROLES = [
  'global',
  'project',
  'profile',
  'cli',
  'environment',
  'credential_store',
  'desktop_launch',
] as const;
export type ConfigSourceRole = (typeof CONFIG_SOURCE_ROLES)[number];

export const CONFIG_DISPOSITIONS = [
  'loaded',
  'absent',
  'ignored',
  'unreadable',
  'invalid',
  'overridden',
  'restricted',
] as const;
export type ConfigDisposition = (typeof CONFIG_DISPOSITIONS)[number];

export const MCP_ORIGINS = [
  'effective_config',
  'global_config',
  'project_config',
  'profile_config',
  'runtime_command',
  'plugin',
] as const;
export type McpOrigin = (typeof MCP_ORIGINS)[number];

export const MCP_TRANSPORTS = ['stdio', 'sse', 'streamable_http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_CONNECTIONS = [
  'configured',
  'deferred',
  'connecting',
  'ready',
  'failed',
  'timed_out',
  'skipped',
  'stopping',
  'stopped',
] as const;
export type McpConnection = (typeof MCP_CONNECTIONS)[number];

export const MCP_EXPOSURES = [
  'not_attempted',
  'not_applicable',
  'exposed',
  'resource_only',
  'resource_only_unavailable',
  'hidden_no_tools',
  'blocked',
] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

export const MCP_READINESS = [
  'not_applicable',
  'unchecked',
  'resolved',
  'missing_effective_path',
  'not_found',
  'invalid_absolute_path',
  'invalid_executable',
  'invalid_effective_environment',
  'permission_denied',
  'not_executable',
  'probe_timed_out',
  'unsupported_transport',
] as const;
export type McpExecutableReadiness = (typeof MCP_READINESS)[number];

export const MCP_WORKING_DIRECTORIES = ['inherited_process', 'project_root', 'profile_home', 'explicit'] as const;
export type McpWorkingDirectory = (typeof MCP_WORKING_DIRECTORIES)[number];

export const MCP_REMEDIATIONS = [
  'open_active_config',
  'restart_desktop',
  'fix_gui_launch_path',
  'install_executable',
  'fix_executable_permissions',
  'review_server_config',
  'retry_connection',
  'retry_diagnostics',
  'check_assistant_scope',
  'restart_to_load_resources',
] as const;
export type McpRemediation = (typeof MCP_REMEDIATIONS)[number];

export const MCP_FAILURES = [
  'missing_executable',
  'launch_failed',
  'connection_refused',
  'timeout',
  'protocol_mismatch',
  'authentication_required',
  'authorization_denied',
  'invalid_configuration',
  'transport_closed',
  'unknown',
] as const;
export type McpFailure = (typeof MCP_FAILURES)[number];

/** Why the engine could not serve a diagnostics request. */
export const DIAGNOSTICS_UNAVAILABLE_REASONS = ['unsupported_version', 'invalid_request'] as const;
export type DiagnosticsUnavailableReason = (typeof DIAGNOSTICS_UNAVAILABLE_REASONS)[number];

/** `snapshot.process` - how this engine process is bound. */
export type RuntimeProcessBinding = {
  profile_binding: RuntimeProfileBinding;
  engine_mode: RuntimeEngineMode;
  workspace_kind: RuntimeWorkspaceKind;
  /** Optional in the schema; present only when a profile is named. */
  profile_name?: string;
};

/** One entry of the config-source precedence chain. */
export type RuntimeConfigSource = {
  role: ConfigSourceRole;
  disposition: ConfigDisposition;
  precedence: number;
  content_digest?: string;
  /** May carry a real path. Never logged - see {@link summariseSnapshot}. */
  display_path?: string;
};

/** An environment override the engine did NOT honour. */
export type RuntimeUnsupportedOverride = {
  name: string;
  disposition: ConfigDisposition;
};

/** The engine's own view of one MCP server. */
export type RuntimeMcpServer = {
  name: string;
  origin: McpOrigin;
  transport: McpTransport;
  connection: McpConnection;
  exposure: McpExposure;
  deferred: boolean;
  tool_count: number;
  resources_declared: boolean;
  resources_exposed: boolean;
  assistant_scoped: boolean;
  executable_readiness: McpExecutableReadiness;
  working_directory: McpWorkingDirectory;
  remediation: McpRemediation[];
  /** May disclose what is installed on this machine. Never logged. */
  executable_basename?: string;
  failure?: McpFailure;
};

/** The whole `snapshot` object. All four members are required by the schema. */
export type RuntimeDiagnosticsSnapshot = {
  process: RuntimeProcessBinding;
  config_sources: RuntimeConfigSource[];
  unsupported_overrides: RuntimeUnsupportedOverride[];
  mcp_servers: RuntimeMcpServer[];
};

/**
 * One list entry the host could not read.
 *
 * WHY ENTRIES DEGRADE INDIVIDUALLY while the envelope does not. Refusing a
 * whole snapshot because ONE server carries an enum member this build has never
 * heard of would leave the user with nothing at all - and the point of the
 * snapshot is to explain a broken server. Dropping the row silently would be
 * worse still: a configured server missing from the list reads as "not
 * configured". So the row is kept as an explicit hole, with whatever `name` was
 * salvageable, and the UI can say "reported in a shape this build cannot read".
 */
export type UnreadableSnapshotEntry = {
  list: 'config_sources' | 'unsupported_overrides' | 'mcp_servers';
  index: number;
  /**
   * The entry's `name` when it was a string, clipped to
   * {@link MAX_FAULT_DETAIL_LENGTH}, else null. Frame only - never logged.
   */
  name: string | null;
  /** Host-authored: a field, a type, a count or a length. Never engine text. */
  reason: string;
  /**
   * The engine's own offending value, clipped. Present only when echoing it
   * helps ("the engine said `quantum_entangled`"). FRAME ONLY: this is the half
   * that may turn out to be a home directory, so nothing logs it.
   */
  offending?: string;
};

/** A decoded `runtime_diagnostics_snapshot`. */
export type DecodedRuntimeDiagnostics = {
  requestId: string;
  snapshot: RuntimeDiagnosticsSnapshot;
  unreadable: UnreadableSnapshotEntry[];
};

/** A decoded `runtime_diagnostics_unavailable`. */
export type DecodedDiagnosticsUnavailable = {
  requestId: string;
  /**
   * `diagnostics_version` AS THE ENGINE SENT IT - an echo, not a record of what
   * this host asked.
   *
   * The two are not the same claim and calling this `requestedVersion` made the
   * host state the engine's number as its own: `get_runtime_diagnostics`
   * declares `diagnostics_version` `const: 1`, so Darhai cannot ask for anything
   * else, and any other value here is an engine fault. What the host actually
   * sent is recorded on the pending entry and compared in
   * {@link handleUnavailable}.
   */
  echoedVersion: number;
  /** The only version this engine can serve. */
  supportedVersion: number;
  reason: DiagnosticsUnavailableReason;
};

/** A decoded `mcp_removal_result`. */
export type DecodedMcpRemoval = {
  requestId: string;
  lifecycleVersion: number;
  name: string;
  /** Carried VERBATIM. The schema declares no enum; see the file header. */
  outcome: string;
  removedTools: string[];
  /** The engine's own count, before {@link MAX_REMOVED_TOOLS} truncation. */
  removedToolCount: number;
  toolsTruncated: boolean;
};

/**
 * Decoded, or refused with the request_id salvaged when that ONE field was
 * readable.
 *
 * The salvage is not cosmetic. A reply this host cannot read is still a reply,
 * and the caller is owed an answer: with the id in hand the pending entry is
 * settled with an `undecodable` frame ("the engine answered in a shape this
 * build cannot read") instead of spinning until somebody's timeout. Without the
 * id nothing can be settled, because settling the wrong request is worse than
 * settling none.
 */
export type DecodeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; requestId: string | null; offending?: string };

// -- small shared guards ------------------------------------------------------

/**
 * One refusal, split by where each half is allowed to travel.
 *
 * `reason` is HOST-AUTHORED - a field name, a type, a count, a length - and is
 * the only half that may be logged. `offending` is the ENGINE's own text,
 * clipped to {@link MAX_FAULT_DETAIL_LENGTH}, and travels only in the frame.
 * Keeping them apart is what makes the redaction invariant checkable instead of
 * a promise: a guard that wants to show a value has to put it in the field the
 * log never reads.
 */
type Fault = { reason: string; offending?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Describe a value for a message WITHOUT quoting it.
 *
 * `JSON.stringify(value)` is the obvious thing and the wrong one: it copies an
 * engine-controlled string, of engine-controlled length, into text that is
 * logged. Numbers and booleans are safe to print - a JSON number is at most a
 * couple of dozen characters and cannot hold a path - and strings are reduced
 * to their length.
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `a ${value.length}-character string`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return 'an object';
}

/**
 * Cut an engine string to {@link MAX_FAULT_DETAIL_LENGTH}, never mid-pair.
 *
 * Slicing at a fixed index can split a surrogate pair and leave a LONE
 * surrogate in the frame - the same unpaired-escape hazard {@link
 * hasLoneSurrogate} refuses on the send path, and this value may be
 * re-serialised by whoever renders it. Stepping one code unit back is enough,
 * because a pair is exactly two units.
 */
function clip(value: string): string {
  if (value.length <= MAX_FAULT_DETAIL_LENGTH) return value;
  const last = value.charCodeAt(MAX_FAULT_DETAIL_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_FAULT_DETAIL_LENGTH - 1 : MAX_FAULT_DETAIL_LENGTH;
  return `${value.slice(0, end)}... (${value.length} characters)`;
}

function enumFault(field: string, value: unknown, allowed: ReadonlySet<string>): Fault | undefined {
  if (typeof value !== 'string') return { reason: `${field} must be a string, got ${describeType(value)}` };
  if (!allowed.has(value)) {
    // The value is NOT in the reason. `working_directory`'s own enum contains
    // `explicit` - "a path was configured" - so the likeliest way this branch
    // widens is an engine answering it with the path itself, and the reason is
    // the half that reaches the log.
    return { reason: `${field} has an unknown value (${value.length} characters)`, offending: clip(value) };
  }
  return undefined;
}

function booleanFault(field: string, value: unknown): Fault | undefined {
  // Never coerce: `"false"` is truthy, and `deferred` decides whether a server
  // is expected to be connected at all.
  if (typeof value !== 'boolean') return { reason: `${field} must be a boolean, got ${describeType(value)}` };
  return undefined;
}

function integerFault(field: string, value: unknown, min: number, max: number): Fault | undefined {
  // `Number.isInteger` is false for NaN and both infinities, which also keeps
  // values JSON cannot represent out.
  if (!Number.isInteger(value)) return { reason: `${field} must be an integer, got ${describeType(value)}` };
  const n = value as number;
  if (n < min || n > max) return { reason: `${field} must be within ${min}..${max}, got ${n}` };
  return undefined;
}

/**
 * A free-form engine string, bounded.
 *
 * EMPTINESS IS NOT CHECKED HERE: none of the strings this guards declares
 * `minLength` in the schema, and `mcp_removal_result.outcome` may legitimately
 * be `""` (the schema says `{"type":"string"}` and nothing more). The length
 * bound is the point - see {@link MAX_ENGINE_NAME_LENGTH} for why one is needed
 * at all - and the refusal names the length, never the text.
 */
function textFault(field: string, value: unknown, maxLength: number): Fault | undefined {
  if (typeof value !== 'string') return { reason: `${field} must be a string, got ${describeType(value)}` };
  if (value.length > maxLength) {
    return { reason: `${field} is ${value.length} characters, over the ${maxLength} this host carries` };
  }
  return undefined;
}

function optionalTextFault(field: string, value: unknown, maxLength: number): Fault | undefined {
  if (value === undefined) return undefined;
  return textFault(field, value, maxLength);
}

/**
 * Unknown fields, named in the frame and counted in the log.
 *
 * Key names are engine-controlled text of engine-controlled length, and an
 * object may carry thousands of them, so the reason states the COUNT and the
 * names ride along in `offending` - bounded by {@link MAX_NAMED_UNKNOWN_KEYS}
 * and clipped.
 */
function unknownKeyFault(label: string, raw: Record<string, unknown>, allowed: ReadonlySet<string>): Fault | undefined {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return undefined;
  const named = unknown.toSorted().slice(0, MAX_NAMED_UNKNOWN_KEYS);
  return {
    reason: `${label} carries ${unknown.length} unknown field(s)`,
    offending: clip(named.join(', ')),
  };
}

const PROFILE_BINDING_SET: ReadonlySet<string> = new Set<string>(PROFILE_BINDINGS);
const ENGINE_MODE_SET: ReadonlySet<string> = new Set<string>(ENGINE_MODES);
const WORKSPACE_KIND_SET: ReadonlySet<string> = new Set<string>(WORKSPACE_KINDS);
const CONFIG_ROLE_SET: ReadonlySet<string> = new Set<string>(CONFIG_SOURCE_ROLES);
const CONFIG_DISPOSITION_SET: ReadonlySet<string> = new Set<string>(CONFIG_DISPOSITIONS);
const MCP_ORIGIN_SET: ReadonlySet<string> = new Set<string>(MCP_ORIGINS);
const MCP_TRANSPORT_SET: ReadonlySet<string> = new Set<string>(MCP_TRANSPORTS);
const MCP_CONNECTION_SET: ReadonlySet<string> = new Set<string>(MCP_CONNECTIONS);
const MCP_EXPOSURE_SET: ReadonlySet<string> = new Set<string>(MCP_EXPOSURES);
const MCP_READINESS_SET: ReadonlySet<string> = new Set<string>(MCP_READINESS);
const MCP_WORKDIR_SET: ReadonlySet<string> = new Set<string>(MCP_WORKING_DIRECTORIES);
const MCP_REMEDIATION_SET: ReadonlySet<string> = new Set<string>(MCP_REMEDIATIONS);
const MCP_FAILURE_SET: ReadonlySet<string> = new Set<string>(MCP_FAILURES);
const UNAVAILABLE_REASON_SET: ReadonlySet<string> = new Set<string>(DIAGNOSTICS_UNAVAILABLE_REASONS);

/** `content_digest`, verbatim from the schema's `pattern`. */
const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * A lone (unpaired) UTF-16 surrogate, found by code unit rather than by regex.
 *
 * WHY THIS MATTERS ON THE SEND PATH. `JSON.stringify` escapes a lone surrogate
 * as `\udXXX` - valid JSON TEXT - but a strict JSON reader (serde_json, which
 * the engine uses) rejects an unpaired escape, so the whole line fails to parse
 * and the reply never comes. That is the one failure mode where the caller
 * cannot be told anything at all, so it is refused here instead.
 *
 * Written as a numeric scan, not a regex: a `\uD800-\uDBFF` character class
 * plus a lookbehind would need an ES2018 target, and putting the range in a
 * regex trips oxlint's control-character rules for no gain.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      // `charCodeAt` past the end is NaN, and NaN fails both comparisons.
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/**
 * The rule for an id DARHAI is about to SEND.
 *
 * Strict on purpose: the id is the host's to choose, so it is minted inside
 * {@link REQUEST_ID_PATTERN} and refused otherwise. The pattern is printable
 * ASCII, so `.length` and UTF-8 byte count are equal for anything that passes -
 * which is why the lifecycle verb's `x-maxUtf8Bytes: 256` needs no separate
 * check HERE (it does inbound, where no pattern applies).
 */
function mintedRequestIdFault(field: string, value: unknown, maxLength: number): Fault | undefined {
  if (typeof value !== 'string') return { reason: `${field} must be a string, got ${describeType(value)}` };
  if (value.length === 0) return { reason: `${field} must not be empty` };
  if (value.length > maxLength) {
    return { reason: `${field} must be at most ${maxLength} characters, got ${value.length}` };
  }
  if (!REQUEST_ID_PATTERN.test(value)) return { reason: `${field} must match ${REQUEST_ID_PATTERN.source}` };
  return undefined;
}

/**
 * The rule for an id the ENGINE sent, which is the schema's rule and no more.
 *
 * WHAT THE SCHEMA SAYS: `{"type":"string", "minLength":1, "maxLength":128}` for
 * both diagnostics replies, and `maxLength: 256` plus `x-maxUtf8Bytes: 256` for
 * `mcp_removal_result`. No `pattern` on any of them.
 *
 * WHY NOT REUSE {@link mintedRequestIdFault}: a schema-conformant reply whose id
 * simply is not one of ours (a prefix, a reformatted UUID) would be reported as
 * MALFORMED, when the accurate diagnosis is "an id this host never minted" -
 * and that difference is the whole content of the log line an operator reads
 * when a round-trip does not settle. Neither rule settles such a reply: every
 * ledger key was minted here, so an id outside the host's pattern cannot match
 * a pending entry either way. Guessing at a correspondence (suffix matching, a
 * lone outstanding request) would settle a request with an answer that may not
 * be its own, which is the one thing this module refuses to do.
 *
 * `maxUtf8Bytes` is optional because only the lifecycle verb declares one;
 * inventing a byte cap where the contract states none would refuse a reply the
 * engine is entitled to send.
 */
function inboundRequestIdFault(
  field: string,
  value: unknown,
  maxLength: number,
  maxUtf8Bytes?: number
): Fault | undefined {
  if (typeof value !== 'string') return { reason: `${field} must be a string, got ${describeType(value)}` };
  if (value.length === 0) return { reason: `${field} must not be empty` };
  if (value.length > maxLength) {
    return { reason: `${field} must be at most ${maxLength} characters, got ${value.length}` };
  }
  if (maxUtf8Bytes !== undefined) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxUtf8Bytes) {
      return { reason: `${field} must be at most ${maxUtf8Bytes} UTF-8 bytes, got ${bytes}` };
    }
  }
  return undefined;
}

/**
 * Quote a request_id for a log line, or describe it.
 *
 * An inbound id is validated against the schema only, which imposes no
 * character rule - so by the time one reaches a log line it may contain a
 * newline, and a newline in a line-oriented log file is a forged record.
 * {@link REQUEST_ID_PATTERN} answers exactly the right question here: an id
 * matching it is one this host could have minted, printable ASCII, safe
 * verbatim. Anything else is described rather than echoed.
 */
function idForLog(requestId: string): string {
  if (REQUEST_ID_PATTERN.test(requestId)) return `"${requestId}"`;
  return `an id outside this host's minting rule (${requestId.length} characters)`;
}

/**
 * A plain token: what engine text has to look like to be quoted in a message.
 *
 * `mcp_removal_result.outcome` is carried verbatim into the FRAME by design
 * (the contract declares no enum, so nothing here may decide what it means),
 * and the word is worth having in the log - `"removed"` and `"not_found"` are
 * the whole story of a removal. But it is free-form engine text: it may be a
 * path, and the module deliberately tolerates control characters in engine
 * strings, so an unfiltered echo could forge a line in a line-oriented log.
 * 64 characters is a CHOICE, an order above any status word the bundle shows.
 */
const LOG_SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function textForLog(value: string): string {
  if (LOG_SAFE_TOKEN.test(value)) return `"${value}"`;
  return `a ${value.length}-character value`;
}

/**
 * Validate an MCP server name for the wire.
 *
 * THREE RULES, and only two of them come from the schema:
 *
 *  1. `minLength: 1` / `maxLength: 256` - UTF-16 code units;
 *  2. `x-maxUtf8Bytes: 256` - BYTES, which is the trap: 200 Cyrillic characters
 *     are 200 code units and 400 bytes;
 *  3. no lone surrogate - a host choice, see {@link hasLoneSurrogate}.
 *
 * Control characters are NOT refused, and that silence in the contract was
 * noticed and resolved the permissive way on purpose: `JSON.stringify` escapes
 * them so the newline-delimited framing survives, and refusing would mean a
 * server whose name came out of a config file oddly is a server the user can
 * never remove - which is the exact hole this verb exists to close.
 */
function mcpNameFault(value: unknown): Fault | undefined {
  if (typeof value !== 'string') return { reason: `name must be a string, got ${describeType(value)}` };
  if (value.length === 0) return { reason: 'name must not be empty' };
  // PROVABLY REDUNDANT as a REJECTION, kept for its MESSAGE. In UTF-8 every
  // code unit costs at least one byte (a surrogate pair is 2 units and 4
  // bytes), so `length > 256` implies `bytes > 256` and the check below would
  // refuse the same name anyway. It stays because the two limits are separate
  // schema rules and a user fixing a name needs to be told which one they hit:
  // without this line a 257-character ASCII name is reported as a BYTE overrun,
  // which sends them looking for multi-byte characters that are not there.
  // Pinned by "names the code-unit rule and the byte rule separately".
  if (value.length > MAX_MCP_NAME_LENGTH) {
    return { reason: `name must be at most ${MAX_MCP_NAME_LENGTH} characters, got ${value.length}` };
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_MCP_NAME_UTF8_BYTES) {
    return { reason: `name must be at most ${MAX_MCP_NAME_UTF8_BYTES} UTF-8 bytes, got ${bytes}` };
  }
  if (hasLoneSurrogate(value)) {
    return { reason: 'name contains an unpaired surrogate and cannot be encoded as UTF-8' };
  }
  return undefined;
}

// -- minting and building -----------------------------------------------------

/**
 * Mint a request_id for a diagnostics round-trip.
 *
 * Shape: `rd-<base36 ms>-<8 hex>` - 20 ASCII characters, inside
 * {@link REQUEST_ID_PATTERN} and far under the 128 cap. Fresh per press: the
 * contract says nothing about id lifetime, and a stable derived id risks
 * colliding with a request the engine still remembers.
 */
export function mintDiagnosticsRequestId(): string {
  return `rd-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** Mint a request_id for an MCP removal. Same shape, different prefix. */
export function mintMcpRemovalRequestId(): string {
  return `mcp-rm-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Build `get_runtime_diagnostics`.
 *
 * The only sanctioned constructor: the command is `additionalProperties: false`
 * with exactly three fields, so it is assembled field-by-field from named
 * inputs and caller objects are never spread. `diagnostics_version` is not a
 * parameter because the schema pins it to `const: 1` - offering it would be
 * offering a way to build an invalid command.
 */
export function buildGetRuntimeDiagnostics(requestId: string): BuildOutcome<GetRuntimeDiagnosticsCommand> {
  const fault = mintedRequestIdFault('request_id', requestId, MAX_DIAGNOSTICS_REQUEST_ID_LENGTH);
  if (fault) return { ok: false, reason: fault.reason };
  return {
    ok: true,
    command: { type: 'get_runtime_diagnostics', diagnostics_version: DIAGNOSTICS_VERSION, request_id: requestId },
  };
}

/**
 * Build `remove_mcp_server`.
 *
 * `lifecycle_version` is likewise not a parameter: the schema's 0..65535 range
 * is not a menu the caller should be choosing from, and 1 is the only value the
 * contract exhibits.
 */
export function buildRemoveMcpServer(input: { requestId: string; name: string }): BuildOutcome<RemoveMcpServerCommand> {
  const idFault = mintedRequestIdFault('request_id', input.requestId, MAX_LIFECYCLE_REQUEST_ID_LENGTH);
  if (idFault) return { ok: false, reason: idFault.reason };

  const nameFault = mcpNameFault(input.name);
  if (nameFault) return { ok: false, reason: nameFault.reason };

  return {
    ok: true,
    command: {
      type: 'remove_mcp_server',
      lifecycle_version: MCP_LIFECYCLE_VERSION,
      request_id: input.requestId,
      name: input.name,
    },
  };
}

// -- the pending-request ledger ----------------------------------------------

/** Which verb a pending entry belongs to. */
export type RuntimeRequestVerb = 'get_runtime_diagnostics' | 'remove_mcp_server';

type PendingRuntimeRequest = {
  readonly requestId: string;
  readonly verb: RuntimeRequestVerb;
  /** The server name asked about, for `remove_mcp_server` only. */
  readonly name?: string;
  /**
   * The `diagnostics_version` this host actually put on the wire, for
   * `get_runtime_diagnostics` only.
   *
   * Recorded for the same reason `name` is: `runtime_diagnostics_unavailable`
   * echoes a version back, and without the sent value the host can only repeat
   * the engine's number while calling it its own request. Read from the built
   * command rather than from {@link DIAGNOSTICS_VERSION}, so it stays true if
   * the builder ever sends something else.
   */
  readonly diagnosticsVersion?: number;
  readonly at: number;
};

/** What the caller knows about a request that the reply cannot tell us. */
type PendingRequestDetails = { name?: string; diagnosticsVersion?: number };

/**
 * Requests awaiting a reply, keyed by request_id.
 *
 * Module-scoped because `CapabilityContext` has nowhere to put state and the
 * dispatcher is itself a module singleton. {@link resetRuntimeRequests} is the
 * seam for a new engine process - an id minted against a dead engine can never
 * be answered, and keeping it only makes a fresh request look like a duplicate.
 */
const pendingRequests = new Map<string, PendingRuntimeRequest>();

/**
 * Answers "would a command written right now actually leave this process?".
 *
 * Declared here rather than imported from another capability: a capability
 * module must not depend on a sibling, and the shape is one line.
 *
 * WHY IT IS A REQUIRED ARGUMENT. `CapabilityContext.sendCommand` returns void
 * and the implementation behind it drops the command in silence when the engine
 * is gone (`WCoreAgent.sendCommand` opens with
 * `if (!this.childProcess?.stdin?.writable) return;`). A capability holding
 * only the context therefore cannot tell a delivered command from a discarded
 * one - and a ledger entry written for a discarded command is a request_id that
 * can never be answered. The caller has the agent, so the caller must answer.
 */
export type EngineReachable = () => boolean;

/** What both send functions need from the layer above. */
export type RuntimeRequestDeps = {
  /** The engine's own capability grades, from `ready.contract`. */
  contract: NegotiatedContract;
  canReachEngine: EngineReachable;
};

export type SendRuntimeRequestOutcome = { ok: true; requestId: string } | { ok: false; reason: string };

/** Drop the oldest pending request to make room, loudly. */
function evictOldestRequest(ctx: CapabilityContext): void {
  // Map iterates in insertion order, so the first key is the oldest send.
  const oldest = pendingRequests.entries().next().value;
  if (oldest === undefined) return;
  pendingRequests.delete(oldest[0]);
  // The age is the useful half: an engine answering in milliseconds and an
  // engine that never answers look identical without it.
  const ageMs = Date.now() - oldest[1].at;
  ctx.warn(
    `evicted unanswered ${oldest[1].verb} "${oldest[0]}" after ${ageMs}ms - ${MAX_PENDING_RUNTIME_REQUESTS} were pending`
  );
}

/**
 * Gate a verb on what the engine says it can do.
 *
 * ONLY `available` qualifies (see `isCapabilityAvailable`). This is the whole
 * point of the contract dependency: a command sent to a build that graded the
 * capability `shape_only` is answered by nothing at all, and the host cannot
 * tell that apart from a slow engine - it would sit on a spinner until its own
 * timeout with no way to say "this engine does not have the feature". The grade
 * is put in the refusal text for the same reason: `shape_only` and
 * `unavailable` mean different things to whoever reads the message.
 */
function contractFault(contract: NegotiatedContract, capability: string): string | undefined {
  if (isCapabilityAvailable(contract, capability)) return undefined;
  return `the engine graded ${capability} "${gradeOf(contract, capability)}"; a command sent now would never be answered`;
}

/**
 * Send one request and remember it until the engine answers.
 *
 * ORDER MATTERS, and every failure leaves the ledger exactly as it found it:
 * build (so a malformed command is never sent), gate on the contract (so a
 * command is never sent to a build that cannot answer it), refuse a duplicate
 * id, probe the transport, write, and only then record. `ok: false` therefore
 * means nothing is pending and the user may act again; `ok: true` means the
 * command was written and an answer is owed.
 */
function sendRequest<T extends { type: RuntimeRequestVerb; request_id: string }>(
  ctx: CapabilityContext,
  built: BuildOutcome<T>,
  capability: string,
  deps: RuntimeRequestDeps,
  details: PendingRequestDetails = {}
): SendRuntimeRequestOutcome {
  // `=== false` rather than `!built.ok`: this repo compiles without
  // strictNullChecks, where only an explicit comparison narrows a discriminated
  // union - `!built.ok` leaves `built.reason` a type error.
  if (built.ok === false) {
    ctx.warn(`refusing to send a malformed runtime command: ${built.reason}`);
    return { ok: false, reason: built.reason };
  }

  const gate = contractFault(deps.contract, capability);
  if (gate) {
    ctx.warn(`refusing to send ${built.command.type}: ${gate}`);
    return { ok: false, reason: gate };
  }

  const requestId = built.command.request_id;
  if (pendingRequests.has(requestId)) {
    // Two live requests under one id cannot both be settled, and the contract
    // publishes no conflict reply for these verbs, so the second would silently
    // steal the first one's answer.
    const reason = `request_id "${requestId}" is already awaiting an answer`;
    ctx.warn(`refusing to send ${built.command.type}: ${reason}`);
    return { ok: false, reason };
  }

  if (!deps.canReachEngine()) {
    const reason = 'the engine cannot be reached, so the request was not sent';
    ctx.warn(`refusing to send ${built.command.type} "${requestId}": ${reason}`);
    return { ok: false, reason };
  }

  try {
    ctx.sendCommand(built.command);
  } catch (cause) {
    // The probe said yes and the write still failed - a stream that died in
    // between throws EPIPE / ERR_STREAM_DESTROYED rather than returning. An
    // unsent request is one the user can repeat; a recorded-but-unsent request
    // is a spinner nothing will ever stop.
    const reason = `the request was not sent: ${String(cause)}`;
    ctx.warn(`${built.command.type} "${requestId}" failed to reach the engine: ${String(cause)}`);
    return { ok: false, reason };
  }

  if (pendingRequests.size >= MAX_PENDING_RUNTIME_REQUESTS) evictOldestRequest(ctx);

  const entry: PendingRuntimeRequest = {
    requestId,
    verb: built.command.type,
    name: details.name,
    diagnosticsVersion: details.diagnosticsVersion,
    at: Date.now(),
  };
  pendingRequests.set(requestId, entry);
  return { ok: true, requestId };
}

/** Ask the engine for a diagnostics snapshot. Gated on `runtime_diagnostics_v1`. */
export function sendGetRuntimeDiagnostics(
  ctx: CapabilityContext,
  requestId: string,
  deps: RuntimeRequestDeps
): SendRuntimeRequestOutcome {
  const built = buildGetRuntimeDiagnostics(requestId);
  return sendRequest(ctx, built, RUNTIME_DIAGNOSTICS_CAPABILITY, deps, {
    // Taken from the command that is actually written, not from the constant:
    // the reply echoes a version back, and the honest comparison is against
    // what went out.
    diagnosticsVersion: built.ok === true ? built.command.diagnostics_version : undefined,
  });
}

/**
 * Detach a live MCP server. Gated on `runtime_mcp_lifecycle_v1`.
 *
 * The `name` is remembered so the reply can be checked against what was asked
 * for: the engine echoes `name` back, and reporting "N tools withdrawn from X"
 * when the engine actually removed Y would be a confident wrong answer about an
 * action the user cannot undo from here.
 */
export function sendRemoveMcpServer(
  ctx: CapabilityContext,
  input: { requestId: string; name: string },
  deps: RuntimeRequestDeps
): SendRuntimeRequestOutcome {
  return sendRequest(ctx, buildRemoveMcpServer(input), RUNTIME_MCP_LIFECYCLE_CAPABILITY, deps, {
    name: typeof input.name === 'string' ? input.name : undefined,
  });
}

/** request_ids still awaiting an answer, in the order they were sent. */
export function pendingRuntimeRequestIds(): readonly string[] {
  return [...pendingRequests.keys()];
}

/** Forget every pending request. For a new engine process; see the map's note. */
export function resetRuntimeRequests(): void {
  pendingRequests.clear();
}

// -- decoders -----------------------------------------------------------------

const SNAPSHOT_EVENT_KEYS: ReadonlySet<string> = new Set(['type', 'diagnostics_version', 'request_id', 'snapshot']);
const SNAPSHOT_BODY_KEYS: ReadonlySet<string> = new Set([
  'process',
  'config_sources',
  'unsupported_overrides',
  'mcp_servers',
]);
const PROCESS_KEYS: ReadonlySet<string> = new Set(['profile_binding', 'engine_mode', 'workspace_kind', 'profile_name']);
const CONFIG_SOURCE_KEYS: ReadonlySet<string> = new Set([
  'role',
  'disposition',
  'precedence',
  'content_digest',
  'display_path',
]);
const OVERRIDE_KEYS: ReadonlySet<string> = new Set(['name', 'disposition']);
const MCP_SERVER_KEYS: ReadonlySet<string> = new Set([
  'name',
  'origin',
  'transport',
  'connection',
  'exposure',
  'deferred',
  'tool_count',
  'resources_declared',
  'resources_exposed',
  'assistant_scoped',
  'executable_readiness',
  'working_directory',
  'remediation',
  'executable_basename',
  'failure',
]);
const REMOVAL_KEYS: ReadonlySet<string> = new Set([
  'type',
  'lifecycle_version',
  'request_id',
  'name',
  'outcome',
  'removed_tools',
]);

/** Decoded, or the reason this one entry could not be read. */
type EntryOutcome<T> = { ok: true; value: T } | { ok: false; reason: string; offending?: string };

/** Turn a {@link Fault} into a refusal without dropping its frame-only half. */
function failed<T>(fault: Fault): EntryOutcome<T> {
  if (fault.offending === undefined) return { ok: false, reason: fault.reason };
  return { ok: false, reason: fault.reason, offending: fault.offending };
}

/** The same, for a whole reply, carrying whatever request_id was salvaged. */
function refused<T>(fault: Fault, requestId: string | null): DecodeOutcome<T> {
  if (fault.offending === undefined) return { ok: false, reason: fault.reason, requestId };
  return { ok: false, reason: fault.reason, requestId, offending: fault.offending };
}

function decodeConfigSource(raw: unknown): EntryOutcome<RuntimeConfigSource> {
  if (!isRecord(raw)) return { ok: false, reason: `entry is not an object, got ${describeType(raw)}` };

  const unknown = unknownKeyFault('config source', raw, CONFIG_SOURCE_KEYS);
  if (unknown) return failed(unknown);

  const roleFault = enumFault('role', raw.role, CONFIG_ROLE_SET);
  if (roleFault) return failed(roleFault);
  const dispositionFault = enumFault('disposition', raw.disposition, CONFIG_DISPOSITION_SET);
  if (dispositionFault) return failed(dispositionFault);
  // `precedence` orders the whole chain, so a value outside the schema's range
  // would sort the "which config is actually in effect" answer wrongly.
  const precedenceFault = integerFault('precedence', raw.precedence, 0, 65535);
  if (precedenceFault) return failed(precedenceFault);

  const entry: RuntimeConfigSource = {
    role: raw.role as ConfigSourceRole,
    disposition: raw.disposition as ConfigDisposition,
    precedence: raw.precedence as number,
  };

  const digest = raw.content_digest;
  if (digest !== undefined) {
    // The schema pins the shape; a digest that does not match cannot be
    // compared against anything, and showing it would invite exactly that.
    if (typeof digest !== 'string' || !CONTENT_DIGEST_PATTERN.test(digest)) {
      return { ok: false, reason: `content_digest must match ${CONTENT_DIGEST_PATTERN.source}` };
    }
    entry.content_digest = digest;
  }

  // Bounded, and the refusal names only the LENGTH: this is the field most
  // likely to hold a real home directory.
  const pathFault = optionalTextFault('display_path', raw.display_path, MAX_ENGINE_PATH_LENGTH);
  if (pathFault) return failed(pathFault);
  if (raw.display_path !== undefined) entry.display_path = raw.display_path as string;

  return { ok: true, value: entry };
}

function decodeUnsupportedOverride(raw: unknown): EntryOutcome<RuntimeUnsupportedOverride> {
  if (!isRecord(raw)) return { ok: false, reason: `entry is not an object, got ${describeType(raw)}` };

  const unknown = unknownKeyFault('unsupported override', raw, OVERRIDE_KEYS);
  if (unknown) return failed(unknown);

  // An environment variable name. Bounded like every other engine-sized string;
  // see {@link MAX_ENGINE_NAME_LENGTH}.
  const nameFault = textFault('name', raw.name, MAX_ENGINE_NAME_LENGTH);
  if (nameFault) return failed(nameFault);
  const dispositionFault = enumFault('disposition', raw.disposition, CONFIG_DISPOSITION_SET);
  if (dispositionFault) return failed(dispositionFault);

  return { ok: true, value: { name: raw.name as string, disposition: raw.disposition as ConfigDisposition } };
}

/**
 * Decode one MCP server row.
 *
 * UNKNOWN ENUM MEMBERS ARE REFUSED rather than carried through as strings.
 * `executable_readiness`, `connection` and `exposure` are what the UI turns
 * into "install the executable" or "fix its permissions"; a value outside the
 * declared set cannot be mapped to advice, and widening the type to `string` so
 * it could be stored would push the guess into every consumer instead of
 * catching it here. The cost is bounded by construction: only THIS row becomes
 * an {@link UnreadableSnapshotEntry}, the rest of the snapshot still renders.
 */
function decodeMcpServer(raw: unknown): EntryOutcome<RuntimeMcpServer> {
  if (!isRecord(raw)) return { ok: false, reason: `entry is not an object, got ${describeType(raw)}` };

  const unknown = unknownKeyFault('mcp server', raw, MCP_SERVER_KEYS);
  if (unknown) return failed(unknown);

  // Bounded: the snapshot's `name` has no `maxLength`, yet it is the very
  // string `remove_mcp_server` caps at 256 - a longer one names a server the
  // user could not remove even if it were rendered.
  const nameFault = textFault('name', raw.name, MAX_ENGINE_NAME_LENGTH);
  if (nameFault) return failed(nameFault);

  const enumFaults = [
    enumFault('origin', raw.origin, MCP_ORIGIN_SET),
    enumFault('transport', raw.transport, MCP_TRANSPORT_SET),
    enumFault('connection', raw.connection, MCP_CONNECTION_SET),
    enumFault('exposure', raw.exposure, MCP_EXPOSURE_SET),
    enumFault('executable_readiness', raw.executable_readiness, MCP_READINESS_SET),
    enumFault('working_directory', raw.working_directory, MCP_WORKDIR_SET),
  ];
  for (const fault of enumFaults) {
    if (fault) return failed(fault);
  }

  const boolFaults = [
    booleanFault('deferred', raw.deferred),
    booleanFault('resources_declared', raw.resources_declared),
    booleanFault('resources_exposed', raw.resources_exposed),
    booleanFault('assistant_scoped', raw.assistant_scoped),
  ];
  for (const fault of boolFaults) {
    if (fault) return failed(fault);
  }

  const countFault = integerFault('tool_count', raw.tool_count, 0, 4294967295);
  if (countFault) return failed(countFault);

  const rawRemediation = raw.remediation;
  if (!Array.isArray(rawRemediation)) {
    return { ok: false, reason: `remediation must be an array, got ${describeType(rawRemediation)}` };
  }
  if (rawRemediation.length > MAX_REMEDIATION_HINTS) {
    return {
      ok: false,
      reason: `remediation carries ${rawRemediation.length} hints, over the ${MAX_REMEDIATION_HINTS} this host reads`,
    };
  }
  const remediation: McpRemediation[] = [];
  for (const [index, hint] of rawRemediation.entries()) {
    const fault = enumFault(`remediation[${index}]`, hint, MCP_REMEDIATION_SET);
    if (fault) return failed(fault);
    remediation.push(hint as McpRemediation);
  }

  const server: RuntimeMcpServer = {
    name: raw.name as string,
    origin: raw.origin as McpOrigin,
    transport: raw.transport as McpTransport,
    connection: raw.connection as McpConnection,
    exposure: raw.exposure as McpExposure,
    deferred: raw.deferred as boolean,
    tool_count: raw.tool_count as number,
    resources_declared: raw.resources_declared as boolean,
    resources_exposed: raw.resources_exposed as boolean,
    assistant_scoped: raw.assistant_scoped as boolean,
    executable_readiness: raw.executable_readiness as McpExecutableReadiness,
    working_directory: raw.working_directory as McpWorkingDirectory,
    remediation,
  };

  const basenameFault = optionalTextFault('executable_basename', raw.executable_basename, MAX_ENGINE_NAME_LENGTH);
  if (basenameFault) return failed(basenameFault);
  if (raw.executable_basename !== undefined) server.executable_basename = raw.executable_basename as string;

  if (raw.failure !== undefined) {
    const failureFault = enumFault('failure', raw.failure, MCP_FAILURE_SET);
    if (failureFault) return failed(failureFault);
    server.failure = raw.failure as McpFailure;
  }

  return { ok: true, value: server };
}

/**
 * The salvageable `name` of an entry, for an unreadable-row report.
 *
 * Clipped: this is a row the decoder already refused, so its `name` is under no
 * length rule at all - the very field {@link MAX_ENGINE_NAME_LENGTH} bounds may
 * be what made the row unreadable. Frame only; nothing logs it.
 */
function salvageName(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return typeof raw.name === 'string' ? clip(raw.name) : null;
}

type ListOutcome<T> = { ok: true; entries: T[]; unreadable: UnreadableSnapshotEntry[] } | { ok: false; reason: string };

/**
 * Decode one array of the snapshot, bounded and entry-by-entry.
 *
 * Over the cap the whole LIST is refused (and with it the snapshot), because a
 * truncated inventory rendered as complete is the silent wrong answer; below
 * the cap a bad entry is kept as an explicit hole. See {@link MAX_MCP_SERVERS}
 * and {@link UnreadableSnapshotEntry} for both halves of that reasoning.
 */
function decodeList<T>(
  list: UnreadableSnapshotEntry['list'],
  raw: unknown,
  cap: number,
  decode: (entry: unknown) => EntryOutcome<T>
): ListOutcome<T> {
  if (!Array.isArray(raw)) return { ok: false, reason: `${list} must be an array, got ${describeType(raw)}` };
  if (raw.length > cap) return { ok: false, reason: `${list} carries ${raw.length} entries, over the ${cap} cap` };

  const entries: T[] = [];
  const unreadable: UnreadableSnapshotEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const decoded = decode(item);
    if (decoded.ok === false) {
      const hole: UnreadableSnapshotEntry = { list, index, name: salvageName(item), reason: decoded.reason };
      if (decoded.offending !== undefined) hole.offending = decoded.offending;
      unreadable.push(hole);
      continue;
    }
    entries.push(decoded.value);
  }
  return { ok: true, entries, unreadable };
}

function decodeProcessBinding(raw: unknown): EntryOutcome<RuntimeProcessBinding> {
  if (!isRecord(raw)) return { ok: false, reason: `process is not an object, got ${describeType(raw)}` };

  const unknown = unknownKeyFault('process', raw, PROCESS_KEYS);
  if (unknown) return failed(unknown);

  const faults = [
    enumFault('profile_binding', raw.profile_binding, PROFILE_BINDING_SET),
    enumFault('engine_mode', raw.engine_mode, ENGINE_MODE_SET),
    enumFault('workspace_kind', raw.workspace_kind, WORKSPACE_KIND_SET),
    optionalTextFault('profile_name', raw.profile_name, MAX_ENGINE_NAME_LENGTH),
  ];
  for (const fault of faults) {
    if (fault) return failed(fault);
  }

  const binding: RuntimeProcessBinding = {
    profile_binding: raw.profile_binding as RuntimeProfileBinding,
    engine_mode: raw.engine_mode as RuntimeEngineMode,
    workspace_kind: raw.workspace_kind as RuntimeWorkspaceKind,
  };
  if (raw.profile_name !== undefined) binding.profile_name = raw.profile_name as string;
  return { ok: true, value: binding };
}

/**
 * Decode `runtime_diagnostics_snapshot`.
 *
 * UNKNOWN TOP-LEVEL KEYS ARE REFUSED because the schema branch is
 * `additionalProperties: false` and the manifest grades this event
 * `criticality: safety`. Elsewhere Darhai tolerates unknown keys (`ready`),
 * where an unrecognised key is indistinguishable from an engine upgrade; here a
 * key this host does not model may be the half that says which config file
 * actually won.
 */
export function decodeRuntimeDiagnosticsSnapshot(
  event: Record<string, unknown>
): DecodeOutcome<DecodedRuntimeDiagnostics> {
  if (event.type !== 'runtime_diagnostics_snapshot') {
    return {
      ok: false,
      reason: `not a runtime_diagnostics_snapshot, got ${describeValue(event.type)}`,
      requestId: null,
    };
  }

  // Salvage the id FIRST so every failure below can still settle its caller.
  // The SCHEMA's rule, not the host's minting rule - see
  // {@link inboundRequestIdFault}.
  const idFault = inboundRequestIdFault('request_id', event.request_id, MAX_DIAGNOSTICS_REQUEST_ID_LENGTH);
  const requestId = idFault ? null : (event.request_id as string);

  const unknown = unknownKeyFault('runtime_diagnostics_snapshot', event, SNAPSHOT_EVENT_KEYS);
  if (unknown) return refused(unknown, requestId);

  // `const: 1` in the schema. A snapshot announcing another version while
  // carrying a v1-shaped body is a message this host cannot claim to
  // understand, and the engine has `runtime_diagnostics_unavailable` for
  // exactly the version conversation.
  if (event.diagnostics_version !== DIAGNOSTICS_VERSION) {
    return {
      ok: false,
      reason: `diagnostics_version must be ${DIAGNOSTICS_VERSION}, got ${describeValue(event.diagnostics_version)}`,
      requestId,
    };
  }

  if (idFault) return { ok: false, reason: idFault.reason, requestId: null };

  const body = event.snapshot;
  if (!isRecord(body)) return { ok: false, reason: `snapshot must be an object, got ${describeType(body)}`, requestId };

  const unknownBody = unknownKeyFault('snapshot', body, SNAPSHOT_BODY_KEYS);
  if (unknownBody) return refused(unknownBody, requestId);

  const process = decodeProcessBinding(body.process);
  if (process.ok === false) return refused({ reason: process.reason, offending: process.offending }, requestId);

  const sources = decodeList('config_sources', body.config_sources, MAX_CONFIG_SOURCES, decodeConfigSource);
  if (sources.ok === false) return { ok: false, reason: sources.reason, requestId };

  const overrides = decodeList(
    'unsupported_overrides',
    body.unsupported_overrides,
    MAX_UNSUPPORTED_OVERRIDES,
    decodeUnsupportedOverride
  );
  if (overrides.ok === false) return { ok: false, reason: overrides.reason, requestId };

  const servers = decodeList('mcp_servers', body.mcp_servers, MAX_MCP_SERVERS, decodeMcpServer);
  if (servers.ok === false) return { ok: false, reason: servers.reason, requestId };

  return {
    ok: true,
    value: {
      requestId: requestId as string,
      snapshot: {
        process: process.value,
        config_sources: sources.entries,
        unsupported_overrides: overrides.entries,
        mcp_servers: servers.entries,
      },
      unreadable: [...sources.unreadable, ...overrides.unreadable, ...servers.unreadable],
    },
  };
}

/**
 * Decode `runtime_diagnostics_unavailable`.
 *
 * UNKNOWN KEYS ARE TOLERATED here, unlike the snapshot, and the difference is
 * the schema's own: this branch is `additionalProperties: true`. Refusing an
 * unmodelled key would be inventing a rule the contract explicitly declined to
 * make - and this payload has no body to misread, only a version and a reason.
 */
export function decodeDiagnosticsUnavailable(
  event: Record<string, unknown>
): DecodeOutcome<DecodedDiagnosticsUnavailable> {
  if (event.type !== 'runtime_diagnostics_unavailable') {
    return {
      ok: false,
      reason: `not a runtime_diagnostics_unavailable, got ${describeValue(event.type)}`,
      requestId: null,
    };
  }

  const idFault = inboundRequestIdFault('request_id', event.request_id, MAX_DIAGNOSTICS_REQUEST_ID_LENGTH);
  const requestId = idFault ? null : (event.request_id as string);
  if (idFault) return { ok: false, reason: idFault.reason, requestId: null };

  // `diagnostics_version` here is an ECHO of the version the host asked for -
  // integer 0..65535, NOT const 1. Pinning it to 1 would make the fixture
  // (which carries 2) undecodable, which is the whole point of this event. The
  // range still has to be checked: it is rendered, logged and compared against
  // what this host actually sent.
  const echoFault = integerFault('diagnostics_version', event.diagnostics_version, 0, 65535);
  if (echoFault) return refused(echoFault, requestId);

  // `supported_version` IS const 1 in the schema. A different value means the
  // engine and this host disagree about what "version 1" is, and the reply
  // cannot be rendered as "this build only speaks 1".
  if (event.supported_version !== 1) {
    return {
      ok: false,
      reason: `supported_version must be 1, got ${describeValue(event.supported_version)}`,
      requestId,
    };
  }

  const reasonFault = enumFault('reason', event.reason, UNAVAILABLE_REASON_SET);
  if (reasonFault) return refused(reasonFault, requestId);

  return {
    ok: true,
    value: {
      requestId: requestId as string,
      echoedVersion: event.diagnostics_version as number,
      supportedVersion: 1,
      reason: event.reason as DiagnosticsUnavailableReason,
    },
  };
}

/**
 * Decode `mcp_removal_result`.
 *
 * `outcome` IS NOT VALIDATED AGAINST ANY VALUE. Both `core-event.schema.json`
 * and `producer-complete.schema.json` declare it `{"type":"string"}` with no
 * enum; 'removed' is the only value the bundle exhibits anywhere, and what the
 * engine emits for "no such server", "refused" or "partially removed" can only
 * be settled by running the binary. Treating anything but 'removed' as failure
 * would be a guess with a user-visible consequence, so the string is carried
 * through verbatim and rendered as-is.
 */
export function decodeMcpRemovalResult(event: Record<string, unknown>): DecodeOutcome<DecodedMcpRemoval> {
  if (event.type !== 'mcp_removal_result') {
    return { ok: false, reason: `not an mcp_removal_result, got ${describeValue(event.type)}`, requestId: null };
  }

  // The lifecycle verb is the one that declares `x-maxUtf8Bytes: 256` alongside
  // `maxLength: 256`, and the two are different rules - see
  // {@link MAX_MCP_NAME_LENGTH}.
  const idFault = inboundRequestIdFault(
    'request_id',
    event.request_id,
    MAX_LIFECYCLE_REQUEST_ID_LENGTH,
    MAX_LIFECYCLE_REQUEST_ID_LENGTH
  );
  const requestId = idFault ? null : (event.request_id as string);

  const unknown = unknownKeyFault('mcp_removal_result', event, REMOVAL_KEYS);
  if (unknown) return refused(unknown, requestId);

  if (idFault) return { ok: false, reason: idFault.reason, requestId: null };

  const versionFault = integerFault('lifecycle_version', event.lifecycle_version, 0, 65535);
  if (versionFault) return refused(versionFault, requestId);

  const nameFault = mcpNameFault(event.name);
  if (nameFault) return refused(nameFault, requestId);

  // `outcome` is carried VERBATIM (no enum in either schema) but not
  // unboundedly: it has no `maxLength` either, and this reply has no per-entry
  // salvage, so an oversized one settles the caller as undecodable rather than
  // travelling into the frame.
  const outcomeFault = textFault('outcome', event.outcome, MAX_ENGINE_NAME_LENGTH);
  if (outcomeFault) return refused(outcomeFault, requestId);

  const rawTools = event.removed_tools;
  if (!Array.isArray(rawTools)) {
    return { ok: false, reason: `removed_tools must be an array, got ${describeType(rawTools)}`, requestId };
  }

  // Bounded scan: only the first MAX_REMOVED_TOOLS are read, so a hostile
  // 100k-name list cannot stall the decode path. Names past the cap are counted
  // and flagged, never silently dropped.
  const limit = Math.min(rawTools.length, MAX_REMOVED_TOOLS);
  const removedTools: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    // Each name is bounded as well as counted: 512 unbounded strings is the
    // same unbounded frame the count cap does nothing about.
    const toolFault = textFault(`removed_tools[${i}]`, rawTools[i], MAX_ENGINE_NAME_LENGTH);
    if (toolFault) return refused(toolFault, requestId);
    removedTools.push(rawTools[i] as string);
  }

  return {
    ok: true,
    value: {
      requestId: requestId as string,
      lifecycleVersion: event.lifecycle_version as number,
      name: event.name as string,
      outcome: event.outcome as string,
      removedTools,
      removedToolCount: rawTools.length,
      toolsTruncated: rawTools.length > MAX_REMOVED_TOOLS,
    },
  };
}

// -- frames -------------------------------------------------------------------

/** What the task layer receives for a diagnostics round-trip. */
export type RuntimeDiagnosticsFrameData =
  | {
      status: 'snapshot';
      requestId: string;
      snapshot: RuntimeDiagnosticsSnapshot;
      unreadable: UnreadableSnapshotEntry[];
    }
  | {
      status: 'unavailable';
      requestId: string;
      /** What THIS HOST sent, from the ledger - not an echo. */
      requestedVersion: number;
      /** What the engine echoed back. Equal to `requestedVersion` unless the engine is at fault. */
      echoedVersion: number;
      /** True when the two disagree, i.e. the engine answered about a version Darhai never asked for. */
      echoMismatch: boolean;
      supportedVersion: number;
      reason: DiagnosticsUnavailableReason;
    }
  | { status: 'undecodable'; requestId: string; detail: string; offending?: string };

/** What the task layer receives for an MCP removal. */
export type McpRemovalFrameData =
  | {
      status: 'result';
      requestId: string;
      name: string;
      outcome: string;
      removedTools: string[];
      removedToolCount: number;
      toolsTruncated: boolean;
    }
  | { status: 'name_mismatch'; requestId: string; requestedName: string; reportedName: string; outcome: string }
  | { status: 'undecodable'; requestId: string; detail: string; offending?: string };

/**
 * Announce a decision to the task layer.
 *
 * `msg_id` is EMPTY on purpose. Diagnostics is Settings-initiated and can fire
 * mid-turn; filing a session-wide fact under whatever turn happens to be open
 * would attach it to an unrelated message. That choice is also why registration
 * matters: `WCoreManager` drops msg_id-less frames unless the type is claimed by
 * a registered capability, so an unregistered handler emits into a void.
 *
 * It is deliberately NOT a reason to touch the turn-stall watchdog either: that
 * watchdog resets on frames carrying a msg_id, and a Settings pane polling for
 * diagnostics must never keep a genuinely stalled turn alive.
 */
function emitDiagnosticsFrame(ctx: CapabilityContext, type: string, data: RuntimeDiagnosticsFrameData): void {
  ctx.emit({ type, data, msg_id: '' });
}

function emitRemovalFrame(ctx: CapabilityContext, data: McpRemovalFrameData): void {
  ctx.emit({ type: 'mcp_removal_result', data, msg_id: '' });
}

/**
 * A log line for a snapshot that names COUNTS and nothing else.
 *
 * The contract's own DEFERRED.md claims diagnostics are "redacted before
 * entering protocol state", but nothing in `core-event.schema.json` enforces
 * it: `display_path`, `profile_name` and `executable_basename` are free-form
 * strings, and the single fixture's tokenised `$CONFIG/...` path is one sample,
 * not a guarantee. Logs are written to disk and shipped in bug reports, so this
 * host assumes the snapshot MAY carry a real home directory and keeps all three
 * fields out of the log entirely. They still travel in the frame, which is the
 * renderer's to show to the user who asked for it.
 */
function summariseSnapshot(value: DecodedRuntimeDiagnostics): string {
  const s = value.snapshot;
  return (
    `diagnostics ${value.requestId}: ${s.config_sources.length} config source(s), ` +
    `${s.unsupported_overrides.length} ignored override(s), ${s.mcp_servers.length} mcp server(s), ` +
    `${value.unreadable.length} unreadable entr(ies)`
  );
}

/**
 * Find the request this reply answers, or say why it settles nothing.
 *
 * TWO WAYS TO DROP, both loud and both leaving the ledger untouched:
 *
 *  - no pending entry: the reply is a duplicate, a replay, or an answer to a
 *    request that was already evicted - possibly from a previous engine
 *    process. `request_id` is the declared correlation key, so a reply that
 *    matches nothing must never be applied to a neighbour;
 *  - a pending entry for the OTHER verb: both verbs share one id space, so an
 *    `mcp_removal_result` carrying a diagnostics id would otherwise settle a
 *    diagnostics request with a removal payload.
 */
function takePending(
  ctx: CapabilityContext,
  requestId: string,
  verb: RuntimeRequestVerb,
  eventType: string
): PendingRuntimeRequest | null {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    // {@link idForLog}, not the raw id: an unmatched id is by definition one
    // this host did not mint, so it is engine text of engine length and may
    // carry a newline into a line-oriented log file.
    ctx.warn(`unsolicited ${eventType} for request_id ${idForLog(requestId)} - dropped`);
    return null;
  }
  if (pending.verb !== verb) {
    ctx.warn(`${eventType} for request_id "${requestId}" was minted for ${pending.verb} - dropped`);
    return null;
  }
  pendingRequests.delete(requestId);
  return pending;
}

/**
 * Settle a reply this host could not read.
 *
 * The request WAS answered, so the caller gets an answer - just an honest one.
 * Returning without settling would leave a spinner running over a completed
 * round-trip, which is the failure this whole module exists to remove.
 */
function settleUndecodable(
  ctx: CapabilityContext,
  eventType: string,
  verb: RuntimeRequestVerb,
  requestId: string | null,
  fault: Fault
): boolean {
  if (requestId === null) {
    ctx.warn(`ignoring malformed ${eventType} with no readable request_id: ${fault.reason}`);
    return false;
  }
  const pending = takePending(ctx, requestId, verb, eventType);
  if (!pending) return false;

  // The REASON only. `fault.offending` is the engine's own text and rides in
  // the frame; see the redaction note in the file header.
  ctx.warn(`${eventType} "${requestId}" could not be decoded: ${fault.reason}`);
  const data: { status: 'undecodable'; requestId: string; detail: string; offending?: string } = {
    status: 'undecodable',
    requestId,
    detail: fault.reason,
  };
  if (fault.offending !== undefined) data.offending = fault.offending;
  if (verb === 'remove_mcp_server') {
    emitRemovalFrame(ctx, data);
  } else {
    emitDiagnosticsFrame(ctx, eventType, data);
  }
  return true;
}

function handleSnapshot(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
  const decoded = decodeRuntimeDiagnosticsSnapshot(event);
  if (decoded.ok === false) {
    return settleUndecodable(ctx, 'runtime_diagnostics_snapshot', 'get_runtime_diagnostics', decoded.requestId, {
      reason: decoded.reason,
      offending: decoded.offending,
    });
  }

  const value = decoded.value;
  const pending = takePending(ctx, value.requestId, 'get_runtime_diagnostics', 'runtime_diagnostics_snapshot');
  if (!pending) return false;

  ctx.log(summariseSnapshot(value));
  if (value.unreadable.length > 0) {
    // Named loudly: a hole in the inventory has to be visible to whoever is
    // debugging why a server does not appear.
    //
    // TWO BOUNDS, both about what the ENGINE controls. The reasons are
    // host-authored, so no engine text (a path in an unknown enum value, a
    // salvaged name) reaches disk; and only the first
    // MAX_LOGGED_UNREADABLE_REASONS are listed, because at the per-list caps
    // there can be 576 of them and the log file rotates at 10 MB. The total is
    // always stated, and the frame below carries every one.
    const listed = value.unreadable
      .slice(0, MAX_LOGGED_UNREADABLE_REASONS)
      .map((entry) => `${entry.list}[${entry.index}]: ${entry.reason}`);
    const omitted = value.unreadable.length - listed.length;
    if (omitted > 0) listed.push(`...and ${omitted} more`);
    ctx.warn(
      `runtime_diagnostics_snapshot "${value.requestId}" carried ${value.unreadable.length} entr(ies) this build cannot read`,
      listed
    );
  }
  emitDiagnosticsFrame(ctx, 'runtime_diagnostics_snapshot', {
    status: 'snapshot',
    requestId: value.requestId,
    snapshot: value.snapshot,
    unreadable: value.unreadable,
  });
  return true;
}

function handleUnavailable(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
  const decoded = decodeDiagnosticsUnavailable(event);
  if (decoded.ok === false) {
    return settleUndecodable(ctx, 'runtime_diagnostics_unavailable', 'get_runtime_diagnostics', decoded.requestId, {
      reason: decoded.reason,
      offending: decoded.offending,
    });
  }

  const value = decoded.value;
  const pending = takePending(ctx, value.requestId, 'get_runtime_diagnostics', 'runtime_diagnostics_unavailable');
  if (!pending) return false;

  // WHAT THIS HOST ASKED comes from the ledger, never from the reply. The
  // command's `diagnostics_version` is `const: 1`, so Darhai cannot ask for
  // anything else; an echo carrying another number is an engine fault, and
  // reporting it as "asked for 65535" would be this host stating, in a line
  // written to disk, that it sent something it cannot send. Where a ledger
  // entry predates the recording (nothing writes one today, but the field is
  // optional), fall back to the constant the builder pins.
  const requestedVersion = pending.diagnosticsVersion === undefined ? DIAGNOSTICS_VERSION : pending.diagnosticsVersion;
  const echoMismatch = value.echoedVersion !== requestedVersion;

  // A refusal, not a fault: the engine answered the question it was asked.
  ctx.log(
    `diagnostics ${value.requestId} unavailable (${value.reason}); this host asked for ${requestedVersion}, engine serves ${value.supportedVersion}` +
      (echoMismatch ? ` - and echoed ${value.echoedVersion}, which this host never sent` : '')
  );
  if (echoMismatch) {
    ctx.warn(
      `runtime_diagnostics_unavailable "${value.requestId}" echoes diagnostics_version ${value.echoedVersion}; this host sent ${requestedVersion}`
    );
  }
  emitDiagnosticsFrame(ctx, 'runtime_diagnostics_unavailable', {
    status: 'unavailable',
    requestId: value.requestId,
    requestedVersion,
    echoedVersion: value.echoedVersion,
    echoMismatch,
    supportedVersion: value.supportedVersion,
    reason: value.reason,
  });
  return true;
}

function handleRemoval(event: Record<string, unknown>, ctx: CapabilityContext): boolean {
  const decoded = decodeMcpRemovalResult(event);
  if (decoded.ok === false) {
    return settleUndecodable(ctx, 'mcp_removal_result', 'remove_mcp_server', decoded.requestId, {
      reason: decoded.reason,
      offending: decoded.offending,
    });
  }

  const value = decoded.value;
  const pending = takePending(ctx, value.requestId, 'remove_mcp_server', 'mcp_removal_result');
  if (!pending) return false;

  // The engine echoes `name`. A mismatch means the reply is about a different
  // server than the one the user asked to remove, and "3 tools withdrawn from
  // X" would then be a confident wrong statement about an action that cannot be
  // undone from here. Report the disagreement instead of picking a side.
  if (pending.name !== undefined && pending.name !== value.name) {
    // The declared exception to the redaction rule: here the two names ARE the
    // finding, so they go to the logger as structured DETAIL (never spliced
    // into the message). Both are bounded - the requested one by
    // {@link mcpNameFault} on the send path, the reported one by the same guard
    // inbound.
    ctx.warn(`mcp_removal_result "${value.requestId}" reports a different server than requested`, {
      requested: pending.name,
      reported: value.name,
    });
    emitRemovalFrame(ctx, {
      status: 'name_mismatch',
      requestId: value.requestId,
      requestedName: pending.name,
      reportedName: value.name,
      outcome: value.outcome,
    });
    return true;
  }

  ctx.log(
    `mcp removal ${value.requestId} outcome ${textForLog(value.outcome)}; ${value.removedToolCount} tool(s) withdrawn${value.toolsTruncated ? ` (first ${MAX_REMOVED_TOOLS} named)` : ''}`
  );
  emitRemovalFrame(ctx, {
    status: 'result',
    requestId: value.requestId,
    name: value.name,
    outcome: value.outcome,
    removedTools: value.removedTools,
    removedToolCount: value.removedToolCount,
    toolsTruncated: value.toolsTruncated,
  });
  return true;
}

/**
 * The capability - inert until something registers it (see the file header).
 *
 * It claims the three REPLY types and nothing else. The two commands are sent
 * through {@link sendGetRuntimeDiagnostics} / {@link sendRemoveMcpServer} by
 * whatever presses the button; a handler cannot originate a round-trip because
 * it only runs when an event arrives.
 */
export const runtimeDiagnosticsCapability: CapabilityHandler = {
  name: RUNTIME_DIAGNOSTICS_HANDLER_NAME,
  handles: ['runtime_diagnostics_snapshot', 'runtime_diagnostics_unavailable', 'mcp_removal_result'],

  handle(event, ctx) {
    if (event.type === 'runtime_diagnostics_snapshot') return handleSnapshot(event, ctx);
    if (event.type === 'runtime_diagnostics_unavailable') return handleUnavailable(event, ctx);
    if (event.type === 'mcp_removal_result') return handleRemoval(event, ctx);
    // Unreachable through the dispatcher, which routes on `handles`. Kept as a
    // fail-closed arm rather than an assumption about the caller: an event this
    // module never claimed must not be decoded as one it did.
    return false;
  },
};
