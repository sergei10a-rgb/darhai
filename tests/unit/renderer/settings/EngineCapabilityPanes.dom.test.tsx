/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Settings panes that render engine capability frames.
 *
 * WHY THE PAYLOADS ARE NOT WRITTEN BY HAND. Every frame these panes receive is
 * built here by driving the CONTRACT'S OWN fixtures through the REAL
 * main-process capability handler and capturing what it emits - the same object
 * `WCoreManager` forwards on `conversation.responseStream`. A hand-written
 * `{ status: 'snapshot', ... }` would keep passing after the handler renamed a
 * field, and the pane would render blank in production while the suite stayed
 * green. This way a rename breaks the render assertion here.
 *
 * It has to be a RUNTIME guard: `tsconfig.json` includes `src/**` only, so a
 * type-level assignment written in this file is never checked by anything.
 */

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createDispatcher } from '@process/agent/wcore/capabilities';
import type { CapabilityContext, CapabilityStreamFrame } from '@process/agent/wcore/capabilities/types';
import {
  capabilityActivationCapability,
  resetCapabilityActivation,
} from '@process/agent/wcore/capabilities/handlers/capabilityActivation';
import {
  resetRuntimeRequests,
  runtimeDiagnosticsCapability,
  sendGetRuntimeDiagnostics,
  sendRemoveMcpServer,
} from '@process/agent/wcore/capabilities/handlers/runtimeDiagnostics';
import { negotiateContract } from '@process/agent/wcore/capabilities/contractNegotiation';
import { recordEngineContract, resetEngineContract } from '@process/agent/wcore/capabilities/engineContractStore';
import { buildWcoreCapabilitySnapshot } from '@process/bridge/wcoreEngineBridge';
import { examplePayload, readFixture } from '../../../helpers/engineContract';

// --- hoisted mock state ------------------------------------------------------

type EngineRequestOutcome = {
  engines: number;
  sent: Array<{ conversationId: string; requestId?: string; reason?: string }>;
  refused: Array<{ conversationId: string; requestId?: string; reason?: string }>;
};

const { streamHandlers, setSectionCalls, sectionValues, mcpServers, engineBridge } = vi.hoisted(() => ({
  streamHandlers: [] as Array<(m: { type: string; data: unknown; msg_id: string; conversation_id: string }) => void>,
  setSectionCalls: [] as Array<{ section: string; value: Record<string, unknown> }>,
  sectionValues: { value: {} as Record<string, Record<string, unknown> | undefined> },
  mcpServers: { value: [] as unknown[] },
  // The `wcoreEngine` bridge, as the renderer sees it. Every payload here is
  // built in a test from the REAL main-process producers, never hand-shaped.
  engineBridge: {
    snapshot: { value: null as unknown },
    liveness: { value: { engines: 1, engineVersion: '' } as { engines: number; engineVersion: string } },
    diagnostics: { value: { engines: 0, sent: [], refused: [] } as EngineRequestOutcome },
    withdrawal: { value: { engines: 0, sent: [], refused: [] } as EngineRequestOutcome },
    diagnosticsCalls: { value: 0 },
    withdrawCalls: { value: [] as Array<{ name: string }> },
  },
}));

/** Every `Modal.confirm` the page opened, so a test can answer it. */
const confirmOptions = vi.hoisted(() => ({ value: [] as Array<{ onOk?: () => unknown }> }));

// Arco's imperative `Modal.confirm` mounts through the legacy `ReactDOM.render`,
// which React 19 removed - it throws in jsdom before any of OUR code runs. Only
// that one static is replaced; every other Arco export (Button, Slider,
// Message) stays real, and the test still has to answer the confirmation, so
// the destructive path is not silently skipped.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Modal: {
      ...(actual.Modal as object),
      confirm: (options: { onOk?: () => unknown }) => {
        confirmOptions.value.push(options);
        return { close: (): void => undefined, update: (): void => undefined };
      },
    },
  };
});

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

// Return the reference English copy and interpolate, so assertions read against
// stable strings rather than whichever locale bundle happens to be loaded.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      opts?: Record<string, unknown> & { defaultValue?: string; defaultValue_one?: string; defaultValue_other?: string }
    ) => {
      // Plural-aware, because the copy under test is. A stub that only reads
      // `defaultValue` silently renders the KEY for every counted string, and
      // the assertion then fails on the shape of the stub rather than on the
      // component - which is exactly what happened when the counted labels
      // moved to `_one`/`_other`.
      const plural = opts?.count === 1 ? opts?.defaultValue_one : opts?.defaultValue_other;
      let out = plural ?? opts?.defaultValue ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k.startsWith('defaultValue')) continue;
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

vi.mock('../../../../src/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (handler: (typeof streamHandlers)[number]) => {
          streamHandlers.push(handler);
          return () => {
            const at = streamHandlers.indexOf(handler);
            if (at !== -1) streamHandlers.splice(at, 1);
          };
        },
      },
    },
    acpConversation: {
      getAvailableAgents: { invoke: () => Promise.resolve({ success: true, data: [{ backend: 'wcore' }] }) },
    },
    wcoreConfig: {
      getSection: ({ section }: { section: string }) => Promise.resolve(sectionValues.value[section]),
      setSection: { invoke: () => Promise.resolve({ ok: true }) },
      getConfigPath: { invoke: () => Promise.resolve('/home/tester/.config/darhai/config.toml') },
    },
    wcoreProfiles: { list: { invoke: () => Promise.resolve([]) } },
    wcoreEngine: {
      capabilitySnapshot: {
        invoke: () =>
          engineBridge.snapshot.value === null
            ? Promise.resolve({
                activation: [],
                overflowed: false,
                grades: {},
                contractKnown: false,
                engineVersion: '',
              })
            : Promise.resolve(engineBridge.snapshot.value),
      },
      requestRuntimeDiagnostics: {
        invoke: () => {
          engineBridge.diagnosticsCalls.value += 1;
          return Promise.resolve(engineBridge.diagnostics.value);
        },
      },
      withdrawMcpServer: {
        invoke: (params: { name: string }) => {
          engineBridge.withdrawCalls.value.push(params);
          return Promise.resolve(engineBridge.withdrawal.value);
        },
      },
      liveness: { invoke: () => Promise.resolve(engineBridge.liveness.value) },
    },
  },
}));

