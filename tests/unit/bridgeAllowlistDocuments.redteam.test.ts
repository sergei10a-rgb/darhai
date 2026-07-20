/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Documents (Odysseus assimilation "documents"). Every mutating verb writes
 * persisted user content, and the AI verbs (ai-edit / ai-suggest) spend model
 * tokens + make outbound provider calls. A REMOTE (paired-device WebSocket) caller
 * must never reach any of them - only the trusted local user owns their documents.
 * The read verbs (documents.list / documents.get) follow the cron read policy and
 * stay allowed.
 *
 * The wire keys below are the exact strings passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives each as `subscribe-<key>`.
 */
describe('isAllowedForRemote - documents mutations + AI verbs denied for remote callers', () => {
  const DENIED = [
    'documents.create',
    'documents.update',
    'documents.delete',
    'documents.ai-edit',
    'documents.ai-suggest',
  ];

  it.each(DENIED)('denies subscribe-%s', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read verbs (documents.list / documents.get) for remote callers', () => {
    expect(isAllowedForRemote('subscribe-documents.list')).toBe(true);
    expect(isAllowedForRemote('subscribe-documents.get')).toBe(true);
  });

  it('does not accidentally deny the unrelated document.convert namespace', () => {
    expect(isAllowedForRemote('subscribe-document.convert')).toBe(true);
  });
});
