/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal GGUF header reader for the two facts the MoE offload path needs:
 * how many transformer blocks the model has, and whether it is a
 * Mixture-of-Experts model at all.
 *
 * WHY A PARSER AND NOT THE CATALOG. The catalog does carry `isMoe`, and the
 * serve path uses it as a hint - but no catalog row carries the LAYER COUNT,
 * and the `--n-cpu-moe` candidate points are fractions of exactly that number.
 * The GGUF file itself states it: `<arch>.block_count` and
 * `<arch>.expert_count` sit in the metadata section of the header. MEASURED on
 * four real GGUFs (2026-08-17, this machine):
 *
 *   openai_gpt-oss-20b.gguf            gpt-oss    block_count=24  expert_count=32
 *   Qwen3.6-35B-A3B (Q4_K_M)           qwen35moe  block_count=40  expert_count=256
 *   Qwen_Qwen2.5-7B-Instruct.gguf      qwen2      block_count=28  (no expert_count)
 *   DeepSeek-V4-Flash (Q2_K_XL shard)  deepseek4  block_count=43  expert_count=256
 *
 * ONLY THE HEAD OF THE FILE IS READ. The metadata section precedes all tensor
 * data, so a 49 GB shard costs the same to answer as a 379 MB one: the reader
 * streams fixed-size chunks from the start and stops as soon as both facts are
 * known. Values it does not care about are skipped, not decoded. There is
 * deliberately NO "stop at the tokenizer section" shortcut: the DeepSeek shard
 * above (an Unsloth re-quant) writes `tokenizer.chat_template` as its SECOND
 * key, seventeen keys before `deepseek4.block_count` - a stop there answered
 * `blockCount: null` for a 43-layer model. Key order is a convention of the
 * writer, not the format.
 *
 * Everything is synchronous by design: the one caller sits on the serve path
 * right after a multi-second GGUF download, and the read is a few chunks of a
 * local file. The fs seam is injectable so tests never touch the disk.
 */

import fs from 'node:fs';

/** GGUF magic bytes: ASCII "GGUF". */
const GGUF_MAGIC = 0x46554747;
/** GGUF header versions this reader understands (v2 added uint64 counts... v3 current). */
const SUPPORTED_VERSIONS = new Set([2, 3]);
/** Bytes fetched per read; metadata keys of interest land in the first chunk in practice. */
const CHUNK_BYTES = 1024 * 1024;
/**
 * Hard ceiling on how much of the file the reader will ever fetch. The
 * architecture keys precede the tokenizer arrays in every llama.cpp-written
 * GGUF, so hitting this means the file is not one - refusing is honest, and it
 * bounds the cost on a hostile or corrupt file.
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** GGUF metadata value-type ids (spec order). */
const enum GgufType {
  Uint8 = 0,
  Int8 = 1,
  Uint16 = 2,
  Int16 = 3,
  Uint32 = 4,
  Int32 = 5,
  Float32 = 6,
  Bool = 7,
  String = 8,
  Array = 9,
  Uint64 = 10,
  Int64 = 11,
  Float64 = 12,
}

/** Fixed byte width per scalar type; strings and arrays are length-prefixed. */
const SCALAR_BYTES: Partial<Record<number, number>> = {
  [GgufType.Uint8]: 1,
  [GgufType.Int8]: 1,
  [GgufType.Uint16]: 2,
  [GgufType.Int16]: 2,
  [GgufType.Uint32]: 4,
  [GgufType.Int32]: 4,
  [GgufType.Float32]: 4,
  [GgufType.Bool]: 1,
  [GgufType.Uint64]: 8,
  [GgufType.Int64]: 8,
  [GgufType.Float64]: 8,
};

/** What the header said about the model, or why it could not say. */
export type GgufMoeMeta = {
  /** `general.architecture`, e.g. "qwen35moe"; '' when the key was absent. */
  architecture: string;
  /** `<arch>.block_count` - transformer layers; null when not stated. */
  blockCount: number | null;
  /** `<arch>.expert_count`; null when not stated (dense models omit it). */
  expertCount: number | null;
  /** True when the header states a positive expert count. */
  isMoe: boolean;
};

/** Injectable filesystem seam (sync, positional reads). */
export type GgufFsProbe = {
  openSync: (path: string) => number;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
};

