// src/process/team/types.ts
//
// Re-export shared types from @/common so existing process-side imports
// continue to work. Renderer code should import from @/common/types/teamTypes.
export type {
  TeammateRole,
  TeammateStatus,
  WorkspaceMode,
  TeamAgent,
  TTeam,
  ITeamAgentSpawnedEvent,
  ITeamAgentStatusEvent,
} from '@/common/types/teamTypes';

// ---------- Process-only types (not needed by renderer) ----------

/**
 * An inter-agent mailbox message for asynchronous communication
 * between teammates inside a team.
 */
export type MailboxMessage = {
  id: string;
  teamId: string;
  toAgentId: string;
  fromAgentId: string;
  type: 'message' | 'idle_notification' | 'shutdown_request';
  content: string;
  summary?: string;
  files?: string[];
  read: boolean;
  createdAt: number;
};

/** A unit of work tracked inside a team's shared task board */
export type TeamTask = {
  id: string;
  teamId: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string; // slotId of the assigned agent
  blockedBy: string[]; // task ids this task depends on
  blocks: string[]; // task ids that depend on this task
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/**
 * Payload sent by an agent when it becomes idle, carrying the
 * reason and an optional summary of completed work.
 */
export type IdleNotification = {
  type: 'idle_notification';
  idleReason: 'available' | 'interrupted' | 'failed';
  summary: string;
  completedTaskId?: string;
  failureReason?: string;
};

// ---------- W1e — team_event_log primitives ----------

/**
 * Discriminator for `team_event_log.event_type`.
 *   - `mailbox`      — Mailbox.write fired
 *   - `task`         — TaskManager.create / update fired
 *   - `spawn`        — TeamSessionService.addAgent fired
 *   - `decision`     — reserved for future leader-side decision tracking
 *   - `wake`         — TeammateManager.wake completed (success or failure)
 *   - `shutdown`     — reserved for future session disposal tracking
 *   - `token_usage`  — agent conversation turn produced a usage report
 */
export type TeamEventType = 'mailbox' | 'task' | 'spawn' | 'decision' | 'wake' | 'shutdown' | 'token_usage';

/**
 * A single durable row in `team_event_log`. Foundation for the Activity tab
 * (W2c) and the cost meter (W2d). Append-only — never updated in place.
 */
export type TeamEvent = {
  id: string;
  teamId: string;
  eventType: TeamEventType;
  /** slotId of the agent (or `'user'`) that triggered the event, when known. */
  actorSlotId?: string;
  /** slotId of the agent (or task id, etc.) the event targeted, when known. */
  targetSlotId?: string;
  /** Event-specific JSON blob. Shape depends on `eventType` — see EventLogger. */
  payload: Record<string, unknown>;
  createdAt: number;
};
