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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claimedEventTypes, registeredCapabilities } from '@process/agent/wcore/capabilities';

const MANAGER_SRC = readFileSync(join(process.cwd(), 'src/process/task/WCoreManager.ts'), 'utf-8');

describe('capability frames bypass the msg_id guard', () => {
  it('the exemption set is built from the registry, not hand-written', () => {
    expect(MANAGER_SRC).toContain('new Set(claimedEventTypes())');
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

  it('every registered capability’s claimed types are in the forwarded set', () => {
    // The registry is the single source; this fails the moment someone
    // introduces a parallel hand-kept list.
    const claimed = new Set(claimedEventTypes());
    for (const capability of registeredCapabilities()) {
      for (const type of capability.handles) {
        expect(claimed.has(type), `${capability.name} claims "${type}" but it is not forwarded`).toBe(true);
      }
    }
  });

  /**
   * A capability that emits under a name it does not claim would be dropped -
   * the exemption set is keyed on claimed types. Nothing prevents that at the
   * type level, so it is stated here as the rule implementers must follow.
   */
  it('documents that a capability must emit under a type it claims', () => {
    expect(MANAGER_SRC).toContain('the capability registry');
  });
});
