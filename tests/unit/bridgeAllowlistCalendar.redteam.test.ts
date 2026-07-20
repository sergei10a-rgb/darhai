/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Calendar (Odysseus assimilation "calendar"). Every mutating verb writes
 * persisted user content, so a REMOTE (paired-device WebSocket) caller must never
 * reach it - only the trusted local user edits their calendar. The read verbs
 * (calendar.list / calendar.get) follow the cron read policy and stay allowed.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives each as `subscribe-<key>`.
 */
describe('isAllowedForRemote - calendar mutations denied for remote callers', () => {
  const DENIED_MUTATIONS = ['calendar.create', 'calendar.update', 'calendar.delete'];

  it.each(DENIED_MUTATIONS)('denies subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read verbs (calendar.list / calendar.get) for remote callers', () => {
    expect(isAllowedForRemote('subscribe-calendar.list')).toBe(true);
    expect(isAllowedForRemote('subscribe-calendar.get')).toBe(true);
  });
});
