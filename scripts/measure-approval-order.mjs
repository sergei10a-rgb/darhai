/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measure which approval signal the engine emits FIRST.
 *
 * Darhai has two approval surfaces and gives the call to whichever claims the
 * call id first: `tool_request` -> the inline in-transcript gate,
 * `approval_required` -> the modal. Which one the user actually sees therefore
 * depends on arrival order, and that is an engine property - not something to
 * assume. Run this against the bundled binary instead of guessing.
 *
 * MEASURED 2026-08-10, bundled wayland-core, win32-x64, via OpenRouter:
 *
 *   Bash  (not in config allow_list)  5 runs: tool_request first, gap 0.0-0.3ms
 *   Write (not in config allow_list)  3 runs: tool_request first, gap 0.1-0.3ms
 *   Read  (IS in config allow_list)   3 runs: NEITHER signal - the engine goes
 *                                     straight to tool_running/tool_result
 *
 * So the two signals are emitted as a PAIR, in a fixed order, effectively at
 * the same instant - and a tool that needs no approval emits neither. In the
 * app that means the inline gate always claims first and the modal is the
 * fallback for an arrival order that does not currently occur. No user-facing
 * setting is needed to make the surface predictable; it already is.
 *
 * Re-run after any engine upgrade:
 *
 *   node scripts/measure-approval-order.mjs <path-to-wayland-core> [runs] [--model <id>]
 *   PROBE_PROMPT="Read the file note.txt ..." node scripts/measure-approval-order.mjs ...
 *
 * Credentials come from the engine's own config.toml / keyring - this script
 * never reads or prints a key.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Resolved against the CWD the user typed it in: each run spawns inside a fresh
// temp workspace, where a relative path would be ENOENT.
const BINARY = process.argv[2] ? resolve(process.argv[2]) : undefined;
const RUNS = Number(process.argv[3] ?? 5);
/** Extra engine flags (e.g. `--model google/gemini-2.5-flash`). */
const EXTRA_ARGS = process.argv.slice(4);
const PROMPT =
  process.env.PROBE_PROMPT ??
  'Run the shell command `echo darhai-probe` and report its exact output. Use the shell tool.';
const RUN_TIMEOUT_MS = 90_000;
/** The engine rejects session ids that are not 6-40 hex chars (hyphens ok). */
const sessionIdFor = (index) => (Date.now().toString(16) + index.toString(16)).slice(-16);

if (!BINARY) {
  console.error('usage: node scripts/measure-approval-order.mjs <wayland-core> [runs] [engine flags...]');
  process.exit(2);
}

/** One run: every frame of interest, timestamped from spawn. */
function runOnce(index) {
  return new Promise((resolve) => {
    const workspace = mkdtempSync(join(tmpdir(), `approval-probe-${index}-`));
    writeFileSync(join(workspace, 'note.txt'), 'probe\n');

    const started = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - started) / 1e6;

    const child = spawn(BINARY, ['--json-stream', '--session-id', sessionIdFor(index), ...EXTRA_ARGS], {
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const frames = [];
    const allTypes = [];
    let buf = '';
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve({ index, reason, frames, allTypes });
    };

    const timer = setTimeout(() => finish('timeout'), RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const type = ev.type;
        allTypes.push(type);

        if (type === 'tool_request' || type === 'approval_required') {
          frames.push({ t: +ms().toFixed(1), type, callId: ev.call_id ?? ev.callId ?? '?' });
          // Both signals for one call id answers the question - stop early.
          const seen = new Map();
          for (const f of frames) {
            if (f.type !== 'tool_request' && f.type !== 'approval_required') continue;
            const set = seen.get(f.callId) ?? new Set();
            set.add(f.type);
            seen.set(f.callId, set);
          }
          for (const set of seen.values()) if (set.size === 2) return finish('both-seen');
        }
        if (type === 'error') {
          frames.push({ t: +ms().toFixed(1), type: 'error', detail: JSON.stringify(ev).slice(0, 400) });
        }
        // A turn that ends without either signal is itself a result: the tool
        // was allow-listed and never gated.
        if (type === 'turn_end' || type === 'stream_end') {
          frames.push({ t: +ms().toFixed(1), type });
          return finish(type);
        }
      }
    });

    child.on('error', (err) => {
      frames.push({ t: +ms().toFixed(1), type: 'spawn-error', detail: String(err) });
      finish('spawn-error');
    });
    child.on('exit', (code) => finish(`exit:${code}`));

    // Let the engine reach `ready` before the first message.
    setTimeout(() => {
      child.stdin.write(JSON.stringify({ type: 'message', msg_id: `probe-${index}`, content: PROMPT }) + '\n');
    }, 2500);
  });
}

const results = [];
for (let i = 1; i <= RUNS; i++) {
  const r = await runOnce(i);
  results.push(r);
  const gated = r.frames.filter((f) => f.type === 'tool_request' || f.type === 'approval_required');
  console.log(
    `run ${i} [${r.reason}] ${gated.map((f) => `${f.type}@${f.t}ms`).join(' -> ') || '(no approval signals)'}`
  );
  console.log('        events:', JSON.stringify(allTypeTally(r.allTypes)));
  for (const f of r.frames.filter((f) => f.detail)) console.log(`        ${f.type}: ${f.detail}`);
}

function allTypeTally(types) {
  return types.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
}

console.log('\n=== SUMMARY ===');
const firsts = [];
for (const r of results) {
  const byCall = new Map();
  for (const f of r.frames) {
    if (f.type !== 'tool_request' && f.type !== 'approval_required') continue;
    if (!byCall.has(f.callId)) byCall.set(f.callId, []);
    byCall.get(f.callId).push(f);
  }
  if (byCall.size === 0) {
    console.log(`run ${r.index}: no gated call (tool ran without approval)`);
    firsts.push('none');
    continue;
  }
  for (const [callId, fs] of byCall) {
    if (fs.length < 2) {
      console.log(`run ${r.index} call ${callId.slice(0, 12)}: ONLY ${fs[0].type}`);
      firsts.push(`only:${fs[0].type}`);
      continue;
    }
    console.log(
      `run ${r.index} call ${callId.slice(0, 12)}: ${fs[0].type} first, gap ${(fs[1].t - fs[0].t).toFixed(1)}ms`
    );
    firsts.push(fs[0].type);
  }
}
console.log('tally:', JSON.stringify(allTypeTally(firsts)));
