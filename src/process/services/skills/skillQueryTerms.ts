/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Query-term extraction for per-turn skill retrieval.
 *
 * Turning a raw user message into the handful of discriminative words we
 * actually retrieve on. Extracted from `agentUtils` so the stopword lists can
 * grow per language without bloating the prompt-assembly module, and so the
 * behaviour is directly unit-testable.
 *
 * Mongolian-first note: the bundled library is ~96% English, so a Mongolian
 * turn matches at most its Latin loan words ("Kubernetes", "React"). Two things
 * follow, and both are handled here:
 *
 *   1. The Mongolian function words in the turn must be stripped, or they
 *      accumulate BM25 score on the ~100 Cyrillic-described skills. Measured on
 *      the shipped corpus: "Монгол хэл дээр вэб сайтын дизайн хийхэд ямар ур
 *      чадвар хэрэгтэй вэ?" surfaced `ace-system-design-interviews`,
 *      `learn-new-language` and `build-a-garden` - matched purely on «дээр»,
 *      «хэрэгтэй» and «чадвар». That is the Mongolian half of the "5 irrelevant
 *      skills on every message" bug the English list already fixed.
 *   2. Text is NFC-normalized before tokenizing, so «й»/«ё»/«ү» written as base
 *      letter + combining breve (NFD - produced by some editors and by macOS
 *      filenames) compares equal to the pre-composed form. Same reasoning as
 *      `memorySearch.normalizeSearchText`.
 *
 * Transliteration note. Mongolian users type technical terms as they say them,
 * in either script - «пайтон» / `paiton` for `python`. Query terms are therefore
 * canonicalized through {@link canonicalTechnicalTerm}, and the same Mongolian
 * function words are stopworded in BOTH scripts, so a fully romanized turn
 * ("nadad paiton yunit test bichhed tuslaach") is treated exactly like its
 * Cyrillic twin instead of looking like an English turn made of nonsense words.
 */
import { canonicalTechnicalTerm } from '@/common/utils/mongolianTechnicalTerms';

/**
 * Conversational stopwords stripped from the retrieval query. These carry no
 * skill intent but, because the skill corpus is terse, several of them are rare
 * in it (high idf) - so left in, a long chatty sentence accumulates BM25 score
 * on unrelated skills. Plain English stopwords plus chat filler; deliberately
 * excludes domain words.
 */
const ENGLISH_STOPWORDS =
  'about above after again against all also am an and any are arent as at be because been before being ' +
  'below between both but by can cant cannot could couldnt did didnt do does doesnt doing dont down during ' +
  'each few for from further had hadnt has hasnt have havent having he her here hers herself him himself his ' +
  'how however i id if ill im ive into is isnt it its itself just lets me more most must my myself no nor not ' +
  'of off on once only or other ought our ours ourselves out over own same shant she should shouldnt so some ' +
  'such than that thats the their theirs them themselves then there theres these they theyll theyre theyve ' +
  'this those through to too under until up very was wasnt we well were werent weve what whats when where ' +
  'which while who whom why will with wont would wouldnt you youd youll youre youve your yours yourself ' +
  'yourselves hi hey hello howdy yeah yep nope ok okay cool nice thanks thank sure gonna wanna gotta got get ' +
  'getting let make made making want wants need needs going give stuff thing things really actually basically ' +
  'maybe perhaps please';

/**
 * Mongolian (Cyrillic) function words and chat filler - the direct counterpart
 * of the English list above. Pronouns, postpositions, copulas, question
 * particles, politeness formulas and generic verbs of asking/doing.
 *
 * Deliberately EXCLUDES domain words, exactly like the English list: «чадвар»
 * (skill), «код» (code), «загвар» (model), «өгөгдөл» (data) and similar stay in
 * the query because they carry real retrieval intent. Words of two characters
 * or fewer («уу», «вэ», «нь», «ба») need no entry - the length filter in
 * {@link discriminativeQueryTerms} already drops them.
 */
