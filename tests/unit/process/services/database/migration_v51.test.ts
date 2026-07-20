/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest (Node ABI) test for migration_v51 - the `notes` table backing the Notes
 * + reminders surface (Odysseus assimilation #9). Verifies the table + indexes
 * are created, up() is idempotent, the FK cascades from users, and a row round-
 * trips. Runs under the shared native-better-sqlite3 gate (see nativeSqlite.ts).
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations, ALL_MIGRATIONS, type IMigration } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

const migration_v51 = ALL_MIGRATIONS.find((m) => m.version === 51) as IMigration | undefined;

describeNativeSqlite('Migration v51 - notes table', () => {
  let driver: BetterSqlite3Driver;
  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });
  afterEach(() => driver.close());

  it('bumps CURRENT_DB_VERSION to 51 or higher and registers migration v51', () => {
    expect(CURRENT_DB_VERSION).toBeGreaterThanOrEqual(51);
    expect(migration_v51).toBeDefined();
    expect(migration_v51!.name).toMatch(/notes/i);
  });

  it('creates the notes table with all required columns', () => {
    const cols = driver.pragma('table_info(notes)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      [
        'archived',
        'color',
        'content',
        'created_at_ms',
        'due_date_ms',
        'id',
        'items',
        'label',
        'last_reminded_at_ms',
        'note_type',
        'pinned',
        'repeat',
        'sort_order',
        'title',
        'updated_at_ms',
        'user_id',
      ].toSorted()
    );
  });

  it('creates the user_id / due_date_ms / (pinned, sort_order) indexes', () => {
    const indexes = driver.pragma('index_list(notes)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('user_id'))).toBe(true);
    expect(names.some((n) => n.includes('due_date_ms'))).toBe(true);
    expect(names.some((n) => n.includes('pinned_sort'))).toBe(true);
  });

  it('cascades a FK from users(id) ON DELETE CASCADE', () => {
    const fks = driver.pragma('foreign_key_list(notes)') as Array<{ table: string; on_delete: string }>;
    expect(fks.some((fk) => fk.table === 'users' && fk.on_delete === 'CASCADE')).toBe(true);
  });

  it('round-trips a notes row', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u1', 'alice', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO notes (id, user_id, title, note_type, pinned, archived, repeat, sort_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('note_1', 'u1', 'Buy milk', 'note', 0, 0, 'none', 5, 1_700_000_000_000, 1_700_000_000_000);
    const row = driver.prepare('SELECT * FROM notes WHERE id = ?').get('note_1') as Record<string, unknown>;
    expect(row.title).toBe('Buy milk');
    expect(row.user_id).toBe('u1');
  });

  it('deletes notes when the owning user is deleted (ON DELETE CASCADE)', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u2', 'bob', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO notes (id, user_id, note_type, pinned, archived, repeat, sort_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('note_2', 'u2', 'note', 0, 0, 'none', 0, 1, 1);
    driver.prepare('DELETE FROM users WHERE id = ?').run('u2');
    const remaining = driver.prepare('SELECT COUNT(*) AS n FROM notes WHERE user_id = ?').get('u2') as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('up() is idempotent - re-running does not throw and keeps existing rows', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u3', 'carol', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO notes (id, user_id, note_type, pinned, archived, repeat, sort_order, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('keep', 'u3', 'note', 0, 0, 'none', 0, 1, 1);

    expect(() => migration_v51!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM notes WHERE id = ?').get('keep')).toBeDefined();
  });
});
