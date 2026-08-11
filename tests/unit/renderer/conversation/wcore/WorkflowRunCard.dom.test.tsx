/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The conversation surface's engine-capability output, driven by REAL frames.
 *
 * Every payload here is produced by running the actual capability reducer over
 * the actual engine-contract fixtures and capturing what it emits. A
 * hand-written object would keep passing after a projection changed shape -
 * which is the exact failure these capabilities were written to end, since a
 * dropped engine event is invisible by construction.
 *
 * Named for the run card because that is the surface's main component, but it
 * also covers the two transcript notices the same surface owns: the provider
 * failover receipt and the failed host-delegated delivery.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';

import { createWorkflowLifecycleCapability } from '../../../../../src/process/agent/wcore/capabilities/handlers/workflowLifecycle';
import type {
  CapabilityContext,
  CapabilityStreamFrame,
} from '../../../../../src/process/agent/wcore/capabilities/types';
import { transformMessage, composeMessage } from '../../../../../src/common/chat/chatLib';
import type { IMessageWorkflowRun, TMessage } from '../../../../../src/common/chat/chatLib';
import type { IResponseMessage } from '../../../../../src/common/adapter/ipcBridge';

// i18n: resolve against the REAL en-US bundle rather than echoing the key back.
// Asserting on live copy means a key this surface forgot to add shows up as a
// failing assertion instead of a test that happily matches its own key string.
function loadModule(name: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, `../../../../../src/renderer/services/i18n/locales/en-US/${name}.json`),
      'utf-8'
    )
  ) as Record<string, unknown>;
}

const EN: Record<string, Record<string, unknown>> = {
  conversation: loadModule('conversation'),
  agentMode: loadModule('agentMode'),
};

function lookup(key: string): string | undefined {
  const parts = key.split('.');
  const moduleName = parts.shift();
  let node: unknown = moduleName === undefined ? undefined : EN[moduleName];
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let value = lookup(key) ?? key;
      for (const [name, replacement] of Object.entries(opts ?? {})) {
        value = value.replace(new RegExp(`{{${name}}}`, 'g'), String(replacement));
      }
      return value;
    },
  }),
}));

/** The same lookup, in the shape the notice helpers expect from i18next. */
const t = ((key: string, opts?: Record<string, unknown>) => {
  let value = lookup(key) ?? (typeof opts?.defaultValue === 'string' ? opts.defaultValue : key);
  for (const [name, replacement] of Object.entries(opts ?? {})) {
    value = value.replace(new RegExp(`{{${name}}}`, 'g'), String(replacement));
  }
  return value;
}) as unknown as Parameters<typeof describeFailover>[1];

// `useWCoreMessage` reaches for the IPC bridge at module scope; the notice
// helpers it exports are pure, so a hollow bridge is enough to import them.
vi.mock('../../../../../src/common', () => ({
  ipcBridge: { conversation: { responseStream: { on: () => () => {} } } },
}));

// Imported after the i18n mock is registered so the component picks it up.
const { default: WorkflowRunCard } =
  await import('../../../../../src/renderer/pages/conversation/Messages/components/cards/WorkflowRunCard');
const { default: SubAgentActivityCard } =
  await import('../../../../../src/renderer/pages/conversation/Messages/components/cards/SubAgentActivityCard');
const { describeFailover, describeDelivery } =
  await import('../../../../../src/renderer/pages/conversation/platforms/wcore/useWCoreMessage');
const { createHostDelegatedDeliveryCapability } =
  await import('../../../../../src/process/agent/wcore/capabilities/handlers/hostDelegatedDelivery');
const { createExecutionPolicyCapability } =
  await import('../../../../../src/process/agent/wcore/capabilities/handlers/executionPolicy');
const { EffectivePolicyBadge } =
  await import('../../../../../src/renderer/pages/conversation/platforms/wcore/WCoreSendBox');
type ExecutionPolicyFrame = Parameters<typeof EffectivePolicyBadge>[0]['frame'];

