/**
 * Mechanical anti-tofu guard for the bundled UI font.
 *
 * WHY
 * ---
 * Дархай is a Mongolian fork. Mongolian Cyrillic needs Ө/ө (U+04E8/U+04E9) and
 * Ү/ү (U+04AE/U+04AF), which live in Unicode's *Cyrillic Supplement/Extended*
 * area - NOT in the basic U+0400-U+045F block that most "Cyrillic" font subsets
 * ship. If the bundled subset ever loses that range, the UI silently degrades to
 * empty boxes (tofu) and nothing in the build fails. This suite makes that
 * failure mechanical: it opens the actual WOFF2 files, reads their `cmap`
 * tables, and diffs them against every character used in every locale JSON.
 *
 * WHICH FONT
 * ----------
 * `src/renderer/main.tsx` does `import '@fontsource-variable/inter'`, which
 * resolves (package.json `exports["."]`) to `index.css` - seven WOFF2 subsets.
 * `--forge-font` in `src/renderer/styles/arco-override.css` lists
 * `'Sora', 'Inter Variable', 'Inter', system-ui, ...`, but Sora's remote Google
 * Fonts link was deliberately removed (see `src/renderer/index.html`, SEC-ELEC-02)
 * and Sora is not in node_modules, so **Inter Variable is the only UI font the
 * app actually ships**. Everything after it in the chain is the user's OS.
 *
 * We resolve the fonts from `node_modules/@fontsource-variable/inter/files/`
 * rather than from `out/renderer/assets/` on purpose: the test must run on a
 * clean checkout without requiring a prior `electron-vite build`. Vite copies
 * these files byte-for-byte (only adding a content hash to the name), and the
 * last test in this file asserts exactly that whenever a build output exists.
 *
 * WHAT IS AND IS NOT ASSERTED
 * ---------------------------
 * The bundled Inter subsets cover Latin, Cyrillic, Greek and Vietnamese. They
 * legitimately do NOT cover CJK (ja-JP, ko-KR, zh-CN, zh-TW) or emoji/dingbats
 * - those are delegated to the OS font stack by design. Rather than skipping
 * them, this suite asserts the delegation explicitly: no *letter* of a bundled
 * script may be missing anywhere, and every uncovered character must be either a
 * CJK letter or a non-letter symbol. An Arabic or Devanagari letter appearing in
 * a locale would fail here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import i18nConfig from '../../src/common/config/i18n-config.json';
import { type FontFaceDeclaration, parseFontFaceDeclarations, readCmapCoverage } from './helpers/woff2Cmap';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LOCALES_DIR = path.join(REPO_ROOT, 'src/renderer/services/i18n/locales');
const FONT_PACKAGE_DIR = path.join(REPO_ROOT, 'node_modules/@fontsource-variable/inter');
const FONT_CSS_FILE = path.join(FONT_PACKAGE_DIR, 'index.css');
const FONT_FILES_DIR = path.join(FONT_PACKAGE_DIR, 'files');
const BUILT_ASSETS_DIR = path.join(REPO_ROOT, 'out/renderer/assets');

/** Fontsource's variable Inter ships exactly these subsets via index.css. */
const EXPECTED_SUBSET_COUNT = 7;
/** Sanity floor: the seven subsets together map well over a thousand codepoints. */
const MIN_TOTAL_COVERAGE = 1000;

/**
 * All 35 letters of the Mongolian Cyrillic alphabet in both cases. Spelled out
 * literally so a regression names the exact letter that disappeared.
 */
const MONGOLIAN_CYRILLIC_ALPHABET = 'АБВГДЕЁЖЗИЙКЛМНОӨПРСТУҮФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмноөпрстуүфхцчшщъыьэюя';

/** Locales whose script the bundled Inter subsets are responsible for. */
const BUNDLED_SCRIPT_LOCALES = [
  'en-US',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'uk-UA',
  'mn-MN',
] as const;

/**
 * Locales that intentionally depend on the operating system's font stack: Inter
 * has no CJK glyphs and shipping a CJK webfont would add tens of megabytes.
 */
const SYSTEM_FONT_LOCALES = ['zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'] as const;

/** Scripts the bundled subsets exist to serve. A missing letter here is a bug. */
const BUNDLED_SCRIPT_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;
/**
 * Scripts explicitly delegated to the OS font stack. Matched on
 * `Script_Extensions`, not `Script`: characters shared between CJK scripts -
 * e.g. U+30FC ー (prolonged sound mark, a `Lm` letter) - carry `Script=Common`
 * and would otherwise look like an unexplained foreign letter.
 */
const SYSTEM_FONT_SCRIPT = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
const IS_LETTER = /\p{L}/u;
/** i18next interpolation - `{{name}}` is replaced at runtime, never rendered. */
const INTERPOLATION = /\{\{[^}]*\}\}/g;

/** Where a codepoint was first seen, so failures are actionable. */
type CharUsage = {
  readonly codePoint: number;
  readonly locale: string;
  readonly module: string;
  readonly key: string;
};

type LocaleCharMap = ReadonlyMap<number, CharUsage>;

