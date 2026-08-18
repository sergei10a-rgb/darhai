/**
 * Pure helpers for the bilingual documentation pairing gate.
 *
 * This is the Darhai (Mongolian-first) port of deepseek-harness's
 * translation-pairing contract. Where the upstream gate binds English/Chinese
 * pairs through per-pair `.i18n.yaml` sidecars, this gate binds English/
 * Mongolian pairs through a single opt-in `docs/i18n/manifest.json`: only the
 * pairs listed there are enforced, so the gate can ship before all 59 docs are
 * translated.
 *
 * Kept free of any filesystem or Git process access so the discovery,
 * hashing, and structural-signature logic can be unit-tested (and
 * mutation-proven) without touching the repository tree. `docs/i18n/README.md`
 * owns the contract these helpers enforce.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** One enforced English/Mongolian document pair. */
export interface TranslationPair {
  /** Repository-relative path of the English side. */
  en: string;
  /** Repository-relative path of the Mongolian side. */
  mn: string;
  /** Git blob hash of the English side at the last confirmed-consistent state. */
  enHash: string;
  /** Git blob hash of the Mongolian side at the last confirmed-consistent state. */
  mnHash: string;
}

/** Validated contents of `docs/i18n/manifest.json`. */
export interface TranslationManifest {
  /** Every enforced pair, in declaration order. */
  pairs: TranslationPair[];
}

/** The 40-hex Git blob hash of file bytes (identical to `git hash-object`). */
export function gitBlobHash(content: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`blob ${content.byteLength}\0`);
  hash.update(content);
  return hash.digest('hex');
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Parse and validate the checked-in manifest. Fails loud on any shape error so
 * a malformed manifest can never silently disable the gate.
 *
 * @param content - Raw manifest JSON text.
 * @returns The validated manifest.
 * @throws Error when the JSON, its fields, or any pair entry is invalid.
 */
export function parseTranslationManifest(content: string): TranslationManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('manifest: expected a JSON object with a "pairs" array');
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((field) => field !== 'pairs');
  if (unsupported.length > 0) {
    throw new Error(`manifest: unsupported field(s): ${unsupported.join(', ')} (only "pairs" is allowed)`);
  }
  if (!Array.isArray(record.pairs)) {
    throw new Error('manifest: "pairs" must be an array');
  }
  const pairs: TranslationPair[] = [];
  const seen = new Set<string>();
  record.pairs.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`manifest: pairs[${index}] must be an object`);
    }
    const pair = entry as Record<string, unknown>;
    const extra = Object.keys(pair).filter((field) => !['en', 'mn', 'enHash', 'mnHash'].includes(field));
    if (extra.length > 0) {
      throw new Error(`manifest: pairs[${index}] has unsupported field(s): ${extra.join(', ')}`);
    }
    const en = pair.en;
    const mn = pair.mn;
    const enHash = pair.enHash;
    const mnHash = pair.mnHash;
    if (typeof en !== 'string' || !en.endsWith('.md') || en.endsWith('.mn.md')) {
      throw new Error(`manifest: pairs[${index}].en must be an English ".md" path (not ".mn.md")`);
    }
    if (typeof mn !== 'string' || !mn.endsWith('.md')) {
      throw new Error(`manifest: pairs[${index}].mn must be a ".md" path`);
    }
    if (en === mn) {
      throw new Error(`manifest: pairs[${index}] en and mn must be different files`);
    }
    if (typeof enHash !== 'string' || !HEX40.test(enHash)) {
      throw new Error(`manifest: pairs[${index}].enHash must be a 40-hex git blob hash`);
    }
    if (typeof mnHash !== 'string' || !HEX40.test(mnHash)) {
      throw new Error(`manifest: pairs[${index}].mnHash must be a 40-hex git blob hash`);
    }
    for (const path of [en, mn]) {
      if (seen.has(path)) {
        throw new Error(`manifest: ${path} appears in more than one pair`);
      }
      seen.add(path);
    }
    pairs.push({ en, mn, enHash, mnHash });
  });
  return { pairs };
}

/**
 * Render the manifest back to canonical, oxfmt-compatible JSON (two-space
 * indent, trailing newline). Used by the refresh tool so a re-record produces
 * a stable, reviewable diff.
 *
 * @param manifest - The manifest to serialize.
 * @returns Canonical JSON text with exactly one trailing newline.
 */
