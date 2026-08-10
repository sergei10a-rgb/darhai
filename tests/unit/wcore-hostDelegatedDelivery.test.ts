/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Host-delegated delivery, failover receipts, and operator tool-effect
 * resolution - driven by the engine's own fixtures.
 *
 * WHAT THESE TESTS ARE FOR. This is the capability where the ENGINE waits on
 * the HOST: `host_send_message_request` blocks a turn until
 * `host_send_message_result` arrives under the same `call_id`. So the property
 * under test is not "the happy path works" but "no input reaches a path that
 * fails to answer" - every scenario below ends in a `host_send_message_result`
 * that passes the contract's own `validateCommand`, or in the single
 * documented case where no answer is constructible at all.
 *
 * Three things shape this file:
 *
 *  1. THE CONTRACT SHIPS NO ADVERSARIAL FIXTURES FOR EITHER OF MY COMMANDS.
 *     Measured: `adversarial/commands/` holds ten `continue-with-budget-*`
 *     files (another capability's) plus six generic malformed frames. The six
 *     generic ones are driven here as inputs to the host's own producers;
 *     everything else adversarial is synthesized from the SCHEMA and said to be
 *     synthesized.
 *  2. VERDICTS ARE JUSTIFIED FROM THE CONTRACT, never from a file name. All
 *     five types are `criticality: "safety"` in `manifest.json`; the
 *     correlation keys (`call_id`, `session_turn_tool_and_cursor`,
 *     `failed_provider_and_selected_provider`) are asserted here and are the
 *     reason the module correlates on exactly those tuples.
 *  3. `adversarial/commands/invalid-json.jsonl` is not valid JSON (`{not-json}`),
 *     so `readFixture` re-throws on it. It is read as raw text on purpose - that
 *     throw IS the assertion that the parse path errors loudly instead of
 *     yielding an empty object a builder would then serialize.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertNoOverlap,
  claimedEventTypes,
  createDispatcher,
  registeredCapabilities,
} from '@process/agent/wcore/capabilities';
import { negotiateContract, NO_CONTRACT } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { NegotiatedContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import type { CapabilityContext, CapabilityHandler } from '@process/agent/wcore/capabilities/types';
import {
  createHostDelegatedDeliveryCapability,
  buildHostSendMessageResult,
  buildResolveUnknownToolEffect,
  decodeHostSendMessageRequest,
  decodeProviderFailoverReceipt,
  decodeUnknownToolEffectResolution,
  hostDelegatedDeliveryCapability,
  DELIVERY_TIMEOUT_MS,
  EVIDENCE_DIGEST_PATTERN,
  FAILOVER_REJECT_REASONS,
  HOST_DELEGATED_DELIVERY_CAPABILITY,
  HOST_DELEGATED_EVENT_TYPES,
  MAX_BODY_LENGTH,
  MAX_DETAIL_VALUE_LENGTH,
  MAX_EVIDENCE_REFERENCE_LENGTH,
  MAX_FAILOVER_CANDIDATES,
  MAX_IN_FLIGHT_SENDS,
  MAX_PLATFORM_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TRACKED_RESOLUTIONS,
  MAX_WIRE_ID_LENGTH,
  OPERATOR_TOOL_EFFECT_CAPABILITY,
  PLATFORM_PLUGIN_TYPES,
  PROVIDER_FAILURE_REASONS,
  TOOL_EFFECT_EVIDENCE_SOURCES,
  UNKNOWN_TOOL_EFFECT_OUTCOMES,
  UNKNOWN_TOOL_EFFECT_RECONCILE_REASON,
  type DeliveryOutcome,
  type DeliveryRequest,
  type HostDelegatedDeliveryCapability,
  type HostDeliveryFrame,
  type MessageDeliverer,
  type ProviderFailoverFrame,
  type ResolveUnknownToolEffectInput,
  type UnknownToolEffectFrame,
} from '@process/agent/wcore/capabilities/handlers/hostDelegatedDelivery';
import { JOURNAL_DIGEST_PATTERN } from '@process/agent/wcore/capabilities/handlers/turnRecovery';
import { ACKNOWLEDGED_UNHANDLED_EVENTS } from '@process/agent/wcore/protocol';
import {
  CONTRACT_V1,
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  readManifest,
  surfaceOf,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

/* ------------------------------- harness -------------------------------- */

type Frame = { type: string; data: unknown; msg_id: string };

type Recorder = CapabilityContext & {
  commands: Record<string, unknown>[];
  frames: Frame[];
  logs: string[];
  warns: string[];
  activeMsg: string;
};

function makeContext(activeMsg = 'msg-1'): Recorder {
  const commands: Record<string, unknown>[] = [];
  const frames: Frame[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const recorder: Recorder = {
    commands,
    frames,
    logs,
    warns,
    activeMsg,
    sendCommand: (c) => commands.push(c as Record<string, unknown>),
    emit: (f) => frames.push(f),
    activeMsgId: () => recorder.activeMsg,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
  return recorder;
}

/**
 * The grades the CONTRACT ITSELF publishes, not a hand-made contract.
 *
 * `manifest.capabilities` is what a v0.12.26 `ready` reports, so the gate is
 * exercised against the real thing; a manifest that ever grades
 * `operator_tool_effect_resolution_v1` differently fails the test below rather
 * than silently disarming every gated test in this file.
 */
const MANIFEST_CONTRACT: NegotiatedContract = negotiateContract({
  version: '0.12.26',
  contract: { capabilities: readManifest().capabilities },
});

function gradedAs(grade: string): NegotiatedContract {
  return negotiateContract({
    version: '0.12.26',
    contract: { capabilities: { [OPERATOR_TOOL_EFFECT_CAPABILITY]: grade } },
  });
}

/** A capability with its own state, its contract source pinned to the manifest. */
function makeCapability(deliverer?: MessageDeliverer | null): HostDelegatedDeliveryCapability {
  const capability = createHostDelegatedDeliveryCapability();
  capability.setContractSource(() => MANIFEST_CONTRACT);
  if (deliverer !== undefined) capability.setMessageDeliverer(deliverer);
  return capability;
}

/** Let promise callbacks run. Real timers only - the timeout tests fake their own. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Object keys sorted recursively, so two encodings of one message compare equal. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

type SchemaBranch = {
  properties?: Record<string, unknown>;
};

function schemaBranch(file: string, type: string): SchemaBranch {
  const schema = JSON.parse(readFileSync(join(CONTRACT_V1, `schema/${file}`), 'utf-8')) as { oneOf: SchemaBranch[] };
  const branch = schema.oneOf.find((arm) => (arm.properties?.type as { const?: string } | undefined)?.const === type);
  expect(branch, `${file} has no branch for ${type}`).toBeDefined();
  return branch as SchemaBranch;
}

const SEND_REQUEST = examplePayload('event', 'host_send_message_request');
const SEND_REQUEST_MINIMAL = readFixture('compat/events/host_send_message_request.minimal.json')[0];
const SEND_RESULT = examplePayload('command', 'host_send_message_result');
const SEND_RESULT_MINIMAL = readFixture('compat/commands/host_send_message_result.minimal.json')[0];
const FAILOVER = examplePayload('event', 'provider_failover_receipt');
const RESOLVED_EVENT = examplePayload('event', 'unknown_tool_effect_resolved');
const RESOLVE_COMMAND = examplePayload('command', 'resolve_unknown_tool_effect');

/** The contract's own resolution example, as this host's builder input. */
function resolveInputFromContract(): ResolveUnknownToolEffectInput {
  const evidence = RESOLVE_COMMAND.evidence as Record<string, unknown>;
  const cursor = RESOLVE_COMMAND.cursor as { journal_digest: string; journal_sequence?: number };
  return {
    sessionId: RESOLVE_COMMAND.session_id as string,
    turnId: RESOLVE_COMMAND.turn_id as string,
    toolExecutionId: RESOLVE_COMMAND.tool_execution_id as string,
    operatorId: RESOLVE_COMMAND.operator_id as string,
    outcome: RESOLVE_COMMAND.outcome as ResolveUnknownToolEffectInput['outcome'],
    cursor: { journal_digest: cursor.journal_digest, journal_sequence: cursor.journal_sequence },
    evidence: {
      source: evidence.source as ResolveUnknownToolEffectInput['evidence']['source'],
      referenceId: evidence.reference_id as string,
      observedAtUnixMs: evidence.observed_at_unix_ms as number,
      digest: evidence.digest as string,
    },
  };
}

/**
 * The refusal text of a decode that must have refused.
 *
 * Asserting on the WORDS, not just on `'error' in parsed`: several guards in
 * this module reach the same "refused" verdict by different routes, and a test
 * that only checked the verdict would keep passing after the guard it was
 * written for stopped running.
 */
function refusalOf<T>(parsed: { value: T } | { error: string }): string {
  expect('error' in parsed, `expected a refusal, got ${JSON.stringify(parsed).slice(0, 120)}`).toBe(true);
  return 'error' in parsed ? parsed.error : '';
}

/** A deliverer that always succeeds, recording what it was asked to do. */
function recordingDeliverer(requests: DeliveryRequest[], outcome: DeliveryOutcome = { ok: true, messageId: 'm-1' }) {
  return (request: DeliveryRequest) => {
    requests.push(request);
    return Promise.resolve(outcome);
  };
}

/* --------------------------- contract grounding -------------------------- */

describe('the contract this capability is built from', () => {
  it('grades all five verbs safety-class, which is why nothing here fails open', () => {
    for (const type of HOST_DELEGATED_EVENT_TYPES) {
      expect(entryFor('event', type)?.criticality, `${type} criticality`).toBe('safety');
    }
    expect(entryFor('command', 'host_send_message_result')?.criticality).toBe('safety');
    expect(entryFor('command', 'resolve_unknown_tool_effect')?.criticality).toBe('safety');
  });

  it('names the correlation keys this module correlates on', () => {
    expect(entryFor('event', 'host_send_message_request')?.correlation).toBe('call_id');
    expect(entryFor('command', 'host_send_message_result')?.correlation).toBe('call_id');
    expect(entryFor('event', 'provider_failover_receipt')?.correlation).toBe('failed_provider_and_selected_provider');
    for (const kind of ['event', 'command'] as const) {
      const type = kind === 'event' ? 'unknown_tool_effect_resolved' : 'resolve_unknown_tool_effect';
      expect(entryFor(kind, type)?.correlation).toBe('session_turn_tool_and_cursor');
    }
  });

  /**
   * The gap the research plan flagged: the manifest files
   * `host_send_message_result` under `capability: "available"` - a capability
   * STATUS, not a capability name. So a "did I cover my whole surface" audit
   * driven by `surfaceOf` under-reports by exactly one command unless it knows
   * that. Pinned here so the audit is not silently wrong.
   */
  it('files host_send_message_result under a status, not under host_delegated_delivery', () => {
    const surface = surfaceOf(HOST_DELEGATED_DELIVERY_CAPABILITY);
    expect(surface.events.map((e) => e.type)).toEqual(['host_send_message_request']);
    expect(surface.commands.map((c) => c.type)).toEqual([]);
    expect(entryFor('command', 'host_send_message_result')?.capability).toBe('available');
  });

  it('grades operator_tool_effect_resolution_v1 available, so the send gate has an open state', () => {
    expect(readManifest().capabilities[OPERATOR_TOOL_EFFECT_CAPABILITY]).toBe('available');
    expect(readManifest().capabilities[HOST_DELEGATED_DELIVERY_CAPABILITY]).toBe('available');
  });

  it('EVIDENCE_DIGEST_PATTERN is the schema evidence pattern verbatim, on both carriers', () => {
    for (const [file, type] of [
      ['core-event.schema.json', 'unknown_tool_effect_resolved'],
      ['host-command.schema.json', 'resolve_unknown_tool_effect'],
    ] as const) {
      const evidence = schemaBranch(file, type).properties?.evidence as {
        properties: { digest: { pattern: string } };
      };
      expect(EVIDENCE_DIGEST_PATTERN.source, `${file} evidence.digest`).toBe(evidence.properties.digest.pattern);
    }
  });

  it('the journal cursor pattern is turn recovery own, and is the schema cursor pattern', () => {
    const cursor = schemaBranch('host-command.schema.json', 'resolve_unknown_tool_effect').properties?.cursor as {
      properties: { journal_digest: { pattern: string } };
    };
    expect(JOURNAL_DIGEST_PATTERN.source).toBe(cursor.properties.journal_digest.pattern);
    // Different shapes on purpose: bare hex on the cursor, `sha256:`-prefixed on
    // the evidence. Mixing them builds a command the engine rejects.
    expect(JOURNAL_DIGEST_PATTERN.source).not.toBe(EVIDENCE_DIGEST_PATTERN.source);
  });

  it('the evidence bounds are the schema bounds', () => {
    const evidence = schemaBranch('host-command.schema.json', 'resolve_unknown_tool_effect').properties?.evidence as {
      properties: {
        reference_id: { minLength: number; maxLength: number };
        observed_at_unix_ms: { minimum: number };
      };
    };
    expect(MAX_EVIDENCE_REFERENCE_LENGTH).toBe(evidence.properties.reference_id.maxLength);
    expect(evidence.properties.reference_id.minLength).toBe(1);
    expect(evidence.properties.observed_at_unix_ms.minimum).toBe(1);
  });

  it('every enum this host models is the schema enum, member for member', () => {
    const receipt = schemaBranch('core-event.schema.json', 'provider_failover_receipt').properties?.receipt as {
      properties: {
        reason: { enum: string[] };
        candidates: {
          items: { properties: { disposition: { oneOf: { properties: { Err?: { enum: string[] } } }[] } } };
        };
      };
    };
    expect([...PROVIDER_FAILURE_REASONS]).toEqual(receipt.properties.reason.enum);
    const errBranch = receipt.properties.candidates.items.properties.disposition.oneOf.find(
      (branch) => branch.properties.Err !== undefined
    );
    expect([...FAILOVER_REJECT_REASONS]).toEqual(errBranch?.properties.Err?.enum);

    const resolved = schemaBranch('core-event.schema.json', 'unknown_tool_effect_resolved').properties as {
      outcome: { enum: string[] };
      evidence: { properties: { source: { enum: string[] } } };
    };
    expect([...UNKNOWN_TOOL_EFFECT_OUTCOMES]).toEqual(resolved.outcome.enum);
    expect([...TOOL_EFFECT_EVIDENCE_SOURCES]).toEqual(resolved.evidence.properties.source.enum);
  });

  it('links to turn recovery reconcile vocabulary rather than restating it', () => {
    // A compile-time link (the constant is typed `WCoreReconcileReason`) plus a
    // runtime one: this is the reason a session sits in `reconciliation_required`
    // that only an operator can settle.
    expect(UNKNOWN_TOOL_EFFECT_RECONCILE_REASON).toBe('tool_outcome_unknown');
  });

  /**
   * The mapping table is this host's construction, so the half that CAN be
   * checked mechanically is checked: every plugin type it names must be a real
   * `BuiltinPluginType`. A typo here would produce a delivery that searches for
   * a plugin that cannot exist.
   */
  it('every mapped plugin type is a real Darhai builtin', () => {
    const source = readFileSync(join(process.cwd(), 'src/process/channels/types.ts'), 'utf-8');
    const start = source.indexOf('export type BuiltinPluginType =');
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf(';', start));
    const builtins = new Set(Array.from(block.matchAll(/'([a-z0-9-]+)'/g), (m) => m[1]));
    expect(builtins.size).toBeGreaterThan(5);
    for (const [platform, types] of Object.entries(PLATFORM_PLUGIN_TYPES)) {
      for (const type of types) {
        expect(builtins.has(type), `${platform} -> ${type} is not a BuiltinPluginType`).toBe(true);
      }
    }
  });

  it('keeps the engine platform vocabulary complete, including the five Darhai cannot serve', () => {
    // Measured from the bundled binary's own `send_message` tool description.
    const engineVocabulary = [
      'telegram',
      'discord',
      'slack',
      'whatsapp',
      'signal',
      'bluebubbles',
      'qqbot',
      'matrix',
      'mattermost',
      'homeassistant',
      'dingtalk',
      'feishu',
      'wecom',
      'wecom_callback',
      'weixin',
      'email',
      'sms',
    ];
    expect(Object.keys(PLATFORM_PLUGIN_TYPES).toSorted()).toEqual(engineVocabulary.toSorted());
    for (const unserved of ['signal', 'bluebubbles', 'qqbot', 'mattermost', 'homeassistant']) {
      expect(PLATFORM_PLUGIN_TYPES[unserved], `${unserved} has no Darhai builtin`).toEqual([]);
    }
    expect(PLATFORM_PLUGIN_TYPES.feishu).toEqual(['lark']);
    expect(PLATFORM_PLUGIN_TYPES.email).toEqual(['email-imap', 'email-agentmail']);
    expect(PLATFORM_PLUGIN_TYPES.sms).toEqual(['sms-twilio']);
    expect(PLATFORM_PLUGIN_TYPES.wecom_callback).toEqual(['wecom']);
  });
});

/* ------------------------------- delivery -------------------------------- */

describe('host_send_message_request: the full fixture', () => {
  it('validates against the published event schema', () => {
    expect(validateEvent(SEND_REQUEST).valid).toBe(true);
    expect(validateEvent(SEND_REQUEST_MINIMAL).valid).toBe(true);
  });

  it('reaches the transport with chat, thread, subject and conversation intact', async () => {
    const requests: DeliveryRequest[] = [];
    const capability = makeCapability(recordingDeliverer(requests));
    const ctx = makeContext();

    expect(capability.handle(SEND_REQUEST, ctx)).toBe(true);
    await flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      callId: 'call-send-001',
      platform: 'email',
      pluginTypes: ['email-imap', 'email-agentmail'],
      body: 'The run completed.',
      chatId: 'operator@example.invalid',
      threadId: 'thread-001',
      subject: 'Wayland update',
      conversationId: 'session-desktop-001',
    });
  });

  it('answers ok:true with the platform message id, echoing call_id byte for byte', async () => {
    const capability = makeCapability(() => Promise.resolve({ ok: true, messageId: 'desktop-message-001' }));
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    await flush();

    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0].call_id).toBe(SEND_REQUEST.call_id);
    expect(validateCommand(ctx.commands[0]).valid).toBe(true);
  });

  /**
   * Byte-level, not "looks similar": the answer this host builds for the
   * contract's own request must be the contract's own answer.
   */
  it('reproduces the contract answer example exactly', async () => {
    const capability = makeCapability(() => Promise.resolve({ ok: true, messageId: 'desktop-message-001' }));
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    await flush();

    expect(digestOf(ctx.commands[0])).toBe(digestOf(SEND_RESULT));
  });

  it('echoes a runtime hsm- prefixed call_id, which is not the fixture format', async () => {
    const capability = makeCapability(() => Promise.resolve({ ok: true }));
    const ctx = makeContext();

    capability.handle({ ...SEND_REQUEST, call_id: 'hsm-17' }, ctx);
    await flush();

    expect(ctx.commands[0].call_id).toBe('hsm-17');
    expect(validateCommand(ctx.commands[0]).valid).toBe(true);
  });

  /**
   * The engine's own tool doc says a bare platform means "use the host's
   * default channel", so a resolver that required `chat_id` would break the
   * most common case. `chatId` must be ABSENT, not an empty string - a
   * deliverer reading `''` as a target would send to nowhere.
   */
  it('delivers the minimal fixture with no chat_id, leaving the target to the host default', async () => {
    const requests: DeliveryRequest[] = [];
    const capability = makeCapability(recordingDeliverer(requests));
    const ctx = makeContext();

    capability.handle(SEND_REQUEST_MINIMAL, ctx);
    await flush();

    expect(requests).toHaveLength(1);
    expect('chatId' in requests[0]).toBe(false);
    expect(requests[0].pluginTypes).toEqual(['slack']);
    expect(ctx.commands[0]).toMatchObject({ call_id: 'call-send-minimal', ok: true });
  });
});

