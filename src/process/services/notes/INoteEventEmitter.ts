/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NoteChangedEvent, NoteReminderFiredEvent } from '@/common/types/notes';

export interface INoteEventEmitter {
  emitNoteChanged(event: NoteChangedEvent): void;
  emitReminderFired(event: NoteReminderFiredEvent): void;
  /** Fire a native OS notification (reuses the shared notificationBridge path). */
  showNotification(params: { title: string; body: string }): Promise<void>;
}
