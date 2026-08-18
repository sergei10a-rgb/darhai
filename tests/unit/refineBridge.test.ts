/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// Unit tests for refineBridge - the IPC trust boundary of the /refine rule
// surface. Covers:
//   - applyRules: routes shape-validated edits to the store with the fixed
//     session id, and remembers the pass id.
//   - rollback: undoes the LAST applied pass; a rollback with nothing to undo
//     returns { ok:false } WITHOUT touching the store.
//   - listRules: reads the store for a scope.
//   - input hardening: an unknown scope falls back to 'session'; malformed
//     edits are dropped before reaching the store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => {
  const g = globalThis as Record<string, unknown>;
  const mk = (name: string): ReturnType<typeof vi.fn> => (g[name] ??= vi.fn()) as ReturnType<typeof vi.fn>;
  return {
    ipcBridge: {
      refine: {
        listRules: { provider: mk('__refListRules') },
        applyRules: { provider: mk('__refApplyRules') },
        rollback: { provider: mk('__refRollback') },
      },
    },
  };
});

const g = globalThis as Record<string, unknown>;
const listRulesMock = g.__refListRules as ReturnType<typeof vi.fn>;
const applyRulesMock = g.__refApplyRules as ReturnType<typeof vi.fn>;
const rollbackMock = g.__refRollback as ReturnType<typeof vi.fn>;

import { initRefineBridge } from '@process/bridge/knowledge/refineBridge';
import type { RefineRuleStore } from '@process/services/memory/refine/refineStore';
import type { RefineResult, RuleEdit, RuleScope } from '@process/services/memory/refine/rule';

const SESSION = 'ui';

function result(id: string, scope: RuleScope, applied = true): RefineResult {
  return { id, scope, applied: [{ action: 'add', scope, id: 'r1', applied }] };
}

/** A vi.fn-backed store matching the RefineRuleStore surface the bridge uses. */
function fakeStore(): {
  store: RefineRuleStore;
  getRulesMock: ReturnType<typeof vi.fn>;
  refineMock: ReturnType<typeof vi.fn>;
  rollbackStoreMock: ReturnType<typeof vi.fn>;
} {
  const getRulesMock = vi.fn().mockReturnValue([]);
  const refineMock = vi.fn().mockResolvedValue(result('refine_1', 'session'));
  const rollbackStoreMock = vi.fn().mockResolvedValue(result('refine_2', 'session'));
  const store = {
    getRules: getRulesMock,
    refine: refineMock,
    rollback: rollbackStoreMock,
  } as unknown as RefineRuleStore;
  return { store, getRulesMock, refineMock, rollbackStoreMock };
}

function lastHandler<T>(mock: ReturnType<typeof vi.fn>, name: string): T {
  const last = mock.mock.calls.at(-1);
  if (!last) throw new Error(`${name} provider was never registered`);
  return last[0] as T;
}

beforeEach(() => {
  listRulesMock.mockReset();
  applyRulesMock.mockReset();
  rollbackMock.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('refineBridge.applyRules', () => {
  it('routes shape-validated edits to the store with the fixed session id', async () => {
    const { store, refineMock } = fakeStore();
    initRefineBridge({ getStore: () => store });
    const handler = lastHandler<(a: { scope: RuleScope; edits: RuleEdit[] }) => Promise<RefineResult>>(
      applyRulesMock,
      'applyRules'
    );
    const edits: RuleEdit[] = [{ action: 'add', scope: 'session', text: 'always measure' }];
    const res = await handler({ scope: 'session', edits });
    expect(res.id).toBe('refine_1');
    expect(refineMock).toHaveBeenCalledWith(edits, 'session', SESSION);
  });

  it('falls back to the session scope for an unknown scope and drops malformed edits', async () => {
    const { store, refineMock } = fakeStore();
    initRefineBridge({ getStore: () => store });
    const handler = lastHandler<(a: { scope: unknown; edits: unknown }) => Promise<RefineResult>>(
      applyRulesMock,
      'applyRules'
    );
    await handler({
      scope: 'weird-scope',
      edits: [42, { action: 'bogus' }, { action: 'add', scope: 'session', text: 'ok' }],
    });
    // Unknown scope -> 'session'; only the one well-formed edit survives.
    expect(refineMock).toHaveBeenCalledWith(
      [{ action: 'add', scope: 'session', text: 'ok', id: undefined, reason: undefined }],
      'session',
      SESSION
    );
  });
});

describe('refineBridge.rollback', () => {
  it('undoes the last applied pass', async () => {
    const { store, rollbackStoreMock } = fakeStore();
    initRefineBridge({ getStore: () => store });
    const applyHandler = lastHandler<(a: { scope: RuleScope; edits: RuleEdit[] }) => Promise<RefineResult>>(
      applyRulesMock,
      'applyRules'
    );
    const rollbackHandler = lastHandler<() => Promise<{ ok: boolean; result: RefineResult | null }>>(
      rollbackMock,
      'rollback'
    );

    await applyHandler({ scope: 'session', edits: [{ action: 'add', scope: 'session', text: 'x' }] });
    const res = await rollbackHandler();
    expect(res.ok).toBe(true);
    expect(rollbackStoreMock).toHaveBeenCalledWith('refine_1', SESSION);
  });

  it('returns { ok:false } and does NOT touch the store when there is nothing to undo', async () => {
    const { store, rollbackStoreMock } = fakeStore();
    initRefineBridge({ getStore: () => store });
    const rollbackHandler = lastHandler<() => Promise<{ ok: boolean; result: RefineResult | null }>>(
      rollbackMock,
      'rollback'
    );
    const res = await rollbackHandler();
    expect(res).toEqual({ ok: false, result: null });
    expect(rollbackStoreMock).not.toHaveBeenCalled();
  });
});

describe('refineBridge.listRules', () => {
  it('reads the store for the requested scope', async () => {
    const { store, getRulesMock } = fakeStore();
    getRulesMock.mockReturnValue([{ id: 'a', scope: 'global', text: 'r', createdAt: 1, refinementId: 'p' }]);
    initRefineBridge({ getStore: () => store });
    const handler = lastHandler<(a: { scope: RuleScope }) => Promise<{ rules: unknown[] }>>(listRulesMock, 'listRules');
    const res = await handler({ scope: 'global' });
    expect(getRulesMock).toHaveBeenCalledWith('global', SESSION);
    expect(res.rules).toHaveLength(1);
  });
});
