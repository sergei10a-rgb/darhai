/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A hosted MCP connector could be signed into and still not connect.
 *
 * `McpOAuthService` stored a token and the settings UI showed the account as
 * authenticated, but nothing put that token on a request. The user saw a
 * successful sign-in followed by a connection failure, with no way to tell
 * "your login is broken" from "the server is unreachable".
 *
 * The behaviour pinned here is the shape of the fix rather than the wiring:
 * a COPY carries the credential, the stored server never does, a header the
 * user set by hand is left alone, and a failure to look up a token can never
 * block the attempt.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';

type TokenGetter = (server: IMcpServer) => Promise<string | null>;

/** The token lookup this suite drives. Reassigned per test. */
let getValidToken: TokenGetter;
/** Calls recorded so a test can assert the lookup was skipped entirely. */
let lookupCalls = 0;

/**
 * Mirror of the private method in McpService, with its one dependency passed in.
 *
 * Injected rather than mocked because the project's vitest setup fails a test
 * whose `vi.fn` implementation throws - and "the lookup threw" is precisely one
 * of the cases that has to be covered here.
 */
async function attachOAuthToken(server: IMcpServer): Promise<IMcpServer> {
  const transport = server.transport;
  if (transport.type === 'stdio') return server;
  if (transport.headers?.Authorization) return server;
  try {
    lookupCalls += 1;
    const token = await getValidToken(server);
    if (!token) return server;
    return {
      ...server,
      transport: { ...transport, headers: { ...transport.headers, Authorization: `Bearer ${token}` } },
    };
  } catch {
    return server;
  }
}

const remote = (headers?: Record<string, string>): IMcpServer =>
  ({
    id: 'remote-1',
    name: 'com.slack-slack-mcp',
    enabled: true,
    transport: { type: 'streamable_http', url: 'https://mcp.example.com', headers },
  }) as unknown as IMcpServer;

const stdio = (): IMcpServer =>
  ({
    id: 'local-1',
    name: 'darhai-search-skills',
    enabled: true,
    transport: { type: 'stdio', command: 'bun', args: ['x.js'], env: {} },
  }) as unknown as IMcpServer;

beforeEach(() => {
  lookupCalls = 0;
  getValidToken = async () => null;
});

describe('attachOAuthToken', () => {
  it('puts the signed-in token on a remote server', async () => {
    getValidToken = async () => 'tok-123';
    const out = await attachOAuthToken(remote());
    expect(out.transport.type !== 'stdio' && out.transport.headers?.Authorization).toBe('Bearer tok-123');
  });

  it('never mutates the stored server, so no credential reaches mcp.config', async () => {
    getValidToken = async () => 'tok-123';
    const original = remote();
    const out = await attachOAuthToken(original);

    expect(out).not.toBe(original);
    expect(original.transport.type !== 'stdio' && original.transport.headers).toBeUndefined();
  });

  it('leaves a header the user set by hand alone', async () => {
    // They may be using a service token deliberately; replacing it silently
    // would be close to impossible to diagnose.
    getValidToken = async () => 'tok-123';
    const out = await attachOAuthToken(remote({ Authorization: 'Bearer mine' }));
    expect(out.transport.type !== 'stdio' && out.transport.headers?.Authorization).toBe('Bearer mine');
    expect(lookupCalls).toBe(0);
  });

  it('keeps other headers the server already carried', async () => {
    getValidToken = async () => 'tok-123';
    const out = await attachOAuthToken(remote({ 'X-Tenant': 'acme' }));
    const headers = out.transport.type !== 'stdio' ? out.transport.headers : undefined;
    expect(headers?.['X-Tenant']).toBe('acme');
    expect(headers?.Authorization).toBe('Bearer tok-123');
  });

  it('does not touch a stdio server, which has no headers to carry', async () => {
    const original = stdio();
    expect(await attachOAuthToken(original)).toBe(original);
    expect(lookupCalls).toBe(0);
  });

  it('passes the server through unchanged when there is no token', async () => {
    getValidToken = async () => null;
    const original = remote();
    expect(await attachOAuthToken(original)).toBe(original);
  });

  it('never blocks the attempt when the token lookup throws', async () => {
    // An unauthenticated attempt fails with the server's own message, which
    // tells the user more than an error from this layer would.
    getValidToken = async () => {
      throw new Error('keychain locked');
    };
    const original = remote();
    await expect(attachOAuthToken(original)).resolves.toBe(original);
  });
});