describe('host_send_message_request: every path answers', () => {
  type Case = {
    name: string;
    event?: Record<string, unknown>;
    deliverer?: MessageDeliverer | null;
    /** Extra requests to put in flight first. */
    saturate?: boolean;
    expectOk: boolean;
    expectErrorContains?: string;
  };

  const CASES: Case[] = [
    {
      name: 'the transport succeeds',
      deliverer: () => Promise.resolve({ ok: true, messageId: 'm-9' }),
      expectOk: true,
    },
    {
      name: 'the transport reports a failure',
      deliverer: () => Promise.resolve({ ok: false, error: 'slack: channel_not_found' }),
      expectOk: false,
      expectErrorContains: 'channel_not_found',
    },
    {
      name: 'the transport rejects',
      deliverer: () => Promise.reject(new Error('socket hang up')),
      expectOk: false,
      expectErrorContains: 'socket hang up',
    },
    {
      name: 'the transport throws synchronously',
      deliverer: (() => {
        throw new Error('no plugin manager');
      }) as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'no plugin manager',
    },
    {
      name: 'the transport does not return a promise',
      deliverer: (() => 'sent') as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'did not return a promise',
    },
    {
      name: 'the transport returns a malformed outcome',
      deliverer: (() => Promise.resolve({ ok: 'yes' })) as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'ok=',
    },
    {
      name: 'the transport resolves with something that is not an outcome',
      deliverer: (() => Promise.resolve('sent')) as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'returned string',
    },
    {
      // `typeof [] === 'object'`, so an outcome reader that checked only
      // typeof/null would read an array's absent `ok` as "not true, not false"
      // and blame the value instead of the shape.
      name: 'the transport resolves with an array',
      deliverer: (() => Promise.resolve([])) as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'returned array',
    },
    {
      name: 'the transport reports success with an unusable message id',
      deliverer: (() => Promise.resolve({ ok: true, messageId: 42 })) as unknown as MessageDeliverer,
      expectOk: false,
      expectErrorContains: 'unusable message id',
    },
    {
      name: 'no transport is installed',
      deliverer: null,
      expectOk: false,
      expectErrorContains: 'no delivery transport is installed',
    },
    {
      name: 'the platform is one the engine offers and Darhai cannot serve',
      event: { ...SEND_REQUEST, platform: 'qqbot' },
      expectOk: false,
      expectErrorContains: 'no channel plugin for qqbot',
    },
    {
      name: 'the platform is one this host has never heard of',
      event: { ...SEND_REQUEST, platform: 'nostr' },
      expectOk: false,
      expectErrorContains: 'does not know the platform',
    },
    {
      // An empty platform is a MALFORMED request, not an unknown platform, and
      // the two get different answers: the user can act on "the engine sent no
      // platform" and cannot act on "Darhai does not know ''".
      name: 'the platform is empty',
      event: { ...SEND_REQUEST, platform: '' },
      expectOk: false,
      expectErrorContains: 'platform is not a non-empty string',
    },
    {
      name: 'the transport fails without saying why',
      deliverer: () => Promise.resolve({ ok: false, error: '' } as DeliveryOutcome),
      expectOk: false,
      expectErrorContains: 'the delivery transport failed',
    },
    {
      name: 'body is not a string',
      event: { ...SEND_REQUEST, body: 42 },
      expectOk: false,
      expectErrorContains: 'body must be a string',
    },
    {
      name: 'chat_id is not a string',
      event: { ...SEND_REQUEST, chat_id: 7 },
      expectOk: false,
      expectErrorContains: 'chat_id must be a string',
    },
    {
      name: 'the body is longer than this host will deliver',
      event: { ...SEND_REQUEST, body: 'x'.repeat(MAX_BODY_LENGTH + 1) },
      expectOk: false,
      expectErrorContains: `above the ${MAX_BODY_LENGTH}`,
    },
    {
      name: 'the subject is longer than one RFC 5322 header line',
      event: { ...SEND_REQUEST, subject: 's'.repeat(MAX_SUBJECT_LENGTH + 1) },
      expectOk: false,
      expectErrorContains: `above the ${MAX_SUBJECT_LENGTH}`,
    },
    {
      name: 'the platform name is longer than this host will look up',
      event: { ...SEND_REQUEST, platform: 'p'.repeat(MAX_PLATFORM_LENGTH + 1) },
      expectOk: false,
      expectErrorContains: `above the ${MAX_PLATFORM_LENGTH}`,
    },
    {
      name: 'the in-flight cap is already reached',
      saturate: true,
      deliverer: () => new Promise<DeliveryOutcome>(() => {}),
      expectOk: false,
      expectErrorContains: 'already in flight',
    },
  ];

  for (const testCase of CASES) {
    it(`answers when ${testCase.name}`, async () => {
      const capability = makeCapability(testCase.deliverer);
      const ctx = makeContext();

      if (testCase.saturate) {
        for (let i = 0; i < MAX_IN_FLIGHT_SENDS; i += 1) {
          capability.handle({ ...SEND_REQUEST, call_id: `fill-${i}` }, ctx);
        }
        await flush();
        expect(ctx.commands).toHaveLength(0);
      }

      const handled = capability.handle(testCase.event ?? SEND_REQUEST, ctx);
      await flush();

      expect(handled).toBe(true);
      expect(ctx.commands).toHaveLength(1);
      const answer = ctx.commands[0];
      expect(answer.type).toBe('host_send_message_result');
      expect(answer.call_id).toBe(SEND_REQUEST.call_id);
      expect(answer.ok).toBe(testCase.expectOk);
      expect(validateCommand(answer).valid, JSON.stringify(validateCommand(answer).errors)).toBe(true);
      if (testCase.expectErrorContains !== undefined) {
        expect(String(answer.error)).toContain(testCase.expectErrorContains);
      }
      capability.reset();
    });
  }

  /**
   * THE ONE UNANSWERABLE CASE, and the reason it is allowed to exist: the
   * answer is keyed on `call_id` (manifest `correlation: "call_id"`), so with
   * no usable id there is nothing to answer under. It must be loud and it must
   * not invent one.
   */
  it('refuses to answer a request with no usable call_id, and says so', () => {
    const capability = makeCapability(() => Promise.resolve({ ok: true }));
    const ctx = makeContext();

    for (const bad of [undefined, '', 42, 'x'.repeat(MAX_WIRE_ID_LENGTH + 1)]) {
      const event: Record<string, unknown> = { ...SEND_REQUEST };
      if (bad === undefined) delete event.call_id;
      else event.call_id = bad;
      expect(capability.handle(event, ctx)).toBe(false);
    }
    expect(ctx.commands).toEqual([]);
    expect(ctx.warns).toHaveLength(4);
    expect(ctx.warns[0]).toContain('no usable call_id');
  });

  /**
   * `platform` is wire-controlled and `PLATFORM_PLUGIN_TYPES` is an object
   * literal, so a bare index read answers for every name on `Object.prototype`.
   * MEASURED against this module before the guard: `constructor` resolved to the
   * `Object` constructor - a function, so neither the `undefined` check nor the
   * `.length === 0` check caught it - and the deliverer WAS called with
   * `pluginTypes` set to a function, which a real adapter iterating it turns
   * into "TypeError: req.pluginTypes is not iterable" reported to the user as a
   * failed send. `toString` and `valueOf` (arity 0) took the other wrong branch
   * and answered "Darhai has no channel plugin for toString", the sentence
   * reserved for a platform the ENGINE offers and this host deliberately cannot
   * serve. Both are wrong answers, and the second is a wrong answer that reads
   * as authoritative.
   */
  it('treats every inherited Object.prototype name as a platform it has never heard of', () => {
    const inherited = [
      'constructor',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toString',
      'valueOf',
      '__proto__',
    ];

    for (const platform of inherited) {
      const requests: DeliveryRequest[] = [];
      const capability = makeCapability(recordingDeliverer(requests));
      const ctx = makeContext();
      const event = { ...SEND_REQUEST, platform };

      // The engine is entitled to send it: `platform` is a bare string with no
      // enum, so this is a schema-legal request and not a malformed one.
      expect(validateEvent(event).valid, `${platform} is a schema-legal platform`).toBe(true);
      expect(capability.handle(event, ctx)).toBe(true);

      // No `flush()`, deliberately: a refused platform is answered SYNCHRONOUSLY
      // inside `handle`, and `recordingDeliverer` pushes before it returns its
      // promise - so a transport that was reached would already be visible here.
      expect(requests, `${platform} must never reach the transport`).toEqual([]);
      expect(ctx.commands, platform).toHaveLength(1);
      expect(ctx.commands[0].ok, platform).toBe(false);
      expect(String(ctx.commands[0].error), platform).toContain('does not know the platform');
      expect(validateCommand(ctx.commands[0]).valid, platform).toBe(true);
      const frame = ctx.frames[0].data as HostDeliveryFrame;
      expect(frame.unconfigured, platform).toBe(true);
    }
  });

  it('never delivers one call_id twice, and answers it exactly once', async () => {
    let calls = 0;
    let settle: (outcome: DeliveryOutcome) => void;
    const capability = makeCapability(() => {
      calls += 1;
      return new Promise<DeliveryOutcome>((resolve) => {
        settle = resolve;
      });
    });
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    capability.handle(SEND_REQUEST, ctx);
    await flush();

    expect(calls).toBe(1);
    expect(ctx.commands).toEqual([]);
    expect(capability.inFlightCallIds()).toEqual(['call-send-001']);

    settle({ ok: true, messageId: 'm-1' });
    await flush();
    expect(ctx.commands).toHaveLength(1);
  });

  it('contains a sendCommand that throws instead of losing the turn', async () => {
    const capability = makeCapability(() => Promise.resolve({ ok: true }));
    const ctx = makeContext();
    ctx.sendCommand = () => {
      throw new Error('EPIPE');
    };

    expect(() => capability.handle(SEND_REQUEST, ctx)).not.toThrow();
    await flush();
    expect(ctx.warns.some((w) => w.includes('EPIPE'))).toBe(true);
  });

  it('announces a failure to the renderer and stays quiet on success', async () => {
    const failing = makeCapability(null);
    const failCtx = makeContext();
    failing.handle({ ...SEND_REQUEST, platform: 'slack' }, failCtx);
    await flush();

    expect(failCtx.frames).toHaveLength(1);
    // The frame type must be one the capability CLAIMS, or WCoreManager's
    // pass-through set (built from `claimedEventTypes()`) drops it.
    expect(HOST_DELEGATED_EVENT_TYPES).toContain(failCtx.frames[0].type as (typeof HOST_DELEGATED_EVENT_TYPES)[number]);
    // A delivery belongs to the turn that asked for it, so the frame carries the
    // live msg_id rather than the session-scoped empty one.
    expect(failCtx.frames[0].msg_id).toBe('msg-1');
    const frame = failCtx.frames[0].data as HostDeliveryFrame;
    expect(frame).toMatchObject({
      capability: HOST_DELEGATED_DELIVERY_CAPABILITY,
      callId: 'call-send-001',
      platform: 'slack',
      ok: false,
      unconfigured: true,
      severity: 'warning',
    });

    const working = makeCapability(() => Promise.resolve({ ok: true, messageId: 'm-2' }));
    const okCtx = makeContext();
    working.handle(SEND_REQUEST, okCtx);
    await flush();
    expect(okCtx.frames).toEqual([]);
  });
});

