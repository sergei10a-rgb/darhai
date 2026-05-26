/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * IJFW IPC verb schemas — trust boundary for renderer → main verb invocations.
 * Fixes SEC-002 (positive-root path containment), SEC-011 (prototype pollution),
 * SEC-012 (byte-count not utf16-unit count).
 */

import * as path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import { IJFW_ERROR_REASONS, type IjfwErrorReason } from '@/common/types/ijfw';

export const ALLOWED_VERBS = [
  'think',
  'links',
  'wiki.get',
  'wiki.compile',
  'wiki.promote',
  'wiki.export',
  'wiki.shareReadme',
  'conflict.resolve',
] as const;
export type IjfwVerb = (typeof ALLOWED_VERBS)[number];

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const queryStringSchema = z.string().min(1).max(2000);

// SEC-002: positive-root containment, not denylist.
function getAllowedExportRoots(): string[] {
  return [app.getPath('downloads'), app.getPath('documents')].map((p) => path.resolve(p));
}

const exportPathSchema = z.string().refine((p) => {
  const resolved = path.resolve(p);
  const roots = getAllowedExportRoots();
  return roots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}, 'Path must be inside Downloads or Documents');

const COMPILE_TYPES = ['summary', 'timeline', 'entity', 'concept', 'candidate'] as const;

export const verbSchemas: Record<IjfwVerb, z.ZodTypeAny> = {
  think: z.object({ query: queryStringSchema }),
  links: z.object({ of: slugSchema }),
  'wiki.get': z.object({ slug: slugSchema }),
  'wiki.compile': z.object({
    subject: z.string().min(1).max(500),
    type: z.enum(COMPILE_TYPES).optional(),
  }),
  'wiki.promote': z.object({ slug: slugSchema }),
  'wiki.export': z.object({ slug: slugSchema, outFile: exportPathSchema }),
  'wiki.shareReadme': z.object({}),
  'conflict.resolve': z.object({
    subject: z.string().min(1).max(500),
    predicate: z.string().min(1).max(500),
    winnerId: z.string().min(1).max(200),
    supersede: z.boolean().optional(),
  }),
};

export const MAX_ARGS_BYTES = 1_048_576;

// SEC-012: byte-count not utf16-unit count.
function byteSize(serialized: string): number {
  return Buffer.byteLength(serialized, 'utf8');
}

// SEC-011: prototype-pollution reject.
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function rejectDangerousKeys(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => rejectDangerousKeys(entry));
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) return true;
    if (rejectDangerousKeys((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

export type ValidatedInvocation =
  | { ok: true; verb: IjfwVerb; args: Record<string, unknown> }
  | { ok: false; reason: string };

export function validateInvocation(verb: string, args: unknown): ValidatedInvocation {
  if (!(ALLOWED_VERBS as readonly string[]).includes(verb)) {
    return { ok: false, reason: 'verb_not_allowed' };
  }
  if (rejectDangerousKeys(args)) {
    return { ok: false, reason: 'unsafe_keys' };
  }
  const serialized = JSON.stringify(args ?? {});
  if (byteSize(serialized) > MAX_ARGS_BYTES) {
    return { ok: false, reason: 'args_too_large' };
  }
  const schema = verbSchemas[verb as IjfwVerb];
  const result = schema.safeParse(args);
  if (!result.success) return { ok: false, reason: `schema_invalid: ${result.error.message}` };
  return { ok: true, verb: verb as IjfwVerb, args: result.data as Record<string, unknown> };
}

// SEC-011 also applies to JSON-RPC responses coming back from the MCP server.
export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.number().int().nonnegative(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string() })
      .optional(),
  })
  .strict();

export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

// Standardized errorReason enum (mirrors @/common/types/ijfw IjfwErrorReason).
export const ijfwErrorReasonSchema = z.enum(
  IJFW_ERROR_REASONS as unknown as readonly [IjfwErrorReason, ...IjfwErrorReason[]],
);

// Renderer → main argument schema for `brain.invoke`. Pre-flight only — the
// real validation happens via `validateInvocation` against the per-verb schema.
export const brainInvokeArgsSchema = z
  .object({
    verb: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type BrainInvokeArgs = z.infer<typeof brainInvokeArgsSchema>;
