/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The vendored contract must describe the engine we actually ship.
 *
 * `tests/fixtures/engine-contract/` is the published `desktop-contract-v1`
 * bundle for one specific release. Every protocol assertion in the suite reads
 * from it, so if the bundled binary moves and the bundle does not, those
 * assertions quietly start proving something about an engine nobody runs -
 * green tests, stale truth. That is the same shape as the bug that let the
 * Settings card advertise `v0.9.6-rc.1` while `v0.10.0` shipped.
 *
 * These tests are cheap and read only files that are committed, so they run
 * everywhere - no binary, no network.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CONTRACT_ROOT = join(REPO_ROOT, 'tests/fixtures/engine-contract');
const V1 = join(CONTRACT_ROOT, 'desktop/v1');

/** The release tag the build actually fetches the binary from. */
function shippedEngineTag(): string {
  const source = readFileSync(join(REPO_ROOT, 'scripts/prepareWaylandCore.js'), 'utf-8');
  const match = /const\s+DEFAULT_WCORE_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(source);
  if (!match) throw new Error('DEFAULT_WCORE_VERSION not found');
  return match[1];
}

/** The README records which release the bundle was extracted from. */
function documentedContractTag(): string {
  const readme = readFileSync(join(CONTRACT_ROOT, 'README.md'), 'utf-8');
  const match = /\*\*Version:\s*`([^`]+)`\*\*/.exec(readme);
  if (!match) throw new Error('contract README does not state its version');
  return match[1];
}

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(V1, 'manifest.json'), 'utf-8')) as Record<string, unknown>;
}

describe('vendored engine contract', () => {
  it('is present and complete', () => {
    for (const sub of ['commands', 'events', 'schema', 'adversarial', 'compat', 'types']) {
      expect(existsSync(join(V1, sub)), `missing ${sub}/`).toBe(true);
    }
    expect(existsSync(join(V1, 'manifest.json'))).toBe(true);
  });

  it('describes the engine release the build ships', () => {
    expect(documentedContractTag()).toBe(shippedEngineTag());
  });

  /**
   * The manifest counts are the bundle's own statement of what it contains.
   * A partial extraction (interrupted download, a stray .gitignore rule eating
   * a directory) would leave files missing while everything still parses.
   */
  it('has every file the manifest claims', () => {
    const m = manifest();
    const counts = m.counts as { commands: number; events: number; fixtures: number };
    const commands = readdirSync(join(V1, 'commands')).filter((f) => f.endsWith('.json'));
    const events = readdirSync(join(V1, 'events')).filter((f) => f.endsWith('.json'));

    expect(commands.length, 'command payloads').toBe(counts.commands);
    expect(events.length, 'event payloads').toBe(counts.events);

    const inventory = m.fixture_inventory as string[];
    expect(inventory.length, 'fixture inventory size').toBe(counts.fixtures);
    const missing = inventory.filter((rel) => !existsSync(join(V1, rel)));
    expect(missing, `fixtures listed but absent: ${missing.slice(0, 5).join(', ')}`).toEqual([]);
  });

  it('every command and event entry points at a payload that exists', () => {
    const m = manifest();
    const entries = [...(m.commands as { path: string }[]), ...(m.events as { path: string }[])];
    const missing = entries.map((e) => e.path).filter((p) => !existsSync(join(V1, p)));
    expect(missing, `declared but absent: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * A host that reads `criticality` to decide how hard to fail needs those
   * values to be from a known set - an unrecognised one must not be treated as
   * "probably fine".
   */
  it('uses only criticality levels this host knows how to weigh', () => {
    const m = manifest();
    const known = new Set(['safety', 'required', 'observational', 'recommended', 'optional']);
    const entries = [
      ...(m.commands as { type: string; criticality?: string }[]),
      ...(m.events as { type: string; criticality?: string }[]),
    ];
    const unknown = entries.filter((e) => e.criticality && !known.has(e.criticality));
    expect(
      unknown.map((e) => `${e.type}:${e.criticality}`),
      'unknown criticality level'
    ).toEqual([]);
  });
});
