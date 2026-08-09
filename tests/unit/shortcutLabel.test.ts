/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform-native shortcut labels.
 *
 * A Windows user saw `⌘K` and pressed the ⊞ Windows key - which occupies the
 * same physical position as ⌘ on a Mac keyboard - and reported the shortcuts
 * as broken. The handlers accept `metaKey || ctrlKey`, so only the label lied.
 * These tests pin BOTH conventions and the repo-wide absence of new hardcoded
 * Mac glyphs in rendered JSX.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { formatShortcut, shortcutKeyLabel } from '@/renderer/utils/ui/shortcutLabel';

describe('formatShortcut', () => {
  it('uses glyphs with no separator on macOS', () => {
    expect(formatShortcut(['mod', 'K'], true)).toBe('⌘K');
    expect(formatShortcut(['mod', 'shift', 'P'], true)).toBe('⌘⇧P');
    expect(formatShortcut(['mod', 'enter'], true)).toBe('⌘↵');
  });

  it('uses key NAMES joined by + on Windows/Linux', () => {
    expect(formatShortcut(['mod', 'K'], false)).toBe('Ctrl+K');
    expect(formatShortcut(['mod', 'shift', 'P'], false)).toBe('Ctrl+Shift+P');
    expect(formatShortcut(['mod', 'enter'], false)).toBe('Ctrl+Enter');
  });

  it('never shows a Mac glyph on a PC - the bug that misled the user', () => {
    const pc = formatShortcut(['mod', 'alt', 'shift', 'enter'], false);
    for (const glyph of ['⌘', '⌥', '⇧', '⌃', '↵', '⎋', '⇥']) {
      expect(pc).not.toContain(glyph);
    }
    expect(pc).toBe('Ctrl+Alt+Shift+Enter');
  });

  it('Tab reads as Tab on both platforms (⇥ only on macOS)', () => {
    expect(formatShortcut(['tab'], false)).toBe('Tab');
    expect(formatShortcut(['tab'], true)).toBe('⇥');
  });

  it('passes through a literal key it does not know', () => {
    expect(shortcutKeyLabel('F5', false)).toBe('F5');
    expect(formatShortcut(['mod', 'F5'], false)).toBe('Ctrl+F5');
  });

  it('is case-insensitive on modifier tokens', () => {
    expect(formatShortcut(['MOD', 'Enter'], false)).toBe('Ctrl+Enter');
  });
});

/**
 * Guard: the fix is only durable if new code does not reintroduce a hardcoded
 * glyph. Scans rendered JSX (not comments) for Mac modifier symbols.
 */
describe('no hardcoded Mac glyphs in rendered UI', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const MAC_GLYPHS = /[⌘⌥⇧⌃]/;

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'locales') continue;
        walk(full, out);
      } else if (entry.name.endsWith('.tsx')) {
        out.push(full);
      }
    }
    return out;
  };

  /** Strip block comments, line comments and the shortcuts overlay table. */
  const rendered = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');

  it('HomeHintBar renders shortcuts through the helper, not literals', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'src/renderer/pages/guid/components/HomeHintBar.tsx'),
      'utf8'
    );
    expect(rendered(source)).not.toMatch(MAC_GLYPHS);
    expect(source).toContain('formatShortcut');
  });

  it('reports every remaining .tsx file that still hardcodes a Mac glyph', () => {
    const offenders = walk(path.join(repoRoot, 'src/renderer'))
      .filter((file) => MAC_GLYPHS.test(rendered(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(repoRoot, file).replace(/\\/g, '/'));
    // Every known site is converted; a new hardcoded glyph fails here with its
    // own path, so the next author is pointed straight at formatShortcut.
    expect(offenders).toEqual([]);
  });
});