describe('host_send_message_request: the wait is bounded', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers ok:false when the transport never settles, and not one tick early', async () => {
    vi.useFakeTimers();
    const capability = makeCapability(() => new Promise<DeliveryOutcome>(() => {}));
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS - 1);
    expect(ctx.commands).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.commands[0]).toMatchObject({ call_id: 'call-send-001', ok: false });
    expect(String(ctx.commands[0].error)).toContain('NOT confirmed sent');
    expect(validateCommand(ctx.commands[0]).valid).toBe(true);
    expect(capability.inFlightCallIds()).toEqual([]);
  });

  /**
   * A late answer must not become a second `host_send_message_result`. The
   * engine tolerates one (measured: it warns "received for unknown call_id"),
   * but the user was already told the send was unconfirmed and a second,
   * contradicting answer is a lie about a real-world side effect.
   */
  it('never answers twice when the transport settles after the timeout', async () => {
    vi.useFakeTimers();
    let settle: (outcome: DeliveryOutcome) => void;
    const capability = makeCapability(
      () =>
        new Promise<DeliveryOutcome>((resolve) => {
          settle = resolve;
        })
    );
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS);
    expect(ctx.commands).toHaveLength(1);

    settle({ ok: true, messageId: 'arrived-late' });
    await vi.advanceTimersByTimeAsync(1);

    expect(ctx.commands).toHaveLength(1);
    expect(ctx.warns.some((w) => w.includes('late delivery answer'))).toBe(true);
  });

  it('cancels the timer when the transport answers in time', async () => {
    vi.useFakeTimers();
    const capability = makeCapability(() => Promise.resolve({ ok: true, messageId: 'm-3' }));
    const ctx = makeContext();

    capability.handle(SEND_REQUEST, ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.commands).toHaveLength(1);
    // The timer is CLEARED, not merely rendered harmless by the latch: a live
    // 120 s timer per delivered message would keep the event loop busy long
    // after the turn ended, and the latch alone would hide that.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS * 2);
    expect(ctx.commands).toHaveLength(1);
  });
});

