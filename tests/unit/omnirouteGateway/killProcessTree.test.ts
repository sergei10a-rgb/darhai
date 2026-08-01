/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * REGRESSION, proven against REAL operating-system processes.
 *
 * The audit found Darhai's OmniRoute `stop()` returning `{state:'stopped'}`
 * while `netstat` still showed the port LISTENING, held by
 * `node ...omniroute\dist\server-ws.mjs` (pid P) whose parent
 * `node ...omniroute\bin\omniroute.mjs` was itself a child of an already-dead
 * process. Killing the direct child does not kill its descendants - not on
 * Windows, and not for a server that forks its own worker on POSIX either.
 *
 * These tests build the same shape with plain node: a PARENT that spawns a
 * GRANDCHILD which binds a real TCP port. One test proves the defect
 * (direct-child kill leaves the grandchild listening), the other proves the fix
 * ({@link killProcessTree} takes the whole tree down). They are deliberately
 * paired: the second is only meaningful because the first still reproduces.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { killProcessTree } from '@process/services/omnirouteGateway/killProcessTree';

/** Binds an ephemeral port and reports `<port> <own pid> <parent pid>`. */
const GRANDCHILD_SRC = `
import net from 'node:net';
import fs from 'node:fs';
const out = process.argv[2];
const server = net.createServer((s) => s.end());
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(out, [server.address().port, process.pid, process.ppid].join(' '));
});
setInterval(() => {}, 1000);
`;

/** Spawns the grandchild, then stays alive - the intermediate node process. */
const PARENT_SRC = `
import { spawn } from 'node:child_process';
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`;

const READY_TIMEOUT_MS = 15000;
const DEATH_TIMEOUT_MS = 15000;

let workdir: string | null = null;
const spawned: Array<ChildProcess> = [];
const strayPids: number[] = [];

/** True while the pid exists (signal 0 never delivers, it only probes). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when something accepts a TCP connection on the loopback port. */
function isPortServed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Build the parent→grandchild tree and wait until the grandchild is listening. */
async function spawnTree(): Promise<{ parent: ChildProcess; parentPid: number; grandPid: number; port: number }> {
  workdir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'darhai-killtree-'));
  const grandchildFile = path.join(workdir, `grandchild-${Math.random().toString(16).slice(2)}.mjs`);
  const parentFile = path.join(workdir, `parent-${Math.random().toString(16).slice(2)}.mjs`);
  const outFile = path.join(workdir, `out-${Math.random().toString(16).slice(2)}.txt`);
  fs.writeFileSync(grandchildFile, GRANDCHILD_SRC, 'utf8');
  fs.writeFileSync(parentFile, PARENT_SRC, 'utf8');

  // Reproduce the manager's ACTUAL spawn shape. On Windows that means
  // `shell: true` (needed for the npm/bun `.cmd` shim), so the direct child is
  // `cmd.exe` and the node processes are its descendants - which is exactly why
  // signalling the direct child does nothing to the server. On POSIX the
  // manager spawns detached, giving the tree its own process group.
  const useShell = process.platform === 'win32';
  const parent = useShell
    ? spawn(`"${process.execPath}" "${parentFile}" "${grandchildFile}" "${outFile}"`, [], {
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
      })
    : spawn(process.execPath, [parentFile, grandchildFile, outFile], { stdio: 'ignore', detached: true });
  spawned.push(parent);

  await waitUntil(
    () => fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').split(' ').length === 3,
    READY_TIMEOUT_MS,
    'the deepest child to report its port'
  );
  const [portText, pidText, ppidText] = fs.readFileSync(outFile, 'utf8').trim().split(' ');
  const port = Number(portText);
  const grandPid = Number(pidText);
  // Track the intermediate node too: nothing else knows its pid, and a stray
  // would hold the port for the next test.
  strayPids.push(grandPid, Number(ppidText));
  await waitUntil(() => isPortServed(port), READY_TIMEOUT_MS, 'the deepest child to accept connections');

  const parentPid = parent.pid;
  if (typeof parentPid !== 'number') throw new Error('parent process has no pid');
  return { parent, parentPid, grandPid, port };
}

afterEach(async () => {
  for (const pid of strayPids.splice(0)) {
    if (isAlive(pid)) await killProcessTree(pid, true);
  }
  for (const child of spawned.splice(0)) {
    if (typeof child.pid === 'number' && isAlive(child.pid)) await killProcessTree(child.pid, true);
  }
  if (workdir) {
    fs.rmSync(workdir, { recursive: true, force: true });
    workdir = null;
  }
});

describe('killProcessTree against real processes', () => {
  it('THE DEFECT: killing only the direct child leaves the server holding the port', { timeout: 45000 }, async () => {
    const { parent, parentPid, grandPid, port } = await spawnTree();

    parent.kill(); // exactly what the old stop() did

    await waitUntil(() => !isAlive(parentPid), DEATH_TIMEOUT_MS, 'the direct child to die');
    // Give any cascade a fair chance before claiming the descendant survived.
    await new Promise((r) => setTimeout(r, 2000));
    expect(isAlive(grandPid)).toBe(true);
    expect(await isPortServed(port)).toBe(true);
  });

  it('THE FIX: killProcessTree takes the whole tree down and frees the port', { timeout: 45000 }, async () => {
    const { parentPid, grandPid, port } = await spawnTree();

    const outcome = await killProcessTree(parentPid, true);
    expect(outcome.ok).toBe(true);

    await waitUntil(() => !isAlive(grandPid), DEATH_TIMEOUT_MS, 'the deepest child to die with the tree');
    await waitUntil(async () => !(await isPortServed(port)), DEATH_TIMEOUT_MS, 'the port to be released');
    expect(isAlive(parentPid)).toBe(false);
  });

  it('refuses an invalid pid instead of signalling something arbitrary', async () => {
    for (const pid of [0, -1, Number.NaN]) {
      const outcome = await killProcessTree(pid, true);
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain('invalid pid');
    }
  });
});
