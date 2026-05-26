/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const downloadsDir = path.join(os.homedir(), 'Downloads');
const documentsDir = path.join(os.homedir(), 'Documents');

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'downloads') return downloadsDir;
      if (name === 'documents') return documentsDir;
      throw new Error(`unexpected path: ${name}`);
    },
  },
}));

// eslint-disable-next-line import/first
import {
  ALLOWED_VERBS,
  MAX_ARGS_BYTES,
  jsonRpcResponseSchema,
  validateInvocation,
  ijfwErrorReasonSchema,
  brainInvokeArgsSchema,
} from '@process/services/ijfw/ipcSchemas';
import { IJFW_ERROR_REASONS } from '@/common/types/ijfw';

describe('ijfw/ipcSchemas', () => {
  describe('verb allowlist', () => {
    it('rejects unknown verbs', () => {
      const result = validateInvocation('not.a.verb', {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('verb_not_allowed');
    });

    it('exposes a frozen tuple of allowed verbs', () => {
      expect(ALLOWED_VERBS).toContain('think');
      expect(ALLOWED_VERBS).toContain('wiki.compile');
      expect(ALLOWED_VERBS).toContain('conflict.resolve');
    });
  });

  describe('think verb', () => {
    it('accepts a valid query', () => {
      const result = validateInvocation('think', { query: 'hello world' });
      expect(result.ok).toBe(true);
    });

    it('rejects empty query', () => {
      const result = validateInvocation('think', { query: '' });
      expect(result.ok).toBe(false);
    });
  });

  describe('wiki.compile verb', () => {
    it('accepts a subject without type', () => {
      const result = validateInvocation('wiki.compile', { subject: 'Wayland' });
      expect(result.ok).toBe(true);
    });

    it('accepts a valid type from the enum', () => {
      const result = validateInvocation('wiki.compile', { subject: 'Wayland', type: 'summary' });
      expect(result.ok).toBe(true);
    });

    it('rejects an unknown type value', () => {
      const result = validateInvocation('wiki.compile', { subject: 'Wayland', type: 'narrative' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/schema_invalid/);
    });
  });

  describe('wiki.export path containment', () => {
    it('accepts a path inside Downloads', () => {
      const out = path.join(downloadsDir, 'memory.md');
      const result = validateInvocation('wiki.export', { slug: 'memory', outFile: out });
      expect(result.ok).toBe(true);
    });

    it('accepts a path inside Documents', () => {
      const out = path.join(documentsDir, 'memory.md');
      const result = validateInvocation('wiki.export', { slug: 'memory', outFile: out });
      expect(result.ok).toBe(true);
    });

    it('rejects ~/.ssh/config', () => {
      const out = path.join(os.homedir(), '.ssh', 'config');
      const result = validateInvocation('wiki.export', { slug: 'memory', outFile: out });
      expect(result.ok).toBe(false);
    });

    it('rejects /private/etc/passwd', () => {
      const result = validateInvocation('wiki.export', {
        slug: 'memory',
        outFile: '/private/etc/passwd',
      });
      expect(result.ok).toBe(false);
    });

    it('rejects path traversal escaping the root', () => {
      const out = path.join(downloadsDir, '..', '..', 'etc', 'passwd');
      const result = validateInvocation('wiki.export', { slug: 'memory', outFile: out });
      expect(result.ok).toBe(false);
    });
  });

  describe('slug validation', () => {
    it('rejects slug with uppercase letters', () => {
      const result = validateInvocation('wiki.get', { slug: 'MySlug' });
      expect(result.ok).toBe(false);
    });

    it('rejects slug starting with a hyphen', () => {
      const result = validateInvocation('wiki.get', { slug: '-leading' });
      expect(result.ok).toBe(false);
    });

    it('accepts a-z 0-9 dashes', () => {
      const result = validateInvocation('wiki.get', { slug: 'my-good-slug-99' });
      expect(result.ok).toBe(true);
    });
  });

  describe('byte-size limit (SEC-012)', () => {
    it('rejects args whose serialized JSON exceeds MAX_ARGS_BYTES by byte count', () => {
      // Build a string that's mostly multi-byte runes so utf16 length and byte length diverge
      const bigUtf8 = '😀'.repeat(Math.ceil(MAX_ARGS_BYTES / 4) + 10);
      const result = validateInvocation('think', { query: bigUtf8 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('args_too_large');
    });
  });

  describe('prototype-pollution guard (SEC-011)', () => {
    it('rejects __proto__ when present as an own key (as JSON.parse produces)', () => {
      const args = JSON.parse('{"query":"hi","__proto__":{"polluted":true}}');
      const result = validateInvocation('think', args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsafe_keys');
    });

    it('rejects nested constructor key', () => {
      const args = JSON.parse('{"query":"hi","nested":{"constructor":{"evil":true}}}');
      const result = validateInvocation('think', args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsafe_keys');
    });

    it('rejects prototype key', () => {
      const result = validateInvocation('think', { query: 'hi', prototype: {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsafe_keys');
    });
  });

  describe('jsonRpcResponseSchema', () => {
    it('accepts a result response', () => {
      expect(
        jsonRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 1, result: { ok: true } }).success,
      ).toBe(true);
    });

    it('accepts an error response', () => {
      expect(
        jsonRpcResponseSchema.safeParse({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'bad' },
        }).success,
      ).toBe(true);
    });

    it('rejects extra unknown keys (strict)', () => {
      expect(
        jsonRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 1, result: {}, extra: 'nope' })
          .success,
      ).toBe(false);
    });

    it('rejects non-2.0 protocol', () => {
      expect(jsonRpcResponseSchema.safeParse({ jsonrpc: '1.0', id: 1, result: {} }).success).toBe(
        false,
      );
    });
  });

  describe('ijfwErrorReasonSchema', () => {
    it('accepts every IJFW_ERROR_REASONS entry', () => {
      for (const reason of IJFW_ERROR_REASONS) {
        expect(ijfwErrorReasonSchema.safeParse(reason).success).toBe(true);
      }
    });
    it('rejects unknown reasons', () => {
      expect(ijfwErrorReasonSchema.safeParse('nonsense').success).toBe(false);
    });
  });

  describe('brainInvokeArgsSchema', () => {
    it('accepts a valid invocation envelope', () => {
      const parsed = brainInvokeArgsSchema.safeParse({ verb: 'think', args: { query: 'hi' } });
      expect(parsed.success).toBe(true);
    });
    it('accepts a verb with no args', () => {
      expect(brainInvokeArgsSchema.safeParse({ verb: 'wiki.shareReadme' }).success).toBe(true);
    });
    it('rejects empty verb', () => {
      expect(brainInvokeArgsSchema.safeParse({ verb: '', args: {} }).success).toBe(false);
    });
    it('rejects extra top-level keys (strict)', () => {
      expect(
        brainInvokeArgsSchema.safeParse({ verb: 'think', args: {}, evil: true }).success,
      ).toBe(false);
    });
  });
});