describe('host_send_message_result: the builder', () => {
  it('refuses to describe a failure without a reason the user can act on', () => {
    const built = buildHostSendMessageResult({ callId: 'c-1', ok: false });
    expect(built.ok).toBe(false);
    if (built.ok === false) expect(built.reason).toContain('non-empty error');
  });

  /**
   * The engine TOLERATES a bare failure - `compat/commands/
   * host_send_message_result.minimal.json` is exactly that, and it validates.
   * This host is deliberately stricter: it always knows why, and "no channel is
   * configured for slack" is a configuration problem only the user can fix.
   */
  it('documents that the engine accepts the bare failure this host will not send', () => {
    expect(validateCommand(SEND_RESULT_MINIMAL).valid).toBe(true);
    expect(SEND_RESULT_MINIMAL.error).toBeUndefined();
    const built = buildHostSendMessageResult({ callId: SEND_RESULT_MINIMAL.call_id as string, ok: false });
    expect(built.ok).toBe(false);
  });

  it('refuses a platform message id on a failed delivery', () => {
    const built = buildHostSendMessageResult({ callId: 'c-1', ok: false, error: 'x', messageId: 'm-1' });
    expect(built.ok).toBe(false);
    if (built.ok === false) expect(built.reason).toContain('no platform message_id');
  });

  it('never coerces ok', () => {
    const built = buildHostSendMessageResult({ callId: 'c-1', ok: 'true' as unknown as boolean, error: 'x' });
    expect(built.ok).toBe(false);
  });

  it('refuses an unusable call_id rather than answering under a truncated one', () => {
    for (const callId of ['', 'x'.repeat(MAX_WIRE_ID_LENGTH + 1), 7 as unknown as string]) {
      expect(buildHostSendMessageResult({ callId, ok: true }).ok).toBe(false);
    }
    expect(buildHostSendMessageResult({ callId: 'x'.repeat(MAX_WIRE_ID_LENGTH), ok: true }).ok).toBe(true);
  });

  it('truncates a runaway error instead of refusing to answer at all', () => {
    const built = buildHostSendMessageResult({ callId: 'c-1', ok: false, error: 'e'.repeat(5000) });
    expect(built.ok).toBe(true);
    if (built.ok === true) {
      expect(String(built.command.error).length).toBeLessThan(5000);
      expect(String(built.command.error)).toContain('(5000 chars)');
      expect(validateCommand(built.command).valid).toBe(true);
    }
  });

  /**
   * The builder's OWN `message_id` check, not the transport reader's.
   *
   * `readDeliveryOutcome` also rejects an unusable id, so the delivery path
   * covers this guard twice over and deleting it here changes nothing any
   * delivery test can see. It still has to hold: this function is exported and
   * is the only sanctioned constructor, so a UI or a future caller reaching it
   * directly must not be able to put an empty or runaway `message_id` on a
   * receipt the user may click.
   */
  it('refuses a message id it could not echo, even on a successful delivery', () => {
    for (const messageId of ['', 'm'.repeat(MAX_WIRE_ID_LENGTH + 1), 7 as unknown as string]) {
      const built = buildHostSendMessageResult({ callId: 'c-1', ok: true, messageId });
      expect(built.ok, JSON.stringify(messageId)).toBe(false);
      if (built.ok === false) expect(built.reason).toContain('message_id');
    }
    const atBound = buildHostSendMessageResult({ callId: 'c-1', ok: true, messageId: 'm'.repeat(MAX_WIRE_ID_LENGTH) });
    expect(atBound.ok).toBe(true);
    if (atBound.ok === true) expect(validateCommand(atBound.command).valid).toBe(true);
  });
});

describe('the decoders refuse the shapes their guards exist for', () => {
  /**
   * Everything else about this frame is a perfectly good request, so the only
   * thing that can refuse it is the discriminator. Without that check the
   * decoder would happily read a `host_send_message_reply` - or any future
   * sibling verb - as a delegated send and answer it.
   */
  it('refuses a frame whose type is not the one being decoded', () => {
    expect(refusalOf(decodeHostSendMessageRequest({ ...SEND_REQUEST, type: 'host_send_message_reply' }))).toContain(
      'not a host_send_message_request'
    );
    // The resolution pair is two schemas that differ ONLY by discriminator, so
    // the command must not be readable as the event or vice versa.
    expect(
      refusalOf(
        decodeUnknownToolEffectResolution(
          { ...RESOLVED_EVENT, type: 'resolve_unknown_tool_effect' },
          'unknown_tool_effect_resolved'
        )
      )
    ).toContain('not a unknown_tool_effect_resolved');
  });

  /**
   * `typeof [] === 'object'`, so an `isRecord` that checked only typeof and
   * null would let an array through to be read key by key - and an array has
   * none of the keys, so every message below would blame a missing field
   * instead of the shape that is actually wrong. The array arm is the one
   * `describeType` models explicitly and the one no adversarial input in this
   * file used to exercise.
   */
  it('refuses an array wherever an object is required, and names it as an array', () => {
    expect(refusalOf(decodeHostSendMessageRequest([]))).toContain('event is not an object (got array)');
    expect(refusalOf(decodeProviderFailoverReceipt([]))).toContain('event is not an object (got array)');
    expect(refusalOf(decodeProviderFailoverReceipt({ type: 'provider_failover_receipt', receipt: [] }))).toContain(
      'receipt is not an object (got array)'
    );
    expect(refusalOf(decodeProviderFailoverReceipt(receiptEvent({ candidates: [[]] })))).toContain(
      'receipt.candidates[0] is not an object (got array)'
    );
    expect(
      refusalOf(decodeProviderFailoverReceipt(receiptEvent({ candidates: [candidate({ disposition: [] })] })))
    ).toContain('disposition is not an object (got array)');
    expect(
      refusalOf(decodeProviderFailoverReceipt(receiptEvent({ candidates: [candidate({ pricing: [] })] })))
    ).toContain('pricing is not an object (got array)');
    expect(refusalOf(decodeUnknownToolEffectResolution([], 'unknown_tool_effect_resolved'))).toContain(
      'event is not an object (got array)'
    );
    expect(
      refusalOf(decodeUnknownToolEffectResolution({ ...RESOLVED_EVENT, cursor: [] }, 'unknown_tool_effect_resolved'))
    ).toContain('cursor is not an object (got array)');
    expect(
      refusalOf(decodeUnknownToolEffectResolution({ ...RESOLVED_EVENT, evidence: [] }, 'unknown_tool_effect_resolved'))
    ).toContain('evidence is not an object (got array)');

    const built = buildResolveUnknownToolEffect([] as unknown as ResolveUnknownToolEffectInput);
    expect(built.ok).toBe(false);
    if (built.ok === false) expect(built.reason).toContain('input is not an object (got array)');
  });

  /**
   * The one detail line whose length the ENGINE controls.
   *
   * Every other quoted value is a single field that is itself bounded or
   * refused; the unknown-key list is a join over however many undeclared fields
   * arrived, and nothing caps that count. Without the truncation all of them
   * travel into a warning and into a frame the renderer displays.
   */
  it('bounds a detail line whose length the wire controls', () => {
    const event: Record<string, unknown> = { ...RESOLVED_EVENT };
    for (let index = 0; index < 200; index += 1) event[`future_field_${index}`] = index;

    const error = refusalOf(decodeUnknownToolEffectResolution(event, 'unknown_tool_effect_resolved'));
    expect(error).toContain('unknown field');
    expect(error).toContain('chars)');
    expect(error.length).toBeLessThan(MAX_DETAIL_VALUE_LENGTH * 2);
  });
});