vi.mock('../../../../src/common/config/storage', () => ({
  ConfigStorage: { get: () => Promise.resolve(undefined), set: () => Promise.resolve(undefined) },
}));

vi.mock('../../../../src/renderer/hooks/useWcoreConfig', () => ({
  useWcoreConfig: () => ({
    getSection: (section: string) => Promise.resolve(sectionValues.value[section]),
    setSection: (section: string, value: Record<string, unknown>) => {
      setSectionCalls.push({ section, value });
      return Promise.resolve(true);
    },
  }),
}));

vi.mock('../../../../src/renderer/hooks/useModelRegistry', () => ({
  useModelRegistry: () => ({ providers: [] as Array<{ providerId: string }> }),
}));

vi.mock('../../../../src/renderer/pages/settings/WCoreConfig/components/useEngineConfigPath', () => ({
  useEngineConfigPath: () => '/home/tester/.config/darhai/config.toml',
}));

// InstalledPage's data layer. The page under test here is the engine-withdrawal
// notice, so every server hook resolves empty and the rows are stubbed out.
vi.mock('../../../../src/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({ mcpServers: mcpServers.value, saveMcpServers: vi.fn() }),
  useMcpAgentStatus: () => ({ setAgentInstallStatus: vi.fn(), checkSingleServerInstallStatus: vi.fn() }),
  useMcpOperations: () => ({ syncMcpToAgents: vi.fn(), removeMcpFromAgents: vi.fn() }),
  useMcpOAuth: () => ({ oauthStatus: {}, login: vi.fn() }),
  useMcpServerCRUD: () => ({
    handleDeleteMcpServer: vi.fn().mockResolvedValue(undefined),
    handleToggleMcpServer: vi.fn(),
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: vi.fn(),
  }),
  useMcpConnection: () => ({ testingServers: {}, refreshServerStatuses: vi.fn() }),
}));

vi.mock('../../../../src/renderer/pages/settings/McpLibrary/hooks/useMcpLibrary', () => ({
  useMcpLibrary: () => ({ entries: [] as unknown[] }),
}));

vi.mock('../../../../src/renderer/pages/settings/components/AddMcpServerModal', () => ({
  default: (): null => null,
}));

// The row itself is not under test, but its Remove action is the ONLY entry
// point to the withdrawal round-trip - a `null` stub made that path untestable
// and is what let a `handleRemove` that never asked the engine ship.
vi.mock('../../../../src/renderer/pages/settings/McpLibrary/components/ServerRow', async () => {
  // `createElement` rather than JSX: a `vi.mock` factory is hoisted above the
  // file's own imports, so the classic JSX transform's `React` binding is not
  // reliably in scope here.
  const react = await import('react');
  return {
    ServerRow: ({ server, onRemove }: { server: { id: string; name: string }; onRemove: () => void }) =>
      react.createElement(
        'button',
        { type: 'button', 'data-testid': `row-remove-${server.id}`, onClick: onRemove },
        `row remove ${server.name}`
      ),
  };
});

vi.mock('../../../../src/renderer/pages/settings/WCoreConfig/panes/Panes.module.css', () => ({ default: {} }));

import React from 'react';
import OverviewPane from '../../../../src/renderer/pages/settings/WCoreConfig/panes/OverviewPane';
import RuntimePane from '../../../../src/renderer/pages/settings/WCoreConfig/panes/RuntimePane';
import MemoryPane from '../../../../src/renderer/pages/settings/WCoreConfig/panes/MemoryPane';
import { InstalledPage } from '../../../../src/renderer/pages/settings/McpLibrary/InstalledPage';

// --- frames, captured from the real handlers --------------------------------

const CONVERSATION = 'conv-1';

/** A capability context that records what the handler emitted. */
function recorder(): CapabilityContext & { frames: CapabilityStreamFrame[] } {
  const frames: CapabilityStreamFrame[] = [];
  return {
    frames,
    sendCommand: () => undefined,
    emit: (frame) => frames.push(frame),
    activeMsgId: () => '',
    log: () => undefined,
    warn: () => undefined,
  };
}

/** Replay a measured `capability_activation` capture and keep what it emitted. */
function activationFrames(relPath: string): CapabilityStreamFrame[] {
  resetCapabilityActivation();
  const ctx = recorder();
  const dispatch = createDispatcher([capabilityActivationCapability]);
  for (const event of readFixture(relPath)) dispatch(event, ctx);
  return ctx.frames;
}

/**
 * Arm a diagnostics request, answer it with the contract's own snapshot event,
 * and keep the frame the handler produced. `patch` mutates the snapshot body
 * first so a test can ask about a server the fixture does not contain.
 */
function diagnosticsFrame(patch?: (snapshot: Record<string, unknown>) => void): CapabilityStreamFrame {
  resetRuntimeRequests();
  const ctx = recorder();
  const contract = negotiateContract(examplePayload('event', 'ready'));
  const event = JSON.parse(JSON.stringify(examplePayload('event', 'runtime_diagnostics_snapshot')));
  patch?.(event.snapshot as Record<string, unknown>);
  expect(sendGetRuntimeDiagnostics(ctx, event.request_id as string, { contract, canReachEngine: () => true }).ok).toBe(
    true
  );
  createDispatcher([runtimeDiagnosticsCapability])(event, ctx);
  const frame = ctx.frames.at(-1);
  expect(frame, 'the handler must have emitted a diagnostics frame').toBeDefined();
  return frame as CapabilityStreamFrame;
}

