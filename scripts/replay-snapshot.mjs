/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keyless wcore-session replay snapshot gate — backup channel.
 *
 * The PRIMARY channel is `bun run test`: the check-mode gate
 * (`tests/unit/wcoreSessionReplaySnapshot.test.ts`) runs there automatically and
 * fails CI on any decoder drift. This wrapper mechanizes the two DELIBERATE
 * operations that must never happen inside a normal test run:
 *
 *   node scripts/replay-snapshot.mjs check    keyless CI gate (compare only)
 *   node scripts/replay-snapshot.mjs record   rewrite goldens from the decode
 *   node scripts/replay-snapshot.mjs verify    prove the gate FAILS on a broken
 *                                              golden, then restore it (the
 *                                              parity-standard counter-check)
 *
 * `record` is keyless too — the input frames are already captured under
 * `tests/fixtures/engine-contract/desktop/v1/observed/`; recording only
 * re-derives the normalized golden from them. Review every golden diff before
 * committing.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const TEST_FILE = 'tests/unit/wcoreSessionReplaySnapshot.test.ts';
const GOLDEN = join('tests/snapshot/wcoreReplay/golden/provider-retry-turn.json');

/** Run vitest once; return its exit code. */
function runVitest(env) {
  const result = spawnSync('bunx', ['vitest', 'run', TEST_FILE], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

function check() {
  process.exit(runVitest({ DARHAI_SNAPSHOT: 'check' }));
}

function record() {
  process.exit(runVitest({ DARHAI_SNAPSHOT: 'record' }));
}

/**
 * Break a golden, assert the gate goes red, restore it. A gate that stays green
 * on a corrupted golden is worthless; this proves it does not.
 */
function verify() {
  if (!existsSync(GOLDEN)) {
    console.error(`[verify] golden missing: ${GOLDEN}\n[verify] run "record" first.`);
    process.exit(1);
  }
  const backup = `${GOLDEN}.verifybak`;
  copyFileSync(GOLDEN, backup);
  let ok = false;
  try {
    const original = readFileSync(GOLDEN, 'utf-8');
    // Flip a semantic value so the normalized transcript no longer matches.
    const corrupted = original.replace('"type": "start"', '"type": "STARTED"');
    if (corrupted === original) {
      console.error('[verify] could not corrupt golden — its shape changed; update the token.');
      process.exit(1);
    }
    writeFileSync(GOLDEN, corrupted, 'utf-8');

    console.log('[verify] running gate against a deliberately-broken golden (expect FAIL)…');
    const code = runVitest({ DARHAI_SNAPSHOT: 'check' });
    if (code === 0) {
      console.error('[verify] GATE IS BROKEN: it passed against a corrupted golden.');
    } else {
      console.log('[verify] OK: the gate caught the corruption (non-zero exit).');
      ok = true;
    }
  } finally {
    copyFileSync(backup, GOLDEN);
    unlinkSync(backup);
  }
  process.exit(ok ? 0 : 1);
}

const cmd = process.argv[2] ?? 'check';
switch (cmd) {
  case 'check':
    check();
    break;
  case 'record':
    record();
    break;
  case 'verify':
    verify();
    break;
  default:
    console.error(`unknown command "${cmd}". Use: check | record | verify`);
    process.exit(1);
}
