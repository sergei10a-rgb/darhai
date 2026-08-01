/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Can this app actually execute a task? Two live proofs, in the real Electron
 * app, against a controllable mock ACP agent - no signed-in commercial CLI.
 *
 * 1. **The agent picker has agents.** `acp.get-available-agents` used to answer
 *    `[]` because the provider read `AgentRegistry`'s snapshot synchronously
 *    while boot-time detection was still running, and the renderer cached that
 *    empty array in SWR forever. The registry ALWAYS merges an unconditional
 *    Darhai Core + Gemini CLI entry once a detection pass completes, so a
 *    non-empty answer is exactly the signal that the query waited for the
 *    registry instead of racing it.
 *
 * 2. **A conversation turn completes.** `chat.send.message` answered
 *    `{ success: true }` while nothing at all was persisted. This drives a full
 *    turn end-to-end - create conversation -> send -> agent spawned -> reply
 *    streamed -> both messages in the DB - and additionally captures the raw
 *    JSON-RPC the agent received, so the assertion is about what actually
 *    crossed the process boundary rather than about what the source suggests.
 *
 * The mock agent is a real OS process spawned by the real production spawn path
 * (`spawnGenericBackend` -> `createGenericSpawnConfig` -> `spawn`), reached by
 * pointing a `custom` backend's cliPath at it. Nothing about the transport,
 * framing or session lifecycle is stubbed.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';
import { createMockAgentBinary } from '../helpers/mockAgentBinary';

type AvailableAgent = { backend: string; name: string; kind?: string; cliPath?: string };
type BridgeResponse<T> = { success: boolean; msg?: string; data?: T };
type PersistedMessage = {
  id: string;
  msg_id?: string;
  type: string;
  position?: string;
  content?: unknown;
};

/** The two engines AgentRegistry.merge() always emits, on every platform. */
const UNCONDITIONAL_BACKENDS = ['wcore', 'gemini'] as const;

/** Text the mock streams back, in two chunks, so streaming is exercised too. */
const REPLY_CHUNKS = ['Mock agent reply: ', 'turn completed.'] as const;
const EXPECTED_REPLY = REPLY_CHUNKS.join('');

const USER_PROMPT = 'darhai-e2e-full-turn-probe';

/** A turn has to be allowed to spawn Node, hand-shake and stream back. */
const TURN_TIMEOUT_MS = 120_000;

let visual: VisualApp;
let workspace: string;
let jsonRpcDumpPath: string;
let mockBinaryPath: string;

test.beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-acp-turn-'));
  jsonRpcDumpPath = path.join(workspace, 'agent-received.jsonl');
  mockBinaryPath = createMockAgentBinary({
    binary: 'claude',
    responses: [{ type: 'text', chunks: [...REPLY_CHUNKS] }],
    dumpRequestsTo: jsonRpcDumpPath,
  });
  visual = await launchVisualApp();
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

test('acp.get-available-agents answers with the detected engines, never an empty list', async () => {
  const response = await invokeBridge<BridgeResponse<AvailableAgent[]>>(
    visual.page,
    'acp.get-available-agents',
    undefined,
    30_000
  );

  expect(response.success, `provider failed: ${response.msg}`).toBe(true);
  const agents = response.data ?? [];
  const backends = agents.map((a) => a.backend);

  expect(
    agents.length,
    `agent picker would render zero pills - acp.get-available-agents returned ${JSON.stringify(response)}`
  ).toBeGreaterThan(0);

  // These are added by merge(), which only runs at the end of a detection pass.
  // Their presence is the proof that the query waited rather than raced.
  for (const backend of UNCONDITIONAL_BACKENDS) {
    expect(backends, `missing always-present backend "${backend}" in ${JSON.stringify(backends)}`).toContain(backend);
  }
});

