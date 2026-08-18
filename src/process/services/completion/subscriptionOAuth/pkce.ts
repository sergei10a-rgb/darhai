/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ported from prime-agent (`packages/ai/src/utils/oauth/pkce.ts`, MIT,
 * (c) Mario Zechner + Prime Intellect). Uses the Web Crypto API so it runs
 * unchanged in the Electron main process (Node 20+ exposes a global `crypto`).
 */

/** Encode raw bytes as an unpadded base64url string (RFC 7636 §A). */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** A PKCE verifier/challenge pair for the S256 code-challenge method. */
export type PkcePair = { verifier: string; challenge: string };

/**
 * Generate a PKCE `code_verifier` (43-char base64url of 32 random bytes) and
 * its S256 `code_challenge` (base64url of the verifier's SHA-256). Cross-platform
 * via Web Crypto - no Node `crypto` import, so the same module works in a Vitest
 * node worker and in the packaged Electron main process.
 */
export async function generatePkce(): Promise<PkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);

  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));

  return { verifier, challenge };
}
