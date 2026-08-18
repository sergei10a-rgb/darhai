/**
 * Enforce the bilingual documentation pairing contract for every pair listed in
 * `docs/i18n/manifest.json`. For each pair the gate checks that:
 *
 *   1. Both files exist (a listed pair whose counterpart is missing is a
 *      half-landed translation and goes red).
 *   2. Each side's current git blob hash equals the hash recorded in the
 *      manifest — editing one side without re-recording the pair goes red, so a
 *      PR can never quietly ship a doc whose translation was not brought along.
 *   3. Each side carries a language switcher linking to its counterpart.
 *   4. The structural signatures match: heading depths and order, verbatim code
 *      blocks, table dimensions, and every non-switcher link target.
 *
 * `--list` reports every pair's state and never fails. A bare run checks the
 * whole manifest; naming pairs checks only those. Translation *quality* remains
 * a review responsibility — a green gate means the pair was confirmed
 * consistent at these exact bytes, not that the wording is faithful.
 *
 * See `docs/i18n/README.md` for the owning contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  documentLinksTo,
  gitBlobHash,
  parseTranslationManifest,
  parseTranslationPairingCliArgs,
  structuralSignature,
  structuralSignatureDiff,
  switcherTarget,
  type TranslationPair,
} from './translation-pairing.ts';

// DARHAI_PAIRING_ROOT is an internal test seam used by tools/verify-translation-gate.ts
// to exercise the full CLI against a throwaway repository; production runs resolve
// the real repo root from the script location.
const root = process.env.DARHAI_PAIRING_ROOT ? resolve(process.env.DARHAI_PAIRING_ROOT) : resolve(__dirname, '..');
const MANIFEST_PATH = 'docs/i18n/manifest.json';

let request: ReturnType<typeof parseTranslationPairingCliArgs>;
try {
  request = parseTranslationPairingCliArgs(process.argv.slice(2), 'check');
} catch (error) {
  console.error(`verify-translation-pairing: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const manifestFile = join(root, MANIFEST_PATH);
if (!existsSync(manifestFile)) {
  console.error(`verify-translation-pairing: missing ${MANIFEST_PATH}`);
  process.exit(2);
}

let pairs: TranslationPair[];
try {
  pairs = parseTranslationManifest(readFileSync(manifestFile, 'utf8')).pairs;
} catch (error) {
  console.error(`verify-translation-pairing: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

/** Normalize a CLI anchor (any of a pair's two files) to a set for matching. */
function anchorSet(anchors: string[]): Set<string> {
  return new Set(anchors.map((anchor) => anchor.split('\\').join('/').replace(/^\.\//, '')));
}

const selected = anchorSet(request.anchors);
const scopedPairs =
  selected.size === 0 ? pairs : pairs.filter((pair) => selected.has(pair.en) || selected.has(pair.mn));

if (selected.size > 0) {
  const matched = new Set<string>();
  for (const pair of scopedPairs) {
    if (selected.has(pair.en)) matched.add(pair.en);
    if (selected.has(pair.mn)) matched.add(pair.mn);
  }
  const unmatched = [...selected].filter((anchor) => !matched.has(anchor));
  if (unmatched.length > 0) {
    for (const anchor of unmatched) {
      console.error(`verify-translation-pairing: ${anchor} is not part of any manifest pair (see ${MANIFEST_PATH})`);
    }
    process.exit(2);
  }
}

type PairState = 'ok' | 'out-of-sync' | 'missing';
const state = new Map<string, PairState>();
const errors: string[] = [];

/** Read a repository file, or undefined when absent. */
function readRepoFile(path: string): Buffer | undefined {
  const abs = join(root, path);
  return existsSync(abs) ? readFileSync(abs) : undefined;
}

for (const pair of scopedPairs) {
  const label = `${pair.en} ↔ ${pair.mn}`;
  const enContent = readRepoFile(pair.en);
  const mnContent = readRepoFile(pair.mn);

  const missing: string[] = [];
  if (enContent === undefined) missing.push(pair.en);
  if (mnContent === undefined) missing.push(pair.mn);
  if (missing.length > 0) {
    errors.push(`${label}: incomplete pair — missing ${missing.join(', ')} (a listed pair must ship both sides)`);
    state.set(pair.en, 'missing');
    continue;
  }

  let consistent = true;
  const enHash = gitBlobHash(enContent!);
  const mnHash = gitBlobHash(mnContent!);
  if (enHash !== pair.enHash) {
    errors.push(
      `${pair.en}: out of sync — current blob ${enHash} does not match the manifest's recorded ${pair.enHash} (bring the counterpart along, then re-record with: bun run docs:i18n:refresh ${pair.en})`
    );
    consistent = false;
  }
  if (mnHash !== pair.mnHash) {
    errors.push(
      `${pair.mn}: out of sync — current blob ${mnHash} does not match the manifest's recorded ${pair.mnHash} (bring the counterpart along, then re-record with: bun run docs:i18n:refresh ${pair.en})`
    );
    consistent = false;
  }
  if (!consistent) {
    state.set(pair.en, 'out-of-sync');
    continue;
  }

  const enText = enContent!.toString('utf8');
  const mnText = mnContent!.toString('utf8');

  // Each side must link to its counterpart (the language switcher).
  const enSwitcher = switcherTarget(pair.mn);
  const mnSwitcher = switcherTarget(pair.en);
  if (!documentLinksTo(enText, enSwitcher)) {
    errors.push(`${pair.en}: missing language switcher — no link to counterpart ${enSwitcher}`);
  }
  if (!documentLinksTo(mnText, mnSwitcher)) {
    errors.push(`${pair.mn}: missing language switcher — no link to counterpart ${mnSwitcher}`);
  }

  // Structural signatures must match, excluding each side's switcher link.
  const enSig = structuralSignature(enText, [enSwitcher]);
  const mnSig = structuralSignature(mnText, [mnSwitcher]);
  const divergences = structuralSignatureDiff(enSig, mnSig);
  for (const divergence of divergences) {
    errors.push(`${label}: ${divergence}`);
  }

  state.set(pair.en, divergences.length === 0 ? 'ok' : 'out-of-sync');
}

if (request.mode === 'list') {
  const order: Record<PairState, number> = { 'out-of-sync': 0, missing: 1, ok: 2 };
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]));
  for (const [enPath, status] of rows) {
    console.log(`${status.padEnd(11)} ${enPath}`);
  }
  const counts: Record<PairState, number> = { ok: 0, 'out-of-sync': 0, missing: 0 };
  for (const status of state.values()) counts[status]++;
  console.log(
    `verify-translation-pairing: ${counts.ok} ok, ${counts['out-of-sync']} out-of-sync, ${counts.missing} missing (of ${state.size} manifest pair(s))`
  );
  process.exit(0);
}

if (errors.length === 0) {
  console.log(
    `verify-translation-pairing: ${scopedPairs.length} pair(s) checked, all consistent${
      selected.size > 0 ? ' (scoped; the full-manifest check still runs in CI)' : ''
    }.`
  );
  process.exit(0);
}

console.error('verify-translation-pairing: bilingual pairing rules violated (see docs/i18n/README.md):');
for (const message of errors) console.error(`  ${message}`);
process.exit(1);
