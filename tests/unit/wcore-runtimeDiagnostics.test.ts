/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's two request/response verbs, driven through the real fixtures.
 *
 * WHAT IS BEING PROVEN. `get_runtime_diagnostics` and `remove_mcp_server` are
 * Darhai's first CORRELATED commands: the manifest gives all five types
 * `criticality: "safety"` and `correlation: "request_id"`, so the host must
 * mint an id, send, and match the reply back to the request it answers. Three
 * things can go wrong and each has its own case below: a reply applied to the
 * wrong request, a command sent to an engine that will never answer it, and a
 * reply this build cannot read leaving the caller waiting for ever.
 *
 * EVERY VERDICT IS ARGUED FROM EVIDENCE, never from a file name: the manifest's
 * grading, the JSON Schema branch (`additionalProperties` differs between the
 * two diagnostics replies, and that difference is load-bearing), or the shape
 * of the fixture. Where the contract is silent - `outcome` has no enum, no
 * negative reply exists for the lifecycle verb - the test says so and pins the
 * host's choice rather than pretending the contract settled it.
 *
 * ROUTING goes through `createDispatcher`, the same function production builds
 * its dispatcher from, over a handler list this file supplies. It has to supply
 * one: this capability is not in `HANDLERS` yet, so `dispatchCapabilityEvent`
 * would not route to it. What these tests prove is the decoders, the ledger and
 * the handler; that the capability is reached in the running app is a
 * registration step outside this file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import { gradeOf, negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { NegotiatedContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import {
  buildGetRuntimeDiagnostics,
  buildRemoveMcpServer,
  decodeMcpRemovalResult,
  decodeRuntimeDiagnosticsSnapshot,
  DIAGNOSTICS_VERSION,
  MAX_CONFIG_SOURCES,
  MAX_ENGINE_NAME_LENGTH,
  MAX_ENGINE_PATH_LENGTH,
  MAX_FAULT_DETAIL_LENGTH,
  MAX_LOGGED_UNREADABLE_REASONS,
  MAX_MCP_SERVERS,
  MAX_PENDING_RUNTIME_REQUESTS,
  MAX_REMEDIATION_HINTS,
  MAX_REMOVED_TOOLS,
  MAX_UNSUPPORTED_OVERRIDES,
  mintDiagnosticsRequestId,
  mintMcpRemovalRequestId,
  pendingRuntimeRequestIds,
  resetRuntimeRequests,
  runtimeDiagnosticsCapability,
  RUNTIME_DIAGNOSTICS_CAPABILITY,
  RUNTIME_DIAGNOSTICS_SUBCONTRACT_VERSION,
  RUNTIME_MCP_LIFECYCLE_CAPABILITY,
  sendGetRuntimeDiagnostics,
  sendRemoveMcpServer,
} from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import type {
  McpRemovalFrameData,
  RuntimeDiagnosticsFrameData,
  RuntimeRequestDeps,
} from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import {
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  readManifest,
  surfaceOf,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

const MODULE_SRC = readFileSync(
  join(process.cwd(), 'src/process/agent/wcore/capabilities/handlers/runtimeDiagnostics.ts'),
  'utf-8'
);

/** The request_ids the contract's own fixtures use. Correlation keys, verbatim. */
const SNAPSHOT_ID = 'runtime-diagnostics-001';
const UNAVAILABLE_ID = 'runtime-diagnostics-unsupported';
const REMOVAL_ID = 'mcp-remove-001';
const REMOVAL_NAME = 'desktop-tools';

type Recorder = CapabilityContext & {
  commands: unknown[];
  frames: { type: string; data: unknown; msg_id: string }[];
  logs: string[];
  warns: string[];
  /** Message AND detail of every log/warn, for the redaction check. */
  transcript: string[];
};

function makeContext(options: { throwOnSend?: boolean } = {}): Recorder {
  const commands: unknown[] = [];
  const frames: Recorder['frames'] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const transcript: string[] = [];
  const record = (message: string, detail?: unknown): void => {
    transcript.push(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
  };
  return {
    commands,
    frames,
    logs,
    warns,
    transcript,
    sendCommand: (command) => {
      if (options.throwOnSend) throw new Error('ERR_STREAM_DESTROYED');
      commands.push(command);
    },
    emit: (frame) => frames.push(frame),
    activeMsgId: () => 'msg-1',
    log: (message, detail) => {
      logs.push(message);
      record(message, detail);
    },
    warn: (message, detail) => {
      warns.push(message);
      record(message, detail);
    },
  };
}

/**
 * The grades the engine's OWN `ready` fixture publishes.
 *
 * Not hand-built: `events/ready.json` carries
 * `contract.capabilities.runtime_diagnostics_v1: "available"` and the same for
 * `runtime_mcp_lifecycle_v1`, so the open path of the gate is proven against
 * the contract rather than against a convenient stub.
 */
const AVAILABLE: NegotiatedContract = negotiateContract(examplePayload('event', 'ready'));

/** An engine that published no contract at all - `compat/events/ready.minimal.json`. */
const NO_GRADES: NegotiatedContract = negotiateContract(readFixture('compat/events/ready.minimal.json')[0]);

function deps(
  contract: NegotiatedContract = AVAILABLE,
  canReachEngine: () => boolean = () => true
): RuntimeRequestDeps {
  return { contract, canReachEngine };
}

const dispatch = createDispatcher([runtimeDiagnosticsCapability]);

/** Register a pending diagnostics request under the fixture's own id. */
function armDiagnostics(ctx: Recorder, requestId: string = SNAPSHOT_ID): void {
  expect(sendGetRuntimeDiagnostics(ctx, requestId, deps()).ok, 'arming the request must succeed').toBe(true);
}

/** Register a pending removal under the fixture's own id and name. */
function armRemoval(ctx: Recorder, requestId: string = REMOVAL_ID, name: string = REMOVAL_NAME): void {
  expect(sendRemoveMcpServer(ctx, { requestId, name }, deps()).ok, 'arming the removal must succeed').toBe(true);
}

function snapshotFixture(): Record<string, unknown> {
  return examplePayload('event', 'runtime_diagnostics_snapshot');
}

/** The fixture's `snapshot` body, deep-copied so a patch cannot leak between tests. */
function snapshotBody(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshotFixture().snapshot)) as Record<string, unknown>;
}

function firstServer(): Record<string, unknown> {
  return (snapshotBody().mcp_servers as Record<string, unknown>[])[0];
}

/** Rebuild the snapshot event around a patched body. */
function snapshotWith(body: Record<string, unknown>): Record<string, unknown> {
  return { ...snapshotFixture(), snapshot: body };
}

/** The bytes this capability hands to the IPC boundary for one event. */
function frameBytes(ctx: Recorder): number {
  return JSON.stringify(ctx.frames).length;
}

/**
 * An unpaired UTF-16 surrogate, by code unit.
 *
 * `JSON.stringify` turns one into a `\udXXX` escape that a strict reader
 * (serde_json, which the engine uses) rejects, so the module refuses to emit
 * one - and must not manufacture one while clipping either.
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

type SnapshotFrame = Extract<RuntimeDiagnosticsFrameData, { status: 'snapshot' }>;
type UnavailableFrame = Extract<RuntimeDiagnosticsFrameData, { status: 'unavailable' }>;
type UndecodableFrame = Extract<RuntimeDiagnosticsFrameData, { status: 'undecodable' }>;
type RemovalFrame = Extract<McpRemovalFrameData, { status: 'result' }>;
type MismatchFrame = Extract<McpRemovalFrameData, { status: 'name_mismatch' }>;

beforeEach(() => {
  // The ledger is module state, exactly as it is in production. Clearing it
  // between cases is what a fresh engine process does.
  resetRuntimeRequests();
});

describe('the contract surface this capability owns', () => {
  /**
   * One handler spans TWO manifest capabilities, so the claim has to be checked
   * against both. Anything the manifest files under them and this handler does
   * not claim would fall through to the acknowledged-inert list and be dropped
   * in silence - the failure this whole layer exists to remove.
   */
  it('claims every reply the manifest files under both capabilities, and nothing else', () => {
    const diagnostics = surfaceOf(RUNTIME_DIAGNOSTICS_CAPABILITY);
    expect(diagnostics.events.map((e) => e.type).toSorted()).toEqual([
      'runtime_diagnostics_snapshot',
      'runtime_diagnostics_unavailable',
    ]);
    expect(diagnostics.commands.map((c) => c.type)).toEqual(['get_runtime_diagnostics']);

    const lifecycle = surfaceOf(RUNTIME_MCP_LIFECYCLE_CAPABILITY);
    expect(lifecycle.events.map((e) => e.type)).toEqual(['mcp_removal_result']);
    expect(lifecycle.commands.map((c) => c.type)).toEqual(['remove_mcp_server']);

    // Commands are sent, not handled: a handler only runs when an event
    // arrives, so it claims the three replies and none of the two verbs.
    expect([...runtimeDiagnosticsCapability.handles].toSorted()).toEqual([
      'mcp_removal_result',
      'runtime_diagnostics_snapshot',
      'runtime_diagnostics_unavailable',
    ]);
  });

  /**
   * The two manifest fields every rule in the module is argued from. If an
   * engine bump downgrades `criticality` or moves `correlation` off
   * `request_id`, the justification for dropping an unmatched reply and for
   * refusing an unknown field evaporates and both must be re-derived.
   */
  it.each([
    ['event', 'runtime_diagnostics_snapshot'],
    ['event', 'runtime_diagnostics_unavailable'],
    ['event', 'mcp_removal_result'],
    ['command', 'get_runtime_diagnostics'],
    ['command', 'remove_mcp_server'],
  ] as const)('%s %s is still safety-class and still correlated on request_id', (kind, type) => {
    const entry = entryFor(kind, type);
    expect(entry?.criticality).toBe('safety');
    expect(entry?.correlation).toBe('request_id');
  });

  it('tracks the subcontract version the manifest publishes', () => {
    expect(readManifest().subcontracts.runtime_diagnostics).toBe(RUNTIME_DIAGNOSTICS_SUBCONTRACT_VERSION);
  });
});

