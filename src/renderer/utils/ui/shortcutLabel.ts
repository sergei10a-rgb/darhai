/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform-native keyboard shortcut labels.
 *
 * Shortcut hints were hardcoded with macOS glyphs (`⌘K`, `⌘N`, `⌘↵`), so a
 * Windows user saw the Command symbol - which sits where the ⊞ Windows key is
 * on a PC keyboard. A user reported pressing ⊞ Win (not Ctrl) and concluding
 * the shortcuts were broken: the label taught the wrong key. The handlers
 * themselves accept `metaKey || ctrlKey`, so only the LABEL was wrong.
 *
 * Each platform gets its own convention, not a translation of the other:
 *   macOS   - glyphs, no separator: `⌘K`, `⌘⇧P`, `⌘↵`
 *   Windows - words joined by `+`:  `Ctrl+K`, `Ctrl+Shift+P`, `Ctrl+Enter`
 *   Linux   - same as Windows.
 *
 * These are UI chrome, NOT translatable strings: `Ctrl` and `⌘` are the names
 * physically printed on the key, identical in every locale, so they stay out
 * of the i18n bundles (the surrounding words are still translated).
 */

import { isMacOS } from '@/renderer/utils/platform';

/** A key in a shortcut: a modifier token, or a literal key name. */
export type ShortcutToken = 'mod' | 'alt' | 'shift' | 'ctrl' | 'enter' | 'esc' | 'tab' | (string & {});

const MAC_LABELS: Record<string, string> = {
  mod: '⌘',
  alt: '⌥',
  shift: '⇧',
  ctrl: '⌃',
  enter: '↵',
  esc: '⎋',
  tab: '⇥',
};

const PC_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  ctrl: 'Ctrl',
  enter: 'Enter',
  esc: 'Esc',
  tab: 'Tab',
};

/** The label for a single token on the current platform. */
export const shortcutKeyLabel = (token: ShortcutToken, mac = isMacOS()): string => {
  const table = mac ? MAC_LABELS : PC_LABELS;
  return table[token.toLowerCase()] ?? token;
};

/**
 * A full shortcut label in the current platform's convention.
 *
 * `formatShortcut(['mod', 'K'])` -> `⌘K` on macOS, `Ctrl+K` elsewhere.
 * The `mac` parameter is a test seam; production callers omit it.
 */
export const formatShortcut = (tokens: ShortcutToken[], mac = isMacOS()): string =>
  tokens.map((token) => shortcutKeyLabel(token, mac)).join(mac ? '' : '+');
