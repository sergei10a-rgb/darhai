/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Input, Message, Tag } from '@arco-design/web-react';
import { Inbox, Send, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { emailTriage } from '@/common/adapter/ipcBridge';
import type { EmailTriageEntry, EmailUrgency } from '@/common/types/emailTriage';

/**
 * Triaged-inbox surface for the Email (IMAP) channel. Lists the AI-triage
 * results the plugin persisted at ingress (urgency, tags, spam verdict, summary,
 * and the DRAFT reply), and lets the user review + edit a draft and explicitly
 * send it. Sending is the ONLY outbound action here and it always requires a
 * human click - the triage layer never auto-sends.
 *
 * Subscribes to `emailTriage.updated` so the list refreshes live as background
 * triage completes.
 */

/** Map an urgency to an Arco Tag color. */
const URGENCY_COLOR: Record<EmailUrgency, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'gold',
  low: 'gray',
  none: 'gray',
};

type TriageEntryCardProps = {
  entry: EmailTriageEntry;
  onSend: (messageId: string, editedBody: string) => Promise<void>;
};

const TriageEntryCard: React.FC<TriageEntryCardProps> = ({ entry, onSend }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>(entry.draftReply);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    setSending(true);
    try {
      await onSend(entry.messageId, draft);
    } finally {
      setSending(false);
    }
  }, [onSend, entry.messageId, draft]);

  const urgencyLabel = t(`settings.channels.emailImap.triage.urgency.${entry.urgency}`);

  return (
    <div className='flex flex-col gap-8px rounded-8px border border-solid border-fill-3 p-16px'>
      <div className='flex items-center justify-between gap-12px'>
        <div className='flex min-w-0 flex-col'>
          <span className='truncate text-14px font-medium text-t-primary'>
            {entry.subject || t('settings.channels.emailImap.triage.noSubject')}
          </span>
          <span className='truncate text-12px text-t-tertiary'>
            {t('settings.channels.emailImap.triage.from')}: {entry.fromAddr}
          </span>
        </div>
        <div className='flex flex-shrink-0 items-center gap-6px'>
          {entry.urgency !== 'none' && <Tag color={URGENCY_COLOR[entry.urgency]}>{urgencyLabel}</Tag>}
          {entry.spamVerdict && (
            <Tag color='red' icon={<ShieldAlert size={12} />}>
              {t('settings.channels.emailImap.triage.spamFlag')}
            </Tag>
          )}
        </div>
      </div>

      {entry.tags.length > 0 && (
        <div className='flex flex-wrap items-center gap-6px'>
          {entry.tags.map((tag) => (
            <Tag key={tag} color='arcoblue' bordered>
              {t(`settings.channels.emailImap.triage.tags.${tag}`)}
            </Tag>
          ))}
        </div>
      )}

      {entry.summary && (
        <div className='flex flex-col gap-2px'>
          <span className='text-12px font-medium text-t-secondary'>
            {t('settings.channels.emailImap.triage.summaryLabel')}
          </span>
          <div className='whitespace-pre-wrap text-13px text-t-secondary'>{entry.summary}</div>
        </div>
      )}

      <div className='flex flex-col gap-4px'>
        <span className='text-12px font-medium text-t-secondary'>
          {t('settings.channels.emailImap.triage.draftLabel')}
        </span>
        <Input.TextArea
          value={draft}
          onChange={(value) => setDraft(value)}
          autoSize={{ minRows: 3, maxRows: 10 }}
          placeholder={t('settings.channels.emailImap.triage.draftPlaceholder')}
        />
        <div className='flex justify-end'>
          <Button
            type='primary'
            size='small'
            icon={<Send size={14} />}
            loading={sending}
            disabled={draft.trim().length === 0}
            onClick={() => void handleSend()}
          >
            {t('settings.channels.emailImap.triage.sendDraft')}
          </Button>
        </div>
      </div>
    </div>
  );
};

type EmailImapTriageViewProps = {
  pluginId: string;
};

const EmailImapTriageView: React.FC<EmailImapTriageViewProps> = ({ pluginId }) => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<EmailTriageEntry[]>([]);

  const loadEntries = useCallback(async () => {
    if (!pluginId) return;
    try {
      const result = await emailTriage.list.invoke({ pluginId });
      setEntries(result);
    } catch (error) {
      console.error('[EmailImapTriageView] load failed:', error);
    }
  }, [pluginId]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  // Live refresh: any triage update for this plugin re-pulls the list.
  useEffect(() => {
    const unsubscribe = emailTriage.onUpdated.on((event) => {
      if (event.pluginId === pluginId) void loadEntries();
    });
    return () => unsubscribe();
  }, [pluginId, loadEntries]);

  const handleSend = useCallback(
    async (messageId: string, editedBody: string): Promise<void> => {
      try {
        await emailTriage.sendDraft.invoke({ pluginId, messageId, editedBody });
        Message.success(t('settings.channels.emailImap.triage.sent'));
        await loadEntries();
      } catch (error) {
        Message.error(error instanceof Error ? error.message : t('settings.channels.emailImap.triage.sendFailed'));
      }
    },
    [pluginId, loadEntries, t]
  );

  return (
    <div className='flex flex-col gap-16px'>
      <div className='flex items-center gap-8px'>
        <Inbox size={16} className='text-t-secondary' />
        <span className='text-13px font-medium text-t-secondary'>
          {t('settings.channels.emailImap.triage.viewTitle')}
        </span>
      </div>

      {entries.length === 0 ? (
        <Empty description={t('settings.channels.emailImap.triage.empty')} />
      ) : (
        <div className='flex flex-col gap-12px'>
          {entries.map((entry) => (
            <TriageEntryCard key={entry.messageId} entry={entry} onSend={handleSend} />
          ))}
        </div>
      )}
    </div>
  );
};

export default EmailImapTriageView;
