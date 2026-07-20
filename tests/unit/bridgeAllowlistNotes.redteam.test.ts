/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Notes (Odysseus assimilation #9). Every mutating note verb writes persisted
 * user content, so a REMOTE (paired-device WebSocket) caller must never reach it -
 * only the trusted local user edits their notes. The read verbs (note.list /
 * note.get) follow the cron read policy and stay allowed for the paired UI.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives each as `subscribe-<key>`.
 */
describe('isAllowedForRemote - note mutations denied for remote callers', () => {
  const DENIED_MUTATIONS = [
    'note.create',
    'note.update',
    'note.delete',
    'note.toggle-pin',
    'note.toggle-archive',
    'note.toggle-item',
    'note.reorder',
  ];

  it.each(DENIED_MUTATIONS)('denies subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read verbs (note.list / note.get) for remote callers', () => {
    expect(isAllowedForRemote('subscribe-note.list')).toBe(true);
    expect(isAllowedForRemote('subscribe-note.get')).toBe(true);
  });
});