export const defaultGgufFsProbe: GgufFsProbe = {
  openSync: (p) => fs.openSync(p, 'r'),
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
};

/** Buffered forward-only reader over the head of the file. */
class HeadReader {
  private buf = Buffer.alloc(0);
  private filePos = 0;
  private cursor = 0;
  private eof = false;

  constructor(
    private readonly fd: number,
    private readonly probe: GgufFsProbe
  ) {}

  /** Ensure `n` unread bytes are buffered; false at EOF or past the scan cap. */
  private ensure(n: number): boolean {
    while (this.buf.length - this.cursor < n) {
      if (this.eof || this.filePos >= MAX_SCAN_BYTES) return false;
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const got = this.probe.readSync(this.fd, chunk, 0, CHUNK_BYTES, this.filePos);
      if (got <= 0) {
        this.eof = true;
        return false;
      }
      this.filePos += got;
      // Drop consumed bytes so the buffer stays bounded by ~2 chunks.
      this.buf = Buffer.concat([this.buf.subarray(this.cursor), chunk.subarray(0, got)]);
      this.cursor = 0;
    }
    return true;
  }

  readU8(): number | null {
    if (!this.ensure(1)) return null;
    const v = this.buf[this.cursor];
    this.cursor += 1;
    return v;
  }

  readU32(): number | null {
    if (!this.ensure(4)) return null;
    const v = this.buf.readUInt32LE(this.cursor);
    this.cursor += 4;
    return v;
  }

  /** uint64 as a JS number; header counts never approach 2^53 in practice. */
  readU64(): number | null {
    if (!this.ensure(8)) return null;
    const v = this.buf.readBigUInt64LE(this.cursor);
    this.cursor += 8;
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
  }

  /**
   * int64 as a JS number; null when negative or past 2^53. The bytes are
   * consumed either way, so the scan continues correctly past a value this
   * reader refuses to answer with.
   */
  readI64(): number | null {
    if (!this.ensure(8)) return null;
    const v = this.buf.readBigInt64LE(this.cursor);
    this.cursor += 8;
    return v < BigInt(0) || v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
  }

  readString(): string | null {
    const len = this.readU64();
    if (len === null || len > MAX_SCAN_BYTES) return null;
    if (!this.ensure(len)) return null;
    const s = this.buf.toString('utf8', this.cursor, this.cursor + len);
    this.cursor += len;
    return s;
  }

  /** Skip `n` bytes without decoding them (still bounded by the scan cap). */
  skip(n: number): boolean {
    if (!this.ensure(n)) return false;
    this.cursor += n;
    return true;
  }
}

/**
 * Read one metadata value as a NON-NEGATIVE integer, or null for other shapes.
 * Signed types decode signed and a negative answers null - the measured trap
 * was Int32 `-1` decoded unsigned into 4294967295, which then rode the
 * bench-failure fallback into `--n-cpu-moe 4294967295` (see the caller). The
 * value's bytes are consumed on every branch, so the scan continues correctly.
 */
function readIntValue(r: HeadReader, type: number): number | null {
  switch (type) {
    case GgufType.Uint8:
    case GgufType.Int8:
    case GgufType.Uint16:
    case GgufType.Int16:
    case GgufType.Uint32:
    case GgufType.Int32: {
      const value = readNarrowInt(r, type);
      return value !== null && value >= 0 ? value : null;
    }
    case GgufType.Uint64:
      return r.readU64();
    case GgufType.Int64:
      return r.readI64();
    default:
      // Not an integer shape; consume it so the scan can continue.
      skipValue(r, type);
      return null;
  }
}

/** Decode a 1/2/4-byte little-endian integer IN ITS OWN SIGNEDNESS, in place. */
function readNarrowInt(r: HeadReader, type: number): number | null {
  if (type === GgufType.Uint32) return r.readU32();
  const width = SCALAR_BYTES[type];
  if (width === undefined || width > 4) return null;
  const tmp = Buffer.alloc(4);
  for (let i = 0; i < width; i++) {
    const byte = r.readU8();
    if (byte === null) return null;
    tmp[i] = byte;
  }
  switch (type) {
    case GgufType.Int8:
      return tmp.readInt8(0);
    case GgufType.Int16:
      return tmp.readInt16LE(0);
    case GgufType.Int32:
      return tmp.readInt32LE(0);
    default:
      return tmp.readUIntLE(0, width);
  }
}

