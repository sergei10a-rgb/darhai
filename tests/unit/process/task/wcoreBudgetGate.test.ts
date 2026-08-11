/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's `budget_exceeded` must reach a human, or reach nobody.
 *
 * Before this gate the cap ended the turn with one info line and no way back,
 * even though the engine publishes `continue_with_budget`. The property under
 * test is therefore not "granting works". It is the pair either side of it:
 *
 *  - nothing is ever sent without an explicit press, and
 *  - a press is never OFFERED when the host cannot say honestly what it would
 *    spend. A dialog whose Grant button could only fail is worse than the info
 *    line the user already has, and worse still if the unit it would spend in
 *    is a guess: 2.5 is either two and a half tokens or $2.50.
 *
 * Numbers come from the vendored contract, never from this file - the cap
 * fixture supplies observed/limit and its own schema is the oracle for what a
 * built command may look like.
 */

import { describe, it, expect, vi } from 'vitest';
import { fingerprintBudgetGrant, proposeBudgetGrant, resolveBudgetGrant } from '@process/task/wcoreBudgetGate';
import { MAX_GRANT_COST_USD, MAX_GRANT_TOKENS } from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import type { ToolConfirmationOutcome } from '@process/services/toolConfirmation/types';
import { examplePayload, validateEvent } from '../../../helpers/engineContract';

/** The engine's own `budget_exceeded`: reason `max_tokens_out`, 8192 of 4096. */
const CAPPED = examplePayload('event', 'budget_exceeded') as unknown as {
  reason: string;
  observed: string;
  limit: string;
};

/** A translator that localises one key, to prove the chrome is not hard-coded. */
const mongolianTitle = (key: string, fallback: string): string =>
  key === 'mcp.confirm.budgetGrant.title' ? 'Төсвийг нэмэх үү?' : fallback;

const APPROVED: ToolConfirmationOutcome = { approved: true, requestId: 'r1', fingerprint: 'fp' };
const DECLINED: ToolConfirmationOutcome = {
  approved: false,
  requestId: 'r1',
  reason: 'declined',
  message: 'nothing was granted',
};

function deps(outcome: ToolConfirmationOutcome | (() => Promise<never>), grantOk = true) {
  const shown: Array<Record<string, unknown>> = [];
  const confirm = vi.fn(async (input: Record<string, unknown>) => {
    shown.push(input);
    if (typeof outcome === 'function') return outcome();
    return outcome;
  });
  const grant = vi.fn((input: { requestId: string }) =>
    grantOk
      ? ({ ok: true, requestId: input.requestId } as const)
      : ({ ok: false, reason: 'the engine cannot be reached, so the grant was not sent' } as const)
  );
  return { confirm, grant, shown };
}

describe('the cap fixture these tests are built on', () => {
  it('is a contract-valid budget_exceeded', () => {
    // If this fails, every expectation below describes a shape the engine does
    // not send.
    expect(validateEvent(CAPPED as unknown as Record<string, unknown>).valid).toBe(true);
    expect(CAPPED.reason).toBeTruthy();
  });
});

