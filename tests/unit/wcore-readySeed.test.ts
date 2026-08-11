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
import { describe, expect, it } from 'vitest';

import { createCapabilitySet } from '@process/agent/wcore/capabilities';
import type { ExecutionPolicyCapability } from '@process/agent/wcore/capabilities/handlers/executionPolicy';
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

/**
 * One agent's execution-policy capability, built the way the agent builds it.
 *
 * Through `createCapabilitySet()` rather than the factory directly: what these
 * tests are about is the instance a running agent actually seeds, so if the set
 * ever stopped carrying one they must fail rather than quietly exercise a
 * private copy.
 */
function policyOfFreshAgent(): ExecutionPolicyCapability {
  return createCapabilitySet().executionPolicy;
}

/** The revision the vendored `ready` states, as the receipt it states it with. */
function readyReceipt(): Record<string, unknown> {
  return readJson('events/ready.json').execution_policy as Record<string, unknown>;
}

/** The same receipt at a later revision - what a `mode_change` looks like. */
function receiptAtRevision(revision: number): Record<string, unknown> {
  return { ...readyReceipt(), revision, reason: 'mode_change' };
}

describe('execution policy is seeded from ready', () => {
  it('adopts the revision the engine states on ready', () => {
    const policy = policyOfFreshAgent();
    // Before the seed there is nothing to render - which is exactly what the
    // user saw for the whole life of the app.
    expect(policy.tracker.current).toBeNull();

    const decision = policy.seedFromReady(readJson('events/ready.json'), recordingContext());

    expect(
      decision,
      'the contract fixture carries an execution_policy; a null seed means it was not read'
    ).not.toBeNull();
    expect(policy.tracker.current).not.toBeNull();
  });

  /**
   * `ready.minimal.json` ships no `execution_policy` even though the core-event
   * schema marks it required. That is a supported engine, not an error: the
   * tracker must stay uninitialised rather than invent a revision 0 nobody
   * sent.
   */
  it('stays uninitialised - and says so - when ready carries no policy', () => {
    const policy = policyOfFreshAgent();
    const ctx = recordingContext();
    const decision = policy.seedFromReady(readJson('compat/events/ready.minimal.json'), ctx);

    expect(decision).toBeNull();
    expect(policy.tracker.current).toBeNull();
    // "no receipt" and "a receipt this host refused" look identical from
    // outside unless the absence is stated.
    expect(ctx.said.length + ctx.frames.length).toBeGreaterThan(0);
  });

  it('does not let a dead engine.s revisions gate the live one', () => {
    const policy = policyOfFreshAgent();
    policy.seedFromReady(readJson('events/ready.json'), recordingContext());
    expect(policy.tracker.current).not.toBeNull();

    policy.reset();
    expect(policy.tracker.current).toBeNull();
  });
});

/**
 * That reset is only safe because the capability belongs to ONE agent.
 *
 * Darhai keeps an engine per open conversation (`WorkerTaskManager.taskList`
 * holds one `WCoreManager`, hence one `WCoreAgent`, per conversation), and a
 * `ready` resets the policy tracker because a `ready` means a new engine
 * process. Against a process-wide instance that reset rewound whatever the
 * OTHER conversation's engine had already published - and a rewound tracker
 * refuses that conversation's next legal receipt as a forward gap, which by
 * this tracker's own rule it can never recover from for the life of the
 * session. The user saw a foreign posture, permanently orange, warning about an
 * update that had in fact arrived.
 *
 * The previous test for this called `reset()` on a single instance and asserted
 * `current` was null - true of a shared instance too, which is why it passed
 * while the defect was live. These drive TWO sets, the way two open
 * conversations do.
 */
describe('two live conversations do not share a policy tracker', () => {
  it('gives every agent its own capability instance', () => {
    const a = createCapabilitySet();
    const b = createCapabilitySet();
    expect(a.executionPolicy).not.toBe(b.executionPolicy);
    expect(a.executionPolicy.tracker).not.toBe(b.executionPolicy.tracker);
    // The dispatcher has to be bound to the per-set handler list as well, or
    // the isolation above is undone the moment an event is routed.
    expect(a.dispatch).not.toBe(b.dispatch);
    expect(a.handlers).toContain(a.executionPolicy);
    expect(b.handlers).toContain(b.executionPolicy);
  });

  it('a second conversation starting does not strand the policy of the first', () => {
    const ctx = recordingContext();
    const a = createCapabilitySet();
    const b = createCapabilitySet();

    // Conversation A comes up and advances two revisions, exactly as a mode
    // change would: seed 0, then 1, then 2.
    a.executionPolicy.seedFromReady(readJson('events/ready.json'), ctx);
    for (const revision of [1, 2]) {
      expect(a.dispatch({ type: 'execution_policy', ...receiptAtRevision(revision) }, ctx)).toBe(true);
    }
    expect(a.executionPolicy.tracker.revision).toBe(2);
    expect(a.executionPolicy.tracker.stale).toBe(false);

    // Conversation B's engine reports ready. Its agent resets ITS tracker and
    // seeds revision 0 - the shared-singleton version of this rewound A.
    b.executionPolicy.reset();
    b.executionPolicy.seedFromReady(readJson('events/ready.json'), ctx);
    expect(b.executionPolicy.tracker.revision).toBe(0);

    // A's next legal revision must still be adopted. On the shared instance the
    // held revision was 0 by now, so revision 3 read as a gap of two and was
    // refused - permanently.
    expect(a.dispatch({ type: 'execution_policy', ...receiptAtRevision(3) }, ctx)).toBe(true);
    expect(
      a.executionPolicy.tracker.revision,
      'conversation A refused its own next revision - a second conversation ready rewound its tracker'
    ).toBe(3);
    expect(a.executionPolicy.tracker.stale, 'A is warning about a gap that never happened').toBe(false);
    // ...and B is untouched by A's traffic, which is the same property read the
    // other way round.
    expect(b.executionPolicy.tracker.revision).toBe(0);
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

    const reset = method.indexOf('this.capabilitySet.executionPolicy.reset()');
    const policySeed = method.indexOf('this.capabilitySet.executionPolicy.seedFromReady(');
    expect(reset, 'the policy tracker is not reset for a new engine').toBeGreaterThan(-1);
    expect(policySeed).toBeGreaterThan(reset);
    expect(method).toContain('turnRecoveryCapability.seedFromReady(');
  });

  /**
   * The seed and the dispatch have to land on the SAME per-agent instance.
   *
   * Asserted against the source because the alternative is booting an engine
   * child, and what is at issue is one identifier: an agent that reaches for
   * the registry's shared dispatcher puts every conversation's revisions back
   * into one tracker, which is the defect the two-set tests above describe.
   */
  it('routes and seeds through the capability set the agent owns', () => {
    expect(AGENT_SRC, 'the agent does not build a capability set of its own').toContain('createCapabilitySet()');
    expect(AGENT_SRC, 'the decoder does not dispatch through the agent set').toContain('this.capabilitySet.dispatch(');
    expect(
      AGENT_SRC.includes('dispatchCapabilityEvent'),
      'the agent is back on the registry-wide dispatcher, which every conversation shares'
    ).toBe(false);
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
