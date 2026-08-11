/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Answer the engine's `budget_exceeded` by asking the person who pays.
 *
 * What was wrong
 * --------------
 * The engine stops a turn when an execution budget is exhausted and publishes a
 * way back: `continue_with_budget` out, `budget_grant_result` in. Darhai spoke
 * neither. `WCoreAgent` printed one info line - "Budget exceeded: max_tokens_out
 * (observed 8192, limit 4096)" - and the turn was simply over; the only recourse
 * was to start again. The command builder, its request_id ledger and the decoder
 * for the answer all existed (`capabilities/handlers/budgetGrants.ts`) and had
 * zero call sites.
 *
 * This module is the missing step: the one where a human is asked. It is the
 * budget twin of `wcoreApprovalGate.ts` and follows it deliberately - same
 * confirmation dialog, same fail-closed rules, same thin-module/thin-call-site
 * split - so money and tools go through one gate rather than two.
 *
 * The amount is DERIVED, and what that does NOT settle
 * ----------------------------------------------------
 * `budget_exceeded` carries no proposed grant: only the cap that was hit and
 * the observed/limit pair, both as strings. So the host has to propose a figure,
 * and the least-invented figure available is the overrun the engine itself
 * reported - `observed - limit`. Anything rounder (double the limit, "+10%") is
 * a number this host made up on a spend dialog. If the overrun cannot be
 * computed, or the unit it is measured in cannot be told from the cap's name,
 * NO DIALOG IS RAISED: a dialog whose Grant button can only fail is worse than
 * the info line the user already has.
 *
 * What the overrun does NOT settle is whether the turn can then make progress,
 * and this module must not pretend otherwise. `additional_tokens` has NO stated
 * semantics anywhere in the vendored contract - I read all of it for this:
 * `commands/continue_with_budget.json` is a bare example with no description,
 * both compat variants likewise, `manifest.json` files the command with only
 * capability/criticality/correlation, `host-command.schema.json` types the field
 * `{"maximum":18446744073709551615,"minimum":0,"type":"integer"}`, and
 * `budget_exceeded.reason` is a bare `{"type":"string"}`. So:
 *   - if the field RAISES the ceiling (the reading its name supports), granting
 *     `observed - limit` sets the new ceiling to exactly what has been spent -
 *     zero headroom, and the resumed turn re-trips on its next token;
 *   - if it TOPS UP from the current position, the figure covers the overrun.
 * Nothing in the bundle picks between those. The losing branch is a loop -
 * cap, dialog, grant, cap - so it is BOUNDED rather than assumed away:
 * {@link MAX_BUDGET_GRANTS_PER_SESSION} caps how many grants one session may
 * send, and `WCoreManager` de-dupes an identical cap that is already on screen.
 * Both bounds are host-side picks; neither is a claim about the engine.
 *
 * Refusing is the default for everything that is not an explicit press
 * --------------------------------------------------------------------
 * Timeout, no window, a closing app, a broken dialog, an unsendable command -
 * each ends as "nothing was granted", with a reason. Unlike the approval gate
 * there is nothing to answer the engine WITH on a refusal: a budget grant is an
 * offer the host makes, so declining it means staying silent, and the turn is
 * already over either way.
 */

import { createHash } from 'node:crypto';
import {
  MAX_GRANT_COST_USD,
  MAX_GRANT_TOKENS,
  mintBudgetRequestId,
} from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import type {
  ContinueWithBudgetInput,
  SendGrantOutcome,
} from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import { describeDenial } from '@process/services/toolConfirmation/types';
import type { ToolConfirmationOutcome, ToolConfirmationRequestInput } from '@process/services/toolConfirmation/types';

/** The engine event this module answers, camel-cased as `WCoreAgent` forwards it. */
export type EngineBudgetRequest = {
  /** The cap that was hit, e.g. `max_tokens_out`. Free-form in the schema. */
  reason: string;
  /** What was spent, as the engine wrote it - a string, per the contract. */
  observed: string;
  /** The cap's value, likewise a string. */
  limit: string;
};

