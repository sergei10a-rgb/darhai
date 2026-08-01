import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Main-process i18n keys must resolve against the bundle the main process
 * actually loads.
 *
 * `src/process/services/i18n/index.ts` registers every locale module under the
 * SINGLE `translation` namespace, so a key written with i18next namespace
 * syntax (`cron:error.x`) resolves against a namespace that does not exist and
 * i18next silently echoes the raw key back. That is how the literal string
 * `error.scheduledTimePassed` ended up persisted as a cron job's `lastError`
 * and rendered in the Scheduled Tasks UI.
 *
 * This scan is the mechanical guard: every literal `i18n.t('...')` key in the
 * main process must be a dotted path that exists in the reference locale.
 */

const PROCESS_DIR = path.resolve(__dirname, '../../src/process');
const EN_LOCALE_DIR = path.resolve(__dirname, '../../src/renderer/services/i18n/locales/en-US');

/**
 * Matches any `.t('<locale-module>.rest')` literal - `i18n.t(...)` as well as
 * the lazy `(await getI18n()).t(...)` form used across the update bridge.
 * Anchoring on the locale module name keeps unrelated `.t()` methods out.
 */
function buildCallRegex(moduleNames: string[]): RegExp {
  return new RegExp(String.raw`\.t\(\s*(['"])((?:${moduleNames.join('|')})[.:][^'"]*)\1`, 'g');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Rebuild the flat module map the main process registers as `translation`. */
function loadReferenceBundle(): Record<string, unknown> {
  const bundle: Record<string, unknown> = {};
  for (const file of fs.readdirSync(EN_LOCALE_DIR)) {
    if (!file.endsWith('.json')) continue;
    bundle[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(EN_LOCALE_DIR, file), 'utf-8'));
  }
  return bundle;
}

/**
 * Resolve a dotted key the way i18next does: try the whole remainder as a flat
 * key at each level first, since locale files legitimately contain flat keys
 * that themselves contain dots (e.g. `"message.badge"`).
 */
function resolves(bundle: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let node: unknown = bundle;
  for (let i = 0; i < parts.length; i++) {
    if (typeof node !== 'object' || node === null) return false;
    const record = node as Record<string, unknown>;
    const rest = parts.slice(i).join('.');
    if (rest in record) return true;
    if (!(parts[i] in record)) return false;
    node = record[parts[i]];
  }
  return typeof node === 'string';
}

describe('main-process i18n keys', () => {
  const bundle = loadReferenceBundle();
  const files = walk(PROCESS_DIR);
  const I18N_T_CALL = buildCallRegex(Object.keys(bundle));

  it('scans a non-trivial number of main-process files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never uses i18next namespace syntax (ns:key) - the main bundle has one namespace', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const match of source.matchAll(I18N_T_CALL)) {
        if (match[2].includes(':')) {
          offenders.push(`${path.relative(PROCESS_DIR, file)} -> ${match[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses only keys that exist in the reference locale', () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const match of source.matchAll(I18N_T_CALL)) {
        const key = match[2];
        // Interpolated / dynamically built keys are out of scope for a static scan.
        if (key.includes('${') || key.includes(':')) continue;
        if (!resolves(bundle, key)) missing.push(`${path.relative(PROCESS_DIR, file)} -> ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
