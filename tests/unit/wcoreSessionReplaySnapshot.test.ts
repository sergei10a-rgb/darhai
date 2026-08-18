/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keyless full-session replay gate for the wcore decoder.
 *
 * WHY THIS TIER EXISTS. Every other wcore test drives ONE handler or asserts
 * ONE field. That is the "green unit tests, broken product" gap the
 * deepseek-harness ACP snapshot suite was built to close: a decoder can pass a
 * hundred per-frame assertions and still assemble a broken TRANSCRIPT, because
 * nothing pins the whole emitted stream of a real session end to end.
 *
 * So this gate does what that suite does, in the wcore/ACP shape Darhai ships:
 * it takes a session RECORDED from the real engine (a committed JSONL of
 * `WCoreEvent` frames, captured with no API key — the `observed/` fixtures),
 * REPLAYS it through the real `WCoreAgent` decoder with NO engine process and
 * NO key (the only mocked boundary is the spawn/config the decoder never
 * reaches on this path), NORMALIZES the emitted frames (tokenize per-turn ids,
 * scrub clocks), and byte-compares the result against a committed golden.
 *
 * RECORD vs CHECK are separate, exactly as `test:snapshot:record` (with key,
 * deliberate) and `test:snapshot` (keyless CI gate) are in the reference repo —
 * except that here even RECORD is keyless, because the input frames are already
 * captured. `DARHAI_SNAPSHOT=record` REWRITES every golden from the current
 * decode; the default CHECK mode only compares and never writes, so a drift
 * fails the build instead of silently updating the fixture. A missing golden in
 * CHECK mode is a hard failure with the record command, never an auto-write.
 *
 * The `gate self-check` block is the counter-test the parity standard requires:
 * it corrupts a golden in memory and proves the byte comparison catches it, so
 * an empty or always-true gate cannot pass for green.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The decoder never spawns on the replay path, but importing WCoreAgent still
// pulls these three at module scope; stub them so no real binary/config/registry
// is touched. This is the SAME mock set the single-frame decoder tests use
// (`wcoreBudgetExceededFrame.test.ts`), and the ONLY boundary mocked — the
// decode itself is the real production code.
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
import { resetCapabilityActivation } from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
// eslint-disable-next-line import/first
import { resetEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
// eslint-disable-next-line import/first
import { resetRuntimeRequests } from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
// eslint-disable-next-line import/first
import { resetBudgetGrants } from '@process/agent/wcore/capabilities/handlers/budgetGrants';
// eslint-disable-next-line import/first
import { resetGoalState } from '@process/agent/wcore/capabilities/handlers/durableGoals';
// eslint-disable-next-line import/first
import { REPLAY_SCENARIOS } from '../snapshot/wcoreReplay/scenarios';
// eslint-disable-next-line import/first
import { normalizeReplay, sha256, type StreamEvent } from '../snapshot/wcoreReplay/replayNormalize';

const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/engine-contract/desktop/v1');
const GOLDEN_DIR = join(process.cwd(), 'tests/snapshot/wcoreReplay/golden');
const RECORD = process.env.DARHAI_SNAPSHOT === 'record';

/**
 * Reset every module-singleton capability ledger the decoder writes on `ready`.
 *
 * The production `ready` arm resets exactly this set (see `wcore/index.ts`);
 * mirroring it here is what makes an in-process replay a clean START rather than
 * a continuation of the previous scenario's session. A ledger with no reset
 * door (anvil) is why `stale-replay.jsonl` is excluded — see `scenarios.ts`.
 */
function resetDecoderState(): void {
  resetCapabilityActivation();
  resetEngineContract();
  resetRuntimeRequests();
  resetBudgetGrants();
  resetGoalState();
}

/** Replay a recorded session through the real decoder, keyless, no process. */
function replaySession(fixtureRel: string): StreamEvent[] {
  resetDecoderState();
  const raw = readFileSync(join(FIXTURE_ROOT, fixtureRel), 'utf-8');
  const frames = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const emitted: StreamEvent[] = [];
  const agent = new WCoreAgent({
    workspace: '/tmp/replay-ws',
    model: {} as never,
    onStreamEvent: (e: StreamEvent) => emitted.push(e),
  } as never);

  for (const frame of frames) {
    (agent as unknown as { handleEvent: (e: unknown) => void }).handleEvent(frame);
  }
  return emitted;
}

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}.json`);
}

describe('wcore keyless session-replay snapshot gate', () => {
  for (const scenario of REPLAY_SCENARIOS) {
    it(`${scenario.name} — ${scenario.covers}`, () => {
      const normalized = normalizeReplay(replaySession(scenario.fixture));
      const path = goldenPath(scenario.name);

      if (RECORD) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, normalized, 'utf-8');
        // A record run proves the session decodes into SOMETHING, then writes it.
        expect(normalized.length, 'a recorded session emitted nothing to pin').toBeGreaterThan(0);
        return;
      }

      expect(
        existsSync(path),
        `golden missing for "${scenario.name}". Record it deliberately with:\n` +
          '  DARHAI_SNAPSHOT=record bunx vitest run tests/unit/wcoreSessionReplaySnapshot.test.ts'
      ).toBe(true);

      const golden = readFileSync(path, 'utf-8');
      // Byte-level: sha256 of the normalized transcript. A whitespace or key-order
      // drift fails here, which is the point — the transcript is the contract.
      expect(sha256(normalized), `replay of ${scenario.fixture} drifted from golden ${scenario.name}.json`).toBe(
        sha256(golden)
      );
      // Show the actual diff, not just the hash, when it fails.
      expect(normalized).toBe(golden);
    });
  }
});

/**
 * The gate's own health check. The parity standard requires a counter-test that
 * deliberately breaks the golden and proves the gate catches it — otherwise an
 * empty or always-green gate passes for a working one.
 */
describe('wcore session-replay gate self-check', () => {
  it('a decoder that dropped a frame would fail the byte comparison', () => {
    const scenario = REPLAY_SCENARIOS[0];
    const frames = replaySession(scenario.fixture);
    const good = normalizeReplay(frames);

    // Simulate a real regression: the decoder emits one fewer frame.
    const broken = normalizeReplay(frames.slice(0, -1));

    expect(broken).not.toBe(good);
    expect(sha256(broken)).not.toBe(sha256(good));
  });

  it('a corrupted golden byte is caught by sha256', () => {
    const scenario = REPLAY_SCENARIOS[0];
    const good = normalizeReplay(replaySession(scenario.fixture));

    // Flip one character anywhere in the transcript.
    const corrupted = good.replace(/probe|info|error|start|finish|capability/, (m) => m.toUpperCase());
    expect(corrupted, 'corpus changed — pick another token to flip').not.toBe(good);
    expect(sha256(corrupted)).not.toBe(sha256(good));
  });

  it('normalization is idempotent — replaying twice pins the same bytes', () => {
    // The determinism the byte gate depends on: two isolated replays of the same
    // recorded session must normalize to identical bytes.
    for (const scenario of REPLAY_SCENARIOS) {
      const a = normalizeReplay(replaySession(scenario.fixture));
      const b = normalizeReplay(replaySession(scenario.fixture));
      expect(a, `${scenario.name} is not deterministic across replays`).toBe(b);
    }
  });
});
