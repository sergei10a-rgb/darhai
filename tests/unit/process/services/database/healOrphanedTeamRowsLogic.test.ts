/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The same heal as `healOrphanedTeamRows.test.ts`, driven through a stub rather
 * than a real database.
 *
 * That file is the better evidence - it runs the delete against SQLite and then
 * asserts `foreign_key_check` passes - but it is gated on the native
 * better-sqlite3 ABI, which does not match locally when the addon is built for
 * Electron. It runs in CI and skips on a dev machine. This file has no native
 * dependency, so the wiring stays covered on both.
 */

import { describe, expect, it, vi } from 'vitest';
import { healOrphanedTeamRows } from '@process/services/database/migrations';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

type Recorded = { sql: string; args: unknown[] };

function stubDriver(options: { existingTables: string[]; deletedPerTable?: number }) {
  const runs: Recorded[] = [];
  const gets: Recorded[] = [];

  const driver = {
    prepare: (sql: string) => ({
      get: (...args: unknown[]) => {
        gets.push({ sql, args });
        const table = String(args[0]);
        return options.existingTables.includes(table) ? { name: table } : undefined;
      },
      run: (...args: unknown[]) => {
        runs.push({ sql, args });
        return { changes: options.deletedPerTable ?? 0, lastInsertRowid: 0 };
      },
      all: (): unknown[] => [],
    }),
    exec: vi.fn(),
    pragma: vi.fn(),
    transaction: <T>(fn: (...a: unknown[]) => T) => fn,
    close: vi.fn(),
  } as unknown as ISqliteDriver;

  return { driver, runs, gets };
}

const ALL_TABLES = ['mailbox', 'team_tasks', 'team_event_log'];

describe('healOrphanedTeamRows (driver-agnostic)', () => {
  it('checks every team-child table', () => {
    const { driver, runs } = stubDriver({ existingTables: ALL_TABLES });

    healOrphanedTeamRows(driver);

    expect(runs).toHaveLength(3);
    for (const table of ALL_TABLES) {
      expect(runs.some((r) => r.sql.includes(`DELETE FROM ${table} `))).toBe(true);
    }
  });

  it('only deletes rows whose team is missing', () => {
    // A live team's mail must survive: this runs on every upgrade, for
    // everyone, not only for databases known to be damaged.
    const { driver, runs } = stubDriver({ existingTables: ALL_TABLES });

    healOrphanedTeamRows(driver);

    for (const run of runs) {
      expect(run.sql).toContain('team_id NOT IN (SELECT id FROM teams)');
    }
  });

  it('skips a table that does not exist yet', () => {
    // A database old enough to predate Teams has nothing to heal, and probing
    // a missing table must not throw in the middle of a migration batch.
    const { driver, runs } = stubDriver({ existingTables: ['mailbox'] });

    expect(() => healOrphanedTeamRows(driver)).not.toThrow();
    expect(runs).toHaveLength(1);
  });

  it('reports how many rows it removed', () => {
    const { driver } = stubDriver({ existingTables: ALL_TABLES, deletedPerTable: 2 });

    expect(healOrphanedTeamRows(driver)).toBe(6);
  });

  it('reports zero on a healthy database', () => {
    const { driver } = stubDriver({ existingTables: ALL_TABLES, deletedPerTable: 0 });

    expect(healOrphanedTeamRows(driver)).toBe(0);
  });

  it('never interpolates anything but its own hardcoded table names', () => {
    // The table name is spliced into the SQL text, so the list it comes from
    // has to stay a literal - not something read back from the database.
    const { driver, runs } = stubDriver({ existingTables: ALL_TABLES });

    healOrphanedTeamRows(driver);

    for (const run of runs) {
      expect(run.args).toEqual([]);
      expect(ALL_TABLES.some((t) => run.sql.includes(`DELETE FROM ${t} `))).toBe(true);
    }
  });
});
