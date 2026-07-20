/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EmailTriageUpdatedEvent } from '@/common/types/emailTriage';

/** Notifies open surfaces that a triage entry was written. */
export interface IEmailTriageEventEmitter {
  emitUpdated(event: EmailTriageUpdatedEvent): void;
}
