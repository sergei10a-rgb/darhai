/**
 * Dependency-free WOFF2 -> `cmap` reader.
 *
 * The renderer ships its UI font as a set of Brotli-compressed WOFF2 subsets
 * (see `@fontsource-variable/inter`). To prove mechanically that a given
 * character can actually be drawn we have to look inside those files and read
 * the font's character-to-glyph map. No font parser is available in this repo's
 * dependency tree, and adding one is not allowed, so the small slice of the
 * WOFF2 + OpenType specs we need is implemented here:
 *
 *  - WOFF2 container   https://www.w3.org/TR/WOFF2/
 *  - OpenType `cmap`   https://learn.microsoft.com/typography/opentype/spec/cmap
 *
 * Only reading is implemented; the font is never reconstructed. That is enough
 * because the `cmap` table is never transformed by the WOFF2 encoder (only
 * `glyf`, `loca` and `hmtx` have transforms), so its bytes appear verbatim in
 * the decompressed stream at a position we can compute from the table
 * directory.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

/** Inclusive codepoint interval, as used by CSS `unicode-range`. */
export type UnicodeRange = {
  readonly start: number;
  readonly end: number;
};

/** A single `@font-face` rule from a Fontsource stylesheet. */
export type FontFaceDeclaration = {
  /** File name relative to the package's `files/` directory. */
  readonly file: string;
  /** Codepoint intervals the browser will use this file for. */
  readonly ranges: readonly UnicodeRange[];
};

/**
 * WOFF2 "known table tags", indexed by the 6-bit tag index stored in each
 * table directory entry. Index 63 means an explicit 4-byte tag follows.
 * Order is normative - see WOFF2 spec, "Table Directory Format".
 */
const KNOWN_TABLE_TAGS: readonly string[] = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

const WOFF2_SIGNATURE = 'wOF2';
const WOFF2_HEADER_SIZE = 48;
const TAG_INDEX_ARBITRARY = 63;
const MAX_BASE128_BYTES = 5;
/** Highest codepoint a format 4 subtable can address. */
const BMP_LIMIT = 0x10000;

type TableEntry = {
  readonly tag: string;
  /** Length of this table's bytes inside the decompressed stream. */
  readonly streamLength: number;
};

type Base128Result = {
  readonly value: number;
  readonly nextOffset: number;
};

/** Reads the WOFF2 variable-length UIntBase128 integer at `offset`. */
function readUIntBase128(buffer: Buffer, offset: number): Base128Result {
  let value = 0;

  for (let i = 0; i < MAX_BASE128_BYTES; i++) {
    if (offset + i >= buffer.length) {
      throw new Error('WOFF2: UIntBase128 runs past end of buffer');
    }
    const byte = buffer[offset + i];
    // A leading 0x80 byte would encode a redundant leading zero.
    if (i === 0 && byte === 0x80) {
      throw new Error('WOFF2: UIntBase128 has a leading zero');
    }
    if ((value & 0xfe000000) !== 0) {
      throw new Error('WOFF2: UIntBase128 overflows 32 bits');
    }
    value = ((value << 7) | (byte & 0x7f)) >>> 0;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset + i + 1 };
    }
  }

  throw new Error('WOFF2: UIntBase128 longer than 5 bytes');
}

/**
 * A table carries an extra `transformLength` field only when a non-null
 * transform was applied. `glyf`/`loca` invert the convention: for them version
 * 3 is the null transform, for every other table version 0 is.
 */
function isTransformed(tag: string, transformVersion: number): boolean {
  if (tag === 'glyf' || tag === 'loca') {
    return transformVersion !== 3;
  }
  return transformVersion !== 0;
}

