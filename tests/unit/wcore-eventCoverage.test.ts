/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Engine event coverage: every variant is either handled or knowingly inert.
 *
 * The decoder's `default` arm warns on unrecognised events because dropping
 * them in silence once hid `browser_policy_denied` for a whole engine release.
 * Upgrading the engine to v0.12.26 then introduced 23 variants this host does
 * not act on - a single start emits 27 such lines - so they are listed in
 * ACKNOWLEDGED_UNHANDLED_EVENTS and stay quiet.
 *
 * That list is only safe while it stays truthful. These tests pin the two ways
 * it can rot: a name drifting into BOTH the handled union and the inert list
 * (so a real handler looks inert), and the list silently becoming the place
 * where everything goes to be ignored.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claimedEventTypes } from '@process/agent/wcore/capabilities';
import { ACKNOWLEDGED_UNHANDLED_EVENTS } from '@process/agent/wcore/protocol';

const PROTOCOL_SRC = readFileSync(join(process.cwd(), 'src/process/agent/wcore/protocol.ts'), 'utf-8');
const DECODER_SRC = readFileSync(join(process.cwd(), 'src/process/agent/wcore/index.ts'), 'utf-8');

/** Discriminants of the WCoreEvent union - what the decoder actually handles. */
function handledEventTypes(): Set<string> {
  const start = PROTOCOL_SRC.indexOf('export type WCoreEvent =');
  expect(start, 'WCoreEvent union not found').toBeGreaterThan(-1);
  const rest = PROTOCOL_SRC.slice(start);
  // The union ends at the next top-level `export` or section banner.
  const end = /\n(?=export |\/\/\s*=)/.exec(rest.slice('export type WCoreEvent ='.length));
  const block = end ? rest.slice(0, 'export type WCoreEvent ='.length + end.index) : rest;
  return new Set(Array.from(block.matchAll(/type:\s*'([a-z_]+)'/g), (m) => m[1]));
}

describe('acknowledged-unhandled engine events', () => {
  it('is non-empty and every entry is a plain event name', () => {
    expect(ACKNOWLEDGED_UNHANDLED_EVENTS.size).toBeGreaterThan(0);
    for (const name of ACKNOWLEDGED_UNHANDLED_EVENTS) {
      expect(name, `"${name}" is not a snake_case event name`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  /**
   * The failure this guards: someone wires up a handler for, say,
   * `session_recovery_snapshot` but leaves it listed as inert. The decoder
   * would still handle it - but the list now lies about what the host does,
   * and the next reader trusts the list.
   */
  it('never lists an event the decoder actually handles', () => {
    const handled = handledEventTypes();
    const overlap = [...ACKNOWLEDGED_UNHANDLED_EVENTS].filter((name) => handled.has(name));
    expect(overlap, `listed as inert but handled in WCoreEvent: ${overlap.join(', ')}`).toEqual([]);
  });

  it('the decoder consults the list rather than warning unconditionally', () => {
    expect(DECODER_SRC).toContain('ACKNOWLEDGED_UNHANDLED_EVENTS.has(typeStr)');
  });

  /**
   * A cap, not a preference. The list exists so ONE warning stays visible; if
   * it grows without bound the warning is worthless again and the right move is
   * to handle some of these, not to keep extending the exemption.
   */
  it('stays small enough that the warning still means something', () => {
    expect(ACKNOWLEDGED_UNHANDLED_EVENTS.size).toBeLessThanOrEqual(30);
  });

  /**
   * The invariant is "this never warns on every engine start", not "this is on
   * the inert list". A variant satisfies it either way: handled by a registered
   * capability, or listed as knowingly inert. Written this way it keeps proving
   * the same thing as capabilities land, instead of needing an edit each time -
   * `execution_policy` and `workspace_policy` moved from the second column to
   * the first when the execution-policy capability registered.
   */
  it('covers the variants a v0.12.26 engine start actually emits', () => {
    // Measured from the running binary via scripts/measure-approval-order.mjs:
    // these four arrive before the first token of any turn, 27 lines in total.
    const claimed = new Set(claimedEventTypes());
    for (const name of ['execution_policy', 'workspace_policy', 'capability_activation', 'provider_attempt']) {
      const covered = ACKNOWLEDGED_UNHANDLED_EVENTS.has(name) || claimed.has(name);
      expect(covered, `${name} is neither handled nor acknowledged - it would warn on every engine start`).toBe(true);
    }
  });
});
