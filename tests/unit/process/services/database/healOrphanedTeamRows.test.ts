/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One stale row could stop a database from ever upgrading.
 *
 * The migration runner checks foreign keys once, globally, for the whole batch,
 * and a single violation rolls back every migration in it - so a mailbox row
 * left behind by an older build blocks the upgrade, and the app then fails to
 * open. Nothing in that failure points at Teams, and the user has no way to
 * reach the row.
 *
 * The rows are already unreachable by design: no team owns them, nothing
 * queries them, and the schema declares they should have been cascaded away.
 * Deleting them is finishing a delete that was supposed to have happened.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { healOrphanedTeamRows, runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

describeNativeSqlite('healOrphanedTeamRows', () => {
  let driver: BetterSqlite3Driver;

  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });

  afterEach(() => driver.close());

  /** Insert a mailbox row for a team that may or may not exist. */
  function insertMailboxRow(id: string, teamId: string): void {
    driver.pragma('foreign_keys = OFF');
    driver
      .prepare(
        `INSERT INTO mailbox (id, team_id, from_agent_id, to_agent_id, type, body, created_at, read)
         VALUES (?, ?, 'a', 'b', 'note', 'hello', 1, 0)`
      )
      .run(id, teamId);
    driver.pragma('foreign_keys = ON');
  }

  function insertTeam(id: string): void {
    const columns = (
      driver.pragma('table_info(teams)') as Array<{ name: string; notnull: number; dflt_value: unknown }>
    )
      .filter((c) => c.notnull === 1 && c.dflt_value === null)
      .map((c) => c.name);
    const values = columns.map((c) => (c === 'id' ? id : 1));
    driver
      .prepare(`INSERT INTO teams (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...values);
  }

  const mailboxIds = (): string[] =>
    (driver.prepare('SELECT id FROM mailbox ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);

  it('removes a row whose team is gone', () => {
    insertMailboxRow('orphan-1', 'team-that-was-deleted');

    expect(healOrphanedTeamRows(driver)).toBe(1);
    expect(mailboxIds()).toEqual([]);
  });

  it('leaves rows whose team still exists', () => {
    // The whole point is that a live team's mail is untouched - this runs on
    // every upgrade, for everyone.
    insertTeam('team-live');
    insertMailboxRow('keep-me', 'team-live');
    insertMailboxRow('orphan-1', 'team-gone');

    expect(healOrphanedTeamRows(driver)).toBe(1);
    expect(mailboxIds()).toEqual(['keep-me']);
  });

  it('does nothing, and reports nothing, on a healthy database', () => {
    insertTeam('team-live');
    insertMailboxRow('keep-me', 'team-live');

    expect(healOrphanedTeamRows(driver)).toBe(0);
    expect(mailboxIds()).toEqual(['keep-me']);
  });

  it('lets the foreign key check pass afterwards', () => {
    // This is the failure being prevented, stated directly: the check that
    // rolls back the whole batch.
    insertMailboxRow('orphan-1', 'team-gone');
    expect((driver.pragma('foreign_key_check') as unknown[]).length).toBeGreaterThan(0);

    healOrphanedTeamRows(driver);

    expect(driver.pragma('foreign_key_check')).toEqual([]);
  });

  it('skips a table that does not exist yet', () => {
    // A database old enough to predate Teams has nothing to heal, and probing
    // a missing table must not throw mid-migration.
    driver.exec('DROP TABLE mailbox');

    expect(() => healOrphanedTeamRows(driver)).not.toThrow();
  });

  it('runs as part of a migration batch, not only when called by hand', () => {
    // Wiring is the part that actually protects anyone: a stale row must not
    // roll back an upgrade.
    insertMailboxRow('orphan-1', 'team-gone');

    expect(() => runMigrations(driver, 0, CURRENT_DB_VERSION)).not.toThrow();
    expect(mailboxIds()).toEqual([]);
  });
});