/**
 * Characters that carry no glyph of their own and therefore cannot be tofu:
 * C0/C1 controls, Unicode format characters (ZWJ, ZWNJ, BOM, soft hyphen, bidi
 * marks) and variation selectors (e.g. U+FE0F, which only switches an adjacent
 * character to emoji presentation).
 */
function isNonRendered(codePoint: number): boolean {
  const char = String.fromCodePoint(codePoint);
  if (/[\p{Cc}\p{Cf}]/u.test(char)) {
    return true;
  }
  const isVariationSelector =
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
  return isVariationSelector;
}

/** Recursively yields every string leaf of a parsed locale module. */
function walkStrings(value: unknown, keyPath: string, visit: (key: string, text: string) => void): void {
  if (typeof value === 'string') {
    visit(keyPath, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${keyPath}[${index}]`, visit));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(child, keyPath === '' ? key : `${keyPath}.${key}`, visit);
    }
  }
}

/** Collects every rendered codepoint of one locale, remembering its first use. */
function collectLocaleChars(locale: string): LocaleCharMap {
  const localeDir = path.join(LOCALES_DIR, locale);
  const chars = new Map<number, CharUsage>();
  const modules = fs
    .readdirSync(localeDir)
    .filter((file) => file.endsWith('.json'))
    .toSorted();

  for (const module of modules) {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(localeDir, module), 'utf8'));
    walkStrings(parsed, '', (key, text) => {
      for (const char of text.replace(INTERPOLATION, '')) {
        const codePoint = char.codePointAt(0);
        if (codePoint === undefined || isNonRendered(codePoint) || chars.has(codePoint)) {
          continue;
        }
        chars.set(codePoint, { codePoint, locale, module, key });
      }
    });
  }

  return chars;
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** One line per missing character, naming the exact locale file and key. */
function describeMissing(usages: readonly CharUsage[]): string {
  return usages
    .map(
      (usage) =>
        `  '${String.fromCodePoint(usage.codePoint)}' ${formatCodePoint(usage.codePoint)} ` +
        `- ${usage.locale}/${usage.module} -> ${usage.key}`
    )
    .join('\n');
}

// --- Shared state, computed once ------------------------------------------

let faces: readonly FontFaceDeclaration[] = [];
/** codepoint -> subset file, for every codepoint with a glyph in the raw cmap. */
let cmapCoverage = new Map<number, string>();
/** Codepoints the browser will really render: cmap ∩ declared unicode-range. */
let renderableCoverage = new Set<number>();
/** Every codepoint claimed by some `@font-face` unicode-range. */
let declaredRanges = new Map<number, string>();
const localeChars = new Map<string, LocaleCharMap>();

beforeAll(() => {
  faces = parseFontFaceDeclarations(fs.readFileSync(FONT_CSS_FILE, 'utf8'));

  for (const face of faces) {
    const coverage = readCmapCoverage(path.join(FONT_FILES_DIR, face.file));
    for (const codePoint of coverage) {
      cmapCoverage.set(codePoint, face.file);
    }
    for (const range of face.ranges) {
      for (let codePoint = range.start; codePoint <= range.end; codePoint++) {
        declaredRanges.set(codePoint, face.file);
        if (coverage.has(codePoint)) {
          renderableCoverage.add(codePoint);
        }
      }
    }
  }

  for (const locale of i18nConfig.supportedLanguages) {
    localeChars.set(locale, collectLocaleChars(locale));
  }
});

describe('Bundled UI font glyph coverage', () => {
  describe('Font parsing sanity', () => {
    // Without these the whole suite could pass vacuously on an empty coverage set.
    it('should parse every @font-face rule the renderer imports', () => {
      expect(faces).toHaveLength(EXPECTED_SUBSET_COUNT);
      for (const face of faces) {
        expect(fs.existsSync(path.join(FONT_FILES_DIR, face.file))).toBe(true);
        expect(face.ranges.length).toBeGreaterThan(0);
      }
    });

    it('should read a non-empty cmap from every bundled subset', () => {
      for (const face of faces) {
        const coverage = readCmapCoverage(path.join(FONT_FILES_DIR, face.file));
        expect(coverage.size, `${face.file} has an empty cmap`).toBeGreaterThan(0);
      }
      expect(renderableCoverage.size).toBeGreaterThan(MIN_TOTAL_COVERAGE);
    });

    it('should cover plain ASCII, proving the parsed cmap is meaningful', () => {
      for (const char of 'AZaz09 .,') {
        expect(renderableCoverage.has(char.codePointAt(0) as number)).toBe(true);
      }
    });

    it('should see every locale directory declared in i18n-config.json', () => {
      const onDisk = fs
        .readdirSync(LOCALES_DIR)
        .filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory())
        .toSorted();
      expect(onDisk).toEqual([...i18nConfig.supportedLanguages].toSorted());
      expect([...BUNDLED_SCRIPT_LOCALES, ...SYSTEM_FONT_LOCALES].toSorted()).toEqual(onDisk);
    });
  });

  describe('Mongolian Cyrillic (hard requirement)', () => {
    it('should provide a glyph for all 70 Mongolian Cyrillic letters', () => {
      const missing = [...MONGOLIAN_CYRILLIC_ALPHABET].filter(
        (char) => !renderableCoverage.has(char.codePointAt(0) as number)
      );
      expect(
        missing,
        `Bundled Inter subsets have no glyph for: ${missing
          .map((char) => `'${char}' ${formatCodePoint(char.codePointAt(0) as number)}`)
          .join(', ')}`
      ).toEqual([]);
    });

    it('should cover every character used in the mn-MN translations', () => {
      const chars = localeChars.get('mn-MN');
      expect(chars).toBeDefined();

      const missing = [...(chars as LocaleCharMap).values()].filter(
        (usage) => !renderableCoverage.has(usage.codePoint) && IS_LETTER.test(String.fromCodePoint(usage.codePoint))
      );

      expect(
        missing,
        `mn-MN uses ${missing.length} letter(s) with no glyph in the bundled fonts:\n${describeMissing(missing)}`
      ).toEqual([]);
    });
  });

  describe('All locales', () => {
    it('should cover every Latin/Cyrillic/Greek letter used in any locale', () => {
      const missing: CharUsage[] = [];

      for (const [locale, chars] of localeChars) {
        for (const usage of chars.values()) {
          const char = String.fromCodePoint(usage.codePoint);
          if (!BUNDLED_SCRIPT_LETTER.test(char)) {
            continue;
          }
          if (!renderableCoverage.has(usage.codePoint)) {
            missing.push({ ...usage, locale });
          }
        }
      }

      expect(
        missing,
        `The bundled fonts own these scripts but have no glyph for:\n${describeMissing(missing)}`
      ).toEqual([]);
    });

    it('should back every codepoint its @font-face unicode-range claims', () => {
      // A subset that declares a range but lacks the glyph makes the browser
      // download bytes it cannot use - a sign the subset was rebuilt wrong.
      const broken: string[] = [];

      for (const chars of localeChars.values()) {
        for (const usage of chars.values()) {
          const declaredIn = declaredRanges.get(usage.codePoint);
          if (declaredIn !== undefined && !cmapCoverage.has(usage.codePoint)) {
            broken.push(
              `'${String.fromCodePoint(usage.codePoint)}' ${formatCodePoint(usage.codePoint)} ` +
                `claimed by ${declaredIn} but absent from its cmap ` +
                `(${usage.locale}/${usage.module} -> ${usage.key})`
            );
          }
        }
      }

      expect(broken, broken.join('\n')).toEqual([]);
    });

    it('should only delegate CJK letters and non-letter symbols to system fonts', () => {
      // Everything the bundled fonts do not draw must be explainable. CJK is an
      // accepted delegation; arrows/dingbats/emoji fall back to Segoe UI Symbol,
      // Apple Color Emoji, Noto and friends. A letter from any other script
      // showing up here would be a genuine tofu risk and fails the test.
      const unexplained: CharUsage[] = [];

      for (const chars of localeChars.values()) {
        for (const usage of chars.values()) {
          if (renderableCoverage.has(usage.codePoint)) {
            continue;
          }
          const char = String.fromCodePoint(usage.codePoint);
          if (SYSTEM_FONT_SCRIPT.test(char) || !IS_LETTER.test(char)) {
            continue;
          }
          unexplained.push(usage);
        }
      }

      expect(
        unexplained,
        `Uncovered letters from a script that is neither bundled nor an accepted CJK delegation:\n${describeMissing(unexplained)}`
      ).toEqual([]);
    });

    it('should keep CJK locales the only ones relying on system fonts for letters', () => {
      const relyingOnSystemFonts = [...localeChars]
        .filter(([, chars]) =>
          [...chars.values()].some(
            (usage) => !renderableCoverage.has(usage.codePoint) && IS_LETTER.test(String.fromCodePoint(usage.codePoint))
          )
        )
        .map(([locale]) => locale)
        .toSorted();

      expect(relyingOnSystemFonts).toEqual([...SYSTEM_FONT_LOCALES].toSorted());
    });
  });

  describe('Build output parity', () => {
    // Runs only after a build; the source of truth stays node_modules so a clean
    // checkout still gets the full guarantee above.
    const hasBuild = fs.existsSync(BUILT_ASSETS_DIR);

    it.skipIf(!hasBuild)('should ship the exact subset bytes it was tested against', () => {
      const built = fs.readdirSync(BUILT_ASSETS_DIR).filter((file) => /^inter-.*\.woff2$/.test(file));
      expect(built.length).toBe(EXPECTED_SUBSET_COUNT);

      for (const file of built) {
        // Vite appends `-<hash>` before the extension and changes nothing else.
        const source = file.replace(/-[A-Za-z0-9_-]{8}\.woff2$/, '.woff2');
        const sourcePath = path.join(FONT_FILES_DIR, source);
        expect(fs.existsSync(sourcePath), `${file} has no source ${source}`).toBe(true);
        expect(
          fs.readFileSync(path.join(BUILT_ASSETS_DIR, file)).equals(fs.readFileSync(sourcePath)),
          `${file} differs from ${source}`
        ).toBe(true);
      }
    });
  });
});
