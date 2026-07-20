/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IDocumentEventEmitter } from './IDocumentEventEmitter';
import type { DocumentChangedEvent } from '@/common/types/documents';

/**
 * Emits document mutation events via ipcBridge.documents.onDocumentChanged so any
 * open surface (the Documents workspace, another window) refreshes.
 */
export class IpcDocumentEventEmitter implements IDocumentEventEmitter {
  emitDocumentChanged(event: DocumentChangedEvent): void {
    ipcBridge.documents.onDocumentChanged.emit(event);
  }
}
