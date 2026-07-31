/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Locale files must mirror the reference locale's SHAPE, not just its key names.
 *
 * `scripts/check-i18n.js` compares flattened key sets, which cannot see the
 * difference between a nested object and a flat dotted key - both flatten to
 * `a.b.c`. That blind spot shipped a real defect: `mn-MN/settings.json` stored
 *
 *     "assistants": { "libraryHint": { "link": ..., "prefix": ... } }
 *
 * where every other locale stores
 *
 *     "assistants": "Assistants",
 *     "assistants.libraryHint.link": ...
 *
 * The nested form silently destroys the leaf value, so `t('settings.assistants')`
 * returned an object and i18next rendered its English error text into the
 * settings sidebar - visible only to Mongolian users, and green in CI.
 *
 * This test compares the TYPE at every shared key path, so the same class of
 * defect fails immediately instead of reaching a release.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve(__dirname, '..', '..', 'src/renderer/services/i18n/locales');
const REFERENCE_LOCALE = 'en-US';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A key path whose value is an object in one locale and a leaf in another. */
type ShapeMismatch = {
  locale: string;
  file: string;
  keyPath: string;
  reference: 'object' | 'leaf';
  actual: 'object' | 'leaf';
};

function kindOf(value: Json): 'object' | 'leaf' {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? 'object' : 'leaf';
}

function localeDirs(): string[] {
  return fs
    .readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readJson(file: string): Record<string, Json> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, Json>;
  } catch {
    return null;
  }
}

/**
 * Compare shapes at every key path present in BOTH objects.
 *
 * Keys missing on one side are deliberately out of scope: `check-i18n.js`
 * already owns missing/extra keys, and duplicating that here would produce two
 * failures for one cause.
 */
function collectMismatches(
  reference: Record<string, Json>,
  actual: Record<string, Json>,
  locale: string,
  file: string,
  prefix = ''
): ShapeMismatch[] {
  const found: ShapeMismatch[] = [];

  for (const [key, refValue] of Object.entries(reference)) {
    if (!(key in actual)) continue;
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const refKind = kindOf(refValue);
    const actualKind = kindOf(actual[key]);

    if (refKind !== actualKind) {
      found.push({ locale, file, keyPath, reference: refKind, actual: actualKind });
      continue; // Do not descend: the shapes already diverged.
    }
    if (refKind === 'object') {
      found.push(
        ...collectMismatches(
          refValue as Record<string, Json>,
          actual[key] as Record<string, Json>,
          locale,
          file,
          keyPath
        )
      );
    }
  }

  return found;
}

function allMismatches(): ShapeMismatch[] {
  const referenceFiles = fs.readdirSync(path.join(LOCALES_DIR, REFERENCE_LOCALE)).filter((f) => f.endsWith('.json'));

  return localeDirs()
    .filter((locale) => locale !== REFERENCE_LOCALE)
    .flatMap((locale) =>
      referenceFiles.flatMap((file) => {
        const reference = readJson(path.join(LOCALES_DIR, REFERENCE_LOCALE, file));
        const actual = readJson(path.join(LOCALES_DIR, locale, file));
        if (!reference || !actual) return [];
        return collectMismatches(reference, actual, locale, file);
      })
    );
}

describe('locale shape parity', () => {
  it('never nests a key that the reference locale stores as a leaf', () => {
    const mismatches = allMismatches();
    const report = mismatches
      .map(
        (m) => `  ${m.locale}/${m.file} -> "${m.keyPath}" is ${m.actual} here but ${m.reference} in ${REFERENCE_LOCALE}`
      )
      .join('\n');

    expect(
      mismatches,
      `Locale files disagree with ${REFERENCE_LOCALE} about the SHAPE of these keys:\n${report}\n\n` +
        `A key stored as a nested object where the reference stores a string has no leaf value, ` +
        `so t('<key>') returns the object and i18next renders its error text into the UI. ` +
        `Use the flat dotted-key form ("a": "Label", "a.b": "...") that the reference locale uses.`
    ).toEqual([]);
  });

  it('covers every locale and every reference file', () => {
    // Guards the guard: if the locale directory moved or the files stopped
    // parsing, the test above would pass vacuously.
    const locales = localeDirs();
    expect(locales.length, 'no locale directories found - has the path changed?').toBeGreaterThan(5);
    expect(locales).toContain(REFERENCE_LOCALE);
    expect(locales).toContain('mn-MN');

    const referenceFiles = fs.readdirSync(path.join(LOCALES_DIR, REFERENCE_LOCALE)).filter((f) => f.endsWith('.json'));
    expect(referenceFiles.length, 'no reference locale JSON files found').toBeGreaterThan(5);
  });
});
