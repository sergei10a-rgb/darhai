/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SemanticIndexService - the single wiring point for hybrid retrieval in the
 * main process. Owns the shared EmbeddingService and SqliteVecStore, and hands
 * out per-namespace HybridRetriever instances.
 *
 * Everything here is lazy and fail-soft:
 *   - The sqlite-vec extension path is resolved via require; if the platform
 *     binary is missing the store degrades to keyword-only.
 *   - The embedding model is only loaded on first retrieval / reindex.
 *   - Nothing on this path runs at app startup unless a caller asks for it.
 *
 * Callers get a HybridRetriever and supply their own keyword lane, so this
 * service stays agnostic of how skills vs memory rank keywords.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { getDataPath } from '@process/utils';
import { getDatabase } from '@process/services/database';
import { EmbeddingService, EMBEDDING_DIM, type EmbedProgress } from './EmbeddingService';
import { SqliteVecStore } from './SqliteVecStore';
import { HybridRetriever, type KeywordLane } from './HybridRetriever';
import type { SemanticNamespace } from './types';

// ESM-safe require: the main process is bundled as ESM, where bare `require`
// isn't defined. `createRequire` gives us a CJS require rooted at this module
// to load the externalized sqlite-vec package (and its native binary).
const nodeRequire = createRequire(import.meta.url);

/** Resolve the sqlite-vec loadable extension path, or null if the package is absent. */
function resolveSqliteVecPath(): string | null {
  try {
    // sqlite-vec ships a tiny JS shim plus a platform binary as an optional
    // dependency. `getLoadablePath()` returns the absolute path to the native
    // extension for the current platform, or throws if none is installed.
    const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath: () => string };
    return sqliteVec.getLoadablePath();
  } catch (err) {
    console.warn('[SemanticIndexService] sqlite-vec package not loadable - keyword-only retrieval:', err);
    return null;
  }
}

export class SemanticIndexService {
  private static instance: SemanticIndexService | null = null;

  private embedder: EmbeddingService | null = null;
  private store: SqliteVecStore | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly retrievers = new Map<SemanticNamespace, HybridRetriever>();

  private constructor(private readonly onProgress?: (p: EmbedProgress) => void) {}

  static getInstance(onProgress?: (p: EmbedProgress) => void): SemanticIndexService {
    if (!SemanticIndexService.instance) {
      SemanticIndexService.instance = new SemanticIndexService(onProgress);
    }
    return SemanticIndexService.instance;
  }

  /** For tests only - drop the singleton so a fresh instance can be built. */
  static resetInstance(): void {
    SemanticIndexService.instance = null;
  }

  /**
   * Lazily construct the embedder + vector store. Idempotent and concurrency-
   * safe. Never throws - a failure just leaves `store` in a degraded state and
   * retrieval falls back to keyword.
   */
  private ensureInit(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const cacheDir = path.join(getDataPath(), 'models');
      this.embedder = new EmbeddingService({ cacheDir, onProgress: this.onProgress });

      const vecPath = resolveSqliteVecPath();
      const db = await getDatabase();
      this.store = vecPath
        ? SqliteVecStore.create(db.getDriver(), EMBEDDING_DIM, vecPath)
        : // Build an unavailable store so callers still get a HybridRetriever.
          SqliteVecStore.create(db.getDriver(), EMBEDDING_DIM, '');
    })();
    return this.initPromise;
  }

  /**
   * Get (or build) the hybrid retriever for a namespace, bound to the given
   * keyword lane. The expensive embedder + vector store are cached per
   * namespace; the (cheap) keyword lane is rebound on every call so a cached
   * retriever never ranks against a stale corpus snapshot - callers that pass a
   * lane built over an updated corpus (a reindex, a new/changed skill or memory)
   * immediately see the fresh entries in keyword results.
   */
  async getRetriever(namespace: SemanticNamespace, keyword: KeywordLane): Promise<HybridRetriever> {
    await this.ensureInit();
    let retriever = this.retrievers.get(namespace);
    if (!retriever) {
      retriever = new HybridRetriever({
        namespace,
        embedder: this.embedder as EmbeddingService,
        store: this.store as SqliteVecStore,
        keyword,
      });
      this.retrievers.set(namespace, retriever);
    } else {
      retriever.setKeyword(keyword);
    }
    return retriever;
  }

  /** True when the vector index is usable; false ⇒ everything is keyword-only. */
  async isVectorAvailable(): Promise<boolean> {
    await this.ensureInit();
    return this.store?.isAvailable() ?? false;
  }
}
