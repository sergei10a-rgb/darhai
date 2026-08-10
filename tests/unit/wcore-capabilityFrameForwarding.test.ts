/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capability frames must survive the msg_id guard.
 *
 * `WCoreManager` drops every stream frame with no `msg_id`, because a frame
 * outside a turn would otherwise put the chat into a false "working" state.
 * But engine capabilities report facts about the SESSION - a policy revision, a
 * workflow run, an audit receipt - and legitimately carry no msg_id. Three
 * earlier features (sub_agent_event, mcp_failed, config_changed) each bought
 * their own hand-written exemption above that guard; nine more would repeat the
 * block nine times and guarantee the tenth is forgotten.
 *
 * So the exemption is derived from the capability registry itself. These tests
 * pin that derivation, because its failure mode is silent: the frame is dropped
 * and the capability merely looks unimplemented.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { forwardableFrameTypes, registeredCapabilities } from '@process/agent/wcore/capabilities';

const MANAGER_SRC = readFileSync(join(process.cwd(), 'src/process/task/WCoreManager.ts'), 'utf-8');

describe('capability frames bypass the msg_id guard', () => {
  it('the exemption set is built from the registry, not hand-written', () => {
    expect(MANAGER_SRC).toContain('new Set(forwardableFrameTypes())');
  });

  /**
   * Order is the whole point: an exemption placed after `if (!data.msg_id)
   * return;` would never run. This asserts the relative position in the source
   * because the alternative - booting a manager and a fake engine - would test
   * far more than the one line at issue.
   */
  it('the exemption is checked BEFORE the guard that would drop it', () => {
    const exemption = MANAGER_SRC.indexOf('CAPABILITY_FRAME_TYPES.has(data.type)');
    const guard = MANAGER_SRC.indexOf('if (!data.msg_id) return;');
    expect(exemption, 'exemption not found').toBeGreaterThan(-1);
    expect(guard, 'msg_id guard not found').toBeGreaterThan(-1);
    expect(exemption).toBeLessThan(guard);
  });

  it('forwards the frame with its own type rather than flattening to info', () => {
    // The renderer routes on `type`; collapsing every capability frame into an
    // `info` line would make them indistinguishable and unstylable.
    const block = MANAGER_SRC.slice(
      MANAGER_SRC.indexOf('CAPABILITY_FRAME_TYPES.has(data.type)'),
      MANAGER_SRC.indexOf('if (!data.msg_id) return;')
    );
    expect(block).toContain('type: data.type');
    expect(block).toContain('conversation_id: this.conversation_id');
  });

  it('every registered capability’s claimed AND emitted types are forwarded', () => {
    // The registry is the single source; this fails the moment someone
    // introduces a parallel hand-kept list.
    const forwarded = new Set(forwardableFrameTypes());
    for (const capability of registeredCapabilities()) {
      for (const type of capability.handles) {
        expect(forwarded.has(type), `${capability.name} handles "${type}" but it is not forwarded`).toBe(true);
      }
      for (const type of capability.emits ?? []) {
        expect(forwarded.has(type), `${capability.name} emits "${type}" but it is not forwarded`).toBe(true);
      }
    }
  });

  /**
   * The gap this whole seam exists to close. Two capabilities project several
   * wire events into ONE frame under a name they never consume - workflow
   * lifecycle emits `workflow_run`, anvil emits `anvil_receipt_alert`. Keying
   * the exemption on `handles` alone dropped both: the capability worked, its
   * tests passed, and nothing reached the user.
   */
  it('forwards projection frames whose name is not a consumed event', () => {
    const forwarded = new Set(forwardableFrameTypes());
    for (const projection of ['workflow_run', 'anvil_receipt_alert']) {
      expect(forwarded.has(projection), `${projection} would be dropped by the msg_id guard`).toBe(true);
    }
  });

  it('derives the set from the registry rather than a hand-kept list', () => {
    expect(MANAGER_SRC).toContain('capability registry');
  });
});

/**
 * The mechanical guard.
 *
 * The rule - "a capability must emit under a type the forward set knows" - was
 * previously asserted by checking that a COMMENT phrase existed in another
 * file. That test passed while `workflow_run` and `anvil_receipt_alert` were
 * being dropped on every turn, and would have kept passing for a tenth
 * capability repeating the mistake.
 *
 * This scans the handler sources instead. Every `ctx.emit({ type: X })` is
 * read out of the file - literal or named constant - and checked against the
 * registry's own forward set. It is the check that would have caught the
 * defect on the day it was written.
 */
describe('every emitted frame type is forwardable (source scan)', () => {
  const HANDLER_DIR = join(process.cwd(), 'src/process/agent/wcore/capabilities/handlers');

  /**
   * Emitted type names per handler file.
   *
   * `type:` in an `emit` call is either a string literal or a module constant;
   * both forms appear in the tree today. A constant is resolved against the
   * same file's `const NAME = 'value'` declarations - deliberately no
   * cross-file resolution, because a frame name defined elsewhere is exactly
   * the indirection this guard should force an author to avoid.
   */
  function emittedTypes(source: string): string[] {
    const consts = new Map<string, string>();
    for (const m of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*'([^']+)'/g)) {
      consts.set(m[1], m[2]);
    }

    const found = new Set<string>();
    for (const m of source.matchAll(/ctx\.emit\(\{[^)]*?\btype:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))/g)) {
      const literal = m[1];
      const ident = m[2];
      if (literal) {
        found.add(literal);
        continue;
      }
      const resolved = ident ? consts.get(ident) : undefined;
      // An unresolvable identifier is reported by name so the failure says
      // what to look at rather than silently passing.
      found.add(resolved ?? `<unresolved:${ident}>`);
    }
    return [...found];
  }

  const files = readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts'));

  it('finds handler sources to scan', () => {
    // A scan over zero files is green and worthless. Nine capabilities are
    // registered; the directory must hold at least that many modules.
    expect(files.length).toBeGreaterThanOrEqual(registeredCapabilities().length);
  });

  it.each(files)('%s emits only types WCoreManager will forward', (file) => {
    const source = readFileSync(join(HANDLER_DIR, file), 'utf-8');
    const forwarded = new Set(forwardableFrameTypes());
    for (const type of emittedTypes(source)) {
      expect(
        forwarded.has(type),
        `${file} emits "${type}" but it is not in forwardableFrameTypes() - ` +
          `WCoreManager drops it before the renderer. Add it to the handler's ` +
          `\`handles\` or \`emits\`.`
      ).toBe(true);
    }
  });
});