/** The same, for `runtime_diagnostics_unavailable`. */
function unavailableFrame(): CapabilityStreamFrame {
  resetRuntimeRequests();
  const ctx = recorder();
  const contract = negotiateContract(examplePayload('event', 'ready'));
  const event = examplePayload('event', 'runtime_diagnostics_unavailable');
  expect(sendGetRuntimeDiagnostics(ctx, event.request_id as string, { contract, canReachEngine: () => true }).ok).toBe(
    true
  );
  createDispatcher([runtimeDiagnosticsCapability])(event, ctx);
  return ctx.frames.at(-1) as CapabilityStreamFrame;
}

/** The same, for `mcp_removal_result`. `name` drives the mismatch case. */
function removalFrame(requestedName = 'desktop-tools'): CapabilityStreamFrame {
  resetRuntimeRequests();
  const ctx = recorder();
  const contract = negotiateContract(examplePayload('event', 'ready'));
  const event = examplePayload('event', 'mcp_removal_result');
  expect(
    sendRemoveMcpServer(
      ctx,
      { requestId: event.request_id as string, name: requestedName },
      {
        contract,
        canReachEngine: () => true,
      }
    ).ok
  ).toBe(true);
  createDispatcher([runtimeDiagnosticsCapability])(event, ctx);
  return ctx.frames.at(-1) as CapabilityStreamFrame;
}

/** Push frames at every live `responseStream` subscriber, the way the task layer does. */
function emit(frames: CapabilityStreamFrame[], conversationId = CONVERSATION): void {
  act(() => {
    for (const frame of frames) {
      for (const handler of streamHandlers) {
        handler({ type: frame.type, data: frame.data, msg_id: frame.msg_id, conversation_id: conversationId });
      }
    }
  });
}

/**
 * The main process's RETAINED readiness record, built by the real assembler.
 *
 * This is the payload a pane receives on mount, and it is what makes the
 * Overview table correct for the only sequence users actually perform: engine
 * starts during a chat (pane unmounted, every frame missed), then Settings is
 * opened. Replaying the capture and reading the record back is the whole
 * mechanism - a hand-written `{ activation: [...] }` would prove nothing about
 * whether the record survives the frames.
 */
function retainedSnapshot(...captures: string[]): unknown {
  resetCapabilityActivation();
  resetEngineContract();
  const ctx = recorder();
  const dispatch = createDispatcher([capabilityActivationCapability]);
  for (const relPath of captures) {
    for (const event of readFixture(relPath)) dispatch(event, ctx);
  }
  recordEngineContract(negotiateContract(examplePayload('event', 'ready')));
  return buildWcoreCapabilitySnapshot();
}

/**
 * Dispatch one more event into the record that is ALREADY loaded.
 *
 * No reset: this is how a mid-session revision reaches the main process, and
 * the ordering matters - `CapabilityActivationRecord.accept` runs BEFORE the
 * handler emits, so a pane that re-reads the record on the frame is guaranteed
 * to get an answer that already contains it.
 */
function recordThenEmit(event: Record<string, unknown>): CapabilityStreamFrame {
  const ctx = recorder();
  createDispatcher([capabilityActivationCapability])(event, ctx);
  const frame = ctx.frames.at(-1);
  expect(frame, 'the handler must have emitted a frame for this event').toBeDefined();
  return frame as CapabilityStreamFrame;
}

/**
 * Press the pane's own button, then answer it the way the engine would.
 *
 * The reply is addressed to the `requestId` the (mocked) main process handed
 * back, because the pane refuses any frame it did not ask for: two open chats
 * are two engines and two different answers to the same question.
 */
async function askThenAnswer(frame: CapabilityStreamFrame, conversationId = CONVERSATION): Promise<void> {
  const requestId = (frame.data as { requestId: string }).requestId;
  engineBridge.diagnostics.value = { engines: 1, sent: [{ conversationId, requestId }], refused: [] };
  fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));
  await screen.findByTestId('diagnostics-pending');
  emit([frame], conversationId);
}

beforeEach(() => {
  streamHandlers.length = 0;
  setSectionCalls.length = 0;
  sectionValues.value = {};
  mcpServers.value = [];
  engineBridge.snapshot.value = null;
  engineBridge.liveness.value = { engines: 1, engineVersion: '' };
  engineBridge.diagnostics.value = { engines: 0, sent: [], refused: [] };
  engineBridge.withdrawal.value = { engines: 0, sent: [], refused: [] };
  engineBridge.diagnosticsCalls.value = 0;
  engineBridge.withdrawCalls.value = [];
  confirmOptions.value = [];
  resetCapabilityActivation();
  resetEngineContract();
  resetRuntimeRequests();
});

// --- Overview: engine capability readiness -----------------------------------

