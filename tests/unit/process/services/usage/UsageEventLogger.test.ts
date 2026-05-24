/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { UsageEventLogger } from '@process/services/usage/UsageEventLogger';
import type { IUsageEventRepository, UsageEvent } from '@process/services/usage/types';

const makeRepo = (overrides: Partial<IUsageEventRepository> = {}): IUsageEventRepository => ({
  append: vi.fn(async () => undefined),
  findSince: vi.fn(async () => [] as UsageEvent[]),
  findByType: vi.fn(async () => [] as UsageEvent[]),
  ...overrides,
});

describe('UsageEventLogger', () => {
  it('generates id and timestamp when omitted', async () => {
    const repo = makeRepo();
    const logger = new UsageEventLogger(repo);
    await logger.record({ eventType: 'guid.message_sent' });
    const arg = (repo.append as ReturnType<typeof vi.fn>).mock.calls[0][0] as UsageEvent;
    expect(arg.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg.timestampMs).toBeGreaterThan(0);
  });

  it('passes through explicit id and timestamp', async () => {
    const repo = makeRepo();
    const logger = new UsageEventLogger(repo);
    await logger.record({ id: 'fixed', timestampMs: 999, eventType: 'guid.message_sent' });
    const arg = (repo.append as ReturnType<typeof vi.fn>).mock.calls[0][0] as UsageEvent;
    expect(arg.id).toBe('fixed');
    expect(arg.timestampMs).toBe(999);
  });

  it('swallows repo errors', async () => {
    const repo = makeRepo({
      append: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const logger = new UsageEventLogger(repo);
    await expect(logger.record({ eventType: 'guid.message_sent' })).resolves.toBeUndefined();
  });
});
