/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The budget grant, in the dialog that already answers tool approvals.
 *
 * What this is testing
 * --------------------
 * When the engine reports `budget_exceeded` the turn dies today with no way
 * back. The way back is `continue_with_budget`, and sending it spends money -
 * so it is raised through the SAME default-deny confirmation dialog as an MCP
 * tool asking to send mail, under the same rules: nothing happens without an
 * explicit press, and every non-press outcome is a refusal.
 *
 * Where the numbers come from
 * ---------------------------
 * Every figure in these dialogs is read out of the vendored engine contract
 * (`tests/fixtures/engine-contract`), never typed here: `budget_exceeded`
 * supplies the cap that was hit and the observed/limit pair, and the engine's
 * own `budget_grant_result` example supplies the amount. A test that invented
 * "8192" would still pass if the contract changed shape underneath it.
 *
 * Where the copy comes from
 * -------------------------
 * The `t` mock resolves against the SHIPPED `en-US` bundle rather than a table
 * written in this file, so a key that never landed in the locale resolves to
 * its own name and the assertions fail. The last test extends that to all 13
 * locales, because "Mongolian" that is English left in place is the failure
 * mode i18n checks do not catch.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { examplePayload, validateEvent } from '../../helpers/engineContract';
// The published enum, so the locale sweep cannot drift from what the decoder
// can actually hand the renderer.
import { BUDGET_REFUSAL_REASONS } from '../../../src/process/agent/wcore/capabilities/handlers/budgetGrants';

const LOCALES_DIR = join(process.cwd(), 'src/renderer/services/i18n/locales');

const bridgeMocks = vi.hoisted(() => ({
  respond: vi.fn(async () => ({ settled: true })),
  listPending: vi.fn(async () => [] as unknown[]),
  requestHandlers: [] as Array<(request: unknown) => void>,
  cancelHandlers: [] as Array<(payload: { requestId: string }) => void>,
}));

vi.mock('../../../src/common', () => ({
  ipcBridge: {
    toolConfirmation: {
      request: {
        on: (handler: (request: unknown) => void) => {
          bridgeMocks.requestHandlers.push(handler);
          return (): void => undefined;
        },
      },
      cancel: {
        on: (handler: (payload: { requestId: string }) => void) => {
          bridgeMocks.cancelHandlers.push(handler);
          return (): void => undefined;
        },
      },
      respond: { invoke: bridgeMocks.respond },
      listPending: { invoke: bridgeMocks.listPending },
    },
  },
}));

/**
 * `t`, backed by the real English bundle.
 *
 * The factory is async and reads the locale itself because a `vi.mock` factory
 * runs before this module's own body: a table built at the top of the file
 * would still be in its temporal dead zone when the component imports i18n.
 */
vi.mock('react-i18next', async () => {
  const { readFileSync: read, existsSync: exists } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const dir = joinPath(process.cwd(), 'src/renderer/services/i18n/locales/en-US');

  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown> & { defaultValue?: string }) => {
        const [namespace, ...path] = key.split('.');
        const file = joinPath(dir, `${namespace}.json`);
        let node: unknown = exists(file) ? JSON.parse(read(file, 'utf-8')) : undefined;
        for (const segment of path) {
          node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
        }
        let out = typeof node === 'string' ? node : (options?.defaultValue ?? key);
        for (const [name, value] of Object.entries(options ?? {})) {
          if (name === 'defaultValue') continue;
          out = out.replace(new RegExp(`{{${name}}}`, 'g'), String(value));
        }
        return out;
      },
    }),
  };
});

vi.mock('../../../src/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ fontScale: 1 }),
}));

import ToolConfirmationDialog from '../../../src/renderer/components/agent/ToolConfirmationDialog';

