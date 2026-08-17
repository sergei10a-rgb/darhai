/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CALIBRATION_SCHEMA,
  MoeOffloadCalibrator,
  calibrationFilePath,
  decideMoeOffload,
  moeCandidatePoints,
  parseBenchJson,
  pickWinner,
  type MoeCalibratorDeps,
} from '@process/services/cookbook/moeCalibration';
import type { GgufMoeMeta } from '@process/services/cookbook/ggufMoeMeta';

const GB = 1024 * 1024 * 1024;

const MOE_META: GgufMoeMeta = { architecture: 'qwen35moe', blockCount: 40, expertCount: 256, isMoe: true };
const DENSE_META: GgufMoeMeta = { architecture: 'qwen2', blockCount: 28, expertCount: null, isMoe: false };
const UNREADABLE_META: GgufMoeMeta = { architecture: '', blockCount: null, expertCount: null, isMoe: false };

/**
 * A real-shaped `llama-bench -o json` payload. Field names and row shape match
 * the b10441 output captured on the reference machine (each point produces a
 * pp row with n_gen=0 and a tg row with n_prompt=0).
 */
function benchJson(points: Array<{ n: number; pp: number; tg: number }>): string {
  return JSON.stringify(
    points.flatMap((p) => [
      { n_cpu_moe: p.n, n_prompt: 128, n_gen: 0, avg_ts: p.pp },
      { n_cpu_moe: p.n, n_prompt: 0, n_gen: 32, avg_ts: p.tg },
    ])
  );
}

describe('moeCandidatePoints', () => {
  it('answers ~50/75/90/100% of the layers, deduplicated and ascending', () => {
    // 40 layers (the measured Qwen3.6-35B-A3B): 20, 30, 36, 40. The measured
    // optimum 36 sits exactly on the 90% point - that is why 90% is a point.
    expect(moeCandidatePoints(40)).toEqual([20, 30, 36, 40]);
    // 24 layers (gpt-oss-20b): 12, 18, 22, 24.
    expect(moeCandidatePoints(24)).toEqual([12, 18, 22, 24]);
  });

  it('never contains 0 - measured as the worst possible configuration', () => {
    expect(moeCandidatePoints(1)).toEqual([1]);
    expect(moeCandidatePoints(2).every((p) => p >= 1)).toBe(true);
  });

  it('answers [] for a nonsensical layer count', () => {
    expect(moeCandidatePoints(0)).toEqual([]);
    expect(moeCandidatePoints(Number.NaN)).toEqual([]);
  });
});

describe('decideMoeOffload', () => {
  it('needs offload for a MoE model larger than the VRAM budget', () => {
    const d = decideMoeOffload({ meta: MOE_META, isMoeHint: false, fileBytes: 19.7 * GB, vramGb: 8 });
    expect(d).toEqual({ needed: true, blockCount: 40 });
  });

  it('declines for a dense model regardless of size', () => {
    const d = decideMoeOffload({ meta: DENSE_META, isMoeHint: false, fileBytes: 100 * GB, vramGb: 8 });
    expect(d).toEqual({ needed: false, reason: 'dense' });
  });

  it('declines for a MoE model whose weights fit fully resident', () => {
    const small: GgufMoeMeta = { ...MOE_META, blockCount: 24 };
    const d = decideMoeOffload({ meta: small, isMoeHint: false, fileBytes: 3 * GB, vramGb: 8 });
    expect(d).toEqual({ needed: false, reason: 'fits-in-vram' });
  });

  it('uses the catalog hint when the GGUF header could not be read - but still needs a layer count', () => {
    const d = decideMoeOffload({ meta: UNREADABLE_META, isMoeHint: true, fileBytes: 19.7 * GB, vramGb: 8 });
    expect(d).toEqual({ needed: false, reason: 'no-block-count' });
  });

  it('treats an unknown file size as "does not fit" for a MoE model', () => {
    // A stat that failed must not silently skip the 3.4x optimisation.
    const d = decideMoeOffload({ meta: MOE_META, isMoeHint: false, fileBytes: null, vramGb: 8 });
    expect(d).toEqual({ needed: true, blockCount: 40 });
  });

  it('declines on a host with no GPU - there is nothing to offload FROM', () => {
    // `--n-cpu-moe` moves expert tensors OFF a GPU. With vramGb 0 the old
    // budget arithmetic still answered `needed: true`, so every serve of a big
    // MoE model on a GPU-less host ran the ~8-minute sweep (failures are never
    // cached) to measure a flag that cannot help. The pure-CPU serve keeps its
    // existing `-ngl` behaviour untouched.
    expect(decideMoeOffload({ meta: MOE_META, isMoeHint: false, fileBytes: 19.7 * GB, vramGb: 0 })).toEqual({
      needed: false,
      reason: 'no-gpu',
    });
    expect(decideMoeOffload({ meta: MOE_META, isMoeHint: false, fileBytes: null, vramGb: 0 })).toEqual({
      needed: false,
      reason: 'no-gpu',
    });
  });
});

