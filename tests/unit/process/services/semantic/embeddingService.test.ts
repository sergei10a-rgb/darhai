/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { EmbeddingService, MAX_EMBED_CHARS, type EmbedPipeline } from '@process/services/semantic/EmbeddingService';

/** A fake pipeline that returns a fixed-length vector per input (deterministic). */
const fakePipeline: EmbedPipeline = async (inputs) => ({
  tolist: () => inputs.map((_, i) => [i + 1, 0, 0]),
});

/** A fake pipeline that records the exact inputs it was handed (for cap assertions). */
function recordingPipeline(): { pipe: EmbedPipeline; inputs: string[] } {
  const inputs: string[] = [];
  const pipe: EmbedPipeline = async (batch) => {
    inputs.push(...batch);
    return { tolist: () => batch.map(() => [1, 0, 0]) };
  };
  return { pipe, inputs };
}

describe('EmbeddingService', () => {
  describe('offline / degraded fallback', () => {
    it('marks itself degraded and returns null when the model fails to load', async () => {
      const svc = new EmbeddingService({
        cacheDir: '/tmp/x',
        pipelineFactory: async () => {
          throw new Error('offline: could not fetch model');
        },
      });
      const vec = await svc.embedQuery('hello');
      expect(vec).toBeNull();
      expect(svc.isDegraded()).toBe(true);
      expect(svc.isReady()).toBe(false);
    });

    it('embedDocuments returns null when degraded (caller falls back to keyword)', async () => {
      const svc = new EmbeddingService({
        cacheDir: '/tmp/x',
        pipelineFactory: async () => {
          throw new Error('offline');
        },
      });
      expect(await svc.embedDocuments(['a', 'b'])).toBeNull();
    });

    it('does not throw on load failure - a degraded service is a valid state', async () => {
      const svc = new EmbeddingService({
        cacheDir: '/tmp/x',
        pipelineFactory: async () => {
          throw new Error('boom');
        },
      });
      await expect(svc.ensureLoaded()).resolves.toBeUndefined();
    });
  });

  describe('happy path', () => {
    it('embeds a query with a query: prefix', async () => {
      const factory = vi.fn(async () => fakePipeline);
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: factory });
      const vec = await svc.embedQuery('search me');
      expect(vec).toBeInstanceOf(Float32Array);
      expect(svc.isReady()).toBe(true);
    });

    it('loads the model at most once across concurrent calls', async () => {
      const factory = vi.fn(async () => fakePipeline);
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: factory });
      await Promise.all([svc.embedQuery('a'), svc.embedQuery('b'), svc.ensureLoaded()]);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('embeds documents in batches and returns one vector per input', async () => {
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: async () => fakePipeline });
      const docs = Array.from({ length: 40 }, (_, i) => `doc ${i}`);
      const vecs = await svc.embedDocuments(docs);
      expect(vecs).not.toBeNull();
      expect(vecs).toHaveLength(40);
      expect(vecs?.[0]).toBeInstanceOf(Float32Array);
    });

    it('returns an empty array for an empty document list (not null) when ready', async () => {
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: async () => fakePipeline });
      await svc.ensureLoaded();
      expect(await svc.embedDocuments([])).toEqual([]);
    });
  });

  describe('input clamping (DoS guard)', () => {
    it('caps an oversized query at MAX_EMBED_CHARS before tokenizing', async () => {
      const { pipe, inputs } = recordingPipeline();
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: async () => pipe });
      const huge = 'x'.repeat(MAX_EMBED_CHARS * 10);
      await svc.embedQuery(huge);
      // One input, prefixed with 'query: ', body clamped to MAX_EMBED_CHARS.
      expect(inputs).toHaveLength(1);
      const body = inputs[0].replace(/^query: /, '');
      expect(body.length).toBe(MAX_EMBED_CHARS);
    });

    it('caps each oversized document at MAX_EMBED_CHARS before tokenizing', async () => {
      const { pipe, inputs } = recordingPipeline();
      const svc = new EmbeddingService({ cacheDir: '/tmp/x', pipelineFactory: async () => pipe });
      const huge = 'y'.repeat(MAX_EMBED_CHARS * 5);
      await svc.embedDocuments([huge, 'short']);
      const clampedBody = inputs[0].replace(/^passage: /, '');
      expect(clampedBody.length).toBe(MAX_EMBED_CHARS);
      // A short doc is left untouched.
      expect(inputs[1]).toBe('passage: short');
    });
  });
});
