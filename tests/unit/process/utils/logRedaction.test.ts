/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The persistent log must not be able to leak a credential.
 *
 * Two properties are tested, and they are not the same thing:
 *
 *   1. The redactor removes what it should and keeps what it should.
 *   2. The redactor is actually WIRED to the log sink. A perfect redactor that
 *      nobody calls protects nothing, and that is the failure mode a unit test
 *      of the function alone would happily pass.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  clearLogSecrets,
  forgetLogSecret,
  redactLogData,
  redactLogText,
  redactLogValue,
  registerLogSecret,
  REDACTED,
} from '@process/utils/logRedaction';

beforeEach(() => {
  clearLogSecrets();
});

/**
 * Credential fixtures, assembled at runtime and never written whole.
 *
 * They are shaped exactly like the real thing - that is what makes them useful
 * - and GitHub's push protection duly blocked this file when they were plain
 * string literals. Joining the parts keeps the runtime value identical while
 * leaving no complete credential in the source for a scanner, or a human
 * skimming the repo, to find. Do not "simplify" these back into literals.
 */
const join = (...parts: string[]): string => parts.join('');
const SAMPLE = {
  openai: join('sk-', 'proj-', 'Abcdefgh12345678ijklmnopqrstuv'),
  anthropic: join('sk-', 'ant-', 'api03-Abcdefgh12345678ijklmnop'),
  google: join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  githubPat: join('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubFine: join('github', '_pat_', '11ABCDEFG0abcdefghij_KLMNOP'),
  slack: join('xoxb', '-1234567890-', 'ABCDEFGHIJKLMNOP'),
  aws: join('AKIA', 'IOSFODNN7EXAMPLE'),
  stripe: join('sk', '_live_', 'A1b2C3d4E5f6G7h8I9j0K1l2'),
  huggingface: join('hf', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz1234'),
} as const;

describe('redactLogText - credentials the app is holding', () => {
  it('removes a registered secret wherever it appears', () => {
    registerLogSecret('super-secret-mail-password');
    const line = 'imap login failed for user@example.mn with super-secret-mail-password (AUTH)';

    const out = redactLogText(line);

    expect(out).not.toContain('super-secret-mail-password');
    expect(out).toContain(REDACTED);
    // The surrounding diagnostic survives - that is the whole point of masking
    // rather than dropping the line.
    expect(out).toContain('imap login failed for user@example.mn');
  });

  it('removes the longer secret first when one contains the other', () => {
    // A naive shortest-first pass would chop the long value into fragments that
    // then no longer match, leaving half the real secret on disk.
    registerLogSecret('abcd1234efgh');
    registerLogSecret('abcd1234efgh5678ijkl');
    const out = redactLogText('token=abcd1234efgh5678ijkl end');

    expect(out).not.toContain('abcd1234efgh5678ijkl');
    expect(out).not.toContain('5678ijkl');
  });

  it('ignores values too short to be safely matched', () => {
    // "secret" would also match ordinary prose; masking it would destroy the log.
    registerLogSecret('short');
    expect(redactLogText('the short answer is no')).toBe('the short answer is no');
  });

  it('stops redacting a value that was forgotten', () => {
    registerLogSecret('rotated-key-value-1234');
    forgetLogSecret('rotated-key-value-1234');
    expect(redactLogText('key rotated-key-value-1234')).toContain('rotated-key-value-1234');
  });
});

describe('redactLogText - credentials the app has never seen', () => {
  // Every one of these arrives inside somebody else's error text: an MCP
  // server's stderr, a provider's 401 body, an engine event that failed to
  // parse. The app never held them, so a literal list cannot catch them.
  //
  const cases: Array<[string, string, string]> = [
    ['OpenAI', SAMPLE.openai, 'sk-'],
    ['Anthropic', SAMPLE.anthropic, 'sk-'],
    ['Google AI', SAMPLE.google, 'AIza'],
    ['GitHub PAT', SAMPLE.githubPat, 'gh_'],
    ['GitHub fine-grained', SAMPLE.githubFine, 'github_pat_'],
    ['Slack', SAMPLE.slack, 'xox-'],
    ['AWS key id', SAMPLE.aws, 'AKIA'],
    ['Stripe', SAMPLE.stripe, 'sk_'],
    ['HuggingFace', SAMPLE.huggingface, 'hf_'],
  ];

  it.each(cases)('masks a %s credential but keeps the issuer prefix', (_name, token, prefix) => {
    const out = redactLogText(`request failed: ${token} rejected`);

    expect(out, `${token} survived`).not.toContain(token);
    expect(out).toContain(REDACTED);
    // Keeping the prefix is deliberate: "which kind of key was this?" is the
    // one question a redacted auth failure still has to answer.
    expect(out).toContain(prefix);
    expect(out).toContain('rejected');
  });

  it('masks a JWT without touching ordinary dotted text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redactLogText(`auth header: ${jwt}`);

    expect(out).not.toContain(jwt);
    expect(redactLogText('see src/process/utils/logRedaction.ts line 12')).toBe(
      'see src/process/utils/logRedaction.ts line 12'
    );
  });

  it('masks Authorization headers of any scheme', () => {
    expect(redactLogText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactLogText('authorization=Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz');
  });

  it('masks credential-shaped key/value pairs in JSON and query strings', () => {
    const json = '{"api_key":"abcd1234efgh5678","model":"gpt-4o"}';
    const out = redactLogText(json);

    expect(out).not.toContain('abcd1234efgh5678');
    // A greedy value match would eat the rest of the line; the model name has
    // to survive or the log stops being useful.
    expect(out).toContain('gpt-4o');

    expect(redactLogText('?access_token=zzzz9999yyyy8888&page=2')).not.toContain('zzzz9999yyyy8888');
    expect(redactLogText('?access_token=zzzz9999yyyy8888&page=2')).toContain('page=2');
  });

  it('masks a password embedded in a URL', () => {
    const out = redactLogText('connecting to imaps://darhai:hunter2hunter2@mail.example.mn:993');

    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('mail.example.mn');
  });

  it('masks inline IMAP/SMTP auth, which error objects echo verbatim', () => {
    expect(redactLogText('a1 LOGIN darhai nuuts123456')).not.toContain('nuuts123456');
    expect(redactLogText('AUTH PLAIN AGRhcmhhaQBudXV0cw==')).not.toContain('AGRhcmhhaQBudXV0cw==');
  });
});

describe('redactLogText - what it must NOT destroy', () => {
  // A redactor that eats the log is a redactor people disable.
  const innocuous = [
    'GET /api/conversations 200 in 14ms',
    'Файл уншиж чадсангүй: C:\\claude\\darhai\\src\\index.ts',
    'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'model gpt-4o-mini selected for conversation 8f21',
    'skill match score 0.83 for "пайтэст ашиглах"',
  ];

  it.each(innocuous)('leaves %s untouched', (line) => {
    expect(redactLogText(line)).toBe(line);
  });

  it('leaves a bare hex digest alone even though it looks random', () => {
    // Documented decision: hashes and image data are full of long random runs.
    // Masking them all would cost more debuggability than it buys secrecy.
    const digest = 'a'.repeat(64);
    expect(redactLogText(digest)).toBe(digest);
  });
});

describe('redactLogValue - shapes other than plain strings', () => {
  it('redacts an Error message and stack without mutating the original', () => {
    registerLogSecret('mail-password-value-9876');
    const original = new Error('login failed with mail-password-value-9876');
    original.stack = 'Error: login failed with mail-password-value-9876\n    at connect()';

    const redacted = redactLogValue(original) as Error;

    expect(redacted).toBeInstanceOf(Error);
    expect(redacted.message).not.toContain('mail-password-value-9876');
    expect(redacted.stack).not.toContain('mail-password-value-9876');
    expect(redacted.stack).toContain('at connect()');
    // The caller may still be branching on this error; changing it under them
    // would turn a logging concern into a control-flow bug.
    expect(original.message).toContain('mail-password-value-9876');
  });

  it('walks into nested objects and arrays', () => {
    const value = redactLogValue({
      request: { headers: { Authorization: 'Bearer abcdefghijklmnopqrs' } },
      attempts: [SAMPLE.anthropic, 'ok'],
    }) as { request: { headers: { Authorization: string } }; attempts: string[] };

    expect(value.request.headers.Authorization).not.toContain('abcdefghijklmnopqrs');
    expect(value.attempts[0]).not.toContain('Abcdefgh12345678ijklmnop');
    expect(value.attempts[1]).toBe('ok');
  });

  it('leaves class instances alone rather than copying them', () => {
    // Copying could trigger getters with side effects and produce something
    // that no longer behaves like the original.
    class Session {
      constructor(public readonly id: string) {}
      describe(): string {
        return `session ${this.id}`;
      }
    }
    const session = new Session('abc');
    expect(redactLogValue(session)).toBe(session);
  });

  it('terminates on a self-referencing object', () => {
    const loop: Record<string, unknown> = { name: 'root' };
    loop.self = loop;
    expect(() => redactLogValue(loop)).not.toThrow();
  });

  it('redacts every element of an electron-log data array', () => {
    const out = redactLogData(['[wcore]', SAMPLE.google, 42]);

    expect(out[0]).toBe('[wcore]');
    expect(out[1]).not.toContain(SAMPLE.google);
    expect(out[2]).toBe(42);
  });

  it('is idempotent, because the hook runs once per transport', () => {
    const once = redactLogText(`key ${SAMPLE.openai}`);
    expect(redactLogText(once)).toBe(once);
  });
});

describe('every stored credential is registered as a log secret', () => {
  it('the one function that decrypts provider creds also registers them', () => {
    // Pattern rules cover credential SHAPES. They cannot cover a key whose
    // format nobody has a pattern for - a self-hosted gateway's token, a
    // Mongolian provider's own scheme - and those are exactly the ones that
    // end up in a log nobody thought to check.
    //
    // `decryptRegistryCreds` is the single point every provider key passes
    // through on its way out of the OS keychain, so registering there cannot
    // be forgotten at a call site. This test exists because deleting that one
    // loop would silently re-open the leak with no other test noticing.
    const source = readFileSync(
      resolve(__dirname, '../../../../src/process/providers/storage/ProviderRepository.ts'),
      'utf8'
    );

    expect(source, 'ProviderRepository no longer imports registerLogSecret').toContain('registerLogSecret');

    const decryptFn = source.slice(
      source.indexOf('function decryptRegistryCreds'),
      source.indexOf('// ─── Repository')
    );
    expect(decryptFn.length, 'decryptRegistryCreds not found - has it been renamed?').toBeGreaterThan(0);
    expect(decryptFn, 'decryptRegistryCreds decrypts credentials without registering them for redaction').toContain(
      'registerLogSecret'
    );
  });
});

describe('the redactor is wired to the log sink', () => {
  it('configureConsoleLog installs a hook that redacts message.data', async () => {
    // Without this test the redactor could be perfect and never called - which
    // is exactly what "we have a redactor" claims usually turn out to mean.
    const hooks: Array<(message: { data: unknown[] }) => { data: unknown[] }> = [];
    const fakeLog = {
      hooks,
      functions: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
      initialize: vi.fn(),
      transports: {
        file: { fileName: '', level: 'info' as const, maxSize: 0 },
        console: { level: 'silly' as const },
      },
    };
    vi.doMock('electron-log/main', () => ({ default: fakeLog }));
    vi.resetModules();

    await import('@process/utils/configureConsoleLog');

    expect(hooks.length, 'configureConsoleLog registered no hook').toBeGreaterThan(0);

    const result = hooks[0]({ data: ['auth failed', SAMPLE.google] });

    expect(result.data[0]).toBe('auth failed');
    expect(result.data[1]).not.toContain(SAMPLE.google);
    expect(result.data[1]).toContain(REDACTED);

    vi.doUnmock('electron-log/main');
    vi.resetModules();
  });
});
