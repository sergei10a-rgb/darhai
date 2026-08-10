/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine-introspection snapshot the UI reads on mount.
 *
 * WHY THIS SEAM EXISTS. `capability_activation` frames are emitted once per
 * engine process START. A Settings pane is unmounted at that moment - the user
 * is in a chat, which is what started the engine - so a pane built only on the
 * live stream shows an empty table forever. Both surfaces that need this
 * shipped that way, and nothing caught it, because a DOM test can push a frame
 * into an already-mounted component and mount order never enters the picture.
 *
 * These tests pin the pull-based answer instead, and pin the one fact that
 * makes the two id fields non-interchangeable: the engine's INTERNAL capability
 * names and the CONTRACT's capability ids are disjoint sets. A renderer that
 * filters one for a name from the other matches nothing, forever - which is
 * exactly the defect this snapshot replaces.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildWcoreCapabilitySnapshot } from '@process/bridge/wcoreEngineBridge';
import { negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import { recordEngineContract, resetEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import {
  capabilityActivationCapability,
  resetCapabilityActivation,
} from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import type { CapabilityContext } from '@process/agent/wcore/capabilities';
import { CONTRACT_V1, readManifest } from '../helpers/engineContract';

/** A context that records nothing - these tests read the RECORD, not the frames. */
function silentContext(): CapabilityContext {
  return {
    sendCommand: () => undefined,
    emit: () => undefined,
    activeMsgId: () => '',
    log: () => undefined,
    warn: () => undefined,
  };
}

/**
 * Drive the real handler over a real captured session.
 *
 * Deliberately not hand-shaped: the whole point of the finding this file
 * closes is that a hand-written `{capability:'durable_goals_v1'}` frame proved
 * a code path that no engine can ever produce.
 */
function replayObserved(file: string): number {
  const path = join(CONTRACT_V1, 'observed', file);
  const lines = readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const ctx = silentContext();
  let handled = 0;
  for (const line of lines) {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (capabilityActivationCapability.handle(frame, ctx)) handled += 1;
  }
  return handled;
}

/** A `ready` payload carrying the contract, as the engine sends it. */
function readyWithContract(): Record<string, unknown> {
  const manifest = readManifest();
  const capabilities: Record<string, string> = {};
  for (const [id, availability] of Object.entries(manifest.capabilities)) {
    capabilities[id] = availability;
  }
  return { version: '0.12.26', contract: { capabilities } };
}

describe('wcoreEngine.capabilitySnapshot', () => {
  beforeEach(() => {
    resetEngineContract();
    resetCapabilityActivation();
  });

  afterEach(() => {
    resetEngineContract();
    resetCapabilityActivation();
  });

  it('reports contractKnown:false before any engine has spoken', () => {
    const snapshot = buildWcoreCapabilitySnapshot();
    expect(snapshot.contractKnown).toBe(false);
    expect(snapshot.grades).toEqual({});
    expect(snapshot.activation).toEqual([]);
    expect(snapshot.engineVersion).toBe('');
  });

  /**
   * The distinction the readouts get wrong. An empty grade map means "nothing
   * is available" to a GATE and "we have not asked yet" to a READOUT; a surface
   * that cannot tell them apart calls a healthy capability broken before the
   * first chat is opened.
   */
  it('distinguishes "engine said nothing is available" from "no engine yet"', () => {
    expect(buildWcoreCapabilitySnapshot().contractKnown).toBe(false);

    recordEngineContract(negotiateContract({ version: '0.12.26', contract: { capabilities: {} } }));

    const after = buildWcoreCapabilitySnapshot();
    expect(after.contractKnown).toBe(true);
    expect(after.grades).toEqual({});
  });

  it('hands over the engine grade for every contract capability', () => {
    recordEngineContract(negotiateContract(readyWithContract()));
    const snapshot = buildWcoreCapabilitySnapshot();

    const manifest = readManifest();
    const graded = Object.entries(manifest.capabilities);
    expect(graded.length, 'the manifest grades no capabilities').toBeGreaterThan(0);
    for (const [id, availability] of graded) {
      expect(snapshot.grades[id], `grade missing for ${id}`).toBe(availability);
    }
    expect(snapshot.engineVersion).toBe('0.12.26');
  });

  it('retains the readiness record from a replayed engine start', () => {
    const handled = replayObserved('capability_activation.default.jsonl');
    expect(handled, 'no observed frame was handled - the capture or the handler changed').toBeGreaterThan(0);

    const snapshot = buildWcoreCapabilitySnapshot();
    expect(snapshot.activation.length).toBeGreaterThan(0);
    for (const row of snapshot.activation) {
      expect(typeof row.capability).toBe('string');
      expect(row.capability.length).toBeGreaterThan(0);
      // `reason` is `null` when the engine stated none. `undefined` would mean
      // the bridge dropped the field, which reads as "not applicable" instead
      // of "not stated".
      expect(row.reason === null || typeof row.reason === 'string').toBe(true);
    }
  });

  /**
   * THE MEASUREMENT. Two independent id namespaces, and nothing in the type
   * system says so. This is the check that would have stopped a renderer from
   * waiting on a `capability_activation` frame named `durable_goals_v1`.
   */
  it('engine-internal capability ids and contract capability ids are disjoint', () => {
    replayObserved('capability_activation.default.jsonl');
    replayObserved('capability_activation.smart-enabled.jsonl');
    recordEngineContract(negotiateContract(readyWithContract()));

    const snapshot = buildWcoreCapabilitySnapshot();
    const announced = new Set(snapshot.activation.map((r) => r.capability));
    const graded = new Set(Object.keys(snapshot.grades));

    expect(announced.size, 'no capability ids were announced').toBeGreaterThan(0);
    expect(graded.size, 'no capability ids were graded').toBeGreaterThan(0);

    const overlap = [...announced].filter((id) => graded.has(id));
    expect(
      overlap,
      'the two namespaces now intersect - a readout may finally filter one by the other, ' +
        'and the availability sources should be reconsidered together'
    ).toEqual([]);
  });

  it('does not hand the renderer the live main-process record', () => {
    replayObserved('capability_activation.default.jsonl');
    const first = buildWcoreCapabilitySnapshot();
    const before = first.activation.length;
    first.activation.length = 0;

    expect(buildWcoreCapabilitySnapshot().activation).toHaveLength(before);
  });
});

describe('a new engine resets the readiness record', () => {
  const AGENT_SRC = readFileSync(join(process.cwd(), 'src/process/agent/wcore/index.ts'), 'utf-8');

  /**
   * Asserted against the source because the alternative - booting a real engine
   * child twice - is what `wcore-engineHome.test.ts` already pays for, and this
   * is one call in one arm. What matters is that the call is INSIDE the `ready`
   * arm: anywhere else and a respawn keeps the dead process's outcomes.
   */
  it('calls resetCapabilityActivation from the ready arm', () => {
    const readyArm = AGENT_SRC.slice(AGENT_SRC.indexOf("case 'ready':"), AGENT_SRC.indexOf("case 'stream_start':"));
    expect(readyArm, 'ready arm not found').not.toBe('');
    expect(readyArm).toContain('resetCapabilityActivation()');
    expect(readyArm).toContain('recordEngineContract(');
  });

  it('drops the record so a respawn does not inherit a dead engine.s rows', () => {
    resetEngineContract();
    resetCapabilityActivation();
    replayObserved('capability_activation.default.jsonl');
    expect(buildWcoreCapabilitySnapshot().activation.length).toBeGreaterThan(0);

    resetCapabilityActivation();
    expect(buildWcoreCapabilitySnapshot().activation).toEqual([]);
  });
});
