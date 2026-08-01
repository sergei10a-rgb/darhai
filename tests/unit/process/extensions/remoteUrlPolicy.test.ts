/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An extension may not hand the app a cleartext remote URL to load.
 *
 * A settings tab's entry URL is rendered INSIDE the desktop app. Over plain
 * http, anyone between the user and that host - a cafe router, a hotel AP, a
 * compromised ISP hop - can rewrite the response and run their script in a
 * window the user already trusts. The type declaration promised `https://`;
 * the code accepted either. These tests hold the code to the promise.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkRemoteUrl,
  describeRemoteUrlRefusal,
  isLoopbackHost,
} from '@process/extensions/resolvers/utils/remoteUrlPolicy';

describe('checkRemoteUrl', () => {
  it('allows https to any host', () => {
    const verdict = checkRemoteUrl('https://tabs.example.mn/settings?tab=1');
    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed && verdict.url).toContain('tabs.example.mn');
  });

  it('REFUSES plain http to a remote host', () => {
    const verdict = checkRemoteUrl('http://tabs.example.mn/settings');
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toBe('cleartext-http');
  });

  it('allows plain http on loopback, where nothing crosses a network', () => {
    // This is how an extension author previews their own page. Refusing it
    // would push people toward turning the check off entirely.
    for (const url of [
      'http://localhost:5173/index.html',
      'http://127.0.0.1:8080/',
      'http://127.0.0.5:3000/',
      'http://[::1]:4000/',
    ]) {
      const verdict = checkRemoteUrl(url);
      expect(verdict.allowed, `${url} should be allowed`).toBe(true);
    }
  });

  it('refuses schemes that are not http(s) at all', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>x</script>']) {
      const verdict = checkRemoteUrl(url);
      expect(verdict.allowed, `${url} should be refused`).toBe(false);
    }
  });

  it('refuses text that is not a URL', () => {
    const verdict = checkRemoteUrl('definitely not a url');
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toBe('not-a-url');
  });

  it('is not fooled by a hostname that merely starts with localhost', () => {
    // `localhost.evil.mn` resolves wherever the attacker points it.
    const verdict = checkRemoteUrl('http://localhost.evil.mn/page');
    expect(verdict.allowed).toBe(false);
  });

  it('is not fooled by loopback in userinfo', () => {
    // `http://localhost@evil.mn/` connects to evil.mn, not localhost.
    const verdict = checkRemoteUrl('http://localhost@evil.mn/page');
    expect(verdict.allowed).toBe(false);
  });

  it('explains each refusal in a sentence a user could act on', () => {
    expect(describeRemoteUrlRefusal('cleartext-http')).toContain('https');
    expect(describeRemoteUrlRefusal('unsupported-scheme')).toContain('https');
    expect(describeRemoteUrlRefusal('not-a-url')).toContain('URL');
  });
});

describe('isLoopbackHost', () => {
  it('covers the whole 127.0.0.0/8 range, not just 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });
});

describe('the policy is actually applied to settings tabs', () => {
  it('SettingsTabResolver routes external entry points through checkRemoteUrl', () => {
    // The policy function could be perfect and unused. This is the only test
    // that fails if someone reverts the resolver to `new URL(...)` and a bare
    // protocol comparison, which is exactly how the hole was there to begin
    // with.
    const source = readFileSync(
      resolve(__dirname, '../../../../src/process/extensions/resolvers/SettingsTabResolver.ts'),
      'utf8'
    );

    expect(source, 'SettingsTabResolver no longer uses the remote-URL policy').toContain('checkRemoteUrl');
    expect(source, 'SettingsTabResolver compares protocols by hand again').not.toMatch(
      /external\.protocol\s*!==\s*'http:'/
    );
  });
});
