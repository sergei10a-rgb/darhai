/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strip credentials out of anything on its way to the persistent log file.
 *
 * Why this exists
 * ---------------
 * `configureConsoleLog.ts` routes EVERY main-process `console.*` call into a
 * daily 10 MB file on disk, and the app asks users to share that file when
 * reporting a bug. Two of those call sites forward bytes the app never chose:
 * the engine's whole stderr stream, and the full text of any event line that
 * failed to parse. Either can carry an API key, a bearer token or the contents
 * of a file a tool just read. Once written, a secret is on disk until the file
 * rotates - and the moment the user attaches it to an issue, it is public.
 *
 * The two halves
 * --------------
 *  1. **Known secrets** - values the app is actually holding (provider keys,
 *     mail passwords) are registered with {@link registerLogSecret} and removed
 *     literally. This is exact: no pattern can miss them.
 *  2. **Shaped tokens** - credentials the app has never seen, arriving inside
 *     someone else's error text, are matched by their issuer's own format.
 *
 * Both are needed. Patterns alone miss a key that looks like a word; a literal
 * list alone misses every credential the app does not hold, which is exactly
 * what shows up in a third-party MCP server's stderr.
 *
 * Deliberately NOT redacted: long base64/hex runs on their own. Tool output,
 * image data and hashes are full of them, and masking every one would turn the
 * log into noise - which costs the debuggability the log exists for. The rule
 * followed here is to match what an issuer stamps as a credential, not what
 * merely looks random.
 */

export const REDACTED = '***redacted***';

/**
 * Secrets the app is holding right now, longest first.
 *
 * A module-level set is the right shape because the sink it protects is also
 * global: `console` is patched once, and any module may log at any time. The
 * alternative - threading a redactor through every call site - fails open the
 * first time someone forgets, which is the failure this file exists to remove.
 */
const knownSecrets = new Set<string>();

/**
 * Register a value that must never appear in the log.
 *
 * Short values are ignored: a 6-character secret would also match ordinary
 * prose, and a log full of `***redacted***` where words used to be is worse
 * than useless. Callers holding genuinely short secrets should not rely on
 * this path.
 */
export function registerLogSecret(secret: string | null | undefined): void {
  if (typeof secret !== 'string') return;
  const trimmed = secret.trim();
  if (trimmed.length < 8) return;
  knownSecrets.add(trimmed);
}

/** Drop a secret that is no longer live (key rotated, account signed out). */
export function forgetLogSecret(secret: string): void {
  knownSecrets.delete(secret);
}

/** Test seam only. */
export function clearLogSecrets(): void {
  knownSecrets.clear();
}

/**
 * Credential shapes, by issuer.
 *
 * Each entry keeps its identifying prefix and masks the rest, so a redacted log
 * still tells you WHICH kind of credential was involved - the one detail that
 * actually helps when debugging an auth failure.
 */
const PATTERNS: readonly { readonly re: RegExp; readonly replace: string }[] = [
  // OpenAI and compatible: sk-, sk-proj-, sk-ant-, sk-svcacct-, sk-admin-
  { re: /\bsk-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}/g, replace: `sk-${REDACTED}` },
  // Google AI Studio / Gemini
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, replace: `AIza${REDACTED}` },
  // Google OAuth service-account style key ids used by newer Gemini keys
  { re: /\bAQ\.[A-Za-z0-9_-]{20,}/g, replace: `AQ.${REDACTED}` },
  // GitHub: personal, oauth, server-to-server, refresh, fine-grained
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: `gh_${REDACTED}` },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: `github_pat_${REDACTED}` },
  // Slack
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: `xox-${REDACTED}` },
  // AWS access key id (the secret itself is caught by the key=value rule below)
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: `AKIA${REDACTED}` },
  // Stripe
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: `sk_${REDACTED}` },
  // Anthropic legacy
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: `sk-ant-${REDACTED}` },
  // HuggingFace
  { re: /\bhf_[A-Za-z0-9]{16,}/g, replace: `hf_${REDACTED}` },
  // JWTs - three base64url segments. Matched because the header is a fixed
  // shape (`{"alg"` base64-encodes to `eyJhbGci`), not because it looks random.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: `jwt.${REDACTED}` },
  // Authorization headers of any scheme
  { re: /\b(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token)?\s*\S+/gi, replace: `$1${REDACTED}` },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, replace: `Bearer ${REDACTED}` },
  // key=value / "key": "value" for anything named like a credential. The value
  // side deliberately stops at a quote, comma, semicolon, ampersand or newline
  // so one match cannot swallow the rest of a JSON line.
  {
    re: /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd|credential|private[_-]?key)(\s*["']?\s*[:=]\s*["']?)([^"',;&\s\n]{4,})/gi,
    replace: `$1$2${REDACTED}`,
  },
  // URLs carrying credentials in userinfo: https://user:pass@host
  { re: /(\/\/[^/\s:@]+:)[^/\s@]+(@)/g, replace: `$1${REDACTED}$2` },
  // IMAP/SMTP inline auth, which error objects echo verbatim.
  //
  // The IMAP tag is required, not optional. Matching a bare `LOGIN` swallowed
  // the next two words of any sentence containing it - "imap login failed for
  // user@x" lost the word "for" - and a redactor that eats prose is a redactor
  // people switch off. A real command always carries a tag (`a1`, `A001`, `*`).
  { re: /\b(?:[A-Za-z]+\d+|\*)\s+(LOGIN\s+\S+\s+)\S+/g, replace: `$1${REDACTED}` },
  { re: /\bAUTH(?:ENTICATE)?\s+(?:PLAIN|LOGIN|XOAUTH2)\s+\S+/gi, replace: `AUTH ${REDACTED}` },
];

/** Apply every rule to one string. Known secrets go first, longest first. */
export function redactLogText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let out = text;
  // Longest first: a short secret that is a substring of a longer one must not
  // chop the longer one into pieces that then fail to match.
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const { re, replace } of PATTERNS) {
    // Each pattern is global; reset lastIndex so a previous call cannot make
    // this one start mid-string and miss a match at the front.
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

/** How deep to walk a logged object before giving up. */
const MAX_DEPTH = 6;

/**
 * Redact in place through whatever shape was logged.
 *
 * Structure is preserved rather than stringified, because electron-log's own
 * formatter is what turns these into a line; flattening here would change what
 * every existing log statement looks like. Errors are handled explicitly: their
 * `message` and `stack` are the usual carriers, and they are non-enumerable, so
 * a generic object walk would silently skip them - the exact place an auth
 * failure puts the credential.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;

  if (typeof value === 'string') return redactLogText(value);

  if (value instanceof Error) {
    // Rebuilding rather than mutating: the caller may still be using this Error
    // for control flow, and a redacted message would corrupt their comparison.
    const copy = new Error(redactLogText(value.message));
    copy.name = value.name;
    if (typeof value.stack === 'string') copy.stack = redactLogText(value.stack);
    return copy;
  }

  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1));

  if (value && typeof value === 'object') {
    // Only plain objects. A class instance may have getters with side effects,
    // and copying it would produce something that no longer behaves like itself.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactLogValue(item, depth + 1);
    return out;
  }

  return value;
}

/** Redact one electron-log `message.data` array. */
export function redactLogData(data: readonly unknown[]): unknown[] {
  return data.map((item) => redactLogValue(item));
}