describe('the commands Darhai writes', () => {
  /**
   * Field-for-field against the contract's own example, using the fixture's own
   * request_id. Byte-equality with the published example is a stronger claim
   * than schema validity: `additionalProperties: false` means a stray key
   * invalidates the message, and `diagnostics_version` is `const: 1`.
   */
  it('reproduces the get_runtime_diagnostics example exactly', () => {
    const built = buildGetRuntimeDiagnostics(SNAPSHOT_ID);
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(built.command).toEqual(examplePayload('command', 'get_runtime_diagnostics'));
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it('reproduces the remove_mcp_server example exactly', () => {
    const built = buildRemoveMcpServer({ requestId: REMOVAL_ID, name: REMOVAL_NAME });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(built.command).toEqual(examplePayload('command', 'remove_mcp_server'));
    expect(validateCommand(built.command).valid).toBe(true);
  });

  /** What actually reaches the transport is what matters, not what a builder returned. */
  it('writes a schema-valid command to the transport for both verbs', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);
    armRemoval(ctx);

    expect(ctx.commands).toHaveLength(2);
    for (const command of ctx.commands) {
      expect(validateCommand(command).valid, JSON.stringify(command)).toBe(true);
    }
    expect(ctx.commands[0]).toEqual(examplePayload('command', 'get_runtime_diagnostics'));
    expect(ctx.commands[1]).toEqual(examplePayload('command', 'remove_mcp_server'));
  });

  /**
   * COUNTER-CHECK for the assertions above. A validator that accepted anything
   * would make every `validateCommand(...).valid === true` meaningless, so each
   * mutation of a command this module really emits is shown to be REJECTED.
   */
  it.each([
    ['request_id dropped', (c: Record<string, unknown>) => delete c.request_id],
    ['a stray field added', (c: Record<string, unknown>) => (c.future_authority = true)],
    ['diagnostics_version bumped to 2', (c: Record<string, unknown>) => (c.diagnostics_version = 2)],
    ['request_id emptied', (c: Record<string, unknown>) => (c.request_id = '')],
  ])('the schema rejects get_runtime_diagnostics with %s', (_label, mutate) => {
    const command = examplePayload('command', 'get_runtime_diagnostics');
    expect(validateCommand(command).valid, 'the unmutated example must be valid').toBe(true);
    mutate(command);
    expect(validateCommand(command).valid).toBe(false);
  });

  it.each([
    ['name dropped', (c: Record<string, unknown>) => delete c.name],
    ['name emptied', (c: Record<string, unknown>) => (c.name = '')],
    ['lifecycle_version out of range', (c: Record<string, unknown>) => (c.lifecycle_version = 70000)],
    ['a stray field added', (c: Record<string, unknown>) => (c.force = true)],
  ])('the schema rejects remove_mcp_server with %s', (_label, mutate) => {
    const command = examplePayload('command', 'remove_mcp_server');
    expect(validateCommand(command).valid, 'the unmutated example must be valid').toBe(true);
    mutate(command);
    expect(validateCommand(command).valid).toBe(false);
  });

  /**
   * The generic adversarial command corpus.
   *
   * HONEST SCOPE: not one of these fixtures names either verb (only
   * `continue_with_budget` has verb-specific vectors), so they cannot prove
   * anything about how the ENGINE treats a bad runtime command. What they prove
   * is that the validator guarding Darhai's emitters actually discriminates -
   * every one is rejected - and that neither builder can produce a shape from
   * this family.
   */
  it('rejects every generic adversarial command, and emits none of those shapes', () => {
    const generic = adversarialFixtures('commands').filter((p) => !p.includes('continue-with-budget'));
    expect(generic.toSorted()).toEqual([
      'adversarial/commands/invalid-json.jsonl',
      'adversarial/commands/missing-type.jsonl',
      'adversarial/commands/non-object.jsonl',
      'adversarial/commands/non-string-type.jsonl',
      'adversarial/commands/unknown-type.jsonl',
      'adversarial/commands/wrong-required-field.jsonl',
    ]);

    // `invalid-json.jsonl` is `{not-json}` - it never becomes a value at all,
    // so the helper throws rather than yielding something to validate.
    expect(() => readFixture('adversarial/commands/invalid-json.jsonl')).toThrow(/not valid JSON/);

    for (const rel of generic.filter((p) => !p.endsWith('invalid-json.jsonl'))) {
      const payload = readFixture(rel)[0];
      expect(validateCommand(payload).valid, `${rel} must be rejected`).toBe(false);
    }

    // Neither builder can reach a type outside its own; both are literals.
    const diagnostics = buildGetRuntimeDiagnostics(SNAPSHOT_ID);
    const removal = buildRemoveMcpServer({ requestId: REMOVAL_ID, name: REMOVAL_NAME });
    expect(diagnostics.ok && diagnostics.command.type).toBe('get_runtime_diagnostics');
    expect(removal.ok && removal.command.type).toBe('remove_mcp_server');
  });

  it('mints request_ids inside the schema’s length caps and its own pattern', () => {
    for (const id of [mintDiagnosticsRequestId(), mintMcpRemovalRequestId()]) {
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(128);
      expect(buildGetRuntimeDiagnostics(id).ok, id).toBe(true);
    }
    // Distinct per call: a stable derived id risks colliding with a request the
    // engine still remembers.
    expect(mintDiagnosticsRequestId()).not.toBe(mintDiagnosticsRequestId());
  });
});

/**
 * The gate. A command sent to a build that graded the capability `shape_only`
 * is answered by nothing at all, and a host cannot tell that apart from a slow
 * engine - it would sit on a spinner until its own timeout with no way to say
 * "this engine does not have the feature".
 */
describe('sending is gated on the engine’s own capability grades', () => {
  it('sends when the engine’s ready fixture grades both capabilities available', () => {
    expect(gradeOf(AVAILABLE, RUNTIME_DIAGNOSTICS_CAPABILITY)).toBe('available');
    expect(gradeOf(AVAILABLE, RUNTIME_MCP_LIFECYCLE_CAPABILITY)).toBe('available');

    const ctx = makeContext();
    expect(sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps()).ok).toBe(true);
    expect(sendRemoveMcpServer(ctx, { requestId: REMOVAL_ID, name: REMOVAL_NAME }, deps()).ok).toBe(true);
    expect(ctx.commands).toHaveLength(2);
  });

  /**
   * `ready.minimal.json` publishes no `contract` block at all, which is what an
   * older engine looks like. Every grade is then `unavailable` and both verbs
   * must refuse - the fail-closed direction, since a command such an engine
   * never answers is indistinguishable from a hang.
   */
  it('refuses when the engine published no contract at all', () => {
    const ctx = makeContext();
    const outcome = sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps(NO_GRADES));

    expect(outcome.ok).toBe(false);
    if (outcome.ok === true) return;
    expect(outcome.reason).toContain('unavailable');
    expect(ctx.commands).toEqual([]);
    // Nothing pending: a refused send must leave the ledger as it found it, or
    // the user can never retry under a fresh id.
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /**
   * `shape_only` is a real grade this very engine emits (`browser_events` in
   * the ready fixture), which is why it is worth distinguishing from
   * `unavailable` in the refusal text rather than collapsing both to "no".
   */
  it('refuses a shape_only grade and names it', () => {
    expect(gradeOf(AVAILABLE, 'browser_events')).toBe('shape_only');

    const shapeOnly: NegotiatedContract = {
      engineVersion: AVAILABLE.engineVersion,
      grades: new Map([
        [RUNTIME_DIAGNOSTICS_CAPABILITY, 'shape_only'],
        [RUNTIME_MCP_LIFECYCLE_CAPABILITY, 'shape_only'],
      ]),
    };

    const ctx = makeContext();
    const diagnostics = sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps(shapeOnly));
    const removal = sendRemoveMcpServer(ctx, { requestId: REMOVAL_ID, name: REMOVAL_NAME }, deps(shapeOnly));

    expect(diagnostics.ok).toBe(false);
    expect(removal.ok).toBe(false);
    if (diagnostics.ok === false) expect(diagnostics.reason).toContain('shape_only');
    if (removal.ok === false) expect(removal.reason).toContain('shape_only');
    expect(ctx.commands).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /** Each verb is gated on its OWN manifest id, not on one shared flag. */
  it('gates the two verbs independently', () => {
    const diagnosticsOnly: NegotiatedContract = {
      engineVersion: AVAILABLE.engineVersion,
      grades: new Map([[RUNTIME_DIAGNOSTICS_CAPABILITY, 'available']]),
    };

    const ctx = makeContext();
    expect(sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps(diagnosticsOnly)).ok).toBe(true);
    expect(sendRemoveMcpServer(ctx, { requestId: REMOVAL_ID, name: REMOVAL_NAME }, deps(diagnosticsOnly)).ok).toBe(
      false
    );
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID]);
  });
});

