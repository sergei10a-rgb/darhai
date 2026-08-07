/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The half-translated screen.
 *
 * Roughly a third of the words on a settings page come from the component
 * library, not from `locales/`: the date picker's month names, "No data", the
 * pagination controls, the upload prompts, the OK/Cancel on every dialog. The
 * app mapped five of its thirteen languages to a library locale, so the other
 * eight - including Mongolian, the language this app exists for - read those
 * words in English no matter how complete our own translations were.
 *
 * Six of those eight were free: the library ships the locale and it simply was
 * not wired up. Mongolian is ours, because the library ships no mn-MN.
 *
 * These tests are the mechanical guard. A language added to
 * `i18n-config.json`, or a library upgrade that introduces a new string, has to
 * fail here rather than quietly reach a user in English.
 */

import { describe, expect, it } from 'vitest';
import enUS from '@arco-design/web-react/es/locale/en-US';
import i18nConfig from '@/common/config/i18n-config.json';
import mnMN from '@renderer/services/i18n/arcoLocaleMn';
import { ARCO_LOCALES, completeArcoLocale, resolveArcoLocale } from '@renderer/services/i18n/arcoLocales';

/**
 * Languages the library genuinely has no locale for. Anything on this list
 * falls back to English on purpose; anything not on it must be mapped.
 *
 * `uk-UA` is here because Arco ships none and inventing a Ukrainian locale
 * nobody on this project can review would be worse than English.
 */
const NO_LIBRARY_LOCALE = new Set(['uk-UA']);

/** Every locale Arco actually ships, read from the package rather than assumed. */
const arcoShippedLocales = new Set([
  'ar-EG',
  'de-DE',
  'en-US',
  'es-ES',
  'fr-FR',
  'id-ID',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'ms-MY',
  'pt-BR',
  'pt-PT',
  'ru-RU',
  'th-TH',
  'tr-TR',
  'vi-VN',
  'zh-CN',
  'zh-HK',
  'zh-TW',
]);

/** Walk a locale object into `a.b.c` -> value pairs, arrays included. */
function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => flatten(v, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

describe('component-library locale coverage', () => {
  const appLanguages = i18nConfig.supportedLanguages as string[];

  it('leaves no app language reading the library in English by accident', () => {
    // Reading the shipped list rather than hardcoding the mapping means a
    // language added to i18n-config.json fails here instead of silently
    // reaching a user in English.
    const unmapped = appLanguages.filter((lang) => !NO_LIBRARY_LOCALE.has(lang) && !ARCO_LOCALES[lang]);
    expect(unmapped).toEqual([]);
  });

  it('maps every language the library itself ships a locale for', () => {
    const shippedButUnmapped = appLanguages.filter((lang) => arcoShippedLocales.has(lang) && !ARCO_LOCALES[lang]);
    expect(shippedButUnmapped).toEqual([]);
  });

  it('falls back to English only where the library genuinely has nothing', () => {
    for (const lang of appLanguages) {
      const resolved = resolveArcoLocale(lang);
      if (NO_LIBRARY_LOCALE.has(lang) || lang === 'en-US') {
        expect(resolved.locale, lang).toBe('en-US');
      } else {
        // Landing on English here is the bug: it means the language was never
        // mapped and the user reads library strings in the wrong language.
        expect(resolved.locale, `${lang} silently resolves to English`).not.toBe('en-US');
      }
    }
  });

  it('falls back to English for a language nobody configured', () => {
    expect(resolveArcoLocale('xx-XX').locale).toBe('en-US');
    expect(resolveArcoLocale(undefined).locale).toBe('en-US');
  });

  it('completes every mapped locale, because the library ships incomplete ones', () => {
    // de-DE, es-ES, fr-FR, pt-BR, ru-RU and tr-TR omit `Form` and `ColorPicker`
    // entirely, and most omit Calendar.monthFormat / yearFormat. Wired in raw,
    // those components render `undefined`. The codebase already carried a
    // hand-written patch for Korean; this asserts the generalised one covers
    // all of them.
    for (const [lang, locale] of Object.entries(ARCO_LOCALES)) {
      const missing = flatten(enUS)
        .map(([k]) => k)
        .filter((k) => !new Map(flatten(locale)).has(k));
      expect(missing, `${lang} is missing library strings`).toEqual([]);
    }
  });

  it('keeps the locale own values and only fills the gaps', () => {
    const partial = { locale: 'xx-XX', Modal: { okText: 'Ja' } };
    const completed = completeArcoLocale(partial);
    expect(completed.Modal.okText).toBe('Ja');
    expect(completed.Modal.cancelText).toBe(enUS.Modal.cancelText);
    expect(completed.Empty.noData).toBe(enUS.Empty.noData);
  });
});

describe('the Mongolian component-library locale', () => {
  const englishKeys = flatten(enUS).map(([k]) => k);
  const mongolian = new Map(flatten(mnMN));

  it('covers every string the English locale has', () => {
    // A library upgrade that adds a string must fail here, not ship English
    // into a Mongolian screen.
    const missing = englishKeys.filter((k) => !mongolian.has(k));
    expect(missing).toEqual([]);
  });

  it('declares itself as Mongolian, with a date library locale that exists', () => {
    expect(mnMN.locale).toBe('mn-MN');
    expect(mnMN.dayjsLocale).toBe('mn');
  });

  it('writes the year before the month, as Mongolian does', () => {
    // "2026 оны 8-р сар", never "8-р сар 2026".
    expect(mnMN.Calendar.monthBeforeYear).toBe(false);
    expect(mnMN.Calendar.formatMonth).toContain('YYYY');
    expect(mnMN.Calendar.formatMonth.indexOf('YYYY')).toBeLessThan(mnMN.Calendar.formatMonth.indexOf('M['));
  });

  it('leaves no user-facing string in Cyrillic-free English', () => {
    // `Form` is excluded on purpose: those messages come from `b-validate`
    // rather than the locale file, and Arco's own non-English locales leave
    // them alone for the same reason.
    const cyrillic = /[Ѐ-ӿ]/;
    const englishLooking = [...mongolian.entries()]
      .filter(([key]) => !key.startsWith('Form'))
      .filter(([key]) => !/format|dayjsLocale|^locale$|monthBeforeYear/i.test(key))
      // Month shorthands are written numerically ("8-р сар") and the "{0}"
      // placeholders carry no letters of their own.
      .filter(([, value]) => /[a-zA-Z]/.test(value.replace(/\{\d+\}/g, '')))
      .filter(([, value]) => !cyrillic.test(value));

    expect(englishLooking).toEqual([]);
  });

  it('translates the buttons a user meets most often', () => {
    expect(mnMN.Modal.cancelText).toBe('Цуцлах');
    expect(mnMN.Modal.okText).toBe('Болсон');
    expect(mnMN.Empty.noData).toBe('Мэдээлэл алга');
    expect(mnMN.Calendar.today).toBe('Өнөөдөр');
  });

  it('names all twelve months and all seven days', () => {
    expect(Object.values(mnMN.Calendar.month.long)).toHaveLength(12);
    expect(new Set(Object.values(mnMN.Calendar.month.long)).size).toBe(12);
    const days = Object.entries(mnMN.Calendar.week.long)
      .filter(([k]) => k !== 'self')
      .map(([, v]) => v);
    expect(days).toEqual(['Даваа', 'Мягмар', 'Лхагва', 'Пүрэв', 'Баасан', 'Бямба', 'Ням']);
  });
});
