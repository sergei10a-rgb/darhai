/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The budget-grant capability, driven by the engine's own fixtures.
 *
 * WHAT THESE TESTS ARE FOR. `continue_with_budget` spends money, and the
 * command is `additionalProperties: false` with an `anyOf` that TypeScript
 * cannot express - so the only thing standing between a stray field and a
 * rejected (or worse, misread) grant is `buildContinueWithBudget`. The contract
 * ships ten adversarial fixtures aimed at exactly that builder; every one of
 * them is driven here, with the verdict stated and justified rather than
 * inferred from the file name.
 *
 * Three measured traps shape this file:
 *
 *  1. `continue-with-budget-overflow-tokens.jsonl` PASSES the contract's own
 *     JSON Schema. 2^64 and the schema's `maximum` of 2^64-1 are the same
 *     IEEE-754 double, so ajv says yes. The table below pins that (`schema:
 *     'accepts'`) so nobody re-derives it, and the host guard is the only thing
 *     that catches the fixture.
 *  2. `continue-with-budget-whitespace-request-id.jsonl` is not valid JSON - it
 *     embeds a raw 0x09 TAB inside a string literal, which RFC 8259 forbids.
 *     `readFixture` re-throws on it, so it is read as raw text.
 *  3. `host-command.schema.json` is one big `oneOf` over 23 command shapes, so
 *     every rejected `continue_with_budget` reports "must have required
 *     property 'msg_id'" - an error from the unrelated `message` branch. Every
 *     assertion here is on the BOOLEAN verdict; an error-text assertion would
 *     read as a bug in the wrong subsystem.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import {
  BUDGET_REFUSAL_REASONS,
  MAX_ADDITIONAL_TOKENS,
  MAX_PENDING_GRANTS,
  budgetGrantsCapability,
  buildApprovalResume,
  buildContinueWithBudget,
  decodeBudgetGrantResult,
  isRetryableRefusal,
  mintBudgetRequestId,
  pendingBudgetGrantIds,
  REQUEST_ID_PATTERN,
  resetBudgetGrants,
  sendContinueWithBudget,
  type ContinueWithBudgetInput,
} from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import {
  CONTRACT_V1,
  adversarialFixtures,
  entryFor,
  examplePayload,
  readFixture,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

type Recorder = CapabilityContext & {
  commands: unknown[];
  frames: { type: string; data: unknown; msg_id: string }[];
  logs: string[];
  warns: string[];
};

function makeContext(): Recorder {
  const commands: unknown[] = [];
  const frames: { type: string; data: unknown; msg_id: string }[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    commands,
    frames,
    logs,
    warns,
    sendCommand: (c) => commands.push(c),
    emit: (f) => frames.push(f),
    activeMsgId: () => 'msg-1',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

/**
 * The production dispatcher's routing function, over this one capability.
 *
 * NOT the production registration: `HANDLERS` in `capabilities/index.ts` is
 * still empty, so nothing routes to this capability in the running app yet.
 * What these tests prove is that the handler behaves correctly once it is
 * registered - see the REQUIRES list in the module's own header.
 */
const dispatch = createDispatcher([budgetGrantsCapability]);

/** One `oneOf` branch of a contract schema, as far as these tests read it. */
type SchemaBranch = {
  properties?: Record<
    string,
    { const?: string; enum?: string[]; pattern?: string; minLength?: number; maxLength?: number; maximum?: number }
  >;
};

function schemaBranch(file: string, type: string): SchemaBranch | undefined {
  const schema = JSON.parse(readFileSync(join(CONTRACT_V1, `schema/${file}`), 'utf-8')) as { oneOf: SchemaBranch[] };
  return schema.oneOf.find((branch) => branch.properties?.type?.const === type);
}

const commandBranch = (type: string) => schemaBranch('host-command.schema.json', type);
const eventBranch = (type: string) => schemaBranch('core-event.schema.json', type);

/**
 * A caller that hands the builder whatever the wire had, casts and all.
 *
 * The casts are the point: these values reach a real caller through IPC JSON,
 * where the declared types are gone and `"1"` arrives as a string. Sanitising
 * here would test the sanitiser instead of the builder.
 *
 * `...raw` FIRST, and it is load-bearing. An adapter that mapped only the three
 * named fields would itself drop `future_authority` before the builder ever saw
 * it, and the `unknown-field.jsonl -> strip` case below could not fail no matter
 * what the builder did. Spreading first means the object handed over really does
 * carry every key the fixture had - so if `buildContinueWithBudget` ever spread
 * its input instead of assembling it field-by-field, that case goes red.
 */
function fromWire(raw: Record<string, unknown>): ContinueWithBudgetInput {
  return {
    ...raw,
    requestId: raw.request_id as string,
    additionalTokens: raw.additional_tokens as number | undefined,
    additionalCostUsd: raw.additional_cost_usd as number | undefined,
  } as ContinueWithBudgetInput;
}

/**
 * A transport that always accepts. Every send test states its own reachability,
 * because {@link sendContinueWithBudget} makes that a required argument rather
 * than an assumption - see the module's `EngineReachable`.
 */
const REACHABLE = () => true;

beforeEach(() => {
  resetBudgetGrants();
});

/**
 * Verdicts, each justified from the contract - the schema branch, the
 * manifest's `criticality: safety`, or the fixture's own bytes. `refuse` means
 * the host must never build this message; `strip` means the defect is a field
 * the builder cannot express, so the correct outcome is a valid command
 * WITHOUT it rather than a refusal.
 */
const ADVERSARIAL = [
  {
    file: 'continue-with-budget-missing-request-id.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: 'request_id is in the branch’s `required` list; the engine correlates the answer on it, so a grant without one can never be matched to the dialog that authorised it.',
  },
  {
    file: 'continue-with-budget-empty-request-id.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: '"" fails minLength 1 and the pattern’s mandatory leading [A-Za-z0-9].',
  },
  {
    file: 'continue-with-budget-long-request-id.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: 'measured 129 characters - over maxLength 128 and over the pattern’s {0,127} tail.',
  },
  {
    file: 'continue-with-budget-unicode-request-id.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: 'measured 128 code points / 256 UTF-16 units / 512 bytes: it PASSES maxLength and is caught only by the ASCII character class. A length-only guard would let it through.',
  },
  {
    file: 'continue-with-budget-empty.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: 'neither quantity present, violating the anyOf. A grant of nothing must never reach the wire - it costs a request_id and grants no budget.',
  },
  {
    file: 'continue-with-budget-negative-cost.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: '-1 breaks `minimum: 0` on the property and `exclusiveMinimum: 0` on the anyOf cost branch.',
  },
  {
    file: 'continue-with-budget-overflow-tokens.jsonl',
    host: 'refuse',
    // MEASURED: ajv ACCEPTS this fixture. 18446744073709551616 (2^64) and the
    // schema's maximum of 2^64-1 are the same double, so `<=` holds. The host
    // guard is the only thing between this and the wire.
    schema: 'accepts',
    why: '2^64 exceeds the schema’s stated maximum even though the schema cannot tell; only a BigInt comparison over the exact value catches it.',
  },
  {
    file: 'continue-with-budget-wrong-numeric-type.jsonl',
    host: 'refuse',
    schema: 'rejects',
    why: '"1" breaks `type: integer`. Coercing it would send a number the user never authorised.',
  },
  {
    file: 'continue-with-budget-unknown-field.jsonl',
    host: 'strip',
    schema: 'rejects',
    why: '`future_authority` breaks additionalProperties:false. The builder constructs field-by-field instead of spreading caller input, so the key is unrepresentable - the right outcome is a valid command without it, not a refusal of an otherwise well-formed grant. `fromWire` spreads the raw fixture, so the key really is on the object the builder is handed: this case fails if the builder ever spreads.',
  },
] as const;

describe('continue_with_budget: the adversarial fixtures', () => {
  it.each(ADVERSARIAL)('$file -> $host', ({ file, host, schema }) => {
    const raw = readFixture(`adversarial/commands/${file}`)[0];

    // Boolean only - see the header note about the oneOf error text.
    expect(validateCommand(raw).valid, `schema verdict for ${file}`).toBe(schema === 'accepts');

    const built = buildContinueWithBudget(fromWire(raw));
    if (host === 'refuse') {
      expect(built.ok, `host must refuse ${file}`).toBe(false);
      return;
    }

    expect(built.ok, `host must be able to build a clean command from ${file}`).toBe(true);
    if (!built.ok) return;
    // The defect really is present on the input - otherwise the adapter, not
    // the builder, is what removed it and this assertion proves nothing.
    expect(fromWire(raw), `${file} must still carry its defect into the builder`).toHaveProperty('future_authority');
    expect(built.command).not.toHaveProperty('future_authority');
    expect(validateCommand(built.command).valid).toBe(true);
  });

  /**
   * Read as raw text, not through `readFixture`.
   *
   * The fixture holds an unescaped 0x09 inside the string literal, which
   * `JSON.parse` rejects ("Bad control character in string literal at position
   * 40"). The assertion that the helper throws is deliberate: if a future
   * contract bump makes this fixture parseable, this test fails and whoever
   * bumps it re-reads the case instead of inheriting a dead code path.
   */
  it('continue-with-budget-whitespace-request-id.jsonl -> refuse (and is not JSON)', () => {
    const rel = 'adversarial/commands/continue-with-budget-whitespace-request-id.jsonl';
    expect(() => readFixture(rel)).toThrow(/not valid JSON/);

    const text = readFileSync(join(CONTRACT_V1, rel), 'utf-8');
    const requestId = /"request_id":"([^"]*)"/.exec(text)?.[1];
    expect(requestId, 'fixture shape changed').toBeDefined();
    // Checked by CODE POINT, not by a regex over the C0 range. Writing that
    // range literally puts real control characters into this source file -
    // which is what happened here once; see "contains no stray control
    // characters" at the bottom. Writing it with \u escapes instead still
    // trips oxlint's `no-control-regex`, which does not care how the
    // character was spelled. A numeric comparison says the same thing and
    // has nothing to smuggle.
    const codePoints = [...(requestId as string)].map((ch) => ch.codePointAt(0) ?? 0);
    expect(
      codePoints.some((cp) => cp < 0x20),
      'fixture no longer carries a raw control character'
    ).toBe(true);

    // Two independent reasons this can never be produced: a leading space fails
    // the pattern's first character class, and a control character is outside
    // every class in the pattern.
    expect(buildContinueWithBudget({ requestId: requestId as string, additionalTokens: 1 }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'budget\t001', additionalTokens: 1 }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: ' budget-001', additionalTokens: 1 }).ok).toBe(false);
  });

  /**
   * A future engine bump that adds an eleventh fixture must fail here rather
   * than be silently skipped - the whole value of this file is that it drives
   * ALL of them.
   */
  it('drives every continue-with-budget fixture the contract ships', () => {
    const shipped = adversarialFixtures('commands')
      .filter((p) => p.includes('continue-with-budget'))
      .map((p) => p.split('/').pop());
    const driven = [...ADVERSARIAL.map((c) => c.file), 'continue-with-budget-whitespace-request-id.jsonl'].toSorted();
    expect(shipped.toSorted()).toEqual(driven);
    expect(shipped).toHaveLength(10);
  });
});

