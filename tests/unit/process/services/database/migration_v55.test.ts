/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest (Node ABI) test for migration_v55 - the `email_triage` table backing the
 * Email AI Triage surface (Odysseus assimilation "email pollers"). Verifies the
 * table + composite index are created, up() is idempotent, and a row round-trips.
 * Runs under the shared native-better-sqlite3 gate.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations, ALL_MIGRATIONS, type IMigration } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

const migration_v55 = ALL_MIGRATIONS.find((m) => m.version === 55) as IMigration | undefined;

describeNativeSqlite('Migration v55 - email_triage table', () => {
  let driver: BetterSqlite3Driver;
  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });
  afterEach(() => driver.close());

  it('bumps CURRENT_DB_VERSION to 55 or higher and registers migration v55', () => {
    expect(CURRENT_DB_VERSION).toBeGreaterThanOrEqual(55);
    expect(migration_v55).toBeDefined();
    expect(migration_v55!.name).toMatch(/email_triage/i);
  });

  it('creates the email_triage table with all required columns', () => {
    const cols = driver.pragma('table_info(email_triage)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      [
        'account',
        'draft_reply',
        'from_addr',
        'message_id',
        'model_used',
        'plugin_id',
        'spam_reason',
        'spam_verdict',
        'subject',
        'summary',
        'tags',
        'triaged_at_ms',
        'urgency',
      ].toSorted()
    );
  });

  it('keys the table on message_id (PRIMARY KEY)', () => {
    const cols = driver.pragma('table_info(email_triage)') as Array<{ name: string; pk: number }>;
    const pk = cols.find((c) => c.pk === 1);
    expect(pk?.name).toBe('message_id');
  });

  it('creates the (plugin_id, triaged_at_ms) composite index', () => {
    const indexes = driver.pragma('index_list(email_triage)') as Array<{ name: string }>;
    expect(indexes.some((i) => i.name.includes('plugin_triaged'))).toBe(true);
  });

  it('round-trips a triage row and upsert overwrites on message_id conflict', () => {
    const insert = driver.prepare(
      `INSERT INTO email_triage (message_id, plugin_id, account, from_addr, subject, urgency, tags,
        spam_verdict, spam_reason, summary, draft_reply, model_used, triaged_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET draft_reply = excluded.draft_reply`
    );
    insert.run(
      '<m@x>',
      'email-imap_default',
      'me@co',
      's@ext',
      'Hi',
      'high',
      '["finance"]',
      0,
      '',
      'sum',
      'draft A',
      'model',
      1
    );
    insert.run(
      '<m@x>',
      'email-imap_default',
      'me@co',
      's@ext',
      'Hi',
      'high',
      '["finance"]',
      0,
      '',
      'sum',
      'draft B',
      'model',
      2
    );

    const rows = driver.prepare('SELECT * FROM email_triage WHERE message_id = ?').all('<m@x>') as Array<{
      draft_reply: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].draft_reply).toBe('draft B');
  });

  it('up() is idempotent - re-running does not throw and keeps existing rows', () => {
    driver
      .prepare(`INSERT INTO email_triage (message_id, subject, urgency, triaged_at_ms) VALUES (?, ?, ?, ?)`)
      .run('keep', 'Kept', 'none', 1);
    expect(() => migration_v55!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM email_triage WHERE message_id = ?').get('keep')).toBeDefined();
  });
});