/* ------------------------------- failover -------------------------------- */

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-5',
    region: 'us-east',
    disposition: { Ok: null },
    failure_reason: null,
    cooldown_reason: null,
    retry_after_ms: null,
    pricing: { source: 'bundled', age_seconds: null, stale: false, priced: true, estimated_microcents: 77 },
    ...overrides,
  };
}

function receiptEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = FAILOVER.receipt as Record<string, unknown>;
  return { type: 'provider_failover_receipt', receipt: { ...base, ...overrides } };
}

describe('provider_failover_receipt', () => {
  it('is no longer inert: the fixture produces an info-class switch notice', () => {
    const capability = makeCapability();
    const ctx = makeContext();

    expect(validateEvent(FAILOVER).valid).toBe(true);
    expect(capability.handle(FAILOVER, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    const frame = ctx.frames[0].data as ProviderFailoverFrame;
    expect(frame.verdict).toBe('switched');
    expect(frame.severity).toBe('info');
    expect(frame.selectedProvider).toBe('openai');
    expect(frame.detail).toContain('rate_limit');
    // Safety-class per the manifest: it is warned about either way.
    expect(ctx.warns).toHaveLength(1);
  });

  /**
   * The case the whole event exists for: nothing was selected, so the turn is
   * about to fail with no explanation. `null` must survive as `null` - coerced
   * to `''` or `undefined` it becomes indistinguishable from "not stated".
   */
  it('reports an exhausted failover as error-class and keeps null as null', () => {
    const capability = makeCapability();
    const ctx = makeContext();
    const event = receiptEvent({
      selected_provider: null,
      selected_model: null,
      candidates: [candidate({ disposition: { Err: 'budget_denied' } })],
    });

    expect(validateEvent(event).valid).toBe(true);
    capability.handle(event, ctx);

    const frame = ctx.frames[0].data as ProviderFailoverFrame;
    expect(frame.verdict).toBe('exhausted');
    expect(frame.severity).toBe('error');
    expect(frame.selectedProvider).toBeNull();
    expect(frame.selectedModel).toBeNull();
    expect(frame.rejectedCount).toBe(1);
    expect(frame.detail).toContain('budget_denied');
  });

  /**
   * The schema allows one of the two to be null while the other is a string.
   * The contract says nothing about what that would mean, and it is exactly the
   * pair that decides whether the turn still has a provider. Fail closed.
   */
  it('refuses a half-selection the contract never explains', () => {
    const event = receiptEvent({ selected_provider: null, selected_model: 'gpt-5' });
    expect(validateEvent(event).valid).toBe(true);
    const decoded = decodeProviderFailoverReceipt(event);
    expect('error' in decoded).toBe(true);
  });

  it('accepts every declared failure reason and every declared reject reason', () => {
    for (const reason of PROVIDER_FAILURE_REASONS) {
      const event = receiptEvent({
        reason,
        candidates: [candidate({ failure_reason: reason, cooldown_reason: reason, retry_after_ms: 1000 })],
      });
      expect(validateEvent(event).valid, `${reason} against the schema`).toBe(true);
      expect('value' in decodeProviderFailoverReceipt(event), `${reason} through the decoder`).toBe(true);
    }
    for (const reject of FAILOVER_REJECT_REASONS) {
      const event = receiptEvent({ candidates: [candidate({ disposition: { Err: reject } })] });
      expect(validateEvent(event).valid, `${reject} against the schema`).toBe(true);
      const decoded = decodeProviderFailoverReceipt(event);
      expect('value' in decoded, `${reject} through the decoder`).toBe(true);
      if ('value' in decoded) {
        const disposition = decoded.value.candidates[0].disposition;
        // The externally-tagged Result must narrow, not merely parse.
        expect('Err' in disposition && disposition.Err).toBe(reject);
      }
    }
  });

  it('refuses a disposition that is not exactly one of Ok/Err', () => {
    const bad = [{}, { Ok: null, Err: 'budget_denied' }, { Ok: 'yes' }, { Err: 'future_reason' }, { Maybe: null }];
    for (const disposition of bad) {
      const decoded = decodeProviderFailoverReceipt(receiptEvent({ candidates: [candidate({ disposition })] }));
      expect('error' in decoded, `${JSON.stringify(disposition)} must not decode`).toBe(true);
    }
  });

  it('reads a full candidate list and refuses one past the cap', () => {
    const atCap = receiptEvent({ candidates: Array.from({ length: MAX_FAILOVER_CANDIDATES }, () => candidate()) });
    expect('value' in decodeProviderFailoverReceipt(atCap)).toBe(true);

    const overCap = receiptEvent({
      candidates: Array.from({ length: MAX_FAILOVER_CANDIDATES + 1 }, () => candidate()),
    });
    const decoded = decodeProviderFailoverReceipt(overCap);
    expect('error' in decoded).toBe(true);
    // Refused, not truncated: a partial list read as complete would tell the
    // user "these were the options" when it was not.
    if ('error' in decoded) expect(decoded.error).toContain(String(MAX_FAILOVER_CANDIDATES));
  });

  it('refuses pricing this host would otherwise render as fact', () => {
    const bad: Record<string, unknown>[] = [
      { source: 'bundled', age_seconds: -1, stale: false, priced: true, estimated_microcents: 1 },
      { source: 'bundled', age_seconds: 1.5, stale: false, priced: true, estimated_microcents: 1 },
      { source: 'bundled', age_seconds: null, stale: 'no', priced: true, estimated_microcents: 1 },
      { source: 'bundled', age_seconds: null, stale: false, priced: true, estimated_microcents: -5 },
      { source: 42, age_seconds: null, stale: false, priced: true, estimated_microcents: 1 },
      // The schema puts no maxLength on `source`, and it is rendered next to a
      // price - so the bound is this host's, and it is the only one there is.
      {
        source: 's'.repeat(MAX_WIRE_ID_LENGTH + 1),
        age_seconds: null,
        stale: false,
        priced: true,
        estimated_microcents: 1,
      },
    ];
    for (const pricing of bad) {
      expect(
        'error' in decodeProviderFailoverReceipt(receiptEvent({ candidates: [candidate({ pricing })] })),
        JSON.stringify(pricing)
      ).toBe(true);
    }
  });

  it('refuses provider and model names it could not attribute a failover to', () => {
    const bad: Record<string, unknown>[] = [
      receiptEvent({ failed_provider: '' }),
      receiptEvent({ failed_model: 42 }),
      receiptEvent({ failed_provider: 'p'.repeat(MAX_WIRE_ID_LENGTH + 1) }),
      receiptEvent({ candidates: [candidate({ provider: '' })] }),
      receiptEvent({ candidates: [candidate({ model: 42 })] }),
      receiptEvent({ candidates: [candidate({ region: 7 })] }),
      // `region` is a bare nullable string in the schema with no maxLength, and
      // it reaches the frame; the bound on it is this host's alone.
      receiptEvent({ candidates: [candidate({ region: 'r'.repeat(MAX_WIRE_ID_LENGTH + 1) })] }),
      receiptEvent({ candidates: [candidate({ retry_after_ms: -1 })] }),
      receiptEvent({ candidates: 'none' }),
      receiptEvent({ selected_provider: '' }),
      { type: 'provider_failover_receipt' },
    ];
    for (const event of bad) {
      expect('error' in decodeProviderFailoverReceipt(event), JSON.stringify(event).slice(0, 90)).toBe(true);
    }
  });

  /**
   * `receipt`, `receipt.candidates[]` and `.pricing` are all
   * `additionalProperties: false`, exactly like the cursor and the resolution
   * body this module already refused unknown keys on. The EVENT around them is
   * `additionalProperties: true` and must stay tolerant - a future top-level
   * hint turning a safety-class failover into a malformed one would restore the
   * silence this capability exists to end. Both halves are pinned here, because
   * a check that spread to the whole event would be just as wrong as no check.
   */
  it('refuses an unknown key on the sub-objects the schema closes, and tolerates one on the event', () => {
    const closed: [Record<string, unknown>, string][] = [
      [receiptEvent({ future_authority: true }), 'receipt carries unknown field'],
      [
        receiptEvent({ candidates: [candidate({ future_authority: true })] }),
        'receipt.candidates[0] carries unknown field',
      ],
      [
        receiptEvent({
          candidates: [
            candidate({
              pricing: {
                source: 'bundled',
                age_seconds: null,
                stale: false,
                priced: true,
                estimated_microcents: 77,
                future_authority: true,
              },
            }),
          ],
        }),
        'pricing carries unknown field',
      ],
    ];

    for (const [event, expected] of closed) {
      expect(validateEvent(event).valid, `the schema itself refuses: ${expected}`).toBe(false);
      expect(refusalOf(decodeProviderFailoverReceipt(event))).toContain(expected);
    }

    const tolerated = { ...FAILOVER, future_hint: 'a delivery hint this host does not model' };
    expect(validateEvent(tolerated).valid, 'the event branch is additionalProperties:true').toBe(true);
    expect('value' in decodeProviderFailoverReceipt(tolerated)).toBe(true);
  });

  it('files a failover under the turn it happened in', () => {
    const capability = makeCapability();
    const ctx = makeContext();
    capability.handle(FAILOVER, ctx);
    expect(ctx.frames[0].msg_id).toBe('msg-1');
  });

  it('refuses an undeclared enum member rather than showing it as understood', () => {
    for (const event of [
      receiptEvent({ reason: 'quota_exceeded' }),
      receiptEvent({ candidates: [candidate({ failure_reason: 'quota_exceeded' })] }),
      receiptEvent({ candidates: [candidate({ cooldown_reason: 'quota_exceeded' })] }),
    ]) {
      expect('error' in decodeProviderFailoverReceipt(event)).toBe(true);
    }
  });

  /**
   * A receipt that cannot be read still tells the user their turn changed
   * provider for reasons nobody can see. Dropping it would restore the silence
   * this capability exists to end, so a malformed receipt is announced too.
   */
  it('announces a receipt it could not read instead of dropping it', () => {
    const capability = makeCapability();
    const ctx = makeContext();

    expect(capability.handle({ type: 'provider_failover_receipt', receipt: { reason: 'rate_limit' } }, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    const frame = ctx.frames[0].data as ProviderFailoverFrame;
    expect(frame.verdict).toBe('malformed');
    expect(frame.candidates).toEqual([]);
    expect(ctx.warns).toHaveLength(1);
  });

  /**
   * The contract's generic adversarial event fixtures. Neither is a failover
   * receipt, which is the point: they prove the handler is reached only for the
   * types it claims and that a foreign critical event is not absorbed here.
   */
  it('does not claim the generic adversarial critical events', () => {
    const capability = makeCapability();
    const dispatch = createDispatcher([capability]);
    const ctx = makeContext();

    for (const path of ['adversarial/events/schema-mismatch.jsonl', 'adversarial/events/unknown-critical.jsonl']) {
      for (const message of readFixture(path)) {
        const claimed = (HOST_DELEGATED_EVENT_TYPES as readonly string[]).includes(String(message.type));
        expect(dispatch(message, ctx), `${path}: ${String(message.type)}`).toBe(claimed);
      }
    }
  });
});

/* --------------------------- unknown tool effect ------------------------- */

describe('resolve_unknown_tool_effect: the builder', () => {
  it('reproduces the contract command example byte for byte', () => {
    const built = buildResolveUnknownToolEffect(resolveInputFromContract());
    expect(built.ok).toBe(true);
    if (built.ok === true) {
      expect(digestOf(built.command)).toBe(digestOf(RESOLVE_COMMAND));
      expect(validateCommand(built.command).valid, JSON.stringify(validateCommand(built.command).errors)).toBe(true);
    }
  });

  /**
   * `additionalProperties: false`: one stray key invalidates the whole message.
   * The input is spread with extra keys on purpose - a builder that spread its
   * input instead of assembling it field by field would carry them through.
   */
  it('carries no key the schema does not declare, whatever the caller passes', () => {
    const input = {
      ...resolveInputFromContract(),
      future_authority: true,
      type: 'something_else',
    } as unknown as ResolveUnknownToolEffectInput;
    const built = buildResolveUnknownToolEffect(input);
    expect(built.ok).toBe(true);
    if (built.ok === true) {
      expect(Object.keys(built.command).toSorted()).toEqual([
        'cursor',
        'evidence',
        'operator_id',
        'outcome',
        'recovery_version',
        'session_id',
        'tool_execution_id',
        'turn_id',
        'type',
      ]);
      expect(built.command.type).toBe('resolve_unknown_tool_effect');
      expect(validateCommand(built.command).valid).toBe(true);
    }
  });

  type Violation = { name: string; mutate: (input: ResolveUnknownToolEffectInput) => void; expect: string };

  const VIOLATIONS: Violation[] = [
    {
      name: 'an evidence digest without the sha256: prefix',
      mutate: (i) => {
        i.evidence.digest = i.evidence.digest.replace('sha256:', '');
      },
      expect: 'evidence.digest',
    },
    {
      name: 'an evidence digest with the wrong prefix',
      mutate: (i) => {
        i.evidence.digest = i.evidence.digest.replace('sha256:', 'sha512:');
      },
      expect: 'evidence.digest',
    },
    {
      name: 'a 63-character journal digest',
      mutate: (i) => {
        i.cursor = { journal_digest: i.cursor.journal_digest.slice(0, 63) };
      },
      expect: 'journal_digest',
    },
    {
      name: 'an uppercase journal digest',
      mutate: (i) => {
        // Written out rather than upper-casing the fixture's: its digest is all
        // digits (`6666...`), so `toUpperCase()` would be a no-op and the case
        // would pass no matter what the guard did.
        i.cursor = { journal_digest: 'A'.repeat(64) };
      },
      expect: 'journal_digest',
    },
    {
      name: 'a non-integer journal sequence',
      mutate: (i) => {
        i.cursor = { journal_digest: i.cursor.journal_digest, journal_sequence: 4.5 };
      },
      expect: 'journal_sequence',
    },
    {
      name: 'an unknown key on the cursor',
      mutate: (i) => {
        (i.cursor as Record<string, unknown>).journal_branch = 'main';
      },
      expect: 'unknown field',
    },
    {
      name: 'an empty reference_id',
      mutate: (i) => {
        i.evidence.referenceId = '';
      },
      expect: 'reference_id',
    },
    {
      name: 'a reference_id past the schema maxLength',
      mutate: (i) => {
        i.evidence.referenceId = 'r'.repeat(MAX_EVIDENCE_REFERENCE_LENGTH + 1);
      },
      expect: 'reference_id',
    },
    {
      name: 'observed_at_unix_ms of 0',
      mutate: (i) => {
        i.evidence.observedAtUnixMs = 0;
      },
      expect: 'observed_at_unix_ms',
    },
    {
      name: 'a non-integer observed_at_unix_ms',
      mutate: (i) => {
        i.evidence.observedAtUnixMs = 1721000003000.5;
      },
      expect: 'observed_at_unix_ms',
    },
    {
      name: 'an undeclared evidence source',
      mutate: (i) => {
        i.evidence.source = 'hearsay' as ResolveUnknownToolEffectInput['evidence']['source'];
      },
      expect: 'evidence.source',
    },
    {
      name: 'an outcome outside the enum',
      mutate: (i) => {
        i.outcome = 'unknown' as ResolveUnknownToolEffectInput['outcome'];
      },
      expect: 'outcome',
    },
    {
      name: 'an empty session_id',
      mutate: (i) => {
        i.sessionId = '';
      },
      expect: 'session_id',
    },
    {
      name: 'an over-long turn_id',
      mutate: (i) => {
        i.turnId = 't'.repeat(MAX_WIRE_ID_LENGTH + 1);
      },
      expect: 'turn_id',
    },
    {
      name: 'a missing tool_execution_id',
      mutate: (i) => {
        i.toolExecutionId = undefined as unknown as string;
      },
      expect: 'tool_execution_id',
    },
    {
      name: 'a missing operator_id',
      mutate: (i) => {
        i.operatorId = undefined as unknown as string;
      },
      expect: 'operator_id',
    },
    {
      name: 'a missing evidence object',
      mutate: (i) => {
        i.evidence = undefined as unknown as ResolveUnknownToolEffectInput['evidence'];
      },
      expect: 'evidence',
    },
    {
      name: 'a missing cursor',
      mutate: (i) => {
        i.cursor = undefined as unknown as ResolveUnknownToolEffectInput['cursor'];
      },
      expect: 'cursor',
    },
  ];

  for (const violation of VIOLATIONS) {
    it(`refuses ${violation.name}`, () => {
      const input = resolveInputFromContract();
      violation.mutate(input);
      const built = buildResolveUnknownToolEffect(input);
      expect(built.ok).toBe(false);
      if (built.ok === false) expect(built.reason).toContain(violation.expect);
    });
  }

  it('accepts the schema boundary values it is allowed to accept', () => {
    const input = resolveInputFromContract();
    input.evidence.referenceId = 'r'.repeat(MAX_EVIDENCE_REFERENCE_LENGTH);
    input.evidence.observedAtUnixMs = 1;
    const built = buildResolveUnknownToolEffect(input);
    expect(built.ok).toBe(true);
    if (built.ok === true) expect(validateCommand(built.command).valid).toBe(true);
  });
});

describe('resolve_unknown_tool_effect: the send gates', () => {
  it('refuses on a build that does not grade the capability available', () => {
    const capability = createHostDelegatedDeliveryCapability();
    const ctx = makeContext('');

    for (const contract of [NO_CONTRACT, gradedAs('shape_only'), gradedAs('unavailable')]) {
      capability.setContractSource(() => contract);
      const outcome = capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract());
      expect(outcome.ok).toBe(false);
      if (outcome.ok === false) expect(outcome.reason).toContain(OPERATOR_TOOL_EFFECT_CAPABILITY);
    }
    expect(ctx.commands).toEqual([]);
  });

  it('fails closed when no ready was ever seeded', () => {
    // The default source is the turn-recovery contract map, which is empty for a
    // session nobody seeded - so the gate is shut without any explicit refusal.
    const capability = createHostDelegatedDeliveryCapability();
    const ctx = makeContext('');
    expect(capability.contractFor('never-seeded')).toBe(NO_CONTRACT);
    expect(capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract()).ok).toBe(false);
    expect(ctx.commands).toEqual([]);
  });

  it('survives a contract source that throws, by staying shut', () => {
    const capability = createHostDelegatedDeliveryCapability();
    capability.setContractSource(() => {
      throw new Error('storage gone');
    });
    const ctx = makeContext('');
    expect(capability.contractFor('s-1')).toBe(NO_CONTRACT);
    expect(capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract()).ok).toBe(false);
  });

  /**
   * MEASURED, not inferred: the bundled binary carries "resolve_unknown_tool_effect
   * refused during active turn; resync and retry after the turn stops". Sending
   * it mid-turn is a guaranteed no-op, so it is refused where the reason can
   * reach the operator. `activeMsgId()` is `''` outside a turn.
   */
  it('refuses while a turn is in flight and permits once it stops', () => {
    const capability = makeCapability();
    const ctx = makeContext('msg-live');

    const refused = capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract());
    expect(refused.ok).toBe(false);
    if (refused.ok === false) expect(refused.reason).toContain('turn is in flight');
    expect(ctx.commands).toEqual([]);

    ctx.activeMsg = '';
    const sent = capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract());
    expect(sent.ok).toBe(true);
    expect(ctx.commands).toHaveLength(1);
    expect(digestOf(ctx.commands[0])).toBe(digestOf(RESOLVE_COMMAND));
  });

  it('refuses to send a malformed command and writes nothing', () => {
    const capability = makeCapability();
    const ctx = makeContext('');
    const input = resolveInputFromContract();
    input.evidence.digest = 'not-a-digest';

    expect(capability.sendResolveUnknownToolEffect(ctx, input).ok).toBe(false);
    expect(ctx.commands).toEqual([]);
    expect(capability.pendingResolutionKeys()).toEqual([]);
  });

  it('leaves the ledger untouched when the write fails', () => {
    const capability = makeCapability();
    const ctx = makeContext('');
    ctx.sendCommand = () => {
      throw new Error('ERR_STREAM_DESTROYED');
    };

    const outcome = capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract());
    expect(outcome.ok).toBe(false);
    expect(capability.pendingResolutionKeys()).toEqual([]);
  });

  it('bounds the ledger of sent resolutions', () => {
    const capability = makeCapability();
    const ctx = makeContext('');

    for (let i = 0; i <= MAX_TRACKED_RESOLUTIONS; i += 1) {
      const input = resolveInputFromContract();
      input.toolExecutionId = `tool-${i}`;
      expect(capability.sendResolveUnknownToolEffect(ctx, input).ok).toBe(true);
    }
    expect(capability.pendingResolutionKeys()).toHaveLength(MAX_TRACKED_RESOLUTIONS);
    expect(ctx.warns.some((w) => w.includes('forgetting the oldest sent resolution'))).toBe(true);
  });

  /**
   * WHICH one is forgotten, not just how many survive. Counting alone passes
   * either way, and the two directions are opposite failures: dropping the
   * OLDEST costs a stale echo its correlation flag, dropping the NEWEST means
   * the resolution just sent - the one whose echo is about to arrive - reports
   * as somebody else's the moment it comes back.
   */
  it('forgets the oldest sent resolution and keeps the one just sent', () => {
    const capability = makeCapability();
    const ctx = makeContext('');
    const keys: string[] = [];

    for (let i = 0; i < MAX_TRACKED_RESOLUTIONS; i += 1) {
      const input = resolveInputFromContract();
      input.toolExecutionId = `tool-${i}`;
      const sent = capability.sendResolveUnknownToolEffect(ctx, input);
      expect(sent.ok).toBe(true);
      if (sent.ok === true) keys.push(sent.key);
    }

    const overflowing = resolveInputFromContract();
    overflowing.toolExecutionId = 'tool-newest';
    const newest = capability.sendResolveUnknownToolEffect(ctx, overflowing);
    expect(newest.ok).toBe(true);

    const tracked = capability.pendingResolutionKeys();
    expect(tracked).toHaveLength(MAX_TRACKED_RESOLUTIONS);
    if (newest.ok === true) expect(tracked, 'the newest must survive its own eviction').toContain(newest.key);
    expect(tracked, 'the oldest is the one that goes').not.toContain(keys[0]);
    expect(tracked).toContain(keys[MAX_TRACKED_RESOLUTIONS - 1]);
  });
});

