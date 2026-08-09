/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Quitting Darhai must FINISH its cleanup, not merely start it.
 *
 * Electron does not await async `before-quit` handlers - measured on this
 * build, `[Darhai] before-quit` and `[Darhai] will-quit` are ~23ms apart with
 * the process already going away - so every awaited step in the cleanup bundle
 * (SQLite close, cron shutdown, cookbook llama-server teardown, fork workers)
 * was best-effort. Only OmniRoute survived, because it had registered its own
 * synchronous reaper: a fix per subsystem, not a fix of the pattern.
 *
 * Two mechanisms replace that, and each test below targets exactly one:
 *
 *  1. A bounded `will-quit` barrier (`src/process/utils/quitBarrier.ts`), which
 *     cancels the cancellable event, waits for the cleanup, then `app.exit(0)`.
 *     Proven here by an agent process that deliberately outlives its parent:
 *     if the barrier does not hold, `workerTaskManager.clear()` is cut off and
 *     the OS still has that pid after Electron is gone.
 *  2. Synchronous reapers on `process.on('exit')`
 *     (`src/process/utils/quitReapers.ts`), for the paths that emit no
 *     `will-quit` at all - `app.exit(1)` from the crash handler, from the
 *     init-failure path, and `app.exit(0)` driven from outside. Proven here by
 *     the WAL sidecars.
 *
 * ## Why the WAL sidecars are evidence
 * The database runs in WAL mode (`schema.ts`: `journal_mode = WAL`). SQLite
 * deletes `<db>-wal` and `<db>-shm` when the last connection closes cleanly and
 * leaves both behind when the process dies with the handle open. Checking them
 * on the host filesystem AFTER the OS process is gone is the operating system
 * agreeing that the handle was closed - not a log line claiming it.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

/** Written by the barrier once the cleanup it held the quit for has finished. */
const CLEANUP_FINISHED = '[Darhai] quit cleanup finished in';

type DbPaths = { db: string; wal: string; shm: string; logsDir: string };

async function resolvePaths(visual: VisualApp): Promise<DbPaths> {
  const { userData, logsDir } = await visual.app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    logsDir: app.getPath('logs'),
  }));
  // Mirrors getDataPath() in src/process/utils/utils.ts.
  const db = path.join(userData, 'wayland', 'wayland.db');
  return { db, wal: `${db}-wal`, shm: `${db}-shm`, logsDir };
}