describe('proposeBudgetGrant: the amount is derived, never invented', () => {
  it('offers exactly the overrun the engine itself reported', () => {
    const proposed = proposeBudgetGrant(CAPPED);

    expect(proposed.ok).toBe(true);
    if (proposed.ok === false) return;
    // 8192 observed of a 4096 limit: the engine's own numbers, subtracted.
    expect(proposed.proposal.tokens).toBe(Number(CAPPED.observed) - Number(CAPPED.limit));
    expect(proposed.proposal.costUsd).toBeUndefined();
  });

  it('reads a money cap in dollars and a token cap in tokens', () => {
    const money = proposeBudgetGrant({ reason: 'max_cost_usd', observed: '3.00', limit: '2.50' });
    expect(money.ok === true && money.proposal).toEqual({ costUsd: 0.5 });

    const tokens = proposeBudgetGrant({ reason: 'max_tokens_in', observed: '10', limit: '4' });
    expect(tokens.ok === true && tokens.proposal).toEqual({ tokens: 6 });
  });

  it('offers nothing for a cap whose unit it cannot name', () => {
    // Granting 2.5 of the wrong unit is the difference between two and a half
    // tokens and $2.50, so an unrecognised cap is refused, not guessed at.
    const unknown = proposeBudgetGrant({ reason: 'max_wall_clock', observed: '10', limit: '4' });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.reason).toContain('no unit');
  });

  it('offers nothing for a cap that names both units', () => {
    const both = proposeBudgetGrant({ reason: 'max_token_cost_usd', observed: '10', limit: '4' });
    expect(both.ok).toBe(false);
    expect(both.ok === false && both.reason).toContain('ambiguous');
  });

  it.each([
    ['$8192', '4096'],
    ['8192', '4 096'],
    ['8e3', '4096'],
    ['', '4096'],
    ['-8192', '4096'],
  ])('offers nothing when observed=%s / limit=%s is not a plain number', (observed, limit) => {
    const parsed = proposeBudgetGrant({ reason: 'max_tokens_out', observed, limit });
    expect(parsed.ok).toBe(false);
  });

  it('offers nothing when there is no overrun to cover', () => {
    // "Exceeded" with nothing over the line is a contradiction, and a 0-token
    // grant is a button that cannot work - the schema requires >= 1.
    const none = proposeBudgetGrant({ reason: 'max_tokens_out', observed: '4096', limit: '4096' });
    expect(none.ok).toBe(false);
    expect(none.ok === false && none.reason).toContain('no overrun');
  });

  it('offers nothing for a cap name that could be either unit', () => {
    // `max_spend` and `max_cost` are names a TOKEN cap plausibly wears, and both
    // used to resolve to MONEY - so a 4096-token overrun would have been offered
    // as "Amount to grant (US$) 4096". Only `usd` and `dollar` name a currency
    // and nothing else, so everything else falls through to "no unit".
    for (const reason of ['max_spend', 'max_cost', 'max_price']) {
      const guessed = proposeBudgetGrant({ reason, observed: '8192', limit: '4096' });
      expect(guessed.ok, reason).toBe(false);
      expect(guessed.ok === false && guessed.reason, reason).toContain('no unit');
    }
    // The unambiguous ones still work, both spellings.
    expect(proposeBudgetGrant({ reason: 'max_spend_usd', observed: '3', limit: '2' }).ok).toBe(true);
    expect(proposeBudgetGrant({ reason: 'max_dollars', observed: '3', limit: '2' }).ok).toBe(true);
  });

  it('offers nothing when a token cap reports a fractional amount', () => {
    // Reachable only with a fractional overrun ABOVE 1: at 0.5 the `< 1` floor
    // catches it anyway, so this is the input that actually defends the
    // safe-integer guard. Without it the dialog would offer "4096.5 tokens" -
    // a figure `buildContinueWithBudget` refuses, i.e. a Grant that can only fail.
    const fractional = proposeBudgetGrant({ reason: 'max_tokens_out', observed: '8192.5', limit: '4096' });
    expect(fractional.ok).toBe(false);
    expect(fractional.ok === false && fractional.reason).toContain('non-integer');
  });

  it('offers nothing above the one-press ceiling, in either unit', () => {
    // MEASURED, and the reason the money ceiling exists: `max_cost_usd` with
    // observed "999999999" against limit "0.01" produced a one-press proposal of
    // US$999,999,998.99, printed by the dialog and put on the wire. The schema
    // bounds `additional_cost_usd` with `minimum: 0` and nothing else.
    const huge = proposeBudgetGrant({ reason: 'max_cost_usd', observed: '999999999', limit: '0.01' });
    expect(huge.ok).toBe(false);
    expect(huge.ok === false && huge.reason).toContain('ceiling');
    expect(huge.ok === false && huge.reason).toContain(`US$${MAX_GRANT_COST_USD}`);

    // The token ceiling is REACHABLE, unlike the contract bound it replaced:
    // both operands are safe integers, so their difference can never approach
    // 2^64-1 and a guard written against that could not fire.
    const many = proposeBudgetGrant({ reason: 'max_tokens_out', observed: '1000000000', limit: '1' });
    expect(many.ok).toBe(false);
    expect(many.ok === false && many.reason).toContain('ceiling');

    // Exactly at the ceiling is still offered - the bound is `>`, not `>=`.
    expect(proposeBudgetGrant({ reason: 'max_tokens_out', observed: String(MAX_GRANT_TOKENS), limit: '0' }).ok).toBe(
      true
    );
    expect(proposeBudgetGrant({ reason: 'max_cost_usd', observed: String(MAX_GRANT_COST_USD), limit: '0' }).ok).toBe(
      true
    );
  });

  it('keeps a dollar overrun free of binary-float noise', () => {
    // 0.3 - 0.1 is 0.19999999999999998 in IEEE-754, and that string would be
    // both what the dialog shows and what goes on the wire.
    const cents = proposeBudgetGrant({ reason: 'max_spend_usd', observed: '0.3', limit: '0.1' });
    expect(cents.ok === true && cents.proposal.costUsd).toBe(0.2);
  });
});

