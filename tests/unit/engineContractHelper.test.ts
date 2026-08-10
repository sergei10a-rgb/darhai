/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The contract helper is load-bearing for every capability suite that follows,
 * so it gets its own tests first. A helper that silently returns `[]` for a
 * fixture directory, or a validator that accepts everything, would make every
 * downstream suite green and meaningless.
 */

import { describe, expect, it } from 'vitest';

import {
  adversarialFixtures,
  compatFixtures,
  entryFor,
  examplePayload,
  messagesOfType,
  readFixture,
  readManifest,
  surfaceOf,
  validateCommand,
  validateEvent,
} from '../helpers/engineContract';

describe('engine contract helper', () => {
  it('reads the manifest with its declared shape', () => {
    const m = readManifest();
    expect(m.contract.name).toBeTruthy();
    expect(m.events.length).toBe(m.counts.events);
    expect(m.commands.length).toBe(m.counts.commands);
  });

  it('finds a known entry and its criticality grading', () => {
    const ready = entryFor('event', 'ready');
    expect(ready?.criticality).toBe('required');
    const message = entryFor('command', 'message');
    expect(message?.criticality).toBe('safety');
  });

  it('returns undefined for a type the contract does not define', () => {
    expect(entryFor('event', 'no_such_event_xyz')).toBeUndefined();
  });

  it('loads an example payload that matches its own type', () => {
    const payload = examplePayload('event', 'execution_policy');
    expect(payload.type).toBe('execution_policy');
    expect(payload.critical).toBe(true);
  });

  describe('fixtures', () => {
    it('lists the adversarial subsystems that exist', () => {
      // Counts measured from the v0.12.26 bundle; a shrinking directory means
      // an incomplete checkout, which would silently weaken every suite.
      expect(adversarialFixtures('recovery').length).toBe(5);
      expect(adversarialFixtures('anvil').length).toBe(11);
      expect(adversarialFixtures('policy').length).toBe(6);
      expect(adversarialFixtures('workflow').length).toBe(8);
    });

    it('returns an empty list for a subsystem that does not exist, without throwing', () => {
      expect(adversarialFixtures('no-such-subsystem')).toEqual([]);
    });

    it('lists compat fixtures for both directions', () => {
      expect(compatFixtures('commands').length).toBeGreaterThan(0);
      expect(compatFixtures('events').length).toBeGreaterThan(0);
    });

    it('reads a fixture as an ordered, hole-free message list', () => {
      const messages = readFixture('adversarial/recovery/valid-replay.jsonl');
      expect(messages.length).toBe(2);
      for (const m of messages) expect(typeof m).toBe('object');
    });

    it('filters a fixture by message type', () => {
      const path = 'adversarial/policy/valid-revisions.jsonl';
      const all = readFixture(path);
      const policies = messagesOfType(path, 'execution_policy');
      expect(policies.length).toBeGreaterThan(0);
      expect(policies.length).toBeLessThanOrEqual(all.length);
      for (const p of policies) expect(p.type).toBe('execution_policy');
    });
  });

  describe('schema validation', () => {
    it('accepts the contract’s own example events', () => {
      for (const type of ['ready', 'stream_start', 'execution_policy']) {
        const result = validateEvent(examplePayload('event', type));
        expect(result.errors, `${type}: ${result.errors.join('; ')}`).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });

    it('accepts the contract’s own example commands', () => {
      for (const type of ['message', 'tool_approve', 'session_resync']) {
        const result = validateCommand(examplePayload('command', type));
        expect(result.errors, `${type}: ${result.errors.join('; ')}`).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });

    /**
     * The counter-check: a validator that accepts anything would make every
     * schema assertion in every capability suite worthless.
     */
    it('rejects a payload that is not an engine message at all', () => {
      expect(validateEvent({ nonsense: true }).valid).toBe(false);
      expect(validateCommand({ nonsense: true }).valid).toBe(false);
    });

    it('rejects an event whose required field is missing', () => {
      const ready = examplePayload('event', 'ready') as Record<string, unknown>;
      delete ready.version;
      expect(validateEvent(ready).valid).toBe(false);
    });
  });

  it('groups a capability’s whole surface, both directions', () => {
    const recovery = surfaceOf('turn_recovery_v1');
    const names = [...recovery.events, ...recovery.commands].map((e) => e.type).sort();
    // Straight from the gap matrix: this capability is 4 events + 3 commands.
    expect(names).toEqual([
      'resolve_interrupted_approval',
      'resume_turn',
      'session_recovery_replay',
      'session_recovery_snapshot',
      'session_recovery_unavailable',
      'session_resync',
      'turn_recovery_lifecycle',
    ]);
  });
});