export function renderTranslationManifest(manifest: TranslationManifest): string {
  const body = {
    pairs: manifest.pairs.map((pair) => ({
      en: pair.en,
      mn: pair.mn,
      enHash: pair.enHash,
      mnHash: pair.mnHash,
    })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** The ordered structural fingerprint compared across the two sides of a pair. */
export interface StructuralSignature {
  /** ATX heading depths in document order (## -> 2). */
  headings: number[];
  /** Each fenced code block as `${infoString}\n${verbatimBody}`, in order. */
  code: string[];
  /** Each table as `${rowCount}x${columnCount}`, in order. */
  tables: string[];
  /** Every link/image/autolink target in order, minus the language switcher. */
  links: string[];
}

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_ROW_HINT = /\|/;
const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/g;
const AUTOLINK = /<((?:https?|ftp|mailto):[^>\s]+)>/g;

/** Count the GFM cells in one table row, ignoring leading/trailing pipes. */
function countTableColumns(row: string): number {
  let trimmed = row.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  // Split on unescaped pipes.
  const cells = trimmed.split(/(?<!\\)\|/);
  return cells.length;
}

/** Strip a leading `<` / trailing `>` from a pointy-bracket link destination. */
function normalizeLinkTarget(target: string): string {
  if (target.startsWith('<') && target.endsWith('>')) return target.slice(1, -1);
  return target;
}

/**
 * Extract the structural signature of a Markdown document. Fenced code blocks
 * are located first so their `#`, `|`, and `[](…)` content is never mistaken
 * for headings, tables, or links — code is preserved verbatim across a
 * translation and must not diverge.
 *
 * @param markdown - Full document text.
 * @param switcherTargets - Link targets that are the language switcher to the
 *   counterpart; excluded from `links` because the two sides legitimately point
 *   at different files.
 * @returns The ordered structural signature.
 */
export function structuralSignature(markdown: string, switcherTargets: readonly string[] = []): StructuralSignature {
  const excluded = new Set(switcherTargets);
  const lines = markdown.split('\n');
  const sig: StructuralSignature = { headings: [], code: [], tables: [], links: [] };

  let fence: { indent: number; marker: string } | null = null;
  let codeInfo = '';
  let codeBody: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE_LINE.exec(line);

    if (fence) {
      // Inside a fence: only a matching closing fence ends it.
      if (
        fenceMatch &&
        fenceMatch[2]![0] === fence.marker[0] &&
        fenceMatch[2]!.length >= fence.marker.length &&
        fenceMatch[3]!.trim() === ''
      ) {
        sig.code.push(`${codeInfo}\n${codeBody.join('\n')}`);
        fence = null;
        codeInfo = '';
        codeBody = [];
      } else {
        codeBody.push(line);
      }
      continue;
    }

    if (fenceMatch) {
      fence = { indent: fenceMatch[1]!.length, marker: fenceMatch[2]! };
      codeInfo = fenceMatch[3]!.trim();
      codeBody = [];
      continue;
    }

    const headingMatch = ATX_HEADING.exec(line);
    if (headingMatch) {
      sig.headings.push(headingMatch[1]!.length);
    }

    // GFM table: a pipe-bearing header row immediately followed by a delimiter row.
    if (TABLE_ROW_HINT.test(line) && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1] ?? '')) {
      const columns = countTableColumns(line);
      let rows = 1; // header
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_HINT.test(lines[j] ?? '') && (lines[j] ?? '').trim() !== '') {
        rows++;
        j++;
      }
      sig.tables.push(`${rows}x${columns}`);
    }

    for (const match of line.matchAll(INLINE_LINK)) {
      const target = normalizeLinkTarget(match[1]!);
      if (!excluded.has(target)) sig.links.push(target);
    }
    for (const match of line.matchAll(AUTOLINK)) {
      if (!excluded.has(match[1]!)) sig.links.push(match[1]!);
    }
  }

  return sig;
}

