/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The advisory per-agent repeat-tool-call reminder (loop breaker). Local weak
 * models on the WCore / llama.cpp backends hammer the same tool call with
 * identical arguments and burn tokens with no progress; the stateless
 * HookGuardService floor cannot see across calls. These tests pin the stateful
 * chain: the exact thresholds fire, argument order does not matter, bookkeeping
 * tools stay transparent, denied calls still count, and two agents never share
 * a chain.
 */

import { describe, it, expect } from 'vitest';
import { RepeatToolReminder, DEFAULT_REPEAT_THRESHOLDS } from '@process/agent/guard/RepeatToolReminder';

/** A fresh, unique agent key per call. WeakMap keys must be objects. */
const agent = (): object => ({});

describe('RepeatToolReminder - threshold escalation', () => {
  it('fires ONLY at the configured consecutive counts 3, 5, 8', () => {
    const guard = new RepeatToolReminder(); // defaults [3, 5, 8]
    const a = agent();

    const counts: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const notice = guard.observe(a, 'grep', { pattern: 'x' });
      if (notice) counts.push(notice.count);
    }

    // Reminders at exactly 3, 5, 8 - never at 4, 6, 7, 9, and never past the top.
    expect(counts).toEqual([3, 5, 8]);
    expect(DEFAULT_REPEAT_THRESHOLDS).toEqual([3, 5, 8]);
  });

  it('the FIRST threshold is a gentle nudge, later thresholds are the detailed form', () => {
    const guard = new RepeatToolReminder({ thresholds: [3, 5] });
    const a = agent();

    let gentle: string | undefined;
    let detailed: string | undefined;
    for (let i = 1; i <= 5; i++) {
      const notice = guard.observe(a, 'read_file', { path: '/tmp/a' });
      if (notice?.count === 3) gentle = notice.text;
      if (notice?.count === 5) detailed = notice.text;
    }

    expect(gentle).toContain('repeating the exact same tool call');
    expect(gentle).not.toContain('consecutive_calls');
    expect(detailed).toContain('Repeated tool call detected');
    expect(detailed).toContain('consecutive_calls: 5');
    expect(detailed).toContain('read_file');
  });

  it('returns undefined below the first threshold (zero cost until it trips)', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    expect(guard.observe(a, 'grep', { q: 1 })).toBeUndefined();
    expect(guard.observe(a, 'grep', { q: 1 })).toBeUndefined();
    expect(guard.observe(a, 'grep', { q: 1 })?.count).toBe(3);
  });

  it('normalizes an out-of-order thresholds list to ascending (first = gentle)', () => {
    const guard = new RepeatToolReminder({ thresholds: [8, 3, 5] });
    const a = agent();
    let third: ReturnType<RepeatToolReminder['observe']>;
    for (let i = 1; i <= 3; i++) third = guard.observe(a, 'grep', { q: 1 });
    // The gentle tier is keyed to the SMALLEST threshold (3), not list order.
    expect(third?.count).toBe(3);
    expect(third?.text).toContain('repeating the exact same tool call');
  });
});

describe('RepeatToolReminder - canonical arguments', () => {
  it('treats argument objects differing only in key order as identical', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();

    // Same values, three different key orderings - one unbroken run of 3.
    guard.observe(a, 'search', { alpha: 1, beta: 2 });
    guard.observe(a, 'search', { beta: 2, alpha: 1 });
    const third = guard.observe(a, 'search', { alpha: 1, beta: 2 });

    expect(third?.count).toBe(3);
  });

  it('deep-sorts nested objects when canonicalizing', () => {
    const guard = new RepeatToolReminder({ thresholds: [2] });
    const a = agent();
    guard.observe(a, 'call', { outer: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] });
    const second = guard.observe(a, 'call', { list: [{ q: 2, p: 1 }], outer: { y: 2, x: 1 } });
    expect(second?.count).toBe(2);
  });

  it('a genuinely different argument value RESETS the run to 1', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    guard.observe(a, 'grep', { pattern: 'x' });
    guard.observe(a, 'grep', { pattern: 'x' });
    // Different value - not the same call, chain resets.
    expect(guard.observe(a, 'grep', { pattern: 'y' })).toBeUndefined();
    // Now two of the new value; still not at threshold.
    expect(guard.observe(a, 'grep', { pattern: 'y' })).toBeUndefined();
    expect(guard.observe(a, 'grep', { pattern: 'y' })?.count).toBe(3);
  });

  it('a different TOOL with identical arguments RESETS the run', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(a, 'grep', { q: 1 });
    expect(guard.observe(a, 'read', { q: 1 })).toBeUndefined();
  });
});

describe('RepeatToolReminder - bookkeeping tools are transparent', () => {
  it('an interleaved default-excluded todo_write does not launder the loop', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();

    // grep X -> todo_write -> grep X -> todo_write -> grep X == three grep X.
    guard.observe(a, 'grep', { pattern: 'x' });
    expect(guard.observe(a, 'todo_write', { items: ['a'] })).toBeUndefined();
    guard.observe(a, 'grep', { pattern: 'x' });
    expect(guard.observe(a, 'todo_write', { items: ['b'] })).toBeUndefined();
    const third = guard.observe(a, 'grep', { pattern: 'x' });

    expect(third?.count).toBe(3);
  });

  it('the case-insensitive default excludes TodoWrite as well', () => {
    const guard = new RepeatToolReminder({ thresholds: [2] });
    const a = agent();
    guard.observe(a, 'grep', { pattern: 'x' });
    guard.observe(a, 'TodoWrite', { items: ['a'] }); // transparent, not counted
    expect(guard.observe(a, 'grep', { pattern: 'x' })?.count).toBe(2);
  });

  it('an excluded tool never itself produces a reminder however often it repeats', () => {
    const guard = new RepeatToolReminder({ thresholds: [2], exclude: ['todo_write'] });
    const a = agent();
    for (let i = 0; i < 10; i++) {
      expect(guard.observe(a, 'todo_write', { items: ['a'] })).toBeUndefined();
    }
  });

  it('an include list tracks only matching tools; off-list tools are transparent', () => {
    const guard = new RepeatToolReminder({ thresholds: [2], include: ['grep'] });
    const a = agent();
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(a, 'read', { q: 1 }); // not in include - transparent, no reset
    expect(guard.observe(a, 'grep', { q: 1 })?.count).toBe(2);
  });
});

