/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResearchRun, ResearchSource, ResearchStatus } from '@/common/types/research';

/**
 * Partial update for a research run. Only the fields present are written;
 * `updated_at_ms` is always re-stamped by the store. `report` / `sources` /
 * `error` land as the loop progresses; `category` is fixed at insert time.
 */
export type ResearchRunPatch = Partial<{
  status: ResearchStatus;
  rounds: number;
  report: string;
  sources: ResearchSource[];
  error: string | null;
}>;

export interface IResearchRunRepository {
  insert(run: ResearchRun): Promise<void>;
  update(runId: string, patch: ResearchRunPatch): Promise<ResearchRun>;
  getById(runId: string): Promise<ResearchRun | null>;
  /** A user's runs, newest-updated first, capped at `limit`. */
  listByUser(userId: string, limit: number): Promise<ResearchRun[]>;
  delete(runId: string): Promise<void>;
}
