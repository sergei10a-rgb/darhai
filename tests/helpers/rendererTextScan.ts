/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AST scan for user-facing English text rendered outside `t()`.
 *
 * `scripts/check-i18n.js` validates keys that ARE passed to `t()`; nothing
 * validated the text that never reached `t()` at all. That is how the MCP
 * Library installed list shipped `{server.toolCount ?? 0} tools` - English, and
 * wrong in English at count 1.
 *
 * The scan parses each renderer `.tsx` with the TypeScript parser rather than
 * matching source with a regex: a regex cannot tell a JSX text node from a
 * `}` closing a destructuring pattern, and the false positives would have to be
 * suppressed with an ignore list large enough to hide the real ones.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** One piece of English text the renderer paints without going through i18n. */
export type TextFinding = {
  /** Repo-relative POSIX path, so findings read the same on every platform. */
  file: string;
  line: number;
  /** The literal text, whitespace-collapsed. */
  text: string;
  /**
   * `count-label` - a JSX text node whose immediately preceding sibling is an
   * interpolated expression, i.e. the `{n} tools` shape. These are the ones
   * that are wrong in English too, because one frozen suffix cannot serve both
   * counts.
   *
   * `text` - any other English JSX text node.
   */
  kind: 'count-label' | 'text';
};

/**
 * Text that carries no language: punctuation, separators, arrows, digits.
 * A finding needs at least two consecutive Latin letters to be a word at all.
 */
const HAS_LATIN_WORD = /[A-Za-z]{2,}/;

/**
 * Scripts that mean the string is already localised (or is a translation being
 * shipped as a literal, which check-i18n's own key scan covers).
 */
const NON_LATIN_SCRIPT = /[Ѐ-ӿ぀-ヿ㐀-鿿가-힯؀-ۿ฀-๿]/;

/**
 * Tokens that are identifiers or symbols rather than prose: a bare unit, a
 * separator glyph, or a CSS-ish word. Kept deliberately short - anything that
 * needs a long allowlist is a finding, not an exception.
 */
const NOT_PROSE = new Set(['px', 'ms', 'kb', 'mb', 'gb', 'id', 'ok', 'no', 'vs']);

/**
 * HTML entities are markup, not words: `&middot;` renders as `·` and carries no
 * language, but its spelling is Latin letters and would otherwise read as prose.
 */
const HTML_ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;

/**
 * A bare file extension (`.md`, `.json`) is a format name, identical in every
 * language. `{v.mdCount} .md` needs no translation, only the count beside it.
 */
const FILE_EXTENSION = /^\.[a-z0-9]{1,5}$/;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** True when `text` is English prose a user would read. */
export function isEnglishProse(text: string): boolean {
  const trimmed = collapse(text).replace(HTML_ENTITY, ' ');
  if (trimmed.length === 0) return false;
  if (FILE_EXTENSION.test(trimmed)) return false;
  if (NON_LATIN_SCRIPT.test(trimmed)) return false;
  if (!HAS_LATIN_WORD.test(trimmed)) return false;
  const words = trimmed.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  return words.some((w) => !NOT_PROSE.has(w));
}

/** Walk up from `node` looking for an enclosing `t(...)` / `i18n.t(...)` call. */
function insideTranslationCall(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (!ts.isCallExpression(cur)) continue;
    const callee = cur.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (name === 't' || name === 'tt') return true;
  }
  return false;
}

/**
 * A JSX text node counts as a count label when the sibling right before it is
 * an interpolated expression - `{n} tools`, `{files.length} files`. Whitespace
 * between the two is part of the same text node, so the check is on the node's
 * own leading whitespace plus the previous child's kind.
 */
function isCountLabel(node: ts.JsxText): boolean {
  const parent = node.parent;
  if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return false;
  const children = parent.children;
  const index = children.indexOf(node);
  if (index <= 0) return false;
  const previous = children[index - 1];
  if (!ts.isJsxExpression(previous)) return false;
  // `{' '}` and friends are spacing, not a value being labelled.
  const inner = previous.expression;
  if (inner !== undefined && ts.isStringLiteral(inner) && collapse(inner.text) === '') return false;
  // The label must follow on the same line; a text node that starts with a
  // newline is the next line of markup, not a suffix on the value.
  return !/^\s*\n/.test(node.getText());
}

/** Collect every English JSX text node in one `.tsx` source file. */
export function scanSource(relPath: string, source: string): TextFinding[] {
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: TextFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = collapse(node.text);
      if (isEnglishProse(text) && !insideTranslationCall(node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({
          file: relPath,
          line: line + 1,
          text,
          kind: isCountLabel(node) ? 'count-label' : 'text',
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

/** Every `.tsx` under `dir`, as repo-relative POSIX paths. */
export function listRendererTsx(dir: string, repoRoot: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listRendererTsx(full, repoRoot, out);
      continue;
    }
    // Test fixtures render throwaway markup ("body", "rail") that no user sees.
    if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) {
      out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Scan the whole renderer tree. */
export function scanRenderer(repoRoot: string): TextFinding[] {
  const rendererDir = path.join(repoRoot, 'src', 'renderer');
  const findings: TextFinding[] = [];
  for (const rel of listRendererTsx(rendererDir, repoRoot)) {
    findings.push(...scanSource(rel, fs.readFileSync(path.join(repoRoot, rel), 'utf-8')));
  }
  return findings;
}
