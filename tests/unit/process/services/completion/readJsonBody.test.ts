/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A gateway in trouble answers with HTML, not JSON.
 *
 * All three provider paths in `oneShotComplete` called `res.json()` and only
 * THEN checked `res.ok`, so a 502 carrying a Cloudflare page threw a bare
 * `SyntaxError: Unexpected token '<'`. The completion died with a message
 * naming neither the provider nor the status, and OmniRoute - whose resilience
 * sits on top of this call - could not tell a broken upstream from a broken
 * request.
 */

import { describe, expect, it } from 'vitest';
import { readJsonBody } from '@process/services/completion/readJsonBody';

/** Minimal stand-in for the parts of Response this helper touches. */
const responseOf = (status: number, body: string): Response =>
  ({ status, ok: status >= 200 && status < 300, text: async () => body }) as unknown as Response;

describe('readJsonBody', () => {
  it('returns the parsed body on the happy path', async () => {
    const data = await readJsonBody<{ ok: boolean }>(responseOf(200, '{"ok":true}'), 'anthropic');
    expect(data.ok).toBe(true);
  });

  it('reports the status when the gateway answers with an HTML error page', async () => {
    const html = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>';
    await expect(readJsonBody(responseOf(502, html), 'openai-compatible')).rejects.toThrow(/^502:/);
  });

  it('names the provider, so a multi-provider route says which one failed', async () => {
    await expect(readJsonBody(responseOf(503, '<html></html>'), 'gemini')).rejects.toThrow(/gemini/);
  });

  it('quotes enough of the body to recognise what answered', async () => {
    await expect(readJsonBody(responseOf(502, '<html>Cloudflare Tunnel error</html>'), 'anthropic')).rejects.toThrow(
      /Cloudflare/
    );
  });

  it('does not paste an entire error page into the message', async () => {
    const huge = `<html>${'x'.repeat(50_000)}</html>`;
    await expect(readJsonBody(responseOf(502, huge), 'anthropic')).rejects.toThrow(
      // Truncated with an ellipsis rather than carrying 50 KB into a toast.
      /…/
    );
  });

  it('says so when the body is empty rather than throwing a parser error', async () => {
    await expect(readJsonBody(responseOf(204, ''), 'anthropic')).rejects.toThrow(/empty body/);
  });

  it('never surfaces a raw JSON parser error', async () => {
    // The whole point: the old failure was `Unexpected token '<'`, which tells
    // the user nothing about what went wrong or where.
    await expect(readJsonBody(responseOf(502, '<html>'), 'anthropic')).rejects.not.toThrow(/Unexpected token/);
  });
});