/** The same lookup the mock does, for assertions. Kept separate on purpose - see the mock's note. */
function en(key: string): string {
  const [namespace, ...path] = key.split('.');
  const file = join(LOCALES_DIR, 'en-US', `${namespace}.json`);
  let node: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : undefined;
  for (const segment of path) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`en-US has no string at "${key}"`);
  return node;
}

/** The cap the engine reported, verbatim from the contract. */
const CAPPED = examplePayload('event', 'budget_exceeded');
/** The engine's own example grant - used as the amount the host proposes, so no figure here is invented. */
const GRANTED = examplePayload('event', 'budget_grant_result');

type Detail = { label: string; labelKey?: string; value: string };

/**
 * The over-promise FAMILY, not one phrasing.
 *
 * This guard was `/will (resume|continue)/`, which the verb en-US actually uses
 * walks straight past: a locale shipping "the turn will carry on" would have
 * passed it. The forbidden claim is "the paused turn WILL come back", however
 * the verb is spelled - so the pattern is anchored on the promise (`will`) and
 * lists the verbs the copy in this family reaches for. The permission-shaped
 * hedge en-US does ship ("you can grant more and let it carry on") is not a
 * promise and must stay legal.
 */
const OVER_PROMISE =
  /\bwill\s+(?:then\s+|automatically\s+|just\s+)?(resume|continue|carry on|carry it on|keep going|go on|pick up|proceed|restart|finish)/;

/**
 * The confirmation request a budget gate raises for one `budget_exceeded`.
 *
 * `title` / `summary` / `confirmLabel` are deliberately the plain fallbacks the
 * sender must always supply: if the dialog ever showed them for this kind, the
 * localised chrome would have silently stopped resolving.
 */
function budgetRequest(overrides: Record<string, unknown> = {}) {
  const details: Detail[] = [
    // The token variants, because this fixture is `max_tokens_out`. Every row
    // carries its unit and the cap row says the unit was READ FROM THE NAME -
    // the gate infers it from a free-form string the engine wrote, and the
    // person pressing Grant is entitled to know that.
    {
      labelKey: 'mcp.confirm.budgetGrant.reasonTokens',
      label: 'Cap reached (read as a token cap from this name)',
      value: String(CAPPED.reason),
    },
    { labelKey: 'mcp.confirm.budgetGrant.observedTokens', label: 'Used (tokens)', value: String(CAPPED.observed) },
    { labelKey: 'mcp.confirm.budgetGrant.limitTokens', label: 'Limit (tokens)', value: String(CAPPED.limit) },
    // BOTH halves of the engine's own example grant. `continue_with_budget`
    // carries either or both, and the two are not interchangeable: 2.5 is
    // either two and a half tokens or $2.50, so each rides a label that names
    // its unit rather than one shared "Amount to grant".
    {
      labelKey: 'mcp.confirm.budgetGrant.grantTokens',
      label: 'Tokens to grant',
      value: String(GRANTED.additional_tokens),
    },
    {
      labelKey: 'mcp.confirm.budgetGrant.grantCost',
      label: 'Amount to grant (US$)',
      value: String(GRANTED.additional_cost_usd),
    },
  ];
  return {
    requestId: 'budget-req-1',
    kind: 'agent.budgetGrant',
    toolName: 'budget',
    title: 'untranslated fallback title',
    summary: 'untranslated fallback summary',
    confirmLabel: 'untranslated fallback confirm',
    fingerprint: 'fp-budget-1',
    details,
    ...overrides,
  };
}

/** Deliver the request the way the main process does: through the bridge listener. */
function raise(request: ReturnType<typeof budgetRequest>): void {
  act(() => {
    for (const handler of bridgeMocks.requestHandlers) handler(request);
  });
}

