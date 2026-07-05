/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EmbeddingService - lazy, offline-tolerant text embedding for the main process.
 *
 * Model: `Xenova/multilingual-e5-small` (384-dim, ONNX q8). Multilingual e5 is
 * trained for retrieval across 100+ languages, so mixed Mongolian + English
 * skill/memory text embeds in one shared space - critical for Darhai's corpus.
 *
 * Design constraints (local-first, offline .exe):
 *   - Lazy: no model is loaded until the first embed() call. Loading downloads
 *     the model once (progress reported) and caches it under userData.
 *   - Offline-tolerant: if the model can't be fetched (no network, first run
 *     offline) the service marks itself DEGRADED and every embed() returns null.
 *     Callers MUST treat null as "vector unavailable" and fall back to keyword.
 *   - Non-blocking: batch embedding yields to the event loop between chunks so
 *     a large backfill never freezes the main process.
 *   - Untrusted input safe: skill/memory text is only ever tokenized + embedded
 *     as plain text. There is no code path where the content is executed or
 *     interpolated into a prompt here, so index poisoning can't inject behavior.
 */

import { setTimeout as delay } from 'node:timers/promises';

// Type-only import so tsc is happy; the heavy runtime module is loaded lazily
// via dynamic import inside load() so it never enters the startup path.
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/** The embedding model id. e5-small is 384-dim and multilingual. */
export const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
/**
 * Pinned model revision: an immutable HuggingFace commit SHA, NOT the mutable
 * `main` branch. HF commits are content-addressed, so pinning a SHA means the
 * exact ONNX weights we vetted are the only ones ever fetched - a compromised or
 * silently-updated `main` cannot swap the model out from under us (a supply-
 * chain / index-poisoning vector for a model that reads untrusted corpus text).
 * This is the last stable commit of Xenova/multilingual-e5-small (2025-07-22).
 * Future hardening (not done here, to keep the installer small): bundle the
 * weights in-app and drop the remote fetch entirely.
 */
export const EMBEDDING_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
/** Output dimension of EMBEDDING_MODEL. Fixed at the vec0 table shape. */
export const EMBEDDING_DIM = 384;

/**
 * Whether the one-time model download from HuggingFace is permitted. Default:
 * allowed (so a fresh install can fetch the model once, then reuse the cache).
 * Air-gapped / high-security deployments can set DARHAI_ALLOW_MODEL_DOWNLOAD=0
 * to forbid any network fetch: if the model isn't already cached locally the
 * service degrades to keyword-only retrieval instead of reaching out.
 */
function isModelDownloadAllowed(): boolean {
  return process.env.DARHAI_ALLOW_MODEL_DOWNLOAD !== '0';
}

/**
 * Hard character cap per embedded text (document OR query). e5 truncates at 512
 * tokens; multilingual text averages well under 4 chars/token, so 2048 chars
 * always covers the model's real context - anything beyond is silently dropped
 * by the tokenizer anyway. Capping here bounds tokenizer/ONNX work and memory so
 * an attacker-controlled skill/memory frontmatter (an unbounded `summary` or a
 * pathological query) cannot drive the embedder into an OOM or a CPU stall.
 */
export const MAX_EMBED_CHARS = 2048;

/** Documents per inference batch. Kept small to bound peak memory on 8GB machines. */
const BATCH_SIZE = 16;