const FIXTURES = path.resolve(__dirname, '../../../../fixtures/engine-contract/desktop/v1/events');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8')) as Record<string, unknown>;
}

/** Run events through the real reducer and hand back every frame it emitted. */
function reduce(events: Array<Record<string, unknown>>): CapabilityStreamFrame[] {
  const capability = createWorkflowLifecycleCapability();
  const frames: CapabilityStreamFrame[] = [];
  const ctx: CapabilityContext = {
    sendCommand: () => {},
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => {},
    warn: () => {},
  };
  for (const event of events) capability.handle(event, ctx);
  return frames;
}

/** The last frame the reducer emitted, as the renderer would receive it. */
function lastMessage(events: Array<Record<string, unknown>>): IMessageWorkflowRun {
  const frames = reduce(events);
  expect(frames.length).toBeGreaterThan(0);
  const frame = frames[frames.length - 1];
  expect(frame.type).toBe('workflow_run');
  const message = transformMessage({
    type: frame.type,
    data: frame.data,
    msg_id: frame.msg_id,
    conversation_id: 'conv-1',
  } as IResponseMessage);
  expect(message?.type).toBe('workflow_run');
  return message as IMessageWorkflowRun;
}

afterEach(cleanup);

describe('WorkflowRunCard - real workflow_lifecycle_v1 frames', () => {
  it('names the run and shows it as running while nodes are still in flight', () => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);

    render(<WorkflowRunCard message={message} />);

    const card = screen.getByTestId('workflow-run-card');
    expect(card.getAttribute('data-workflow-status')).toBe('running');
    // "Desktop audit" comes from the fixture, "Running" from the en-US bundle.
    expect(card.textContent).toContain('Desktop audit');
    expect(card.textContent).toContain('Running');
    // The node the engine reported is listed by its own id.
    expect(screen.getByText('scan')).toBeTruthy();
  });

  it('flips to succeeded when the run finishes, without stacking a second card', () => {
    const frames = reduce([fixture('workflow_started'), fixture('workflow_node_event'), fixture('workflow_finished')]);

    // The agent talks WHILE the workflow runs, so the run's snapshots are not
    // consecutive in the transcript. That interleaving is the whole reason the
    // merge is keyed on runId: without it the generic "same as the last
    // message?" rule pushes a fresh card after every interruption and the user
    // ends up with one card per node transition.
    let list: TMessage[] = [];
    let interleaved = 0;
    for (const frame of frames) {
      const message = transformMessage({
        type: frame.type,
        data: frame.data,
        msg_id: frame.msg_id,
        conversation_id: 'conv-1',
      } as IResponseMessage);
      list = composeMessage(message, list);
      list = composeMessage(
        transformMessage({
          type: 'content',
          data: 'still working',
          msg_id: `turn-${(interleaved += 1)}`,
          conversation_id: 'conv-1',
        } as IResponseMessage),
        list
      );
    }

    const cards = list.filter((message) => message.type === 'workflow_run');
    expect(cards).toHaveLength(1);

    render(<WorkflowRunCard message={cards[0] as IMessageWorkflowRun} />);
    expect(screen.getByTestId('workflow-run-card').getAttribute('data-workflow-status')).toBe('succeeded');
    expect(screen.getByTestId('workflow-run-card').textContent).toContain('Succeeded');
  });

  it('surfaces a failed node with its engine code, message and retryability', () => {
    const started = fixture('workflow_started');
    const failedNode = {
      ...fixture('workflow_node_event'),
      event_id: 'workflow-event-003',
      sequence: 3,
      state: 'failed',
      failure: { code: 'disk_full', message: 'no space left on the audit volume', retryable: false },
    };
    const message = lastMessage([started, failedNode]);

    render(<WorkflowRunCard message={message} />);

    expect(screen.getByText('disk_full')).toBeTruthy();
    expect(screen.getByText('no space left on the audit volume')).toBeTruthy();
    // The single question a failed step raises, answered explicitly.
    expect(screen.getByText('Cannot retry')).toBeTruthy();
    expect(screen.queryByText('Can retry')).toBeNull();
  });

  it('says a retryable failure is retryable', () => {
    const failedNode = {
      ...fixture('workflow_node_event'),
      event_id: 'workflow-event-003',
      sequence: 3,
      state: 'failed',
      failure: { code: 'rate_limited', message: 'try again shortly', retryable: true },
    };
    const message = lastMessage([fixture('workflow_started'), failedNode]);

    render(<WorkflowRunCard message={message} />);
    expect(screen.getByText('Can retry')).toBeTruthy();
  });

  it('reports a run-level failure that no node carried', () => {
    const finishedFailed = {
      ...fixture('workflow_finished'),
      succeeded: false,
      terminal_state: 'failed',
      failure: { code: 'aborted_by_operator', message: 'the operator stopped the run', retryable: true },
    };
    const message = lastMessage([fixture('workflow_started'), finishedFailed]);

    render(<WorkflowRunCard message={message} />);

    expect(screen.getByTestId('workflow-run-card').getAttribute('data-workflow-status')).toBe('failed');
    expect(screen.getByTestId('workflow-run-failure')).toBeTruthy();
    expect(screen.getByText('aborted_by_operator')).toBeTruthy();
    expect(screen.getByText('the operator stopped the run')).toBeTruthy();
  });

  it('says so when a run has reported no node at all, instead of rendering a blank body', () => {
    const message = lastMessage([fixture('workflow_started')]);
    expect(message.content.nodes).toHaveLength(0);

    render(<WorkflowRunCard message={message} />);

    const empty = screen.getByTestId('workflow-run-empty');
    expect(empty.textContent).toBe('No step has reported yet');
  });

  it('changes the empty-state wording once the run is over - nothing is coming', () => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_finished')]);

    render(<WorkflowRunCard message={message} />);
    expect(screen.getByTestId('workflow-run-empty').textContent).toBe('The run ended without reporting a single step');
  });

  it('warns that the stream lost lines, counting the real loss and not the sampled list', () => {
    // The reducer enumerates at most MAX_ENUMERATED_MISSING (256) individual
    // missing sequence numbers but always counts the true total. A card that
    // read `missingSequences.length` would under-report a 999-line gap as 256.
    const farAhead = { ...fixture('workflow_node_event'), event_id: 'workflow-event-999', sequence: 1000 };
    const message = lastMessage([fixture('workflow_started'), farAhead]);

    expect(message.content.missingTotal).toBe(999);

    render(<WorkflowRunCard message={message} />);
    expect(screen.getByTestId('workflow-run-gap').textContent).toContain('999');
  });

  it('does not warn about a gap on a contiguous stream', () => {
    // Sequence 1, not the shipped fixture's 2. The published fixtures step
    // 0 -> 2 -> 4 and therefore DO describe a lossy stream; a "no warning" case
    // has to be built deliberately, or this assertion would be testing the
    // fixture numbering rather than the card.
    const contiguous = { ...fixture('workflow_node_event'), sequence: 1 };
    const message = lastMessage([fixture('workflow_started'), contiguous]);

    expect(message.content.missingTotal).toBe(0);

    render(<WorkflowRunCard message={message} />);
    expect(screen.queryByTestId('workflow-run-gap')).toBeNull();
  });

  it('never prints "N of 0": the declared count is shown as a separate engine claim', () => {
    // The engine's own `after-terminal` fixture opens a run with node_count 0
    // and then emits a node. Rendering that as a fraction would report the
    // engine's inconsistency as a Darhai bug.
    const zeroDeclared = { ...fixture('workflow_started'), node_count: 0 };
    const message = lastMessage([zeroDeclared, fixture('workflow_node_event')]);

    render(<WorkflowRunCard message={message} />);

    const card = screen.getByTestId('workflow-run-card');
    expect(card.textContent).toContain('1 steps reported');
    expect(card.textContent).toContain('engine declared 0');
    expect(card.textContent).not.toContain('1 of 0');
  });

  it('hides the declared-count note when the engine and the stream agree', () => {
    // The shipped fixture declares node_count 1 and emits exactly one node.
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);
    render(<WorkflowRunCard message={message} />);
    expect(screen.getByTestId('workflow-run-card').textContent).not.toContain('engine declared');
  });

  it('cannot be flipped back to failed by a conflicting terminal for a node that already succeeded', () => {
    // The reducer refuses the rewrite; this asserts the CARD shows the refusal
    // rather than the last thing that arrived on the wire.
    const succeeded = {
      ...fixture('workflow_node_event'),
      event_id: 'workflow-event-003',
      sequence: 3,
      state: 'succeeded',
    };
    const contradiction = {
      ...fixture('workflow_node_event'),
      event_id: 'workflow-event-004',
      sequence: 4,
      state: 'failed',
      failure: { code: 'injected', message: 'a second terminal claiming the node failed', retryable: false },
    };
    const message = lastMessage([fixture('workflow_started'), succeeded, contradiction]);

    render(<WorkflowRunCard message={message} />);

    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.queryByText('injected')).toBeNull();
  });

  it('falls back to the workflow id when the engine sends no display name', () => {
    const unnamed = { ...fixture('workflow_started'), name: '' };
    const message = lastMessage([unnamed]);

    render(<WorkflowRunCard message={message} />);
    expect(screen.getByTestId('workflow-run-card').textContent).toContain('desktop-audit');
  });
});

