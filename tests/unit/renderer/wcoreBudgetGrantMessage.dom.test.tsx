/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's answer to a budget grant, in the transcript.
 *
 * `budget_grant_result` had no arm in `useWCoreMessage`, so it landed in
 * `default:` - the arm the neighbouring cases document as the wrong place for a
 * session-level fact. Two things followed from that, both named in the comments
 * beside `workflow_run` and `execution_policy`: the frame was pushed through
 * `transformMessage` and rendered a junk bubble, and `setStreamRunning(true)`
 * flipped the composer back to "generating" for a turn that had already died on
 * the cap. Nine refusal reasons were decoded upstream and reached nobody.
 *
 * These tests drive the real hook off a real frame shape and assert both halves:
 * WHAT is said (the refusal reason survives to the screen) and what is NOT done
 * (the composer stays unlocked).
 *
 * The `t` mock resolves against the SHIPPED en-US bundle, so a key that never
 * landed in the locale resolves to its own name and the assertions fail.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetGrantFrameData } from '../../../src/process/agent/wcore/capabilities/handlers/budgetGrants';

const LOCALES_DIR = join(process.cwd(), 'src/renderer/services/i18n/locales');

const streamMocks = vi.hoisted(() => ({
  handlers: [] as Array<(message: Record<string, unknown>) => void>,
  addOrUpdateMessage: vi.fn(),
}));

vi.mock('../../../src/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (handler: (message: Record<string, unknown>) => void) => {
          streamMocks.handlers.push(handler);
          return (): void => undefined;
        },
      },
      update: { invoke: vi.fn(async () => undefined) },
      // Read on mount to decide whether the conversation is already running.
      get: { invoke: vi.fn(async () => ({ success: true, data: { status: 'done' } })) },
    },
  },
}));

vi.mock('../../../src/renderer/pages/conversation/Messages/hooks', () => ({
  useAddOrUpdateMessage: () => streamMocks.addOrUpdateMessage,
}));

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

import { useWCoreMessage } from '../../../src/renderer/pages/conversation/platforms/wcore/useWCoreMessage';

/** The same lookup the mock does, for assertions. */
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

const CONVERSATION = 'conv-budget';

/** The frame `budgetGrantsCapability` emits, decoded from the contract's own example. */
function frame(overrides: Partial<BudgetGrantFrameData> = {}): BudgetGrantFrameData {
  return {
    requestId: 'budget-001',
    additionalTokens: 250000,
    additionalCostUsd: 0,
    outcome: 'granted',
    requestedTokens: 250000,
    retryable: false,
    ...overrides,
  } as BudgetGrantFrameData;
}

function deliver(data: BudgetGrantFrameData): void {
  act(() => {
    for (const handler of streamMocks.handlers) {
      handler({ type: 'budget_grant_result', data, msg_id: '', conversation_id: CONVERSATION });
    }
  });
}

type Tips = { msg_id: string; type: string; content: { content: string; type: string } };

function lastNotice(): Tips {
  const calls = streamMocks.addOrUpdateMessage.mock.calls;
  expect(calls.length, 'the frame produced no message at all').toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Tips;
}

describe('budget_grant_result in the transcript', () => {
  beforeEach(() => {
    streamMocks.handlers.length = 0;
    streamMocks.addOrUpdateMessage.mockClear();
  });

  it('says what the engine actually granted', () => {
    const { result } = renderHook(() => useWCoreMessage(CONVERSATION));

    deliver(frame());

    const notice = lastNotice();
    expect(notice.type).toBe('tips');
    expect(notice.content.type).toBe('success');
    expect(notice.content.content).toBe(
      en('mcp.budgetResult.granted').replace(
        '{{amount}}',
        en('mcp.budgetResult.tokens').replace('{{tokens}}', '250000')
      )
    );
    // Keyed by request_id, so two grants are two notices and neither overwrites
    // the assistant's own reply.
    expect(notice.msg_id).toBe('budget:budget-001');
    // ...and the composer is NOT put back into "generating" for a turn the cap
    // already ended. This is what falling through to `default:` did.
    expect(result.current.running).toBe(false);
  });

  it('does not show a US$ 0 that was never granted', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    deliver(frame());

    // `additional_cost_usd` is required by the schema, so a token-only grant
    // answers with 0. Printing it would read as a second amount.
    expect(lastNotice().content.content).not.toContain('US$');
  });

  it('reports a grant the engine cut down, not the amount that was asked for', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    deliver(frame({ additionalTokens: 1000, requestedTokens: 250000 }));

    const notice = lastNotice();
    expect(notice.content.content).toContain('1000');
    expect(notice.content.content).toContain('250000');
    expect(notice.content.type).toBe('warning');
  });

  it('tells the user an administrator blocked it, and does not offer a retry', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    deliver(frame({ outcome: 'refused', refusalReason: 'managed_policy', retryable: false }));

    const notice = lastNotice();
    expect(notice.content.content).toContain(en('mcp.budgetResult.reason.managed_policy'));
    expect(notice.content.content).not.toContain(en('mcp.budgetResult.retry'));
    expect(notice.content.type).toBe('error');
  });

  it('tells the user a busy turn is worth retrying', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    deliver(frame({ outcome: 'refused', refusalReason: 'turn_in_progress', retryable: true }));

    const notice = lastNotice();
    expect(notice.content.content).toContain(en('mcp.budgetResult.reason.turn_in_progress'));
    expect(notice.content.content).toContain(en('mcp.budgetResult.retry'));
    // "try again shortly" is not the same news as "an admin said no".
    expect(notice.content.type).toBe('warning');
  });

  it('ships a sentence for every refusal reason the decoder can produce', () => {
    // The decoder refuses to pass through a reason outside this enum, so a
    // reason with no copy would render its own wire name at the user.
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, 'en-US', 'mcp.json'), 'utf-8')) as {
      budgetResult: { reason: Record<string, string> };
    };
    for (const reason of [
      'host_not_authorized',
      'managed_policy',
      'no_exhausted_budget',
      'invalid_grant',
      'budget_tracker_unavailable',
      'persistence_failure',
      'request_id_conflict',
      'ledger_capacity_exceeded',
      'turn_in_progress',
    ]) {
      expect(typeof bundle.budgetResult.reason[reason], `en-US budgetResult.reason.${reason}`).toBe('string');
    }
  });
});