describe('budget grant in the confirmation dialog', () => {
  beforeEach(() => {
    bridgeMocks.respond.mockReset();
    bridgeMocks.respond.mockResolvedValue({ settled: true });
    bridgeMocks.listPending.mockClear();
    bridgeMocks.requestHandlers.length = 0;
    bridgeMocks.cancelHandlers.length = 0;
    document.title = 'darhai-test';
  });

  it('drives the dialog from a contract-valid budget_exceeded payload', () => {
    // If this ever fails, every other test in the file is describing a shape
    // the engine does not send.
    expect(validateEvent(CAPPED).valid).toBe(true);
    expect(validateEvent(GRANTED).valid).toBe(true);
    expect(CAPPED.reason).toBeTruthy();
  });

  it('shows the engine numbers under localised labels, not the sender fallbacks', async () => {
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());

    expect(await screen.findByText(en('mcp.confirm.budgetGrant.title'))).toBeTruthy();
    expect(screen.getByText(en('mcp.confirm.budgetGrant.summary'))).toBeTruthy();
    expect(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') })).toBeTruthy();
    expect(screen.queryByText('untranslated fallback title')).toBeNull();

    // The cap, as the engine reported it.
    expect(screen.getByText(String(CAPPED.reason))).toBeTruthy();
    expect(screen.getByText(String(CAPPED.observed))).toBeTruthy();
    expect(screen.getByText(String(CAPPED.limit))).toBeTruthy();
    expect(screen.getByText(String(GRANTED.additional_tokens))).toBeTruthy();

    // Field names are translated, because this request is raised by the app.
    expect(screen.getByText(en('mcp.confirm.budgetGrant.observedTokens'))).toBeTruthy();
    expect(screen.getByText(en('mcp.confirm.budgetGrant.limitTokens'))).toBeTruthy();
    // ...and each one names the unit, so no figure on this dialog is unitless.
    for (const key of ['observedTokens', 'limitTokens', 'reasonTokens']) {
      expect(en(`mcp.confirm.budgetGrant.${key}`).toLowerCase(), key).toContain('token');
    }
  });

  it('tells tokens from dollars, and shows both halves of a two-quantity grant', async () => {
    // The contract's own example grant is `{additional_cost_usd: 2.5,
    // additional_tokens: 250000}`. A dialog with one unitless "Amount" row
    // shows a bare 2.5 that could be 2.5 tokens, and silently drops the money.
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    const rows = [...document.querySelectorAll('dl > div')].map((row) => ({
      label: row.querySelector('dt')?.textContent,
      value: row.querySelector('dd')?.textContent,
    }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { label: en('mcp.confirm.budgetGrant.grantTokens'), value: String(GRANTED.additional_tokens) },
        { label: en('mcp.confirm.budgetGrant.grantCost'), value: String(GRANTED.additional_cost_usd) },
      ])
    );
    // Each label names its unit; neither can be read as the other.
    expect(en('mcp.confirm.budgetGrant.grantTokens')).not.toBe(en('mcp.confirm.budgetGrant.grantCost'));
    expect(en('mcp.confirm.budgetGrant.grantCost')).toMatch(/US\$|\$/);
  });

  it('names what asked, and it is not a tool called "budget"', async () => {
    // A budget cap has no requesting tool. The shared "Requested by {{tool}}"
    // line would print the placeholder word the sender had to invent, on the
    // one line whose job is to answer "what asked?".
    render(<ToolConfirmationDialog />);
    raise(budgetRequest({ toolName: 'budget' }));

    await screen.findByText(en('mcp.confirm.budgetGrant.title'));
    expect(screen.getByText(en('mcp.confirm.budgetGrant.footer'))).toBeTruthy();
    expect(screen.queryByText('Requested by budget')).toBeNull();
  });

  it('promises nothing about the paused turn resuming', async () => {
    // The contract is silent on whether `continue_with_budget` revives the turn
    // that was cut off - `refusal_reason: turn_in_progress` even hints it may
    // not - so the copy must not say it does. This is a claim about words, and
    // words are the whole product here, so it is asserted on the text the user
    // actually sees rather than on the bundle alone.
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    const rendered = (await screen.findByText(en('mcp.confirm.budgetGrant.summary'))).textContent ?? '';

    const summary = rendered.toLowerCase();
    expect(summary).toContain('engine');
    expect(summary).toMatch(/decision|decides/);
    expect(summary).not.toMatch(OVER_PROMISE);
  });

  it('sends nothing until the grant button is pressed', async () => {
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    expect(bridgeMocks.respond).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));
    expect(bridgeMocks.respond).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.respond).toHaveBeenCalledWith({ requestId: 'budget-req-1', approved: true });
  });

  it('treats Cancel and closing as refusals - money is never spent by dismissal', async () => {
    const { unmount } = render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.cancel') }));
    expect(bridgeMocks.respond).toHaveBeenCalledWith({ requestId: 'budget-req-1', approved: false });
    unmount();

    bridgeMocks.respond.mockClear();
    bridgeMocks.requestHandlers.length = 0;
    render(<ToolConfirmationDialog />);
    raise(budgetRequest({ requestId: 'budget-req-2' }));
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('common.close') }));
    expect(bridgeMocks.respond).toHaveBeenCalledWith({ requestId: 'budget-req-2', approved: false });
  });

  it('says "unknown" for a figure it did not receive, never 0', async () => {
    render(<ToolConfirmationDialog />);
    raise(
      budgetRequest({
        details: [
          { labelKey: 'mcp.confirm.budgetGrant.limitTokens', label: 'Limit (tokens)', value: '' },
          { labelKey: 'mcp.confirm.budgetGrant.grantTokens', label: 'Tokens to grant', value: '' },
        ],
      })
    );

    await screen.findByText(en('mcp.confirm.budgetGrant.title'));
    const values = [...document.querySelectorAll('dd')].map((node) => node.textContent);
    expect(values).toEqual([en('mcp.confirm.budgetGrant.unknown'), en('mcp.confirm.budgetGrant.unknown')]);
    // Not "(empty)" - that reads as a field the engine left blank - and above
    // all not a zero, which on a spend dialog reads as a real amount.
    expect(values).not.toContain(en('mcp.confirm.emptyValue'));
    expect(values).not.toContain('0');
  });

  it.each([
    [' ', 'a single space'],
    ['\t', 'a tab'],
    ['  \n ', 'spaces and a newline'],
  ])('says "unknown" for %s too, not a blank box', async (blank) => {
    // `value.length > 0` passed these straight through into a
    // `whitespace-pre-wrap` cell, which paints an EMPTY box on a spend dialog -
    // the exact misread the unknown override exists to prevent. Not
    // hypothetical: the contract ships an adversarial budget fixture whose
    // request_id is a raw TAB.
    render(<ToolConfirmationDialog />);
    raise(
      budgetRequest({
        details: [{ labelKey: 'mcp.confirm.budgetGrant.limitTokens', label: 'Limit (tokens)', value: blank }],
      })
    );

    await screen.findByText(en('mcp.confirm.budgetGrant.title'));
    expect(document.querySelector('dd')?.textContent).toBe(en('mcp.confirm.budgetGrant.unknown'));
  });

  it('keeps "(empty)" for the kinds that are not about money', async () => {
    render(<ToolConfirmationDialog />);
    raise(budgetRequest({ kind: 'email.send', details: [{ label: 'Subject', value: '' }] }));

    await screen.findByText(en('mcp.confirm.emailSend.title'));
    expect(document.querySelector('dd')?.textContent).toBe(en('mcp.confirm.emptyValue'));
  });

  it('says the details are missing instead of rendering a blank body', async () => {
    render(<ToolConfirmationDialog />);
    raise(budgetRequest({ details: [] }));

    expect(await screen.findByText(en('mcp.confirm.noDetails'))).toBeTruthy();
    expect(document.querySelectorAll('dd')).toHaveLength(0);
    // Still refusable: an empty dialog must not be a trap.
    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.cancel') }));
    expect(bridgeMocks.respond).toHaveBeenCalledWith({ requestId: 'budget-req-1', approved: false });
  });

  it('reports a grant that never reached the main process, and allows a retry', async () => {
    bridgeMocks.respond.mockRejectedValueOnce(new Error('bridge is gone'));
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));

    // The user pressed a button that spends money and it did not land. Saying
    // nothing here would leave them believing the budget was raised.
    expect(await screen.findByText(en('mcp.confirm.answerUndelivered'))).toBeTruthy();
    expect(screen.getByText(en('mcp.confirm.budgetGrant.title'))).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));
    expect(bridgeMocks.respond).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(en('mcp.confirm.budgetGrant.title'))).toBeNull());
  });

  it('reports a grant the gate had already expired', async () => {
    bridgeMocks.respond.mockResolvedValueOnce({ settled: false });
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));

    // `settled: false` means the gate had already answered this request on its
    // own timeout - i.e. denied it. That is a different sentence from "we could
    // not deliver your answer", and only one of the two is worth retrying.
    expect(await screen.findByText(en('mcp.confirm.answerExpired'))).toBeTruthy();
    expect(screen.queryByText(en('mcp.confirm.answerUndelivered'))).toBeNull();
  });

  it('stops offering a Grant that can only fail once the request has expired', async () => {
    bridgeMocks.respond.mockResolvedValue({ settled: false });
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));
    await screen.findByText(en('mcp.confirm.answerExpired'));

    // The gate settles a request exactly once, so every further press returns
    // the same terminal error. Re-enabling the button after the failure made a
    // dead end look like a retry.
    const grant = screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') });
    expect((grant as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(grant);
    expect(bridgeMocks.respond).toHaveBeenCalledTimes(1);

    // ...and the way out the copy names actually works.
    expect(en('mcp.confirm.answerExpired').toLowerCase()).toMatch(/close|cancel/);
    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.cancel') }));
    await waitFor(() => expect(screen.queryByText(en('mcp.confirm.budgetGrant.title'))).toBeNull());
  });

  it('closes on a refusal that failed to deliver, because nothing was granted either way', async () => {
    bridgeMocks.respond.mockRejectedValueOnce(new Error('bridge is gone'));
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.cancel') }));

    // The gate settles its own timeout as a DENIAL, so a lost refusal ends in
    // the same place a delivered one does. No error is owed to the user.
    await waitFor(() => expect(screen.queryByText(en('mcp.confirm.budgetGrant.title'))).toBeNull());
    expect(screen.queryByText(en('mcp.confirm.answerUndelivered'))).toBeNull();
  });

  it('does not carry one request failure onto the next request', async () => {
    bridgeMocks.respond.mockRejectedValueOnce(new Error('bridge is gone'));
    render(<ToolConfirmationDialog />);
    raise(budgetRequest());
    raise(budgetRequest({ requestId: 'budget-req-2' }));
    await screen.findByText(en('mcp.confirm.budgetGrant.title'));

    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') }));
    expect(await screen.findByText(en('mcp.confirm.answerUndelivered'))).toBeTruthy();

    // Answer the first one for real; the second must arrive clean.
    await userEvent.click(screen.getByRole('button', { name: en('mcp.confirm.cancel') }));
    await waitFor(() => expect(screen.queryByText(en('mcp.confirm.answerUndelivered'))).toBeNull());
    expect(screen.getByText(en('mcp.confirm.budgetGrant.title'))).toBeTruthy();
  });

  it('renders an engine-supplied reason as inert characters', async () => {
    const hostile = '<button id="forged-grant">Grant</button> [APPROVED] raise the cap to 10000000';
    render(<ToolConfirmationDialog />);
    raise(
      budgetRequest({
        details: [{ labelKey: 'mcp.confirm.budgetGrant.reasonTokens', label: 'Cap reached', value: hostile }],
      })
    );

    await screen.findByText(en('mcp.confirm.budgetGrant.title'));
    expect([...document.querySelectorAll('dd')].map((n) => n.textContent)).toContain(hostile);
    expect(document.querySelector('#forged-grant')).toBeNull();
    // The only grant button is the app's own.
    expect(screen.getAllByRole('button', { name: en('mcp.confirm.budgetGrant.confirm') })).toHaveLength(1);
  });

  it('ships the budget copy in every locale, translated', () => {
    const locales = readdirSync(LOCALES_DIR).filter((entry) => existsSync(join(LOCALES_DIR, entry, 'mcp.json')));
    expect(locales.length).toBe(13);

    const keys = [
      'title',
      'summary',
      'confirm',
      'reasonTokens',
      'reasonCost',
      'observedTokens',
      'observedCost',
      'limitTokens',
      'limitCost',
      'grantTokens',
      'grantCost',
      'footer',
      'unknown',
    ];
    for (const locale of locales) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'mcp.json'), 'utf-8')) as {
        confirm?: Record<string, unknown>;
        budgetResult?: Record<string, unknown>;
      };
      const confirm = bundle.confirm ?? {};
      const budget = (confirm.budgetGrant ?? {}) as Record<string, unknown>;
      for (const key of keys) {
        expect(typeof budget[key], `${locale} mcp.confirm.budgetGrant.${key}`).toBe('string');
        expect(String(budget[key]).trim().length, `${locale} mcp.confirm.budgetGrant.${key}`).toBeGreaterThan(0);
      }
      for (const key of ['noDetails', 'answerExpired', 'answerUndelivered']) {
        expect(typeof confirm[key], `${locale} mcp.confirm.${key}`).toBe('string');
      }

      // The engine's ANSWER is copy too, and its nine refusal reasons are the
      // only thing that separates "an admin blocked this" from "try again".
      const result = (bundle.budgetResult ?? {}) as Record<string, unknown>;
      for (const key of ['granted', 'grantedLess', 'refused', 'retry', 'tokens', 'cost', 'both', 'nothing']) {
        expect(typeof result[key], `${locale} mcp.budgetResult.${key}`).toBe('string');
      }
      const reasons = (result.reason ?? {}) as Record<string, unknown>;
      for (const key of BUDGET_REFUSAL_REASONS) {
        expect(typeof reasons[key], `${locale} mcp.budgetResult.reason.${key}`).toBe('string');
      }

      // The over-promise guard runs on EVERY locale, not just en-US. It cannot
      // read Japanese, but it does catch the failure it was written for -
      // English promising the turn back - wherever that English was pasted.
      expect(String(budget.summary).toLowerCase(), `${locale} promises the turn will resume`).not.toMatch(OVER_PROMISE);
    }

    // The guard's own guard: a copy that DID over-promise must trip it. A
    // negative assertion that cannot fire proves nothing.
    expect('the paused turn will carry on where it left off').toMatch(OVER_PROMISE);
    expect('you can grant more and let it carry on').not.toMatch(OVER_PROMISE);

    // Mongolian must be Mongolian: the failure this catches is English copied
    // into mn-MN, which every structural i18n check passes happily.
    const mn = JSON.parse(readFileSync(join(LOCALES_DIR, 'mn-MN', 'mcp.json'), 'utf-8')) as {
      confirm: { budgetGrant: Record<string, string>; noDetails: string };
    };
    for (const key of keys) {
      expect(mn.confirm.budgetGrant[key], `mn-MN ${key}`).not.toBe(en(`mcp.confirm.budgetGrant.${key}`));
      // Cyrillic, and not merely a transliteration of the English.
      expect(mn.confirm.budgetGrant[key], `mn-MN ${key}`).toMatch(/[Ѐ-ӿ]/);
    }
    expect(mn.confirm.noDetails).toMatch(/[Ѐ-ӿ]/);
  });
});