describe('RepeatToolReminder - denied calls still count', () => {
  it('counts every attempt the model makes, regardless of the downstream verdict', () => {
    // `observe` takes no verdict: the seam calls it for EVERY attempt, including
    // ones a `pre` guard denied. A model hammering a denied call is exactly the
    // loop worth breaking, so three attempts at the same denied call still trip
    // the threshold.
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    // Simulate three consecutive attempts of a call that the destructive floor
    // would deny; the tracker sees them all the same.
    guard.observe(a, 'run_shell', { command: 'rm -rf /' });
    guard.observe(a, 'run_shell', { command: 'rm -rf /' });
    const third = guard.observe(a, 'run_shell', { command: 'rm -rf /' });
    expect(third?.count).toBe(3);
  });
});

describe('RepeatToolReminder - per-agent isolation', () => {
  it('two agents keep independent chains (one never trips the other)', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    const b = agent();

    // Interleave the same call across two agents.
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(b, 'grep', { q: 1 });
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(b, 'grep', { q: 1 });
    const aThird = guard.observe(a, 'grep', { q: 1 });
    const bThird = guard.observe(b, 'grep', { q: 1 });

    expect(aThird?.count).toBe(3);
    expect(bThird?.count).toBe(3);
  });

  it("one agent's heavy repetition does not push another agent over the threshold", () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    const b = agent();

    for (let i = 0; i < 8; i++) guard.observe(a, 'grep', { q: 1 });
    // b has only made two of the same call - must not be at threshold.
    guard.observe(b, 'grep', { q: 1 });
    expect(guard.observe(b, 'grep', { q: 1 })).toBeUndefined();
  });
});

describe('RepeatToolReminder - reset', () => {
  it('reset restarts the chain so post-interjection repetition counts from 1', () => {
    const guard = new RepeatToolReminder({ thresholds: [3] });
    const a = agent();
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(a, 'grep', { q: 1 });
    guard.reset(a);
    // After a user interjection the run starts over.
    expect(guard.observe(a, 'grep', { q: 1 })).toBeUndefined();
    expect(guard.observe(a, 'grep', { q: 1 })).toBeUndefined();
    expect(guard.observe(a, 'grep', { q: 1 })?.count).toBe(3);
  });

  it('reset is safe for an agent with no chain yet', () => {
    const guard = new RepeatToolReminder();
    expect(() => guard.reset(agent())).not.toThrow();
  });
});

describe('RepeatToolReminder - argument preview cap', () => {
  it('head-truncates the detailed reminder arguments with an omitted-count marker', () => {
    // Preview only bounds the DETAILED reminder, which fires at a LATER
    // threshold - so drive the run to the second threshold (3), not the first.
    const guard = new RepeatToolReminder({ thresholds: [2, 3], argumentsPreviewChars: 20 });
    const a = agent();
    const big = { command: 'x'.repeat(500) };
    guard.observe(a, 'run_shell', big);
    guard.observe(a, 'run_shell', big);
    const notice = guard.observe(a, 'run_shell', big);
    expect(notice?.count).toBe(3);
    expect(notice?.text).toContain('… (+');
    expect(notice?.text).toContain('more chars)');
  });

  it('does not truncate when the canonical arguments fit within the cap', () => {
    const guard = new RepeatToolReminder({ thresholds: [2, 3], argumentsPreviewChars: 500 });
    const a = agent();
    guard.observe(a, 'grep', { q: 1 });
    guard.observe(a, 'grep', { q: 1 });
    const notice = guard.observe(a, 'grep', { q: 1 });
    expect(notice?.count).toBe(3);
    expect(notice?.text).not.toContain('more chars)');
    expect(notice?.text).toContain('{"q":1}');
  });
});

describe('RepeatToolReminder - config fails loud', () => {
  it('throws on an empty thresholds list', () => {
    expect(() => new RepeatToolReminder({ thresholds: [] })).toThrow(/must not be empty/);
  });

  it('throws on a non-integer threshold', () => {
    expect(() => new RepeatToolReminder({ thresholds: [3.5] })).toThrow(/integer >= 2/);
  });

  it('throws on a threshold below 2', () => {
    expect(() => new RepeatToolReminder({ thresholds: [1] })).toThrow(/integer >= 2/);
  });

  it('throws on a duplicate threshold', () => {
    expect(() => new RepeatToolReminder({ thresholds: [3, 3] })).toThrow(/must not contain duplicates/);
  });

  it('throws on an invalid argumentsPreviewChars', () => {
    expect(() => new RepeatToolReminder({ argumentsPreviewChars: 0 })).toThrow(/argumentsPreviewChars/);
  });
});
