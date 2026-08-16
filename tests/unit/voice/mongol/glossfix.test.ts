/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { glossfix } from '@process/services/voice/mongol/glossfix';

describe('glossfix', () => {
  it('restores a Latin term and keeps the Mongolian suffix in place', () => {
    // The stem match stops before the suffix, so case endings survive - the
    // property that makes the pass safe on inflected Mongolian.
    expect(glossfix('надад имэйлээр илгээгээрэй')).toBe('надад emailээр илгээгээрэй');
    expect(glossfix('юүтюбээс үзсэн')).toBe('YouTubeээс үзсэн');
  });

  it('matches case-insensitively, including at sentence start', () => {
    expect(glossfix('Зүүм дээр уулзъя')).toBe('Zoom дээр уулзъя');
  });

  it('prefers the longest key over its own prefix', () => {
    // "ватсапп" (double п) must win over "ватсап"; a prefix-first order would
    // leave a stray "п" behind ("WhatsAppп").
    expect(glossfix('ватсаппаар бичье')).toBe('WhatsAppаар бичье');
  });

  it('never fires mid-word', () => {
    // "зум" is a key, but here it is preceded by a letter, so the word-start
    // guard must hold - this is the 0-false-positive property the source
    // glossary was measured for.
    expect(glossfix('арзумын')).toBe('арзумын');
  });

  it('returns text without glossary stems unchanged', () => {
    const text = 'Өнөөдөр Улаанбаатар хотод цас орно.';
    expect(glossfix(text)).toBe(text);
  });

  it('handles multi-word keys', () => {
    expect(glossfix('веб сайтад тавь')).toBe('websiteад тавь');
  });
});
