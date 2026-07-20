/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IResearchEventEmitter } from './IResearchEventEmitter';
import type { ResearchRunChangedEvent } from '@/common/types/research';

/**
 * Emits run status changes via ipcBridge.research.onRunChanged so the Research
 * page (progress rail + recent-runs list) refreshes as the loop advances.
 */
export class IpcResearchEventEmitter implements IResearchEventEmitter {
  emitRunChanged(event: ResearchRunChangedEvent): void {
    ipcBridge.research.onRunChanged.emit(event);
  }
}