describe('parseBenchJson', () => {
  it('keeps only generation rows, keyed by their n_cpu_moe', () => {
    const out = parseBenchJson(
      benchJson([
        { n: 20, pp: 200, tg: 18.2 },
        { n: 36, pp: 180, tg: 27.8 },
      ])
    );
    expect(out).toEqual([
      { nCpuMoe: 20, tokensPerSec: 18.2 },
      { nCpuMoe: 36, tokensPerSec: 27.8 },
    ]);
  });

  it('answers [] for malformed output instead of throwing', () => {
    expect(parseBenchJson('')).toEqual([]);
    expect(parseBenchJson('ggml_cuda_init: found 1 CUDA device')).toEqual([]);
    expect(parseBenchJson('{"not":"an array"}')).toEqual([]);
  });
});

describe('pickWinner', () => {
  it('elects the fastest measured point', () => {
    expect(
      pickWinner([
        { nCpuMoe: 20, tokensPerSec: 18.2 },
        { nCpuMoe: 36, tokensPerSec: 27.8 },
        { nCpuMoe: 40, tokensPerSec: 16.3 },
      ])
    ).toEqual({ nCpuMoe: 36, tokensPerSec: 27.8 });
  });

  it('answers null for an empty sweep', () => {
    expect(pickWinner([])).toBeNull();
  });
});

// ── The calibrator: cache, sweep, fallback ──────────────────────────────────

type FakeOver = Partial<MoeCalibratorDeps> & { files?: Map<string, string> };

/** In-memory deps: a MoE model that does not fit, a bench that answers. */
function makeDeps(over: FakeOver = {}): { deps: MoeCalibratorDeps; files: Map<string, string> } {
  const files = over.files ?? new Map<string, string>();
  const deps: MoeCalibratorDeps = {
    execBench: vi.fn(async () =>
      benchJson([
        { n: 20, pp: 210, tg: 18.2 },
        { n: 30, pp: 195, tg: 22.4 },
        { n: 36, pp: 180, tg: 27.8 },
        { n: 40, pp: 170, tg: 16.3 },
      ])
    ),
    readMeta: () => ({ ...MOE_META }),
    fileSizeBytes: () => 19.7 * GB,
    readCacheFile: (p) => files.get(p) ?? null,
    writeCacheFile: (p, content) => {
      files.set(p, content);
    },
    now: () => new Date('2026-08-17T00:00:00Z'),
    ...over,
  };
  return { deps, files };
}

const REQ = {
  modelId: 'Qwen/Qwen3.6-35B-A3B',
  ggufPath: '/models/qwen.gguf',
  isMoeHint: true,
  gpuName: 'NVIDIA GeForce RTX 4070 Laptop GPU',
  vramGb: 8,
};

function makeCalibrator(deps: MoeCalibratorDeps, benchBinary: string | null = '/bin/llama-bench') {
  return new MoeOffloadCalibrator({ userDataDir: () => '/ud', resolveBenchBinary: () => benchBinary }, deps);
}

