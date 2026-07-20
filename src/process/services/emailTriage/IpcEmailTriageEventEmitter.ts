/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IEmailTriageEventEmitter } from './IEmailTriageEventEmitter';
import type { EmailTriageUpdatedEvent } from '@/common/types/emailTriage';

/**
 * Emits triage updates via ipcBridge.emailTriage.onUpdated so the triaged-inbox
 * view refreshes live as each inbound email is triaged in the background.
 */
export class IpcEmailTriageEventEmitter implements IEmailTriageEventEmitter {
  emitUpdated(event: EmailTriageUpdatedEvent): void {
    ipcBridge.emailTriage.onUpdated.emit(event);
  }
}
