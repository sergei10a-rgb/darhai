/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { parseRealName } from '@process/onboarding/detect';

describe('parseRealName', () => {
  it('parses a same-line RealName value', () => {
    expect(parseRealName('RealName: Jane Doe')).toBe('Jane Doe');
  });

  it('parses the two-line continuation form', () => {
    expect(parseRealName('RealName:\n Jane Doe')).toBe('Jane Doe');
  });

  it('trims surrounding whitespace', () => {
    expect(parseRealName('RealName:   Jane Doe   \n')).toBe('Jane Doe');
  });

  it('returns null when the RealName marker is absent', () => {
    expect(parseRealName('SomethingElse: value')).toBeNull();
  });

  it('returns null when the RealName value is empty', () => {
    expect(parseRealName('RealName: \n')).toBeNull();
  });

  it('returns null for the empty-continuation form', () => {
    expect(parseRealName('RealName:\n')).toBeNull();
  });
});