describe('Overview - engine capability readiness', () => {
  it('says the engine has not announced anything rather than showing a blank panel', () => {
    render(<OverviewPane version='0.12.26' />);
    expect(screen.getByTestId('engine-capabilities-empty')).toBeTruthy();
    expect(screen.queryByTestId('engine-capabilities-table')).toBeNull();
  });

  /**
   * THE MOUNT-ORDER TEST, and the one this suite did not have.
   *
   * No frame is emitted here AT ALL - the engine started and finished
   * announcing itself before the pane existed, which is the only sequence a
   * real user produces: opening a Darhai Core chat is what starts the engine,
   * and Settings is unmounted while that happens. A pane built on the live
   * stream alone renders the empty state forever in exactly this test.
   *
   * Delete the mount-time `capabilitySnapshot` pull from `OverviewPane` and
   * this test goes red; every other Overview test in this file stays green,
   * because they all push frames into an already-mounted component.
   */
  it('fills the table from the retained record when every frame arrived before mount', async () => {
    engineBridge.snapshot.value = retainedSnapshot('observed/capability_activation.default.jsonl');
    render(<OverviewPane version='0.12.26' />);

    const table = await screen.findByTestId('engine-capabilities-table');
    expect(within(table).getAllByRole('row').length - 1).toBe(8);
    // The safety statement the whole feature exists to surface.
    const row = within(table).getByText('delegate_isolation').closest('tr');
    expect(row!.textContent).toContain('declined');
    expect(row!.textContent).toContain('Isolation is NOT being enforced on this platform.');
    expect(streamHandlers.length).toBeGreaterThan(0);
  });

  it('lets a live engine replace what the retained record said', async () => {
    engineBridge.snapshot.value = retainedSnapshot('observed/capability_activation.default.jsonl');
    render(<OverviewPane version='0.12.26' />);
    await screen.findByTestId('engine-capabilities-table');

    // A NEW engine process. Its `ready` clears the retained record before it
    // announces anything, so what the main process holds from here on is its
    // rows alone - which is what the pane must end up showing.
    resetCapabilityActivation();
    const frame = recordThenEmit({
      type: 'capability_activation',
      capability: 'mid_flight_monitor',
      stage: 'ready',
    });
    engineBridge.snapshot.value = buildWcoreCapabilitySnapshot();
    emit([frame], 'conv-new');

    // Keeping the dead process's rows alongside a live one's would be the blend
    // the record itself guards against.
    const table = await screen.findByTestId('engine-capabilities-table');
    await waitFor(() => expect(within(table).getAllByRole('row').length - 1).toBe(1));
    expect(within(table).queryByText('delegate_isolation')).toBeNull();
  });

  /**
   * THE MID-SESSION REVISION, and the assumption the old merge rule rested on.
   *
   * Retained rows were seeded under `conversationId: null`, so the FIRST live
   * frame from any conversation replaced the whole 8-row table with a single
   * row. The justification was that "any frame arriving after mount comes from
   * an engine whose `ready` already cleared the record" - which holds only if
   * activation frames never arrive mid-session, while `capabilityActivation.ts`
   * implements `outcome_changed` and `health: 'changed'` for exactly the case
   * where one does. The table would then collapse to one row, taking
   * `delegate_isolation: isolation_not_enforced` - the safety statement this
   * whole feature exists to surface - off a readout whose stated rule is that a
   * missing row must never read as "not configured", and nothing re-pulls, so
   * it never came back.
   *
   * Restore the wholesale replace (drop the `showingRetained` re-read in
   * `OverviewPane`) and this goes red: 8 rows become 1.
   */
  it('keeps the other rows when the engine revises one verdict mid-session', async () => {
    engineBridge.snapshot.value = retainedSnapshot('observed/capability_activation.default.jsonl');
    render(<OverviewPane version='0.12.26' />);
    const before = await screen.findByTestId('engine-capabilities-table');
    expect(within(before).getAllByRole('row').length - 1).toBe(8);

    // Same engine, same record - it is revising a verdict it already gave.
    const frame = recordThenEmit({
      type: 'capability_activation',
      capability: 'mid_flight_monitor',
      stage: 'outcome_changed',
      reason: 'dependency_unavailable',
    });
    engineBridge.snapshot.value = buildWcoreCapabilitySnapshot();
    emit([frame], 'conv-live');

    const table = await screen.findByTestId('engine-capabilities-table');
    await waitFor(() =>
      expect(within(table).getByText('mid_flight_monitor').closest('tr')!.textContent).toContain('outcome changed')
    );
    // The seven capabilities the engine did NOT re-announce are still there.
    expect(within(table).getAllByRole('row').length - 1).toBe(8);
    expect(within(table).getByText('delegate_isolation').closest('tr')!.textContent).toContain(
      'Isolation is NOT being enforced on this platform.'
    );
  });

  it('separates "an engine said nothing" from "no engine has run"', async () => {
    // A contract was published, so an engine DID start - it just announced no
    // readiness. Telling that user to open a chat would be advice for a state
    // they are not in.
    resetCapabilityActivation();
    resetEngineContract();
    recordEngineContract(negotiateContract(examplePayload('event', 'ready')));
    engineBridge.snapshot.value = buildWcoreCapabilitySnapshot();

    render(<OverviewPane version='0.12.26' />);
    const empty = await screen.findByTestId('engine-capabilities-empty');
    await waitFor(() => expect(empty.textContent).toContain('announced no capability readiness'));
    expect(empty.textContent).not.toContain('Open a Darhai Core chat and come back');
  });

  it('renders one row per capability from the measured 24-frame start', async () => {
    render(<OverviewPane version='0.12.26' />);
    emit(activationFrames('observed/capability_activation.default.jsonl'));

    const table = await screen.findByTestId('engine-capabilities-table');
    // 8 capabilities, not 24 frames: the last frame per capability wins.
    expect(within(table).getAllByRole('row').length - 1).toBe(8);
    expect(within(table).getByText('mid_flight_monitor')).toBeTruthy();
    expect(within(table).getByText('smart_handoff')).toBeTruthy();
  });

  it('surfaces delegate_isolation as declined, with the engine’s own reason', async () => {
    render(<OverviewPane version='0.12.26' />);
    emit(activationFrames('observed/capability_activation.default.jsonl'));

    const row = (await screen.findByText('delegate_isolation')).closest('tr');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('declined');
    expect(row!.textContent).toContain('Isolation is NOT being enforced on this platform.');
    // It is a platform fact, not an opt-out: offering a switch would be a lie.
    expect(row!.textContent).toContain('Not a setting');
    expect(row!.textContent).not.toContain('A config key can turn it back on.');
  });

  it('shows a ready capability as active, not as declined', async () => {
    render(<OverviewPane version='0.12.26' />);
    emit(activationFrames('observed/capability_activation.default.jsonl'));

    const row = (await screen.findByText('cooldown_tracker')).closest('tr');
    expect(row!.textContent).toContain('active');
    expect(row!.textContent).not.toContain('declined');
    expect(row!.textContent).toContain('The engine stated no reason.');
  });

  it('shows smart_handoff reaching ready once the engine is started with the gate on', async () => {
    // The capture the Memory pane's toggle is justified by. If this ever stops
    // showing `ready`, the switch on that pane is lying to the user.
    render(<OverviewPane version='0.12.26' />);
    emit(activationFrames('observed/capability_activation.smart-enabled.jsonl'));

    const row = (await screen.findByText('smart_handoff')).closest('tr');
    expect(row!.textContent).toContain('active');
    expect(row!.textContent).toContain('ready');
  });

  it('does not blend two engine processes into one readout', async () => {
    render(<OverviewPane version='0.12.26' />);
    emit(activationFrames('observed/capability_activation.default.jsonl'), 'conv-old');
    await screen.findByTestId('engine-capabilities-table');

    emit(
      [
        {
          type: 'capability_activation',
          data: { capability: 'mid_flight_monitor', stage: 'ready', reason: null, health: 'ok', remedy: 'unknown' },
          msg_id: '',
        },
      ],
      'conv-new'
    );

    const table = await screen.findByTestId('engine-capabilities-table');
    await waitFor(() => expect(within(table).getAllByRole('row').length - 1).toBe(1));
    expect(within(table).queryByText('delegate_isolation')).toBeNull();
  });

  it('ignores a frame whose grade is missing instead of rendering an empty row', async () => {
    render(<OverviewPane version='0.12.26' />);
    emit([{ type: 'capability_activation', data: { capability: 'ghost', stage: 'ready' }, msg_id: '' }]);

    await waitFor(() => expect(screen.getByTestId('engine-capabilities-empty')).toBeTruthy());
    expect(screen.queryByText('ghost')).toBeNull();
  });
});