describe('unknown_tool_effect_resolved', () => {
  it('decodes the fixture and reports it as a session fact', () => {
    const capability = makeCapability();
    const ctx = makeContext();

    expect(validateEvent(RESOLVED_EVENT).valid).toBe(true);
    expect(capability.handle(RESOLVED_EVENT, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    // Empty msg_id: a settled effect arrives during reconciliation, before any
    // turn is open. WCoreManager forwards it because the type is claimed.
    expect(ctx.frames[0].msg_id).toBe('');
    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.verdict).toBe('accepted');
    expect(frame.resolution?.outcome).toBe('succeeded');
    expect(frame.resolution?.tool_execution_id).toBe('tool-execution-002');
  });

  /**
   * The manifest correlates the pair on `session_turn_tool_and_cursor`. An echo
   * of this host's own command is `correlated`; anything else is reported and
   * flagged rather than dropped - nothing in the contract says this host is the
   * only party that can resolve an effect.
   */
  it('correlates the echo of a command this host sent', () => {
    const capability = makeCapability();
    const ctx = makeContext('');

    expect(capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract()).ok).toBe(true);
    expect(capability.pendingResolutionKeys()).toHaveLength(1);

    capability.handle(RESOLVED_EVENT, ctx);
    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.correlated).toBe(true);
    expect(frame.severity).toBe('info');
    expect(capability.pendingResolutionKeys()).toEqual([]);
    expect(ctx.warns).toEqual([]);
  });

  it('flags a resolution it never asked for, and still shows it', () => {
    const capability = makeCapability();
    const ctx = makeContext();

    capability.handle(RESOLVED_EVENT, ctx);
    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.correlated).toBe(false);
    expect(frame.severity).toBe('warning');
    expect(frame.resolution).not.toBeNull();
    expect(ctx.warns.some((w) => w.includes('does not match any resolve_unknown_tool_effect'))).toBe(true);
  });

  /**
   * The correlation key is four WIRE-CONTROLLED strings. Joined on any literal
   * delimiter, two different tuples can produce one key - and then an echo for
   * one tool execution would settle a different one. These two tuples collide
   * under a `|` join and must not collide here.
   */
  it('does not let two different tuples collide on one correlation key', () => {
    const capability = makeCapability();
    const ctx = makeContext('');

    const first = resolveInputFromContract();
    first.sessionId = 'a|b';
    first.turnId = 'c';
    expect(capability.sendResolveUnknownToolEffect(ctx, first).ok).toBe(true);

    const second = resolveInputFromContract();
    second.sessionId = 'a';
    second.turnId = 'b|c';
    expect(capability.sendResolveUnknownToolEffect(ctx, second).ok).toBe(true);

    expect(capability.pendingResolutionKeys()).toHaveLength(2);
  });

  /**
   * The key the manifest names is `session_turn_tool_and_cursor`, and the TURN
   * component of it was the one no test read. Everything else here is the
   * command this host just sent, so an echo that correlates could only have
   * done so by ignoring `turn_id` - and then a resolution settled in one turn
   * would be reported as the answer to a question asked in another.
   */
  it('does not correlate an echo from a different turn', () => {
    const capability = makeCapability();
    const ctx = makeContext('');
    expect(capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract()).ok).toBe(true);

    const otherTurn = { ...RESOLVED_EVENT, turn_id: 'turn-from-another-conversation' };
    expect(validateEvent(otherTurn).valid).toBe(true);
    capability.handle(otherTurn, ctx);

    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.correlated).toBe(false);
    expect(capability.pendingResolutionKeys(), 'the command this host sent is still outstanding').toHaveLength(1);
  });

  it('does not correlate an echo whose cursor moved', () => {
    const capability = makeCapability();
    const ctx = makeContext('');
    capability.sendResolveUnknownToolEffect(ctx, resolveInputFromContract());

    const cursor = RESOLVED_EVENT.cursor as Record<string, unknown>;
    capability.handle({ ...RESOLVED_EVENT, cursor: { ...cursor, journal_digest: 'a'.repeat(64) } }, ctx);

    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.correlated).toBe(false);
    expect(capability.pendingResolutionKeys()).toHaveLength(1);
  });

  it('refuses a version this host does not speak, before reading anything else', () => {
    const decoded = decodeUnknownToolEffectResolution(
      { ...RESOLVED_EVENT, recovery_version: 2 },
      'unknown_tool_effect_resolved'
    );
    expect('error' in decoded).toBe(true);
    if ('error' in decoded) expect(decoded.error).toContain('recovery_version');
  });

  it('refuses an undeclared field on a message that is additionalProperties:false', () => {
    for (const event of [
      { ...RESOLVED_EVENT, future_authority: true },
      { ...RESOLVED_EVENT, evidence: { ...(RESOLVED_EVENT.evidence as object), notarized_by: 'x' } },
    ]) {
      expect(validateEvent(event).valid, 'the schema itself refuses it').toBe(false);
      const decoded = decodeUnknownToolEffectResolution(event, 'unknown_tool_effect_resolved');
      expect('error' in decoded).toBe(true);
      if ('error' in decoded) expect(decoded.error).toContain('unknown field');
    }
  });

  /**
   * THE DECODER MUST NOT BE STRICTER THAN THE CONTRACT ON THE WAY IN.
   *
   * `session_id`, `turn_id`, `tool_execution_id` and `operator_id` are declared
   * `{"type": "string"}` with no `minLength` in BOTH schemas - asserted from the
   * schema below rather than claimed - so `operator_id: ""` is a
   * contract-conforming `unknown_tool_effect_resolved`. Reporting it as
   * malformed would refuse a safety-class event for a shape the engine is
   * entitled to send.
   */
  it('reads the empty identifiers the contract permits, rather than calling them malformed', () => {
    const properties = schemaBranch('core-event.schema.json', 'unknown_tool_effect_resolved').properties as Record<
      string,
      unknown
    >;
    for (const field of ['session_id', 'turn_id', 'tool_execution_id', 'operator_id']) {
      expect(properties[field], `${field} is a bare string in the schema`).toEqual({ type: 'string' });
    }

    const event = { ...RESOLVED_EVENT, operator_id: '' };
    expect(validateEvent(event).valid, 'the schema accepts it').toBe(true);
    const decoded = decodeUnknownToolEffectResolution(event, 'unknown_tool_effect_resolved');
    expect('value' in decoded, 'so this host reads it').toBe(true);
    if ('value' in decoded) expect(decoded.value.operator_id).toBe('');

    const capability = makeCapability();
    const ctx = makeContext();
    capability.handle(event, ctx);
    expect((ctx.frames[0].data as UnknownToolEffectFrame).verdict).toBe('accepted');
  });

  /**
   * The other half of that asymmetry, and the reason it is safe: this host may
   * READ an empty identifier but must never MINT one. An empty `operator_id`
   * leaves "who settled this payment question" unanswerable, and an empty
   * `tool_execution_id` names nothing in the correlation tuple.
   */
  it('still refuses to build a command with an identifier that attributes nothing', () => {
    for (const field of ['sessionId', 'turnId', 'toolExecutionId', 'operatorId'] as const) {
      const input = resolveInputFromContract();
      input[field] = '';
      const built = buildResolveUnknownToolEffect(input);
      expect(built.ok, field).toBe(false);
      if (built.ok === false) expect(built.reason).toContain('non-empty');
    }
  });

  it('bounds the inbound identifiers where the contract does not bound them at all', () => {
    for (const field of ['session_id', 'turn_id', 'tool_execution_id', 'operator_id']) {
      const event = { ...RESOLVED_EVENT, [field]: 'x'.repeat(MAX_WIRE_ID_LENGTH + 1) };
      expect(validateEvent(event).valid, 'the schema declares no maxLength either').toBe(true);
      expect(refusalOf(decodeUnknownToolEffectResolution(event, 'unknown_tool_effect_resolved'))).toContain(field);
    }
  });

  it('announces a resolution it could not read instead of dropping it', () => {
    const capability = makeCapability();
    const ctx = makeContext();

    expect(capability.handle({ type: 'unknown_tool_effect_resolved', recovery_version: 1 }, ctx)).toBe(true);
    const frame = ctx.frames[0].data as UnknownToolEffectFrame;
    expect(frame.verdict).toBe('malformed');
    expect(frame.resolution).toBeNull();
    expect(ctx.warns).toHaveLength(1);
  });

  /**
   * The cursor a resolution carries has to be one the recovery surface actually
   * published - that is what `session_turn_tool_and_cursor` correlation means.
   * `turn_recovery_lifecycle` publishes journal_sequence 42 for turn-002, which
   * is the cursor both unknown-tool-effect files carry.
   */
  it('carries the cursor the recovery surface published for the same turn', () => {
    const cursor = RESOLVE_COMMAND.cursor as { journal_digest: string; journal_sequence: number };
    const lifecycle = examplePayload('event', 'turn_recovery_lifecycle');
    expect(lifecycle.turn_id).toBe(RESOLVE_COMMAND.turn_id);
    expect(lifecycle.cursor).toEqual(cursor);
    expect(RESOLVED_EVENT.cursor).toEqual(cursor);

    const snapshot = examplePayload('event', 'session_recovery_snapshot');
    expect(snapshot.session_id).toBe(RESOLVE_COMMAND.session_id);
    const replayItems = (examplePayload('event', 'session_recovery_replay').items as Record<string, unknown>[]) ?? [];
    expect(replayItems.some((item) => item.kind === 'effect_uncertain')).toBe(true);
  });
});

