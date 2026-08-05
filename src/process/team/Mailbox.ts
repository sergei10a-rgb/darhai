// src/process/team/Mailbox.ts
import type { EventLogger } from './EventLogger';
import type { ITeamRepository } from './repository/ITeamRepository';
import type { MailboxMessage } from './types';

/** Thin service layer over ITeamRepository's mailbox methods. */
export class Mailbox {
  /**
   * @param repo         underlying persistence
   * @param eventLogger  W1e - optional team_event_log writer. Each successful
   *                     `write()` appends a `'mailbox'` event. Logger absence
   *                     keeps the legacy callers (and tests) working unchanged.
   */
  constructor(
    private readonly repo: ITeamRepository,
    private readonly eventLogger?: EventLogger
  ) {}

  /**
   * Write a message to an agent's mailbox.
   * @returns The persisted message.
   */
  async write(params: {
    teamId: string;
    toAgentId: string;
    fromAgentId: string;
    content: string;
    type?: MailboxMessage['type'];
    summary?: string;
    files?: string[];
  }): Promise<MailboxMessage> {
    const message: MailboxMessage = {
      id: crypto.randomUUID(),
      teamId: params.teamId,
      toAgentId: params.toAgentId,
      fromAgentId: params.fromAgentId,
      type: params.type ?? 'message',
      content: params.content,
      summary: params.summary,
      files: params.files,
      read: false,
      createdAt: Date.now(),
    };

    const persisted = await this.repo.writeMessage(message);

    // W1e: log event AFTER successful persistence so failed writes don't pollute the log.
    if (this.eventLogger) {
      void this.eventLogger.append({
        teamId: params.teamId,
        eventType: 'mailbox',
        actorSlotId: params.fromAgentId,
        targetSlotId: params.toAgentId,
        payload: {
          messageId: persisted.id,
          type: persisted.type,
          summary: persisted.summary,
          hasFiles: Boolean(persisted.files && persisted.files.length > 0),
        },
      });
    }

    return persisted;
  }

  /**
   * Read all unread messages for an agent, atomically marking them as read.
   * Uses a single transaction to prevent concurrent double-reads.
   */
  async readUnread(teamId: string, agentId: string): Promise<MailboxMessage[]> {
    return this.repo.readUnreadAndMark(teamId, agentId);
  }

  /**
   * Look at an agent's unread messages without consuming them.
   *
   * `wake()` skips when a wake for the same agent is already running, so a
   * message that arrives mid-wake is never delivered by that wake. Peeking after
   * the turn ends is how we notice it is still sitting there.
   */
  async peekUnread(teamId: string, agentId: string): Promise<MailboxMessage[]> {
    return this.repo.peekUnread(teamId, agentId);
  }

  /**
   * Get message history for an agent (newest first).
   */
  async getHistory(teamId: string, agentId: string, limit?: number): Promise<MailboxMessage[]> {
    return this.repo.getMailboxHistory(teamId, agentId, limit);
  }
}