const MONGOLIAN_STOPWORDS =
  'бид бол болно болох болсон болж байна байгаа байх байсан байж юм юу юун ямар яаж яагаад хэрхэн хэзээ ' +
  'хаана хаанаас хэн хэний хэнд гэж гэсэн гэдэг гэвэл гэх мөн буюу эсвэл харин гэхдээ тэгээд тийм тийн ' +
  'үгүй одоо дараа дараах өмнө хойш дээр доор дотор гадна тухай талаар төлөө хамт хүртэл хойно дагуу ' +
  'надад танд бидэнд надаас танаас миний таны бидний минь чинь тань энэ энэн энд тэр тэнд түүн үүн ийм ' +
  'тэгэх ингэх хийх хийхэд хийе хийж авах авахад авъя өгөх өгөөч өгнө үү болгох тусла туслаач туслаарай ' +
  'туслах тусална хэрэгтэй хэрэглэх хэрэглэн хүсч хүсэж сайн сайну байнуу баярлалаа тэгье за маш их бага ' +
  'зөвхөн бүх бүгд бүр нэг бас дахин дахиад аль хэд хэдэн бишүү биш зэрэг гээд';

/**
 * The same Mongolian function words, romanized - what a user types when the
 * keyboard is not switched to Cyrillic ("nadad ... bichihed tuslaach").
 *
 * Two jobs, both load-bearing:
 *   1. Stopwording, exactly as for the Cyrillic list. Without it these words
 *      look like rare English tokens (high idf) and drag unrelated skills in.
 *   2. Script detection. A romanized Mongolian turn is written entirely in
 *      Latin, so {@link isMostlyNonLatinScript} cannot see it, and the
 *      cross-lingual relaxation that rescues Cyrillic turns never fires. These
 *      words are the marker that says "this turn is Mongolian" - see
 *      {@link isMongolianTurn}.
 *
 * Every entry is checked against English: romanizations that collide with a
 * real English word (`deer` = дээр, `door` = доор, `end` = энд, `tend` = тэнд,
 * `hen` = хэн, `mash` = маш, `bid` = бид, `bur` = бүр) are DELIBERATELY absent,
 * because stopwording them would silently delete a legitimate English content
 * word from an English turn.
 */
const MONGOLIAN_LATIN_STOPWORDS =
  'nadad tanaas tanii minii bidnii bidend chinii baina bainuu baigaa baih baisan baij bolno boloh bolson bolj ' +
  'yamar yaaj yagaad herhen hezee haana haanaas henii hend gej gesen gedeg gevel tuslaach tusla tuslaarai ' +
  'tuslah tusalna heregtei hereglekh hereglej hiih hiihed hiij hiiye bichih bichihed bichhed bichij ashiglah ' +
  'ashiglaad ashiglan ashiglaj uzeh uguuch ugnu avah avahad sain sainuu bayarlalaa tegye tegeed tiim ugui ' +
  'odoo daraa umnu dotor gadna tuhai talaar tuluu hamt hurtel daguu iim ingeh tegeh bugd dahin dahiad zovhon ' +
  'bish heden baga ikh husch husej';

/** All stopwords, in one lookup set. */
export const QUERY_STOPWORDS = new Set([
  ...ENGLISH_STOPWORDS.split(' '),
  ...MONGOLIAN_STOPWORDS.split(' '),
  ...MONGOLIAN_LATIN_STOPWORDS.split(' '),
]);

/** Just the romanized Mongolian markers, for script detection on raw text. */
const MONGOLIAN_LATIN_MARKERS = new Set(MONGOLIAN_LATIN_STOPWORDS.split(' '));

/** Minimum token length that can carry retrieval intent. */
const MIN_TERM_LENGTH = 3;

/**
 * Case-fold and NFC-normalize so Cyrillic compares by character, not by
 * encoding. Mirrors `memorySearch.normalizeSearchText`.
 */
export function normalizeQueryText(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase();
}

