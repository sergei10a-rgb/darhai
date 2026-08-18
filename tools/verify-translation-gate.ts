/**
 * Counter-check for the bilingual pairing gate: prove the gate actually catches
 * every class of drift, so a green `verify-translation-pairing` is meaningful
 * and not just an empty test that passes on everything.
 *
 * This is the parity-gate discipline applied to docs: the real
 * `scripts/verify-translation-pairing.ts` CLI is run against a throwaway
 * repository (via the DARHAI_PAIRING_ROOT seam) whose pairs are deliberately
 * broken in each way the gate is supposed to reject. If any deliberate break
 * fails to turn the gate red, THIS script exits non-zero — an unbroken gate is
 * a broken gate.
 *
 * Nothing here touches the real `docs/` tree. Run with:
 *   bun run docs:i18n:gate-selfcheck
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitBlobHash } from '../scripts/translation-pairing.ts';

const VERIFY_SCRIPT = resolve(__dirname, '..', 'scripts', 'verify-translation-pairing.ts');
const REFRESH_SCRIPT = resolve(__dirname, '..', 'scripts', 'refresh-translation-pairing.ts');

const MN_BASELINE = `# Гарчиг

[English](gate-sample.en.md) | Монгол

Нэг мөр энгийн текст.

## Дэд гарчиг

- нэг зүйл
- хоёр зүйл
`;

const EN_BASELINE = `# Title

English | [Монгол](gate-sample.md)

One line of plain text.

## Subheading

- item one
- item two
`;

const failures: string[] = [];

/** Run a pairing script against the throwaway repo root and capture its result. */
function run(script: string, root: string, args: string[] = []): { code: number; out: string } {
  const result = spawnSync('bunx', ['tsx', script, ...args], {
    env: { ...process.env, DARHAI_PAIRING_ROOT: root },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Write the manifest for the single sample pair, computed from the files on disk. */
function writeManifest(root: string, enContent: string, mnContent: string): void {
  const manifest = {
    pairs: [
      {
        en: 'docs/gate-sample.en.md',
        mn: 'docs/gate-sample.md',
        enHash: gitBlobHash(Buffer.from(enContent, 'utf8')),
        mnHash: gitBlobHash(Buffer.from(mnContent, 'utf8')),
      },
    ],
  };
  writeFileSync(join(root, 'docs', 'i18n', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Restore all three files (both sides + manifest) to a consistent baseline. */
function resetBaseline(root: string): void {
  writeFileSync(join(root, 'docs', 'gate-sample.md'), MN_BASELINE);
  writeFileSync(join(root, 'docs', 'gate-sample.en.md'), EN_BASELINE);
  writeManifest(root, EN_BASELINE, MN_BASELINE);
}

/** Assert a gate run had the expected exit code and message; record failures. */
function expect(name: string, got: { code: number; out: string }, wantCode: number, wantSubstring: string): void {
  const codeOk = got.code === wantCode;
  const msgOk = got.out.includes(wantSubstring);
  if (codeOk && msgOk) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures.push(name);
  console.log(
    `  FAIL  ${name}: expected exit ${wantCode} containing ${JSON.stringify(wantSubstring)}, got exit ${got.code}`
  );
  console.log(`        output: ${got.out.trim().split('\n').join(' | ')}`);
}

const workspace = mkdtempSync(join(tmpdir(), 'darhai-pairing-gate-'));
try {
  mkdirSync(join(workspace, 'docs', 'i18n'), { recursive: true });
  resetBaseline(workspace);

  console.log('translation-gate self-check:');

  // 0. Baseline: a consistent pair must pass. If this fails, every red below is meaningless.
  expect('baseline pair passes', run(VERIFY_SCRIPT, workspace), 0, 'all consistent');

  // 1. Missing counterpart: delete the mn side.
  rmSync(join(workspace, 'docs', 'gate-sample.md'));
  expect('missing counterpart is rejected', run(VERIFY_SCRIPT, workspace), 1, 'incomplete pair');
  resetBaseline(workspace);

  // 2. Hash drift: edit mn body without re-recording the manifest.
  writeFileSync(join(workspace, 'docs', 'gate-sample.md'), `${MN_BASELINE}\nНэмэлт мөр.\n`);
  expect('unrecorded edit is rejected (hash gate)', run(VERIFY_SCRIPT, workspace), 1, 'out of sync');
  resetBaseline(workspace);

  // 3. Structural drift: add a heading to en, then re-record hashes so the check
  //    passes the hash gate and must reach the structural comparison.
  const enExtraHeading = `${EN_BASELINE}\n### Extra heading\n\nmore.\n`;
  writeFileSync(join(workspace, 'docs', 'gate-sample.en.md'), enExtraHeading);
  writeManifest(workspace, enExtraHeading, MN_BASELINE);
  expect('structural drift is rejected (heading count)', run(VERIFY_SCRIPT, workspace), 1, 'heading depth');
  resetBaseline(workspace);

  // 4. Missing switcher: rewrite en without its language switcher, re-record hashes.
  const enNoSwitcher = EN_BASELINE.replace('English | [Монгол](gate-sample.md)\n\n', '');
  writeFileSync(join(workspace, 'docs', 'gate-sample.en.md'), enNoSwitcher);
  writeManifest(workspace, enNoSwitcher, MN_BASELINE);
  expect('missing switcher is rejected', run(VERIFY_SCRIPT, workspace), 1, 'language switcher');
  resetBaseline(workspace);

  // 5. Refresh round-trip: after refresh --all the re-recorded pair is green again,
  //    proving the deliberate act of confirmation actually clears the gate.
  const enEdited = EN_BASELINE.replace('One line of plain text.', 'One edited line of plain text.');
  writeFileSync(join(workspace, 'docs', 'gate-sample.en.md'), enEdited);
  expect('edit before refresh is red', run(VERIFY_SCRIPT, workspace), 1, 'out of sync');
  run(REFRESH_SCRIPT, workspace, ['--all']);
  expect('refresh --all clears the gate', run(VERIFY_SCRIPT, workspace), 0, 'all consistent');
  resetBaseline(workspace);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(
    `\ntranslation-gate self-check FAILED: the gate did not catch ${failures.length} deliberate break(s): ${failures.join(', ')}`
  );
  console.error('An unbroken gate is a broken gate — fix verify-translation-pairing before trusting a green run.');
  process.exit(1);
}
console.log('\ntranslation-gate self-check passed: every deliberate break was rejected, and refresh clears the gate.');
process.exit(0);