// --- Runtime: diagnostics readout --------------------------------------------

describe('Runtime - diagnostics readout', () => {
  it('says nothing has been reported rather than showing an empty snapshot', async () => {
    render(<RuntimePane />);
    // Awaited so the pane's own config reads settle before the assertion.
    expect(await screen.findByTestId('diagnostics-empty')).toBeTruthy();
    expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull();
  });

  /**
   * The pane must be able to ORIGINATE the round-trip. Before this, nothing in
   * the app called `sendGetRuntimeDiagnostics`, so the whole section below was
   * unreachable and its own empty state admitted it ("this build has no way to
   * ask yet"). Remove the button or its `ask` wiring and this goes red.
   */
  it('asks the engine when the control is pressed', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    engineBridge.diagnostics.value = {
      engines: 1,
      sent: [{ conversationId: CONVERSATION, requestId: 'rd-x' }],
      refused: [],
    };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));

    await waitFor(() => expect(engineBridge.diagnosticsCalls.value).toBe(1));
    expect(await screen.findByTestId('diagnostics-pending')).toBeTruthy();
  });

  /**
   * THE WAY OUT OF "waiting for its answer".
   *
   * There is no timeout in `useRuntimeDiagnostics` and that is deliberate - this
   * layer cannot honour one honestly - so the control is the only escape. It
   * used to carry `loading` for `pending` as well as `asking`, and Arco's
   * `loading` blocks the handler: MEASURED, five further clicks after one
   * reported-sent request produced zero additional invocations and the pane
   * stayed on `diagnostics-pending` until the rail tab was switched, which no
   * copy suggests. Put `phase === 'pending'` back into `loading` and this goes
   * red at 1 call instead of 2.
   */
  it('can be asked again while an answer is still owed', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    engineBridge.diagnostics.value = {
      engines: 1,
      sent: [{ conversationId: CONVERSATION, requestId: 'rd-1' }],
      refused: [],
    };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));
    await screen.findByTestId('diagnostics-pending');
    expect(engineBridge.diagnosticsCalls.value).toBe(1);

    engineBridge.diagnostics.value = {
      engines: 1,
      sent: [{ conversationId: CONVERSATION, requestId: 'rd-2' }],
      refused: [],
    };
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    await waitFor(() => expect(engineBridge.diagnosticsCalls.value).toBe(2));
  });

  it('says there is no engine to ask rather than spinning', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    engineBridge.diagnostics.value = { engines: 0, sent: [], refused: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));

    const block = await screen.findByTestId('diagnostics-no-engine');
    expect(block.textContent).toContain('No Darhai Core chat is open');
    expect(screen.queryByTestId('diagnostics-pending')).toBeNull();
  });

  it('reports the engine’s own refusal to accept the request', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    engineBridge.diagnostics.value = {
      engines: 1,
      sent: [],
      refused: [{ conversationId: CONVERSATION, reason: 'the engine graded runtime_diagnostics_v1 "shape_only"' }],
    };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));

    const block = await screen.findByTestId('diagnostics-not-sent');
    expect(block.textContent).toContain('shape_only');
    expect(screen.queryByTestId('diagnostics-pending')).toBeNull();
  });

  it('ignores a snapshot answering a request this pane never made', async () => {
    // Another surface's round-trip, or another engine's. The pane cannot say
    // which process it describes, so it must not display it as its own.
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');
    emit([diagnosticsFrame()]);

    await waitFor(() => expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull());
    expect(screen.getByTestId('diagnostics-empty')).toBeTruthy();
  });

  it('ignores an answer from a different engine than the one it asked', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    const frame = diagnosticsFrame();
    const requestId = (frame.data as { requestId: string }).requestId;
    engineBridge.diagnostics.value = { engines: 2, sent: [{ conversationId: CONVERSATION, requestId }], refused: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));
    await screen.findByTestId('diagnostics-pending');

    emit([frame], 'some-other-conversation');

    await waitFor(() => expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull());
    expect(screen.getByTestId('diagnostics-pending')).toBeTruthy();
  });

  it('names which engine answered when several chats are open', async () => {
    render(<RuntimePane />);
    await screen.findByTestId('diagnostics-empty');

    const frame = diagnosticsFrame();
    const requestId = (frame.data as { requestId: string }).requestId;
    engineBridge.diagnostics.value = { engines: 3, sent: [{ conversationId: CONVERSATION, requestId }], refused: [] };
    fireEvent.click(screen.getByRole('button', { name: 'Ask the engine' }));
    await screen.findByTestId('diagnostics-pending');
    emit([frame]);

    await screen.findByTestId('diagnostics-snapshot');
    const source = screen.getByTestId('diagnostics-source');
    expect(source.textContent).toContain(CONVERSATION);
    expect(source.textContent).toContain('3 Darhai Core chats are open');
  });

  it('renders the process binding the engine reported', async () => {
    render(<RuntimePane />);
    await askThenAnswer(diagnosticsFrame());

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('standard');
    expect(snapshot.textContent).toContain('bound_profile');
    expect(snapshot.textContent).toContain('temporary');
    // The fixture's profile is named `desktop`; the pair is what the next test
    // proves disappears together.
    expect(snapshot.textContent).toContain('profile desktop');
  });

  it('omits the profile entirely when the engine named none', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        delete (snapshot.process as Record<string, unknown>).profile_name;
        // The fixture's server is `desktop-tools`; clearing it leaves the word
        // "desktop" traceable to the profile alone.
        snapshot.mcp_servers = [];
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    // The label must vanish with the value - a bare "profile" reads as "none".
    expect(snapshot.textContent).toContain('profile binding');
    expect(snapshot.textContent).not.toContain('desktop');
  });

  it('shows the config-source chain with the path the engine reported', async () => {
    render(<RuntimePane />);
    await askThenAnswer(diagnosticsFrame());

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('$CONFIG/wayland-core/config.toml');
    expect(snapshot.textContent).toContain('loaded');
    expect(snapshot.textContent).toContain('global');
  });

  it('says a config source has no path rather than printing an empty cell', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        delete ((snapshot.config_sources as Record<string, unknown>[])[0] as Record<string, unknown>).display_path;
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('not reported');
    expect(snapshot.textContent).not.toContain('$CONFIG/wayland-core/config.toml');
  });

  it('names the environment overrides the engine refused', async () => {
    render(<RuntimePane />);
    await askThenAnswer(diagnosticsFrame());

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('WAYLAND_CONFIG_PATH');
    expect(snapshot.textContent).toContain('ignored');
    expect(snapshot.textContent).not.toContain('honoured every environment variable');
  });

  it('states plainly when nothing was ignored', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        snapshot.unsupported_overrides = [];
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('honoured every environment variable it was given');
  });

  it('reports a healthy MCP server with its resolved executable', async () => {
    render(<RuntimePane />);
    await askThenAnswer(diagnosticsFrame());

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('desktop-tools');
    expect(snapshot.textContent).toContain('Executable found');
    expect(snapshot.textContent).toContain('Open the active config file');
    expect(snapshot.textContent).not.toContain('Executable not found');
  });

  it('turns a broken MCP server into words the user can act on', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        const server = (snapshot.mcp_servers as Record<string, unknown>[])[0];
        server.connection = 'failed';
        server.exposure = 'hidden_no_tools';
        server.executable_readiness = 'not_found';
        server.remediation = ['install_executable'];
        server.failure = 'missing_executable';
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('Executable not found');
    expect(snapshot.textContent).toContain('Install the missing program');
    expect(snapshot.textContent).toContain('missing_executable');
    // Counter-check: the healthy wording must be gone, so the label is proven to
    // follow the data rather than being printed unconditionally.
    expect(snapshot.textContent).not.toContain('Open the active config file');
  });

  it('names the rows it could not read instead of dropping them', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        (snapshot.mcp_servers as Record<string, unknown>[]).push({
          name: 'quantum',
          origin: 'global_config',
          transport: 'stdio',
          connection: 'entangled',
          exposure: 'exposed',
          deferred: false,
          tool_count: 0,
          resources_declared: false,
          resources_exposed: false,
          assistant_scoped: false,
          executable_readiness: 'resolved',
          working_directory: 'project_root',
          remediation: [],
        });
      })
    );

    const unreadable = await screen.findByTestId('diagnostics-unreadable');
    expect(unreadable.textContent).toContain('quantum');
    expect(unreadable.textContent).toContain('mcp_servers[1]');
    // The VALUE, not just its length. `offending` is the engine's own text,
    // kept out of the log and put in the frame precisely so it can be shown -
    // `entangled` is the token that identifies an engine upgrade, and
    // "9 characters" identifies nothing.
    expect(unreadable.textContent).toContain('entangled');
  });

  /**
   * The card printed "Restart the session to load its resources" and
   * "Check which assistant this server is scoped to" while withholding the
   * three fields that ARE those conditions. Drop any of them from the card and
   * this goes red.
   */
  it('shows the facts that justify the remediation hints it prints', async () => {
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        const server = (snapshot.mcp_servers as Record<string, unknown>[])[0];
        server.connection = 'configured';
        server.exposure = 'resource_only_unavailable';
        server.deferred = true;
        server.tool_count = 0;
        server.resources_declared = true;
        server.resources_exposed = false;
        server.assistant_scoped = true;
        server.working_directory = 'profile_home';
        server.remediation = ['restart_to_load_resources', 'check_assistant_scope'];
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).toContain('Restart the session to load its resources');
    expect(snapshot.textContent).toContain('Check which assistant this server is scoped to');

    const flags = within(snapshot).getByTestId('mcp-server-flags');
    expect(flags.textContent).toContain('start deferred until first use');
    expect(flags.textContent).toContain('resources declared but NOT exposed yet');
    expect(flags.textContent).toContain('scoped to one assistant');
    expect(snapshot.textContent).toContain('profile_home');
  });

  it('does not claim resources are held back when the server declares none', async () => {
    // Counter-check for the test above: the flags must follow the data rather
    // than being printed unconditionally.
    render(<RuntimePane />);
    await askThenAnswer(
      diagnosticsFrame((snapshot) => {
        const server = (snapshot.mcp_servers as Record<string, unknown>[])[0];
        server.deferred = false;
        server.resources_declared = false;
        server.resources_exposed = false;
        server.assistant_scoped = false;
      })
    );

    const snapshot = await screen.findByTestId('diagnostics-snapshot');
    expect(snapshot.textContent).not.toContain('resources declared');
    expect(snapshot.textContent).not.toContain('scoped to one assistant');
    expect(within(snapshot).queryByTestId('mcp-server-flags')).toBeNull();
  });

  /**
   * Nothing in the main-process decoder makes `name` distinct, and the handler
   * itself anticipates repeats. A `key={server.name}` reconciled two real
   * servers into one row - on a readout whose entire point is that a missing
   * row must never read as "not configured".
   */
  it('keeps two servers that share a name as two rows', async () => {
    // The collision is asserted on the CONSOLE, not just on the row count.
    // React renders both children on a first paint even with duplicate keys and
    // only complains - it is the next reconciliation that merges them - so a
    // count-only assertion passes against the very key this test exists to
    // forbid. (Measured: with `key={server.name}` restored, the row count stays
    // 2 and only this console assertion goes red.)
    const keyErrors: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      keyErrors.push(args.map((a) => String(a)).join(' '));
    });
    try {
      render(<RuntimePane />);
      await askThenAnswer(
        diagnosticsFrame((snapshot) => {
          const servers = snapshot.mcp_servers as Record<string, unknown>[];
          const twin = JSON.parse(JSON.stringify(servers[0])) as Record<string, unknown>;
          twin.origin = 'global_config';
          twin.connection = 'failed';
          twin.executable_readiness = 'not_found';
          twin.remediation = ['install_executable'];
          servers.push(twin);
          // Two config sources that share a precedence integer, likewise.
          const sources = snapshot.config_sources as Record<string, unknown>[];
          const sameOrder = JSON.parse(JSON.stringify(sources[0])) as Record<string, unknown>;
          sameOrder.display_path = '$PROJECT/.wayland-core/config.toml';
          sources.push(sameOrder);
        })
      );

      const snapshot = await screen.findByTestId('diagnostics-snapshot');
      expect(within(snapshot).getAllByText('desktop-tools')).toHaveLength(2);
      expect(snapshot.textContent).toContain('Executable not found');
      expect(snapshot.textContent).toContain('$PROJECT/.wayland-core/config.toml');
      expect(screen.queryByTestId('diagnostics-unreadable')).toBeNull();
      expect(keyErrors.filter((line) => line.includes('same key'))).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports a refusal as a refusal, never as an empty snapshot', async () => {
    render(<RuntimePane />);
    await askThenAnswer(unavailableFrame());

    const block = await screen.findByTestId('diagnostics-unavailable');
    expect(block.textContent).toContain('does not serve the diagnostics version');
    expect(block.textContent).toContain('this engine serves v1');
    expect(screen.queryByTestId('diagnostics-snapshot')).toBeNull();
    expect(screen.queryByTestId('diagnostics-empty')).toBeNull();
  });
});

