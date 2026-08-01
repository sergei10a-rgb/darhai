/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Transliterated technical vocabulary: Mongolian spellings of English technical
 * loan words, mapped to the canonical English token they name.
 *
 * Why this exists. Darhai's skill library and the user's own notes are written
 * in English, but Mongolian users type technical terms the way they say them -
 * either in Cyrillic («пайтон», «докер», «кубернетес») or in ad-hoc Latin
 * romanization (`paiton`, `doker`, `kubernetis`). Neither is the string
 * `python` / `docker` / `kubernetes`, so a purely lexical retriever finds
 * NOTHING for such a turn. Measured on the shipped library: "надад пайтон юнит
 * тэст бичхэд туслаач пайтэст ашиглаад" returned zero skills, while the exact
 * same request with `python` / `pytest` left in Latin returned the right three.
 *
 * Why a curated table rather than a general transliterator. A general Mongolian
 * Cyrillic <-> Latin transliterator has better recall but is lossy in the wrong
 * direction: «ө» is written `o`, `u` or `oe` and «ү» as `u`, so the mapping is
 * many-to-one and round-tripping invents words. Those invented words then match
 * unrelated skills, which is precisely the "5 irrelevant skills on every
 * message" failure the relevance gate exists to prevent. A curated table is
 * lower recall but each entry is a deliberate, verifiable claim: this exact
 * string means this exact English term. Retrieval precision is worth more here
 * than covering the long tail, and the table is trivially extended.
 *
 * Precision invariant: every KEY is a string that is not an ordinary English
 * word, so canonicalizing an English turn is a no-op. {@link buildAliasMap}
 * asserts key/value disjointness (canonicalization is idempotent) and the unit
 * tests assert no key collides with the English vocabulary we care about -
 * including near-misses like `piton`, `deer` and `bid`, which are deliberately
 * absent because they are real English words.
 *
 * Deliberately covers LOAN WORDS ONLY - transliterations of English technical
 * terms. Native Mongolian technical words («алдаа» = error, «өгөгдөл» = data)
 * are a bilingual glossary, a different mechanism with a different risk profile,
 * and are intentionally out of scope here.
 */

/**
 * Canonical English term -> the Mongolian spellings that mean it.
 *
 * Grouped by canonical term (not flat pairs) so a reviewer can see every
 * spelling of one concept at a glance, and so adding a spelling is a one-word
 * edit. Cyrillic and Latin romanizations live in the same group on purpose:
 * they are the same claim about the same word, just typed on a different
 * keyboard layout.
 */
