/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-free ACP conversations for the feature specs.
 *
 * The ACP feature specs drive the live `claude` / `codex` CLIs, so every failure
 * and recovery path in them was left as an empty `test.skip` - there was no way
 * to make a signed-in commercial CLI fail on demand. `createMockAgentBinary`
 * removes that constraint: it produces a real OS process the app spawns through
 * its real spawn path (`spawnGenericBackend` -> `spawn`), whose responses,
 * startup failure and received JSON-RPC we control.
 *
 * This module wraps it into the one thing the specs need: "give me a
 * conversation wired to an agent I control, and let me read what it received."
 * Nothing about the transport, framing or session lifecycle is stubbed.
 */
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeBridge } from './bridge';
import { createMockAgentBinary, type MockBinaryOptions, type MockBinaryResponse } from './mockAgentBinary';

export type BridgeResponse<T = unknown> = { success: boolean; msg?: string; data?: T };

export type PersistedMessage = {
  id: string;
  msg_id?: string;
  type: string;
  position?: string;
  content?: unknown;
};

export type MockAgentConversation = {
  /** Conversation id, ready for `chat.send.message`. */
  id: string;
  /** Temp workspace the agent was given as its cwd. */
  workspace: string;
  /** JSONL file the mock appends every received JSON-RPC request to. */
  dumpPath: string;
};

/** Temp dirs created by this helper, removed by {@link cleanupMockWorkspaces}. */
const workspaces: string[] = [];

export type CreateMockConversationOptions = {
  /** Canned agent replies, applied in order across `session/prompt` calls. */
  responses?: MockBinaryResponse[];
  /** Make the agent binary die before reading stdin - the "backend unavailable" case. */
  failOnStartup?: MockBinaryOptions['failOnStartup'];
  /** Conversation name shown in the sidebar. */
  name?: string;
};

/**
 * Create an `acp` conversation bound to a mock agent binary.
 *
 * The `custom` backend is used deliberately: it is the one backend whose
 * `cliPath` the app takes verbatim, so `node <script>` reaches the production
 * command/args parser and a real `spawn`.
 */
export async function createMockAgentConversation(
  page: Page,
  options: CreateMockConversationOptions = {}
): Promise<MockAgentConversation> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-e2e-mock-'));
  workspaces.push(workspace);
  const dumpPath = path.join(workspace, 'agent-received.jsonl');

  const binary = createMockAgentBinary({
    binary: 'claude',
    responses: options.responses ?? [{ type: 'text', chunks: ['mock reply'] }],
    failOnStartup: options.failOnStartup,
    dumpRequestsTo: dumpPath,
  });

  const conversation = await invokeBridge<{ id?: string }>(
    page,
    'create-conversation',
    {
      type: 'acp',
      name: options.name ?? 'e2e mock agent',
      model: { id: 'mock', name: 'mock', platform: 'custom', useModel: 'mock' },
      extra: {
        backend: 'custom',
        customAgentId: 'e2e-mock-agent',
        cliPath: `node ${binary}`,
        workspace,
        customWorkspace: true,
      },
    },
    60_000
  );

  if (!conversation?.id) {
    throw new Error(`create-conversation returned ${JSON.stringify(conversation)}`);
  }
  return { id: conversation.id, workspace, dumpPath };
}

/** Send one turn through the real send path. */
export async function sendToMockAgent(
  page: Page,
  conversationId: string,
  input: string,
  timeoutMs = 120_000
): Promise<BridgeResponse> {
  return invokeBridge<BridgeResponse>(
    page,
    'chat.send.message',
    { conversation_id: conversationId, msg_id: `e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, input },
    timeoutMs
  );
}

/** Read every message the conversation has persisted. */
export async function readPersistedMessages(page: Page, conversationId: string): Promise<PersistedMessage[]> {
  return invokeBridge<PersistedMessage[]>(
    page,
    'database.get-conversation-messages',
    { conversation_id: conversationId },
    30_000
  );
}

/** Concatenate every assistant-side message body, in order. */
export function assistantText(messages: PersistedMessage[]): string {
  return messages
    .filter((m) => m.position !== 'right')
    .map((m) => JSON.stringify(m.content ?? ''))
    .join('\n');
}

/**
 * Poll until `predicate` holds over the conversation's persisted messages, or
 * the deadline passes. Returns the last read, so a failing assertion can print
 * what was actually there.
 */
export async function waitForMessages(
  page: Page,
  conversationId: string,
  predicate: (messages: PersistedMessage[]) => boolean,
  timeoutMs = 120_000
): Promise<PersistedMessage[]> {
  const deadline = Date.now() + timeoutMs;
  let messages: PersistedMessage[] = [];
  for (;;) {
    messages = await readPersistedMessages(page, conversationId);
    if (predicate(messages)) return messages;
    if (Date.now() >= deadline) return messages;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The JSON-RPC requests the mock agent actually received, in order. */
export function readJsonRpcDump(dumpPath: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  if (!fs.existsSync(dumpPath)) return [];
  return fs
    .readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

/**
 * Wait until the mock agent has recorded a request for `method`.
 * Spawn + handshake is asynchronous, so a bare read races the agent.
 */
export async function waitForJsonRpc(
  dumpPath: string,
  method: string,
  timeoutMs = 120_000
): Promise<Array<{ method?: string; params?: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const requests = readJsonRpcDump(dumpPath);
    if (requests.some((r) => r.method === method)) return requests;
    if (Date.now() >= deadline) return requests;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Remove every temp workspace this helper created. */
export function cleanupMockWorkspaces(): void {
  for (const dir of workspaces.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
