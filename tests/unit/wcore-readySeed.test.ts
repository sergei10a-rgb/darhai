/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ready` reaches the two capabilities that cannot claim it.
 *
 * WHY THIS IS EASY TO GET WRONG. The capability dispatcher runs from the
 * decoder's DEFAULT arm, and `ready` has an arm of its own - it is where the
 * contract is read. A handler declaring `handles: ['ready']` therefore
 * registers a type that never routes. Both modules solved that by exposing an
 * explicit `seedFromReady` for the `ready` arm to call, and then nothing called
 * it. The failure is silent in both directions:
 *
 *  - the engine states execution-policy revision 0 ON `ready` and nowhere else,
 *    so the posture badge simply stayed absent;
 *  - turn recovery had no contract for the session, so `canResync` answered
 *    false for every session no matter what the engine supports.
 *
 * These tests drive the real capabilities over the vendored `ready` fixtures,
 * then pin that the decoder actually makes the call.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { executionPolicyCapability } from '@process/agent/wcore/capabilities/handlers/executionPolicy';
import { turnRecoveryCapability } from '@process/agent/wcore/capabilities/handlers/turnRecovery';
import type { CapabilityContext } from '@process/agent/wcore/capabilities';
import { CONTRACT_V1 } from '../helpers/engineContract';

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CONTRACT_V1, relative), 'utf-8')) as Record<string, unknown>;
}

/** Records what a seed sent or said, so absence can be told from silence. */
function recordingContext(): CapabilityContext & { said: string[]; frames: string[] } {
  const said: string[] = [];
  const frames: string[] = [];
  return {
    said,
    frames,
    sendCommand: () => undefined,
    emit: (frame) => {
      frames.push(frame.type);
    },
    activeMsgId: () => '',
    // Both, because the modules choose their own level for an absent receipt -
    // a missing optional field is not a fault, so `log` is as defensible as
    // `warn`, and a test that watched only one would call a stated absence
    // silent.
    log: (message) => {
      said.push(message);
    },
    warn: (message) => {
      said.push(message);
    },
  };
}

describe('execution policy is seeded from ready', () => {
  beforeEach(() => {
    executionPolicyCapability.reset();
  });

  it('adopts the revision the engine states on ready', () => {
    // Before the seed there is nothing to render - which is exactly what the
    // user saw for the whole life of the app.
    expect(executionPolicyCapability.tracker.current).toBeNull();

    const decision = executionPolicyCapability.seedFromReady(readJson('events/ready.json'), recordingContext());

    expect(
      decision,
      'the contract fixture carries an execution_policy; a null seed means it was not read'
    ).not.toBeNull();
    expect(executionPolicyCapability.tracker.current).not.toBeNull();
  });

  /**
   * `ready.minimal.json` ships no `execution_policy` even though the core-event
   * schema marks it required. That is a supported engine, not an error: the
   * tracker must stay uninitialised rather than invent a revision 0 nobody
   * sent.
   */
  it('stays uninitialised - and says so - when ready carries no policy', () => {
    const ctx = recordingContext();
    const decision = executionPolicyCapability.seedFromReady(readJson('compat/events/ready.minimal.json'), ctx);

    expect(decision).toBeNull();
    expect(executionPolicyCapability.tracker.current).toBeNull();
    // "no receipt" and "a receipt this host refused" look identical from
    // outside unless the absence is stated.
    expect(ctx.said.length + ctx.frames.length).toBeGreaterThan(0);
  });

  it('does not let a dead engine.s revisions gate the live one', () => {
    executionPolicyCapability.seedFromReady(readJson('events/ready.json'), recordingContext());
    expect(executionPolicyCapability.tracker.current).not.toBeNull();

    executionPolicyCapability.reset();
    expect(executionPolicyCapability.tracker.current).toBeNull();
  });
});

describe('turn recovery is seeded from ready', () => {
  it('remembers the contract for the session named on ready', () => {
    const ready = readJson('events/ready.json');
    const sessionId = ready.session_id as string;
    expect(typeof sessionId, 'fixture lost its session_id').toBe('string');

    const contract = turnRecoveryCapability.seedFromReady(ready, recordingContext());
    expect(contract, 'a ready with a session_id must seed a contract').not.toBeNull();

    // What the seed unlocks: without it `contractFor` answers NO_CONTRACT,
    // which gates every recovery command shut.
    expect(turnRecoveryCapability.contractFor(sessionId).grades.size).toBeGreaterThan(0);
  });

  it('treats a ready with no session_id as a supported engine, not an error', () => {
    // `compat/events/ready.minimal.json` ships `session_id: null`.
    const contract = turnRecoveryCapability.seedFromReady(
      readJson('compat/events/ready.minimal.json'),
      recordingContext()
    );
    expect(contract).toBeNull();
  });
});

describe('the decoder makes the call', () => {
  const AGENT_SRC = readFileSync(join(process.cwd(), 'src/process/agent/wcore/index.ts'), 'utf-8');

  /**
   * Asserted against the source for the same reason the sibling reset test is:
   * the alternative is booting a real engine child, which `wcore-engineHome`
   * already pays for. What matters is WHERE the call sits - a seed after
   * `readyResolve()` races every caller released by it.
   */
  it('seeds inside the ready arm, before readyResolve releases waiting senders', () => {
    const readyArm = AGENT_SRC.slice(AGENT_SRC.indexOf("case 'ready':"), AGENT_SRC.indexOf("case 'stream_start':"));
    expect(readyArm, 'ready arm not found').not.toBe('');

    const seed = readyArm.indexOf('this.seedCapabilitiesFromReady(');
    const resolve = readyArm.indexOf('this.readyResolve()');
    expect(seed, 'the ready arm does not seed the capabilities').toBeGreaterThan(-1);
    expect(resolve, 'readyResolve not found in the ready arm').toBeGreaterThan(-1);
    expect(seed).toBeLessThan(resolve);
  });

  it('seeds both capabilities, and resets the policy tracker first', () => {
    const body = AGENT_SRC.slice(AGENT_SRC.indexOf('private seedCapabilitiesFromReady('));
    const method = body.slice(0, body.indexOf('\n  /**', 1));

    const reset = method.indexOf('executionPolicyCapability.reset()');
    const policySeed = method.indexOf('executionPolicyCapability.seedFromReady(');
    expect(reset, 'the policy tracker is not reset for a new engine').toBeGreaterThan(-1);
    expect(policySeed).toBeGreaterThan(reset);
    expect(method).toContain('turnRecoveryCapability.seedFromReady(');
  });

  /**
   * A seed that throws must not take the arm down with it: `readyResolve()`
   * releases every caller waiting to send, and never resolving hangs them all.
   * Losing a posture badge is recoverable; that is not.
   */
  it('contains a seed that throws', () => {
    const body = AGENT_SRC.slice(AGENT_SRC.indexOf('private seedCapabilitiesFromReady('));
    const method = body.slice(0, body.indexOf('\n  /**', 1));
    expect((method.match(/try \{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((method.match(/catch \(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
