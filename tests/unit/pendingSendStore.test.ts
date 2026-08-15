/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pending-send store (SEC-8) - pure-function tests. Exercises the main-memory
 * hold/take/peek/clear lifecycle directly, including the load-bearing
 * exactly-once `take` guarantee and the replace-on-rehold behaviour.
 */

import { describe, expect, it } from 'vitest';
import { clearPendingSend, holdPendingSend, peekPendingSend, takePendingSend } from '@process/bridge/conversation/pendingSendBridge';

describe('pendingSend store (SEC-8)', () => {
  it('hold then peek reports hasPending with the minted id', () => {
    const cid = 'conv-hold-peek';
    const { id } = holdPendingSend({ conversationId: cid, message: 'hello', files: ['/a.txt'] });
    expect(id).toBeTruthy();

    const peeked = peekPendingSend({ conversationId: cid });
    expect(peeked).toEqual({ hasPending: true, id });
  });

  it('take returns the full record then deletes it (exactly-once)', () => {
    const cid = 'conv-take-once';
    const { id } = holdPendingSend({ conversationId: cid, message: 'secret body', files: ['/x'] });

    const first = takePendingSend({ conversationId: cid });
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      id,
      conversationId: cid,
      message: 'secret body',
      files: ['/x'],
    });
    expect(typeof first?.createdAt).toBe('number');

    // Second take must yield null - the body is reclaimable exactly once.
    const second = takePendingSend({ conversationId: cid });
    expect(second).toBeNull();

    // And peek confirms nothing remains.
    expect(peekPendingSend({ conversationId: cid })).toEqual({ hasPending: false });
  });

  it('a fresh hold replaces a prior hold (new id, latest message)', () => {
    const cid = 'conv-replace';
    const first = holdPendingSend({ conversationId: cid, message: 'first' });
    const second = holdPendingSend({ conversationId: cid, message: 'second' });

    expect(second.id).not.toBe(first.id);

    const taken = takePendingSend({ conversationId: cid });
    expect(taken?.id).toBe(second.id);
    expect(taken?.message).toBe('second');

    // Only the latest hold existed - nothing left after one take.
    expect(takePendingSend({ conversationId: cid })).toBeNull();
  });

  it('defaults files to an empty array when omitted', () => {
    const cid = 'conv-no-files';
    holdPendingSend({ conversationId: cid, message: 'm' });
    expect(takePendingSend({ conversationId: cid })?.files).toEqual([]);
  });

  it('clear removes a held message and returns ok', () => {
    const cid = 'conv-clear';
    holdPendingSend({ conversationId: cid, message: 'drop me' });

    expect(clearPendingSend({ conversationId: cid })).toEqual({ ok: true });
    expect(peekPendingSend({ conversationId: cid })).toEqual({ hasPending: false });
    expect(takePendingSend({ conversationId: cid })).toBeNull();
  });

  it('take and peek for an unknown conversation are null / not-pending', () => {
    expect(takePendingSend({ conversationId: 'never-held' })).toBeNull();
    expect(peekPendingSend({ conversationId: 'never-held' })).toEqual({ hasPending: false });
  });
});
