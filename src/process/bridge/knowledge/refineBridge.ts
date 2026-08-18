/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the /refine rule surface. Wires the process-wide
 * {@link getRefineRuleStore} singleton to three verbs: list the rules in a
 * scope, apply a refinement pass, and roll back the LAST applied pass. The
 * renderer never tracks pass ids - the bridge remembers the most recent one so
 * "rollback" always means "undo what I just did".
 *
 * Session-scoped rules live for the life of this process under one fixed
 * session id (the desktop app is a single renderer); global rules are mirrored
 * to disk by the store itself. The whole `refine.*` namespace is remote-denied
 * (see bridgeAllowlist): `applyRules` / `rollback` rewrite the user's on-disk
 * global rules, and even `listRules` discloses them, so only the trusted local
 * renderer may reach it. Untrusted renderer input is validated here before it
 * reaches the pure gate.
 */

import { ipcBridge } from '@/common';
import { getRefineRuleStore } from '@process/services/memory/refine/refineRuleStoreSingleton';
import type { RefineRuleStore } from '@process/services/memory/refine/refineStore';
import type { RuleEdit, RuleScope } from '@process/services/memory/refine/rule';

/** The single session id session-scoped rules live under in the desktop app. */
const DEFAULT_SESSION = 'ui';

/** Injectable collaborators - production defaults are wired in {@link initRefineBridge}. */
export type RefineBridgeDeps = {
  getStore: () => RefineRuleStore;
  sessionId: string;
};

/** Narrow an untrusted scope; anything but `'global'` is the editable `'session'` lane. */
function safeScope(value: unknown): RuleScope {
  return value === 'global' ? 'global' : 'session';
}

/**
 * Shape-validate an untrusted edit array. The pure gate (`validateRuleEdit`)
 * does the real admission (length, duplicate, scope containment); this only
 * drops non-objects and unknown actions/scopes so a malformed payload cannot
 * reach the store as `undefined`.
 */
function safeEdits(value: unknown): RuleEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: RuleEdit[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const action = entry.action === 'add' || entry.action === 'remove' ? entry.action : undefined;
    if (!action) continue;
    const scope = entry.scope === 'global' ? 'global' : entry.scope === 'session' ? 'session' : undefined;
    if (!scope) continue;
    edits.push({
      action,
      scope,
      text: typeof entry.text === 'string' ? entry.text : undefined,
      id: typeof entry.id === 'string' ? entry.id : undefined,
      reason: typeof entry.reason === 'string' ? entry.reason : undefined,
    });
  }
  return edits;
}

/** Initialize the /refine IPC bridge handlers. */
export function initRefineBridge(deps?: Partial<RefineBridgeDeps>): void {
  const resolved: RefineBridgeDeps = {
    getStore: getRefineRuleStore,
    sessionId: DEFAULT_SESSION,
    ...deps,
  };
  // The id of the most recent applied pass, so `rollback` can undo "the last
  // one" without the renderer carrying pass ids across IPC.
  let lastResultId: string | null = null;

  ipcBridge.refine.listRules.provider(async ({ scope }) => {
    const rules = resolved.getStore().getRules(safeScope(scope), resolved.sessionId);
    return { rules: [...rules] };
  });

  ipcBridge.refine.applyRules.provider(async ({ scope, edits }) => {
    const result = await resolved.getStore().refine(safeEdits(edits), safeScope(scope), resolved.sessionId);
    lastResultId = result.id;
    return result;
  });

  ipcBridge.refine.rollback.provider(async () => {
    if (lastResultId === null) return { ok: false, result: null };
    const result = await resolved.getStore().rollback(lastResultId, resolved.sessionId);
    // A successful rollback consumes the pass; a second rollback has nothing to undo.
    if (result !== null) lastResultId = null;
    return { ok: result !== null, result };
  });
}
