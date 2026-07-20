/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResearchRunChangedEvent } from '@/common/types/research';

export interface IResearchEventEmitter {
  emitRunChanged(event: ResearchRunChangedEvent): void;
}
