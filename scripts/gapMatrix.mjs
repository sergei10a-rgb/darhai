/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derive `tests/fixtures/engine-contract/gap-matrix.json` from the code.
 *
 * WHY THIS FILE EXISTS. The gap matrix describes itself - in the contract
 * bundle's own README - as "generated: what Darhai implements vs what the
 * contract defines", and the refresh instructions say to "regenerate the gap
 * matrix" after an engine bump. No generator existed. So the file was written
 * once by hand and then rotted: every one of its 34 `gaps` rows still said
 * `implemented: false`, including `continue_with_budget` and
 * `budget_grant_result`, which the same commit that updated
 * `docs/architecture/engine-capabilities/README.md` to "waves 1-4 ✅ landed"
 * had just wired up. Two sources of truth, already disagreeing, on the exact
 * question of which engine verbs Darhai speaks.
 *
 * WHAT "IMPLEMENTED" MEANS HERE, precisely - it is derived, never asserted:
 *
 *   - an EVENT is implemented when some registered capability handler declares
 *     it in `handles`/`emits`, or when the core decoder has a `case` arm for it
 *     in `src/process/agent/wcore/index.ts`. Those two places are exactly the
 *     ones that can act on an event; anything else is a mention.
 *   - a COMMAND is implemented when the engine-facing tree
 *     (`src/process/agent/wcore/`) names it as a string literal in code, with
 *     comments stripped first. A command no code there names is one nothing can
 *     build, whatever a comment says.
 *
 * Both rules read the SHIPPED code, so a capability that is deleted flips its
 * rows back without anybody remembering to. The derivation is deliberately
 * conservative: it looks for construction and dispatch, not for the name
 * appearing somewhere - `ACKNOWLEDGED_UNHANDLED_EVENTS` in `protocol.ts` is a
 * list of names Darhai deliberately does NOT handle, and a looser scan would
 * read that list as evidence of the opposite.
 *
 * The counter-guard is `tests/unit/engineContractGapMatrix.test.ts`: it runs
 * this derivation and fails when the checked-in file disagrees. Regenerate with
 *
 *     node scripts/gapMatrix.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const BUNDLE_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'engine-contract');
export const DESKTOP_DIR = path.join(BUNDLE_DIR, 'desktop', 'v1');
export const MATRIX_PATH = path.join(BUNDLE_DIR, 'gap-matrix.json');

const SRC_DIR = path.join(REPO_ROOT, 'src');
const HANDLERS_DIR = path.join(SRC_DIR, 'process', 'agent', 'wcore', 'capabilities', 'handlers');
const ENGINE_DIR = path.join(SRC_DIR, 'process', 'agent', 'wcore');
const CORE_DECODER = path.join(ENGINE_DIR, 'index.ts');

/** Every `.ts`/`.tsx` file under a directory. */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Quoted strings inside a `handles:` / `emits:` declaration.
 *
 * Follows ONE level of indirection on purpose. Half the handlers declare
 * `handles: ANVIL_EVENT_TYPES` or `handles: [...GOAL_EVENT_TYPES]` rather than
 * an inline array - a literal-only scan silently reported those capabilities as
 * unimplemented, which is the same wrong answer the hand-written matrix gave.
 * Resolving the named array in the same module is enough for every handler that
 * exists; one that reached across modules would show up as a gap row for a
 * capability the wave table calls landed, which is a loud failure, not a quiet one.
 */
function declaredTypes(source, field) {
  const found = new Set();
  const collect = (body) => {
    for (const quoted of body.matchAll(/'([^']+)'/g)) found.add(quoted[1]);
    // `[...IDENT]` spreads a named array beside any literals.
    for (const spread of body.matchAll(/\.\.\.([A-Z][A-Z0-9_]*)/g)) {
      for (const quoted of namedArray(source, spread[1]).matchAll(/'([^']+)'/g)) found.add(quoted[1]);
    }
  };

  // Bracket-scanned rather than regex-matched: an array literal contains the
  // commas and newlines any "value" pattern would have to stop at.
  for (const match of source.matchAll(new RegExp(`(?:^|[\\s{])${field}\\s*:\\s*`, 'g'))) {
    const start = match.index + match[0].length;
    if (source[start] === '[') {
      const end = source.indexOf(']', start);
      if (end > start) collect(source.slice(start, end));
      continue;
    }
    const identifier = /^[A-Z][A-Z0-9_]*/.exec(source.slice(start));
    if (identifier) collect(namedArray(source, identifier[0]));
  }
  return found;
}

