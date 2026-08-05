/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wiring, not just the helper.
 *
 * `mcpStdioSpawn.test.ts` proves the resolver decides correctly. This proves the
 * session-injection path actually CALLS it - which is the part that was broken:
 * the resolver logic already existed on the connection-test path, and the bug
 * was precisely that the session path did not use it. A green helper test would
 * have said nothing about that.
 *
 * The platform is forced in both directions so the assertions hold on every CI
 * shard, not just whichever OS happens to run them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';

vi.mock('@process/utils/shellEnv', () => ({
  resolveNpxPath: () => '/bundled/bun.exe',
  normalizeNpxArgsForBundledBun: (args: string[]) =>
    args.filter((arg) => arg !== '-y' && arg !== '--yes' && arg !== '--prefer-offline'),
}));

import { buildAcpSessionMcpServers } from '@process/agent/acp/mcpSessionConfig';

const realPlatform = process.platform;
const setPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
});

const npxServer: IMcpServer = {
  id: 'catalog-1',
  name: 'chrome-devtools',
  enabled: true,
  status: 'connected',
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  createdAt: 1,
  updatedAt: 1,
  originalJson: '{}',
} as IMcpServer;

const caps = { stdio: true, http: true, sse: true };

describe('buildAcpSessionMcpServers resolves npx before it reaches the agent', () => {
  it('does not hand the agent a bare npx on Windows', () => {
    // The exact defect: `npx` is `npx.cmd` on Windows and does not resolve for a
    // shell:false spawn, so the server started nothing and the session showed a
    // connected badge with zero tools.
    setPlatform('win32');

    const [server] = buildAcpSessionMcpServers([npxServer], caps);

    expect(server).toBeDefined();
    expect('command' in server! && server.command).not.toBe('npx');
    expect('command' in server! && server.command).toBe('/bundled/bun.exe');
    expect('args' in server! && server.args).toEqual(['x', '--bun', 'chrome-devtools-mcp@latest']);
  });

  it('leaves npx untouched off Windows', () => {
    // Resolving here would bake an absolute path into a persisted config that
    // goes stale on an AppImage relaunch.
    setPlatform('linux');

    const [server] = buildAcpSessionMcpServers([npxServer], caps);

    expect('command' in server! && server.command).toBe('npx');
    expect('args' in server! && server.args).toEqual(['-y', 'chrome-devtools-mcp@latest']);
  });

  it('leaves a non-npx command alone on Windows', () => {
    setPlatform('win32');
    const uvxServer = {
      ...npxServer,
      transport: { type: 'stdio' as const, command: 'uvx', args: ['mcp-server-git'] },
    } as IMcpServer;

    const [server] = buildAcpSessionMcpServers([uvxServer], caps);

    expect('command' in server! && server.command).toBe('uvx');
    expect('args' in server! && server.args).toEqual(['mcp-server-git']);
  });
});
