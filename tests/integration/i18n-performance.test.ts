/**
 * i18n performance tests
 * Verifies lazy-loading and modular locale performance behavior
 *
 * These budgets are in BYTES, not milliseconds, and that is deliberate.
 *
 * The four load tests below used to assert `performance.now()` deltas against
 * fixed millisecond budgets. Those assertions measured the host, not the
 * product: a full `vitest run` puts 24 forks on 24 cores, so the same
 * `readFile` + `JSON.parse` that takes 4 ms on an idle machine was measured at
 * 85 ms, 203 ms, 605 ms and 3939 ms on a loaded one. The suite reported the
 * scheduler as an i18n regression, at random, in whichever run lost the draw.
 *
 * Wall-clock here was only ever a proxy. Reading and parsing a locale is
 * O(bytes) with no I/O concurrency and no network, so the one property that
 * actually decides whether a locale loads fast is how large it is. Asserting
 * the bytes tests the same regression the millisecond budget was aiming at
 * (someone drops a huge blob into a locale module) and is invariant under
 * machine load, so it cannot go red because another fork was busy.
 *
 * The reads and `JSON.parse` calls are unchanged - a missing or malformed
 * locale still fails these tests exactly as before.
 *
 * Every cap is checked against EVERY shipped locale, not a sample. A size guard
 * that reads only en-US is blind to exactly the file that breaches first: the
 * locales are not the same size, and this fork's own rule is that mn-MN carries
 * complete Mongolian Cyrillic, which costs ~1.6x the bytes of the English it
 * translates. Measured 2026-08-15 over the 37 modules x 13 locales:
 *
 *   per locale, total bytes
 *     mn-MN 477,237 | uk-UA 412,597 | ru-RU 412,557 | ja-JP 356,976
 *     fr-FR 336,215 | ko-KR 330,232 | de-DE 327,951 | es-ES 326,992
 *     pt-BR 321,729 | tr-TR 320,906 | en-US 297,581 | zh-TW 295,834
 *     zh-CN 294,588                       -> 640 KiB cap, 1.37x over mn-MN
 *
 *   per module, all 481 files fall into two clearly separated populations
 *     ordinary modules  max mn-MN/conversation  30,616 -> 64 KiB cap  (2.14x)
 *     `settings`        152,964 .. 254,671 (mn-MN)    -> 320 KiB cap  (1.29x)
 *   Nothing measured lies between 30,616 and 152,964, so the 64 KiB line sits
 *   in an empty band: `settings` is the one aggregate module, and any other
 *   module crossing 64 KiB is the blob these tests exist to catch.
 */

import * as fs from 'fs';
import * as path from 'path';
import i18nConfig from '../../src/common/config/i18n-config.json';

const LOCALES_DIR = path.resolve(__dirname, '../../src/renderer/services/i18n/locales');
const SUPPORTED_LANGUAGES = i18nConfig.supportedLanguages;
const MODULES = i18nConfig.modules;
const DEFAULT_LANGUAGE = i18nConfig.defaultLanguage;

/**
 * Resolve a byte budget, letting the environment TIGHTEN it but never loosen it.
 *
 * The override exists so the guards can be mutation-proved (lower the cap, watch
 * the named test go red). Clamping with `Math.min` keeps that lever while making
 * it useless as a way to quietly widen a cap that has started to bite.
 */
function budgetBytes(envVar: string, measuredDefault: number): number {
  const override = Number(process.env[envVar]);
  if (Number.isFinite(override) && override > 0) return Math.min(measuredDefault, override);
  return measuredDefault;
}

const MODULE_BUDGET_BYTES = budgetBytes('I18N_MODULE_BUDGET_BYTES', 64 * 1024);
const AGGREGATE_MODULE_BUDGET_BYTES = budgetBytes('I18N_AGGREGATE_MODULE_BUDGET_BYTES', 320 * 1024);
const FULL_LOCALE_BUDGET_BYTES = budgetBytes('I18N_FULL_LOCALE_BUDGET_BYTES', 640 * 1024);

/**
 * Modules that legitimately aggregate a whole surface and are an order of
 * magnitude larger than the rest. Measured, not assumed: `settings` is the only
 * one of the 37 modules that exceeds the ordinary cap, in all 13 locales.
 */
const AGGREGATE_MODULES = new Set(['settings']);

function budgetForModule(module: string): number {
  return AGGREGATE_MODULES.has(module) ? AGGREGATE_MODULE_BUDGET_BYTES : MODULE_BUDGET_BYTES;
}

/** Read + parse a locale module, returning the byte length actually loaded. */
async function loadModuleBytes(language: string, module: string): Promise<number> {
  const modulePath = path.join(LOCALES_DIR, language, `${module}.json`);
  const content = await fs.promises.readFile(modulePath, 'utf-8');
  JSON.parse(content);
  return Buffer.byteLength(content, 'utf-8');
}

