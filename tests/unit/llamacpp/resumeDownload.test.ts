/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Direct test of the extracted `resumeDownload` module.
 *
 * Deliberately a single test: the resume behaviours (Range on a `.part`,
 * 200-restart, oversized-partial discard, reuse of a completed file) are
 * already covered end-to-end by `LlamaCppProvisioner.test.ts`, which now
 * delegates to this module. This one exists so a regression in the module
 * itself is named after the module, not after whichever provisioner happened
 * to trip over it first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResumeDownloadError, resumeDownload } from '@process/services/llamacpp/resumeDownload';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'darhai-resume-dl-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('resumeDownload', () => {
  it('resumes a .part with a Range request, appends the 206 body, and renames atomically', async () => {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz', 'utf8');
    const destPath = path.join(work, 'payload.bin');
    // An earlier attempt was killed after 10 bytes.
    await writeFile(`${destPath}.part`, body.subarray(0, 10));

    const requests: { url: string; range: string | null }[] = [];
    const fetchStub: typeof globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const headers = new Headers((init?.headers as HeadersInit) || {});
      requests.push({ url: String(input), range: headers.get('range') });
      const start = Number.parseInt(/bytes=(\d+)-/.exec(headers.get('range') || '')?.[1] || '0', 10);
      return new Response(new Uint8Array(body.subarray(start)), { status: 206 });
    }) as typeof globalThis.fetch;

    const seen: number[] = [];
    await resumeDownload({
      url: 'https://example.invalid/payload.bin',
      destPath,
      expectedBytes: body.length,
      signal: new AbortController().signal,
      fetch: fetchStub,
      onBytes: (n) => seen.push(n),
    });

    // The request asked to continue exactly where the partial stopped.
    expect(requests).toHaveLength(1);
    expect(requests[0].range).toBe('bytes=10-');
    // The spliced file is the complete payload, at the final path, with no
    // .part left behind - and progress started from the resumed prefix.
    expect(await readFile(destPath)).toEqual(body);
    expect(existsSync(`${destPath}.part`)).toBe(false);
    expect(seen[0]).toBe(10);
    expect(seen[seen.length - 1]).toBe(body.length);
    // The typed error class is what callers map from; assert it is exported
    // in the shape they rely on.
    expect(new ResumeDownloadError('FAILED', 'x').code).toBe('FAILED');
  });
});