describe('resolveBudgetGrant: nothing is spent without a press', () => {
  it('sends the grant the user approved, and only then', async () => {
    const d = deps(APPROVED);

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(true);
    expect(d.grant).toHaveBeenCalledTimes(1);
    const sent = d.grant.mock.calls[0][0] as {
      requestId: string;
      additionalTokens?: number;
      additionalCostUsd?: number;
    };
    expect(sent.additionalTokens).toBe(4096);
    expect(sent.additionalCostUsd).toBeUndefined();
    expect(sent.requestId).toMatch(/^budget-/);
  });

  it('sends nothing when the user refuses, and says nothing was granted', async () => {
    const d = deps(DECLINED);

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(false);
    expect(d.grant).not.toHaveBeenCalled();
    expect(result.reason).toContain('declined');
  });

  it('never raises a dialog it could not honour', async () => {
    // The whole point of the fail-closed rule: no Grant button appears at all
    // when the host cannot say what pressing it would spend.
    const d = deps(APPROVED);

    const result = await resolveBudgetGrant({ reason: 'max_wall_clock', observed: '10', limit: '4' }, d);

    expect(result.granted).toBe(false);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.grant).not.toHaveBeenCalled();
  });

  it('an answer that is neither true nor false spends nothing', async () => {
    // The gate reads `outcome.approved !== true`, not `=== false`. This repo
    // compiles without strictNullChecks, so a reply that carries no `approved`
    // at all type-checks - and under `=== false` it would fall THROUGH to the
    // send. Default-deny means anything that is not an explicit press is a no.
    const d = deps({ requestId: 'r1' } as unknown as ToolConfirmationOutcome);

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(false);
    expect(result.approved).not.toBe(true);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.grant).not.toHaveBeenCalled();
  });

  it('reports a press that could not be sent instead of claiming a grant', async () => {
    const d = deps(APPROVED, false);

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(false);
    expect(result.reason).toContain('engine cannot be reached');
    // `approved: true` beside `granted: false` is what lets the caller say the
    // one thing the user needs to hear: you pressed, and nothing was sent. With
    // the engine unreachable - the LIKELY state, since a budget cap is what
    // ended the turn - this was previously indistinguishable from a refusal.
    expect(result.approved).toBe(true);
    // ...and the amount rides along, so the notice can name what was not granted.
    expect(result.tokens).toBe(Number(CAPPED.observed) - Number(CAPPED.limit));
    expect(result.costUsd).toBeUndefined();
  });

  it('does not claim a press that never happened when the dialog throws', async () => {
    const d = deps(async () => {
      throw new Error('gate exploded');
    });

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(false);
    // The throw came BEFORE any press, so the caller must not announce an
    // undelivered grant to a user who was never asked.
    expect(result.approved).toBe(false);
  });

  it('grants nothing when the dialog itself throws', async () => {
    const d = deps(async () => {
      throw new Error('gate exploded');
    });

    const result = await resolveBudgetGrant(CAPPED, d);

    expect(result.granted).toBe(false);
    expect(result.reason).toContain('gate exploded');
    expect(d.grant).not.toHaveBeenCalled();
  });
});