describe('replies are matched to the request they answer', () => {
  /**
   * The snapshot fixture, whole, through the real dispatcher. The nested
   * assertions matter: `remediation` is what the UI turns into "install the
   * executable", and it sits three levels down - a decoder that dropped it
   * would still produce a plausible-looking frame.
   */
  it('settles the diagnostics request and carries the whole snapshot', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    expect(dispatch(snapshotFixture(), ctx)).toBe(true);
    expect(pendingRuntimeRequestIds()).toEqual([]);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].type).toBe('runtime_diagnostics_snapshot');

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.status).toBe('snapshot');
    expect(data.requestId).toBe(SNAPSHOT_ID);
    expect(data.unreadable).toEqual([]);
    expect(data.snapshot.process).toEqual({
      profile_binding: 'bound_profile',
      engine_mode: 'standard',
      workspace_kind: 'temporary',
      profile_name: 'desktop',
    });
    expect(data.snapshot.config_sources).toEqual([
      {
        role: 'global',
        disposition: 'loaded',
        precedence: 10,
        content_digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        display_path: '$CONFIG/wayland-core/config.toml',
      },
    ]);
    expect(data.snapshot.unsupported_overrides).toEqual([{ name: 'WAYLAND_CONFIG_PATH', disposition: 'ignored' }]);

    const server = data.snapshot.mcp_servers[0];
    expect(server.name).toBe('desktop-tools');
    expect(server.remediation).toEqual(['open_active_config']);
    expect(server.executable_readiness).toBe('resolved');
    expect(server.exposure).toBe('exposed');
    expect(server.tool_count).toBe(2);
    expect(server.executable_basename).toBe('desktop-mcp');
    expect(ctx.warns).toEqual([]);
  });

  /**
   * The unavailable fixture must SETTLE its request, not reject it: the engine
   * answered the question it was asked. Note the fixture asks about version 2
   * while `get_runtime_diagnostics.diagnostics_version` is `const: 1` - a
   * schema-conformant host can never provoke this branch, so a fixture-level
   * test is the only proof available.
   */
  it('settles the request with the unavailable reply rather than treating it as a fault', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    expect(dispatch(examplePayload('event', 'runtime_diagnostics_unavailable'), ctx)).toBe(true);
    expect(pendingRuntimeRequestIds()).toEqual([]);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0].type).toBe('runtime_diagnostics_unavailable');

    const data = ctx.frames[0].data as UnavailableFrame;
    expect(data).toEqual({
      status: 'unavailable',
      requestId: UNAVAILABLE_ID,
      // The fixture ANSWERS about version 2 while this host can only ask for 1
      // (`get_runtime_diagnostics.diagnostics_version` is `const: 1`), so the
      // two halves are different numbers and the frame says which is which.
      requestedVersion: DIAGNOSTICS_VERSION,
      echoedVersion: 2,
      echoMismatch: true,
      supportedVersion: 1,
      reason: 'unsupported_version',
    });
    // The refusal itself is not a host fault, but the echo disagreeing with
    // what went out is an engine fault and is named as one.
    expect(ctx.warns.join(' ')).toContain('echoes diagnostics_version 2');
  });

  it('settles the removal and names the tools that disappeared', () => {
    const ctx = makeContext();
    armRemoval(ctx);

    expect(dispatch(examplePayload('event', 'mcp_removal_result'), ctx)).toBe(true);
    expect(pendingRuntimeRequestIds()).toEqual([]);

    const data = ctx.frames[0].data as RemovalFrame;
    expect(data.status).toBe('result');
    expect(data.requestId).toBe(REMOVAL_ID);
    expect(data.name).toBe(REMOVAL_NAME);
    expect(data.removedTools).toEqual(['fetch', 'search']);
    expect(data.removedToolCount).toBe(2);
    expect(data.toolsTruncated).toBe(false);
  });

  /**
   * The rule the task is named for: a reply whose request_id was never sent is
   * DROPPED. `request_id` is the declared correlation key, so applying it to a
   * neighbour would answer one question with another question's answer - and an
   * engine restart or a replayed line makes this a real path, not a theory.
   */
  it('drops a reply whose request_id was never sent, without settling anything else', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, 'rd-mine-001');

    expect(dispatch(snapshotFixture(), ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    // The unrelated request is untouched - the whole point.
    expect(pendingRuntimeRequestIds()).toEqual(['rd-mine-001']);
    expect(ctx.warns.join(' ')).toContain('unsolicited');
  });

  /**
   * Both verbs share one id space, so the verb has to be part of the match. A
   * removal reply carrying a diagnostics id would otherwise settle a
   * diagnostics request with a removal payload.
   */
  it('drops a reply that carries the other verb’s request_id', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, REMOVAL_ID);

    expect(dispatch(examplePayload('event', 'mcp_removal_result'), ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([REMOVAL_ID]);
    expect(ctx.warns.join(' ')).toContain('minted for get_runtime_diagnostics');
  });

  it('refuses a second request under an id already awaiting an answer', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    const second = sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps());
    expect(second.ok).toBe(false);
    if (second.ok === false) expect(second.reason).toContain('already awaiting');
    expect(ctx.commands).toHaveLength(1);
  });

  /**
   * `sendCommand` returns void and drops the command in silence on a dead
   * stdin, so the probe is the only thing between a discarded command and a
   * ledger entry that can never be answered.
   */
  it('refuses when the engine cannot be reached, and records nothing', () => {
    const ctx = makeContext();
    const outcome = sendGetRuntimeDiagnostics(
      ctx,
      SNAPSHOT_ID,
      deps(AVAILABLE, () => false)
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toContain('cannot be reached');
    expect(ctx.commands).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /** The probe cannot close the window completely: the stream can die mid-write. */
  it('reports a write that throws as unsent, and records nothing', () => {
    const ctx = makeContext({ throwOnSend: true });
    const outcome = sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps());

    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toContain('ERR_STREAM_DESTROYED');
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  /**
   * The ledger is bounded because the contract publishes NO negative reply for
   * the lifecycle verb: an engine that ignores a `remove_mcp_server` for an
   * unknown name leaves its entry in place for ever. Dropping the oldest keeps
   * the newest press working; refusing new requests would let one silent engine
   * disable the feature for the session.
   */
  it('evicts the oldest request at the cap instead of growing without bound', () => {
    const ctx = makeContext();
    for (let i = 0; i < MAX_PENDING_RUNTIME_REQUESTS; i += 1) {
      expect(sendGetRuntimeDiagnostics(ctx, `rd-${i}`, deps()).ok).toBe(true);
    }
    expect(pendingRuntimeRequestIds()).toHaveLength(MAX_PENDING_RUNTIME_REQUESTS);

    expect(sendGetRuntimeDiagnostics(ctx, 'rd-overflow', deps()).ok).toBe(true);
    const ids = pendingRuntimeRequestIds();
    expect(ids).toHaveLength(MAX_PENDING_RUNTIME_REQUESTS);
    expect(ids).not.toContain('rd-0');
    expect(ids).toContain('rd-overflow');
    // The age is the useful half of the warning: a fast engine and a silent one
    // look identical without it.
    expect(ctx.warns.join(' ')).toMatch(/evicted unanswered get_runtime_diagnostics "rd-0" after \d+ms/);
  });

  it('forgets every pending request on reset, as a new engine process would', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID]);

    resetRuntimeRequests();
    expect(pendingRuntimeRequestIds()).toEqual([]);
    // And the id is reusable afterwards, which is what makes reset the fix for
    // a restarted engine rather than a leak.
    expect(sendGetRuntimeDiagnostics(ctx, SNAPSHOT_ID, deps()).ok).toBe(true);
  });
});

/**
 * Frames only reach the renderer when their type is one the registry claims:
 * `WCoreManager` exempts exactly those from the `if (!data.msg_id) return;`
 * guard. A frame emitted under any other type is dropped in silence, and the
 * capability merely looks unimplemented.
 */
describe('every frame is emitted under a claimed type, with no msg_id', () => {
  it('holds for all four frame shapes this capability can emit', () => {
    const claimed = new Set(runtimeDiagnosticsCapability.handles);

    const cases: (() => Recorder)[] = [
      () => {
        const ctx = makeContext();
        armDiagnostics(ctx);
        dispatch(snapshotFixture(), ctx);
        return ctx;
      },
      () => {
        const ctx = makeContext();
        armDiagnostics(ctx, UNAVAILABLE_ID);
        dispatch(examplePayload('event', 'runtime_diagnostics_unavailable'), ctx);
        return ctx;
      },
      () => {
        const ctx = makeContext();
        armRemoval(ctx);
        dispatch(examplePayload('event', 'mcp_removal_result'), ctx);
        return ctx;
      },
      () => {
        const ctx = makeContext();
        armDiagnostics(ctx);
        dispatch({ ...snapshotFixture(), snapshot: 'nope' }, ctx);
        return ctx;
      },
    ];

    for (const build of cases) {
      resetRuntimeRequests();
      const ctx = build();
      expect(ctx.frames).toHaveLength(1);
      expect(claimed.has(ctx.frames[0].type), `${ctx.frames[0].type} is not claimed`).toBe(true);
      // Session-scoped: diagnostics is Settings-initiated and can fire mid-turn.
      expect(ctx.frames[0].msg_id).toBe('');
    }
  });
});

