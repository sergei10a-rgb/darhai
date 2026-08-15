/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the Darhai Core entry in `getDetectedAgents()` is allowed to claim.
 *
 * WHY THIS EXISTS. The entry was built `available: true` unconditionally with
 * no `version` field at all, so the function answered "does Darhai SHIP the
 * Core backend" - always yes - while every caller reads it as "can I use this
 * engine".
 *
 * The live surface that got that wrong is the Agents page (`/settings/agents`,
 * renderer/pages/settings/AgentSettings): its Darhai Core card derived a green
 * "Active" badge from PRESENCE in this array, which is unconditionally true.
 * Its badge now reads `available`, pinned by
 * tests/unit/renderer/agentsSettings.dom.test.tsx. The unrouted WCoreSettings
 * page had the same bug, but `/settings/wcore` has redirected to
 * `/settings/wcore-config` for a while, so nothing user-visible came from it.
 *
 * The Settings panes were moved to `wcoreEngine.liveness` in an earlier wave,
 * but the PRODUCER stayed wrong, so the next caller would inherit the same
 * defect. These tests pin the producer instead of the panes.
 *
 * The version tests deliberately drive the REAL contract store through the real
 * `negotiateContract`, because the staleness they guard against is entirely
 * about WHEN the value arrives: a `ready` lands when the user opens a chat,
 * long after the `merge()` that built the snapshot.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/tmp') } }));

/** Controlled per test - this is the fact `available` is supposed to reflect. */
const resolveWCoreBinary = vi.fn<() => string | null>(() => null);
vi.mock('@process/agent/wcore/binaryResolver', () => ({
  resolveWCoreBinary: () => resolveWCoreBinary(),
}));

/**
 * ACP detection is stubbed so these tests do not depend on which CLIs happen to
 * be installed on the machine running them - but `detectBuiltinAgents` still
 * returns a real-shaped entry, because "do not break the ACP agents that share
 * this surface" is one of the things being pinned.
 */
const detectBuiltinAgents = vi.fn(async () => [
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'acp' as const,
    available: true,
    backend: 'claude',
    cliPath: '/bin/claude',
  },
]);
vi.mock('@process/agent/acp/AcpDetector', () => ({
  acpDetector: {
    clearEnvCache: vi.fn(),
    isCliAvailable: vi.fn(() => false),
    detectBuiltinAgents: () => detectBuiltinAgents(),
    detectExtensionAgents: vi.fn(async () => []),
    detectCustomAgents: vi.fn(async () => []),
  },
}));

/** Remote agents come from the DB; an unmocked import would log a load error. */
vi.mock('@process/services/database', () => ({
  // Explicit return type: without it TS cannot infer through the mocked
  // module's own reference cycle and reports TS7023.
  getDatabase: vi.fn(async () => ({ getRemoteAgents: (): never[] => [] })),
}));

