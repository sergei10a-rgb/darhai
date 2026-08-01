#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type-check `tests/` against a SHRINKING allowlist.
 *
 * The root `tsconfig.json` only includes `src/**`, so nothing under `tests/`
 * has ever been type-checked - real type errors have hidden there (for example
 * `tests/unit/team-TeammateManager.test.ts` passes a `taskManager` property
 * that `TeammateManagerParams` does not declare). Turning the whole directory
 * on at once is not landable: it reports 1300+ errors, the large majority of
 * them `noImplicitAny` inference noise on `.catch(() => ...)` callbacks, which
 * exists only because this repo is not `strict`.
 *
 * So the gate is per-file and one-way:
 *   - every file already failing today is recorded in the allowlist;
 *   - any file NOT on that list must type-check clean, so new and newly-touched
 *     tests are covered from now on;
 *   - a file on the list that becomes clean is reported so the entry can be
 *     deleted - the list can only shrink.
 *
 * Usage:
 *   node scripts/typecheck-tests.mjs            # check
 *   node scripts/typecheck-tests.mjs --update   # rewrite the allowlist
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'tests', 'typecheckAllowlist.json');
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** `path/to/file.ts(12,34): error TS1234: message` */
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error TS\d+:/;

function runTsc() {
  try {
    execFileSync(process.execPath, [TSC, '-p', 'tsconfig.test.json', '--noEmit', '--pretty', 'false'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return '';
  } catch (err) {
    // tsc exits non-zero when it finds errors; the report is on stdout.
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

function collectFailingFiles(output) {
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const file = match[1].replace(/\\/g, '/');
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

const output = runTsc();
const failing = collectFailingFiles(output);
const totalErrors = [...failing.values()].reduce((sum, n) => sum + n, 0);

if (process.argv.includes('--update')) {
  const payload = {
    note: 'Files under tests/ that do not yet type-check. This list may only shrink - see scripts/typecheck-tests.mjs.',
    generatedErrorCount: totalErrors,
    files: [...failing.keys()].sort(),
  };
  fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${payload.files.length} files (${totalErrors} errors) to ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}`
  );
  process.exit(0);
}

if (!fs.existsSync(ALLOWLIST_PATH)) {
  console.error(`Missing ${ALLOWLIST_PATH}. Run: node scripts/typecheck-tests.mjs --update`);
  process.exit(1);
}

const allowlist = new Set(JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).files);
const regressions = [...failing.keys()].filter((file) => !allowlist.has(file)).sort();
const nowClean = [...allowlist].filter((file) => !failing.has(file)).sort();

console.log(`tests/ type-check: ${totalErrors} errors across ${failing.size} files (allowlisted: ${allowlist.size}).`);

if (nowClean.length > 0) {
  console.log(`\n${nowClean.length} allowlisted file(s) now type-check clean - remove them from the allowlist:`);
  for (const file of nowClean) console.log(`  - ${file}`);
}

if (regressions.length > 0) {
  console.error(`\n${regressions.length} file(s) outside the allowlist have type errors:`);
  for (const file of regressions) {
    console.error(`  - ${file} (${failing.get(file)} error(s))`);
    for (const line of output.split(/\r?\n/)) {
      if (line.replace(/\\/g, '/').startsWith(`${file}(`)) console.error(`      ${line.trim()}`);
    }
  }
  console.error('\nFix them, or - if the file is genuinely new legacy - run with --update and justify the growth.');
  process.exit(1);
}

process.exit(0);
