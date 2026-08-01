/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real MCP stdio client, for specs that need to prove a server the app
 * ADVERTISES can actually be spawned, connected to, and called.
 *
 * `tools/list` alone is not proof: the `darhai-search-skills` regression that
 * started this work had a server that listed its tool and then died on spawn.
 * The only assertion that closes that gap is calling the tool and reading the
 * bytes it returns, from the same command / args / env the app put in
 * `session/new` - which is exactly what {@link callMcpTool} does.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type McpToolDescriptor = { name: string; description?: string };

export type McpSpawnSpec = {
  command: string;
  args: string[];
  /** Extra env for the child, on top of the current process env. */
  env?: Record<string, string>;
};

export type McpSession = {
  serverName: string;
  tools: McpToolDescriptor[];
  /** Call a tool and return the concatenated text content of the result. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
};

type JsonRpcMessage = {
  id?: number;
  result?: {
    serverInfo?: { name?: string };
    tools?: McpToolDescriptor[];
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

/**
 * Spawn an MCP stdio server, complete the `initialize` handshake and read its
 * tool list. The returned session stays live until {@link McpSession.close}.
 */
export async function connectMcpStdio(spec: McpSpawnSpec, timeoutMs = 30_000): Promise<McpSession> {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command === 'node' ? process.execPath : spec.command, spec.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...spec.env },
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });

  let nextId = 100;
  const pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  let exited: string | null = null;

  child.on('exit', (code) => {
    exited = `exited with code ${code}. stderr: ${stderr}`;
    for (const [, p] of pending) p.reject(new Error(exited));
    pending.clear();
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    let nl = stdout.indexOf('\n');
    while (nl >= 0) {
      const line = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      nl = stdout.indexOf('\n');
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      waiter.resolve(msg);
    }
  });

  const request = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    if (exited) return Promise.reject(new Error(exited));
    const id = nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms. stderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'darhai-e2e-mcp-client', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await request('tools/list', {});

  return {
    serverName: init.result?.serverInfo?.name ?? '',
    tools: listed.result?.tools ?? [],
    async call(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) throw new Error(`${name} failed: ${response.error.message}`);
      const content = response.result?.content ?? [];
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
      if (response.result?.isError) throw new Error(`${name} returned isError: ${text}`);
      return text;
    },
    close() {
      child.kill();
    },
  };
}

/** Convenience: connect, call one tool, tear down. */
export async function callMcpTool(
  spec: McpSpawnSpec,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const session = await connectMcpStdio(spec);
  try {
    return await session.call(name, args);
  } finally {
    session.close();
  }
}
