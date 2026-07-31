/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * What the app ACTUALLY hands an agent in `session/new`.
 *
 * Source review cannot answer this: the MCP list is assembled from persisted
 * config, agent capabilities and a path resolver, and the bug this spec exists
 * to pin was precisely a mismatch between what the app advertised and what was
 * on disk. So we stand up a real ACP agent (a Node script we control, set as
 * the conversation's `cliPath`), let the app drive a real connect, and read the
 * JSON-RPC it sent.
 *
 * Two properties are asserted against that captured payload:
 *   1. Every stdio MCP server the app advertises resolves to a file that
 *      exists - the default-on `darhai-search-skills` / `darhai-web-search`
 *      used to point at `out/main/builtin-mcp-*.js` files the production build
 *      never emitted, so every spawn died with MODULE_NOT_FOUND.
 *   2. A user-added (non-builtin) server reaches the session - the ACP paths
 *      filtered on `builtin === true`, so a user-installed MCP server could
 *      never be delivered to a custom agent at all.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';
import { createMockAgentBinary } from '../helpers/mockAgentBinary';

type StdioServer = { name: string; command: string; args?: string[] };
type JsonRpcRequest = { method?: string; params?: { mcpServers?: StdioServer[] } };

const USER_SERVER_NAME = 'e2e-user-mcp';

let visual: VisualApp;
let dumpFile: string;
let tmpRoot: string;

/** Minimal but real MCP stdio server, standing in for a user-installed one. */
function writeUserMcpServer(dir: string): string {
  const file = path.join(dir, 'user-echo-mcp.cjs');
  fs.writeFileSync(
    file,
    `'use strict';
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e-user-mcp', version: '1.0.0' } } });
    } else if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'e2e_echo', description: 'echo', inputSchema: { type: 'object' } }] } });
    }
  }
});
process.stdin.resume();
`,
    'utf-8'
  );
  return file;
}

test.beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-mcp-session-'));
  dumpFile = path.join(tmpRoot, 'acp-requests.jsonl');

  visual = await launchVisualApp();
  await waitForSettle(visual.page);

  // Register a user-added (non-builtin, connected) MCP server alongside the
  // builtins the app seeds itself.
  const existing =
    (await invokeBridge<StdioServerConfig[]>(visual.page, 'agent.config.storage.get', 'mcp.config').catch(() => [])) ??
    [];

  const userServer = {
    id: 'e2e-user-mcp-id',
    name: USER_SERVER_NAME,
    description: 'user-added server for the session/new assertion',
    enabled: true,
    builtin: false,
    status: 'connected',
    transport: { type: 'stdio', command: 'node', args: [writeUserMcpServer(tmpRoot)], env: {} },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    originalJson: '{}',
  };

  await invokeBridge(visual.page, 'agent.config.storage.set', {
    key: 'mcp.config',
    data: [...existing.filter((s) => s.name !== USER_SERVER_NAME), userServer],
  });
});

type StdioServerConfig = { name: string };

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('every MCP server the app puts in session/new exists on disk, user server included', async () => {
  const cliPath = createMockAgentBinary({ binary: 'claude', dumpRequestsTo: dumpFile });

  const conversation = await invokeBridge<{ id: string }>(
    visual.page,
    'create-conversation',
    {
      type: 'acp',
      name: 'mcp-session-probe',
      model: { id: 'mock', name: 'mock', useModel: 'mock', platform: 'custom' },
      extra: { backend: 'custom', cliPath: `node ${cliPath}`, workspace: process.cwd() },
    },
    30_000
  );
  expect(conversation?.id, 'conversation was not created').toBeTruthy();

  await invokeBridge(
    visual.page,
    'chat.send.message',
    { conversation_id: conversation.id, input: 'ping', msg_id: `probe_${Date.now()}` },
    60_000
  ).catch(() => {
    // The turn itself may fail; only the captured session/new matters here.
  });

  // Wait for the mock to record a session/new.
  const deadline = Date.now() + 90_000;
  let sessionNew: JsonRpcRequest | undefined;
  while (Date.now() < deadline && !sessionNew) {
    if (fs.existsSync(dumpFile)) {
      sessionNew = fs
        .readFileSync(dumpFile, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as JsonRpcRequest)
        .find((r) => r.method === 'session/new');
    }
    if (!sessionNew) await new Promise((r) => setTimeout(r, 1_000));
  }

  expect(sessionNew, `the app never sent session/new. dump: ${dumpFile}`).toBeTruthy();

  const servers = sessionNew?.params?.mcpServers ?? [];
  // eslint-disable-next-line no-console -- this payload is the evidence the spec exists to produce
  console.log('[mcp-session] session/new mcpServers =', JSON.stringify(servers, null, 2));

  expect(servers.length, 'session/new carried no MCP servers at all').toBeGreaterThan(0);

  const missing = servers
    .filter((s) => s.command === 'node')
    .map((s) => (s.args ?? [])[0])
    .filter((script): script is string => typeof script === 'string')
    .filter((script) => !fs.existsSync(script));
  expect(missing, `the app advertised MCP scripts that do not exist: ${missing.join(', ')}`).toEqual([]);

  expect(
    servers.map((s) => s.name),
    'a user-added (non-builtin) MCP server did not reach session/new'
  ).toContain(USER_SERVER_NAME);

  await invokeBridge(visual.page, 'remove-conversation', { id: conversation.id }).catch(() => {});
});