describe('what the snapshot decoder refuses, and what it survives', () => {
  /**
   * `additionalProperties: false` on this branch plus `criticality: safety`: a
   * key this host does not model may be the half that says which config file
   * actually won. Refusing still SETTLES the caller - the request was answered,
   * just not in a shape this build can read.
   */
  it('refuses an unknown top-level field and settles the caller as undecodable', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    const event = { ...snapshotFixture(), future_authority: true };
    expect(validateEvent(event).valid, 'the schema must reject it too').toBe(false);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.requestId).toBe(SNAPSHOT_ID);
    // The COUNT is the reason (host-authored, log-safe); the engine's own key
    // name rides in `offending`, which only the frame carries.
    expect(data.detail).toContain('1 unknown field(s)');
    expect(data.offending).toBe('future_authority');
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  it('refuses a diagnostics_version the schema pins to 1', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    const event = { ...snapshotFixture(), diagnostics_version: 2 };
    expect(validateEvent(event).valid).toBe(false);
    expect(dispatch(event, ctx)).toBe(true);
    expect((ctx.frames[0].data as UndecodableFrame).status).toBe('undecodable');
  });

  /**
   * A reply with no readable request_id can settle NOTHING: settling the wrong
   * request is worse than settling none. The caller waits for its own timeout,
   * which is the honest outcome when the engine sent something unattributable.
   */
  it('cannot settle anything when the request_id itself is unreadable', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    expect(dispatch({ ...snapshotFixture(), request_id: 42 }, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID]);
    expect(ctx.warns.join(' ')).toContain('no readable request_id');
  });

  /**
   * One row degrades, the rest survive. Refusing the whole snapshot over one
   * new enum member would leave the user with nothing - and the snapshot exists
   * to explain a broken server. Dropping the row silently would be worse still:
   * a configured server missing from the list reads as "not configured".
   */
  it('keeps an unreadable server row as an explicit hole and renders the rest', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = [
      good,
      { ...good, name: 'from-the-future', connection: 'quantum_entangled' },
      { ...good, name: 'second-good' },
    ];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.status).toBe('snapshot');
    expect(data.snapshot.mcp_servers.map((s) => s.name)).toEqual(['desktop-tools', 'second-good']);
    expect(data.unreadable).toHaveLength(1);
    expect(data.unreadable[0].list).toBe('mcp_servers');
    expect(data.unreadable[0].index).toBe(1);
    // The name is salvaged so the UI can still show WHICH server it cannot read.
    expect(data.unreadable[0].name).toBe('from-the-future');
    expect(data.unreadable[0].reason).toContain('connection');
    expect(ctx.warns.join(' ')).toContain('cannot read');
  });

  /**
   * The envelope does NOT degrade. `process` is one object, not a list: an
   * unreadable `engine_mode` means the answer to "how is this engine bound"
   * is unknown, and there is no partial version of that to show.
   */
  it('refuses the whole snapshot when the process binding is unreadable', () => {
    const body = snapshotBody();
    body.process = { ...(body.process as Record<string, unknown>), engine_mode: 'turbo' };

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('engine_mode');
  });

  /**
   * The wire controls this array's length and the schema sets no `maxItems`,
   * while the decode loop runs synchronously inside the readline handler. Over
   * the cap the snapshot is refused rather than truncated: a list rendered as
   * complete when it is not is the silent wrong answer.
   */
  it('refuses a server list past the cap instead of truncating it', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = Array.from({ length: MAX_MCP_SERVERS + 1 }, (_unused, i) => ({ ...good, name: `srv-${i}` }));

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain(`${MAX_MCP_SERVERS + 1} entries`);
  });

  it('accepts a server list exactly at the cap', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = Array.from({ length: MAX_MCP_SERVERS }, (_unused, i) => ({ ...good, name: `srv-${i}` }));

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);
    expect((ctx.frames[0].data as SnapshotFrame).snapshot.mcp_servers).toHaveLength(MAX_MCP_SERVERS);
  });

  it('makes only the offending row unreadable when its remediation list is oversized', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = [
      good,
      { ...good, name: 'noisy', remediation: Array(MAX_REMEDIATION_HINTS + 1).fill('retry_connection') },
    ];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.mcp_servers.map((s) => s.name)).toEqual(['desktop-tools']);
    expect(data.unreadable[0].name).toBe('noisy');
    expect(data.unreadable[0].reason).toContain('remediation');
  });

  /**
   * `content_digest` has a `pattern` in the schema. A digest that does not
   * match cannot be compared against anything, and showing it would invite
   * exactly that comparison.
   */
  it('makes a config source with a malformed digest unreadable', () => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = [{ ...source, content_digest: 'sha256:nope' }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources).toEqual([]);
    expect(data.unreadable[0].list).toBe('config_sources');
    expect(data.unreadable[0].reason).toContain('content_digest');
  });

  it('refuses an unknown field inside a nested entry, as the schema does', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = [{ ...good, future_field: 1 }];
    const event = snapshotWith(body);
    expect(validateEvent(event).valid, 'the schema pins additionalProperties:false on the entry too').toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);
    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hole.reason).toContain('mcp server carries 1 unknown field(s)');
    expect(hole.offending).toBe('future_field');
  });

  /**
   * `precedence` is what orders the whole chain, and the schema bounds it to
   * 0..65535. A value outside that - or one that is not an integer at all -
   * would sort the "which config file is actually in effect" answer wrongly,
   * which is the single question this list exists to answer.
   */
  it.each([
    ['out of range', 70000],
    ['not an integer', 'first'],
    ['fractional', 1.5],
  ])('makes a config source with a precedence %s unreadable', (_label, precedence) => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = [{ ...source, precedence }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources).toEqual([]);
    expect(data.unreadable[0].reason).toContain('precedence');
  });

  /**
   * The `snapshot` object itself is `additionalProperties: false`. A key here
   * is not one row's problem: it is a whole section of the engine's self-report
   * this build has never been told about, so the envelope is refused rather
   * than rendered as if it were complete.
   */
  it('refuses an unknown field inside the snapshot body', () => {
    const body = snapshotBody();
    body.future_section = { anything: true };
    const event = snapshotWith(body);
    expect(validateEvent(event).valid, 'the schema pins additionalProperties:false on the body too').toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('snapshot carries 1 unknown field(s)');
    expect(data.offending).toBe('future_section');
  });

  it('accepts the engine’s own snapshot fixture through the schema as well as the decoder', () => {
    expect(validateEvent(snapshotFixture()).valid).toBe(true);
    const decoded = decodeRuntimeDiagnosticsSnapshot(snapshotFixture());
    expect(decoded.ok).toBe(true);
  });
});

describe('runtime_diagnostics_unavailable', () => {
  /**
   * The schema sets `additionalProperties: TRUE` on this branch and FALSE on
   * the snapshot. Refusing an unmodelled key here would invent a rule the
   * contract explicitly declined to make - and this payload has no body to
   * misread, only a version and a reason.
   */
  it('tolerates an unknown field, because the schema allows one here', () => {
    const event = { ...examplePayload('event', 'runtime_diagnostics_unavailable'), retry_after_ms: 500 };
    expect(validateEvent(event).valid, 'the schema itself accepts it').toBe(true);

    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);
    expect(dispatch(event, ctx)).toBe(true);
    expect((ctx.frames[0].data as UnavailableFrame).status).toBe('unavailable');
  });

  it('refuses a supported_version other than the 1 the schema pins', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    const event = { ...examplePayload('event', 'runtime_diagnostics_unavailable'), supported_version: 2 };
    expect(validateEvent(event).valid).toBe(false);
    expect(dispatch(event, ctx)).toBe(true);
    expect((ctx.frames[0].data as UndecodableFrame).status).toBe('undecodable');
  });

  it('refuses a reason outside the two the schema declares', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    const event = { ...examplePayload('event', 'runtime_diagnostics_unavailable'), reason: 'engine_busy' };
    expect(validateEvent(event).valid).toBe(false);
    expect(dispatch(event, ctx)).toBe(true);
    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('reason');
  });

  /**
   * WHAT THE HOST ASKED vs WHAT THE ENGINE ECHOED are two different claims, and
   * the log makes one of them in Darhai's own voice.
   * `get_runtime_diagnostics.diagnostics_version` is `const: 1`, so this host
   * CANNOT ask for 65535; an echo carrying it is an engine fault. Reporting it
   * as "asked for 65535" would write a confident falsehood about Darhai's own
   * behaviour into a file that gets attached to bug reports.
   */
  it('reports the version this host actually sent, not the engine’s echo of it', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    const event = {
      ...examplePayload('event', 'runtime_diagnostics_unavailable'),
      diagnostics_version: 65535,
      reason: 'invalid_request',
    };
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UnavailableFrame;
    expect(data.requestedVersion).toBe(DIAGNOSTICS_VERSION);
    expect(data.echoedVersion).toBe(65535);
    expect(data.echoMismatch).toBe(true);
    expect(data.reason).toBe('invalid_request');

    // The log says which number is whose, and never attributes 65535 to Darhai.
    const transcript = ctx.transcript.join('\n');
    expect(transcript).toContain('this host asked for 1');
    expect(transcript).not.toContain('asked for 65535');
    expect(transcript).toContain('echoed 65535, which this host never sent');
  });

  /**
   * The comparison is against the LEDGER, so a faithful echo must not be
   * reported as a disagreement - otherwise every unavailable reply would carry
   * a false alarm and the flag would mean nothing.
   */
  it('does not flag an echo that matches what the host sent', () => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    const event = {
      ...examplePayload('event', 'runtime_diagnostics_unavailable'),
      diagnostics_version: DIAGNOSTICS_VERSION,
      reason: 'invalid_request',
    };
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UnavailableFrame;
    expect(data.requestedVersion).toBe(DIAGNOSTICS_VERSION);
    expect(data.echoedVersion).toBe(DIAGNOSTICS_VERSION);
    expect(data.echoMismatch).toBe(false);
    expect(ctx.warns).toEqual([]);
    expect(ctx.transcript.join('\n')).not.toContain('never sent');
  });

  /**
   * The echoed version is decoded, rendered, logged and compared, so its range
   * is not decoration: the schema says `integer 0..65535` and anything else
   * cannot be any of those things. (Mutation-proof for the guard the first
   * review found unexercised.)
   */
  it.each([
    ['over the maximum', 65536],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '1'],
    ['null', null],
  ])('refuses an echoed diagnostics_version that is %s', (_label, diagnostics_version) => {
    const ctx = makeContext();
    armDiagnostics(ctx, UNAVAILABLE_ID);

    const event = { ...examplePayload('event', 'runtime_diagnostics_unavailable'), diagnostics_version };
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('diagnostics_version');
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });
});