/**
 * What the host offers to add. Both fields are optional and at least one is
 * always present, mirroring `continue_with_budget`'s `anyOf`.
 */
export type BudgetProposal = { tokens?: number; costUsd?: number };

export type BudgetProposalOutcome = { ok: true; proposal: BudgetProposal } | { ok: false; reason: string };

export type BudgetGrantDeps = {
  /** Raise the dialog. Same service the MCP tool gate and the approval gate use. */
  confirm: (input: ToolConfirmationRequestInput) => Promise<ToolConfirmationOutcome>;
  /** Send `continue_with_budget`. Owns the request_id ledger and the delivery probe. */
  grant: (input: ContinueWithBudgetInput) => SendGrantOutcome;
  /** Localised chrome. Falls back to English when a translator is absent. */
  t?: (key: string, fallback: string) => string;
};

/**
 * Result, for the caller's logging and for tests to assert on.
 *
 * `approved` is the HUMAN's press, and it is separate from `granted` on purpose.
 * The two disagree in exactly one place and it is the dangerous one: the user
 * pressed Grant and the command did not leave the process (the engine is gone -
 * which is the LIKELY state, since a budget cap is what ended the turn). Without
 * this field the caller cannot tell that case from "the user said no", and the
 * screen looks identical either way. See `WCoreManager.resolveBudgetGrant`.
 */
export type BudgetGrantDecision = {
  granted: boolean;
  approved?: boolean;
  requestId?: string;
  reason?: string;
  /** What the press was FOR, carried only when it was approved and not sent. */
  tokens?: number;
  costUsd?: number;
};

/**
 * How many grants one session may actually send.
 *
 * A HOST-SIDE PICK, stated as one - the contract states no such bound. It exists
 * because of the semantic gap described in this module's header: a granted cap
 * can be re-tripped by the resumed turn with different numbers, which is a new
 * cap key and therefore a new dialog, so nothing else in the host bounds
 * cap-dialog-grant-cap. Four is above any run of genuine consecutive overruns a
 * user would sit through and far below a loop that bills.
 *
 * At the cap the gate is not silently disabled: `WCoreManager` says so once, in
 * the transcript, because a feature that stops offering without saying so is the
 * same silence this whole surface exists to remove.
 */
export const MAX_BUDGET_GRANTS_PER_SESSION = 4;

/**
 * Why a grant the user pressed for never reached the engine.
 *
 * `undelivered` - the press happened and the command could not be sent.
 * `session_limit` - {@link MAX_BUDGET_GRANTS_PER_SESSION} is used up, so no
 * dialog was raised at all.
 */
export type BudgetGrantNotSentCode = 'undelivered' | 'session_limit';

/** The frame `WCoreManager` emits so a host-side failure reaches the transcript. */
export const BUDGET_GRANT_NOT_SENT = 'budget_grant_not_sent';

/**
 * What that frame carries.
 *
 * The amounts ride along so the notice can say WHAT was not granted; `detail` is
 * the gate's own English reason, shown the way `host_send_message_request`
 * already shows a transport error - diagnostic, beside a translated sentence.
 */
export type BudgetGrantNotSentFrameData = {
  code: BudgetGrantNotSentCode;
  detail?: string;
  tokens?: number;
  costUsd?: number;
};

/**
 * Words in a cap's name that say which unit it is measured in.
 *
 * MEASURED, AND THIN. The contract types `budget_exceeded.reason` as a plain
 * string and ships exactly one example - `max_tokens_out` - so there is no enum
 * to switch on and no second sample to generalise from. These lists are
 * therefore a reading of names, kept deliberately small: a cap that matches
 * neither list, or BOTH, is refused rather than guessed at. Granting 2.5 of the
 * wrong unit is the difference between two and a half tokens and $2.50.
 *
 * NARROWED, and this is the fix to a real misread. The money list used to carry
 * `cost`, `spend` and `price`, which are all words a TOKEN cap plausibly wears:
 * `max_spend` and `max_cost` both resolved to money, so a 4096-TOKEN overrun
 * would have been offered as "Amount to grant (US$) 4096". Only `usd` and
 * `dollar` name a currency and nothing else, so only those two survive; every
 * other name now falls through to "no unit this host recognises" and raises no
 * dialog. That is a feature lost on ambiguous names and a misread prevented on
 * the one dialog that spends money.
 *
 * The user is told, too. The inference does not stay inside this module: the
 * dialog's own labels say the unit was READ FROM THE CAP'S NAME (see the
 * `reasonTokens` / `reasonCost` rows below), so a person can see where the
 * dollar sign came from.
 */
