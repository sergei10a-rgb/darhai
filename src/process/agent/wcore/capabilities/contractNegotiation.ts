/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract negotiation: what this engine build actually supports.
 *
 * The `ready` event carries a `contract` block in which the engine grades every
 * capability it knows about. Three grades matter to a host:
 *
 *   available          - implemented; a host may use it
 *   publication_bound  - the shape is final but emission depends on the engine
 *                        being configured to publish it (anvil receipts)
 *   shape_only         - the type exists, the behaviour does not yet
 *   unavailable        - not in this build
 *
 * WHY A HOST MUST READ THIS. Darhai is pinned to one engine tag but users can
 * point it at another binary (PATH lookup in `binaryResolver`), and the engine
 * self-updates. Sending `session_resync` to a build that graded
 * `turn_recovery_v1` as `shape_only` gets a turn that hangs on a reply that
 * never comes. Every capability that sends a COMMAND therefore has to gate on
 * its grade first - which is why three of the nine research plans list
 * `contract_negotiation` as their dependency.
 *
 * This module is not a `CapabilityHandler`: `ready` is a first-class event with
 * its own arm in the decoder, so the state is captured there and read from
 * here. Keeping it in `capabilities/` puts it next to the modules that consume
 * it rather than in the 1100-line agent file.
 */

/** How the engine grades one capability in its `ready.contract` block. */
export type CapabilityGrade = 'available' | 'publication_bound' | 'shape_only' | 'unavailable';

/** Whether the engine journals enough to answer a recovery request. */
export type SessionPersistence = 'durable' | 'journaled_without_replay' | 'disabled_by_operator' | 'disabled_by_host';

/** The `contract` block of `ready`. Unknown keys are preserved, not rejected. */
export type EngineContract = {
  name?: string;
  major?: number;
  minor?: number;
  generator?: string;
  fixture_digest?: string;
  schema_digest?: string;
  source_inputs_digest?: string;
  capabilities?: Record<string, CapabilityGrade | string>;
};

/** What a capability needs to know before it acts. */
export type NegotiatedContract = {
  /** Engine semver string from `ready.version`, e.g. "0.12.26". */
  engineVersion: string;
  /** Contract major/minor, when the engine states them. */
  contractMajor?: number;
  contractMinor?: number;
  /** Grade per capability id, exactly as the engine reported it. */
  grades: ReadonlyMap<string, CapabilityGrade | string>;
  /** Recovery is only meaningful when the engine journals durably. */
  sessionPersistence?: SessionPersistence;
};

/** The empty contract: nothing is available until an engine says otherwise. */
export const NO_CONTRACT: NegotiatedContract = {
  engineVersion: '',
  grades: new Map(),
};

/**
 * Read the negotiated contract out of a `ready` payload.
 *
 * Tolerant by construction: the schema marks `contract` required, but a host
 * that hard-fails on a slightly-off `ready` is a host that cannot start against
 * an older or newer engine at all. Missing pieces degrade to "nothing is
 * available", which every gate below reads as "do not send that command" - the
 * safe direction.
 */
export function negotiateContract(ready: Record<string, unknown>): NegotiatedContract {
  const version = typeof ready.version === 'string' ? ready.version : '';
  const contract = (ready.contract ?? {}) as EngineContract;
  const rawGrades = contract.capabilities;

  const grades = new Map<string, CapabilityGrade | string>();
  if (rawGrades && typeof rawGrades === 'object') {
    for (const [name, grade] of Object.entries(rawGrades)) {
      if (typeof grade === 'string') grades.set(name, grade);
    }
  }

  const persistence = ready.session_persistence;

  return {
    engineVersion: version,
    contractMajor: typeof contract.major === 'number' ? contract.major : undefined,
    contractMinor: typeof contract.minor === 'number' ? contract.minor : undefined,
    grades,
    sessionPersistence: typeof persistence === 'string' ? (persistence as SessionPersistence) : undefined,
  };
}

/**
 * May this host use `capability` on this engine?
 *
 * Only `available` qualifies. `publication_bound` deliberately does NOT: the
 * shape is settled but emission is conditional, so a host that treats it as
 * usable will sit waiting for events that are never published. A capability
 * that specifically wants the publication-bound grade should ask for the grade
 * directly via {@link gradeOf}.
 */
export function isCapabilityAvailable(contract: NegotiatedContract, capability: string): boolean {
  return contract.grades.get(capability) === 'available';
}

/** The raw grade, or `'unavailable'` when the engine did not mention it. */
export function gradeOf(contract: NegotiatedContract, capability: string): CapabilityGrade | string {
  return contract.grades.get(capability) ?? 'unavailable';
}

/**
 * Can the engine answer a recovery request at all?
 *
 * `turn_recovery_v1` being available is necessary but not sufficient: with
 * persistence off there is no journal to resync against, and the engine would
 * answer `session_recovery_unavailable` every time. Checking both here keeps
 * that reasoning in one place instead of in each caller.
 */
export function canRecoverSessions(contract: NegotiatedContract): boolean {
  if (!isCapabilityAvailable(contract, 'turn_recovery_v1')) return false;
  return contract.sessionPersistence === 'durable';
}

/** Capability ids the engine graded, sorted. For diagnostics and tests. */
export function gradedCapabilities(contract: NegotiatedContract): string[] {
  return [...contract.grades.keys()].sort();
}