describe('mcp_removal_result', () => {
  /**
   * `outcome` has NO enum in `core-event.schema.json` OR in
   * `producer-complete.schema.json` - it is `{"type":"string"}`, and 'removed'
   * is the only value the bundle exhibits. What the engine says for "no such
   * server" or "refused" is unknown, so the string is carried through verbatim
   * and rendered as-is; treating anything else as failure would be a guess with
   * a user-visible consequence.
   */
  it.each(['removed', 'not_found', 'refused', 'partially_removed', ''])(
    'passes outcome "%s" through verbatim',
    (outcome) => {
      const ctx = makeContext();
      armRemoval(ctx);

      const event = { ...examplePayload('event', 'mcp_removal_result'), outcome };
      // The schema accepts every one of these: it really is a free-form string.
      expect(validateEvent(event).valid, `${outcome} must be schema-valid`).toBe(true);
      expect(dispatch(event, ctx)).toBe(true);
      expect((ctx.frames[0].data as RemovalFrame).outcome).toBe(outcome);
    }
  );

  /**
   * The behavioural test above could pass while a literal comparison lurked in
   * a branch no fixture reaches, so the source itself is checked - the same
   * technique `wcore-eventCoverage.test.ts` uses against the decoder source.
   */
  it('contains no comparison against a hardcoded outcome literal', () => {
    for (const forbidden of ["=== 'removed'", "!== 'removed'", '=== "removed"', "outcome === '"]) {
      expect(MODULE_SRC.includes(forbidden), `source compares outcome: ${forbidden}`).toBe(false);
    }
  });

  /**
   * The engine echoes `name`. A mismatch means the reply is about a different
   * server than the user asked to remove, and "2 tools withdrawn from X" would
   * then be a confident wrong statement about an action that cannot be undone
   * from here.
   */
  it('reports a name that disagrees with the request instead of picking a side', () => {
    const ctx = makeContext();
    armRemoval(ctx, REMOVAL_ID, 'the-one-i-asked-for');

    expect(dispatch(examplePayload('event', 'mcp_removal_result'), ctx)).toBe(true);
    const data = ctx.frames[0].data as MismatchFrame;
    expect(data.status).toBe('name_mismatch');
    expect(data.requestedName).toBe('the-one-i-asked-for');
    expect(data.reportedName).toBe(REMOVAL_NAME);
    expect(ctx.warns.join(' ')).toContain('different server');
  });

  /**
   * Truncation rather than refusal, and the asymmetry is deliberate: refusing
   * would leave a spinner running over a removal that already happened. The
   * exact count and an explicit flag travel with the frame so nothing is
   * silently short.
   */
  it('flags a tool list past the cap with the exact count', () => {
    const ctx = makeContext();
    armRemoval(ctx);

    const event = {
      ...examplePayload('event', 'mcp_removal_result'),
      removed_tools: Array.from({ length: MAX_REMOVED_TOOLS + 5 }, (_unused, i) => `tool-${i}`),
    };
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as RemovalFrame;
    expect(data.removedTools).toHaveLength(MAX_REMOVED_TOOLS);
    expect(data.removedToolCount).toBe(MAX_REMOVED_TOOLS + 5);
    expect(data.toolsTruncated).toBe(true);
  });

  it.each([
    ['a non-string tool name', { removed_tools: ['fetch', 7] }],
    ['removed_tools missing', { removed_tools: undefined }],
    ['lifecycle_version out of range', { lifecycle_version: 70000 }],
    ['a non-string outcome', { outcome: 7 }],
    ['an unknown field', { future_flag: true }],
  ])('refuses %s and settles the caller as undecodable', (_label, patch) => {
    const ctx = makeContext();
    armRemoval(ctx);

    const event: Record<string, unknown> = { ...examplePayload('event', 'mcp_removal_result'), ...patch };
    expect(dispatch(event, ctx)).toBe(true);
    const data = ctx.frames[0].data as Extract<McpRemovalFrameData, { status: 'undecodable' }>;
    expect(data.status).toBe('undecodable');
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  it('accepts the engine’s own removal fixture through the schema as well as the decoder', () => {
    expect(validateEvent(examplePayload('event', 'mcp_removal_result')).valid).toBe(true);
    expect(decodeMcpRemovalResult(examplePayload('event', 'mcp_removal_result')).ok).toBe(true);
  });
});

/**
 * `maxLength: 256` counts UTF-16 code units; `x-maxUtf8Bytes: 256` counts
 * BYTES. Darhai's UI is Mongolian Cyrillic, so a two-bytes-per-character server
 * name is a live path, and a host that checks only `.length` sends a
 * schema-invalid command that the engine may answer with nothing at all.
 */
describe('the byte cap on an MCP server name', () => {
  it('refuses 200 Cyrillic characters - 200 code units, 400 bytes', () => {
    const name = 'д'.repeat(200);
    // Both halves of the trap, asserted rather than assumed.
    expect(name.length).toBe(200);
    expect(Buffer.byteLength(name, 'utf8')).toBe(400);
    expect(name.length).toBeLessThanOrEqual(256);

    const built = buildRemoveMcpServer({ requestId: REMOVAL_ID, name });
    expect(built.ok).toBe(false);
    if (built.ok === false) expect(built.reason).toContain('UTF-8 bytes');

    // And nothing reaches the transport.
    const ctx = makeContext();
    expect(sendRemoveMcpServer(ctx, { requestId: REMOVAL_ID, name }, deps()).ok).toBe(false);
    expect(ctx.commands).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([]);
  });

  it('accepts a Cyrillic name exactly at 256 bytes and refuses the next character', () => {
    const at = 'д'.repeat(128);
    expect(Buffer.byteLength(at, 'utf8')).toBe(256);
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name: at }).ok).toBe(true);

    const over = 'д'.repeat(129);
    expect(over.length).toBe(129);
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name: over }).ok).toBe(false);
  });

  it('accepts 256 ASCII characters and refuses 257', () => {
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 'a'.repeat(256) }).ok).toBe(true);
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 'a'.repeat(257) }).ok).toBe(false);
  });

  /**
   * The code-unit cap cannot REFUSE anything the byte cap would let through -
   * in UTF-8 every code unit costs at least one byte - so what it is worth is
   * its message. A 257-character ASCII name reported as a BYTE overrun sends
   * the user hunting for multi-byte characters that are not there. This is the
   * assertion that keeps that line from being decoration.
   */
  it('names the code-unit rule and the byte rule separately, since the schema states both', () => {
    const tooManyCharacters = buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 'a'.repeat(257) });
    expect(tooManyCharacters.ok).toBe(false);
    if (tooManyCharacters.ok === false) {
      expect(tooManyCharacters.reason).toContain('256 characters');
      expect(tooManyCharacters.reason).not.toContain('UTF-8');
    }

    const tooManyBytes = buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 'д'.repeat(200) });
    expect(tooManyBytes.ok).toBe(false);
    if (tooManyBytes.ok === false) expect(tooManyBytes.reason).toContain('UTF-8 bytes');
  });

  it.each([
    ['empty', ''],
    ['a lone high surrogate', 'srv-\ud800'],
    ['a lone low surrogate', 'srv-\udc00'],
  ])('refuses a name that is %s', (_label, name) => {
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name }).ok).toBe(false);
  });

  it('refuses a name that is not a string at all', () => {
    const built = buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 7 as unknown as string });
    expect(built.ok).toBe(false);
  });

  /**
   * The permissive half, and it is a CHOICE the contract left open: control
   * characters are legal per the schema, `JSON.stringify` escapes them so the
   * newline-delimited framing survives, and refusing would mean a server whose
   * name came out of a config file oddly is one the user can never remove -
   * which is the hole this verb exists to close.
   */
  it('accepts a control character in a name, and the command still validates', () => {
    const built = buildRemoveMcpServer({
      requestId: REMOVAL_ID, // Written as an escape, never a raw byte: this file is checked for stray
      // control characters, and a literal 0x01 here would trip that check.
      name: 'srv\u0001odd',
    });
    expect(built.ok).toBe(true);
    if (built.ok === false) return;
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['over the 128 cap for the diagnostics verb', 'a'.repeat(129)],
    ['carrying a space', 'rd 001'],
    ['starting with a separator', '-rd-001'],
    ['not a string', 7 as unknown as string],
  ])('refuses a diagnostics request_id that is %s', (_label, id) => {
    expect(buildGetRuntimeDiagnostics(id).ok).toBe(false);
  });
});

/**
 * The snapshot may carry a real home directory: `display_path`,
 * `profile_name` and `executable_basename` are free-form strings, and the
 * contract's redaction claim lives in prose, not in the schema. Logs are
 * written to disk and shipped in bug reports, so none of the three may appear
 * there - they travel only in the frame, which is the renderer's to show to the
 * user who asked for it.
 */
describe('diagnostics logging discloses counts, never paths', () => {
  it('keeps display_path, profile_name and executable_basename out of the log transcript', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotFixture(), ctx)).toBe(true);

    const transcript = ctx.transcript.join('\n');
    for (const secret of ['$CONFIG/wayland-core/config.toml', 'desktop-mcp', 'profile_name']) {
      expect(transcript, `"${secret}" leaked into the log`).not.toContain(secret);
    }
    // It still says something useful.
    expect(transcript).toContain('1 mcp server(s)');
    expect(transcript).toContain(SNAPSHOT_ID);

    // The frame - not the log - is where the paths belong.
    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources[0].display_path).toBe('$CONFIG/wayland-core/config.toml');
  });

  it('keeps paths out of the warning raised for an unreadable row', () => {
    const body = snapshotBody();
    const good = firstServer();
    body.mcp_servers = [{ ...good, executable_readiness: 'quantum' }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);
    expect(ctx.transcript.join('\n')).not.toContain('desktop-mcp');
  });
});

/**
 * A future safety-graded event must never be mistaken for a reply. These three
 * fixtures are exactly that: unknown types, one of them claiming
 * `critical: true`.
 */
