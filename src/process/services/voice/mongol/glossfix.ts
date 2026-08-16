/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Glossary pass over Nemotron STT output: foreign terms the model spells out
 * in Cyrillic go back to their Latin form ("имэйлээр" → "emailээр").
 *
 * Ported from mn-asr-app `core/glossfix.py` + `core/glossary.json` (98
 * entries), where it was MEASURED at 0 false positives across 11,253 real
 * transcript lines. The model's one systematic weakness is code-switching
 * residue - GitHub → "эд хав"-grade damage in long speech - and this map
 * repairs the recoverable class of it.
 *
 * Matching rules (the reason the false-positive rate holds):
 *   - A key only matches at a WORD START (no letter/digit immediately
 *     before it), so it never fires inside a longer Mongolian word.
 *   - The match is the bare STEM and the replacement stops there, so any
 *     Mongolian suffix survives in place: "юүтюбээс" → "YouTubeээс".
 *   - Longest key wins (keys sorted by length, descending) so multi-word
 *     and long variants beat their own prefixes.
 *   - Keys must not be a stem of a real Mongolian word - that property is
 *     curated in the source glossary, not enforced here.
 */

/** Cyrillic stem (lowercase, suffix-free) → Latin replacement. */
const GLOSSARY: Record<string, string> = {
  айпад: 'iPad',
  айпэд: 'iPad',
  айфон: 'iPhone',
  айфоон: 'iPhone',
  алибаба: 'Alibaba',
  аниме: 'anime',
  анимэ: 'anime',
  апдейт: 'update',
  аплэйт: 'update',
  блютус: 'Bluetooth',
  блютүз: 'Bluetooth',
  блютүүс: 'Bluetooth',
  бэкап: 'backup',
  вайбер: 'Viber',
  вайбэр: 'Viber',
  вайфай: 'WiFi',
  ватсап: 'WhatsApp',
  ватсапп: 'WhatsApp',
  'веб сайт': 'website',
  вичат: 'WeChat',
  ворд: 'Word',
  вотсапп: 'WhatsApp',
  вэбсайт: 'website',
  вэчат: 'WeChat',
  гоогл: 'Google',
  гугл: 'Google',
  гүгл: 'Google',
  гүүгл: 'Google',
  дедлайн: 'deadline',
  дэдлайн: 'deadline',
  дээдлайн: 'deadline',
  жимайл: 'Gmail',
  жимэйл: 'Gmail',
  зум: 'Zoom',
  зуум: 'Zoom',
  зүүм: 'Zoom',
  имайл: 'email',
  имэил: 'email',
  имэйл: 'email',
  инстаграм: 'Instagram',
  инстаграмм: 'Instagram',
  кимчи: 'kimchi',
  кимчхи: 'kimchi',
  логин: 'login',
  макбук: 'MacBook',
  макбүүк: 'MacBook',
  месенжер: 'Messenger',
  мессенжер: 'Messenger',
  миитинг: 'meeting',
  митинг: 'meeting',
  миттинг: 'meeting',
  нетфликс: 'Netflix',
  нэтфликс: 'Netflix',
  паверпоинт: 'PowerPoint',
  паверпойнт: 'PowerPoint',
  пдф: 'PDF',
  поверпойнт: 'PowerPoint',
  рамен: 'ramen',
  рамэн: 'ramen',
  репорт: 'report',
  самсанг: 'Samsung',
  самсунг: 'Samsung',
  сиви: 'CV',
  скриншот: 'screenshot',
  скриншёт: 'screenshot',
  суши: 'sushi',
  сяоми: 'Xiaomi',
  телеграм: 'Telegram',
  телеграмм: 'Telegram',
  тесла: 'Tesla',
  тикток: 'TikTok',
  тойота: 'Toyota',
  тоёота: 'Toyota',
  тэсла: 'Tesla',
  фейсбук: 'Facebook',
  фейсбүүк: 'Facebook',
  фидбэк: 'feedback',
  фийдбак: 'feedback',
  фийдбэк: 'feedback',
  фэйсбук: 'Facebook',
  фэйсбүүк: 'Facebook',
  хонда: 'Honda',
  хуавей: 'Huawei',
  хуавэй: 'Huawei',
  хюндай: 'Hyundai',
  хёндай: 'Hyundai',
  хүндай: 'Hyundai',
  чатжипиай: 'ChatGPT',
  чатжипити: 'ChatGPT',
  шаоми: 'Xiaomi',
  эксел: 'Excel',
  эксэл: 'Excel',
  экцел: 'Excel',
  эмэйл: 'email',
  эппл: 'Apple',
  ютуб: 'YouTube',
  ютюб: 'YouTube',
  юүтюб: 'YouTube',
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** No letter or digit immediately before the stem = we are at a word start. */
const WORD_START = '(?<![0-9A-Za-zА-Яа-яЁёӨҮөү])';

/** Longest key first, so long variants beat their own prefixes. */
const PATTERNS: ReadonlyArray<[RegExp, string]> = Object.keys(GLOSSARY)
  .toSorted((a, b) => b.length - a.length)
  .map((key) => [new RegExp(WORD_START + escapeRegExp(key), 'giu'), GLOSSARY[key]]);

/** Apply the glossary to one transcript. Pure; returns the input on no match. */
export function glossfix(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