/** Advance past a value of `type` without decoding it. False when truncated. */
function skipValue(r: HeadReader, type: number): boolean {
  const width = SCALAR_BYTES[type];
  if (width !== undefined) return r.skip(width);
  if (type === GgufType.String) {
    const s = r.readString();
    return s !== null;
  }
  if (type === GgufType.Array) {
    const elemType = r.readU32();
    const count = r.readU64();
    if (elemType === null || count === null) return false;
    const elemWidth = SCALAR_BYTES[elemType];
    if (elemWidth !== undefined) return r.skip(elemWidth * count);
    if (elemType === GgufType.String) {
      for (let i = 0; i < count; i++) {
        if (r.readString() === null) return false;
      }
      return true;
    }
    // Nested arrays do not occur in llama.cpp GGUFs; refuse rather than guess.
    return false;
  }
  return false;
}

const EMPTY_META: GgufMoeMeta = { architecture: '', blockCount: null, expertCount: null, isMoe: false };

/**
 * Sanity bounds for `block_count` / `expert_count`. The real corpus this
 * reader was verified on sits at 24-43 layers and 32-256 experts; published
 * models top out well under a thousand of either, so 1..1024 leaves headroom
 * without admitting garbage. The stake is not cosmetic: `blockCount` becomes
 * `--n-cpu-moe <n>` verbatim on the bench-failure fallback, and a corrupt
 * 4294967295 sent llama-server's argument parser into a loop long enough for
 * the 20 s readiness fallback to declare the hung process 'ready'. Out of
 * bounds reads as "the header could not say" - the same honest null as a
 * missing key, which the serve answers by keeping its existing behaviour.
 */
const SANE_COUNT_MIN = 1;
const SANE_COUNT_MAX = 1024;

/** `value` when it is a plausible layer/expert count, else null. */
function saneCount(value: number | null): number | null {
  if (value === null) return null;
  return value >= SANE_COUNT_MIN && value <= SANE_COUNT_MAX ? value : null;
}

/**
 * Read `general.architecture`, `<arch>.block_count` and `<arch>.expert_count`
 * from a GGUF file's metadata section. Never throws: an unreadable, truncated
 * or non-GGUF file answers with the empty meta, because the caller's fallback
 * (serve without expert offload) is the right response to every failure mode
 * here and an exception would fail the whole serve over an optimisation.
 */
export function readGgufMoeMeta(filePath: string, probe: GgufFsProbe = defaultGgufFsProbe): GgufMoeMeta {
  let fd: number;
  try {
    fd = probe.openSync(filePath);
  } catch {
    return { ...EMPTY_META };
  }
  try {
    return parseHead(new HeadReader(fd, probe));
  } catch {
    return { ...EMPTY_META };
  } finally {
    probe.closeSync(fd);
  }
}

function parseHead(r: HeadReader): GgufMoeMeta {
  const magic = r.readU32();
  const version = r.readU32();
  if (magic !== GGUF_MAGIC || version === null || !SUPPORTED_VERSIONS.has(version)) {
    return { ...EMPTY_META };
  }
  const tensorCount = r.readU64();
  const kvCount = r.readU64();
  if (tensorCount === null || kvCount === null) return { ...EMPTY_META };

  let architecture = '';
  let blockCount: number | null = null;
  let expertCount: number | null = null;

  for (let i = 0; i < kvCount; i++) {
    const key = r.readString();
    const type = r.readU32();
    if (key === null || type === null) break;

    if (key === 'general.architecture' && type === GgufType.String) {
      architecture = r.readString() ?? '';
    } else if (architecture !== '' && key === `${architecture}.block_count`) {
      blockCount = saneCount(readIntValue(r, type));
    } else if (architecture !== '' && key === `${architecture}.expert_count`) {
      expertCount = saneCount(readIntValue(r, type));
    } else if (!skipValue(r, type)) {
      break;
    }
    if (blockCount !== null && expertCount !== null) break;
  }

  return {
    architecture,
    blockCount,
    expertCount,
    isMoe: expertCount !== null && expertCount > 0,
  };
}
