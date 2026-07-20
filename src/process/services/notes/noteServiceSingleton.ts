/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { NoteService } from './NoteService';
import { IpcNoteEventEmitter } from './IpcNoteEventEmitter';
import { SqliteNoteRepository } from './SqliteNoteRepository';

export const noteService = new NoteService(new SqliteNoteRepository(), new IpcNoteEventEmitter());
