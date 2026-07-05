/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeFingerprint } from '@process/services/semantic/fingerprint';

describe('computeFingerprint', () => {
  it('is stable for identical inputs', () => {
    expect(computeFingerprint('hello', 'model-a', 384)).toBe(computeFingerprint('hello', 'model-a', 384));
  });

  it('changes when the text changes', () => {
    expect(computeFingerprint('hello', 'm', 384)).not.toBe(computeFingerprint('hellox', 'm', 384));
  });

  it('changes when the model changes (forces re-embed on model swap)', () => {
    expect(computeFingerprint('hello', 'model-a', 384)).not.toBe(computeFingerprint('hello', 'model-b', 384));
  });

  it('changes when the dimension changes', () => {
    expect(computeFingerprint('hello', 'm', 384)).not.toBe(computeFingerprint('hello', 'm', 768));
  });

  it('does not collide on shifted field boundaries', () => {
    // Length-prefixing must keep ('a','bc') distinct from ('ab','c')-style shifts.
    expect(computeFingerprint('ab', 'm', 384)).not.toBe(computeFingerprint('a', 'bm', 384));
  });

  it('handles Cyrillic text without throwing and stays stable', () => {
    const fp = computeFingerprint('Монгол хэл', 'm', 384);
    expect(fp).toHaveLength(16);
    expect(computeFingerprint('Монгол хэл', 'm', 384)).toBe(fp);
  });
});