describe('MoeOffloadCalibrator.resolveNCpuMoe', () => {
  it('measures once, elects the fastest point, and caches it', async () => {
    const { deps, files } = makeDeps();
    const onCalibrating = vi.fn();
    const calibrator = makeCalibrator(deps);

    const n = await calibrator.resolveNCpuMoe({ ...REQ, onCalibrating });

    expect(n).toBe(36);
    expect(onCalibrating).toHaveBeenCalledTimes(1);
    expect(deps.execBench).toHaveBeenCalledTimes(1);
    // The sweep asks llama-bench for all candidate points in ONE process.
    const args = (deps.execBench as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args[args.indexOf('-ncmoe') + 1]).toBe('20,30,36,40');
    expect(args[args.indexOf('-m') + 1]).toBe('/models/qwen.gguf');
    // The winner landed in the cache file, with the sweep that elected it.
    const written = JSON.parse(files.get(calibrationFilePath('/ud')) ?? 'null');
    expect(written.schema).toBe(CALIBRATION_SCHEMA);
    expect(written.entries[0].nCpuMoe).toBe(36);
    expect(written.entries[0].measured).toHaveLength(4);
  });

  it('answers from the cache in zero measurements on the second serve', async () => {
    const { deps } = makeDeps();
    const calibrator = makeCalibrator(deps);
    await calibrator.resolveNCpuMoe({ ...REQ });

    const onCalibrating = vi.fn();
    const n = await calibrator.resolveNCpuMoe({ ...REQ, onCalibrating });

    expect(n).toBe(36);
    expect(onCalibrating).not.toHaveBeenCalled();
    expect(deps.execBench).toHaveBeenCalledTimes(1); // still just the first run
  });

  it('re-measures for a different GPU - the cache key is model + GPU + VRAM', async () => {
    const { deps } = makeDeps();
    const calibrator = makeCalibrator(deps);
    await calibrator.resolveNCpuMoe({ ...REQ });
    // 19.7 GB does not fit a 16 GB card either, so this card needs its OWN
    // measurement; the 8 GB entry must not answer for it.
    await calibrator.resolveNCpuMoe({ ...REQ, gpuName: 'NVIDIA GeForce RTX 5080', vramGb: 16 });
    expect(deps.execBench).toHaveBeenCalledTimes(2);
  });

  it('falls back to all layers when the bench fails, and does NOT cache the failure', async () => {
    const { deps, files } = makeDeps({
      execBench: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    const calibrator = makeCalibrator(deps);

    const n = await calibrator.resolveNCpuMoe({ ...REQ });

    // All 40 layers: measured at 16.3 tok/s on the Qwen - still 2x better
    // than the 8.3 of plain -ngl 99.
    expect(n).toBe(40);
    expect(files.size).toBe(0);
    // The next serve retries the measurement instead of reusing the failure.
    await calibrator.resolveNCpuMoe({ ...REQ });
    expect(deps.execBench).toHaveBeenCalledTimes(2);
  });

  it('falls back to all layers when no llama-bench exists next to the server', async () => {
    const { deps } = makeDeps();
    const calibrator = makeCalibrator(deps, null);
    const onCalibrating = vi.fn();
    const n = await calibrator.resolveNCpuMoe({ ...REQ, onCalibrating });
    expect(n).toBe(40);
    // Nothing was measured, so nothing was announced as calibrating.
    expect(onCalibrating).not.toHaveBeenCalled();
    expect(deps.execBench).not.toHaveBeenCalled();
  });

  it('answers null (no flag) for a dense model', async () => {
    const { deps } = makeDeps({ readMeta: () => ({ ...DENSE_META }) });
    const calibrator = makeCalibrator(deps);
    const n = await calibrator.resolveNCpuMoe({ ...REQ, isMoeHint: false });
    expect(n).toBeNull();
    expect(deps.execBench).not.toHaveBeenCalled();
  });

  it('answers null for a MoE model that fits fully in VRAM', async () => {
    const { deps } = makeDeps({ fileSizeBytes: () => 3 * GB });
    const calibrator = makeCalibrator(deps);
    const n = await calibrator.resolveNCpuMoe({ ...REQ });
    expect(n).toBeNull();
  });

  it('survives a corrupt cache file by re-measuring', async () => {
    const files = new Map<string, string>([[calibrationFilePath('/ud'), '{not json']]);
    const { deps } = makeDeps({ files });
    const calibrator = makeCalibrator(deps);
    const n = await calibrator.resolveNCpuMoe({ ...REQ });
    expect(n).toBe(36);
    expect(deps.execBench).toHaveBeenCalledTimes(1);
  });

  it('treats unparseable bench output as a failed sweep (fallback, not cached)', async () => {
    const { deps, files } = makeDeps({ execBench: vi.fn(async () => 'CUDA error: out of memory') });
    const calibrator = makeCalibrator(deps);
    const n = await calibrator.resolveNCpuMoe({ ...REQ });
    expect(n).toBe(40);
    expect(files.size).toBe(0);
  });

  it('answers null on a GPU-less host without ever launching the bench', async () => {
    const { deps } = makeDeps();
    const calibrator = makeCalibrator(deps);
    const onCalibrating = vi.fn();
    const n = await calibrator.resolveNCpuMoe({ ...REQ, gpuName: null, vramGb: 0, onCalibrating });
    expect(n).toBeNull();
    expect(deps.execBench).not.toHaveBeenCalled();
    expect(onCalibrating).not.toHaveBeenCalled();
  });
});

/**
 * The bench is a real child process holding a 20-50 GB model mapped, and on
 * Windows a parent's death does NOT take the child with it. `cancel()` is the
 * handle the serve layer's stop paths (stopServe / before-quit stopAll) pull:
 * it aborts the in-flight sweep through the AbortSignal that
 * `deps.execBench` receives, and an aborted sweep is a failed sweep - the
 * fallback answer, never a cache entry.
 */
describe('MoeOffloadCalibrator.cancel', () => {
  it('aborts the in-flight bench through its signal, and the sweep is not cached', async () => {
    let seen: AbortSignal | null = null;
    const execBench = vi.fn(
      (_binary: string, _args: string[], _timeoutMs: number, signal: AbortSignal): Promise<string> => {
        seen = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('bench aborted')));
        });
      }
    );
    const { deps, files } = makeDeps({ execBench: execBench as unknown as MoeCalibratorDeps['execBench'] });
    const calibrator = makeCalibrator(deps);

    // resolveNCpuMoe reaches execBench synchronously (meta/cache reads are
    // sync), so the signal is already captured by the time this returns.
    const inflight = calibrator.resolveNCpuMoe({ ...REQ });
    expect(seen).not.toBeNull();

    expect(calibrator.cancel()).toBe(true);
    const n = await inflight;

    expect((seen as unknown as AbortSignal).aborted).toBe(true);
    // The abort lands as a failed sweep: the measured all-layers fallback,
    // never cached, so the next serve re-measures.
    expect(n).toBe(40);
    expect(files.size).toBe(0);
  });

  it('answers false when no sweep is running, so stop paths can call it blindly', () => {
    const { deps } = makeDeps();
    expect(makeCalibrator(deps).cancel()).toBe(false);
  });
});
