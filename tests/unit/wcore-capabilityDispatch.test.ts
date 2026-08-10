/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The capability dispatcher's own guarantees, tested before any capability
 * relies on them.
 *
 * Nine engine subsystems are about to be built on this layer independently. If
 * dispatch silently swallows a throw, or lets two handlers claim one event
 * type, the resulting bug shows up in whichever capability happens to be under
 * suspicion - not here, where it belongs.
 *
 * Every test drives `createDispatcher`, the same function production calls, so
 * none of this can drift from the real routing.
 */

import { describe, expect, it } from 'vitest';

import {
  assertNoOverlap,
  claimedEventTypes,
  createDispatcher,
  dispatchCapabilityEvent,
  registeredCapabilities,
} from '@process/agent/wcore/capabilities';
import type { CapabilityContext, CapabilityHandler } from '@process/agent/wcore/capabilities/types';
import { ACKNOWLEDGED_UNHANDLED_EVENTS } from '@process/agent/wcore/protocol';

type Recorder = CapabilityContext & {
  commands: unknown[];
  frames: unknown[];
  logs: string[];
  warns: string[];
};

function makeContext(): Recorder {
  const commands: unknown[] = [];
  const frames: unknown[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    commands,
    frames,
    logs,
    warns,
    sendCommand: (c) => commands.push(c),
    emit: (f) => frames.push(f),
    activeMsgId: () => 'msg-1',
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  };
}

const handler = (name: string, handles: string[], fn: CapabilityHandler['handle']): CapabilityHandler => ({
  name,
  handles,
  handle: fn,
});

describe('routing', () => {
  it('delivers an event to the handler that claims it', () => {
    const seen: Record<string, unknown>[] = [];
    const dispatch = createDispatcher([handler('a', ['evt_a'], (e) => (seen.push(e), true))]);
    expect(dispatch({ type: 'evt_a', n: 1 }, makeContext())).toBe(true);
    expect(seen).toEqual([{ type: 'evt_a', n: 1 }]);
  });

  it('reports false for an event nobody claims', () => {
    const dispatch = createDispatcher([handler('a', ['evt_a'], () => true)]);
    expect(dispatch({ type: 'evt_other' }, makeContext())).toBe(false);
  });

  /**
   * A handler may recognise a type and still decline it - a recovery snapshot
   * for a session that is not ours, say. That must fall through to the caller's
   * own handling rather than being counted as consumed.
   */
  it('passes a declined event back to the caller', () => {
    const dispatch = createDispatcher([handler('a', ['evt_a'], () => false)]);
    expect(dispatch({ type: 'evt_a' }, makeContext())).toBe(false);
  });

  it('ignores an event with no usable type rather than throwing', () => {
    const dispatch = createDispatcher([handler('a', ['evt_a'], () => true)]);
    expect(dispatch({}, makeContext())).toBe(false);
    expect(dispatch({ type: 42 } as unknown as Record<string, unknown>, makeContext())).toBe(false);
  });

  it('gives a handler the context it needs to answer the engine', () => {
    const dispatch = createDispatcher([
      handler('a', ['evt_a'], (_e, ctx) => {
        ctx.sendCommand({ type: 'stop' });
        ctx.emit({ type: 'info', data: 'x', msg_id: ctx.activeMsgId() });
        return true;
      }),
    ]);
    const ctx = makeContext();
    dispatch({ type: 'evt_a' }, ctx);
    expect(ctx.commands).toEqual([{ type: 'stop' }]);
    expect(ctx.frames).toEqual([{ type: 'info', data: 'x', msg_id: 'msg-1' }]);
  });

  it('prefixes a handler’s logs with its capability name', () => {
    const dispatch = createDispatcher([
      handler('diagnostics', ['evt_a'], (_e, ctx) => (ctx.log('hello'), ctx.warn('careful'), true)),
    ]);
    const ctx = makeContext();
    dispatch({ type: 'evt_a' }, ctx);
    expect(ctx.logs[0]).toContain('[diagnostics] hello');
    expect(ctx.warns[0]).toContain('[diagnostics] careful');
  });
});

describe('registration', () => {
  it('rejects two handlers claiming the same event type', () => {
    expect(() => assertNoOverlap([handler('a', ['shared'], () => true), handler('b', ['shared'], () => true)])).toThrow(
      /both claim event "shared"/
    );
  });

  it('rejects a handler that declares no event types', () => {
    expect(() => assertNoOverlap([handler('empty', [], () => true)])).toThrow(/declares no event types/);
  });

  it('accepts disjoint handlers', () => {
    expect(() =>
      assertNoOverlap([handler('a', ['x', 'y'], () => true), handler('b', ['z'], () => true)])
    ).not.toThrow();
  });

  it('createDispatcher enforces the same rule, so a bad set cannot be dispatched', () => {
    expect(() =>
      createDispatcher([handler('a', ['shared'], () => true), handler('b', ['shared'], () => true)])
    ).toThrow(/both claim event "shared"/);
  });
});

/**
 * Isolation: a capability bug must cost its own feature, not the conversation
 * it happened during.
 */
describe('a throwing handler is contained', () => {
  it('reports the event unhandled instead of propagating', () => {
    const dispatch = createDispatcher([
      handler('explodes', ['boom'], () => {
        throw new Error('handler bug');
      }),
    ]);
    const ctx = makeContext();
    expect(() => dispatch({ type: 'boom' }, ctx)).not.toThrow();
    expect(dispatch({ type: 'boom' }, ctx)).toBe(false);
  });

  it('names the capability in the warning so the culprit is identifiable', () => {
    const dispatch = createDispatcher([
      handler('explodes', ['boom'], () => {
        throw new Error('handler bug');
      }),
    ]);
    const ctx = makeContext();
    dispatch({ type: 'boom' }, ctx);
    expect(ctx.warns.join(' ')).toContain('explodes');
  });

  it('a sibling capability keeps working after another one throws', () => {
    const dispatch = createDispatcher([
      handler('explodes', ['boom'], () => {
        throw new Error('handler bug');
      }),
      handler('fine', ['ok'], () => true),
    ]);
    const ctx = makeContext();
    dispatch({ type: 'boom' }, ctx);
    expect(dispatch({ type: 'ok' }, ctx)).toBe(true);
  });
});

describe('the live registry', () => {
  it('every registered capability has a name and at least one type', () => {
    for (const h of registeredCapabilities()) {
      expect(h.name, 'capability without a name').toBeTruthy();
      expect(h.handles.length, `${h.name} claims nothing`).toBeGreaterThan(0);
    }
  });

  it('claimed types are unique across capabilities', () => {
    const claimed = claimedEventTypes();
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  /**
   * The two lists answer opposite questions - "we handle this" and "we
   * knowingly ignore this". A type in both means the acknowledged list is lying
   * about what the host does, which is what makes such a list dangerous as it
   * ages.
   */
  it('no capability claims a type also listed as knowingly inert', () => {
    const overlap = claimedEventTypes().filter((t) => ACKNOWLEDGED_UNHANDLED_EVENTS.has(t));
    expect(overlap, `claimed AND listed inert: ${overlap.join(', ')}`).toEqual([]);
  });

  it('the production dispatcher is callable and declines what nobody claims', () => {
    expect(dispatchCapabilityEvent({ type: 'definitely_not_claimed_xyz' }, makeContext())).toBe(false);
  });
});
