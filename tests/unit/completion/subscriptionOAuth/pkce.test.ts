/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proves the PKCE pair is RFC-7636 correct: the challenge is the base64url of
 * SHA-256(verifier). We recompute the challenge independently from the returned
 * verifier - if `generatePkce` ever swapped in a wrong digest/encoding, this
 * asserts red. Also pins the verifier's shape (43-char base64url of 32 bytes).
 */

import { describe, it, expect } from 'vitest';
import { generatePkce } from '@process/services/completion/subscriptionOAuth/pkce';

const BASE64URL = /^[A-Za-z0-9\-_]+$/;

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

describe('generatePkce', () => {
  it('derives challenge = base64url(SHA-256(verifier))', async () => {
    const { verifier, challenge } = await generatePkce();

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = b64url(new Uint8Array(digest));

    expect(challenge).toBe(expected);
  });

  it('produces a 43-char unpadded base64url verifier (32 random bytes)', async () => {
    const { verifier } = await generatePkce();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).not.toContain('=');
  });

  it('is non-deterministic across calls (fresh randomness each time)', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('rejects a challenge that does not match a tampered verifier', async () => {
    const { verifier, challenge } = await generatePkce();
    const wrongDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${verifier}x`));
    expect(challenge).not.toBe(b64url(new Uint8Array(wrongDigest)));
  });
});
