/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { DocumentService } from './DocumentService';
import { IpcDocumentEventEmitter } from './IpcDocumentEventEmitter';
import { SqliteDocumentRepository } from './SqliteDocumentRepository';

export const documentService = new DocumentService(new SqliteDocumentRepository(), new IpcDocumentEventEmitter());
