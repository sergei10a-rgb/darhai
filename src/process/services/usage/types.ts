/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Closed set of telemetry events fed into the Launchpad predictive widget.
 * Adding a new event type requires updating both the producer (usually a
 * renderer hook) and the dashboard analytics that consumes them.
 */
export type UsageEventType =
  | 'launchpad.card_clicked'
  | 'launchpad.view_all_clicked'
  | 'launchpad.intent_pill_clicked'
  | 'launchpad.intent_prompt_clicked'
  | 'guid.assistant_selected'
  | 'guid.cli_selected'
  | 'guid.model_selected'
  | 'guid.message_sent'
  | 'guid.foreground'
  | 'dashboard.opened'
  | 'dashboard.widget_clicked'
  | 'dashboard.summary_requested';

export type UsageEvent = {
  id: string;
  timestampMs: number;
  eventType: UsageEventType;
  anchorId?: string;
  assistantId?: string;
  cliBackend?: string;
  metadata?: Record<string, unknown>;
};

export interface IUsageEventRepository {
  append(event: UsageEvent): Promise<void>;
  findSince(sinceMs: number): Promise<UsageEvent[]>;
  findByType(eventType: UsageEventType, sinceMs: number): Promise<UsageEvent[]>;
}