/**
 * Distinct, length >= {@link MIN_TERM_LENGTH}, non-stopword query tokens - the
 * signal we retrieve on - each mapped to its canonical English form when it is
 * a known transliteration.
 *
 * Unicode-aware tokenization (`\p{L}\p{N}`) so Cyrillic / Mongolian query words
 * survive - an ASCII `[a-z0-9_-]` regex drops them entirely, leaving non-Latin
 * turns with zero discriminative terms.
 *
 * Canonicalization REPLACES rather than adds a variant. Keeping both spellings
 * would let one concept score twice in `RetrievalResult.matchedTerms`, and that
 * count is exactly what the relevance gate uses to tell a genuine match from an
 * incidental one - inflating it would reopen the "5 irrelevant skills on every
 * message" hole. The lost recall is negligible: the library is ~96% English, so
 * the transliterated spelling had essentially nothing to match anyway.
 *
 * Order matters: filter first, canonicalize second. Every alias key is at least
 * {@link MIN_TERM_LENGTH} characters and no canonical form is a stopword, so
 * the two orders agree today - but filtering first keeps the stopword lists
 * authoritative over the alias table rather than the reverse.
 */
export function discriminativeQueryTerms(text: string): string[] {
  const tokens: string[] = normalizeQueryText(text).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const kept = tokens.filter((t) => t.length >= MIN_TERM_LENGTH && !QUERY_STOPWORDS.has(t));
  return [...new Set(kept.map(canonicalTechnicalTerm))];
}

/** A term that has letters, none of which are Latin (Cyrillic, CJK, ...). */
const NON_LATIN_TERM = (term: string): boolean => /\p{L}/u.test(term) && !/\p{Script=Latin}/u.test(term);

/**
 * True when most of the turn's content words are written in a non-Latin script.
 *
 * Callers use this to decide whether "no skill shares two query terms" is
 * evidence of irrelevance or merely of a language barrier. The skill corpus is
 * written in English, so for a Mongolian turn the Cyrillic words CANNOT co-occur
 * with the Latin loan word in any document - the co-occurrence floor is
 * unsatisfiable by construction and must be relaxed to the best evidence the
 * corpus can offer. For an English turn the same corpus could have matched more
 * terms, so a single shared word stays what it always was: too weak.
 *
 * Terms with no letters at all (bare numbers, version strings) are neutral and
 * excluded from the ratio.
 */
export function isMostlyNonLatinScript(terms: readonly string[]): boolean {
  const lettered = terms.filter((t) => /\p{L}/u.test(t));
  if (lettered.length === 0) return false;
  const nonLatin = lettered.filter(NON_LATIN_TERM).length;
  return nonLatin * 2 >= lettered.length;
}

/**
 * True when this turn is written in Mongolian, in EITHER script.
 *
 * Cyrillic is self-evident from the characters. Romanized Mongolian is not -
 * "nadad paiton yunit test bichhed tuslaach" is 100% Latin and, to a script
 * test, indistinguishable from an English sentence full of typos. So the raw
 * text is also scanned for the romanized function words in
 * {@link MONGOLIAN_LATIN_MARKERS}: those are what actually identify the
 * language, and they are checked on the RAW text because the same list
 * stopwords them out of {@link discriminativeQueryTerms}.
 *
 * `terms` is consulted too (via {@link isMostlyNonLatinScript}) so a turn whose
 * Cyrillic words all canonicalized to English still registers as Mongolian.
 */
export function isMongolianTurn(rawText: string, terms: readonly string[]): boolean {
  if (isMostlyNonLatinScript(terms)) return true;
  const tokens = normalizeQueryText(rawText).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.some((t) => /\p{Script=Cyrillic}/u.test(t) || MONGOLIAN_LATIN_MARKERS.has(t));
}

/**
 * True when the turn contains at least one term the English-written corpus
 * could plausibly contain - a Latin-script term, whether it was typed that way
 * ("Kubernetes") or produced by canonicalizing a transliteration («пайтон»).
 *
 * This is the precondition for relaxing the co-occurrence floor. The relaxation
 * exists for ONE situation: the turn names a real technical concept the corpus
 * knows, but every other word is in a language the corpus is not written in, so
 * two query terms can never co-occur in a single document. A Mongolian turn
 * with NO such bridge term is not in that situation - it is an ordinary chatty
 * turn, and its lone shared word is an incidental same-script hit. Measured:
 * "Сайн байна уу, өнөөдөр цаг агаар ямар байна?" (a weather greeting) matched
 * one Cyrillic word in one of the ~100 Cyrillic-described skills and, under the
 * unconditional relaxation, advertised three unrelated career skills.
 */
export function hasCrossLingualBridgeTerm(terms: readonly string[]): boolean {
  return terms.some((t) => /\p{Script=Latin}/u.test(t));
}
