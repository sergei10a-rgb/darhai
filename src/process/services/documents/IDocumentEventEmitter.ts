/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DocumentChangedEvent } from '@/common/types/documents';

export interface IDocumentEventEmitter {
  emitDocumentChanged(event: DocumentChangedEvent): void;
}
