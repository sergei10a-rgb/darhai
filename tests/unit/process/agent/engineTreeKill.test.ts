/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two engines that ignored being told to stop.
 *
 * Both the wcore engine and the OpenClaw gateway are long-lived processes that
 * spawn their own trees (MCP servers, tool subprocesses). Both were stopped
 * with a bare `child.kill('SIGTERM')`. On Windows that signal is emulated: it
 * never reaches the tree, so `node` and engine children were left running after
 * the app closed, holding files inside the install directory - which is what
 * made the next update or uninstall fail to replace them.
 *
 * The fix routes both through `killChild`, the cross-platform tree kill
 * (`taskkill /T /F` on Windows, SIGTERM -> SIGKILL descendant sweep on POSIX)
 * already used for the ACP agents.
 *
 * Two properties are tested here, and both were broken:
 *  - the kill reaches the *tree*, not just the process we hold; and
 *  - the caller can *wait* for it, since a quit that returns before the tree is
 *    gone has not actually cleaned anything up.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const killChild = vi.fn(async () => {});

vi.mock('@process/agent/acp/utils', () => ({
  killChild: (...args: unknown[]) => killChild(...(args as [])),
  isProcessAlive: () => true,
}));

import { WCoreAgent } from '@process/agent/wcore';
import { OpenClawGatewayManager } from '@process/agent/openclaw/OpenClawGatewayManager';
import { trackedAgentChildCount, registerAgentChild, resetAgentChildRegistry } from '@process/agent/childRegistry';

function fakeChild(pid = 4242) {
  const proc = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  Object.assign(proc, { pid, exitCode: null, signalCode: null, killed: false, kill: vi.fn() });
  return proc;
}

/**
 * Both classes keep the handle private, and the behaviour under test is what
 * `kill()`/`stop()` do with that handle - not how it got there. Injecting it
 * directly keeps these tests on the teardown path instead of dragging in the
 * whole spawn stack (binary resolution, env building, profile paths).
 */
function injectChild(target: object, field: string, child: ChildProcess): void {
  (target as unknown as Record<string, unknown>)[field] = child;
}

beforeEach(() => {
  resetAgentChildRegistry();
  killChild.mockClear();
  killChild.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('WCoreAgent.kill', () => {
  const makeAgent = () =>
    new WCoreAgent({
      workspace: '/tmp/ws',
      model: { id: 'p', name: 'p', platform: 'openai', baseUrl: '', apiKey: '', useModel: 'm' } as never,
      onStreamEvent: () => {},
    });

  it('tree-kills the engine instead of signalling only the process we hold', async () => {
    const agent = makeAgent();
    const child = fakeChild();
    injectChild(agent, 'childProcess', child);

    await agent.kill();

    expect(killChild).toHaveBeenCalledWith(child, false, 'WCoreAgent');
    // The bare signal is the bug: on Windows it never reaches the engine's
    // own children.
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not resolve until the tree kill has finished', async () => {
    const agent = makeAgent();
    injectChild(agent, 'childProcess', fakeChild());

    let released!: () => void;
    killChild.mockImplementation(() => new Promise<void>((resolve) => (released = resolve)));

    let settled = false;
    const killed = agent.kill().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false); // still killing

    released();
    await killed;
    expect(settled).toBe(true);
  });

  it('is a no-op when there is no engine running', async () => {
    await makeAgent().kill();
    expect(killChild).not.toHaveBeenCalled();
  });

  it('does not tree-kill the same pid twice when kill is called again', async () => {
    // The heartbeat watchdog and the quit sequence can both call this.
    const agent = makeAgent();
    injectChild(agent, 'childProcess', fakeChild());

    await agent.kill();
    await agent.kill();

    expect(killChild).toHaveBeenCalledTimes(1);
  });

  it('stops tracking the engine it just killed, so the quit sweep skips it', async () => {
    const agent = makeAgent();
    const child = fakeChild(3131);
    registerAgentChild(child, { label: 'wcore' });
    injectChild(agent, 'childProcess', child);
    expect(trackedAgentChildCount()).toBe(1);

    await agent.kill();

    expect(trackedAgentChildCount()).toBe(0);
  });
});

describe('OpenClawGatewayManager.stop', () => {
  it('tree-kills the gateway instead of signalling only the process we hold', async () => {
    const manager = new OpenClawGatewayManager({});
    const child = fakeChild(5151);
    injectChild(manager, 'process', child);

    await manager.stop();

    expect(killChild).toHaveBeenCalledWith(child, false, 'OpenClawGatewayManager');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('resolves even when the gateway never emits exit', async () => {
    // The old implementation awaited an `exit` event with no bound on it, so a
    // process that never emitted one left stop() pending forever - and the quit
    // sequence awaiting it wedged.
    const manager = new OpenClawGatewayManager({});
    injectChild(manager, 'process', fakeChild(5252));

    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('is a no-op when no gateway is running', async () => {
    await new OpenClawGatewayManager({}).stop();
    expect(killChild).not.toHaveBeenCalled();
  });

  it('does not tree-kill the same pid twice on concurrent stops', async () => {
    const manager = new OpenClawGatewayManager({});
    injectChild(manager, 'process', fakeChild(5353));

    await Promise.all([manager.stop(), manager.stop()]);

    expect(killChild).toHaveBeenCalledTimes(1);
  });
});
