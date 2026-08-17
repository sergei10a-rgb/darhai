/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measured `--n-cpu-moe` calibration for MoE models that do not fit in VRAM.
 *
 * WHY THIS EXISTS. For a Mixture-of-Experts model larger than VRAM, `-ngl` is
 * the wrong knob: the useful one moves EXPERT tensors to the CPU while keeping
 * attention on the GPU. MEASURED on the reference machine (RTX 4070 Laptop
 * 8 GB, llama.cpp b10441):
 *
 *   Qwen3.6-35B-A3B Q4_K_M (19.7 GB, 40 layers):
 *     `-ngl 99` alone          8.3 tok/s   (WORSE than pure CPU's 11.4)
 *     `-ngl 99 --n-cpu-moe 36` 27.8 tok/s  (3.4x)
 *     `-ngl 99 --n-cpu-moe 40` 16.3 tok/s  (all layers - the safe fallback)
 *   gpt-oss-20b F16 (12.8 GB, 24 layers), llama-bench tg32, r=2, 2026-08-17:
 *     n_cpu_moe 12 -> 23.8   16 -> 21.4   18 -> 21.5   20 -> 19.8   24 -> 18.9
 *
 * The optimum is model- AND machine-specific (90% of the layers for the Qwen,
 * 50% for gpt-oss) and there is no formula, so this module MEASURES: it runs
 * the `llama-bench` that ships in the same managed install over a handful of
 * candidate points, picks the fastest, and caches the answer in
 * `<userData>/llamacpp/calibration.json` keyed by model + GPU + VRAM. One
 * calibration costs ~1-3 minutes; every later serve of that model reads the
 * cache in zero time.
 *
 * WHY llama-bench AND NOT llama-fit-params. The same install ships
 * `llama-fit-params`, which PREDICTS a placement from free VRAM and tensor
 * sizes in ~7.5 s. Measured head-to-head on gpt-oss-20b (see the numbers in
 * git history / the task report): its suggestion is a computation, not a
 * measurement, it emits `-ot` tensor regexes plus a clamped `-c 4096` rather
 * than a `--n-cpu-moe` count, and the sweep's winner beat it. A once-per-model
 * cached measurement buys the real optimum for one extra minute, once.
 *
 * FAILURE IS NEVER FATAL AND NEVER CACHED. A bench that times out, cannot be
 * found, or prints something unparseable falls back to `--n-cpu-moe
 * <blockCount>` - all expert layers on the CPU - which was measured at 16.3
 * tok/s on the Qwen versus 8.3 for plain `-ngl 99`, so the fallback is still
 * 2x better than not offloading at all. The failure is not written to the
 * cache (same principle as the `--help` probe in LocalServeManager: a failed
 * measurement is not evidence about the model), so the next serve retries.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { readGgufMoeMeta, type GgufMoeMeta } from './ggufMoeMeta';

/** Cache file, beside the managed installs it calibrates for. */
export const CALIBRATION_FILE_NAME = 'calibration.json';
/** Bump when the entry shape changes; an unknown schema reads as empty. */
export const CALIBRATION_SCHEMA = 1;

/**
 * Candidate points as fractions of the layer count. 50/75/100% bracket the
 * space; 90% is there because the measured Qwen optimum (36 of 40) sits
 * exactly on it and neither 75% nor 100% comes close (27.8 vs 16.3 tok/s).
 */
const CANDIDATE_FRACTIONS = [0.5, 0.75, 0.9, 1] as const;

/**
 * Ceiling for one whole calibration run (a single llama-bench process that
 * loads the model once per candidate point). Four points at the measured
 * ~20-40 s each plus load time fits well inside; a bench still running at the
 * ceiling is killed and the serve falls back.
 */
const BENCH_TIMEOUT_MS = 8 * 60 * 1000;

/** llama-bench invocation: short prompt+gen, 2 repetitions, JSON out. */
const BENCH_FIXED_ARGS = ['-ngl', '99', '-p', '128', '-n', '32', '-r', '2', '-o', 'json'] as const;

/**
 * Fraction of the card's VRAM the model weights may occupy before expert
 * offload is worth measuring. A desktop session already holds ~2 GB of an
 * 8 GB card (measured in docs/architecture/local-models.md §5), and llama.cpp
 * still needs KV-cache room, so a model whose weights exceed this fraction
 * will not run fully resident and `-ngl auto` alone was measured SLOWER than
 * pure CPU on such a model.
 */
const VRAM_USABLE_FRACTION = 0.8;
const BYTES_PER_GB = 1024 * 1024 * 1024;

/** One measured candidate point. */
export type MoeCalibrationMeasurement = { nCpuMoe: number; tokensPerSec: number };

/** One cached calibration: the winner, and the sweep that elected it. */
export type MoeCalibrationEntry = {
  modelId: string;
  gpuName: string;
  vramGb: number;
  blockCount: number;
  /** The winning `--n-cpu-moe` value. */
  nCpuMoe: number;
  /** The full sweep, kept so a report can show WHY this value won. */
  measured: MoeCalibrationMeasurement[];
  calibratedAt: string;
};

export type MoeCalibrationFile = { schema: number; entries: MoeCalibrationEntry[] };

/** Whether the serve needs expert offload at all, and what it knows if so. */
export type MoeOffloadDecision =
  | { needed: false; reason: 'dense' | 'fits-in-vram' | 'no-block-count' | 'no-gpu' }
  | { needed: true; blockCount: number };

/** Injectable seams: process execution + filesystem + clock. */
export type MoeCalibratorDeps = {
  /**
   * Run `binary args` and resolve its stdout; reject on failure/timeout, and
   * reject on `signal` abort - that is how {@link MoeOffloadCalibrator.cancel}
   * reaches a bench that is already running.
   */
  execBench: (binary: string, args: string[], timeoutMs: number, signal: AbortSignal) => Promise<string>;
  /** Read the GGUF header facts (default: the real streaming reader). */
  readMeta: (ggufPath: string) => GgufMoeMeta;
  fileSizeBytes: (p: string) => number | null;
  readCacheFile: (p: string) => string | null;
  writeCacheFile: (p: string, content: string) => void;
  now: () => Date;
};

const execFileAsync = promisify(execFile);

export const defaultMoeCalibratorDeps: MoeCalibratorDeps = {
  execBench: async (binary, args, timeoutMs, signal) => {
    const { stdout } = await execFileAsync(binary, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      // `cancel()` aborts through this: execFile kills the child with its
      // killSignal (SIGTERM; on Windows any signal terminates the process).
      // llama-bench spawns no children of its own, so there is no tree to
      // walk - unlike the long-lived servers LocalServeManager escalates
      // SIGTERM -> SIGKILL on. Without this handle the bench outlived the app:
      // on Windows a parent's death does not reap the child, and a bench holds
      // a 20-50 GB model mapped for minutes.
      signal,
    });
    return stdout;
  },
  readMeta: (p) => readGgufMoeMeta(p),
  fileSizeBytes: (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return null;
    }
  },
  readCacheFile: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  writeCacheFile: (p, content) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  },
  now: () => new Date(),
};

