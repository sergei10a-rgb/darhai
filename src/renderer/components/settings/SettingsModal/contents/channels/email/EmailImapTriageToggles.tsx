/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Alert, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { PreferenceRow } from './PreferenceRow';
import type { TriageConfig } from '@/common/types/emailTriage';

/**
 * AI triage feature toggles for the Email (IMAP) channel (Odysseus assimilation
 * "email pollers"). A master switch plus five per-pass switches. All default
 * OFF; the per-pass rows only show once triage is enabled.
 *
 * A prominent safety note states that drafts are NEVER auto-sent - the whole
 * feature is draft-only, enforced structurally in the plugin ingress.
 */
type EmailImapTriageTogglesProps = {
  value: TriageConfig;
  onChange: (next: TriageConfig) => void;
};

const EmailImapTriageToggles: React.FC<EmailImapTriageTogglesProps> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const set = (patch: Partial<TriageConfig>): void => onChange({ ...value, ...patch });

  return (
    <>
      <div className='text-13px font-medium text-t-secondary mt-16px'>
        {t('settings.channels.emailImap.triage.config.sectionTitle')}
      </div>
      <Alert type='info' content={t('settings.channels.emailImap.triage.config.draftSafetyNote')} />

      <PreferenceRow
        label={t('settings.channels.emailImap.triage.config.enable.label')}
        description={t('settings.channels.emailImap.triage.config.enable.help')}
      >
        <Switch checked={value.triageEnabled} onChange={(v) => set({ triageEnabled: v })} />
      </PreferenceRow>

      {value.triageEnabled && (
        <>
          <PreferenceRow
            label={t('settings.channels.emailImap.triage.config.urgent.label')}
            description={t('settings.channels.emailImap.triage.config.urgent.help')}
          >
            <Switch checked={value.triageUrgent} onChange={(v) => set({ triageUrgent: v })} />
          </PreferenceRow>

          <PreferenceRow
            label={t('settings.channels.emailImap.triage.config.tag.label')}
            description={t('settings.channels.emailImap.triage.config.tag.help')}
          >
            <Switch checked={value.triageTag} onChange={(v) => set({ triageTag: v })} />
          </PreferenceRow>

          <PreferenceRow
            label={t('settings.channels.emailImap.triage.config.spam.label')}
            description={t('settings.channels.emailImap.triage.config.spam.help')}
          >
            <Switch checked={value.triageSpam} onChange={(v) => set({ triageSpam: v })} />
          </PreferenceRow>

          <PreferenceRow
            label={t('settings.channels.emailImap.triage.config.summary.label')}
            description={t('settings.channels.emailImap.triage.config.summary.help')}
          >
            <Switch checked={value.triageSummary} onChange={(v) => set({ triageSummary: v })} />
          </PreferenceRow>

          <PreferenceRow
            label={t('settings.channels.emailImap.triage.config.draft.label')}
            description={t('settings.channels.emailImap.triage.config.draft.help')}
          >
            <Switch checked={value.triageDraft} onChange={(v) => set({ triageDraft: v })} />
          </PreferenceRow>
        </>
      )}
    </>
  );
};

export default EmailImapTriageToggles;
