/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The component library's own strings, per app language.
 *
 * Roughly a third of the words on a settings page come from Arco rather than
 * from `locales/`: the date picker's month names, "No data", the pagination
 * controls, the upload prompts, the OK/Cancel on every dialog. This map covered
 * five of the app's thirteen languages, so the other eight fell through to
 * English - including Mongolian, the language this app exists for. Those users
 * read a half-translated screen no matter how complete our own translations
 * were.
 *
 * Six of the eight gaps were free: Arco ships those locales and they simply
 * were not wired up. Mongolian is ours (`arcoLocaleMn.ts`), because Arco ships
 * no mn-MN. Ukrainian still falls back to English - Arco ships no uk-UA either,
 * and inventing one nobody here can review would be worse than English.
 *
 * Lives in its own module so the mapping can be tested directly; importing
 * `main.tsx` would mount the whole app.
 */

import enUS from '@arco-design/web-react/es/locale/en-US';
import jaJP from '@arco-design/web-react/es/locale/ja-JP';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import zhTW from '@arco-design/web-react/es/locale/zh-TW';
import koKR from '@arco-design/web-react/es/locale/ko-KR';
import deDE from '@arco-design/web-react/es/locale/de-DE';
import esES from '@arco-design/web-react/es/locale/es-ES';
import frFR from '@arco-design/web-react/es/locale/fr-FR';
import ptBR from '@arco-design/web-react/es/locale/pt-BR';
import ruRU from '@arco-design/web-react/es/locale/ru-RU';
import trTR from '@arco-design/web-react/es/locale/tr-TR';
import mnMN from './arcoLocaleMn';

export type ArcoLocale = typeof enUS;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fill whatever a locale is missing from the English one.
 *
 * Arco's non-English locales are not complete: several omit `Form` and
 * `ColorPicker` entirely, and most omit `Calendar.monthFormat` /
 * `Calendar.yearFormat`. Wiring one in raw leaves those components rendering
 * `undefined`. The codebase already carried a hand-written patch for Korean -
 * this is that patch generalised, so adding a language cannot reintroduce the
 * same hole, and a library upgrade that adds a string is covered too.
 */
export function completeArcoLocale(locale: unknown, base: unknown = enUS): ArcoLocale {
  if (!isPlainObject(base)) return locale as ArcoLocale;
  if (!isPlainObject(locale)) return base as ArcoLocale;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(locale)) {
    const baseValue = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(value) && isPlainObject(baseValue) ? completeArcoLocale(value, baseValue) : value;
  }
  return out as ArcoLocale;
}

export const ARCO_LOCALES: Record<string, ArcoLocale> = {
  'zh-CN': completeArcoLocale(zhCN),
  'zh-TW': completeArcoLocale(zhTW),
  'ja-JP': completeArcoLocale(jaJP),
  'ko-KR': completeArcoLocale(koKR),
  'en-US': enUS,
  'de-DE': completeArcoLocale(deDE),
  'es-ES': completeArcoLocale(esES),
  'fr-FR': completeArcoLocale(frFR),
  'pt-BR': completeArcoLocale(ptBR),
  'ru-RU': completeArcoLocale(ruRU),
  'tr-TR': completeArcoLocale(trTR),
  'mn-MN': completeArcoLocale(mnMN),
};

/** The library locale for an app language, falling back to English. */
export function resolveArcoLocale(language: string | undefined): ArcoLocale {
  return (language && ARCO_LOCALES[language]) || enUS;
}