/** The literal body of `const NAME = [ ... ]` in this module, or an empty string. */
function namedArray(source, name) {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`);
  return declaration.exec(source)?.[1] ?? '';
}

/** Event types this build can actually act on. */
export function implementedEventTypes() {
  const types = new Set();
  for (const file of walk(HANDLERS_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const type of declaredTypes(source, 'handles')) types.add(type);
    for (const type of declaredTypes(source, 'emits')) types.add(type);
  }
  const decoder = fs.readFileSync(CORE_DECODER, 'utf8');
  for (const arm of decoder.matchAll(/case '([a-z0-9_]+)':/g)) types.add(arm[1]);
  return types;
}

/** Comments removed, so prose about a verb is never read as code that sends it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1 ');
}

/**
 * Command types the engine-facing source names as string literals.
 *
 * MEASURED, and narrower than it looks. A first attempt matched only
 * `type: '<name>'` object properties and reported `goal_cancel` as a gap - it
 * IS built, by `buildControl(registry, contract, input, 'goal_cancel', 'cancel')`,
 * where the verb arrives as an ARGUMENT. Chasing that indirection properly means
 * type-checking, so the rule is instead: the literal appears, in code rather
 * than prose, inside `src/process/agent/wcore/` - the only tree that may speak to
 * the engine. Comments are stripped first, because every one of these verbs is
 * discussed at length in the headers there.
 */
export function implementedCommandTypes() {
  const types = new Set();
  for (const file of walk(ENGINE_DIR)) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    for (const literal of source.matchAll(/'([a-z][a-z0-9_]*)'/g)) types.add(literal[1]);
  }
  return types;
}

/** Adversarial/compat fixture inventory, by directory. */
function fixtureInventory() {
  const root = path.join(DESKTOP_DIR, 'adversarial');
  const inventory = {};
  if (!fs.existsSync(root)) return inventory;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const files = fs
      .readdirSync(path.join(root, entry.name))
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => `adversarial/${entry.name}/${name}`);
    inventory[`adversarial/${entry.name}`] = files;
  }
  return inventory;
}

/**
 * The whole matrix, derived. Rows keep the manifest's own order and fields.
 *
 * The manifest is an argument so a test can hand in a synthetic one carrying a
 * verb no code implements and prove this function can still answer "gap". A
 * partition that has only ever returned "everything is fine" is not evidence
 * that everything is fine.
 */
export function deriveGapMatrix(
  manifest = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'manifest.json'), 'utf8'))
) {
  const events = implementedEventTypes();
  const commands = implementedCommandTypes();

  const rows = [];
  for (const [kind, list] of [
    ['event', manifest.events ?? []],
    ['command', manifest.commands ?? []],
  ]) {
    for (const entry of list) {
      rows.push({
        kind,
        type: entry.type,
        capability: entry.capability,
        criticality: entry.criticality,
        correlation: entry.correlation,
        path: entry.path,
        implemented: kind === 'event' ? events.has(entry.type) : commands.has(entry.type),
      });
    }
  }

  return {
    gaps: rows.filter((row) => !row.implemented),
    implemented: rows.filter((row) => row.implemented),
    fixtures: fixtureInventory(),
  };
}

/** Serialised exactly as the checked-in file is, so a diff is a real diff. */
export function serialiseGapMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 1)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const matrix = deriveGapMatrix();
  const text = serialiseGapMatrix(matrix);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(MATRIX_PATH, text, 'utf8');
    console.log(
      `Wrote ${path.relative(REPO_ROOT, MATRIX_PATH)}: ${matrix.implemented.length} implemented, ${matrix.gaps.length} gaps.`
    );
  } else {
    const current = fs.existsSync(MATRIX_PATH) ? fs.readFileSync(MATRIX_PATH, 'utf8') : '';
    if (current === text) {
      console.log(`${path.relative(REPO_ROOT, MATRIX_PATH)} is current.`);
    } else {
      console.error(`${path.relative(REPO_ROOT, MATRIX_PATH)} is STALE. Run: node scripts/gapMatrix.mjs --write`);
      process.exitCode = 1;
    }
  }
}
