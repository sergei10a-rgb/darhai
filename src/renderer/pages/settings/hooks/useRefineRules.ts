/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State + actions for the /refine rules card: list the rules in a scope, add or
 * remove one (each is a one-edit refinement pass), and roll back the LAST pass.
 * The bridge remembers the last pass id, so `rollback` needs no argument and is
 * only meaningful right after an add/remove - `canRollback` tracks that.
 */

import { useCallback, useEffect, useState } from 'react';
import { refine } from '@/common/adapter/ipcBridge';
import type { RefineRule, RuleScope } from '@process/services/memory/refine/rule';

export type RefineRulesController = {
  scope: RuleScope;
  setScope: (scope: RuleScope) => void;
  rules: RefineRule[];
  /** True right after a successful add/remove, cleared by a rollback or scope change. */
  canRollback: boolean;
  busy: boolean;
  addRule: (text: string) => Promise<void>;
  removeRule: (id: string) => Promise<void>;
  rollback: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useRefineRules(): RefineRulesController {
  const [scope, setScopeState] = useState<RuleScope>('session');
  const [rules, setRules] = useState<RefineRule[]>([]);
  const [canRollback, setCanRollback] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (which: RuleScope): Promise<void> => {
    const result = await refine.listRules.invoke({ scope: which }).catch(() => ({ rules: [] as RefineRule[] }));
    setRules(result.rules);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    await load(scope);
  }, [load, scope]);

  useEffect(() => {
    void load(scope);
  }, [load, scope]);

  const setScope = useCallback((next: RuleScope): void => {
    setScopeState(next);
    // A rollback undoes the last pass in whatever scope it targeted; changing
    // scope makes "the last pass" ambiguous for the user, so clear the affordance.
    setCanRollback(false);
  }, []);

  const addRule = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setBusy(true);
      try {
        const result = await refine.applyRules.invoke({ scope, edits: [{ action: 'add', scope, text: trimmed }] });
        setCanRollback(result.applied.some((e) => e.applied));
        await load(scope);
      } finally {
        setBusy(false);
      }
    },
    [load, scope]
  );

  const removeRule = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true);
      try {
        const result = await refine.applyRules.invoke({ scope, edits: [{ action: 'remove', scope, id }] });
        setCanRollback(result.applied.some((e) => e.applied));
        await load(scope);
      } finally {
        setBusy(false);
      }
    },
    [load, scope]
  );

  const rollback = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await refine.rollback.invoke();
      setCanRollback(false);
      await load(scope);
    } finally {
      setBusy(false);
    }
  }, [load, scope]);

  return { scope, setScope, rules, canRollback, busy, addRule, removeRule, rollback, refresh };
}