describe('continue_with_budget: what the builder does produce', () => {
  it('reproduces the contract’s own example field-for-field', () => {
    const fixture = examplePayload('command', 'continue_with_budget');
    const built = buildContinueWithBudget(fromWire(fixture));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toEqual(fixture);
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it.each([
    'compat/commands/continue_with_budget.tokens-only.json',
    'compat/commands/continue_with_budget.cost-only.json',
  ])('reproduces %s, so both single-quantity shapes stay reachable', (rel) => {
    const fixture = readFixture(rel)[0];
    const built = buildContinueWithBudget(fromWire(fixture));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toEqual(fixture);
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it('omits a quantity the caller did not give rather than defaulting it to 0', () => {
    // `additional_tokens: 0` alone would fail the anyOf; emitting a field the
    // caller never asked for is also how a "cost only" grant silently becomes
    // a token grant.
    const built = buildContinueWithBudget({ requestId: 'budget-001', additionalCostUsd: 2.5 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.command).toSorted()).toEqual(['additional_cost_usd', 'request_id', 'type']);
  });

  it('accepts a zero quantity only when the other one qualifies', () => {
    // Mirrors the anyOf exactly: tokens>=1 OR cost>0, not "both non-negative".
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: 1, additionalCostUsd: 0 }).ok).toBe(true);
    expect(buildContinueWithBudget({ requestId: 'b2', additionalTokens: 0, additionalCostUsd: 2.5 }).ok).toBe(true);
    expect(buildContinueWithBudget({ requestId: 'b3', additionalTokens: 0, additionalCostUsd: 0 }).ok).toBe(false);
  });

  it('refuses quantities JSON cannot carry', () => {
    // JSON.stringify turns these into `null`, which the engine would reject as
    // a type error a long way from the press that caused it.
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: Number.NaN }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalCostUsd: Number.NaN }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalCostUsd: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: 1.5 }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: -1 }).ok).toBe(false);
  });

  it('holds the token bound as a BigInt, where a Number comparison is blind', () => {
    // MEASURED: BigInt(18446744073709551615) === 18446744073709551616n, i.e. a
    // bound derived from a JS number is already wrong before the comparison.
    // Written as strings: the repo targets ES6, where a `123n` literal does not
    // compile - and a numeric argument would round before BigInt saw it.
    expect(MAX_ADDITIONAL_TOKENS).toBe(BigInt('18446744073709551615'));
    // The bound routed through a JS number is already 2^64 - i.e. a Number-derived
    // guard is wrong before the comparison even runs. (Written via Number() so the
    // lossy literal is computed, not typed: `no-loss-of-precision` rejects the
    // literal form, which is the same fact the lint rule is warning about.)
    expect(BigInt(Number('18446744073709551615')) > MAX_ADDITIONAL_TOKENS).toBe(true);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: 2 ** 64 }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: 'b1', additionalTokens: 10_000_000 }).ok).toBe(true);
  });
});

