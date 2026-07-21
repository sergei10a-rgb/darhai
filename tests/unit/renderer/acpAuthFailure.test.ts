/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeAuthFailure,
  classifyAcpAuthFailure,
  getAcpAuthRemedy,
} from '@/renderer/pages/conversation/platforms/acp/acpAuthFailure';

describe('looksLikeAuthFailure', () => {
  it.each(['Invalid API key', 'createSession returned null', '[ACP-AUTH-401] rejected', 'HTTP 401', 'UNAUTHORIZED'])(
    'returns true for %s',
    (errorMsg) => {
      expect(looksLikeAuthFailure(errorMsg)).toBe(true);
    }
  );

  it('returns false for an unrelated error', () => {
    expect(looksLikeAuthFailure('network timeout while reading file')).toBe(false);
  });
});

describe('classifyAcpAuthFailure', () => {
  it('classifies claude as subscription-blocked, Anthropic key', () => {
    const remedy = classifyAcpAuthFailure('claude', 'Invalid API key');
    expect(remedy).not.toBeNull();
    expect(remedy?.subscriptionOAuthBlocked).toBe(true);
    expect(remedy?.providerKeyLabel).toBe('Anthropic');
    expect(remedy?.backendLabel).toBe('Claude Code');
  });

  it('classifies codex as subscription-blocked, OpenAI key, with cliLogin', () => {
    const remedy = classifyAcpAuthFailure('codex', 'authentication failed');
    expect(remedy?.subscriptionOAuthBlocked).toBe(true);
    expect(remedy?.providerKeyLabel).toBe('OpenAI');
    expect(remedy?.cliLoginCmd).toBe('codex login');
    expect(remedy?.backendLabel).toBe('Codex');
  });

  it('classifies a vendor CLI (droid) as not blocked, with default login cmd', () => {
    const remedy = classifyAcpAuthFailure('droid', 'unauthorized');
    expect(remedy?.subscriptionOAuthBlocked).toBe(false);
    expect(remedy?.cliLoginCmd).toBe('droid login');
    expect(remedy?.providerKeyLabel).toBeUndefined();
    expect(remedy?.backendLabel).toBe('Factory Droid');
  });

  it('returns null for a non-auth error', () => {
    expect(classifyAcpAuthFailure('claude', 'network timeout while reading file')).toBeNull();
  });

  it('classifies wcore with no CLI login and a tailored explainer', () => {
    const remedy = classifyAcpAuthFailure('wcore', 'API error 401: invalid x-api-key');
    expect(remedy).not.toBeNull();
    expect(remedy?.backendLabel).toBe('Darhai Core');
    // No CLI login and no subscription fallback for the engine.
    expect(remedy?.cliLoginCmd).toBeUndefined();
    expect(remedy?.subscriptionOAuthBlocked).toBe(false);
    expect(remedy?.explainerKey).toBe('conversation.acpAuthFailure.wcoreExplainer');
  });
});

describe('getAcpAuthRemedy', () => {
  it('returns a descriptor for an arbitrary backend without an error gate', () => {
    const remedy = getAcpAuthRemedy('qwen');
    expect(remedy.backend).toBe('qwen');
    expect(remedy.backendLabel).toBe('Qwen Code');
    expect(remedy.cliLoginCmd).toBe('qwen');
  });

  it('Title-cases an unknown backend id', () => {
    const remedy = getAcpAuthRemedy('hermes');
    expect(remedy.backendLabel).toBe('Hermes');
    expect(remedy.cliLoginCmd).toBe('hermes login');
  });

  it('applies runtime overrides (wcore names the failing provider)', () => {
    const remedy = getAcpAuthRemedy('wcore', { providerKeyLabel: 'Anthropic' });
    expect(remedy.backendLabel).toBe('Darhai Core');
    expect(remedy.providerKeyLabel).toBe('Anthropic');
    expect(remedy.cliLoginCmd).toBeUndefined();
  });
});