// --- Memory: smart compaction -------------------------------------------------

describe('Memory - smart compaction', () => {
  it('shows the engine default (off) and gates the dependent switch', async () => {
    render(<MemoryPane />);

    const panel = await screen.findByTestId('smart-compaction');
    const smart = within(panel).getByLabelText('Smart compaction');
    const handoff = within(panel).getByLabelText('Hand compacted context to memory');
    expect(smart.getAttribute('aria-checked')).toBe('false');
    expect(handoff.getAttribute('aria-disabled')).toBe('true');
    expect(panel.textContent).toContain('Does nothing until smart compaction is on.');
  });

  it('writes smart_enabled into the engine’s [compact] section', async () => {
    render(<MemoryPane />);

    const panel = await screen.findByTestId('smart-compaction');
    fireEvent.click(within(panel).getByLabelText('Smart compaction'));

    await waitFor(() => expect(setSectionCalls.length).toBeGreaterThan(0));
    expect(setSectionCalls.at(-1)).toEqual({ section: 'compact', value: { smart_enabled: true } });
  });

  it('ungates the handoff switch once smart compaction is on', async () => {
    sectionValues.value = { compact: { smart_enabled: true } };
    render(<MemoryPane />);

    const panel = await screen.findByTestId('smart-compaction');
    await waitFor(() =>
      expect(within(panel).getByLabelText('Hand compacted context to memory').getAttribute('aria-disabled')).toBe(
        'false'
      )
    );
    expect(panel.textContent).toContain('written to long-term memory');
  });

  it('keeps the rest of [compact] when one flag is toggled', async () => {
    sectionValues.value = { compact: { smart_enabled: true, smart_cooldown_turns: 4 } };
    render(<MemoryPane />);

    const panel = await screen.findByTestId('smart-compaction');
    await waitFor(() =>
      expect(within(panel).getByLabelText('Hand compacted context to memory').getAttribute('aria-disabled')).toBe(
        'false'
      )
    );
    fireEvent.click(within(panel).getByLabelText('Hand compacted context to memory'));

    await waitFor(() => expect(setSectionCalls.length).toBeGreaterThan(0));
    expect(setSectionCalls.at(-1)!.value).toEqual({
      smart_enabled: true,
      smart_cooldown_turns: 4,
      smart_handoff_to_memory: true,
    });
  });
});