describe('mintBudgetRequestId', () => {
  it('always produces an id the schema accepts', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = mintBudgetRequestId();
      seen.add(id);
      expect(id.length).toBeLessThanOrEqual(128);
      const built = buildContinueWithBudget({ requestId: id, additionalTokens: 1 });
      expect(built.ok, `minted id rejected: ${id}`).toBe(true);
      if (built.ok) expect(validateCommand(built.command).valid).toBe(true);
    }
    // Same-millisecond presses must not collide - a collision would read as
    // `request_id_conflict` from the engine and lose the second grant.
    expect(seen.size).toBe(1000);
  });
});

describe('budget_grant_result: the round trip', () => {
  it('settles the grant the contract’s own example pair describes', () => {
    const ctx = makeContext();
    const commandFixture = examplePayload('command', 'continue_with_budget');
    const eventFixture = examplePayload('event', 'budget_grant_result');
    // The fixtures share request_id "budget-001" - this is the engine's own
    // request/answer pair, not a hand-written one.
    expect(commandFixture.request_id).toBe(eventFixture.request_id);
    expect(validateEvent(eventFixture).valid).toBe(true);

    const sent = sendContinueWithBudget(ctx, fromWire(commandFixture), REACHABLE);
    expect(sent).toEqual({ ok: true, requestId: 'budget-001' });
    expect(ctx.commands).toEqual([commandFixture]);
    expect(pendingBudgetGrantIds()).toEqual(['budget-001']);

    expect(dispatch(eventFixture, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
    expect(ctx.frames[0]).toEqual({
      type: 'budget_grant_result',
      msg_id: 'msg-1',
      data: {
        requestId: 'budget-001',
        additionalTokens: 250000,
        additionalCostUsd: 2.5,
        outcome: 'granted',
        requestedTokens: 250000,
        requestedCostUsd: 2.5,
        retryable: false,
      },
    });
    expect(pendingBudgetGrantIds()).toEqual([]);
  });

  it('surfaces a refusal with its reason instead of swallowing it', () => {
    const ctx = makeContext();
    const refusal = readFixture('compat/events/budget_grant_result.turn-in-progress.json')[0];
    expect(validateEvent(refusal).valid).toBe(true);

    sendContinueWithBudget(ctx, { requestId: refusal.request_id as string, additionalTokens: 1 }, REACHABLE);
    expect(dispatch(refusal, ctx)).toBe(true);

    const data = ctx.frames[0]?.data as Record<string, unknown>;
    expect(data.outcome).toBe('refused');
    expect(data.refusalReason).toBe('turn_in_progress');
    // The one reason a host may sensibly re-ask on; the other eight are a
    // decision, a malformed request, or a broken subsystem.
    expect(data.retryable).toBe(true);
    for (const reason of BUDGET_REFUSAL_REASONS.filter((r) => r !== 'turn_in_progress')) {
      expect(isRetryableRefusal(reason), `${reason} must not be retryable`).toBe(false);
    }
  });

  it('reports what was granted beside what was asked for', () => {
    // The schema lets the engine grant less than requested; a host that shows
    // the requested figure as granted misreports spend.
    const ctx = makeContext();
    sendContinueWithBudget(
      ctx,
      { requestId: 'budget-partial', additionalTokens: 250000, additionalCostUsd: 2.5 },
      REACHABLE
    );
    const partial = {
      type: 'budget_grant_result',
      request_id: 'budget-partial',
      additional_tokens: 1000,
      additional_cost_usd: 0.25,
      outcome: 'granted',
    };
    expect(validateEvent(partial).valid).toBe(true);
    expect(dispatch(partial, ctx)).toBe(true);
    expect(ctx.frames[0]?.data).toMatchObject({
      additionalTokens: 1000,
      additionalCostUsd: 0.25,
      requestedTokens: 250000,
      requestedCostUsd: 2.5,
    });
  });
});

describe('budget_grant_result: correlation on request_id', () => {
  it('drops an answer to a request nobody made', () => {
    // The manifest gives this event `correlation: request_id`. An answer we
    // cannot place is a reply to a previous session or a duplicate - settling
    // "the pending one" would credit another grant's tokens to it.
    const ctx = makeContext();
    sendContinueWithBudget(ctx, { requestId: 'budget-mine', additionalTokens: 1 }, REACHABLE);
    expect(dispatch(examplePayload('event', 'budget_grant_result'), ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('budget-001');
    expect(pendingBudgetGrantIds()).toEqual(['budget-mine']);
  });

  it('answers a request_id exactly once', () => {
    const ctx = makeContext();
    const event = examplePayload('event', 'budget_grant_result');
    sendContinueWithBudget(ctx, fromWire(examplePayload('command', 'continue_with_budget')), REACHABLE);
    expect(dispatch(event, ctx)).toBe(true);
    // A duplicate delivery must not emit a second grant - budget would be
    // counted twice in the UI for one press.
    expect(dispatch(event, ctx)).toBe(false);
    expect(ctx.frames).toHaveLength(1);
  });

  it('refuses to send the same request_id twice', () => {
    const ctx = makeContext();
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-dup', additionalTokens: 1 }, REACHABLE).ok).toBe(true);
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-dup', additionalTokens: 1 }, REACHABLE).ok).toBe(false);
    expect(ctx.commands).toHaveLength(1);
  });

  it('never puts a malformed grant on the wire', () => {
    const ctx = makeContext();
    const sent = sendContinueWithBudget(ctx, { requestId: 'budget bad id', additionalTokens: 1 }, REACHABLE);
    expect(sent.ok).toBe(false);
    expect(ctx.commands).toEqual([]);
    expect(pendingBudgetGrantIds()).toEqual([]);
    expect(ctx.warns.join(' ')).toMatch(/refusing to send/);
  });

  it('bounds the pending ledger instead of leaking unanswered grants', () => {
    const ctx = makeContext();
    for (let i = 0; i < MAX_PENDING_GRANTS + 1; i += 1) {
      expect(sendContinueWithBudget(ctx, { requestId: `budget-${i}`, additionalTokens: 1 }, REACHABLE).ok).toBe(true);
    }
    const pending = pendingBudgetGrantIds();
    expect(pending).toHaveLength(MAX_PENDING_GRANTS);
    expect(pending).not.toContain('budget-0');
    expect(pending).toContain(`budget-${MAX_PENDING_GRANTS}`);
    expect(ctx.warns.join(' ')).toContain('evicted unanswered budget grant "budget-0"');
  });

  it('forgets pending grants on reset, so a restart cannot look like a conflict', () => {
    const ctx = makeContext();
    sendContinueWithBudget(ctx, { requestId: 'budget-old', additionalTokens: 1 }, REACHABLE);
    resetBudgetGrants();
    expect(pendingBudgetGrantIds()).toEqual([]);
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-old', additionalTokens: 1 }, REACHABLE).ok).toBe(true);
  });
});

/**
 * The gap between "we called sendCommand" and "the engine got it".
 *
 * `CapabilityContext.sendCommand` returns `void`, and the implementation behind
 * it is `WCoreAgent.sendCommand`, which begins
 * `if (!this.childProcess?.stdin?.writable) return;`. A dead engine therefore
 * swallows the command and tells the caller nothing. Reporting `ok: true` there
 * mints a request_id nobody will ever answer: the dialog spins forever, the
 * ledger slot is held until eviction, and the user is told their grant is in
 * flight when it is in a bit bucket.
 *
 * So delivery is an argument, not an assumption, and these are the tests that
 * hold it that way.
 */
describe('continue_with_budget: delivery is not assumed', () => {
  it('records nothing and reports failure when the engine cannot be reached', () => {
    const ctx = makeContext();
    const sent = sendContinueWithBudget(ctx, { requestId: 'budget-dead', additionalTokens: 1 }, () => false);

    expect(sent.ok, 'an unsendable grant must not report success').toBe(false);
    expect(ctx.commands, 'nothing may be handed to a transport that cannot carry it').toEqual([]);
    expect(pendingBudgetGrantIds(), 'a grant that never left must not occupy the ledger').toEqual([]);
    expect(ctx.warns.join(' ')).toContain('budget-dead');
  });

  it('leaves the request_id free to retry after an unreachable engine', () => {
    // The point of not recording: the user presses again once the engine is
    // back. If the failed attempt had been recorded, this would come back as a
    // self-inflicted "already awaiting an answer".
    const ctx = makeContext();
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-retry', additionalTokens: 1 }, () => false).ok).toBe(false);
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-retry', additionalTokens: 1 }, REACHABLE).ok).toBe(true);
    expect(ctx.commands).toHaveLength(1);
  });

  it('records nothing when the write itself throws', () => {
    // The probe answers for the moment before the write; a stream that dies in
    // between throws (EPIPE / ERR_STREAM_DESTROYED) instead of returning. Same
    // outcome required: no ledger entry, no false success.
    const ctx = makeContext();
    ctx.sendCommand = () => {
      throw new Error('EPIPE');
    };

    const sent = sendContinueWithBudget(ctx, { requestId: 'budget-epipe', additionalTokens: 1 }, REACHABLE);
    expect(sent.ok).toBe(false);
    //  not : this repo compiles without strictNullChecks,
    // where only an explicit comparison narrows a discriminated union.
    if (sent.ok === true) return;
    expect(sent.reason).toContain('EPIPE');
    expect(pendingBudgetGrantIds()).toEqual([]);
    expect(ctx.warns.join(' ')).toContain('budget-epipe');
  });

  it('does not consult the transport for a grant it was going to refuse anyway', () => {
    // Ordering, mechanised: build and de-dup faults are the caller's bug and
    // must be reported as such. Probing first would report "the engine is
    // unreachable" for a command that was malformed regardless.
    let probes = 0;
    const counted = () => {
      probes += 1;
      return true;
    };
    const ctx = makeContext();
    expect(sendContinueWithBudget(ctx, { requestId: 'budget bad id', additionalTokens: 1 }, counted).ok).toBe(false);
    expect(probes, 'a malformed grant must fail on its own merits').toBe(0);

    expect(sendContinueWithBudget(ctx, { requestId: 'budget-once', additionalTokens: 1 }, counted).ok).toBe(true);
    expect(sendContinueWithBudget(ctx, { requestId: 'budget-once', additionalTokens: 1 }, counted).ok).toBe(false);
    expect(probes, 'a duplicate must fail on its own merits too').toBe(1);
  });
});

describe('budget_grant_result: what the host refuses to decode', () => {
  /** Register the id the malformed payload claims, so the only thing under test is the decode. */
  function pendingCtx(requestId: string): Recorder {
    const ctx = makeContext();
    sendContinueWithBudget(ctx, { requestId, additionalTokens: 1 }, REACHABLE);
    return ctx;
  }

  it('rejects granted + refusal_reason, the schema’s allOf coupling', () => {
    const bad = { ...examplePayload('event', 'budget_grant_result'), refusal_reason: 'managed_policy' };
    // The schema's first allOf branch says `granted` implies NOT required
    // refusal_reason; the two halves disagree about whether money was spent,
    // and picking either half is a guess.
    expect(validateEvent(bad).valid).toBe(false);

    const ctx = pendingCtx('budget-001');
    expect(dispatch(bad, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
    // Fail closed: the correlation entry survives, so a well-formed answer can
    // still settle it.
    expect(pendingBudgetGrantIds()).toEqual(['budget-001']);
  });

  it('rejects refused without a reason, the other half of the coupling', () => {
    const refusal = readFixture('compat/events/budget_grant_result.turn-in-progress.json')[0];
    const bad = { ...refusal };
    delete bad.refusal_reason;
    expect(validateEvent(bad).valid).toBe(false);

    const ctx = pendingCtx(refusal.request_id as string);
    expect(dispatch(bad, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
  });

  it('rejects a refusal reason outside the published enum', () => {
    const refusal = readFixture('compat/events/budget_grant_result.turn-in-progress.json')[0];
    const bad = { ...refusal, refusal_reason: 'quota_paused' };
    expect(validateEvent(bad).valid).toBe(false);

    const ctx = pendingCtx(refusal.request_id as string);
    expect(dispatch(bad, ctx)).toBe(false);
    expect(ctx.warns.join(' ')).toContain('quota_paused');
  });

  it.each([
    ['missing outcome', { outcome: undefined }],
    ['unknown outcome', { outcome: 'partial' }],
    ['missing additional_tokens', { additional_tokens: undefined }],
    ['string additional_tokens', { additional_tokens: '250000' }],
    ['negative additional_cost_usd', { additional_cost_usd: -1 }],
    ['missing additional_cost_usd', { additional_cost_usd: undefined }],
    ['unusable request_id', { request_id: ' budget-001' }],
  ])('rejects %s', (_name, patch) => {
    const bad: Record<string, unknown> = { ...examplePayload('event', 'budget_grant_result'), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete bad[k];
    expect(validateEvent(bad).valid).toBe(false);

    const ctx = pendingCtx('budget-001');
    expect(dispatch(bad, ctx)).toBe(false);
    expect(ctx.frames).toEqual([]);
  });

  it('does not throw on a payload with nothing in it', () => {
    const ctx = makeContext();
    expect(dispatch({ type: 'budget_grant_result' }, ctx)).toBe(false);
    expect(decodeBudgetGrantResult({ type: 'not_ours' }).ok).toBe(false);
  });

  /**
   * `additionalProperties: false`, enforced rather than tolerated.
   *
   * Darhai is forward-tolerant elsewhere - `negotiateContract` reads the fields
   * it knows out of `ready` and ignores the rest, because refusing an
   * unrecognised key there would make an additive engine change into a dead
   * feature. This event does not get that treatment. The manifest grades it
   * `criticality: safety` and it is the answer to a question about money: a key
   * this host cannot model may be the one that says how much, and there is no
   * safe way to settle a spend answer that was only half understood.
   *
   * The cost is deliberate and bounded: the grant is not settled, the pending
   * entry survives so a well-formed answer still can settle it, and the warning
   * names the offending key so the engine bump is diagnosable in one line.
   */
  it('refuses an unknown field, matching additionalProperties:false', () => {
    const forward = { ...examplePayload('event', 'budget_grant_result'), future_ledger_id: 'x' };
    expect(validateEvent(forward).valid).toBe(false);

    const ctx = pendingCtx('budget-001');
    expect(dispatch(forward, ctx), 'a half-understood spend answer must not settle a grant').toBe(false);
    expect(ctx.frames).toEqual([]);
    // Named, not just counted: "something was wrong" is not a diagnosable
    // warning for an engine upgrade.
    expect(ctx.warns.join(' ')).toContain('future_ledger_id');
    // Fail closed, not fail shut: the grant is still answerable.
    expect(pendingBudgetGrantIds()).toEqual(['budget-001']);
    const wellFormed = examplePayload('event', 'budget_grant_result');
    expect(dispatch(wellFormed, ctx)).toBe(true);
    expect(ctx.frames).toHaveLength(1);
  });

  it('names every unknown field, not just the first', () => {
    // An engine that adds two fields must not send the reader looking for one.
    const forward = {
      ...examplePayload('event', 'budget_grant_result'),
      future_ledger_id: 'x',
      accounting_epoch: 2,
    };
    const decoded = decodeBudgetGrantResult(forward);
    expect(decoded.ok).toBe(false);
    // Explicit comparison narrows; see the note on sendContinueWithBudget.
    if (decoded.ok === true) return;
    expect(decoded.reason).toContain('accounting_epoch');
    expect(decoded.reason).toContain('future_ledger_id');
  });

  it('accepts the exact key set the schema publishes', () => {
    // The other side of the unknown-key guard: it must not have been written so
    // tightly that a legal message fails. Both legal shapes, key for key.
    const granted = examplePayload('event', 'budget_grant_result');
    expect(Object.keys(granted).toSorted()).toEqual([
      'additional_cost_usd',
      'additional_tokens',
      'outcome',
      'request_id',
      'type',
    ]);
    expect(decodeBudgetGrantResult(granted).ok).toBe(true);

    const refused = readFixture('compat/events/budget_grant_result.turn-in-progress.json')[0];
    expect(Object.keys(refused).toSorted()).toEqual([
      'additional_cost_usd',
      'additional_tokens',
      'outcome',
      'refusal_reason',
      'request_id',
      'type',
    ]);
    expect(decodeBudgetGrantResult(refused).ok).toBe(true);
  });
});

describe('approval_resume (command)', () => {
  it('reproduces the contract’s own example', () => {
    const fixture = examplePayload('command', 'approval_resume');
    const built = buildApprovalResume({
      resumeToken: fixture.resume_token as string,
      approved: fixture.approved as boolean,
      answer: (fixture.modifications as { answer: string }).answer,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toEqual(fixture);
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it('omits modifications when there is no answer to send', () => {
    const built = buildApprovalResume({ resumeToken: 'resume-001', approved: false });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command).toEqual({ type: 'approval_resume', resume_token: 'resume-001', approved: false });
    expect(validateCommand(built.command).valid).toBe(true);
  });

  it('refuses an unroutable or coerced answer', () => {
    // An empty token cannot be matched to a suspension: the turn stays paused
    // with no sign that we replied.
    expect(buildApprovalResume({ resumeToken: '', approved: true }).ok).toBe(false);
    // Never coerce - a truthy string here would approve what a human denied.
    expect(buildApprovalResume({ resumeToken: 'r', approved: 'yes' as unknown as boolean }).ok).toBe(false);
    expect(buildApprovalResume({ resumeToken: 'r', approved: true, answer: 7 as unknown as string }).ok).toBe(false);
  });

  /**
   * Risk guard, mechanised. `approval_required` carries both `call_id` and
   * `resume_token`, and the contract publishes both answers without saying
   * whether they are alternatives. Darhai answers tool approvals with
   * `tool_approve` today (measured to work); sending both would double-answer
   * one approval. This capability therefore claims no approval event at all.
   */
  it('claims budget_grant_result and nothing else', () => {
    expect(budgetGrantsCapability.handles).toEqual(['budget_grant_result']);
    expect(dispatch({ type: 'approval_required', call_id: 'c1' }, makeContext())).toBe(false);
    expect(dispatch({ type: 'budget_exceeded', reason: 'max_tokens_out' }, makeContext())).toBe(false);
  });
});

describe('contract surface', () => {
  it('keys on the correlation fields the manifest declares', () => {
    expect(entryFor('event', 'budget_grant_result')?.correlation).toBe('request_id');
    expect(entryFor('command', 'continue_with_budget')?.correlation).toBe('request_id');
    expect(entryFor('command', 'approval_resume')?.correlation).toBe('resume_token');
  });

  it('treats these types as safety-critical, as the manifest grades them', () => {
    // `criticality: safety` is why every branch above fails closed rather than
    // guessing: this is spend, and a wrong guess is money.
    for (const [kind, type] of [
      ['event', 'budget_grant_result'],
      ['command', 'continue_with_budget'],
      ['command', 'approval_resume'],
    ] as const) {
      expect(entryFor(kind, type)?.criticality, `${kind} ${type}`).toBe('safety');
    }
  });

  it('mirrors the published refusal enum exactly', () => {
    const branch = eventBranch('budget_grant_result');
    expect(branch?.properties?.refusal_reason?.enum).toEqual([...BUDGET_REFUSAL_REASONS]);
  });

  /**
   * DRIFT GATES.
   *
   * `REQUEST_ID_PATTERN` and `MAX_ADDITIONAL_TOKENS` are hand-transcribed from
   * `host-command.schema.json` into a module that cannot read `tests/fixtures/`
   * at runtime - `src/process/` ships without them. A transcription with no gate
   * is exactly the drift that module argues against everywhere else, so the gate
   * lives here: change either side and these fail.
   */
  it('REQUEST_ID_PATTERN is the schema’s pattern verbatim, on both branches', () => {
    const command = commandBranch('continue_with_budget')?.properties?.request_id;
    expect(command?.pattern, 'schema shape changed').toBeDefined();
    expect(REQUEST_ID_PATTERN.source).toBe(command?.pattern);

    // The module says the command and event patterns are identical and uses one
    // constant for both. If the engine ever splits them, that is a silent
    // mis-validation of every incoming answer.
    const event = eventBranch('budget_grant_result')?.properties?.request_id;
    expect(event?.pattern).toBe(command?.pattern);
  });

  it('the pattern really does subsume minLength and maxLength', () => {
    // The module keeps ONE guard where the schema has three rules, on the claim
    // that the pattern implies the other two. Measured, not assumed.
    const request = commandBranch('continue_with_budget')?.properties?.request_id;
    expect(request?.minLength).toBe(1);
    expect(request?.maxLength).toBe(128);

    const ok = 'b'.repeat(128);
    const tooLong = 'b'.repeat(129);
    expect(buildContinueWithBudget({ requestId: ok, additionalTokens: 1 }).ok).toBe(true);
    expect(buildContinueWithBudget({ requestId: tooLong, additionalTokens: 1 }).ok).toBe(false);
    expect(buildContinueWithBudget({ requestId: '', additionalTokens: 1 }).ok).toBe(false);
  });

  it('the token bound is the schema’s maximum, digit for digit', () => {
    // Read as TEXT. `JSON.parse` on this schema returns 18446744073709552000 for
    // a file that says 18446744073709551615 - the two are the same double - so a
    // parsed comparison would pass against the wrong number and prove nothing.
    const raw = readFileSync(join(CONTRACT_V1, 'schema/host-command.schema.json'), 'utf-8');
    const matches = [...raw.matchAll(/"additional_tokens":\{"maximum":(\d+),"minimum":0,"type":"integer"\}/g)];
    expect(matches, 'schema shape changed - re-derive this gate').toHaveLength(1);
    expect(MAX_ADDITIONAL_TOKENS).toBe(BigInt(matches[0][1]));

    // And the parsed form really is lossy, which is why the gate reads text.
    const parsed = commandBranch('continue_with_budget')?.properties?.additional_tokens?.maximum;
    expect(String(parsed)).not.toBe(matches[0][1]);
  });
});

describe('this file’s own bytes', () => {
  /**
   * A regex covering the C0 range was once written with the RAW bytes inside the
   * character class, which put a literal NUL and a literal 0x1F into this source
   * file. It compiled, it passed, and it was invisible in every diff and editor.
   *
   * Source is text: tab, LF and CR are the only control bytes that belong in it.
   */
  it('contains no stray control characters', () => {
    const path = join(process.cwd(), 'tests/unit/wcore-budgetGrants.test.ts');
    const bytes = readFileSync(path);
    // Prove we read THIS file and not an empty/missing one, so the assertion
    // below cannot pass vacuously.
    expect(bytes.toString('utf-8')).toContain('contains no stray control characters');

    const stray = [...bytes]
      .map((byte, offset) => ({ byte, offset }))
      .filter(({ byte }) => byte < 0x09 || (byte > 0x0d && byte < 0x20));
    expect(stray, `stray control bytes at ${JSON.stringify(stray)}`).toEqual([]);
  });
});