import { agentRegistry } from '@process/agent/AgentRegistry';
import { negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import { recordEngineContract, resetEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import type { DetectedAgent } from '@/common/types/detectedAgent';

/** The Core entry as a caller would find it. */
function wcoreEntry(): DetectedAgent<'wcore'> {
  const found = agentRegistry.getDetectedAgents().find((a) => a.backend === 'wcore');
  return found as DetectedAgent<'wcore'>;
}

/**
 * `agentRegistry` is a module singleton with a one-shot `initialize()`, so each
 * test re-runs the full detection pass through the public refresh entry point.
 */
async function detect(): Promise<void> {
  await agentRegistry.refreshAll();
}

describe('AgentRegistry - the Darhai Core entry tells the truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEngineContract();
    resolveWCoreBinary.mockReturnValue(null);
    detectBuiltinAgents.mockResolvedValue([
      {
        id: 'claude',
        name: 'Claude Code',
        kind: 'acp' as const,
        available: true,
        backend: 'claude',
        cliPath: '/bin/claude',
      },
    ]);
  });

  afterEach(() => {
    resetEngineContract();
  });

  // --- available ---

  it('reports available: false when no Core binary resolves', async () => {
    resolveWCoreBinary.mockReturnValue(null);

    await detect();

    // The whole point: the entry is still PRESENT (Darhai ships the backend)
    // but no longer claims it can be used.
    expect(wcoreEntry()).toBeDefined();
    expect(wcoreEntry().available).toBe(false);
  });

  it('reports available: true and the resolved path when a Core binary exists', async () => {
    resolveWCoreBinary.mockReturnValue('/opt/darhai/wayland-core');

    await detect();

    expect(wcoreEntry().available).toBe(true);
    expect(wcoreEntry().cliPath).toBe('/opt/darhai/wayland-core');
  });

  it('carries no cliPath when nothing resolved, rather than an empty string', async () => {
    resolveWCoreBinary.mockReturnValue(null);

    await detect();

    expect(wcoreEntry().cliPath).toBeUndefined();
  });

  it('re-resolves the binary on refresh, so an install stops being invisible', async () => {
    resolveWCoreBinary.mockReturnValue(null);
    await detect();
    expect(wcoreEntry().available).toBe(false);

    // The user installs the engine and Darhai re-scans PATH.
    resolveWCoreBinary.mockReturnValue('/usr/local/bin/wayland-core');
    await agentRegistry.refreshBuiltinAgents();

    expect(wcoreEntry().available).toBe(true);
    expect(wcoreEntry().cliPath).toBe('/usr/local/bin/wayland-core');
  });

  // --- version ---

  it('omits version until an engine has reported one', async () => {
    resolveWCoreBinary.mockReturnValue('/opt/darhai/wayland-core');

    await detect();

    // Absent, not a pinned build constant dressed as a reading.
    expect(wcoreEntry().version).toBeUndefined();
  });

  it("carries the engine's semver once a ready has been recorded", async () => {
    resolveWCoreBinary.mockReturnValue('/opt/darhai/wayland-core');
    recordEngineContract(negotiateContract({ version: '0.12.26', contract: { capabilities: {} } }));

    await detect();

    expect(wcoreEntry().version).toBe('0.12.26');
  });

  it('picks up a ready that lands AFTER the last detection pass', async () => {
    // The real ordering: detection runs at boot, the engine publishes its
    // `ready` when the user opens a chat, and nothing re-merges in between. A
    // version frozen at merge time would stay absent for the whole session.
    resolveWCoreBinary.mockReturnValue('/opt/darhai/wayland-core');
    await detect();
    expect(wcoreEntry().version).toBeUndefined();

    recordEngineContract(negotiateContract({ version: '0.12.26', contract: { capabilities: {} } }));

    expect(wcoreEntry().version).toBe('0.12.26');
  });

  it('treats an empty engineVersion as not reported', async () => {
    resolveWCoreBinary.mockReturnValue('/opt/darhai/wayland-core');
    // A `ready` with no version string still marks the contract as known, so
    // `known` alone is not enough to claim a version.
    recordEngineContract(negotiateContract({ contract: { capabilities: {} } }));

    await detect();

    expect(wcoreEntry().version).toBeUndefined();
  });

  // --- the neighbours ---

  it('leaves ACP agents and their own availability untouched', async () => {
    resolveWCoreBinary.mockReturnValue(null);

    await detect();
    const claude = agentRegistry.getDetectedAgents().find((a) => a.backend === 'claude');

    // ACP `available` comes from a real PATH hit in AcpDetector; an unusable
    // Core entry must not disturb it.
    expect(claude).toBeDefined();
    expect(claude?.available).toBe(true);
    expect(claude?.kind).toBe('acp');
  });

  it('keeps the Core entry present and first regardless of availability', async () => {
    resolveWCoreBinary.mockReturnValue(null);

    await detect();
    const agents = agentRegistry.getDetectedAgents();

    // Several callers ask this list "does Darhai ship backend X". Dropping an
    // unavailable entry would silently change that answer.
    expect(agents[0]?.backend).toBe('wcore');
    expect(agents.some((a) => a.backend === 'gemini')).toBe(true);
  });
});
