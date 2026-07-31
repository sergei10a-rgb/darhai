/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the desktop runtime's own user identity.
 *
 * The desktop app never shows a login screen, so the renderer has no way to
 * learn which `users` row it is acting as. Every per-user surface (calendar,
 * notes, documents, teams, research) keys its queries and its inserts on that
 * id, and `calendar_events` / `notes` / `documents` each declare a foreign key
 * onto `users(id)` - so the id cannot be invented renderer-side either: a made
 * up value reads back empty and fails the FK on write.
 *
 * The main process owns the database, which makes it the only side that can
 * both answer the question and guarantee the row exists. This bridge is that
 * answer, and nothing more - it is a read of one seeded row.
 *
 * Remote-denied (bridgeAllowlist REMOTE_DENIED_KEYS): a paired-device WebSocket
 * caller has its own identity from the webserver auth flow and must never be
 * handed the host profile's.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database/export';
import type { LocalUserIdentity } from '@/common/types/localUser';

/** Initialize the local-user IPC bridge handler. */
export function initLocalUserBridge(): void {
  ipcBridge.localUser.get.provider(async (): Promise<LocalUserIdentity> => {
    const db = await getDatabase();
    const user = db.getOrCreateSystemUser();
    return { id: user.id, username: user.username };
  });
}