const ALIAS_GROUPS: Readonly<Record<string, readonly string[]>> = {
  // --- Languages & runtimes -------------------------------------------------
  python: ['пайтон', 'пайтхон', 'пайсон', 'питон', 'paiton', 'paython'],
  pytest: ['пайтэст', 'пайтест', 'питест', 'paitest', 'paytest'],
  javascript: ['жаваскрипт', 'javaskript'],
  typescript: ['тайпскрипт', 'таипскрипт', 'taipskript', 'taipscript'],
  java: ['жава', 'жаба'],
  kotlin: ['котлин'],
  swift: ['свифт'],
  golang: ['голанг', 'голэнг'],
  rust: ['раст'],
  node: ['нодежс', 'нодежээс'],
  php: ['пхп'],
  ruby: ['руби'],

  // --- Frameworks & libraries ----------------------------------------------
  react: ['реакт', 'reakt'],
  vue: ['вью'],
  angular: ['ангуляр'],
  express: ['экспресс'],
  django: ['жанго', 'джанго'],
  flask: ['фласк'],
  framework: ['фреймворк'],

  // --- Platforms & infrastructure ------------------------------------------
  docker: ['докер', 'доккер', 'doker'],
  kubernetes: ['кубернетес', 'кубернетис', 'кубернэтэс', 'кубер', 'kubernetis', 'kubernets', 'kuber'],
  linux: ['линукс'],
  ubuntu: ['убунту'],
  windows: ['виндовс', 'виндоус'],
  macos: ['макос'],
  server: ['сервер'],
  client: ['клиент'],
  browser: ['браузер'],
  terminal: ['терминал'],
  protocol: ['протокол'],
  migration: ['миграц', 'миграци'],

  // --- Version control ------------------------------------------------------
  git: ['гит'],
  github: ['гитхаб', 'гитхуб'],
  gitlab: ['гитлаб'],

  // --- Data stores ----------------------------------------------------------
  postgres: ['постгрес', 'постгрэс'],
  redis: ['редис'],
  mongodb: ['монгодб', 'монгодиби'],
  database: ['датабааз', 'датабэйс', 'databaaz'],
  cache: ['кэш', 'кеш', 'kesh'],

  // --- Core engineering vocabulary -----------------------------------------
  api: ['апи'],
  json: ['жсон', 'жейсон'],
  token: ['токен'],
  code: ['код', 'кодыг', 'кодын', 'кодод', 'kod'],
  script: ['скрипт'],
  algorithm: ['алгоритм', 'algoritm'],
  component: ['компонент', 'komponent'],
  function: ['функц', 'функци'],
  class: ['класс', 'klass'],
  object: ['обьект', 'объект', 'obyekt'],
  array: ['массив', 'massiv'],
  interface: ['интерфейс'],
  compiler: ['компилятор'],
  model: ['модел', 'модель'],
  file: ['файл'],

  // --- Workflow verbs & artefacts ------------------------------------------
  test: ['тест', 'тэст'],
  unit: ['юнит', 'yunit'],
  debug: ['дебаг', 'дибаг', 'debag'],
  deploy: ['деплой', 'deploi'],
  build: ['билд', 'bild'],

  // --- Web / product surface ------------------------------------------------
  web: ['вэб', 'веб', 'veb'],
  site: ['сайт', 'sait'],
  design: ['дизайн', 'dizain', 'dizayn'],
  frontend: ['фронтенд'],
  backend: ['бэкенд'],
};

/**
 * Flatten {@link ALIAS_GROUPS} into the lookup direction callers need, with the
 * same NFC + lowercase normalization every tokenizer in the app applies, so a
 * key written with a combining breve still matches the pre-composed spelling.
 *
 * Throws on a malformed table (a key that is also a canonical value, or two
 * groups claiming the same spelling) rather than silently resolving one way:
 * both mistakes break the idempotence callers rely on, and both are edit-time
 * errors that must fail loudly at module load, not at retrieval time.
 */
function buildAliasMap(): ReadonlyMap<string, string> {
  const normalize = (s: string): string => s.normalize('NFC').toLocaleLowerCase();
  const canonicals = new Set(Object.keys(ALIAS_GROUPS).map(normalize));
  const map = new Map<string, string>();

  for (const [canonical, spellings] of Object.entries(ALIAS_GROUPS)) {
    const target = normalize(canonical);
    for (const spelling of spellings) {
      const key = normalize(spelling);
      if (canonicals.has(key)) {
        throw new Error(
          `mongolianTechnicalTerms: alias "${key}" is also a canonical term - canonicalization would not be idempotent`
        );
      }
      const existing = map.get(key);
      if (existing !== undefined && existing !== target) {
        throw new Error(`mongolianTechnicalTerms: alias "${key}" is claimed by both "${existing}" and "${target}"`);
      }
      map.set(key, target);
    }
  }

  return map;
}

/** Transliterated spelling -> canonical English term. */
export const TECHNICAL_TERM_ALIASES: ReadonlyMap<string, string> = buildAliasMap();

/**
 * The canonical English term for a token, or the token unchanged.
 *
 * Idempotent by construction (see {@link buildAliasMap}), so callers may apply
 * it to already-canonical text - which they do: the skill retriever runs it
 * over both the query and the indexed documents so the two sides always meet in
 * the same vocabulary.
 *
 * Expects an already lowercased, NFC-normalized token (what every tokenizer in
 * the app produces); normalizes defensively anyway so a raw caller is not a
 * silent miss.
 */
export function canonicalTechnicalTerm(token: string): string {
  const key = token.normalize('NFC').toLocaleLowerCase();
  return TECHNICAL_TERM_ALIASES.get(key) ?? token;
}

/** True when `token` is a transliterated spelling with a canonical English form. */
export function isTransliteratedTechnicalTerm(token: string): boolean {
  return TECHNICAL_TERM_ALIASES.has(token.normalize('NFC').toLocaleLowerCase());
}