describe('events this capability does not claim', () => {
  it.each([
    'adversarial/events/unknown-critical.jsonl',
    'adversarial/events/unknown-noncritical.jsonl',
    'adversarial/events/unknown-criticality.jsonl',
  ])('%s is not routed here and settles nothing', (rel) => {
    const event = readFixture(rel)[0];
    // Outside the published contract entirely - the schema has no branch for it.
    expect(validateEvent(event).valid).toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    armRemoval(ctx);

    expect(dispatch(event, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID, REMOVAL_ID]);
  });

  /**
   * The dispatcher contains a throwing handler and reports the event unhandled,
   * so a handler that threw would LOOK like a decline. Junk of a claimed type
   * must therefore be shown to be handled deliberately, not swallowed.
   */
  it.each([
    ['a snapshot that is not an object below the type', { type: 'runtime_diagnostics_snapshot' }],
    ['a removal with nothing but a type', { type: 'mcp_removal_result' }],
    ['an unavailable with nothing but a type', { type: 'runtime_diagnostics_unavailable' }],
  ])('does not throw on %s', (_label, event) => {
    const ctx = makeContext();
    expect(() => dispatch(event, ctx)).not.toThrow();
    // No request_id at all, so nothing can be settled and nothing is emitted.
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns.length).toBeGreaterThan(0);
  });
});

/**
 * EVERY PER-FIELD GUARD, EXERCISED.
 *
 * The first review mutated fifteen guards and found ten that no case here
 * touched: each one worked, but nothing stopped a refactor from deleting it in
 * silence. A guard nobody tests is indistinguishable from decoration, and this
 * decoder is `criticality: safety` - so each of the ten is pinned below by the
 * OBSERVABLE consequence of removing it, not by asserting the guard exists.
 *
 * The shape is always the same: patch the engine's own fixture, dispatch it
 * through the real dispatcher, and assert BOTH halves - that the bad row does
 * not enter the frame, and that the hole names the field. Asserting only the
 * reason would still pass if the row were also kept.
 */
describe('the guards on one mcp server row', () => {
  /**
   * `"false"` is a truthy string. `deferred` decides whether a server is
   * expected to be connected at all, so coercion here would make the UI report
   * a connected server as deferred - the module's own comment names this as the
   * reason the guard exists.
   */
  it.each(['deferred', 'resources_declared', 'resources_exposed', 'assistant_scoped'])(
    'refuses a row whose %s is the STRING "false" rather than a boolean',
    (field) => {
      const body = snapshotBody();
      body.mcp_servers = [{ ...firstServer(), [field]: 'false' }];
      const event = snapshotWith(body);
      expect(validateEvent(event).valid, 'the schema rejects it too').toBe(false);

      const ctx = makeContext();
      armDiagnostics(ctx);
      expect(dispatch(event, ctx)).toBe(true);

      const data = ctx.frames[0].data as SnapshotFrame;
      // The row is a HOLE, not a server carrying a truthy "false".
      expect(data.snapshot.mcp_servers).toEqual([]);
      expect(data.unreadable).toHaveLength(1);
      expect(data.unreadable[0].reason).toContain(`${field} must be a boolean`);
    }
  );

  /**
   * `tool_count` is rendered as "N tools" and the schema bounds it to a u32. A
   * negative or fractional count is a number no UI can honestly show, and a
   * string would concatenate rather than add wherever it is summed.
   */
  it.each([
    ['negative', -1],
    ['fractional', 2.5],
    ['a string', '2'],
    ['over the u32 maximum', 4294967296],
    ['null', null],
  ])('refuses a row whose tool_count is %s', (_label, tool_count) => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), tool_count }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.mcp_servers).toEqual([]);
    expect(data.unreadable[0].reason).toContain('tool_count');
  });

  /**
   * `failure` is optional, so the guard sits behind an `undefined` check and a
   * mutation there is invisible unless a case sends a real value. It is what
   * the UI turns into "the executable was missing" - an unmapped member cannot
   * become advice.
   */
  it('refuses a row whose failure is outside the ten the schema declares', () => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), failure: 'meltdown' }];
    const event = snapshotWith(body);
    expect(validateEvent(event).valid).toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.mcp_servers).toEqual([]);
    expect(data.unreadable[0].reason).toContain('failure');
    expect(data.unreadable[0].offending).toBe('meltdown');
  });

  /** And a declared member still travels, so the guard is not simply refusing everything. */
  it('carries a failure the schema declares', () => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), failure: 'launch_failed' }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);
    expect((ctx.frames[0].data as SnapshotFrame).snapshot.mcp_servers[0].failure).toBe('launch_failed');
  });

  /**
   * `executable_basename` is optional and free-form. A non-string here would
   * reach the renderer as an object where a name is expected.
   */
  it('refuses a row whose executable_basename is not a string', () => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), executable_basename: 42 }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.mcp_servers).toEqual([]);
    expect(data.unreadable[0].reason).toContain('executable_basename must be a string');
  });
});

describe('the guards on the other three snapshot sections', () => {
  /**
   * `process` is ONE object, not a list, so an unknown key here is a whole
   * section of the engine's self-report this build has never been told about -
   * the envelope is refused rather than rendered as complete.
   */
  it('refuses the whole snapshot when the process binding carries an unknown field', () => {
    const body = snapshotBody();
    body.process = { ...(body.process as Record<string, unknown>), future_binding: 1 };
    const event = snapshotWith(body);
    expect(validateEvent(event).valid, 'the schema pins additionalProperties:false on process').toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('process carries 1 unknown field(s)');
    expect(data.offending).toBe('future_binding');
  });

  it('refuses the whole snapshot when profile_name is not a string', () => {
    const body = snapshotBody();
    body.process = { ...(body.process as Record<string, unknown>), profile_name: 7 };

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain('profile_name must be a string');
  });

  it('makes a config source with an unknown field unreadable, and keeps the rest', () => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = [source, { ...source, future_role: 'x' }];
    const event = snapshotWith(body);
    expect(validateEvent(event).valid, 'the schema pins additionalProperties:false on the entry').toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources).toHaveLength(1);
    expect(data.unreadable).toHaveLength(1);
    expect(data.unreadable[0].list).toBe('config_sources');
    expect(data.unreadable[0].reason).toContain('config source carries 1 unknown field(s)');
    expect(data.unreadable[0].offending).toBe('future_role');
  });

  it('makes a config source whose display_path is not a string unreadable', () => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = [{ ...source, display_path: 42 }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources).toEqual([]);
    expect(data.unreadable[0].reason).toContain('display_path must be a string');
  });

  it('makes an unsupported override with an unknown field unreadable, and keeps the rest', () => {
    const body = snapshotBody();
    const override = (body.unsupported_overrides as Record<string, unknown>[])[0];
    body.unsupported_overrides = [override, { ...override, future_disposition: true }];
    const event = snapshotWith(body);
    expect(validateEvent(event).valid).toBe(false);

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(event, ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.unsupported_overrides).toHaveLength(1);
    expect(data.unreadable[0].list).toBe('unsupported_overrides');
    expect(data.unreadable[0].reason).toContain('unsupported override carries 1 unknown field(s)');
    expect(data.unreadable[0].offending).toBe('future_disposition');
  });

  /**
   * The two caps the first review found unexercised. Both refuse the WHOLE
   * snapshot rather than truncating, for the reason the third does: a list
   * rendered as complete when it is not is the silent wrong answer this
   * capability exists to remove.
   */
  it('refuses a config-source list one past its cap, and accepts one exactly at it', () => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = Array.from({ length: MAX_CONFIG_SOURCES + 1 }, () => ({ ...source }));

    const over = makeContext();
    armDiagnostics(over);
    expect(dispatch(snapshotWith(body), over)).toBe(true);
    const data = over.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain(`${MAX_CONFIG_SOURCES + 1} entries`);

    resetRuntimeRequests();
    body.config_sources = Array.from({ length: MAX_CONFIG_SOURCES }, () => ({ ...source }));
    const at = makeContext();
    armDiagnostics(at);
    expect(dispatch(snapshotWith(body), at)).toBe(true);
    expect((at.frames[0].data as SnapshotFrame).snapshot.config_sources).toHaveLength(MAX_CONFIG_SOURCES);
  });

  it('refuses an unsupported-override list one past its cap, and accepts one exactly at it', () => {
    const body = snapshotBody();
    const override = (body.unsupported_overrides as Record<string, unknown>[])[0];
    body.unsupported_overrides = Array.from({ length: MAX_UNSUPPORTED_OVERRIDES + 1 }, () => ({ ...override }));

    const over = makeContext();
    armDiagnostics(over);
    expect(dispatch(snapshotWith(body), over)).toBe(true);
    const data = over.frames[0].data as UndecodableFrame;
    expect(data.status).toBe('undecodable');
    expect(data.detail).toContain(`${MAX_UNSUPPORTED_OVERRIDES + 1} entries`);

    resetRuntimeRequests();
    body.unsupported_overrides = Array.from({ length: MAX_UNSUPPORTED_OVERRIDES }, () => ({ ...override }));
    const at = makeContext();
    armDiagnostics(at);
    expect(dispatch(snapshotWith(body), at)).toBe(true);
    expect((at.frames[0].data as SnapshotFrame).snapshot.unsupported_overrides).toHaveLength(MAX_UNSUPPORTED_OVERRIDES);
  });
});

/**
 * SIZE, NOT JUST COUNT.
 *
 * Every cap above bounds how MANY entries the engine may send. None of them
 * bounds how BIG one is, and no string on these five types except
 * `remove_mcp_server.name` has a `maxLength` - so a fully schema-VALID snapshot
 * can be tens of megabytes, structured-cloned to the renderer and summarised
 * into a log file that rotates at 10 MB, destroying the forensic history this
 * capability exists to provide.
 *
 * The property proven here is stronger than "small enough": the emitted frame
 * is the SAME SIZE whether the engine's strings are a thousand characters or a
 * hundred thousand. That is what makes the bound a bound rather than a
 * threshold somebody has to keep re-choosing.
 */