test('a conversation turn completes end-to-end against a mock ACP agent', async () => {
  test.setTimeout(TURN_TIMEOUT_MS + 60_000);

  // `node <script>` is the CLI path: the production Windows/POSIX parsers split
  // it into command + inline args and spawn it with no shell.
  const cliPath = `node ${mockBinaryPath}`;

  const conversation = await invokeBridge<{ id?: string }>(
    visual.page,
    'create-conversation',
    {
      type: 'acp',
      name: 'e2e mock turn',
      model: { id: 'mock', name: 'mock', platform: 'custom', useModel: 'mock' },
      extra: {
        backend: 'custom',
        customAgentId: 'e2e-mock-agent',
        cliPath,
        workspace,
        customWorkspace: true,
      },
    },
    60_000
  );

  expect(conversation?.id, `create-conversation returned ${JSON.stringify(conversation)}`).toBeTruthy();
  const conversationId = conversation.id as string;

  const msgId = `e2e-turn-${Date.now()}`;
  const sendResult = await invokeBridge<BridgeResponse<unknown>>(
    visual.page,
    'chat.send.message',
    { conversation_id: conversationId, msg_id: msgId, input: USER_PROMPT },
    TURN_TIMEOUT_MS
  );
  expect(sendResult.success, `chat.send.message failed: ${sendResult.msg}`).toBe(true);

  // Poll the DB rather than the UI: the claim under test is persistence, and a
  // rendered bubble that is never written is the exact failure mode audited.
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let messages: PersistedMessage[] = [];
  let assistantText = '';
  while (Date.now() < deadline) {
    messages = await invokeBridge<PersistedMessage[]>(
      visual.page,
      'database.get-conversation-messages',
      { conversation_id: conversationId },
      30_000
    );
    assistantText = extractAssistantText(messages);
    if (assistantText.includes(EXPECTED_REPLY)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const rendered = JSON.stringify(messages, null, 2);

  // (a) the user's own message survived the turn
  const userMessage = messages.find((m) => m.msg_id === msgId || m.id === msgId);
  expect(userMessage, `user message "${msgId}" was not persisted. Messages:\n${rendered}`).toBeTruthy();
  expect(JSON.stringify(userMessage?.content)).toContain(USER_PROMPT);

  // (b) the agent's reply was streamed back and persisted
  expect(assistantText, `assistant reply missing. Messages:\n${rendered}`).toContain(EXPECTED_REPLY);

  // (c) the agent really was driven over ACP - assert on the wire, not the source
  const requests = readJsonRpcDump(jsonRpcDumpPath);
  const methods = requests.map((r) => r.method);
  expect(methods, `agent received no JSON-RPC. Dump: ${jsonRpcDumpPath}`).toContain('initialize');
  expect(methods).toContain('session/new');
  expect(methods).toContain('session/prompt');

  const prompt = requests.find((r) => r.method === 'session/prompt');
  expect(
    JSON.stringify(prompt?.params),
    `session/prompt did not carry the user text: ${JSON.stringify(prompt)}`
  ).toContain(USER_PROMPT);
});

test('chat.send.message rejects a malformed call instead of reporting success', async () => {
  // The audit's probe omitted msg_id; the send answered `{ success: true }` and
  // nothing was ever written. A call that cannot produce a turn must say so.
  const conversation = await invokeBridge<{ id?: string }>(
    visual.page,
    'create-conversation',
    {
      type: 'acp',
      name: 'e2e malformed send',
      model: { id: 'mock', name: 'mock', platform: 'custom', useModel: 'mock' },
      extra: { backend: 'custom', customAgentId: 'e2e-mock-agent', cliPath: `node ${mockBinaryPath}`, workspace },
    },
    60_000
  );
  const conversationId = conversation.id as string;

  const noMsgId = await invokeBridge<BridgeResponse<unknown>>(
    visual.page,
    'chat.send.message',
    { conversation_id: conversationId, input: USER_PROMPT },
    30_000
  );
  expect(noMsgId.success, `missing msg_id was accepted: ${JSON.stringify(noMsgId)}`).toBe(false);
  expect(noMsgId.msg).toContain('msg_id');

  const noInput = await invokeBridge<BridgeResponse<unknown>>(
    visual.page,
    'chat.send.message',
    { conversation_id: conversationId, msg_id: 'e2e-no-input' },
    30_000
  );
  expect(noInput.success, `missing input was accepted: ${JSON.stringify(noInput)}`).toBe(false);
  expect(noInput.msg).toContain('input');

  // Nothing may have been written for either rejected call.
  const messages = await invokeBridge<PersistedMessage[]>(
    visual.page,
    'database.get-conversation-messages',
    { conversation_id: conversationId },
    30_000
  );
  expect(messages.length, `rejected sends still persisted: ${JSON.stringify(messages)}`).toBe(0);
});

/** Concatenate every assistant-side text message body, in order. */
function extractAssistantText(messages: PersistedMessage[]): string {
  return messages
    .filter((m) => m.position !== 'right')
    .map((m) => JSON.stringify(m.content ?? ''))
    .join('\n');
}

/** Read the newline-delimited JSON-RPC the mock agent recorded. */
function readJsonRpcDump(dumpPath: string): Array<{ method?: string; params?: unknown }> {
  if (!fs.existsSync(dumpPath)) return [];
  return fs
    .readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: unknown });
}