/** Drive the real delivery/failover capability and hand back what it emitted. */
function deliveryFrames(events: Array<Record<string, unknown>>): CapabilityStreamFrame[] {
  const capability = createHostDelegatedDeliveryCapability();
  const frames: CapabilityStreamFrame[] = [];
  const ctx: CapabilityContext = {
    sendCommand: () => {},
    emit: (frame) => frames.push(frame),
    activeMsgId: () => 'turn-1',
    log: () => {},
    warn: () => {},
  };
  for (const event of events) capability.handle(event, ctx);
  capability.reset();
  return frames;
}

function frameOf<T>(frames: CapabilityStreamFrame[], type: string): T {
  const found = frames.find((frame) => frame.type === type);
  expect(found, `no ${type} frame was emitted`).toBeTruthy();
  return found!.data as T;
}

describe('provider failover notice - real provider_failover_receipt frames', () => {
  it('names both providers and the reason when the turn switched', () => {
    const frames = deliveryFrames([fixture('provider_failover_receipt')]);
    const notice = describeFailover(frameOf(frames, 'provider_failover_receipt'), t);

    // The whole point of the capability: the user learns WHY the turn moved.
    expect(notice.content).toBe('anthropic/claude-sonnet-4-6 failed (rate limit) - the turn switched to openai/gpt-5');
    // A provider change is not a green tick, even though the frame grades the
    // switch itself `info` - a different company saw the conversation.
    expect(notice.severity).toBe('warning');
  });

  it('grades the case where nothing survived as an error and lists what was refused', () => {
    const receipt = fixture('provider_failover_receipt').receipt as Record<string, unknown>;
    // Annotated because this repo compiles without strictNullChecks: an
    // inferred `null` literal widens to `any` and TS7018 rejects it.
    const exhausted: Record<string, unknown> = {
      type: 'provider_failover_receipt',
      receipt: {
        ...receipt,
        selected_provider: null,
        selected_model: null,
        candidates: [
          {
            ...(receipt.candidates as Array<Record<string, unknown>>)[0],
            disposition: { Err: 'provider_not_allowed' },
          },
        ],
      },
    };

    const notice = describeFailover(frameOf(deliveryFrames([exhausted]), 'provider_failover_receipt'), t);

    // Today this failure is indistinguishable from a generic error; after this
    // it says the turn had nowhere left to go.
    expect(notice.severity).toBe('error');
    expect(notice.content).toContain('no other provider could take the turn');
    expect(notice.content).toContain('1 candidates were rejected:');
    expect(notice.content).toContain('openai/gpt-5: provider_not_allowed');
  });

  it('admits an unreadable receipt instead of naming a provider it does not know', () => {
    const notice = describeFailover(
      frameOf(deliveryFrames([{ type: 'provider_failover_receipt' }]), 'provider_failover_receipt'),
      t
    );

    expect(notice.content).toBe('The engine switched provider, but the record could not be read');
    // No fabricated provider/model anywhere in the sentence.
    expect(notice.content).not.toContain('null');
    expect(notice.content).not.toContain('undefined');
  });
});

