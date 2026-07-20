/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CalendarEventChangedEvent, CalendarReminderFiredEvent } from '@/common/types/calendar';

export interface ICalendarEventEmitter {
  emitEventChanged(event: CalendarEventChangedEvent): void;
  emitReminderFired(event: CalendarReminderFiredEvent): void;
  /** Fire a native OS notification (reuses the shared notificationBridge path). */
  showNotification(params: { title: string; body: string }): Promise<void>;
}
