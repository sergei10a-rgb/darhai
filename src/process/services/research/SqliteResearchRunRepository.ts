/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { researchStore } from './ResearchStore';
import type { IResearchRunRepository, ResearchRunPatch } from './IResearchRunRepository';
import type { ResearchRun } from '@/common/types/research';

/** Thin delegation wrapper around the ResearchStore singleton (mirrors SqliteDocumentRepository). */
export class SqliteResearchRunRepository implements IResearchRunRepository {
  async insert(run: ResearchRun): Promise<void> {
    await researchStore.insert(run);
  }

  async update(runId: string, patch: ResearchRunPatch): Promise<ResearchRun> {
    return researchStore.update(runId, patch);
  }

  async getById(runId: string): Promise<ResearchRun | null> {
    return researchStore.getById(runId);
  }

  async listByUser(userId: string, limit: number): Promise<ResearchRun[]> {
    return researchStore.listByUser(userId, limit);
  }

  async delete(runId: string): Promise<void> {
    await researchStore.delete(runId);
  }
}