describe('delivery failure notice - real host_send_message_request frames', () => {
  it('points at Settings when no channel is configured for the platform', () => {
    // No deliverer installed, which is exactly the "the agent was asked to email
    // me and nothing is set up" case the capability exists to surface.
    const frames = deliveryFrames([fixture('host_send_message_request')]);
    const frame = frameOf<{ unconfigured: boolean; platform: string }>(frames, 'host_send_message_request');

    expect(frame.unconfigured).toBe(true);
    expect(frame.platform).toBe('email');

    const notice = describeDelivery(frame as never, t);
    expect(notice.content).toBe(
      'The agent tried to send a message over email, but no email channel is set up. Add one in Settings - Channels.'
    );
    expect(notice.severity).toBe('warning');
  });

  it("reports the engine's own error when a configured channel refused the send", () => {
    const frame = {
      capability: 'host_delegated_delivery' as const,
      callId: 'call-send-001',
      platform: 'slack',
      ok: false as const,
      error: 'channel "ops" is archived',
      unconfigured: false,
      severity: 'warning' as const,
    };

    const notice = describeDelivery(frame, t);
    expect(notice.content).toBe('The agent could not send a message over slack: channel "ops" is archived');
  });
});

describe('effective execution policy badge - real execution_policy frames', () => {
  /** Drive the real policy tracker and hand back its decision frames. */
  function policyFrames(events: Array<Record<string, unknown>>): CapabilityStreamFrame[] {
    const capability = createExecutionPolicyCapability();
    const frames: CapabilityStreamFrame[] = [];
    const ctx: CapabilityContext = {
      sendCommand: () => {},
      emit: (frame) => frames.push(frame),
      activeMsgId: () => '',
      log: () => {},
      warn: () => {},
    };
    for (const event of events) capability.handle(event, ctx);
    return frames;
  }

  function lastPolicyFrame(events: Array<Record<string, unknown>>): ExecutionPolicyFrame {
    const frames = policyFrames(events);
    expect(frames.length).toBeGreaterThan(0);
    return frames[frames.length - 1].data as ExecutionPolicyFrame;
  }

  it('shows the posture the engine APPLIED, not the mode the user picked', () => {
    const frame = lastPolicyFrame([fixture('execution_policy')]);

    render(<EffectivePolicyBadge frame={frame} />);

    const badge = screen.getByTestId('execution-policy-badge');
    // The shipped receipt is smart / auto_edit / sandbox required.
    expect(badge.textContent).toBe('Engine: Smart / Auto Edit');
    expect(badge.getAttribute('data-policy-state')).toBe('ok');
  });

  it('flags a managed floor - the case where the mode selector silently lies', () => {
    const receipt = fixture('execution_policy');
    const clamped = {
      ...receipt,
      policy: { ...(receipt.policy as Record<string, unknown>), managed_floor_active: true, approvals: 'prompt' },
    };

    render(<EffectivePolicyBadge frame={lastPolicyFrame([clamped])} />);

    const badge = screen.getByTestId('execution-policy-badge');
    expect(badge.textContent).toBe('Engine: Smart / Ask every time');
    expect(badge.getAttribute('data-policy-state')).toBe('attention');
  });

  it('flags a bypassed sandbox', () => {
    const receipt = fixture('execution_policy');
    const unsandboxed = {
      ...receipt,
      policy: { ...(receipt.policy as Record<string, unknown>), sandbox: 'bypass' },
    };

    render(<EffectivePolicyBadge frame={lastPolicyFrame([unsandboxed])} />);
    expect(screen.getByTestId('execution-policy-badge').getAttribute('data-policy-state')).toBe('attention');
  });

  it('says the posture is unknown when the first receipt was refused, rather than guessing', () => {
    // `critical` is pinned to true by the schema; a receipt claiming false is
    // refused, and with nothing adopted before it there is no policy to show.
    const notCritical = { ...fixture('execution_policy'), critical: false };
    const frame = lastPolicyFrame([notCritical]);

    expect(frame.policy).toBeNull();

    render(<EffectivePolicyBadge frame={frame} />);
    const badge = screen.getByTestId('execution-policy-badge');
    expect(badge.textContent).toBe('Engine posture unknown');
    expect(badge.getAttribute('data-policy-state')).toBe('unknown');
  });

  it('warns that the shown policy is behind the engine after a refused revision', () => {
    // Adopt revision 1, then refuse revision 3 (a gap). The host still holds a
    // valid policy - but it is provably not the engine's current one.
    const first = fixture('execution_policy');
    const gapped = { ...first, revision: 3 };
    const frame = lastPolicyFrame([first, gapped]);

    expect(frame.stale).toBe(true);
    expect(frame.policy).not.toBeNull();

    render(<EffectivePolicyBadge frame={frame} />);
    expect(screen.getByTestId('execution-policy-badge').getAttribute('data-policy-state')).toBe('attention');
  });
});

