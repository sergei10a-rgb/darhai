// tests/unit/process/acp/runtime/IdleReclaimer.test.ts

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { IdleReclaimer } from '@process/acp/runtime/IdleReclaimer';

// AcpRuntime-level mocks (60b8c14 idle-refresh test): capture the callbacks the
// runtime hands to its session so the test can fire stream/status events.
vi.mock('@process/acp/session/AcpSession', () => ({
  // Plain `function` so the mock is constructible (`new AcpSession(...)`);
  // the returned object becomes the instance.
  AcpSession: vi.fn(function () {
    return {
      status: 'active',
      start: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
vi.mock('@process/team/prompts/teamGuideCapability', () => ({
  shouldInjectTeamGuideMcp: vi.fn(async () => false),
}));
vi.mock('@process/team/mcp/guide/teamGuideSingleton', () => ({
  getTeamGuideStdioConfig: vi.fn(() => null),
}));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn(async () => undefined) },
}));

import { AcpRuntime } from '@process/acp/runtime/AcpRuntime';
import { AcpSession } from '@process/acp/session/AcpSession';
import type { SessionCallbacks, SessionEntry } from '@process/acp/types';

describe('IdleReclaimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEntry(status: string, lastActiveAt: number) {
    return {
      session: {
        status,
        suspend: vi.fn().mockResolvedValue(undefined),
      } as any,
      lastActiveAt,
    };
  }

  it('reclaims idle active session (INV-A-02)', () => {
    const sessions = new Map<string, any>();
    sessions.set('c1', makeEntry('active', Date.now() - 60_000));
    const r = new IdleReclaimer(sessions, 30_000, 1_000);
    r.start();
    vi.advanceTimersByTime(1_000);
    expect(sessions.get('c1').session.suspend).toHaveBeenCalledOnce();
    r.stop();
  });

  it('does NOT reclaim prompting session (INV-A-02)', () => {
    const sessions = new Map<string, any>();
    sessions.set('c1', makeEntry('prompting', Date.now() - 60_000));
    const r = new IdleReclaimer(sessions, 30_000, 1_000);
    r.start();
    vi.advanceTimersByTime(1_000);
    expect(sessions.get('c1').session.suspend).not.toHaveBeenCalled();
    r.stop();
  });

  it('does NOT reclaim recently active session', () => {
    const sessions = new Map<string, any>();
    sessions.set('c1', makeEntry('active', Date.now()));
    const r = new IdleReclaimer(sessions, 30_000, 1_000);
    r.start();
    vi.advanceTimersByTime(1_000);
    expect(sessions.get('c1').session.suspend).not.toHaveBeenCalled();
    r.stop();
  });

  // ── 60b8c17d9: a session whose activity keeps refreshing must survive ──
  it('never reclaims while activity keeps refreshing (60b8c17d9)', () => {
    const sessions = new Map<string, any>();
    const entry = makeEntry('active', Date.now());
    sessions.set('c1', entry);
    const r = new IdleReclaimer(sessions, 30_000, 1_000);
    r.start();
    // 10 simulated minutes of a long reply: a stream chunk refreshes the
    // clock every 10 s, always inside the 30 s idle window.
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(10_000);
      entry.lastActiveAt = Date.now();
    }
    expect(entry.session.suspend).not.toHaveBeenCalled();
    r.stop();
  });

  it('reclaims exactly once after the refreshes stop (60b8c17d9)', () => {
    const sessions = new Map<string, any>();
    const entry = makeEntry('active', Date.now());
    sessions.set('c1', entry);
    const r = new IdleReclaimer(sessions, 30_000, 1_000);
    r.start();
    vi.advanceTimersByTime(10_000);
    entry.lastActiveAt = Date.now(); // last chunk
    vi.advanceTimersByTime(31_000); // then silence past the idle window
    expect(entry.session.suspend).toHaveBeenCalledOnce();
    r.stop();
  });
});

describe('AcpRuntime activity refresh (60b8c17d9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (AcpSession as unknown as Mock).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes lastActiveAt on every stream chunk and status flip', async () => {
    const runtime = new AcpRuntime((() => ({})) as never, { idleTimeoutMs: 300_000, checkIntervalMs: 60_000 });
    await runtime.createConversation('c1', { agentBackend: 'claude' } as never);

    const callbacks = (AcpSession as unknown as Mock).mock.calls[0][2] as SessionCallbacks;
    const entry = (runtime as unknown as { sessions: Map<string, SessionEntry> }).sessions.get('c1');
    expect(entry).toBeDefined();

    // A turn longer than the idle timeout: without the callback refresh the
    // prompting→active flip would leave this stale stamp for the reclaimer.
    entry!.lastActiveAt = Date.now() - 600_000;
    callbacks.onMessage({} as never);
    expect(Date.now() - entry!.lastActiveAt).toBeLessThan(1_000);

    entry!.lastActiveAt = Date.now() - 600_000;
    callbacks.onStatusChange('active' as never);
    expect(Date.now() - entry!.lastActiveAt).toBeLessThan(1_000);

    await runtime.shutdown();
  });
});