/** Render a signature value for an error message, truncated for readability. */
function show(value: string | number | undefined): string {
  if (value === undefined) return 'nothing';
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Diff two structural signatures, returning the first divergence per field.
 *
 * @param en - Signature of the English side.
 * @param mn - Signature of the Mongolian side.
 * @returns Human-readable divergences; empty means the structures match.
 */
export function structuralSignatureDiff(en: StructuralSignature, mn: StructuralSignature): string[] {
  const out: string[] = [];
  // Headings, code, and tables are compared by value AND order: heading depths
  // mirror the counterpart, and code blocks are byte-identical because code is
  // not translated.
  const fields: [string, (string | number)[], (string | number)[]][] = [
    ['heading depth', en.headings, mn.headings],
    ['code block (verbatim)', en.code, mn.code],
    ['table (rows x columns)', en.tables, mn.tables],
  ];
  for (const [name, enValues, mnValues] of fields) {
    if (enValues.length !== mnValues.length) {
      out.push(`${name} count differs: en has ${enValues.length}, mn has ${mnValues.length}`);
      continue;
    }
    for (let i = 0; i < enValues.length; i++) {
      if (enValues[i] !== mnValues[i]) {
        out.push(`${name} #${i + 1} diverges: ${show(enValues[i])} (en) vs ${show(mnValues[i])} (mn)`);
        break;
      }
    }
  }
  // Links are compared by COUNT only, not target: a cross-doc link legitimately
  // points at a different locale on each side (e.g. mn `introduction.md` links
  // to `README.md` while en `introduction.en.md` links to `README.en.md`). The
  // switcher link is already excluded from both signatures.
  if (en.links.length !== mn.links.length) {
    out.push(`link count differs: en has ${en.links.length}, mn has ${mn.links.length}`);
  }
  return out;
}

/**
 * Whether a Markdown tree links to any accepted target. Used to require that
 * each side of a pair carries a language switcher to its counterpart.
 *
 * @param markdown - Full document text.
 * @param target - The counterpart's basename to look for.
 * @returns True when a link/image/autolink points at the target.
 */
export function documentLinksTo(markdown: string, target: string): boolean {
  for (const match of markdown.matchAll(INLINE_LINK)) {
    if (normalizeLinkTarget(match[1]!) === target) return true;
  }
  for (const match of markdown.matchAll(AUTOLINK)) {
    if (match[1] === target) return true;
  }
  return false;
}

/** The counterpart basename used both as switcher target and switcher requirement. */
export function switcherTarget(counterpart: string): string {
  return basename(counterpart);
}

/** A parsed CLI invocation shared by the verify and refresh entrypoints. */
export interface TranslationPairingCliRequest {
  mode: 'check' | 'list' | 'write';
  /** English anchor paths named on the command line; empty means the whole manifest. */
  anchors: string[];
}

/**
 * Parse `verify` / `refresh` CLI arguments. `--list` reports state and takes no
 * paths; `--write` requires explicit pairs or `--all`, so a bulk re-record is
 * always a deliberate choice that never blesses unconfirmed drift.
 *
 * @param argv - Arguments after the script name.
 * @param defaultMode - `check` for the verify entry, `write` for refresh.
 * @returns The validated request.
 * @throws Error when flags or their combination are invalid.
 */
export function parseTranslationPairingCliArgs(
  argv: string[],
  defaultMode: 'check' | 'write'
): TranslationPairingCliRequest {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const anchors = [...new Set(argv.filter((arg) => !arg.startsWith('--')))].sort();
  const unknown = flags.filter((flag) => !['--list', '--write', '--all'].includes(flag));
  if (unknown.length > 0) throw new Error(`unknown flag(s): ${unknown.join(', ')}`);
  const listMode = flags.includes('--list');
  const writeMode = flags.includes('--write') || defaultMode === 'write';
  const allMode = flags.includes('--all');

  if (listMode) {
    if (writeMode && defaultMode === 'write') {
      throw new Error('--list is a read-only report and cannot be used with the refresh (write) tool');
    }
    if (allMode || anchors.length > 0) {
      throw new Error('--list reports the whole manifest and takes no other flags or paths');
    }
    return { mode: 'list', anchors: [] };
  }

  if (writeMode) {
    if (allMode && anchors.length > 0) {
      throw new Error('--write takes either pair paths or --all, not both');
    }
    if (!allMode && anchors.length === 0) {
      throw new Error(
        '--write requires the pair(s) you confirmed (any file of a pair), or --all to re-record every manifest pair; recording pairs you did not review blesses unconfirmed content'
      );
    }
    return { mode: 'write', anchors };
  }

  if (allMode) throw new Error('--all only applies to --write');
  return { mode: 'check', anchors };
}
