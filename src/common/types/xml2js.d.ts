/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal typings for the part of `xml2js` we actually use.
 *
 * `xml2js` is a direct dependency but ships no types, and `@types/xml2js`
 * declares the whole surface as loosely-typed builder/parser classes. We only
 * ever call `parseStringPromise`, and its result is genuinely unknown-shaped
 * (it mirrors whatever XML arrived), so `unknown` is the honest return type -
 * callers must narrow it, which is exactly what `feedParser.ts` does.
 */
declare module 'xml2js' {
  export type ParserOptions = {
    /** false collapses a lone child element to a bare value instead of a 1-length array. */
    explicitArray?: boolean;
    /** Trim surrounding whitespace from text nodes. */
    trim?: boolean;
    /** Keep the document element as the single top-level key (default true). */
    explicitRoot?: boolean;
    /** Strip namespace prefixes from element names. */
    ignoreAttrs?: boolean;
    /** Key under which element attributes are collected (default '$'). */
    attrkey?: string;
    /** Key under which text content is collected when attributes exist (default '_'). */
    charkey?: string;
  };

  export function parseStringPromise(xml: string, options?: ParserOptions): Promise<unknown>;
}
