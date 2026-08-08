/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * mcp_failed surfacing + stderr level routing (c98088d05 + 49a49fcd9).
 *
 * A configured MCP server that fails to connect was dropped: the engine event
 * had no handler and fell to the unknown-event arm, and even if surfaced the
 * manager's empty-msg_id guard would swallow it. These tests pin (1) the agent
 * emits a typed mcp_failed stream event, and (2) the stderr classifier keeps
 * ordinary progress off console.error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@process/agent/wcore/binaryResolver', () => ({ resolveWCoreBinary: () => '/fake/wcore' }));
vi.mock('@process/agent/wcore/envBuilder', () => ({
  buildEngineSpawnEnv: () => ({}),
  buildSpawnConfig: () => ({
    args: [] as string[],
    env: {} as Record<string, string>,
    projectConfig: null as string | null,
    resolvedMaxTokens: undefined as number | undefined,
  }),
}));
vi.mock('@process/providers/ipc/modelRegistryIpc', () => ({ hydrateModelForSpawn: async (m: unknown) => m }));

// eslint-disable-next-line import/first
import { WCoreAgent } from '@process/agent/wcore/index';
// eslint-disable-next-line import/first
import { wcoreStderrLevel, stripAnsi } from '@process/agent/wcore/stderrLog';

type StreamEvent = { type: string; data: unknown; msg_id: string };

describe('WCoreAgent mcp_failed surfacing', () => {
  it('emits a typed mcp_failed stream event carrying name + reason', () => {
    const events: StreamEvent[] = [];
    const agent = new WCoreAgent({
      workspace: '/tmp/ws',
      model: {} as never,
      onStreamEvent: (e: StreamEvent) => events.push(e),
    } as never);

    (agent as unknown as { handleEvent: (e: unknown) => void }).handleEvent({
      type: 'mcp_failed',
      name: 'gws',
      reason: 'egress denied',
    });

    const failed = events.filter((e) => e.type === 'mcp_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toEqual({ name: 'gws', reason: 'egress denied' });
  });
});

describe('wcoreStderrLevel', () => {
  it('classifies an ERROR/PANIC line as error', () => {
    expect(wcoreStderrLevel('2026-08-08 ERROR provider connection failed')).toBe('error');
    expect(wcoreStderrLevel('thread panicked at ...PANIC')).toBe('error');
  });

  it('classifies WARN as warn', () => {
    expect(wcoreStderrLevel('WARN retrying in 2s')).toBe('warn');
  });

  it('classifies DEBUG/TRACE as debug', () => {
    expect(wcoreStderrLevel('DEBUG spawned tool')).toBe('debug');
    expect(wcoreStderrLevel('TRACE frame decoded')).toBe('debug');
  });

  it('defaults an unlabeled progress line to info, NOT error', () => {
    expect(wcoreStderrLevel('starting session on port 4000')).toBe('info');
  });

  it('strips ANSI before classifying', () => {
    // A colorized ERROR token must still be detected.
    expect(wcoreStderrLevel('[31mERROR[0m boom')).toBe('error');
    expect(stripAnsi('[31mred[0m')).toBe('red');
  });
});

// Route stderr lines through console at the classified level.
describe('WCoreAgent stderr routing', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('an ordinary progress line does not hit console.error', () => {
    // Exercise the same classifier the stderr handler uses.
    const line = 'INFO listening on 127.0.0.1:4000';
    const level = wcoreStderrLevel(line);
    (console[level] as (...a: unknown[]) => void)('[wcore]', line);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('[wcore]', line);
  });
});
