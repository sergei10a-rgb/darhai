/**
 * Re-record the manifest blob hashes for confirmed-consistent pairs. This is
 * the *deliberate* half of the gate: after editing either side of a pair and
 * bringing the counterpart along, run this to update the recorded hashes so the
 * next `verify` passes. The resulting `docs/i18n/manifest.json` diff is the
 * reviewable act of confirming the two sides say the same thing.
 *
 * It never runs automatically from a test or hook, and it refuses a bulk
 * re-record unless the caller passes `--all`, so drift is never silently
 * blessed. `docs/i18n/README.md` owns the contract.
 *
 * Usage:
 *   bun run docs:i18n:refresh docs/introduction.md   # re-record one pair
 *   bun run docs:i18n:refresh --all                  # re-record every pair
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  gitBlobHash,
  parseTranslationManifest,
  parseTranslationPairingCliArgs,
  renderTranslationManifest,
  type TranslationPair,
} from './translation-pairing.ts';

// DARHAI_PAIRING_ROOT is an internal test seam (see tools/verify-translation-gate.ts);
// production runs resolve the real repo root from the script location.
const root = process.env.DARHAI_PAIRING_ROOT ? resolve(process.env.DARHAI_PAIRING_ROOT) : resolve(__dirname, '..');
const MANIFEST_PATH = 'docs/i18n/manifest.json';

let request: ReturnType<typeof parseTranslationPairingCliArgs>;
try {
  request = parseTranslationPairingCliArgs(process.argv.slice(2), 'write');
} catch (error) {
  console.error(`refresh-translation-pairing: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const manifestFile = join(root, MANIFEST_PATH);
if (!existsSync(manifestFile)) {
  console.error(`refresh-translation-pairing: missing ${MANIFEST_PATH}`);
  process.exit(2);
}

let pairs: TranslationPair[];
try {
  pairs = parseTranslationManifest(readFileSync(manifestFile, 'utf8')).pairs;
} catch (error) {
  console.error(`refresh-translation-pairing: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const selected = new Set(request.anchors.map((anchor) => anchor.split('\\').join('/').replace(/^\.\//, '')));

// Validate every named anchor resolves to a manifest pair before writing anything.
if (selected.size > 0) {
  const known = new Set<string>();
  for (const pair of pairs) {
    known.add(pair.en);
    known.add(pair.mn);
  }
  const unknown = [...selected].filter((anchor) => !known.has(anchor));
  if (unknown.length > 0) {
    for (const anchor of unknown) {
      console.error(`refresh-translation-pairing: ${anchor} is not part of any manifest pair (see ${MANIFEST_PATH})`);
    }
    process.exit(2);
  }
}

let recorded = 0;
const updated: TranslationPair[] = pairs.map((pair) => {
  const inScope = selected.size === 0 || selected.has(pair.en) || selected.has(pair.mn);
  if (!inScope) return pair;

  const enAbs = join(root, pair.en);
  const mnAbs = join(root, pair.mn);
  const missing: string[] = [];
  if (!existsSync(enAbs)) missing.push(pair.en);
  if (!existsSync(mnAbs)) missing.push(pair.mn);
  if (missing.length > 0) {
    console.error(`refresh-translation-pairing: cannot record ${pair.en} ↔ ${pair.mn}: missing ${missing.join(', ')}`);
    process.exit(2);
  }

  const enHash = gitBlobHash(readFileSync(enAbs));
  const mnHash = gitBlobHash(readFileSync(mnAbs));
  if (enHash !== pair.enHash || mnHash !== pair.mnHash) recorded++;
  return { en: pair.en, mn: pair.mn, enHash, mnHash };
});

const rendered = renderTranslationManifest({ pairs: updated });
if (readFileSync(manifestFile, 'utf8') === rendered) {
  console.log('refresh-translation-pairing: manifest already current; nothing to record.');
  process.exit(0);
}

writeFileSync(manifestFile, rendered);
console.log(
  `refresh-translation-pairing: recorded ${recorded} pair(s) into ${MANIFEST_PATH}; run the check to validate.`
);
process.exit(0);