/** Parses the WOFF2 table directory that follows the 48-byte header. */
function readTableDirectory(buffer: Buffer, numTables: number): { entries: TableEntry[]; nextOffset: number } {
  const entries: TableEntry[] = [];
  let offset = WOFF2_HEADER_SIZE;

  for (let i = 0; i < numTables; i++) {
    const flags = buffer[offset];
    offset += 1;

    const tagIndex = flags & 0x3f;
    let tag: string;
    if (tagIndex === TAG_INDEX_ARBITRARY) {
      tag = buffer.toString('latin1', offset, offset + 4);
      offset += 4;
    } else {
      tag = KNOWN_TABLE_TAGS[tagIndex];
      if (tag === undefined) {
        throw new Error(`WOFF2: unknown table tag index ${tagIndex}`);
      }
    }

    const transformVersion = (flags >> 6) & 0x03;
    const original = readUIntBase128(buffer, offset);
    offset = original.nextOffset;

    let streamLength = original.value;
    if (isTransformed(tag, transformVersion)) {
      const transformed = readUIntBase128(buffer, offset);
      offset = transformed.nextOffset;
      streamLength = transformed.value;
    }

    entries.push({ tag, streamLength });
  }

  return { entries, nextOffset: offset };
}

/**
 * Returns the raw bytes of one sfnt table from a WOFF2 file.
 *
 * Only meaningful for tables the WOFF2 encoder never transforms - `cmap` is
 * one of them.
 */
export function readWoff2Table(fontPath: string, wantedTag: string): Buffer {
  const buffer = fs.readFileSync(fontPath);

  const signature = buffer.toString('latin1', 0, 4);
  if (signature !== WOFF2_SIGNATURE) {
    throw new Error(`Not a WOFF2 file (signature ${JSON.stringify(signature)}): ${fontPath}`);
  }

  const numTables = buffer.readUInt16BE(12);
  const totalCompressedSize = buffer.readUInt32BE(20);
  const { entries, nextOffset } = readTableDirectory(buffer, numTables);

  const compressed = buffer.subarray(nextOffset, nextOffset + totalCompressedSize);
  const stream = zlib.brotliDecompressSync(compressed);

  const expectedLength = entries.reduce((sum, entry) => sum + entry.streamLength, 0);
  if (stream.length !== expectedLength) {
    // Guards against a directory mis-parse silently yielding garbage tables.
    throw new Error(
      `WOFF2: decompressed ${stream.length} bytes but the table directory accounts for ${expectedLength} (${fontPath})`
    );
  }

  let cursor = 0;
  for (const entry of entries) {
    if (entry.tag === wantedTag) {
      return stream.subarray(cursor, cursor + entry.streamLength);
    }
    cursor += entry.streamLength;
  }

  throw new Error(`WOFF2: table ${wantedTag} not present in ${fontPath}`);
}

/** cmap subtable format 4: segmented mapping to delta values, BMP only. */
function collectFormat4(table: Buffer, offset: number, out: Set<number>): void {
  const segCountX2 = table.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;
  const endCodes = offset + 14;
  const startCodes = endCodes + segCountX2 + 2; // +2 skips `reservedPad`
  const idDeltas = startCodes + segCountX2;
  const idRangeOffsets = idDeltas + segCountX2;

  for (let segment = 0; segment < segCount; segment++) {
    const endCode = table.readUInt16BE(endCodes + segment * 2);
    const startCode = table.readUInt16BE(startCodes + segment * 2);
    const idDelta = table.readInt16BE(idDeltas + segment * 2);
    const idRangeOffset = table.readUInt16BE(idRangeOffsets + segment * 2);

    // The final segment is the required 0xFFFF terminator.
    if (startCode === 0xffff) {
      continue;
    }

    for (let code = startCode; code <= endCode && code < BMP_LIMIT; code++) {
      let glyphId: number;
      if (idRangeOffset === 0) {
        glyphId = (code + idDelta) & 0xffff;
      } else {
        // idRangeOffset is a byte offset from its own slot in the array.
        const glyphIndexAddress = idRangeOffsets + segment * 2 + idRangeOffset + (code - startCode) * 2;
        if (glyphIndexAddress + 1 >= table.length) {
          continue;
        }
        glyphId = table.readUInt16BE(glyphIndexAddress);
        if (glyphId !== 0) {
          glyphId = (glyphId + idDelta) & 0xffff;
        }
      }
      // Glyph 0 is `.notdef` - the tofu box. It is not coverage.
      if (glyphId !== 0) {
        out.add(code);
      }
    }
  }
}

