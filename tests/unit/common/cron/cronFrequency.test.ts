/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The schedule that quietly spends money.
 *
 * A `new_conversation` cron job creates a fresh conversation and a fresh agent
 * process on every fire. Nothing bounded it: the overlap guard reads
 * `isConversationBusy(job.metadata.conversationId)`, and a new-conversation job
 * has no such id by design, so the check ran against `undefined` and never
 * tripped. `* * * * *` therefore meant one agent run a minute, forever.
 *
 * The gate has to be right in both directions. Missing a fast schedule lets the
 * original problem through; flagging a slow one - or an ordinary job posting
 * into an existing conversation - trains people to click past the warning.
 */

import { describe, expect, it } from 'vitest';
import {
  isNewConversationFootgun,
  MIN_SAFE_NEW_CONVERSATION_INTERVAL_MS,
  scheduleIntervalMs,
  scheduleLikeIntervalMs,
} from '@/common/cron/cronFrequency';

describe('scheduleIntervalMs', () => {
  it('reads a plain every-minute cron', () => {
    expect(scheduleIntervalMs('* * * * *')).toBe(60_000);
  });

  it('reads a stepped minute field', () => {
    expect(scheduleIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
    expect(scheduleIntervalMs('*/30 * * * *')).toBe(30 * 60_000);
  });

  it('takes the tightest gap in a minute list', () => {
    // `0,5,30` fires 5 minutes apart at its closest, not 30.
    expect(scheduleIntervalMs('0,5,30 * * * *')).toBe(5 * 60_000);
  });

  it('treats a fixed minute as hourly at most', () => {
    expect(scheduleIntervalMs('0 * * * *')).toBe(3_600_000);
    expect(scheduleIntervalMs('30 9 * * *')).toBe(3_600_000);
  });

  it('reads second-precision cron, which fires fastest of all', () => {
    expect(scheduleIntervalMs('* * * * * *')).toBe(1000);
    expect(scheduleIntervalMs('*/10 * * * * *')).toBe(10_000);
  });

  it('reads fixed intervals', () => {
    expect(scheduleIntervalMs('30s')).toBe(30_000);
    expect(scheduleIntervalMs('@every 5m')).toBe(5 * 60_000);
    expect(scheduleIntervalMs('2h')).toBe(2 * 3_600_000);
    expect(scheduleIntervalMs('1d')).toBe(86_400_000);
  });

  it('says nothing rather than guessing at something it cannot read', () => {
    // An unreadable schedule must not be treated as fast - that would block a
    // valid job on a parser gap.
    expect(scheduleIntervalMs('')).toBeNull();
    expect(scheduleIntervalMs(undefined)).toBeNull();
    expect(scheduleIntervalMs('nonsense')).toBeNull();
    expect(scheduleIntervalMs('* * *')).toBeNull();
  });
});

describe('isNewConversationFootgun', () => {
  it('flags the schedule that spawns an agent every minute', () => {
    expect(isNewConversationFootgun('* * * * *', 'new_conversation')).toBe(true);
  });

  it('flags anything under the safe interval', () => {
    expect(isNewConversationFootgun('*/5 * * * *', 'new_conversation')).toBe(true);
    expect(isNewConversationFootgun('*/14 * * * *', 'new_conversation')).toBe(true);
    expect(isNewConversationFootgun('30s', 'new_conversation')).toBe(true);
    expect(isNewConversationFootgun('* * * * * *', 'new_conversation')).toBe(true);
  });

  it('leaves a schedule at or above the threshold alone', () => {
    expect(isNewConversationFootgun('*/15 * * * *', 'new_conversation')).toBe(false);
    expect(isNewConversationFootgun('0 * * * *', 'new_conversation')).toBe(false);
    expect(isNewConversationFootgun('0 9 * * 1', 'new_conversation')).toBe(false);
    expect(isNewConversationFootgun('1d', 'new_conversation')).toBe(false);
  });

  it('does not gate a job posting into an existing conversation', () => {
    // That case IS bounded - the conversation's busy state makes a fast schedule
    // queue rather than multiply. Warning there would be noise.
    expect(isNewConversationFootgun('* * * * *', 'existing')).toBe(false);
    expect(isNewConversationFootgun('* * * * *', undefined)).toBe(false);
  });

  it('does not gate a schedule it could not read', () => {
    expect(isNewConversationFootgun('nonsense', 'new_conversation')).toBe(false);
    expect(isNewConversationFootgun('', 'new_conversation')).toBe(false);
  });

  it('puts the boundary exactly where the constant says', () => {
    const justUnder = MIN_SAFE_NEW_CONVERSATION_INTERVAL_MS / 60_000 - 1;
    expect(isNewConversationFootgun(`*/${justUnder} * * * *`, 'new_conversation')).toBe(true);
    expect(
      isNewConversationFootgun(`*/${MIN_SAFE_NEW_CONVERSATION_INTERVAL_MS / 60_000} * * * *`, 'new_conversation')
    ).toBe(false);
  });
});

describe('scheduleLikeIntervalMs - the shape the scheduler actually stores', () => {
  it('reads a fixed interval straight off the schedule', () => {
    expect(scheduleLikeIntervalMs({ kind: 'every', everyMs: 30_000 })).toBe(30_000);
  });

  it('parses the expression of a cron schedule', () => {
    expect(scheduleLikeIntervalMs({ kind: 'cron', expr: '*/5 * * * *' })).toBe(5 * 60_000);
  });

  it('treats a one-shot as having no frequency at all', () => {
    // `at` fires once. Calling it "fast" would block a perfectly safe job.
    expect(scheduleLikeIntervalMs({ kind: 'at', atMs: 1_785_888_000_000 })).toBeNull();
    expect(isNewConversationFootgun({ kind: 'at', atMs: 1 }, 'new_conversation')).toBe(false);
  });

  it('says nothing for a malformed interval rather than assuming', () => {
    expect(scheduleLikeIntervalMs({ kind: 'every', everyMs: 0 })).toBeNull();
    expect(scheduleLikeIntervalMs({ kind: 'every' })).toBeNull();
    expect(scheduleLikeIntervalMs(undefined)).toBeNull();
  });

  it('gates a fast stored schedule the same way it gates a raw expression', () => {
    expect(isNewConversationFootgun({ kind: 'every', everyMs: 60_000 }, 'new_conversation')).toBe(true);
    expect(isNewConversationFootgun({ kind: 'cron', expr: '* * * * *' }, 'new_conversation')).toBe(true);
    expect(isNewConversationFootgun({ kind: 'every', everyMs: 3_600_000 }, 'new_conversation')).toBe(false);
  });
});
