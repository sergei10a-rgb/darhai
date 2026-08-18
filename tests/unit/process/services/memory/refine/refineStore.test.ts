/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the /refine rule store. Disk collaborators are injected, so these
 * assert the store's two invariants directly:
 *  - A SESSION refinement touches NEITHER disk dep (session rules never leak).
 *  - A GLOBAL refinement mirrors exactly its applied edits to disk, and a
 *    rollback reverses that mirror.
 */

import { describe, expect, it, vi, type Mock } from 'vitest';
import { RefineRuleStore, type RefineStoreDeps } from '@process/services/memory/refine/refineStore';
import { makeRuleId, type RefineRule } from '@process/services/memory/refine/rule';

let seq = 0;
const tick = () => 1_700_000_000_000 + seq++;

type Harness = {
  store: RefineRuleStore;
  persistGlobal: Mock<(rule: RefineRule) => Promise<void>>;
  removeGlobal: Mock<(rule: RefineRule) => Promise<void>>;
};

function makeStore(overrides: Partial<RefineStoreDeps> = {}): Harness {
  const persistGlobal = (overrides.persistGlobal ?? vi.fn(async () => {})) as Mock;
  const removeGlobal = (overrides.removeGlobal ?? vi.fn(async () => {})) as Mock;
  const store = new RefineRuleStore({ persistGlobal, removeGlobal, now: overrides.now ?? tick });
  return { store, persistGlobal, removeGlobal };
}

describe('RefineRuleStore session isolation', () => {
  it('never writes a session rule to disk', async () => {
    const { store, persistGlobal, removeGlobal } = makeStore();

    const result = await store.refine(
      [{ action: 'add', scope: 'session', text: 'Энэ session-ий дүрэм' }],
      'session',
      's1'
    );

    expect(result.applied[0].applied).toBe(true);
    expect(store.getRules('session', 's1')).toHaveLength(1);
    // The leak guard, proven at the store boundary: zero disk writes.
    expect(persistGlobal).not.toHaveBeenCalled();
    expect(removeGlobal).not.toHaveBeenCalled();
  });

  it('keeps session rules per-session', async () => {
    const { store } = makeStore();
    await store.refine([{ action: 'add', scope: 'session', text: 'Зөвхөн s1-ийн дүрэм' }], 'session', 's1');

    expect(store.getRules('session', 's1')).toHaveLength(1);
    expect(store.getRules('session', 's2')).toHaveLength(0); // s2 never saw it
  });

  it('refuses a global edit inside a session refinement (no disk write)', async () => {
    const { store, persistGlobal } = makeStore();

    const result = await store.refine([{ action: 'add', scope: 'global', text: 'Гоожсон дүрэм' }], 'session', 's1');

    expect(result.applied[0].applied).toBe(false);
    expect(result.applied[0].error).toBe('scope_mismatch');
    expect(persistGlobal).not.toHaveBeenCalled();
  });
});

describe('RefineRuleStore global persistence', () => {
  it('mirrors each admitted global add to persistGlobal', async () => {
    const { store, persistGlobal } = makeStore();

    await store.refine(
      [
        { action: 'add', scope: 'global', text: 'Түлхэхийн өмнө lint ажиллуул' },
        { action: 'add', scope: 'global', text: 'Backup ав туршихын өмнө' },
      ],
      'global',
      's1'
    );

    expect(persistGlobal).toHaveBeenCalledTimes(2);
    expect(persistGlobal.mock.calls[0][0].text).toBe('Түлхэхийн өмнө lint ажиллуул');
    expect(store.getRules('global', 's1')).toHaveLength(2);
  });

  it('does not persist an edit the gate rejected', async () => {
    const { store, persistGlobal } = makeStore();

    // Second edit duplicates the first -> rejected -> only one disk write.
    await store.refine(
      [
        { action: 'add', scope: 'global', text: 'Давхардсан дүрэм' },
        { action: 'add', scope: 'global', text: 'давхардсан  ДҮРЭМ' },
      ],
      'global',
      's1'
    );

    expect(persistGlobal).toHaveBeenCalledTimes(1);
    expect(store.getRules('global', 's1')).toHaveLength(1);
  });

  it('survives a disk failure without throwing (in-memory stays source of truth)', async () => {
    const { store, persistGlobal } = makeStore({
      persistGlobal: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await expect(
      store.refine([{ action: 'add', scope: 'global', text: 'Дискэн дээр амжилтгүй' }], 'global', 's1')
    ).resolves.toBeDefined();
    expect(persistGlobal).toHaveBeenCalledTimes(1);
    expect(store.getRules('global', 's1')).toHaveLength(1); // still admitted in memory
  });
});

describe('RefineRuleStore rollback', () => {
  it('reverts a session add and touches no disk dep', async () => {
    const { store, persistGlobal, removeGlobal } = makeStore();
    const result = await store.refine(
      [{ action: 'add', scope: 'session', text: 'Буцаах session дүрэм' }],
      'session',
      's1'
    );
    expect(store.getRules('session', 's1')).toHaveLength(1);

    const rb = await store.rollback(result.id, 's1');

    expect(rb?.rollbackOf).toBe(result.id);
    expect(store.getRules('session', 's1')).toHaveLength(0);
    expect(persistGlobal).not.toHaveBeenCalled();
    expect(removeGlobal).not.toHaveBeenCalled();
  });

  it('reverts a global add by mirroring a removeGlobal', async () => {
    const { store, persistGlobal, removeGlobal } = makeStore();
    const result = await store.refine(
      [{ action: 'add', scope: 'global', text: 'Буцаах global дүрэм' }],
      'global',
      's1'
    );
    expect(persistGlobal).toHaveBeenCalledTimes(1);

    const rb = await store.rollback(result.id, 's1');

    expect(rb?.applied[0].applied).toBe(true);
    expect(store.getRules('global', 's1')).toHaveLength(0);
    expect(removeGlobal).toHaveBeenCalledTimes(1);
    expect(removeGlobal.mock.calls[0][0].id).toBe(makeRuleId('global', 'Буцаах global дүрэм'));
  });

  it('returns null for an unknown rollback id', async () => {
    const { store } = makeStore();
    expect(await store.rollback('refine_nonexistent', 's1')).toBeNull();
  });
});
