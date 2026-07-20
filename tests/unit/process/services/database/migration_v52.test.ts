/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest (Node ABI) test for migration_v52 - the `calendar_events` table backing
 * the Calendar surface (Odysseus assimilation "calendar"). Verifies the table +
 * indexes are created, up() is idempotent, the FK cascades from users, and a row
 * round-trips. Runs under the shared native-better-sqlite3 gate.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations, ALL_MIGRATIONS, type IMigration } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

const migration_v52 = ALL_MIGRATIONS.find((m) => m.version === 52) as IMigration | undefined;

describeNativeSqlite('Migration v52 - calendar_events table', () => {
  let driver: BetterSqlite3Driver;
  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });
  afterEach(() => driver.close());

  it('bumps CURRENT_DB_VERSION to 52 or higher and registers migration v52', () => {
    expect(CURRENT_DB_VERSION).toBeGreaterThanOrEqual(52);
    expect(migration_v52).toBeDefined();
    expect(migration_v52!.name).toMatch(/calendar/i);
  });

  it('creates the calendar_events table with all required columns', () => {
    const cols = driver.pragma('table_info(calendar_events)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      [
        'all_day',
        'calendar_id',
        'color',
        'created_at_ms',
        'description',
        'end_ms',
        'id',
        'last_reminded_at_ms',
        'location',
        'reminder_lead_ms',
        'rrule',
        'start_ms',
        'title',
        'updated_at_ms',
        'user_id',
      ].toSorted()
    );
  });

  it('creates the user_id / (user_id, start_ms, end_ms) / rrule indexes', () => {
    const indexes = driver.pragma('index_list(calendar_events)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('user_id'))).toBe(true);
    expect(names.some((n) => n.includes('user_range'))).toBe(true);
    expect(names.some((n) => n.includes('rrule'))).toBe(true);
  });

  it('cascades a FK from users(id) ON DELETE CASCADE', () => {
    const fks = driver.pragma('foreign_key_list(calendar_events)') as Array<{ table: string; on_delete: string }>;
    expect(fks.some((fk) => fk.table === 'users' && fk.on_delete === 'CASCADE')).toBe(true);
  });

  it('round-trips a calendar_events row', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u1', 'alice', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO calendar_events (id, user_id, title, start_ms, end_ms, all_day, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('cal_1', 'u1', 'Standup', 1_700_000_000_000, 1_700_000_003_600_000, 0, 1, 1);
    const row = driver.prepare('SELECT * FROM calendar_events WHERE id = ?').get('cal_1') as Record<string, unknown>;
    expect(row.title).toBe('Standup');
    expect(row.user_id).toBe('u1');
  });

  it('deletes events when the owning user is deleted (ON DELETE CASCADE)', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u2', 'bob', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO calendar_events (id, user_id, title, start_ms, end_ms, all_day, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('cal_2', 'u2', 'One-off', 1, 2, 0, 1, 1);
    driver.prepare('DELETE FROM users WHERE id = ?').run('u2');
    const remaining = driver.prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?').get('u2') as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  it('up() is idempotent - re-running does not throw and keeps existing rows', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u3', 'carol', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO calendar_events (id, user_id, title, start_ms, end_ms, all_day, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('keep', 'u3', 'Keep me', 1, 2, 0, 1, 1);

    expect(() => migration_v52!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get('keep')).toBeDefined();
  });
});