/** Absolute path of the calibration cache under this userData. */
export function calibrationFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'llamacpp', CALIBRATION_FILE_NAME);
}

/**
 * Candidate `--n-cpu-moe` points for a model of `blockCount` layers:
 * ~50%, ~75%, ~90% and 100% of the layers, de-duplicated, never 0.
 * 0 is excluded on measurement: on a model that does not fit, `--n-cpu-moe 0`
 * IS plain `-ngl 99`, which was the worst configuration measured (8.3 tok/s,
 * below even pure CPU) - and on the 96.8 GB DeepSeek class it does not load at
 * all.
 */
export function moeCandidatePoints(blockCount: number): number[] {
  if (!Number.isFinite(blockCount) || blockCount < 1) return [];
  const points = CANDIDATE_FRACTIONS.map((f) => Math.max(1, Math.round(blockCount * f)));
  return [...new Set(points)].toSorted((a, b) => a - b);
}

/**
 * Does this serve need expert offload at all?
 *
 * MoE-ness comes from the GGUF header (`expert_count > 0`) OR the catalog's
 * `isMoe` hint - the header wins when it answers, the hint covers a file the
 * reader could not parse. The layer count comes ONLY from the header, because
 * no catalog row carries it; without it there are no candidate points, so the
 * serve keeps its existing behaviour rather than guessing one.
 */