describe('the frame is bounded by this host, not by the engine', () => {
  /** A snapshot at every list cap, each row carrying one `size`-character string. */
  function hostileSnapshot(size: number, mode: 'names' | 'unknown-enums'): Record<string, unknown> {
    const huge = 'x'.repeat(size);
    const body = snapshotBody();
    const good = firstServer();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    const override = (body.unsupported_overrides as Record<string, unknown>[])[0];

    body.mcp_servers = Array.from({ length: MAX_MCP_SERVERS }, (_unused, i) =>
      mode === 'names' ? { ...good, name: `${huge}-${i}` } : { ...good, working_directory: `${huge}-${i}` }
    );
    body.config_sources = Array.from({ length: MAX_CONFIG_SOURCES }, (_unused, i) =>
      mode === 'names' ? { ...source, display_path: `${huge}-${i}` } : { ...source, role: `${huge}-${i}` }
    );
    body.unsupported_overrides = Array.from({ length: MAX_UNSUPPORTED_OVERRIDES }, (_unused, i) =>
      mode === 'names' ? { ...override, name: `${huge}-${i}` } : { ...override, disposition: `${huge}-${i}` }
    );
    return snapshotWith(body);
  }

  /**
   * The reviewer's Case A: 256 servers, each with a 100k-character `name`. The
   * schema accepts every one of them, and before the length bound the emitted
   * frame was 25.7 MB.
   */
  it('does not carry a 25 MB snapshot of oversized names into the frame', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(hostileSnapshot(100_000, 'names'), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    // Every row is a hole naming its length - nothing is silently dropped.
    expect(data.snapshot.mcp_servers).toEqual([]);
    expect(data.unreadable).toHaveLength(MAX_MCP_SERVERS + MAX_CONFIG_SOURCES + MAX_UNSUPPORTED_OVERRIDES);
    expect(data.unreadable[0].reason).toContain('characters, over the');
    expect(frameBytes(ctx)).toBeLessThan(1_000_000);
  });

  /**
   * The reviewer's Case B: every row carrying an unknown enum value, which the
   * decoder echoes back. 576 rows * 100k characters was a 57.7 MB frame AND a
   * 57.6 MB warn detail written to a 10 MB log file.
   */
  it('does not carry a 57 MB snapshot of oversized enum values into the frame or the log', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(hostileSnapshot(100_000, 'unknown-enums'), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.unreadable).toHaveLength(MAX_MCP_SERVERS + MAX_CONFIG_SOURCES + MAX_UNSUPPORTED_OVERRIDES);
    expect(frameBytes(ctx)).toBeLessThan(1_000_000);
    // The log is the tighter budget: it is a rotating file, and this is one line.
    expect(ctx.transcript.join('\n').length).toBeLessThan(16_000);
  });

  /**
   * THE BOUND IS A BOUND. Two runs of the same hostile shape differing only in
   * the engine's chosen string length must produce byte-identical frames: every
   * echo is clipped to the same width and every carried string is refused by
   * the same rule, so the engine cannot move the number at all.
   */
  it.each(['names', 'unknown-enums'] as const)('emits the same frame at 1k and at 100k characters (%s)', (mode) => {
    const small = makeContext();
    armDiagnostics(small);
    dispatch(hostileSnapshot(1_000, mode), small);

    resetRuntimeRequests();
    const large = makeContext();
    armDiagnostics(large);
    dispatch(hostileSnapshot(100_000, mode), large);

    // Not "similar": identical apart from the DIGITS of the lengths each
    // refusal quotes - 1000 against 100000 is two characters wider, in the
    // reason and again in the clipped echo, on each of the 576 rows.
    const rows = MAX_MCP_SERVERS + MAX_CONFIG_SOURCES + MAX_UNSUPPORTED_OVERRIDES;
    expect(frameBytes(large) - frameBytes(small)).toBeLessThanOrEqual(rows * 4);
    expect(frameBytes(large)).toBeLessThan(1_000_000);
  });

  it('clips an echoed value and states its true length', () => {
    const body = snapshotBody();
    const value = 'q'.repeat(5_000);
    body.mcp_servers = [{ ...firstServer(), connection: value }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hole.offending?.length).toBeLessThan(MAX_FAULT_DETAIL_LENGTH + 40);
    expect(hole.offending).toContain('(5000 characters)');
    expect(hole.reason).toContain('connection has an unknown value (5000 characters)');
  });

  /**
   * Cutting a UTF-16 string at a fixed index can split a surrogate pair, and a
   * lone surrogate is the exact hazard the send path refuses: `JSON.stringify`
   * emits a `\udXXX` escape that a strict reader (serde_json, which the engine
   * uses) rejects. Clipping must not manufacture one on the way out.
   */
  it('clips without leaving a lone surrogate', () => {
    // The pair straddles the cut: units MAX_FAULT_DETAIL_LENGTH-1 and .._LENGTH.
    const value = `${'a'.repeat(MAX_FAULT_DETAIL_LENGTH - 1)}😀${'b'.repeat(50)}`;
    expect(hasLoneSurrogate(value), 'the input itself is well-formed').toBe(false);
    expect(hasLoneSurrogate(value.slice(0, MAX_FAULT_DETAIL_LENGTH)), 'a naive slice would split it').toBe(true);

    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), connection: value }];
    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hasLoneSurrogate(hole.offending as string)).toBe(false);
  });

  /** The salvaged name is engine-sized too - it is the field that may have failed the bound. */
  it('clips the salvaged name of an unreadable row', () => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), name: 'n'.repeat(50_000), connection: 'quantum' }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hole.name?.length).toBeLessThan(MAX_FAULT_DETAIL_LENGTH + 40);
    expect(hole.name).toContain('(50000 characters)');
  });

  it('names only the first few unknown fields, and counts the rest', () => {
    const body = snapshotBody();
    const noisy: Record<string, unknown> = { ...firstServer() };
    for (let i = 0; i < 200; i += 1) noisy[`future_${i}_${'k'.repeat(500)}`] = 1;
    body.mcp_servers = [noisy];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hole.reason).toContain('carries 200 unknown field(s)');
    expect(hole.offending?.length).toBeLessThan(MAX_FAULT_DETAIL_LENGTH + 40);
  });

  /**
   * The log line is capped independently of the frame: the frame is delivered
   * once to a renderer, the log line is appended to a 10 MB rotating file.
   */
  it('logs at most a fixed number of unreadable reasons, and states the true total', () => {
    const body = snapshotBody();
    const good = firstServer();
    const rows = MAX_LOGGED_UNREADABLE_REASONS + 7;
    body.mcp_servers = Array.from({ length: rows }, (_unused, i) => ({
      ...good,
      name: `srv-${i}`,
      connection: 'quantum_entangled',
    }));

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    // The FRAME keeps every hole.
    expect(data.unreadable).toHaveLength(rows);

    const transcript = ctx.transcript.join('\n');
    expect(transcript).toContain(`carried ${rows} entr(ies) this build cannot read`);
    expect(transcript).toContain(`...and ${rows - MAX_LOGGED_UNREADABLE_REASONS} more`);
    expect(transcript).toContain(`mcp_servers[${MAX_LOGGED_UNREADABLE_REASONS - 1}]`);
    expect(transcript).not.toContain(`mcp_servers[${MAX_LOGGED_UNREADABLE_REASONS}]`);
  });

  /** The same question for the reply that has no per-entry salvage. */
  it('refuses an mcp_removal_result whose outcome or tool name is oversized', () => {
    for (const patch of [
      { outcome: 'o'.repeat(MAX_ENGINE_NAME_LENGTH + 1) },
      { removed_tools: ['fetch', 't'.repeat(MAX_ENGINE_NAME_LENGTH + 1)] },
    ]) {
      resetRuntimeRequests();
      const ctx = makeContext();
      armRemoval(ctx);

      const event = { ...examplePayload('event', 'mcp_removal_result'), ...patch };
      expect(validateEvent(event).valid, 'the schema itself accepts it - no maxLength').toBe(true);
      expect(dispatch(event, ctx)).toBe(true);

      const data = ctx.frames[0].data as Extract<McpRemovalFrameData, { status: 'undecodable' }>;
      expect(data.status).toBe('undecodable');
      expect(data.detail).toContain('over the');
      expect(JSON.stringify(ctx.frames).length).toBeLessThan(2_000);
    }
  });

  it('accepts an outcome and a tool name exactly at the bound', () => {
    const ctx = makeContext();
    armRemoval(ctx);

    const event = {
      ...examplePayload('event', 'mcp_removal_result'),
      outcome: 'o'.repeat(MAX_ENGINE_NAME_LENGTH),
      removed_tools: ['t'.repeat(MAX_ENGINE_NAME_LENGTH)],
    };
    expect(dispatch(event, ctx)).toBe(true);
    expect((ctx.frames[0].data as RemovalFrame).status).toBe('result');
  });

  it.each([
    ['a display_path one over the path bound', 'config_sources', MAX_ENGINE_PATH_LENGTH + 1, false],
    ['a display_path exactly at the path bound', 'config_sources', MAX_ENGINE_PATH_LENGTH, true],
  ] as const)('%s', (_label, _list, length, shouldDecode) => {
    const body = snapshotBody();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    body.config_sources = [{ ...source, display_path: '/'.repeat(length) }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.config_sources).toHaveLength(shouldDecode ? 1 : 0);
    if (!shouldDecode) {
      expect(data.unreadable[0].reason).toContain('display_path is');
      // The refusal names the LENGTH, never the path.
      expect(data.unreadable[0].reason).not.toContain('//');
    }
  });

  it('refuses a server name over the bound the removal verb itself imposes', () => {
    const body = snapshotBody();
    body.mcp_servers = [
      { ...firstServer(), name: 'a'.repeat(MAX_ENGINE_NAME_LENGTH + 1) },
      { ...firstServer(), name: 'b'.repeat(MAX_ENGINE_NAME_LENGTH) },
    ];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const data = ctx.frames[0].data as SnapshotFrame;
    // The one at the bound survives: this is a cap, not a ban on long names.
    expect(data.snapshot.mcp_servers).toHaveLength(1);
    expect(data.unreadable[0].reason).toContain(`name is ${MAX_ENGINE_NAME_LENGTH + 1} characters`);
    // ...and that name could not have been carried by `remove_mcp_server` either.
    expect(buildRemoveMcpServer({ requestId: REMOVAL_ID, name: 'a'.repeat(MAX_ENGINE_NAME_LENGTH + 1) }).ok).toBe(
      false
    );
  });
});