/**
 * The expand/collapse control has to be operable without a mouse.
 *
 * Both cards used to ship `<div className={styles.header} onClick={...}>`: no
 * `role`, no `tabIndex`, no key handling. Nothing was HIDDEN from a keyboard
 * user, because both default to expanded - they simply had no way to collapse
 * a card, and a screen reader was never told a control existed at all. Both now
 * share one `CardDisclosureHeader`, so these assertions cover the neighbour too.
 */
describe('card disclosure control is reachable from the keyboard', () => {
  function headerOf(): HTMLElement {
    return screen.getByTestId('card-disclosure-header');
  }

  it('announces itself as an expanded control that owns the card body', () => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);
    render(<WorkflowRunCard message={message} />);

    const header = headerOf();
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('tabindex')).toBe('0');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // The control must point at what it controls, or the state it announces
    // refers to nothing a screen reader can move to.
    const controls = header.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).toBeTruthy();
    // ...and it must carry a name, since the arrow glyph is decorative.
    expect(header.getAttribute('aria-label')).toContain('Desktop audit');
  });

  it.each([['Enter'], [' ']])('collapses and re-expands on %s', (key) => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);
    render(<WorkflowRunCard message={message} />);

    expect(screen.getByText('scan')).toBeTruthy();

    fireEvent.keyDown(headerOf(), { key });
    expect(headerOf().getAttribute('aria-expanded')).toBe('false');
    // Collapsed means the body is gone, not merely restyled.
    expect(screen.queryByText('scan')).toBeNull();

    fireEvent.keyDown(headerOf(), { key });
    expect(headerOf().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('scan')).toBeTruthy();
  });

  it('ignores keys that are not a button activation', () => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);
    render(<WorkflowRunCard message={message} />);

    fireEvent.keyDown(headerOf(), { key: 'a' });
    fireEvent.keyDown(headerOf(), { key: 'ArrowDown' });
    expect(headerOf().getAttribute('aria-expanded')).toBe('true');
  });

  it('fixes the neighbouring sub-agent card by the same seam', () => {
    render(
      <SubAgentActivityCard
        message={
          {
            id: 'm1',
            type: 'sub_agent',
            msg_id: 'call-1',
            conversation_id: 'conv-1',
            position: 'left',
            content: { parentCallId: 'call-1', agentName: 'auditor', status: 'running', body: 'looking around' },
          } as never
        }
      />
    );

    const header = headerOf();
    expect(header.getAttribute('role')).toBe('button');
    expect(header.getAttribute('tabindex')).toBe('0');
    expect(header.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(headerOf().getAttribute('aria-expanded')).toBe('false');
  });
});