/** Read + parse every module of one locale, as loading that locale would. */
async function loadLocale(language: string): Promise<{ translations: Record<string, unknown>; bytes: number }> {
  const loaded = await Promise.all(
    MODULES.map(async (module) => {
      const modulePath = path.join(LOCALES_DIR, language, `${module}.json`);
      const content = await fs.promises.readFile(modulePath, 'utf-8');
      return { module, data: JSON.parse(content), bytes: Buffer.byteLength(content, 'utf-8') };
    })
  );

  const translations: Record<string, unknown> = {};
  let bytes = 0;
  for (const entry of loaded) {
    translations[entry.module] = entry.data;
    bytes += entry.bytes;
  }
  return { translations, bytes };
}

describe('i18n Performance Tests', () => {
  describe('Module Loading Performance', () => {
    it('should load a single module within size budget', async () => {
      const measured = await Promise.all(
        SUPPORTED_LANGUAGES.flatMap((language) =>
          MODULES.map(async (module) => ({
            id: `${language}/${module}`,
            module,
            bytes: await loadModuleBytes(language, module),
          }))
        )
      );

      const oversized = measured
        .filter((entry) => entry.bytes >= budgetForModule(entry.module))
        .map((entry) => `${entry.id}.json ${entry.bytes} B >= ${budgetForModule(entry.module)} B`);

      expect(oversized).toEqual([]);
    });

    it('should load a full locale within size budget', async () => {
      const measured = await Promise.all(
        SUPPORTED_LANGUAGES.map(async (language) => ({ language, bytes: (await loadLocale(language)).bytes }))
      );

      const oversized = measured
        .filter((entry) => entry.bytes >= FULL_LOCALE_BUDGET_BYTES)
        .map((entry) => `${entry.language} ${entry.bytes} B >= ${FULL_LOCALE_BUDGET_BYTES} B`);

      expect(oversized).toEqual([]);
    });

    it('should load all modules in parallel successfully', async () => {
      const results = await Promise.all(
        MODULES.map(async (module) => {
          const modulePath = path.join(LOCALES_DIR, 'en-US', `${module}.json`);
          const content = await fs.promises.readFile(modulePath, 'utf-8');
          return { module, data: JSON.parse(content) };
        })
      );

      expect(results).toHaveLength(MODULES.length);
      for (const { data } of results) {
        expect(data).toBeDefined();
        expect(typeof data).toBe('object');
      }
    });
  });

  describe('File Size Optimization', () => {
    it('should keep each modularized module smaller', async () => {
      const sizes = await Promise.all(
        MODULES.map(async (module) => {
          const modulePath = path.join(LOCALES_DIR, 'en-US', `${module}.json`);
          const stats = await fs.promises.stat(modulePath);
          return stats.size;
        })
      );

      const totalSize = sizes.reduce((a, b) => a + b, 0);
      const avgSize = totalSize / MODULES.length;
      expect(avgSize).toBeLessThan(20 * 1024);
    });
  });

  describe('Memory Usage', () => {
    it('should cache only the loaded language', async () => {
      const loadedTranslations = new Map<string, Record<string, unknown>>();

      const { translations } = await loadLocale('en-US');
      loadedTranslations.set('en-US', translations);

      expect(loadedTranslations.size).toBe(1);
      expect(loadedTranslations.has('en-US')).toBe(true);
    });
  });

  describe('Startup Performance', () => {
    it('should load startup locale within size budget', async () => {
      // The locale the app boots into is whatever `defaultLanguage` says, and
      // in this fork that is mn-MN - the largest of the 13. Hardcoding a
      // different one here would guard a locale nobody starts in.
      const { bytes } = await loadLocale(DEFAULT_LANGUAGE);

      expect(bytes).toBeLessThan(FULL_LOCALE_BUDGET_BYTES);
    });

    it('should switch locale within size budget', async () => {
      const loadedTranslations = new Map<string, Record<string, unknown>>();
      const outgoing = await loadLocale('zh-CN');
      loadedTranslations.set('zh-CN', outgoing.translations);

      // A switch loads the incoming locale in full and drops the outgoing one -
      // that eviction is why switching costs the incoming locale's bytes and
      // not the sum of both.
      const incoming = await loadLocale('ja-JP');
      loadedTranslations.clear();
      loadedTranslations.set('ja-JP', incoming.translations);

      expect([...loadedTranslations.keys()]).toEqual(['ja-JP']);
      expect(Object.keys(loadedTranslations.get('ja-JP'))).toHaveLength(MODULES.length);
      expect(incoming.bytes).toBeLessThan(FULL_LOCALE_BUDGET_BYTES);
    });
  });

  describe('Lazy Loading Impact', () => {
    it('should reduce startup memory by loading only required locale', () => {
      const estimatedSizePerLocale = 100 * 1024;
      const oldMemoryUsage = SUPPORTED_LANGUAGES.length * estimatedSizePerLocale;
      const newMemoryUsage = estimatedSizePerLocale;

      const reduction = (oldMemoryUsage - newMemoryUsage) / oldMemoryUsage;
      expect(reduction).toBeGreaterThan(0.8);
    });
  });
});
