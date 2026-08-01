/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One rule for every remote URL an extension is allowed to hand the app.
 *
 * The problem this closes
 * ----------------------
 * An extension manifest can point a settings tab at an external page, and that
 * page is loaded INSIDE the desktop app. Accepting `http://` there means
 * anyone on the same network - a cafe router, a hotel AP, a compromised ISP
 * hop - can rewrite the response in flight and run their script in a window
 * that already has the user's session in front of it. The manifest author does
 * not have to be malicious for this to happen; they only have to have typed
 * `http`.
 *
 * The type declaration for `entryUrl` already SAID "external https:// URL".
 * The code accepted either scheme. This makes the code agree with the promise.
 *
 * Loopback is the deliberate exception: `http://localhost:5173` is how an
 * extension author runs their own page while developing it, the bytes never
 * leave the machine, and refusing it would push people toward disabling the
 * check altogether - which is how a security control becomes decoration.
 */

/** Hosts whose traffic never crosses a network, so cleartext costs nothing. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export type RemoteUrlRefusalReason = 'not-a-url' | 'unsupported-scheme' | 'cleartext-http';

/**
 * Both members declare BOTH fields.
 *
 * This repo compiles without `strictNullChecks`, and under that setting a
 * discriminated union narrows unreliably - `if (!verdict.allowed)` still left
 * `verdict.reason` unknown to the checker. Declaring the absent field as
 * `undefined` on each side means call sites do not depend on narrowing at all.
 */
export type RemoteUrlVerdict =
  | { allowed: true; url: string; reason?: undefined }
  | { allowed: false; url?: undefined; reason: RemoteUrlRefusalReason };

/** True for a host that resolves to this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // 127.0.0.0/8 is entirely loopback, not just 127.0.0.1.
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Decide whether an extension-supplied remote URL may be used.
 *
 * Returns a verdict rather than throwing: every caller here is inside a loop
 * over many manifest entries, and one bad entry must skip that entry with a
 * readable log line, not abort the whole extension load.
 */
export function checkRemoteUrl(raw: string): RemoteUrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, reason: 'not-a-url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported-scheme' };
  }

  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return { allowed: false, reason: 'cleartext-http' };
  }

  return { allowed: true, url: parsed.toString() };
}

/** Log-ready sentence for a refusal, so each call site does not invent one. */
export function describeRemoteUrlRefusal(reason: RemoteUrlRefusalReason): string {
  switch (reason) {
    case 'not-a-url':
      return 'not a valid URL';
    case 'unsupported-scheme':
      return 'unsupported protocol (only https, or http on loopback)';
    case 'cleartext-http':
      return 'plain http to a remote host - anyone on the network could replace the content, so it is refused; use https';
  }
}