/**
 * `aria-controls` must never name an element that is not there.
 *
 * The card unmounts its body when collapsed (`{expanded && <div id={bodyId}>}`),
 * so a header that keeps announcing `aria-controls="workflow-run-…"` in the
 * collapsed state is publishing a dangling IDREF - invalid ARIA, and assistive
 * tech that offers "move to the controlled region" has nothing to move to at
 * exactly the moment the user is asking what is hidden. The old test checked
 * resolution in the EXPANDED state only, which is the state where it could not
 * fail.
 */
describe('the disclosure control never points at an element that is not there', () => {
  function headerOf(): HTMLElement {
    return screen.getByTestId('card-disclosure-header');
  }

  /** Whatever `aria-controls` names, it has to exist. Checked in every state. */
  function expectControlsResolves(state: string): void {
    const controls = headerOf().getAttribute('aria-controls');
    if (controls === null) return;
    expect(controls, `${state}: aria-controls is present but empty`).not.toBe('');
    expect(
      document.getElementById(controls),
      `${state}: aria-controls names "${controls}", which is not in the document`
    ).toBeTruthy();
  }

  it('resolves while expanded, and stops claiming a target once collapsed', () => {
    const message = lastMessage([fixture('workflow_started'), fixture('workflow_node_event')]);
    render(<WorkflowRunCard message={message} />);

    expect(headerOf().getAttribute('aria-expanded')).toBe('true');
    expect(headerOf().getAttribute('aria-controls'), 'the expanded card must announce its body').toBeTruthy();
    expectControlsResolves('expanded');

    fireEvent.keyDown(headerOf(), { key: 'Enter' });
    expect(headerOf().getAttribute('aria-expanded')).toBe('false');
    expectControlsResolves('collapsed');

    fireEvent.keyDown(headerOf(), { key: 'Enter' });
    expect(headerOf().getAttribute('aria-expanded')).toBe('true');
    expectControlsResolves('re-expanded');
  });

  it('holds for the neighbouring sub-agent card, which shares the header', () => {
    render(
      <SubAgentActivityCard
        message={
          {
            id: 'm1',
            type: 'sub_agent',
            msg_id: 'call-1',
            conversation_id: 'conv-1',
            position: 'left',
            content: { parentCallId: 'call-1', agentName: 'auditor', status: 'running', body: 'looking around' },
          } as never
        }
      />
    );

    expectControlsResolves('sub-agent expanded');
    fireEvent.keyDown(headerOf(), { key: 'Enter' });
    expectControlsResolves('sub-agent collapsed');
  });
});

