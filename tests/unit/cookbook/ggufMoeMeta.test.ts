/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readGgufMoeMeta, type GgufFsProbe } from '@process/services/cookbook/ggufMoeMeta';

/**
 * Build a synthetic GGUF v3 header in memory. Field layout follows the spec
 * the real parser was verified against on four real files (gpt-oss-20b,
 * Qwen3.6-35B-A3B, Qwen2.5-7B, DeepSeek-V4-Flash shard) - see ggufMoeMeta.ts.
 */
type KvValue =
  | { t: 'u32'; v: number }
  | { t: 'i32'; v: number }
  | { t: 'i16'; v: number }
  | { t: 'i8'; v: number }
  | { t: 'u64'; v: number }
  | { t: 'i64'; v: bigint }
  | { t: 'str'; v: string }
  | { t: 'f32'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'strArr'; v: string[] }
  | { t: 'u32Arr'; v: number[] };

function str(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(body.length));
  return Buffer.concat([len, body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function kv(key: string, value: KvValue): Buffer {
  const parts: Buffer[] = [str(key)];
  switch (value.t) {
    case 'u32':
      parts.push(u32(4), u32(value.v));
      break;
    case 'i32': {
      const b = Buffer.alloc(4);
      b.writeInt32LE(value.v);
      parts.push(u32(5), b);
      break;
    }
    case 'i16': {
      const b = Buffer.alloc(2);
      b.writeInt16LE(value.v);
      parts.push(u32(3), b);
      break;
    }
    case 'i8': {
      const b = Buffer.alloc(1);
      b.writeInt8(value.v);
      parts.push(u32(1), b);
      break;
    }
    case 'u64':
      parts.push(u32(10), u64(value.v));
      break;
    case 'i64': {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(value.v);
      parts.push(u32(11), b);
      break;
    }
    case 'str':
      parts.push(u32(8), str(value.v));
      break;
    case 'f32': {
      const b = Buffer.alloc(4);
      b.writeFloatLE(value.v);
      parts.push(u32(6), b);
      break;
    }
    case 'bool':
      parts.push(u32(7), Buffer.from([value.v ? 1 : 0]));
      break;
    case 'strArr':
      parts.push(u32(9), u32(8), u64(value.v.length), ...value.v.map(str));
      break;
    case 'u32Arr':
      parts.push(u32(9), u32(4), u64(value.v.length), ...value.v.map(u32));
      break;
  }
  return Buffer.concat(parts);
}

function ggufFile(kvs: Buffer[], opts: { magic?: number; version?: number } = {}): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt32LE(opts.magic ?? 0x46554747, 0); // 'GGUF'
  head.writeUInt32LE(opts.version ?? 3, 4);
  head.writeBigUInt64LE(BigInt(7), 8); // tensor count (unused by the reader)
  head.writeBigUInt64LE(BigInt(kvs.length), 16);
  return Buffer.concat([head, ...kvs]);
}

/** An in-memory fs seam over one buffer. */
function bufferProbe(data: Buffer): GgufFsProbe {
  return {
    openSync: () => 42,
    readSync: (_fd, out, offset, length, position) => {
      if (position >= data.length) return 0;
      const n = Math.min(length, data.length - position);
      data.copy(out, offset, position, position + n);
      return n;
    },
    closeSync: () => {},
  };
}

describe('readGgufMoeMeta', () => {
  it('reads architecture, block_count and expert_count from a MoE header', () => {
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'qwen35moe' }),
      kv('qwen35moe.block_count', { t: 'u32', v: 40 }),
      kv('qwen35moe.expert_count', { t: 'u32', v: 256 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file))).toEqual({
      architecture: 'qwen35moe',
      blockCount: 40,
      expertCount: 256,
      isMoe: true,
    });
  });

  it('answers isMoe false for a dense model that states no expert_count', () => {
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'qwen2' }),
      kv('qwen2.block_count', { t: 'u32', v: 28 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file))).toEqual({
      architecture: 'qwen2',
      blockCount: 28,
      expertCount: null,
      isMoe: false,
    });
  });

  it('survives keys BEFORE the architecture facts, tokenizer.chat_template included', () => {
    // The real DeepSeek-V4-Flash shard (an Unsloth re-quant) writes
    // tokenizer.chat_template as its SECOND key, 17 keys before block_count.
    // A "stop at tokenizer." shortcut answered blockCount: null for it.
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'deepseek4' }),
      kv('tokenizer.chat_template', { t: 'str', v: '{%- for m in messages %}...{%- endfor %}' }),
      kv('general.tags', { t: 'strArr', v: ['unsloth', 'deepseek'] }),
      kv('general.sampling.top_p', { t: 'f32', v: 1.0 }),
      kv('deepseek4.block_count', { t: 'u32', v: 43 }),
      kv('deepseek4.expert_count', { t: 'u32', v: 256 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file))).toEqual({
      architecture: 'deepseek4',
      blockCount: 43,
      expertCount: 256,
      isMoe: true,
    });
  });

  it('skips unrelated value shapes (bool, u64, numeric arrays) without derailing', () => {
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'gpt-oss' }),
      kv('general.some_flag', { t: 'bool', v: true }),
      kv('general.file_size', { t: 'u64', v: 13_000_000_000 }),
      kv('gpt-oss.rope.dims', { t: 'u32Arr', v: [1, 2, 3, 4] }),
      kv('gpt-oss.block_count', { t: 'u32', v: 24 }),
      kv('gpt-oss.expert_count', { t: 'u32', v: 32 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file)).blockCount).toBe(24);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file)).expertCount).toBe(32);
  });

  it('answers empty for a non-GGUF file instead of throwing', () => {
    const notGguf = Buffer.from('MZ\x90\x00 definitely not a gguf header padding padding');
    expect(readGgufMoeMeta('/x.exe', bufferProbe(notGguf))).toEqual({
      architecture: '',
      blockCount: null,
      expertCount: null,
      isMoe: false,
    });
  });

  it('answers empty for an unsupported header version', () => {
    const file = ggufFile([kv('general.architecture', { t: 'str', v: 'x' })], { version: 1 });
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file)).architecture).toBe('');
  });

  it('answers empty when the file cannot be opened', () => {
    const probe: GgufFsProbe = {
      openSync: () => {
        throw new Error('ENOENT');
      },
      readSync: () => 0,
      closeSync: () => {},
    };
    expect(readGgufMoeMeta('/missing.gguf', probe)).toEqual({
      architecture: '',
      blockCount: null,
      expertCount: null,
      isMoe: false,
    });
  });

  it('answers null for a signed -1, never 4294967295', () => {
    // The measured failure: Int32 -1 decoded unsigned became blockCount
    // 4294967295, the bench-failure fallback then passed
    // `--n-cpu-moe 4294967295`, llama-server's parser looped over it for tens
    // of seconds, and the 20 s readiness fallback declared the hung process
    // 'ready'. Signed types must decode signed, and a negative is not a count.
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'broken' }),
      kv('broken.block_count', { t: 'i32', v: -1 }),
      kv('broken.expert_count', { t: 'i32', v: -1 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(file))).toEqual({
      architecture: 'broken',
      blockCount: null,
      expertCount: null,
      isMoe: false,
    });
  });

  it('reads positive signed values correctly across widths', () => {
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'signed' }),
      kv('signed.block_count', { t: 'i32', v: 40 }),
      kv('signed.expert_count', { t: 'i16', v: 256 }),
    ]);
    const meta = readGgufMoeMeta('/x.gguf', bufferProbe(file));
    expect(meta.blockCount).toBe(40);
    expect(meta.expertCount).toBe(256);
    expect(meta.isMoe).toBe(true);
  });

  it('rejects counts outside the 1..1024 sanity bounds', () => {
    // Real models sit at 24-94 layers / 8-384 experts. A count of 0, or one in
    // the billions, is a mis-parse or a corrupt header - and it is exactly the
    // number the fallback would hand llama-server as `--n-cpu-moe`.
    const tooBig = ggufFile([
      kv('general.architecture', { t: 'str', v: 'corrupt' }),
      kv('corrupt.block_count', { t: 'u32', v: 4_294_967_295 }),
      kv('corrupt.expert_count', { t: 'u64', v: 1_000_000 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(tooBig))).toEqual({
      architecture: 'corrupt',
      blockCount: null,
      expertCount: null,
      isMoe: false,
    });

    const zero = ggufFile([
      kv('general.architecture', { t: 'str', v: 'zeroed' }),
      kv('zeroed.block_count', { t: 'u32', v: 0 }),
    ]);
    expect(readGgufMoeMeta('/x.gguf', bufferProbe(zero)).blockCount).toBeNull();
  });

  it('answers null for a negative Int64 without derailing the scan', () => {
    const file = ggufFile([
      kv('general.architecture', { t: 'str', v: 'wide' }),
      kv('wide.block_count', { t: 'i64', v: BigInt(-1) }),
      kv('wide.expert_count', { t: 'u32', v: 32 }),
    ]);
    const meta = readGgufMoeMeta('/x.gguf', bufferProbe(file));
    // The negative consumed its 8 bytes and answered null; the scan carried on
    // and still found the key after it.
    expect(meta.blockCount).toBeNull();
    expect(meta.expertCount).toBe(32);
  });

  it('answers what it has for a header truncated mid-value', () => {
    const whole = ggufFile([
      kv('general.architecture', { t: 'str', v: 'qwen35moe' }),
      kv('qwen35moe.block_count', { t: 'u32', v: 40 }),
      kv('qwen35moe.expert_count', { t: 'u32', v: 256 }),
    ]);
    // Cut inside the expert_count value: block_count must still be reported.
    const truncated = whole.subarray(0, whole.length - 2);
    const meta = readGgufMoeMeta('/x.gguf', bufferProbe(Buffer.from(truncated)));
    expect(meta.blockCount).toBe(40);
    expect(meta.expertCount).toBeNull();
  });
});