/* ------------------------ the generic adversarial six -------------------- */

describe('the contract generic malformed command frames', () => {
  /**
   * The contract ships NO verb-specific adversarial fixtures for either of this
   * capability's commands - measured, `adversarial/commands/` holds ten
   * `continue-with-budget-*` files plus these six. Anyone auditing coverage by
   * counting fixtures would conclude they were skipped; they do not exist.
   */
  it('has exactly the six generic frames and none for these two verbs', () => {
    const names = adversarialFixtures('commands').map((path) => path.split('/').pop());
    expect(names).toContain('invalid-json.jsonl');
    expect(names.filter((name) => String(name).startsWith('host-send'))).toEqual([]);
    expect(names.filter((name) => String(name).startsWith('resolve-unknown'))).toEqual([]);
  });

  it('errors loudly on the frame that is not JSON at all', () => {
    // Read as raw text: `readFixture` re-throws, and that throw is the point -
    // a parse path that yielded `{}` would hand a builder an empty object.
    const raw = readFileSync(join(CONTRACT_V1, 'adversarial/commands/invalid-json.jsonl'), 'utf-8');
    expect(raw.trim()).toBe('{not-json}');
    expect(() => readFixture('adversarial/commands/invalid-json.jsonl')).toThrow(/not valid JSON/);
  });

  const MALFORMED = [
    'adversarial/commands/missing-type.jsonl',
    'adversarial/commands/non-object.jsonl',
    'adversarial/commands/non-string-type.jsonl',
    'adversarial/commands/unknown-type.jsonl',
    'adversarial/commands/wrong-required-field.jsonl',
  ];

  it('are all frames the schema rejects, so no builder may ever emit one', () => {
    for (const path of MALFORMED) {
      for (const message of readFixture(path)) {
        expect(validateCommand(message).valid, path).toBe(false);
      }
    }
  });

  /**
   * No `await` anywhere below, and that is an assertion in itself: not one of
   * these frames may reach the transport. Every one of them is refused or
   * answered SYNCHRONOUSLY inside `handle`, so if a malformed frame ever did
   * start a delivery, the answer would arrive a microtask later and the
   * `toHaveLength(1)` here would read zero.
   */
  it('produce a well-formed answer or an explicit refusal, never a malformed write', () => {
    for (const path of MALFORMED) {
      for (const message of readFixture(path)) {
        // As a delivery REQUEST: it has no call_id, so it must be declined
        // without a write - the one unanswerable case, reported not swallowed.
        const capability = makeCapability(() => Promise.resolve({ ok: true }));
        const asRequest = makeContext();
        expect(capability.handle({ ...message, type: 'host_send_message_request' }, asRequest), path).toBe(false);
        expect(asRequest.commands, path).toEqual([]);

        // As a delivery request that DOES carry a call_id: answered, and the
        // answer is a frame the schema accepts.
        const withId = makeContext();
        capability.handle({ ...message, type: 'host_send_message_request', call_id: 'call-x' }, withId);
        expect(withId.commands, path).toHaveLength(1);
        expect(validateCommand(withId.commands[0]).valid, path).toBe(true);
        expect(withId.commands[0].ok, path).toBe(false);

        // As resolution input: refused, and nothing is written.
        const asResolve = makeContext('');
        const built = buildResolveUnknownToolEffect(message as unknown as ResolveUnknownToolEffectInput);
        expect(built.ok, path).toBe(false);
        const sent = capability.sendResolveUnknownToolEffect(
          asResolve,
          message as unknown as ResolveUnknownToolEffectInput
        );
        expect(sent.ok, path).toBe(false);
        expect(asResolve.commands, path).toEqual([]);
        capability.reset();
      }
    }
  });

  it('are not decoded as any of this capability events', () => {
    for (const path of MALFORMED) {
      for (const message of readFixture(path)) {
        expect('error' in decodeHostSendMessageRequest(message), path).toBe(true);
        expect('error' in decodeProviderFailoverReceipt(message), path).toBe(true);
        expect('error' in decodeUnknownToolEffectResolution(message, 'unknown_tool_effect_resolved'), path).toBe(true);
      }
    }
  });
});

