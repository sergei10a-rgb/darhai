/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { getDatabase } from '@process/services/database';
import type { ResearchRunPatch } from './IResearchRunRepository';
import type { ResearchCategory, ResearchRun, ResearchSource, ResearchStatus } from '@/common/types/research';

/** Database row structure for the `research_runs` table (migration v54). */
type ResearchRunRow = {
  id: string;
  user_id: string;
  query: string | null;
  category: string | null;
  status: string | null;
  rounds: number;
  report: string | null;
  sources: string | null;
  error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

const VALID_CATEGORIES: ReadonlySet<string> = new Set<ResearchCategory>([
  'auto',
  'general',
  'product',
  'comparison',
  'howto',
  'factcheck',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<ResearchStatus>([
  'planning',
  'searching',
  'reading',
  'synthesizing',
  'writing',
  'done',
  'error',
  'cancelled',
]);

function toCategory(value: string | null): ResearchCategory {
  return value !== null && VALID_CATEGORIES.has(value) ? (value as ResearchCategory) : 'auto';
}

function toStatus(value: string | null): ResearchStatus {
  return value !== null && VALID_STATUSES.has(value) ? (value as ResearchStatus) : 'planning';
}

/** Parse the JSON sources column defensively - a corrupt value degrades to []. */
function parseSources(value: string | null): ResearchSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is ResearchSource => Boolean(s) && typeof s === 'object')
      .map((s) => ({
        title: typeof (s as ResearchSource).title === 'string' ? (s as ResearchSource).title : '',
        url: typeof (s as ResearchSource).url === 'string' ? (s as ResearchSource).url : '',
      }))
      .filter((s) => s.url.length > 0);
  } catch {
    return [];
  }
}

function rowToRun(row: ResearchRunRow): ResearchRun {
  return {
    id: row.id,
    userId: row.user_id,
    query: row.query ?? '',
    category: toCategory(row.category),
    status: toStatus(row.status),
    rounds: row.rounds,
    report: row.report ?? '',
    sources: parseSources(row.sources),
    error: row.error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

/**
 * ResearchStore - persistence layer for research runs. Thin, synchronous
 * better-sqlite3 access wrapped in async methods (mirrors DocumentStore /
 * CalendarStore). JSON-typed `sources` is (de)serialized at the boundary so
 * callers only ever see a real array.
 */
class ResearchStore {
  async insert(run: ResearchRun): Promise<void> {
    const db = await getDatabase();
    db.getDriver()
      .prepare(
        `
      INSERT INTO research_runs (
        id, user_id, query, category, status, rounds, report, sources, error,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        run.id,
        run.userId,
        run.query,
        run.category,
        run.status,
        run.rounds,
        run.report,
        JSON.stringify(run.sources),
        run.error,
        run.createdAtMs,
        run.updatedAtMs
      );
  }

  /**
   * Partial update. Only fields present in `patch` are written; `updated_at_ms`
   * is always bumped. Returns the resulting row. Throws if `id` does not exist.
   */
  async update(runId: string, patch: ResearchRunPatch): Promise<ResearchRun> {
    const db = await getDatabase();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.rounds !== undefined) {
      sets.push('rounds = ?');
      params.push(patch.rounds);
    }
    if (patch.report !== undefined) {
      sets.push('report = ?');
      params.push(patch.report);
    }
    if (patch.sources !== undefined) {
      sets.push('sources = ?');
      params.push(JSON.stringify(patch.sources));
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      params.push(patch.error);
    }

    sets.push('updated_at_ms = ?');
    params.push(Date.now());
    params.push(runId);

    const result = db
      .getDriver()
      .prepare(`UPDATE research_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    if (result.changes === 0) {
      throw new Error(`ResearchStore.update: no row with id=${runId}`);
    }
    const updated = await this.getById(runId);
    if (!updated) {
      throw new Error(`ResearchStore.update: row vanished after update id=${runId}`);
    }
    return updated;
  }

  async getById(runId: string): Promise<ResearchRun | null> {
    const db = await getDatabase();
    const row = db.getDriver().prepare('SELECT * FROM research_runs WHERE id = ?').get(runId) as
      | ResearchRunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  async listByUser(userId: string, limit: number): Promise<ResearchRun[]> {
    const db = await getDatabase();
    const rows = db
      .getDriver()
      .prepare('SELECT * FROM research_runs WHERE user_id = ? ORDER BY updated_at_ms DESC LIMIT ?')
      .all(userId, limit) as ResearchRunRow[];
    return rows.map(rowToRun);
  }

  async delete(runId: string): Promise<void> {
    const db = await getDatabase();
    db.getDriver().prepare('DELETE FROM research_runs WHERE id = ?').run(runId);
  }
}

// Singleton instance
export const researchStore = new ResearchStore();
