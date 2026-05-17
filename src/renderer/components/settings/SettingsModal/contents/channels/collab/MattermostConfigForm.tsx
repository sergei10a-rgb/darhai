/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Credential form for the Mattermost channel plugin.
 * Mirrors MatrixConfigForm: JSON-encode creds for testPlugin IPC,
 * then enablePlugin with the raw credential fields.
 */

import { Button, Input, Message } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

import { channel } from '@/common/adapter/ipcBridge';
import type { IChannelPluginStatus } from '@process/channels/types';

const PreferenceRow: React.FC<{
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      <span className='text-14px text-t-primary'>{label}</span>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex items-center gap-8px'>{children}</div>
  </div>
);

export interface MattermostConfigFormProps {
  pluginStatus: IChannelPluginStatus | null;
  onStatusChange: (status: IChannelPluginStatus | null) => void;
}

const MattermostConfigForm: React.FC<MattermostConfigFormProps> = ({
  pluginStatus,
  onStatusChange,
}) => {
  const { t } = useTranslation();

  const [serverUrl, setServerUrl] = useState('https://');
  const [accessToken, setAccessToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [testLoading, setTestLoading] = useState(false);

  const hasExisting = !!pluginStatus?.hasToken;

  const handleTestAndEnable = async () => {
    if (!serverUrl.trim() || serverUrl.trim() === 'https://') {
      Message.warning(
        t(
          'settings.channels.mattermost.credentials.serverUrl.required',
          'Please enter the Mattermost server URL',
        ),
      );
      return;
    }
    if (!accessToken.trim()) {
      Message.warning(
        t(
          'settings.channels.mattermost.credentials.accessToken.required',
          'Please enter a personal access token',
        ),
      );
      return;
    }

    const tokenJson = JSON.stringify({
      serverUrl: serverUrl.trim(),
      accessToken: accessToken.trim(),
      ...(teamId.trim() ? { teamId: teamId.trim() } : {}),
    });

    setTestLoading(true);
    try {
      const testResult = await channel.testPlugin.invoke({
        pluginId: 'mattermost_default',
        token: tokenJson,
      });

      if (!testResult.success || !testResult.data?.success) {
        Message.error(
          testResult.data?.error ??
            t('settings.channels.mattermost.connectionFailed', 'Mattermost connection failed'),
        );
        return;
      }

      Message.success(
        t('settings.channels.mattermost.connectionSuccess', 'Mattermost connected'),
      );

      const enableResult = await channel.enablePlugin.invoke({
        pluginId: 'mattermost_default',
        config: {
          serverUrl: serverUrl.trim(),
          accessToken: accessToken.trim(),
          ...(teamId.trim() ? { teamId: teamId.trim() } : {}),
        },
      });

      if (enableResult.success) {
        Message.success(
          t('settings.channels.mattermost.pluginEnabled', 'Mattermost plugin enabled'),
        );
        const statusResult = await channel.getPluginStatus.invoke();
        if (statusResult.success && statusResult.data) {
          onStatusChange(
            statusResult.data.find((p) => p.type === 'mattermost') ?? null,
          );
        }
      } else {
        Message.error(
          enableResult.msg ??
            t('settings.channels.mattermost.enableFailed', 'Failed to enable Mattermost plugin'),
        );
      }
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className='flex flex-col gap-12px'>
      {hasExisting && (
        <div className='flex items-start gap-8px p-12px rd-8px bg-warning-1 text-warning border border-warning'>
          <AlertTriangle size={16} className='mt-2px flex-shrink-0' />
          <span className='text-12px'>
            {t(
              'settings.channels.mattermost.replaceWarning',
              'Connecting a new Mattermost account will replace your existing one.',
            )}
          </span>
        </div>
      )}

      <PreferenceRow
        label={t(
          'settings.channels.mattermost.credentials.serverUrl.label',
          'Server URL',
        )}
        description={t(
          'settings.channels.mattermost.credentials.serverUrl.help',
          'Full HTTPS base URL of your Mattermost server, e.g. https://mattermost.example.com',
        )}
      >
        <Input
          value={serverUrl}
          onChange={setServerUrl}
          placeholder='https://mattermost.example.com'
          style={{ width: 280 }}
        />
      </PreferenceRow>

      <PreferenceRow
        label={t(
          'settings.channels.mattermost.credentials.accessToken.label',
          'Personal Access Token',
        )}
        description={t(
          'settings.channels.mattermost.credentials.accessToken.help',
          'Create in Mattermost under Account Settings → Security → Personal Access Tokens.',
        )}
      >
        <Input.Password
          value={accessToken}
          onChange={setAccessToken}
          placeholder={
            hasExisting
              ? '••••••••••••••••'
              : t(
                  'settings.channels.mattermost.credentials.accessToken.placeholder',
                  'your-personal-access-token',
                )
          }
          style={{ width: 280 }}
          visibilityToggle
        />
      </PreferenceRow>

      <PreferenceRow
        label={t(
          'settings.channels.mattermost.credentials.teamId.label',
          'Team ID (optional)',
        )}
        description={t(
          'settings.channels.mattermost.credentials.teamId.help',
          'Limit the bot to a specific team. Leave blank to receive messages from all teams.',
        )}
      >
        <Input
          value={teamId}
          onChange={setTeamId}
          placeholder={t(
            'settings.channels.mattermost.credentials.teamId.placeholder',
            'team-id or leave blank',
          )}
          style={{ width: 280 }}
        />
      </PreferenceRow>

      <div className='flex justify-end pt-8px'>
        <Button type='primary' loading={testLoading} onClick={() => void handleTestAndEnable()}>
          {t('settings.channels.mattermost.testAndEnable', 'Test & Enable')}
        </Button>
      </div>
    </div>
  );
};

export default MattermostConfigForm;
