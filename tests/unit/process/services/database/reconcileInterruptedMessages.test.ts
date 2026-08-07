/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The turn that kept typing forever.
 *
 * Streaming persists message rows with status 'pending', and ACP tool calls
 * with 'work'; both are finalized only when the turn completes. A crash or
 * kill mid-turn froze those rows non-terminal, and nothing ever touched them
 * again - so after every restart the chat rendered the dead turn as still
 * responding, with a typing indicator that never went away.
 *
 * The repair runs once at startup, before any window or agent exists. At that
 * moment nothing can legitimately be in flight, which is what makes the
 * blanket UPDATE safe - and what these tests pin down: exactly the two
 * non-terminal statuses flip to 'error', and the terminal ones are never
 * touched, because rewriting a finished turn's status would corrupt history.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { reconcileInterruptedMessagesOn } from '@process/services/database';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

describeNativeSqlite('reconcileInterruptedMessagesOn', () => {
  let driver: BetterSqlite3Driver;

  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });

  afterEach(() => driver.close());

  /** Insert a message row without dragging in the conversations fixture. */
  function insertMessage(id: string, status: string): void {
    driver.pragma('foreign_keys = OFF');
    driver
      .prepare(
        `INSERT INTO messages (id, conversation_id, type, content, position, status, created_at)
         VALUES (?, 'conv-1', 'text', '{}', 'left', ?, 1)`
      )
      .run(id, status);
    driver.pragma('foreign_keys = ON');
  }

  function statusOf(id: string): string {
    return (driver.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }).status;
  }

  it('flips both non-terminal statuses to error, and only those', () => {
    insertMessage('m-work', 'work');
    insertMessage('m-pending', 'pending');
    insertMessage('m-finish', 'finish');
    insertMessage('m-error', 'error');

    const result = reconcileInterruptedMessagesOn(driver);

    expect(result).toEqual({ success: true, data: 2 });
    // The interrupted turn shows as failed, not as typing forever.
    expect(statusOf('m-work')).toBe('error');
    expect(statusOf('m-pending')).toBe('error');
    // A finished turn's history must never be rewritten.
    expect(statusOf('m-finish')).toBe('finish');
    expect(statusOf('m-error')).toBe('error');
  });

  it('is idempotent - a second pass finds nothing left to repair', () => {
    insertMessage('m-work', 'work');

    expect(reconcileInterruptedMessagesOn(driver).data).toBe(1);
    expect(reconcileInterruptedMessagesOn(driver)).toEqual({ success: true, data: 0 });
  });

  it('reports zero on a database with no interrupted turns', () => {
    insertMessage('m-finish', 'finish');
    expect(reconcileInterruptedMessagesOn(driver)).toEqual({ success: true, data: 0 });
  });

  it('reports failure instead of throwing, so startup can never be blocked by it', () => {
    driver.close();
    const result = reconcileInterruptedMessagesOn(driver);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