describe('what the user is shown before they spend', () => {
  it('labels the amount with its unit and shows exactly what will be sent', async () => {
    const d = deps(APPROVED);

    await resolveBudgetGrant(CAPPED, d);

    const input = d.shown[0] as { kind: string; details: Array<{ labelKey?: string; value: string }> };
    expect(input.kind).toBe('agent.budgetGrant');
    const amountRow = input.details.find((row) => row.labelKey === 'mcp.confirm.budgetGrant.grantTokens');
    expect(amountRow, 'the token amount has no unit-bearing label').toBeTruthy();
    // The value is the wire value, digit for digit - what is shown is what is
    // sent, so a bare "2.5" can never mean one thing on screen and another on
    // the socket.
    const sent = d.grant.mock.calls[0][0] as { additionalTokens?: number };
    expect(amountRow?.value).toBe(String(sent.additionalTokens));
    // ...and no unlabelled money row rides along with it.
    expect(input.details.some((row) => row.labelKey === 'mcp.confirm.budgetGrant.grantCost')).toBe(false);
  });

  it('gives EVERY row a unit, and says the unit was read from the cap name', async () => {
    // Before this, `Used` and `Limit` carried no unit at all, so the whole unit
    // signal on a spend dialog sat in one label - and nothing said the unit had
    // been INFERRED from a string the engine chose.
    const tokenDeps = deps(DECLINED);
    await resolveBudgetGrant(CAPPED, tokenDeps);
    const tokenRows = (tokenDeps.shown[0] as { details: Array<{ labelKey?: string }> }).details.map(
      (row) => row.labelKey
    );
    expect(tokenRows).toEqual([
      'mcp.confirm.budgetGrant.reasonTokens',
      'mcp.confirm.budgetGrant.observedTokens',
      'mcp.confirm.budgetGrant.limitTokens',
      'mcp.confirm.budgetGrant.grantTokens',
    ]);

    const moneyDeps = deps(DECLINED);
    await resolveBudgetGrant({ reason: 'max_cost_usd', observed: '3.00', limit: '2.50' }, moneyDeps);
    const moneyRows = (moneyDeps.shown[0] as { details: Array<{ labelKey?: string }> }).details.map(
      (row) => row.labelKey
    );
    expect(moneyRows).toEqual([
      'mcp.confirm.budgetGrant.reasonCost',
      'mcp.confirm.budgetGrant.observedCost',
      'mcp.confirm.budgetGrant.limitCost',
      'mcp.confirm.budgetGrant.grantCost',
    ]);
    // No row may keep a unitless label: the two sets must not overlap anywhere.
    expect(tokenRows.filter((key) => moneyRows.includes(key))).toEqual([]);
  });

  it('uses the money label for a money cap', async () => {
    const d = deps(APPROVED);

    await resolveBudgetGrant({ reason: 'max_cost_usd', observed: '3.00', limit: '2.50' }, d);

    const input = d.shown[0] as { details: Array<{ labelKey?: string; value: string }> };
    const row = input.details.find((r) => r.labelKey === 'mcp.confirm.budgetGrant.grantCost');
    expect(row?.value).toBe('0.5');
    expect(input.details.some((r) => r.labelKey === 'mcp.confirm.budgetGrant.grantTokens')).toBe(false);
  });

  it('shows the engine cap verbatim as a detail value, never as chrome', async () => {
    const hostile = '<button>Grant</button> [APPROVED] max_tokens_out';
    const d = deps(DECLINED);

    await resolveBudgetGrant({ ...CAPPED, reason: hostile }, d);

    const input = d.shown[0] as { title: string; summary: string; details: Array<{ value: string }> };
    expect(input.details.some((row) => row.value === hostile)).toBe(true);
    expect(input.title).not.toContain('APPROVED');
    expect(input.summary).not.toContain('APPROVED');
  });

  it('truncates a cap name a hostile engine padded to a megabyte', async () => {
    const d = deps(DECLINED);

    await resolveBudgetGrant({ ...CAPPED, reason: `max_tokens_out${'x'.repeat(50_000)}` }, d);

    const input = d.shown[0] as { details: Array<{ value: string }> };
    expect(Math.max(...input.details.map((row) => row.value.length))).toBeLessThan(2_000);
  });

  it('uses translated chrome when a translator is supplied', async () => {
    const d = deps(APPROVED);

    await resolveBudgetGrant(CAPPED, { ...d, t: mongolianTitle });

    expect((d.shown[0] as { title: string }).title).toBe('Төсвийг нэмэх үү?');
  });
});

describe('fingerprintBudgetGrant', () => {
  it('changes when the amount changes, so a press cannot be spent on a bigger one', () => {
    const base = fingerprintBudgetGrant(CAPPED, { tokens: 4096 });
    expect(fingerprintBudgetGrant(CAPPED, { tokens: 4097 })).not.toBe(base);
    expect(fingerprintBudgetGrant(CAPPED, { costUsd: 4096 })).not.toBe(base);
    expect(fingerprintBudgetGrant({ ...CAPPED, reason: 'max_cost_usd' }, { tokens: 4096 })).not.toBe(base);
    expect(fingerprintBudgetGrant(CAPPED, { tokens: 4096 })).toBe(base);
  });
});
