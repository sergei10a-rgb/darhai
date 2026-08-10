/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared access to the vendored engine contract (`tests/fixtures/engine-contract`).
 *
 * Every capability's tests need the same four things: the manifest, an example
 * payload, the adversarial fixtures for their subsystem, and a way to check a
 * payload against the published JSON Schema. Without one place to get them,
 * each test file grows its own path juggling and its own half-right schema
 * loader, and they drift.
 *
 * This module only READS and VALIDATES. It deliberately makes no claim about
 * whether a given fixture should be accepted or rejected - the fixture names
 * are suggestive (`valid-replay`, `cursor-gap`) but not a reliable oracle
 * (`duplicate-identical` is a case a host should tolerate, `noncritical` is
 * about a flag, not a verdict). Each capability's tests state the expected
 * verdict themselves, where it can be justified against the contract.
 */

// The contract's schemas declare draft 2020-12. Ajv's default export only
// knows draft-07, and compiling a 2020-12 schema through it fails with
// "no schema with key or ref .../2020-12/schema" - which reads like a missing
// file rather than the wrong dialect. Import the dialect-matched build.
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRACT_ROOT = join(process.cwd(), 'tests/fixtures/engine-contract');
export const CONTRACT_V1 = join(CONTRACT_ROOT, 'desktop/v1');

/** One entry of the manifest's command/event inventory. */
export type ContractEntry = {
  type: string;
  path: string;
  capability: string;
  /** How badly a host misbehaving here matters, per the engine's own grading. */
  criticality: 'safety' | 'required' | 'observational' | 'recommended' | 'optional';
  /** Which field(s) tie a message to its peer - the key a host must correlate on. */
  correlation?: string;
};

export type ContractManifest = {
  contract: { name: string; major: number; minor: number };
  capabilities: Record<string, 'available' | 'publication_bound' | 'shape_only' | 'unavailable'>;
  subcontracts: Record<string, string>;
  commands: ContractEntry[];
  events: ContractEntry[];
  counts: { commands: number; events: number; fixtures: number; child_types: number };
  fixture_inventory: string[];
};

let manifestCache: ContractManifest | null = null;

export function readManifest(): ContractManifest {
  if (!manifestCache) {
    manifestCache = JSON.parse(readFileSync(join(CONTRACT_V1, 'manifest.json'), 'utf-8')) as ContractManifest;
  }
  return manifestCache;
}

/** The manifest entry for one event or command, or undefined if the contract has none. */
export function entryFor(kind: 'event' | 'command', type: string): ContractEntry | undefined {
  const m = readManifest();
  return (kind === 'event' ? m.events : m.commands).find((e) => e.type === type);
}

/** The engine's own example payload for an event or command. */
export function examplePayload(kind: 'event' | 'command', type: string): Record<string, unknown> {
  const entry = entryFor(kind, type);
  if (!entry) throw new Error(`contract has no ${kind} "${type}"`);
  return JSON.parse(readFileSync(join(CONTRACT_V1, entry.path), 'utf-8')) as Record<string, unknown>;
}

/**
 * Fixture paths for one adversarial subsystem, e.g. `recovery`, `anvil`,
 * `policy`, `workflow`, `commands`, `events`, `types`. Returns paths relative
 * to the contract root so failures name something greppable.
 */
export function adversarialFixtures(subsystem: string): string[] {
  const dir = join(CONTRACT_V1, 'adversarial', subsystem);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
    .sort()
    .map((f) => `adversarial/${subsystem}/${f}`);
}

/** Compat fixture paths for `commands` or `events`. */
export function compatFixtures(kind: 'commands' | 'events'): string[] {
  const dir = join(CONTRACT_V1, 'compat', kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
    .sort()
    .map((f) => `compat/${kind}/${f}`);
}

/**
 * Read a fixture as the ordered list of messages it encodes.
 *
 * Fixtures are JSON Lines: one message per line, in the order the engine would
 * emit them. Order is the point in most of them (a sequence gap, a stale
 * replay), so the array order is preserved exactly and blank lines are
 * dropped rather than yielding holes.
 */
export function readFixture(relPath: string): Record<string, unknown>[] {
  const full = join(CONTRACT_V1, relPath);
  const raw = readFileSync(full, 'utf-8');
  const out: Record<string, unknown>[] = [];
  for (const [i, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch (cause) {
      throw new Error(`${relPath}:${i + 1} is not valid JSON: ${String(cause)}`);
    }
  }
  return out;
}

/** Every message in a fixture that carries the given `type`. */
export function messagesOfType(relPath: string, type: string): Record<string, unknown>[] {
  return readFixture(relPath).filter((m) => m.type === type);
}

type Validator = (payload: unknown) => { valid: boolean; errors: string[] };

function buildValidator(schemaFile: string): Validator {
  const schema = JSON.parse(readFileSync(join(CONTRACT_V1, 'schema', schemaFile), 'utf-8')) as object;
  // The contract's schemas use draft 2020-12 and format assertions; strict mode
  // rejects a few upstream constructs that are legal but unusual, and failing
  // to compile here would look like a Darhai bug rather than a schema nuance.
  const ajv = new Ajv({ strict: false, allErrors: true });
  // ajv-formats is typed against the draft-07 `Ajv` class; `Ajv2020` is a
  // sibling of it, not a subclass, so the types disagree while the runtime API
  // is the same object shape. The cast is the narrowest place to say so.
  addFormats(ajv as unknown as Parameters<typeof addFormats>[0]);
  const compiled = ajv.compile(schema);
  return (payload: unknown) => {
    const valid = compiled(payload) as boolean;
    const errors = (compiled.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    return { valid, errors };
  };
}

let eventValidator: Validator | null = null;
let commandValidator: Validator | null = null;

/** Validate an engine→Desktop event against the published core-event schema. */
export function validateEvent(payload: unknown): { valid: boolean; errors: string[] } {
  if (!eventValidator) eventValidator = buildValidator('core-event.schema.json');
  return eventValidator(payload);
}

/** Validate a Desktop→engine command against the published host-command schema. */
export function validateCommand(payload: unknown): { valid: boolean; errors: string[] } {
  if (!commandValidator) commandValidator = buildValidator('host-command.schema.json');
  return commandValidator(payload);
}

/**
 * The manifest entries for one capability, both directions.
 *
 * Capability tests use this to assert they covered their whole surface rather
 * than the subset someone remembered to list.
 */
export function surfaceOf(capability: string): { events: ContractEntry[]; commands: ContractEntry[] } {
  const m = readManifest();
  return {
    events: m.events.filter((e) => e.capability === capability),
    commands: m.commands.filter((c) => c.capability === capability),
  };
}
