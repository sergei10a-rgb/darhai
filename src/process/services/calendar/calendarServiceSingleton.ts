/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { CalendarService } from './CalendarService';
import { IpcCalendarEventEmitter } from './IpcCalendarEventEmitter';
import { SqliteCalendarRepository } from './SqliteCalendarRepository';

export const calendarService = new CalendarService(new SqliteCalendarRepository(), new IpcCalendarEventEmitter());