/** Clamp a text to MAX_EMBED_CHARS before it reaches the tokenizer. */
function clampEmbedText(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

type Health = 'unloaded' | 'loading' | 'ready' | 'degraded';

export type EmbedProgress = { status: string; loaded?: number; total?: number; progress?: number };

export type EmbeddingServiceOptions = {
  /** Directory to cache model files under (typically `<userData>/wayland/models`). */
  cacheDir: string;
  /** Optional progress sink for the one-time model download. */
  onProgress?: (p: EmbedProgress) => void;
  /**
   * Injectable pipeline factory for tests - defaults to transformers.js. Lets
   * unit tests exercise batching / fallback without loading a real model.
   */
  pipelineFactory?: (cacheDir: string, onProgress?: (p: EmbedProgress) => void) => Promise<EmbedPipeline>;
};

/** Minimal shape of the transformers.js feature-extraction pipeline we depend on. */
export type EmbedPipeline = (
  input: string[],
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>;

export class EmbeddingService {
  private health: Health = 'unloaded';
  private pipe: EmbedPipeline | null = null;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly options: EmbeddingServiceOptions) {}

  /** True once a model is loaded and embeddings can be produced. */
  isReady(): boolean {
    return this.health === 'ready';
  }

  /** True when the model failed to load - callers must use the keyword fallback. */
  isDegraded(): boolean {
    return this.health === 'degraded';
  }

  get dimension(): number {
    return EMBEDDING_DIM;
  }

  get modelId(): string {
    return EMBEDDING_MODEL;
  }

  /**
   * Ensure the model is loaded. Idempotent and safe to call concurrently - the
   * first call owns the load, everyone else awaits it. A load failure flips the
   * service to `degraded` and resolves (never rejects) so retrieval keeps
   * working via the keyword lane.
   */
  async ensureLoaded(): Promise<void> {
    if (this.health === 'ready' || this.health === 'degraded') return;
    if (this.loadPromise) return this.loadPromise;

    this.health = 'loading';
    this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const factory = this.options.pipelineFactory ?? defaultPipelineFactory;
      this.pipe = await factory(this.options.cacheDir, this.options.onProgress);
      this.health = 'ready';
    } catch (err) {
      // Offline / fetch failure / incompatible runtime: degrade, don't crash.
      this.health = 'degraded';
      this.pipe = null;
      console.warn('[EmbeddingService] model load failed - vector retrieval disabled, using keyword fallback:', err);
    }
  }

  /**
   * Embed a single query string. Returns null when the model is unavailable so
   * the caller falls back to keyword retrieval. e5 models expect a `query:`
   * prefix on search queries.
   */
  async embedQuery(text: string): Promise<Float32Array | null> {
    await this.ensureLoaded();
    if (!this.pipe) return null;
    const [vec] = await this.runBatch([`query: ${clampEmbedText(text)}`]);
    return vec ?? null;
  }

  /**
   * Embed a batch of documents. Yields to the event loop between chunks so a
   * large backfill never blocks the main process. Returns null when the model
   * is unavailable. e5 models expect a `passage:` prefix on indexed documents.
   */
  async embedDocuments(texts: readonly string[]): Promise<Float32Array[] | null> {
    await this.ensureLoaded();
    if (!this.pipe || texts.length === 0) {
      return this.pipe ? [] : null;
    }

    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE).map((t) => `passage: ${clampEmbedText(t)}`);
      const vecs = await this.runBatch(chunk);
      out.push(...vecs);
      // Cooperative yield: let pending IPC / UI work run between chunks.
      if (i + BATCH_SIZE < texts.length) await delay(0);
    }
    return out;
  }

  private async runBatch(inputs: string[]): Promise<Float32Array[]> {
    if (!this.pipe) return [];
    // `normalize: true` L2-normalizes each vector, so a later dot-product in
    // sqlite-vec equals cosine similarity.
    const tensor = await this.pipe(inputs, { pooling: 'mean', normalize: true });
    return tensor.tolist().map((row) => Float32Array.from(row));
  }
}

/**
 * Default pipeline factory backed by transformers.js Node runtime
 * (onnxruntime-node). Isolated here so tests can inject a fake and so the heavy
 * dependency is only imported when embeddings are actually needed.
 */
async function defaultPipelineFactory(
  cacheDir: string,
  onProgress?: (p: EmbedProgress) => void
): Promise<EmbedPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  // Cache model files under userData so re-launches (and the offline .exe) reuse
  // them. Local files are always allowed; remote fetch is allowed only for the
  // ONE-TIME download and only when DARHAI_ALLOW_MODEL_DOWNLOAD isn't disabled.
  // When remote is off and the model isn't cached, the fetch throws and the
  // service degrades to keyword-only.
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = isModelDownloadAllowed();

  const pipe = (await pipeline('feature-extraction', EMBEDDING_MODEL, {
    dtype: 'q8',
    // Pin to an immutable commit SHA so we only ever load the exact vetted
    // weights - never whatever `main` currently points at.
    revision: EMBEDDING_MODEL_REVISION,
    progress_callback: onProgress ? (p: unknown) => onProgress(p as EmbedProgress) : undefined,
  })) as FeatureExtractionPipeline;

  return (input, opts) => pipe(input, opts) as ReturnType<EmbedPipeline>;
}