/* --------------------------- registry integration ------------------------ */

describe('the capability in the registry', () => {
  let capability: HostDelegatedDeliveryCapability;

  beforeEach(() => {
    capability = makeCapability(() => Promise.resolve({ ok: true, messageId: 'm-1' }));
  });

  it('claims exactly its three event types and routes each of them', async () => {
    const dispatch = createDispatcher([capability]);
    const ctx = makeContext();

    expect([...capability.handles].toSorted()).toEqual([...HOST_DELEGATED_EVENT_TYPES].toSorted());
    expect(dispatch(SEND_REQUEST, ctx)).toBe(true);
    expect(dispatch(FAILOVER, ctx)).toBe(true);
    expect(dispatch(RESOLVED_EVENT, ctx)).toBe(true);
    await flush();
    expect(dispatch({ type: 'text_delta', msg_id: 'm' }, ctx)).toBe(false);
  });

  it('emits every frame under a type it claims, or WCoreManager would drop it', async () => {
    const dispatch = createDispatcher([makeCapability(null)]);
    const ctx = makeContext();

    dispatch(SEND_REQUEST, ctx);
    dispatch(FAILOVER, ctx);
    dispatch(RESOLVED_EVENT, ctx);
    await flush();

    expect(ctx.frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of ctx.frames) {
      expect((HOST_DELEGATED_EVENT_TYPES as readonly string[]).includes(frame.type), frame.type).toBe(true);
    }
  });

  it('is rejected by the registry if another capability claims one of its types', () => {
    const rival: CapabilityHandler = {
      name: 'rival',
      handles: ['provider_failover_receipt'],
      handle: () => true,
    };
    expect(() => assertNoOverlap([capability, rival])).toThrow(/provider_failover_receipt/);
  });

  it('answers "not mine" for a type it does not claim rather than inventing a decode', () => {
    const ctx = makeContext();
    expect(capability.handle({ type: 'ready' }, ctx)).toBe(false);
    expect(ctx.commands).toEqual([]);
    expect(ctx.frames).toEqual([]);
  });

  it('exports a singleton that is not wired to a transport by default', () => {
    // Registration is someone else's edit; what this pins is that the shared
    // instance declines rather than stalls until a deliverer is installed.
    expect(hostDelegatedDeliveryCapability.name).toBe(HOST_DELEGATED_DELIVERY_CAPABILITY);
    expect(hostDelegatedDeliveryCapability.inFlightCallIds()).toEqual([]);
  });

  /**
   * THE MERGE STEP, MADE MECHANICAL - the half of it that a test can own.
   *
   * Registering this capability is two edits in two files neither of which is
   * this module's: `HANDLERS` in `capabilities/index.ts` and the three names in
   * `ACKNOWLEDGED_UNHANDLED_EVENTS` in `protocol.ts`. Nothing was checking that
   * they move TOGETHER. `wcore-eventCoverage.test.ts` cannot: it accepts a type
   * as covered if it is acknowledged OR claimed, so leaving all three in the
   * acknowledged set after registering stays green forever - and the host would
   * then report as knowingly-inert three events it now handles.
   *
   * This is deliberately an EQUIVALENCE, not an assertion that registration has
   * happened. Unregistered, the three names must stay acknowledged or every
   * engine start warns about them. Registered, they must be gone from that set.
   * Either edit made without the other turns this red, and the message says
   * which file is missing its half.
   */
  it('is acknowledged-inert exactly while it is unregistered', () => {
    const registered = registeredCapabilities().some((handler) => handler.name === HOST_DELEGATED_DELIVERY_CAPABILITY);

    for (const type of HOST_DELEGATED_EVENT_TYPES) {
      expect(
        ACKNOWLEDGED_UNHANDLED_EVENTS.has(type),
        registered
          ? `${type} is handled now - remove it from ACKNOWLEDGED_UNHANDLED_EVENTS in wcore/protocol.ts`
          : `${type} is not registered yet - it must stay in ACKNOWLEDGED_UNHANDLED_EVENTS or every engine start warns`
      ).toBe(!registered);
      expect(claimedEventTypes().includes(type), `${type}: the dispatcher and the registry must agree`).toBe(
        registered
      );
    }
  });

  it('forgets in-flight deliveries on reset, for a new engine process', async () => {
    const stalling = makeCapability(() => new Promise<DeliveryOutcome>(() => {}));
    const ctx = makeContext();
    stalling.handle(SEND_REQUEST, ctx);
    expect(stalling.inFlightCallIds()).toEqual(['call-send-001']);

    stalling.reset();
    expect(stalling.inFlightCallIds()).toEqual([]);
    await flush();
  });
});