/**
 * A field the projection did not send must not be rendered as a number.
 *
 * The card's own docstring promises that "where the projection says nothing,
 * the card says nothing rather than filling the gap with a zero", and the
 * transform half-kept it: a missing `nodes` was coerced to `[]` and rendered as
 * a confident "0 steps reported"; a missing `missingTotal` failed `> 0` and
 * SUPPRESSED the lost-lines warning, so "never counted" was drawn exactly like
 * "counted, nothing lost"; a missing `nodeCount` compared unequal to
 * `nodes.length` and printed the literal "engine declared undefined".
 *
 * The in-tree reducer populates all three, so these drive `transformMessage`
 * directly - which is the seam the defence lives at, and the only place a
 * projection from a future engine or a third-party producer arrives through.
 */
describe('WorkflowRunCard - a projection that omits its measurements', () => {
  /** Build a message from a raw projection body, the way the stream does. */
  function messageFrom(data: Record<string, unknown>): IMessageWorkflowRun {
    const message = transformMessage({
      type: 'workflow_run',
      data,
      msg_id: String(data.runId ?? ''),
      conversation_id: 'conv-1',
    } as IResponseMessage);
    expect(message?.type).toBe('workflow_run');
    return message as IMessageWorkflowRun;
  }

  const COMPLETE = {
    runId: 'run-9',
    workflowId: 'desktop-audit',
    name: 'Desktop audit',
    nodeCount: 1,
    status: 'running',
    missingTotal: 0,
    nodes: [{ nodeId: 'scan', state: 'running' }],
  } as const;

  function without(...keys: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = { ...COMPLETE };
    for (const key of keys) delete body[key];
    return body;
  }

  it('keeps a complete projection unchanged - the control for the three below', () => {
    render(<WorkflowRunCard message={messageFrom({ ...COMPLETE })} />);
    expect(screen.getByTestId('workflow-run-observed').textContent).toBe('1 steps reported');
    expect(screen.queryByTestId('workflow-run-gap')).toBeNull();
    expect(screen.queryByTestId('workflow-run-gap-unknown')).toBeNull();
    expect(screen.getByText('scan')).toBeTruthy();
  });

  it('says the step count is unreported rather than reporting zero steps', () => {
    render(<WorkflowRunCard message={messageFrom(without('nodes'))} />);

    const observed = screen.getByTestId('workflow-run-observed').textContent ?? '';
    expect(observed).toBe(lookup('conversation.workflowRun.nodesUnknown'));
    expect(observed, 'absence was rendered as a measured zero').not.toContain('0');
    // ...and the list area says no list arrived, which is a different fact from
    // "a list arrived and was empty".
    expect(screen.getByTestId('workflow-run-nodes-unknown')).toBeTruthy();
    expect(screen.queryByTestId('workflow-run-empty')).toBeNull();
  });

  it('does not read a missing loss count as proof that nothing was lost', () => {
    render(<WorkflowRunCard message={messageFrom(without('missingTotal'))} />);

    expect(screen.queryByTestId('workflow-run-gap'), 'a count that was never sent must not be quantified').toBeNull();
    const notice = screen.getByTestId('workflow-run-gap-unknown');
    expect(notice.textContent).toBe(lookup('conversation.workflowRun.linesLostUnknown'));
  });

  it('omits the declared-count line instead of printing "declared undefined"', () => {
    render(<WorkflowRunCard message={messageFrom(without('nodeCount'))} />);

    const card = screen.getByTestId('workflow-run-card');
    expect(card.textContent).not.toContain('undefined');
    expect(card.textContent).not.toContain('NaN');
    // The observed count is still a real measurement and is still shown.
    expect(screen.getByTestId('workflow-run-observed').textContent).toBe('1 steps reported');
  });

  it('renders every field absent at once without inventing a single number', () => {
    render(<WorkflowRunCard message={messageFrom(without('nodes', 'missingTotal', 'nodeCount'))} />);

    const card = screen.getByTestId('workflow-run-card');
    expect(card.textContent).not.toContain('undefined');
    expect(card.textContent).not.toContain('0 steps');
    expect(screen.getByTestId('workflow-run-gap-unknown')).toBeTruthy();
    expect(screen.getByTestId('workflow-run-nodes-unknown')).toBeTruthy();
  });

  /**
   * The transform is where absence has to survive; a message that carries a
   * zero the engine never sent cannot be rescued by the component.
   */
  it('does not manufacture the fields on the way through transformMessage', () => {
    const content = messageFrom(without('nodes', 'missingTotal', 'nodeCount')).content;
    expect(content.nodes).toBeUndefined();
    expect(content.missingTotal).toBeUndefined();
    expect(content.nodeCount).toBeUndefined();
    // What WAS sent still arrives.
    expect(content.runId).toBe('run-9');
    expect(content.status).toBe('running');
  });
});