/**
 * The host's own failures, which used to reach nobody at all.
 *
 * Every arm above describes a decision the ENGINE made, and therefore evidence
 * that the command arrived. These two are the opposite: the press happened (or
 * would have) and the host could not send it. Measured before this arm existed:
 * with the engine unreachable, `responseStream.emit` was called ZERO times and
 * the modal closed on a screen identical to a successful grant.
 */
describe('budget_grant_not_sent in the transcript', () => {
  beforeEach(() => {
    streamMocks.handlers.length = 0;
    streamMocks.addOrUpdateMessage.mockClear();
  });

  function deliverNotSent(data: Record<string, unknown>, msgId = 'm1'): void {
    act(() => {
      for (const handler of streamMocks.handlers) {
        handler({ type: 'budget_grant_not_sent', data, msg_id: msgId, conversation_id: CONVERSATION });
      }
    });
  }

  it('says the grant never reached the engine, and names the amount', () => {
    const { result } = renderHook(() => useWCoreMessage(CONVERSATION));

    deliverNotSent({ code: 'undelivered', detail: 'the engine cannot be reached', tokens: 4096 });

    const notice = lastNotice();
    expect(notice.type).toBe('tips');
    // An error, not a warning: the user believes they spent something.
    expect(notice.content.type).toBe('error');
    expect(notice.content.content).toContain('4096');
    expect(notice.content.content).toContain('the engine cannot be reached');
    // A dead turn must not be shown as generating - the same reason this arm is
    // not left to `default:`.
    expect(result.current.running).toBe(false);
  });

  it('does not read like an engine refusal', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    deliverNotSent({ code: 'undelivered', detail: 'the engine cannot be reached', tokens: 4096 });

    // `mcp.budgetResult.refused` means the ENGINE answered, which is exactly
    // what did NOT happen here. Only one of the two is worth pressing again.
    const refusedPrefix = en('mcp.budgetResult.refused').split('{{')[0];
    expect(lastNotice().content.content).not.toContain(refusedPrefix);
  });

  it('says the session grant limit stopped it, on its own line', () => {
    renderHook(() => useWCoreMessage(CONVERSATION));

    // `msg_id: ''` on purpose. The manager emits this frame with whatever msg_id
    // it currently holds, and between turns that is the empty string - which is
    // exactly the value the manager's OWN stream guard (`if (!data.msg_id)
    // return;`) drops. This arm is fed through the capability context instead
    // and must survive it, or the notice disappears in precisely the case it
    // was written for: after the capped turn already died.
    deliverNotSent({ code: 'session_limit' }, '');

    const notice = lastNotice();
    expect(notice.content.content).toBe(en('mcp.budgetResult.notSent.sessionLimit'));
    expect(notice.content.type).toBe('warning');
    // Keyed so a second session-limit notice replaces rather than stacks.
    expect(notice.msg_id).toBe('budget:limit');
  });

  it('ships both host-failure sentences in every locale', () => {
    // The engine's nine refusals already have this guard; the host's two did
    // not exist, and an untranslated one would show its own key name.
    const locales = readdirSync(LOCALES_DIR).filter((entry) => existsSync(join(LOCALES_DIR, entry, 'mcp.json')));
    expect(locales.length).toBe(13);
    for (const locale of locales) {
      const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'mcp.json'), 'utf-8')) as {
        budgetResult: { notSent?: Record<string, string> };
      };
      for (const key of ['undelivered', 'sessionLimit']) {
        expect(typeof bundle.budgetResult.notSent?.[key], `${locale} budgetResult.notSent.${key}`).toBe('string');
      }
    }
    // Mongolian must be Mongolian, not English left in place.
    const mn = JSON.parse(readFileSync(join(LOCALES_DIR, 'mn-MN', 'mcp.json'), 'utf-8')) as {
      budgetResult: { notSent: Record<string, string> };
    };
    for (const key of ['undelivered', 'sessionLimit']) {
      expect(mn.budgetResult.notSent[key], `mn-MN ${key}`).toMatch(/[Ѐ-ӿ]/);
      expect(mn.budgetResult.notSent[key], `mn-MN ${key}`).not.toBe(en(`mcp.budgetResult.notSent.${key}`));
    }
  });
});