/** Resolve once the app's OS process has actually exited. */
function waitForProcessExit(visual: VisualApp, timeoutMs: number): Promise<void> {
  const child = visual.app.process();
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Electron pid ${child.pid} did not exit within ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function readLogs(logsDir: string): string {
  if (!fs.existsSync(logsDir)) return '';
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'))
    .join('\n');
}

/**
 * Tear down an app this spec has ALREADY killed.
 *
 * `closeVisualApp` assumes a live CDP channel: its first move is
 * `app.process()`, which throws `Cannot read properties of undefined` once
 * Playwright's connection to the app is gone - which is precisely the state
 * every test here deliberately leaves it in. Falling back to removing the
 * profile directly keeps a teardown detail from being reported as a failed
 * assertion about quit behaviour.
 */
async function discardApp(visual: VisualApp): Promise<void> {
  try {
    await closeVisualApp(visual);
    return;
  } catch {
    // The app is already gone; only its profile directory is left.
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(visual.runRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** True while the OS still has this pid. Signal 0 only probes; it never kills. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * A minimal ACP agent that deliberately OUTLIVES its parent.
 *
 * The shared `createMockAgentBinary` helper exits on stdin EOF, which the OS
 * delivers for free when Electron dies - so it could never tell "Darhai reaped
 * me" from "my pipe closed". This one keeps a timer alive and ignores EOF,
 * exactly like a real CLI agent that is mid-task, so the only thing that can
 * remove it is Darhai's own teardown. It self-destructs after five minutes so
 * a failing run cannot leak a process.
 */
function writeSurvivingAgent(dir: string, pidFile: string): string {
  const scriptPath = path.join(dir, 'surviving-acp-agent.cjs');
  const script = `'use strict';
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));

// Outlive the parent on purpose - see the spec header.
process.stdin.on('end', () => {});
setInterval(() => {}, 60000);
// Safety net: never leak past the test.
setTimeout(() => process.exit(0), 5 * 60 * 1000);

const SESSION = 'surviving-agent-session';
function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\\n'); } catch (_e) {}
}
function handle(req) {
  const { method, id } = req || {};
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { audio: false, embeddedContext: false, image: false },
        mcpCapabilities: { http: false, sse: false } }, authMethods: [] } });
    return;
  }
  if (method === 'session/new') { send({ jsonrpc: '2.0', id, result: { sessionId: SESSION } }); return; }
  if (method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } } } });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (typeof id !== 'undefined') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + String(method) } });
  }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (_e) {}
  }
});
`;
  fs.writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

test.describe('quit cleanup', () => {
  test('app.exit(), which emits no will-quit at all, still closes the SQLite handle', async () => {
    test.setTimeout(300_000);
    // The crash handler and the init-failure path both call `app.exit(1)`, and
    // the E2E fixture itself closes apps with `app.exit(0)`. None of them emits
    // `before-quit` or `will-quit`, so the quit barrier cannot help here; the
    // synchronous `process.on('exit')` reaper is what makes the close explicit.
    //
    // Measured honesty: on THIS build the sidecars also disappear with that
    // reaper removed, because better-sqlite3's own teardown happens to run on
    // the `app.exit` path too. This test is therefore a property guard on the
    // outcome ("no exit path leaves an open handle behind"), not proof that the
    // reaper is the sole cause of it - the reaper exists so the guarantee does
    // not depend on a native addon's undocumented destructor ordering,
    // especially from the crash handler where process state is already unknown.
    const visual = await launchVisualApp();
    const paths = await resolvePaths(visual);
    try {
      await waitForSettle(visual.page);
      expect(fs.existsSync(paths.db), `no database at ${paths.db}`).toBe(true);
      // Anchor: without a live WAL there is nothing for a clean close to remove
      // and the assertion after the exit would be vacuous.
      expect(fs.existsSync(paths.wal), 'WAL sidecar must exist while the app holds the handle open').toBe(true);

      await visual.app.evaluate(({ app }) => {
        setTimeout(() => app.exit(0), 200);
      });
      await waitForProcessExit(visual, 60_000);

      expect(
        fs.existsSync(paths.wal),
        'wayland.db-wal survived app.exit(0): the SQLite handle was abandoned open'
      ).toBe(false);
      expect(fs.existsSync(paths.shm), 'wayland.db-shm survived app.exit(0)').toBe(false);
    } finally {
      await discardApp(visual);
    }
  });

  test('app.quit() reaps a spawned agent that outlives its parent, and closes the database', async () => {
    test.setTimeout(300_000);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-quit-reap-'));
    const pidFile = path.join(workspace, 'agent.pid');
    const agentScript = writeSurvivingAgent(workspace, pidFile);

    const visual = await launchVisualApp();
    const paths = await resolvePaths(visual);
    let agentPid = 0;
    try {
      await waitForSettle(visual.page);

      const conversation = await invokeBridge<{ id?: string }>(
        visual.page,
        'create-conversation',
        {
          type: 'acp',
          name: 'quit-reap probe',
          model: { id: 'mock', name: 'mock', platform: 'custom', useModel: 'mock' },
          extra: {
            backend: 'custom',
            customAgentId: 'darhai-quit-reap-agent',
            cliPath: `node ${agentScript}`,
            workspace,
            customWorkspace: true,
          },
        },
        60_000
      );
      expect(conversation?.id, `create-conversation returned ${JSON.stringify(conversation)}`).toBeTruthy();

      // Spawns the agent through the real production spawn path.
      await invokeBridge<{ success: boolean; msg?: string }>(
        visual.page,
        'chat.send.message',
        { conversation_id: conversation.id, msg_id: `quit-reap-${Date.now()}`, input: 'stay alive' },
        120_000
      );

      const deadline = Date.now() + 60_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(fs.existsSync(pidFile), 'the agent process never started - nothing to reap').toBe(true);
      agentPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      expect(Number.isInteger(agentPid) && agentPid > 0).toBe(true);
      expect(isAlive(agentPid), `agent pid ${agentPid} was already gone before the quit`).toBe(true);

      // Scheduled inside the app: an awaited quit RPC never resolves, because
      // the channel dies with the app.
      await visual.app.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 200);
      });
      await waitForProcessExit(visual, 60_000);

      expect(
        await waitForPidGone(agentPid, 15_000),
        `agent pid ${agentPid} outlived Darhai: workerTaskManager.clear() was cut off by the quit`
      ).toBe(true);

      // The database, on the same quit.
      expect(fs.existsSync(paths.wal), 'wayland.db-wal survived the quit').toBe(false);
      expect(fs.existsSync(paths.shm), 'wayland.db-shm survived the quit').toBe(false);

      // The barrier's own receipt. A process that had already exited could not
      // have written this line.
      const logs = readLogs(paths.logsDir);
      expect(logs, 'main log has no quit record at all - the check below would be vacuous').toContain(
        '[Darhai] before-quit'
      );
      expect(logs).toContain(CLEANUP_FINISHED);
    } finally {
      if (agentPid && isAlive(agentPid)) {
        // Only ever a pid this test caused to be spawned, and only when the
        // assertion above already reported it as leaked.
        try {
          process.kill(agentPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await discardApp(visual);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