// --- MCP library: what the engine actually withdrew ---------------------------

describe('MCP library - engine withdrawal', () => {
  const SERVER = { id: 'srv-1', name: 'desktop-tools', source: 'custom', enabled: true, status: 'connected' };

  /** Press Remove on the row, then answer the confirmation it must open. */
  async function confirmRemove(): Promise<void> {
    fireEvent.click(await screen.findByTestId(`row-remove-${SERVER.id}`));
    const options = confirmOptions.value.at(-1);
    expect(options, 'Remove must ask for confirmation before withdrawing anything').toBeDefined();
    await act(async () => {
      await options!.onOk?.();
    });
  }

  it('shows nothing until a withdrawal has been asked for', () => {
    render(<InstalledPage />);
    expect(screen.queryByTestId('engine-withdrawals')).toBeNull();
  });

  /**
   * The request half. `handleRemove` used to call `handleDeleteMcpServer` and
   * stop there - the library entry vanished while a running engine went on
   * serving the tools, and the page told every user to restart their chats.
   * Remove the `withdrawMcpServer` call and this goes red.
   */
  it('asks the running engines to drop the server, not just the config files', async () => {
    mcpServers.value = [SERVER];
    engineBridge.withdrawal.value = {
      engines: 1,
      sent: [{ conversationId: CONVERSATION, requestId: 'mcp-rm-x' }],
      refused: [],
    };
    render(<InstalledPage />);
    await confirmRemove();

    await waitFor(() => expect(engineBridge.withdrawCalls.value).toEqual([{ name: 'desktop-tools' }]));
    const notice = await screen.findByTestId('engine-withdrawals');
    expect(notice.textContent).toContain('Waiting for its answer');
    expect(notice.textContent).toContain(CONVERSATION);
  });

  it('names the tools the engine actually withdrew', async () => {
    mcpServers.value = [SERVER];
    const frame = removalFrame();
    const requestId = (frame.data as { requestId: string }).requestId;
    engineBridge.withdrawal.value = { engines: 1, sent: [{ conversationId: CONVERSATION, requestId }], refused: [] };

    render(<InstalledPage />);
    await confirmRemove();
    await waitFor(() => expect(engineBridge.withdrawCalls.value.length).toBe(1));
    emit([frame]);

    const notice = await screen.findByTestId('engine-withdrawals');
    await waitFor(() => expect(notice.textContent).toContain('2 tools withdrawn'));
    expect(notice.textContent).toContain('desktop-tools');
    expect(notice.textContent).toContain('fetch, search');
    // `outcome` has no enum in the contract - shown verbatim, not judged.
    expect(notice.textContent).toContain('removed');
  });

  it('claims nothing when the engine answered about a different server', async () => {
    mcpServers.value = [SERVER];
    const frame = removalFrame('some-other-server');
    const requestId = (frame.data as { requestId: string }).requestId;
    engineBridge.withdrawal.value = { engines: 1, sent: [{ conversationId: CONVERSATION, requestId }], refused: [] };

    render(<InstalledPage />);
    await confirmRemove();
    await waitFor(() => expect(engineBridge.withdrawCalls.value.length).toBe(1));
    emit([frame]);

    const notice = await screen.findByTestId('engine-withdrawals');
    await waitFor(() => expect(notice.textContent).toContain('Nothing is claimed about either'));
    expect(notice.textContent).toContain('some-other-server');
    expect(notice.textContent).toContain('desktop-tools');
    expect(notice.textContent).not.toContain('tools withdrawn from the running engine');
  });

  it('says which chat could not be asked instead of claiming it was', async () => {
    mcpServers.value = [SERVER];
    engineBridge.withdrawal.value = {
      engines: 1,
      sent: [],
      refused: [{ conversationId: CONVERSATION, reason: 'the engine cannot be reached, so the request was not sent' }],
    };

    render(<InstalledPage />);
    await confirmRemove();

    const notice = await screen.findByTestId('engine-withdrawals');
    await waitFor(() => expect(notice.textContent).toContain('could not be asked to drop it'));
    expect(notice.textContent).toContain('cannot be reached');
  });

  it('ignores a removal result answering a request this page never made', async () => {
    render(<InstalledPage />);
    emit([removalFrame()]);
    await waitFor(() => expect(screen.queryByTestId('engine-withdrawals')).toBeNull());
  });

  /**
   * The other half of the correlation, which had no test.
   *
   * `InstalledPage` matches a reply on BOTH the request id and the conversation
   * it was sent to; deleting the conversation half left all 40 tests in this
   * file green, while the identical rule in `useRuntimeDiagnostics` has a named
   * test ("ignores an answer from a different engine than the one it asked")
   * that goes red under the same mutation. Asymmetric coverage of one rule is
   * an invitation to delete the weaker half as redundant - so both halves are
   * now pinned. Delete `if (conversationId !== msg.conversation_id) return;`
   * and this goes red.
   */
  it('ignores a removal result from a different engine than the one it asked', async () => {
    mcpServers.value = [SERVER];
    const frame = removalFrame();
    const requestId = (frame.data as { requestId: string }).requestId;
    engineBridge.withdrawal.value = { engines: 2, sent: [{ conversationId: CONVERSATION, requestId }], refused: [] };

    render(<InstalledPage />);
    await confirmRemove();
    await waitFor(() => expect(engineBridge.withdrawCalls.value.length).toBe(1));

    // Same correlation id, WRONG engine. Each open chat holds its own copy of
    // the tools, so crediting this answer to the chat that was asked would
    // report tools pulled from a session that never dropped them.
    emit([frame], 'some-other-conversation');

    const notice = await screen.findByTestId('engine-withdrawals');
    await waitFor(() => expect(notice.textContent).toContain('Waiting for its answer'));
    expect(notice.textContent).not.toContain('tools withdrawn from the running engine');
  });
});