const TOKEN_MARKERS = ['token'] as const;
const MONEY_MARKERS = ['usd', 'dollar'] as const;

/**
 * A number as the engine writes one: plain decimal digits, optionally with a
 * fractional part.
 *
 * Deliberately narrow. `Number('$2.50')` is NaN but `Number(' 2.50 ')` is 2.5
 * and `Number('2e3')` is 2000 - accepting either would mean this host decided
 * what a currency-formatted or exponent-formatted budget means. A string this
 * pattern rejects ends as "no dialog", which is the honest answer.
 */
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/** A cap name is a short identifier; anything longer is not one, and must not fill the dialog. */
const MAX_REASON_CHARS = 1_000;

function parseAmount(value: unknown): number | null {
  if (typeof value !== 'string' || !PLAIN_NUMBER.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Kill binary-float noise in a USD difference.
 *
 * `0.3 - 0.1` is `0.19999999999999998` in IEEE-754, and that string would be
 * both what the dialog shows and what goes on the wire. Six decimals is the
 * micro-dollar the engine's own cost events already work in, so this is a
 * rounding of representation, not a change of amount.
 */
function roundMicroDollars(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Work out what to offer for one `budget_exceeded`, or say why nothing can be.
 *
 * Split out from {@link resolveBudgetGrant} so the arithmetic and the
 * fail-closed rules can be tested without a dialog, an engine or a window.
 */
export function proposeBudgetGrant(request: EngineBudgetRequest): BudgetProposalOutcome {
  const rawReason = typeof request.reason === 'string' ? request.reason : '';
  if (rawReason.length === 0) return { ok: false, reason: 'the engine did not say which cap was hit' };

  const reason = rawReason.toLowerCase();
  const isTokenCap = TOKEN_MARKERS.some((marker) => reason.includes(marker));
  const isMoneyCap = MONEY_MARKERS.some((marker) => reason.includes(marker));
  if (isTokenCap && isMoneyCap) {
    return {
      ok: false,
      reason: `cap "${rawReason}" names both tokens and money, so the unit to grant in is ambiguous`,
    };
  }
  if (!isTokenCap && !isMoneyCap) {
    return { ok: false, reason: `cap "${rawReason}" names no unit this host recognises` };
  }

  const observed = parseAmount(request.observed);
  const limit = parseAmount(request.limit);
  if (observed === null || limit === null) {
    return {
      ok: false,
      reason: `observed "${String(request.observed)}" / limit "${String(request.limit)}" are not plain numbers`,
    };
  }

  if (isTokenCap) {
    // Both sides must be exact integers, or the difference is not a token count.
    if (!Number.isSafeInteger(observed) || !Number.isSafeInteger(limit)) {
      return { ok: false, reason: `token cap "${rawReason}" reported non-integer amounts` };
    }
    const tokens = observed - limit;
    // `>= 1` is the schema's own floor for a qualifying grant. A cap reported as
    // exceeded with nothing over it is a contradiction, and offering 0 tokens is
    // a button that cannot work.
    if (tokens < 1)
      return { ok: false, reason: `cap "${rawReason}" reports no overrun to cover (${observed} of ${limit})` };
    // The one-press ceiling, not the contract's. The contract bound (2^64-1) is
    // UNREACHABLE from here - both operands passed `Number.isSafeInteger`, so
    // their difference is at most 2^53-1 - and a guard that cannot fire defends
    // nothing. `MAX_GRANT_TOKENS` is reachable: observed 1e9 against limit 1 is
    // an overrun ten times over it. The wire-level bound still lives in
    // `buildContinueWithBudget`, which is where a non-gate caller would meet it.
    if (tokens > MAX_GRANT_TOKENS) {
      return { ok: false, reason: `the overrun (${tokens} tokens) is over the ${MAX_GRANT_TOKENS} one-grant ceiling` };
    }
    return { ok: true, proposal: { tokens } };
  }

  const costUsd = roundMicroDollars(observed - limit);
  if (!(costUsd > 0)) {
    return { ok: false, reason: `cap "${rawReason}" reports no overrun to cover (${observed} of ${limit})` };
  }
  // The money side had NO ceiling at all, on the module whose header says money
  // moves through it. MEASURED before this line existed: reason `max_cost_usd`,
  // observed "999999999", limit "0.01" produced a one-press proposal of
  // US$999,999,998.99, and a 21-digit observed produced 1e+21 - which is
  // literally what the dialog printed and what would have gone on the wire.
  // Both figures are parsed from strings the ENGINE wrote.
  if (costUsd > MAX_GRANT_COST_USD) {
    return { ok: false, reason: `the overrun (US$${costUsd}) is over the US$${MAX_GRANT_COST_USD} one-grant ceiling` };
  }
  return { ok: true, proposal: { costUsd } };
}

/**
 * Bind the approval to the exact figures the user saw.
 *
 * The approval gate hashes the request text; here the AMOUNT is the thing that
 * must not change underneath a press. A dialog answered late must not be
 * spendable against a different cap, and - the reason this exists at all - not
 * against a larger number than the one on screen.
 */
export function fingerprintBudgetGrant(request: EngineBudgetRequest, proposal: BudgetProposal): string {
  const parts = [
    request.reason,
    request.observed,
    request.limit,
    proposal.tokens === undefined ? '' : String(proposal.tokens),
    proposal.costUsd === undefined ? '' : String(proposal.costUsd),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

/**
 * Ask, then send at most one `continue_with_budget`. Never throws: a throw here
 * would leave the user with a dialog and no answer on a spend decision.
 */
export async function resolveBudgetGrant(
  request: EngineBudgetRequest,
  deps: BudgetGrantDeps
): Promise<BudgetGrantDecision> {
  const t = deps.t ?? ((_key: string, fallback: string) => fallback);
  // Set the moment the human's press is known, so the catch below can still
  // tell "nothing was offered" from "they pressed and it went wrong".
  let pressed = false;

  try {
    const proposed = proposeBudgetGrant(request);
    // `=== false` rather than `!proposed.ok`: this repo compiles without
    // strictNullChecks, where only an explicit comparison narrows a union.
    if (proposed.ok === false) {
      // No dialog at all. The user still has the engine's own "Budget exceeded"
      // line in the transcript; what they must not get is a Grant button that
      // could only ever fail, on the one dialog that spends money.
      return { granted: false, reason: proposed.reason };
    }

    const proposal = proposed.proposal;
    const isTokens = proposal.tokens !== undefined;

    const outcome = await deps.confirm({
      kind: 'agent.budgetGrant',
      // No tool asked for this - the engine's own cap did. The dialog renders a
      // dedicated footer for this kind rather than "Requested by <tool>"; the
      // cap name is carried here too so the gate's own logs name it.
      toolName: request.reason || 'budget',
      title: t('mcp.confirm.budgetGrant.title', 'Raise the budget?'),
      summary: t(
        'mcp.confirm.budgetGrant.summary',
        'The engine stopped because a budget cap was reached. Whether the paused turn resumes is the engine’s decision.'
      ),
      confirmLabel: t('mcp.confirm.budgetGrant.confirm', 'Grant'),
      // `labelKey` so the renderer translates the field name; `label` is the
      // fallback. The main process has no translator of its own.
      details: [
        // EVERY row names the unit, and the cap row also names where the unit
        // came from. Before this, "Used" and "Limit" carried no unit at all and
        // the entire unit signal sat in one label derived from `reason` - so a
        // user reading "Cap reached: max_spend / Used 8192 / Limit 4096 / Amount
        // to grant (US$) 4096" saw three consistent numbers with no way to
        // notice that the dollar sign came from a substring match on a string
        // the ENGINE chose. The label says "read from this name" because that is
        // what happened; the concession the marker lists make in their own
        // comment now reaches the person pressing the button.
        {
          labelKey: isTokens ? 'mcp.confirm.budgetGrant.reasonTokens' : 'mcp.confirm.budgetGrant.reasonCost',
          label: isTokens
            ? 'Cap reached (read as a token cap from this name)'
            : 'Cap reached (read as a US$ cap from this name)',
          value: truncate(request.reason, MAX_REASON_CHARS),
        },
        {
          labelKey: isTokens ? 'mcp.confirm.budgetGrant.observedTokens' : 'mcp.confirm.budgetGrant.observedCost',
          label: isTokens ? 'Used (tokens)' : 'Used (US$)',
          value: request.observed,
        },
        {
          labelKey: isTokens ? 'mcp.confirm.budgetGrant.limitTokens' : 'mcp.confirm.budgetGrant.limitCost',
          label: isTokens ? 'Limit (tokens)' : 'Limit (US$)',
          value: request.limit,
        },
        // The unit lives in the LABEL, because the value must be exactly the
        // number that goes on the wire - a bare "2.5" under a label that does
        // not say US$ is the misread this row exists to prevent.
        ...(proposal.tokens === undefined
          ? []
          : [
              {
                labelKey: 'mcp.confirm.budgetGrant.grantTokens',
                label: 'Tokens to grant',
                value: String(proposal.tokens),
              },
            ]),
        ...(proposal.costUsd === undefined
          ? []
          : [
              {
                labelKey: 'mcp.confirm.budgetGrant.grantCost',
                label: 'Amount to grant (US$)',
                value: String(proposal.costUsd),
              },
            ]),
      ],
      fingerprint: fingerprintBudgetGrant(request, proposal),
    });

    // `!== true`, never `=== false`. `ToolConfirmationOutcome` is a union whose
    // approving member requires `approved: true`, but this repo compiles without
    // strictNullChecks and a malformed reply that carries no `approved` at all
    // reaches here as neither: `=== false` would then fall THROUGH to the send.
    // Default-deny on a spend dialog means "anything that is not an explicit
    // true is a no", and the test named for that mutation is
    // "an answer that is neither true nor false spends nothing".
    if (outcome.approved !== true) {
      // Nothing to tell the engine. A budget grant is an offer this host makes;
      // not making it is the whole of the refusal.
      return { granted: false, reason: describeDenial(outcome) || 'not approved' };
    }
    pressed = true;

    const sent = deps.grant({
      requestId: mintBudgetRequestId(),
      additionalTokens: proposal.tokens,
      additionalCostUsd: proposal.costUsd,
    });
    // `approved: true` beside `granted: false` is the whole point: the press
    // happened and nothing was sent, which the caller must say out loud.
    if (sent.ok === false) return { granted: false, approved: true, reason: sent.reason, ...amountOf(proposal) };
    return { granted: true, approved: true, requestId: sent.requestId };
  } catch (error) {
    // A throw from the dialog or the send path must still end as "nothing was
    // granted", and must say so - not as an unhandled rejection in the main
    // process while the user believes they raised the cap.
    return {
      granted: false,
      approved: pressed,
      reason: `the budget grant could not be offered (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** The proposal as decision fields, so an unsent grant can name what it was. */
function amountOf(proposal: BudgetProposal): { tokens?: number; costUsd?: number } {
  const out: { tokens?: number; costUsd?: number } = {};
  if (proposal.tokens !== undefined) out.tokens = proposal.tokens;
  if (proposal.costUsd !== undefined) out.costUsd = proposal.costUsd;
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…`;
}