export function decideMoeOffload(args: {
  meta: GgufMoeMeta;
  isMoeHint: boolean;
  fileBytes: number | null;
  vramGb: number;
}): MoeOffloadDecision {
  const isMoe = args.meta.isMoe || args.isMoeHint;
  if (!isMoe) return { needed: false, reason: 'dense' };
  if (args.meta.blockCount === null || args.meta.blockCount < 1) {
    return { needed: false, reason: 'no-block-count' };
  }
  if (args.vramGb <= 0) {
    // No GPU: `--n-cpu-moe` moves expert tensors OFF a GPU, so on this host
    // the flag answers nothing and the sweep would measure nothing - while
    // costing up to BENCH_TIMEOUT_MS on EVERY serve of the model, because a
    // failed/empty sweep is deliberately never cached. The pure-CPU serve
    // keeps its existing `-ngl` behaviour untouched.
    return { needed: false, reason: 'no-gpu' };
  }
  const budgetBytes = args.vramGb * VRAM_USABLE_FRACTION * BYTES_PER_GB;
  if (args.fileBytes !== null && args.fileBytes <= budgetBytes) {
    // Weights fit fully resident: `-ngl auto` already handles this best.
    return { needed: false, reason: 'fits-in-vram' };
  }
  return { needed: true, blockCount: args.meta.blockCount };
}

/**
 * Parse `llama-bench -o json` output into per-point generation speeds.
 *
 * Only tg rows count (`n_gen > 0, n_prompt === 0`): prompt processing has its
 * own row and its own trade-off, and the number the user feels in a chat is
 * generation. Field names verified against the real b10441 output on this
 * machine. Malformed input answers `[]` rather than throwing - the caller
 * treats an empty sweep as a failed calibration.
 */
export function parseBenchJson(stdout: string): MoeCalibrationMeasurement[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: MoeCalibrationMeasurement[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const nGen = typeof r.n_gen === 'number' ? r.n_gen : 0;
    const nPrompt = typeof r.n_prompt === 'number' ? r.n_prompt : 0;
    const nCpuMoe = typeof r.n_cpu_moe === 'number' ? r.n_cpu_moe : null;
    const avgTs = typeof r.avg_ts === 'number' ? r.avg_ts : null;
    if (nGen > 0 && nPrompt === 0 && nCpuMoe !== null && avgTs !== null && avgTs > 0) {
      out.push({ nCpuMoe, tokensPerSec: avgTs });
    }
  }
  return out;
}

/** The fastest measured point, or null for an empty sweep. */
export function pickWinner(measured: MoeCalibrationMeasurement[]): MoeCalibrationMeasurement | null {
  let best: MoeCalibrationMeasurement | null = null;
  for (const m of measured) {
    if (best === null || m.tokensPerSec > best.tokensPerSec) best = m;
  }
  return best;
}

/** Shape-check a parsed cache file without trusting any field. */
function isCalibrationFile(value: unknown): value is MoeCalibrationFile {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return f.schema === CALIBRATION_SCHEMA && Array.isArray(f.entries);
}

function isEntry(value: unknown): value is MoeCalibrationEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.modelId === 'string' &&
    typeof e.gpuName === 'string' &&
    typeof e.vramGb === 'number' &&
    typeof e.nCpuMoe === 'number' &&
    e.nCpuMoe > 0
  );
}

/** What one serve asks the calibrator. */
export type MoeOffloadRequest = {
  /** Catalog model id - the cache key, stable across re-downloads. */
  modelId: string;
  ggufPath: string;
  /** Catalog `isMoe`, used only when the GGUF header cannot answer. */
  isMoeHint: boolean;
  gpuName: string | null;
  vramGb: number;
  /** Called once when a real (non-cached) calibration is about to run. */
  onCalibrating?: () => void;
};

/**
 * Owns the calibration cache and the bench sweep. One instance per process,
 * wired with real deps in cookbookServeSingleton and with fakes in tests.
 */
export class MoeOffloadCalibrator {
  /** The in-flight sweep's abort handle, or null when no bench is running. */
  private activeBench: AbortController | null = null;

  constructor(
    private readonly config: {
      userDataDir: () => string;
      /** The llama-bench beside the resolved llama-server, or null. */
      resolveBenchBinary: () => string | null;
    },
    private readonly deps: MoeCalibratorDeps = defaultMoeCalibratorDeps
  ) {}

  /**
   * Abort the in-flight llama-bench sweep, if any. True when there was one.
   *
   * This is the handle the serve layer's stop paths pull (stopServe and the
   * before-quit stopAll in CookbookServeService): the bench is a real child
   * process holding a 20-50 GB model mapped, and on Windows a parent's death
   * does NOT take the child with it - without this, quitting the app during
   * the calibration minutes left the bench running to completion. The abort
   * lands in {@link calibrate} as a rejected execBench, i.e. a failed sweep:
   * the fallback answer, never a cache entry, so the next serve re-measures.
   */
  cancel(): boolean {
    const active = this.activeBench;
    if (active === null) return false;
    active.abort();
    return true;
  }

