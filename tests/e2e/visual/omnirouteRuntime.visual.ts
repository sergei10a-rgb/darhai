/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The OmniRoute runtime, proven against the real app and the real OS.
 *
 * Three audit findings meet here, and all three were about Darhai SAYING one
 * thing while the operating system said another:
 *
 *  1. `stop` returned `{state:'stopped'}` in 8ms; four seconds later
 *     `GET /v1/models` still answered 200 and `netstat` still showed
 *     `127.0.0.1:20128 LISTENING`, held by a grandchild process. Every port
 *     assertion below therefore reads `netstat`, not the returned status.
 *  2. `start` reported `runtime: null` because the runtime kind was only ever
 *     set inside `install()`.
 *  3. "The gateway stays opt-in / off unless the user enables it" was refuted:
 *     `start` flipped the persisted master relay switch on a green health check.
 *
 * The relay assertions run everywhere. The start/stop half needs a real global
 * `omniroute` bin and is skipped (not faked) when the machine does not have one.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { launchVisualApp, closeVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

const PORT = 20128;
const GET_CONFIG = 'omniroute-gateway.get-config';
const RUNTIME_STATUS = 'omniroute-gateway.runtime-status';
const START = 'omniroute-gateway.start';
const STOP = 'omniroute-gateway.stop';
const REGISTRY_LIST = 'modelRegistry.list';

type GatewayConfigView = { enabled: boolean; baseUrl: string; hasApiKey: boolean };
type RuntimeStatus = {
  state: string;
  port: number | null;
  runtime: string | null;
  owned: boolean;
  error?: string;
};
type RegistryRow = { providerId: string; state?: string };

let visual: VisualApp;

/**
 * Every LISTENING socket on the OmniRoute port, straight from the OS - the only
 * evidence that counts here, since the whole defect was a status that disagreed
 * with the kernel.
 */
function netstatLines(): string[] {
  const windows = process.platform === 'win32';
  const cmd = windows ? 'netstat' : 'lsof';
  const args = windows ? ['-ano'] : ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'];
  const marker = windows ? 'LISTENING' : 'LISTEN';
  let out: string;
  try {
    out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    // `lsof` exits 1 with no output when nothing matches - that IS "port free".
    // Anything else (missing tool, permissions) must surface, not read as free.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes(`:${PORT}`) && l.toUpperCase().includes(marker));
}

/** True when a global `omniroute` bin exists - the start/stop half needs one. */
function omnirouteInstalled(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['omniroute'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function waitForPortQuiet(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = netstatLines();
    if (lines.length === 0 || Date.now() >= deadline) return lines;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.beforeAll(async () => {
  // A stale listener from an earlier run would make every assertion here
  // meaningless, so refuse to start rather than test against someone else's port.
  expect(netstatLines(), 'port 20128 must be free before this spec runs').toEqual([]);
  visual = await launchVisualApp();
  await waitForSettle(visual.page);
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test('a fresh profile has the external relay OFF and nothing on port 20128', async () => {
  const config = await invokeBridge<GatewayConfigView>(visual.page, GET_CONFIG);
  expect(config.enabled).toBe(false);

  const rows = await invokeBridge<RegistryRow[]>(visual.page, REGISTRY_LIST);
  expect(rows.filter((r) => r.providerId === 'omniroute-gateway')).toEqual([]);

  const status = await invokeBridge<RuntimeStatus>(visual.page, RUNTIME_STATUS);
  expect(status.state).toBe('idle');
  expect(status.owned).toBe(false);
  expect(netstatLines()).toEqual([]);
});

test('start binds the port, stop frees it, and neither turns the relay on', async () => {
  test.skip(!omnirouteInstalled(), 'no global `omniroute` bin on this machine');
  test.setTimeout(180_000);

  expect(netstatLines(), 'before start').toEqual([]);

  const started = await invokeBridge<RuntimeStatus>(visual.page, START, undefined, 120_000);
  expect(started.state).toBe('running');
  expect(started.port).toBe(PORT);
  // Finding 2: a start that skipped install() must still name its runtime.
  expect(started.runtime).not.toBeNull();
  // We spawned it in this session, so we own it and may stop it.
  expect(started.owned).toBe(true);
  expect(netstatLines(), 'after start').not.toEqual([]);

  // Finding 3: a running server is NOT consent. Nothing may have been enabled.
  const afterStart = await invokeBridge<GatewayConfigView>(visual.page, GET_CONFIG);
  expect(afterStart.enabled).toBe(false);
  const rowsAfterStart = await invokeBridge<RegistryRow[]>(visual.page, REGISTRY_LIST);
  expect(rowsAfterStart.filter((r) => r.providerId === 'omniroute-gateway')).toEqual([]);

  // Finding 1: stop must be true at the socket level, not just in the status.
  const stopped = await invokeBridge<RuntimeStatus>(visual.page, STOP, undefined, 60_000);
  expect(stopped.state).toBe('stopped');
  expect(stopped.port).toBeNull();
  expect(await waitForPortQuiet(10_000), 'after stop').toEqual([]);
});

/**
 * Quitting must not leak the server either. Electron does NOT await async
 * `before-quit` handlers - measured 23ms from `before-quit` to `will-quit` -
 * so the awaited stopAll in src/index.ts was cut off and the OmniRoute tree
 * outlived the Electron pid, still LISTENING. Runs last: it ends the app.
 */
test('quitting Darhai leaves nothing listening on port 20128', async () => {
  test.skip(!omnirouteInstalled(), 'no global `omniroute` bin on this machine');
  test.setTimeout(180_000);

  const started = await invokeBridge<RuntimeStatus>(visual.page, START, undefined, 120_000);
  expect(started.state).toBe('running');
  expect(netstatLines(), 'server up, stop deliberately never called').not.toEqual([]);

  // Scheduled inside the app: awaiting a quit RPC never resolves, because the
  // channel dies with the app.
  await visual.app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 200);
  });

  expect(await waitForPortQuiet(30_000), 'after app quit').toEqual([]);
});
