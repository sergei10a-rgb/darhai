/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { showNotification } from '@process/bridge/desktop/notificationBridge';
import type { ICalendarEventEmitter } from './ICalendarEventEmitter';
import type { CalendarEventChangedEvent, CalendarReminderFiredEvent } from '@/common/types/calendar';

/**
 * Emits calendar events via ipcBridge.calendar.* and delegates native
 * notifications to the same showNotification path the note reminder uses
 * (IpcNoteEventEmitter) - no new notification path is introduced.
 */
export class IpcCalendarEventEmitter implements ICalendarEventEmitter {
  emitEventChanged(event: CalendarEventChangedEvent): void {
    ipcBridge.calendar.onEventChanged.emit(event);
  }

  emitReminderFired(event: CalendarReminderFiredEvent): void {
    ipcBridge.calendar.onReminderFired.emit(event);
  }

  async showNotification(params: { title: string; body: string }): Promise<void> {
    return showNotification(params);
  }
}