  /**
   * The `--n-cpu-moe` value this serve should pass, or null for "no flag"
   * (dense model, fits in VRAM, or layer count unknowable). Never throws.
   */
  async resolveNCpuMoe(req: MoeOffloadRequest): Promise<number | null> {
    const meta = this.deps.readMeta(req.ggufPath);
    const decision = decideMoeOffload({
      meta,
      isMoeHint: req.isMoeHint,
      fileBytes: this.deps.fileSizeBytes(req.ggufPath),
      vramGb: req.vramGb,
    });
    if (!decision.needed) return null;

    const cached = this.readCached(req);
    if (cached !== null) return cached.nCpuMoe;

    const winner = await this.calibrate(req, decision.blockCount);
    if (winner === null) {
      // Fallback measured at 2x plain `-ngl 99` on the Qwen; never cached, so
      // the next serve gets another chance at a real measurement.
      return decision.blockCount;
    }
    return winner;
  }

  /** The cached entry for this model on this GPU, or null. */
  private readCached(req: MoeOffloadRequest): MoeCalibrationEntry | null {
    const file = this.readCacheFileParsed();
    const gpuName = req.gpuName ?? '';
    return (
      file.entries.find(
        (e) => isEntry(e) && e.modelId === req.modelId && e.gpuName === gpuName && e.vramGb === req.vramGb
      ) ?? null
    );
  }

  private readCacheFileParsed(): MoeCalibrationFile {
    const empty: MoeCalibrationFile = { schema: CALIBRATION_SCHEMA, entries: [] };
    const raw = this.deps.readCacheFile(calibrationFilePath(this.config.userDataDir()));
    if (raw === null) return empty;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
    return isCalibrationFile(parsed) ? parsed : empty;
  }

  /** Run the sweep; answer the winning point, or null when nothing measured. */
  private async calibrate(req: MoeOffloadRequest, blockCount: number): Promise<number | null> {
    const binary = this.config.resolveBenchBinary();
    const points = moeCandidatePoints(blockCount);
    if (binary === null || points.length === 0) return null;

    req.onCalibrating?.();
    const abort = new AbortController();
    this.activeBench = abort;
    let stdout: string;
    try {
      stdout = await this.deps.execBench(
        binary,
        ['-m', req.ggufPath, '-ncmoe', points.join(','), ...BENCH_FIXED_ARGS],
        BENCH_TIMEOUT_MS,
        abort.signal
      );
    } catch (err) {
      console.warn(
        `[MoeOffloadCalibrator] llama-bench sweep failed for ${req.modelId}; ` +
          `serving with --n-cpu-moe ${blockCount} (all layers) and retrying next serve:`,
        err
      );
      return null;
    } finally {
      // Only clear our own handle: a newer sweep may already own the slot.
      if (this.activeBench === abort) this.activeBench = null;
    }

    const measured = parseBenchJson(stdout);
    const winner = pickWinner(measured);
    if (winner === null) {
      console.warn(`[MoeOffloadCalibrator] llama-bench produced no usable rows for ${req.modelId}`);
      return null;
    }

    this.writeCached({
      modelId: req.modelId,
      gpuName: req.gpuName ?? '',
      vramGb: req.vramGb,
      blockCount,
      nCpuMoe: winner.nCpuMoe,
      measured,
      calibratedAt: this.deps.now().toISOString(),
    });
    return winner.nCpuMoe;
  }

  /** Upsert one entry; the file stays small (one entry per model+GPU+VRAM). */
  private writeCached(entry: MoeCalibrationEntry): void {
    const file = this.readCacheFileParsed();
    const rest = file.entries.filter(
      (e) => !(e.modelId === entry.modelId && e.gpuName === entry.gpuName && e.vramGb === entry.vramGb)
    );
    const next: MoeCalibrationFile = { schema: CALIBRATION_SCHEMA, entries: [...rest, entry] };
    try {
      this.deps.writeCacheFile(calibrationFilePath(this.config.userDataDir()), JSON.stringify(next, null, 2));
    } catch (err) {
      // A cache that cannot be written costs a re-measurement, not the serve.
      console.warn('[MoeOffloadCalibrator] could not write calibration cache:', err);
    }
  }
}
