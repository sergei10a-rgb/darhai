/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-wide singleton for the /refine rule store, mirroring
 * `getIjfwArchiveService`'s shape. The store holds session-scoped rules in an
 * in-memory map keyed by session id, so every /refine verb MUST talk to the
 * same instance or a session rule added by one call would be invisible to the
 * next. Global rules are mirrored to the on-disk archive by the store itself.
 */

import { createRefineRuleStore } from './refineStore';
import type { RefineRuleStore } from './refineStore';

let instance: RefineRuleStore | null = null;

/** The one refine store for this process, created on first use. */
export function getRefineRuleStore(): RefineRuleStore {
  if (!instance) {
    instance = createRefineRuleStore();
  }
  return instance;
}

/** Replace the singleton (tests only). */
export function setRefineRuleStore(store: RefineRuleStore): void {
  instance = store;
}
