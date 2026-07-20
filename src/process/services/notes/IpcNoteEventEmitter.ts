/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { showNotification } from '@process/bridge/notificationBridge';
import type { INoteEventEmitter } from './INoteEventEmitter';
import type { NoteChangedEvent, NoteReminderFiredEvent } from '@/common/types/notes';

/**
 * Emits note events via ipcBridge.note.* and delegates native notifications to
 * the same showNotification path the cron service uses (IpcCronEventEmitter).
 */
export class IpcNoteEventEmitter implements INoteEventEmitter {
  emitNoteChanged(event: NoteChangedEvent): void {
    ipcBridge.note.onNoteChanged.emit(event);
  }

  emitReminderFired(event: NoteReminderFiredEvent): void {
    ipcBridge.note.onReminderFired.emit(event);
  }

  async showNotification(params: { title: string; body: string }): Promise<void> {
    return showNotification(params);
  }
}