/**
 * REDACTION, BEYOND THE THREE DECLARED FIELDS.
 *
 * The first version of this file checked only that the fixture's own
 * `display_path`, `profile_name` and `executable_basename` stayed out of the
 * log. That cannot catch the wider hole: the decoder used to echo ANY unknown
 * enum value verbatim into a reason, and every reason was logged - so an engine
 * answering `working_directory` with a path (its own enum contains `explicit`,
 * i.e. "a path was configured") put a home directory into a file that gets
 * attached to bug reports.
 */
describe('no engine-chosen string reaches the log', () => {
  const SECRET = '/home/serge/secret-project';

  it('keeps a path the engine sent as an unknown enum value out of the log, and in the frame', () => {
    const body = snapshotBody();
    body.mcp_servers = [{ ...firstServer(), working_directory: SECRET }];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    expect(ctx.transcript.join('\n')).not.toContain(SECRET);
    expect(ctx.transcript.join('\n')).not.toContain('serge');
    // The renderer still gets it - it is the answer the user asked for.
    const hole = (ctx.frames[0].data as SnapshotFrame).unreadable[0];
    expect(hole.offending).toBe(SECRET);
    expect(hole.reason).toContain('working_directory has an unknown value');
  });

  /**
   * A sweep rather than a list: every free-form string in the snapshot carries
   * a distinct sentinel at once, so a future field that starts being logged
   * fails here even if nobody remembers to add a case.
   */
  it('keeps every engine-chosen string in a snapshot out of the log', () => {
    const sentinels = {
      display_path: '/home/serge/SENTINEL-display-path',
      profile_name: '/home/serge/SENTINEL-profile-name',
      basename: '/home/serge/SENTINEL-basename',
      serverName: '/home/serge/SENTINEL-server-name',
      overrideName: '/home/serge/SENTINEL-override-name',
      badEnum: '/home/serge/SENTINEL-bad-enum',
      unknownKey: 'SENTINEL_unknown_key',
    };

    const body = snapshotBody();
    const good = firstServer();
    const source = (body.config_sources as Record<string, unknown>[])[0];
    const override = (body.unsupported_overrides as Record<string, unknown>[])[0];

    body.process = { ...(body.process as Record<string, unknown>), profile_name: sentinels.profile_name };
    body.config_sources = [{ ...source, display_path: sentinels.display_path }];
    body.unsupported_overrides = [
      { ...override, name: sentinels.overrideName },
      { ...override, disposition: sentinels.badEnum },
    ];
    body.mcp_servers = [
      { ...good, name: sentinels.serverName, executable_basename: sentinels.basename },
      { ...good, name: sentinels.serverName, [sentinels.unknownKey]: 1 },
      { ...good, name: sentinels.serverName, exposure: sentinels.badEnum },
    ];

    const ctx = makeContext();
    armDiagnostics(ctx);
    expect(dispatch(snapshotWith(body), ctx)).toBe(true);

    const transcript = ctx.transcript.join('\n');
    for (const [field, value] of Object.entries(sentinels)) {
      expect(transcript, `${field} leaked into the log`).not.toContain(value);
    }
    // The log still says something worth having.
    expect(transcript).toContain('3 unreadable entr(ies)');
    expect(transcript).toContain('mcp_servers[1]');

    // And the frame carries what the renderer needs.
    const data = ctx.frames[0].data as SnapshotFrame;
    expect(data.snapshot.mcp_servers[0].executable_basename).toBe(sentinels.basename);
    expect(data.unreadable.map((entry) => entry.offending)).toContain(sentinels.badEnum);
  });

  /**
   * `outcome` is carried verbatim into the FRAME by design - the contract
   * declares no enum, so nothing here may decide what it means - but it is
   * still engine text, and the module tolerates control characters in engine
   * strings. Splicing it into a log LINE would let the engine forge a record.
   */
  it('describes an outcome that is not a plain token instead of quoting it into the log', () => {
    const ctx = makeContext();
    armRemoval(ctx);

    const outcome = '/home/serge/removed\nfatal: disk destroyed';
    const event = { ...examplePayload('event', 'mcp_removal_result'), outcome };
    expect(validateEvent(event).valid, 'the schema accepts any string here').toBe(true);
    expect(dispatch(event, ctx)).toBe(true);

    const transcript = ctx.transcript.join('\n');
    expect(transcript).not.toContain('fatal: disk destroyed');
    expect(transcript).not.toContain('serge');
    expect(transcript).toContain(`a ${outcome.length}-character value`);
    // Verbatim in the frame, which is the contract's own rule for this field.
    expect((ctx.frames[0].data as RemovalFrame).outcome).toBe(outcome);
  });

  it('still quotes a plain outcome, which is the whole story of a removal', () => {
    const ctx = makeContext();
    armRemoval(ctx);
    expect(dispatch({ ...examplePayload('event', 'mcp_removal_result'), outcome: 'not_found' }, ctx)).toBe(true);
    expect(ctx.transcript.join('\n')).toContain('outcome "not_found"');
  });

  /**
   * The ONE declared exception, pinned so it stays deliberate: in a name
   * mismatch the two names ARE the finding, and they go to the logger as
   * structured detail rather than spliced into the message.
   */
  it('passes the two names of a mismatch as detail, not as message text', () => {
    const ctx = makeContext();
    armRemoval(ctx, REMOVAL_ID, 'the-one-i-asked-for');
    expect(dispatch(examplePayload('event', 'mcp_removal_result'), ctx)).toBe(true);

    expect(ctx.warns.join(' ')).not.toContain(REMOVAL_NAME);
    expect(ctx.transcript.join('\n')).toContain(REMOVAL_NAME);
  });
});

/**
 * INBOUND request_ids are the SCHEMA's to rule on, not the host's.
 *
 * `REQUEST_ID_PATTERN` is the rule Darhai mints under. Applying it to a reply
 * reports an engine that reformatted the correlation key as MALFORMED, when the
 * accurate answer is "an id this host never minted" - and that sentence is the
 * entire content of the log line an operator reads when a round-trip does not
 * settle. Neither rule settles such a reply (every ledger key was minted here),
 * so what changes is the diagnosis, which is what the log is for.
 */
describe('an inbound request_id is judged by the schema', () => {
  it('reports a schema-valid id this host never minted as unsolicited, not as malformed', () => {
    const ctx = makeContext();
    armRemoval(ctx);

    const event = { ...examplePayload('event', 'mcp_removal_result'), request_id: 'mcp rm 001' };
    expect(validateEvent(event).valid, 'the schema imposes no pattern, so a space is legal').toBe(true);
    expect(dispatch(event, ctx)).toBe(false);

    const warns = ctx.warns.join(' ');
    expect(warns).toContain('unsolicited');
    expect(warns).not.toContain('no readable request_id');
    // The id itself is not echoed: it is engine text of engine length.
    expect(warns).not.toContain('mcp rm 001');
    expect(warns).toContain("outside this host's minting rule");
    // The request it could not match is untouched, which is the point.
    expect(pendingRuntimeRequestIds()).toEqual([REMOVAL_ID]);
    expect(ctx.frames).toEqual([]);
  });

  /** A line-oriented log file plus an unfiltered id is a forged record. */
  it('never lets an inbound request_id forge a log line', () => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    const event = { ...snapshotFixture(), request_id: 'rd-001\nfatal: engine exploded' };
    expect(validateEvent(event).valid, 'a newline is schema-legal here').toBe(true);
    expect(dispatch(event, ctx)).toBe(false);

    for (const warn of ctx.warns) expect(warn).not.toContain('\n');
    expect(ctx.warns.join(' ')).not.toContain('fatal: engine exploded');
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID]);
  });

  /**
   * The lifecycle verb declares `x-maxUtf8Bytes: 256` NEXT TO `maxLength: 256`,
   * and the two are different rules: 200 Cyrillic characters are 200 code units
   * and 400 bytes. The old inbound path never checked the byte rule at all - it
   * happened to reject such ids for the wrong reason (the host pattern), which
   * is exactly the confusion this separation removes.
   */
  it('refuses an inbound lifecycle request_id over 256 UTF-8 bytes', () => {
    const id = 'д'.repeat(200);
    expect(id.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(id, 'utf8')).toBe(400);

    const ctx = makeContext();
    armRemoval(ctx);
    expect(dispatch({ ...examplePayload('event', 'mcp_removal_result'), request_id: id }, ctx)).toBe(false);

    const warns = ctx.warns.join(' ');
    expect(warns).toContain('no readable request_id');
    expect(warns).toContain('256 UTF-8 bytes, got 400');
    expect(ctx.frames).toEqual([]);
  });

  /** The length rules the schema does state are still enforced, per verb. */
  it.each([
    ['over the diagnostics 128-character cap', 'a'.repeat(129), 'at most 128 characters'],
    ['empty', '', 'must not be empty'],
    ['not a string', 42, 'must be a string'],
  ])('refuses an inbound diagnostics request_id that is %s', (_label, request_id, expected) => {
    const ctx = makeContext();
    armDiagnostics(ctx);

    expect(dispatch({ ...snapshotFixture(), request_id }, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain(expected);
    expect(pendingRuntimeRequestIds()).toEqual([SNAPSHOT_ID]);
  });

  /**
   * The other half: an id the schema allows but the HOST would never mint is
   * still refused on the SEND path, where the rule is ours to impose.
   */
  it('still refuses to MINT an id outside the host pattern', () => {
    expect(buildGetRuntimeDiagnostics('rd 001').ok).toBe(false);
    expect(buildRemoveMcpServer({ requestId: 'mcp rm 001', name: REMOVAL_NAME }).ok).toBe(false);
  });
});
