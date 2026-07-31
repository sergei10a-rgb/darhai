/**
 * MCP - stdio mock server round-trip.
 *
 * Validates the W4 L35 bump to @modelcontextprotocol/sdk@^1.29.0 by spinning
 * up a tiny dependency-free stdio MCP server (tests/e2e/helpers/mocks/mockMcpServer.ts)
 * and asking the Wayland bridge to (a) test the connection, (b) enumerate
 * tools, and (c) round-trip an `echo` call. If the SDK shape changed under
 * us, this spec catches it before the agent surface notices.
 *
 * We do NOT depend on a published MCP server. Mocks are local and offline.
 */
import path from 'path';
import fs from 'fs';
import { test, expect } from '../fixtures';
import { invokeBridge } from '../helpers';

type Tool = { name: string; description?: string };
type TestEnvelope =
  | { success: true; data: { success: boolean; tools?: Tool[]; error?: string } }
  | { success: false; msg: string };

const mockServerPath = path.resolve(__dirname, '../helpers/mocks/mockMcpServer.ts');

test.describe('MCP stdio bridge', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(mockServerPath)) {
      throw new Error(`mock MCP server missing: ${mockServerPath}`);
    }
  });

  // ── Connection test ───────────────────────────────────────────────────────
  // The bridge's `mcp.test-connection` does the full initialize + tools/list
  // dance against the configured transport. If the SDK is wired correctly,
  // the response data should carry our mock's single tool.
  test('mcp.test-connection against a local stdio server reports tools/list', async ({ page }) => {
    // Spawned with `node`, not `bunx --bun`: the Electron child env does not
    // reliably have bun on PATH, and the previous `bunx` command silently
    // produced "MCP error -32000: Connection closed" while the spec still
    // passed - every tools assertion sat inside an `if (resp.data.success)`.
    // Node 24 strips the mock's TypeScript annotations natively.
    const server = {
      id: 'e2e-mock-mcp',
      name: 'e2e-mock-mcp',
      description: 'inline mock for L35 SDK 1.29 verification',
      enabled: true,
      transport: {
        type: 'stdio' as const,
        command: 'node',
        args: [mockServerPath],
        env: {},
      },
      status: 'disconnected' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      originalJson: '{}',
    };

    const resp = await invokeBridge<TestEnvelope>(page, 'mcp.test-connection', server, 20_000);
    expect(resp, 'envelope returned').toBeDefined();

    // Unconditional from here down. Every assertion below used to be nested
    // inside a success branch, so the spec reported green while the mock never
    // connected at all - exactly the failure mode it exists to detect.
    expect(resp.success, `mcp.test-connection rejected: ${'msg' in resp ? resp.msg : ''}`).toBe(true);
    if (!resp.success) return; // narrowing only; the assertion above already failed

    expect(resp.data.success, `MCP handshake failed: ${resp.data.error ?? '(no error reported)'}`).toBe(true);
    expect(Array.isArray(resp.data.tools), 'tools is an array').toBe(true);
    const names = (resp.data.tools ?? []).map((t) => t.name);
    // Our mock advertises exactly one tool named `echo`.
    expect(names, 'mock advertises the echo tool').toContain('echo');
  });

  // ── Authenticated-servers list returns the documented envelope ────────────
  // mcp.get-authenticated-servers is the bridge UI consults to decide whether
  // an OAuth-protected MCP needs a re-auth. The shape must be a string[]
  // envelope even when empty.
  test('mcp.get-authenticated-servers returns a string[] envelope', async ({ page }) => {
    type Envelope = { success: true; data: string[] } | { success: false; msg: string };
    const resp = await invokeBridge<Envelope>(page, 'mcp.get-authenticated-servers', undefined, 5_000);
    expect(resp, 'envelope returned').toBeDefined();
    expect(typeof resp.success, 'success is boolean').toBe('boolean');
    if (resp.success) {
      expect(Array.isArray(resp.data), 'data is an array').toBe(true);
      for (const id of resp.data) {
        expect(typeof id, 'each id is a string').toBe('string');
      }
    } else {
      expect(typeof resp.msg, 'failure carries msg').toBe('string');
    }
  });

  // ── Tool round-trip via the agent layer requires an agent CLI ─────────────
  test.skip('tools/call round-trip via syncMcpToAgents requires a real backend agent CLI on PATH - skip in headless CI', () => {});
});
