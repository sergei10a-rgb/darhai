/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import type { IUsageEventRepository, UsageEvent } from './types';

/**
 * Thin orchestrator that turns a partial record() input into a fully-formed
 * UsageEvent and writes it through the repository. Defaults `id` to a UUID
 * and `timestampMs` to now. Errors are swallowed (warn-only) — telemetry
 * must never break a user-facing flow.
 */
export class UsageEventLogger {
  constructor(private readonly repo: IUsageEventRepository) {}

  async record(
    input: Omit<UsageEvent, 'id' | 'timestampMs'> & Partial<Pick<UsageEvent, 'id' | 'timestampMs'>>
  ): Promise<void> {
    const event: UsageEvent = {
      id: input.id ?? randomUUID(),
      timestampMs: input.timestampMs ?? Date.now(),
      eventType: input.eventType,
      anchorId: input.anchorId,
      assistantId: input.assistantId,
      cliBackend: input.cliBackend,
      metadata: input.metadata,
    };
    try {
      await this.repo.append(event);
    } catch (err) {
      console.warn('[UsageEventLogger] append failed:', err instanceof Error ? err.message : err);
    }
  }
}
