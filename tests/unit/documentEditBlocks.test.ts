/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the pure edit-block helpers that back the Documents AI loop
 * (ported from Odysseus's FIND/REPLACE + FIND/SUGGEST/REASON protocols).
 */

import { describe, it, expect } from 'vitest';
import { applyEdits, parseEditBlocks, parseSuggestBlocks } from '@process/services/documents/editBlocks';

describe('parseEditBlocks', () => {
  it('parses multiple FIND/REPLACE blocks', () => {
    const reply = [
      '<<<FIND>>>',
      'a',
      '<<<REPLACE>>>',
      'b',
      '<<<END>>>',
      '<<<FIND>>>',
      'c',
      '<<<REPLACE>>>',
      'd',
      '<<<END>>>',
    ].join('\n');
    expect(parseEditBlocks(reply)).toEqual([
      { find: 'a', replace: 'b' },
      { find: 'c', replace: 'd' },
    ]);
  });

  it('returns [] when the reply has no blocks', () => {
    expect(parseEditBlocks('sorry, I could not help')).toEqual([]);
  });
});

describe('applyEdits', () => {
  it('replaces the first occurrence of each FIND and counts applied/skipped', () => {
    const result = applyEdits('the cat sat', [
      { find: 'cat', replace: 'dog' },
      { find: 'missing', replace: 'x' },
    ]);
    expect(result.content).toBe('the dog sat');
    expect(result.appliedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
  });

  it('matches after stripping a leading line-number gutter from FIND', () => {
    const result = applyEdits('hello world', [{ find: '1\thello world', replace: 'goodbye world' }]);
    expect(result.content).toBe('goodbye world');
    expect(result.appliedCount).toBe(1);
  });
});

describe('parseSuggestBlocks', () => {
  it('parses FIND/SUGGEST/REASON blocks', () => {
    const reply = ['<<<FIND>>>', 'quick', '<<<SUGGEST>>>', 'swift', '<<<REASON>>>', 'stronger', '<<<END>>>'].join('\n');
    expect(parseSuggestBlocks(reply)).toEqual([{ find: 'quick', suggest: 'swift', reason: 'stronger' }]);
  });

  it('drops no-op suggestions where find == suggest', () => {
    const reply = ['<<<FIND>>>', 'same', '<<<SUGGEST>>>', 'same', '<<<REASON>>>', 'stronger', '<<<END>>>'].join('\n');
    expect(parseSuggestBlocks(reply)).toEqual([]);
  });

  it('drops suggestions whose reason signals no change', () => {
    const reply = ['<<<FIND>>>', 'a', '<<<SUGGEST>>>', 'b', '<<<REASON>>>', 'looks good already', '<<<END>>>'].join(
      '\n'
    );
    expect(parseSuggestBlocks(reply)).toEqual([]);
  });
});