/** cmap subtable format 12: segmented coverage, full Unicode range. */
function collectFormat12(table: Buffer, offset: number, out: Set<number>): void {
  const groupCount = table.readUInt32BE(offset + 12);

  for (let group = 0; group < groupCount; group++) {
    const base = offset + 16 + group * 12;
    const startCharCode = table.readUInt32BE(base);
    const endCharCode = table.readUInt32BE(base + 4);
    const startGlyphId = table.readUInt32BE(base + 8);

    for (let code = startCharCode; code <= endCharCode; code++) {
      if (startGlyphId + (code - startCharCode) !== 0) {
        out.add(code);
      }
    }
  }
}

/** True for the encoding records that map Unicode codepoints. */
function isUnicodeEncoding(platformId: number, encodingId: number): boolean {
  // Platform 0 is Unicode; platform 3 (Windows) uses 1 = BMP, 10 = full repertoire.
  return platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
}

/**
 * Returns every Unicode codepoint the font maps to a real (non-`.notdef`) glyph.
 *
 * Throws on any cmap subtable format it cannot parse, so an unsupported font
 * can never be mistaken for a font with no coverage.
 */
export function readCmapCoverage(fontPath: string): Set<number> {
  const table = readWoff2Table(fontPath, 'cmap');
  const subtableCount = table.readUInt16BE(2);
  const coverage = new Set<number>();
  let parsedSubtables = 0;

  for (let i = 0; i < subtableCount; i++) {
    const record = 4 + i * 8;
    const platformId = table.readUInt16BE(record);
    const encodingId = table.readUInt16BE(record + 2);
    const subtableOffset = table.readUInt32BE(record + 4);

    if (!isUnicodeEncoding(platformId, encodingId)) {
      continue;
    }

    const format = table.readUInt16BE(subtableOffset);
    if (format === 4) {
      collectFormat4(table, subtableOffset, coverage);
    } else if (format === 12) {
      collectFormat12(table, subtableOffset, coverage);
    } else {
      throw new Error(
        `cmap subtable format ${format} is not supported (platform ${platformId}/${encodingId}) in ${fontPath}`
      );
    }
    parsedSubtables += 1;
  }

  if (parsedSubtables === 0) {
    throw new Error(`No Unicode cmap subtable found in ${fontPath}`);
  }

  return coverage;
}

/**
 * Extracts the `src` file name and `unicode-range` of every `@font-face` rule
 * in a Fontsource stylesheet. The `unicode-range` matters: a browser only
 * downloads and uses a subset for codepoints inside its declared range, so
 * real coverage is `cmap ∩ unicode-range`, not `cmap` alone.
 */
export function parseFontFaceDeclarations(css: string): FontFaceDeclaration[] {
  const blocks = css.split('@font-face').slice(1);
  const declarations: FontFaceDeclaration[] = [];

  for (const block of blocks) {
    const srcMatch = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block);
    const rangeMatch = /unicode-range:\s*([^;]+);/.exec(block);
    if (srcMatch === null || rangeMatch === null) {
      throw new Error('@font-face block without a woff2 src or a unicode-range');
    }

    const ranges = rangeMatch[1].split(',').map((raw): UnicodeRange => {
      const parsed = /^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/.exec(raw.trim());
      if (parsed === null) {
        // Wildcard forms such as `U+04??` are valid CSS but Fontsource does not
        // emit them; failing loudly beats silently under-reporting coverage.
        throw new Error(`Unsupported unicode-range syntax: ${raw.trim()}`);
      }
      const start = parseInt(parsed[1], 16);
      const end = parsed[2] === undefined ? start : parseInt(parsed[2], 16);
      return { start, end };
    });

    declarations.push({ file: srcMatch[1], ranges });
  }

  return declarations;
}
