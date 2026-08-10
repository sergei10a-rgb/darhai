/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract negotiation is the gate three other capabilities stand on.
 *
 * Darhai pins one engine tag, but `binaryResolver` will happily use a
 * `wayland-core` found on PATH and the engine can self-update, so the binary in
 * front of us is not necessarily the one we vendored a contract for. Sending a
 * gated command to a build that graded the capability `shape_only` buys a turn
 * that waits for a reply which never comes.
 *
 * The payloads here are the contract's own `ready` example, so what these tests
 * prove is true of a real engine and not of a hand-written stand-in.
 */

import { describe, expect, it } from 'vitest';

import {
  NO_CONTRACT,
  canRecoverSessions,
  gradeOf,
  gradedCapabilities,
  isCapabilityAvailable,
  negotiateContract,
} from '@process/agent/wcore/capabilities/contractNegotiation';
import { examplePayload } from '../helpers/engineContract';

const readyExample = (): Record<string, unknown> => examplePayload('event', 'ready');

describe('negotiating a real ready payload', () => {
  it('reads the engine version and contract revision', () => {
    const c = negotiateContract(readyExample());
    expect(c.engineVersion).toBeTruthy();
    expect(typeof c.contractMajor).toBe('number');
    expect(typeof c.contractMinor).toBe('number');
  });

  it('captures every capability the engine graded', () => {
    const graded = gradedCapabilities(negotiateContract(readyExample()));
    // The v0.12.26 contract grades 17 capabilities; the exact members matter
    // more than the count, so assert the ones other code gates on.
    expect(graded).toContain('turn_recovery_v1');
    expect(graded).toContain('durable_goals_v1');
    expect(graded).toContain('runtime_diagnostics_v1');
    expect(graded).toContain('anvil_receipts');
  });

  it('preserves each grade verbatim rather than flattening to a boolean', () => {
    const c = negotiateContract(readyExample());
    expect(gradeOf(c, 'turn_recovery_v1')).toBe('available');
    expect(gradeOf(c, 'anvil_receipts')).toBe('publication_bound');
    expect(gradeOf(c, 'browser_events')).toBe('shape_only');
  });

  it('reports a capability the engine never mentioned as unavailable', () => {
    expect(gradeOf(negotiateContract(readyExample()), 'no_such_capability')).toBe('unavailable');
  });
});

describe('availability', () => {
  const withGrades = (grades: Record<string, string>) =>
    negotiateContract({ version: '0.12.26', contract: { capabilities: grades } });

  it('only "available" counts as usable', () => {
    const c = withGrades({ a: 'available' });
    expect(isCapabilityAvailable(c, 'a')).toBe(true);
  });

  /**
   * The distinction that matters: `publication_bound` means the SHAPE is final
   * but emission depends on engine configuration. A host that treats it as
   * usable waits for events that are never published.
   */
  it('publication_bound is NOT usable', () => {
    expect(isCapabilityAvailable(withGrades({ a: 'publication_bound' }), 'a')).toBe(false);
  });

  it('shape_only and unavailable are not usable', () => {
    expect(isCapabilityAvailable(withGrades({ a: 'shape_only' }), 'a')).toBe(false);
    expect(isCapabilityAvailable(withGrades({ a: 'unavailable' }), 'a')).toBe(false);
  });

  it('an ungraded capability is not usable', () => {
    expect(isCapabilityAvailable(withGrades({}), 'a')).toBe(false);
  });

  it('a grade this host has never heard of is not usable', () => {
    expect(isCapabilityAvailable(withGrades({ a: 'some_future_grade' }), 'a')).toBe(false);
  });
});

describe('recovery needs BOTH the capability and a durable journal', () => {
  const make = (grade: string, persistence?: string) =>
    negotiateContract({
      version: '0.12.26',
      contract: { capabilities: { turn_recovery_v1: grade } },
      ...(persistence ? { session_persistence: persistence } : {}),
    });

  it('allows recovery when the capability is available and persistence is durable', () => {
    expect(canRecoverSessions(make('available', 'durable'))).toBe(true);
  });

  /**
   * Without a journal there is nothing to resync against, and the engine would
   * answer `session_recovery_unavailable` every time. Checking both here keeps
   * that reasoning out of each caller.
   */
  it('refuses when the journal is not durable, even if the capability is available', () => {
    expect(canRecoverSessions(make('available', 'journaled_without_replay'))).toBe(false);
    expect(canRecoverSessions(make('available', 'disabled_by_operator'))).toBe(false);
    expect(canRecoverSessions(make('available', 'disabled_by_host'))).toBe(false);
  });

  it('refuses when persistence was not reported at all', () => {
    expect(canRecoverSessions(make('available'))).toBe(false);
  });

  it('refuses when the capability is not available, even with a durable journal', () => {
    expect(canRecoverSessions(make('shape_only', 'durable'))).toBe(false);
  });
});

/**
 * Degradation, not rejection. A host that hard-fails on an imperfect `ready`
 * cannot start against an older or newer engine at all - and the safe direction
 * for a missing contract is "use nothing", which every gate above already
 * treats as a refusal.
 */
describe('a malformed or older ready degrades safely', () => {
  it('an empty payload yields a contract that permits nothing', () => {
    const c = negotiateContract({});
    expect(c.engineVersion).toBe('');
    expect(gradedCapabilities(c)).toEqual([]);
    expect(isCapabilityAvailable(c, 'turn_recovery_v1')).toBe(false);
    expect(canRecoverSessions(c)).toBe(false);
  });

  it('tolerates a contract block with no capabilities', () => {
    const c = negotiateContract({ version: '0.9.0', contract: {} });
    expect(c.engineVersion).toBe('0.9.0');
    expect(gradedCapabilities(c)).toEqual([]);
  });

  it('ignores non-string grades instead of throwing', () => {
    const c = negotiateContract({
      version: '1',
      contract: { capabilities: { good: 'available', bad: 42, worse: null } as unknown as Record<string, string> },
    });
    expect(gradedCapabilities(c)).toEqual(['good']);
  });

  it('tolerates a non-object contract', () => {
    expect(() => negotiateContract({ version: '1', contract: 'nonsense' })).not.toThrow();
    expect(gradedCapabilities(negotiateContract({ version: '1', contract: 'nonsense' }))).toEqual([]);
  });

  it('NO_CONTRACT permits nothing', () => {
    expect(isCapabilityAvailable(NO_CONTRACT, 'anything')).toBe(false);
    expect(canRecoverSessions(NO_CONTRACT)).toBe(false);
  });
});
