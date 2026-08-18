/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loopback OAuth callback server, distilled from prime-agent's per-provider
 * copies (MIT, (c) Mario Zechner + Prime Intellect) into one reusable helper.
 * Used by the Claude Max and ChatGPT flows, which differ only in host/port/path
 * and how they validate `state`.
 */

import type { Server } from 'node:http';
import { oauthErrorHtml, oauthSuccessHtml } from './oauthPage';

/** A running callback server and the primitives a flow needs to drive it. */
export type LoopbackServer = {
  redirectUri: string;
  /** Resolves with the received `{ code, state }`, or `null` if cancelled. */
  waitForCode: () => Promise<{ code: string; state: string } | null>;
  /** Force {@link waitForCode} to resolve `null` (e.g. manual paste won the race). */
  cancel: () => void;
  /** Close the underlying HTTP server. Always call in a `finally`. */
  close: () => void;
};

export type LoopbackServerOptions = {
  host: string;
  port: number;
  path: string;
  /** Predicate the received `state` must satisfy, else the browser sees an error. */
  validateState: (state: string) => boolean;
  /** Message rendered on the success page. */
  successMessage: string;
};

/**
 * Start a one-shot loopback HTTP server that captures the OAuth `code`/`state`
 * from the redirect. Rejects the outer promise if the port cannot be bound so
 * the caller can fall back to manual code paste.
 */
export async function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const { createServer } = await import('node:http');

  return new Promise<LoopbackServer>((resolve, reject) => {
    let settle: ((value: { code: string; state: string } | null) => void) | undefined;
    const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
      let settled = false;
      settle = (value) => {
        if (settled) return;
        settled = true;
        resolveWait(value);
      };
    });

    const server: Server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        if (url.pathname !== options.path) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(oauthErrorHtml('Callback route not found.'));
          return;
        }

        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(oauthErrorHtml('Authentication did not complete.', `Error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(oauthErrorHtml('Missing code or state parameter.'));
          return;
        }
        if (!options.validateState(state)) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(oauthErrorHtml('State mismatch.'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthSuccessHtml(options.successMessage));
        settle?.({ code, state });
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal error');
      }
    });

    server.on('error', (err) => reject(err));

    server.listen(options.port, options.host, () => {
      resolve({
        redirectUri: `http://localhost:${options.port}${options.path}`,
        waitForCode: () => waitForCodePromise,
        cancel: () => settle?.(null),
        close: () => server.close(),
      });
    });
  });
}

/**
 * Parse a pasted authorization value - accepts a bare code, a `code#state`
 * fragment, a `code=...&state=...` query, or a full redirect URL. Shared by the
 * manual-paste fallback of every callback-server flow.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL - fall through
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}
