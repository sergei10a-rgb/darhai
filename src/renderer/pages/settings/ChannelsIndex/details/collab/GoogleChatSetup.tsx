/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { channel } from '@/common/adapter/ipcBridge';
import type { IChannelPluginStatus } from '@process/channels/types';
import GoogleChatConfigForm from '@renderer/components/settings/SettingsModal/contents/channels/collab/GoogleChatConfigForm';

import ChannelDetailLayout from '../../ChannelDetailLayout';

const GoogleChatSetup: React.FC = () => {
  const { t } = useTranslation();
  const [pluginStatus, setPluginStatus] = useState<IChannelPluginStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const result = await channel.getPluginStatus.invoke();
      if (result.success && result.data) {
        setPluginStatus(result.data.find((p) => p.type === 'google-chat') ?? null);
      }
    } catch (error) {
      console.error('[GoogleChatSetup] loadStatus failed:', error);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const unsubscribe = channel.pluginStatusChanged.on(({ status }) => {
      if (status.type === 'google-chat') setPluginStatus(status);
    });
    return () => unsubscribe();
  }, []);

  return (
    <ChannelDetailLayout
      channelId='google-chat'
      displayName='Google Chat'
      pluginId={pluginStatus?.id ?? 'google-chat_default'}
      helpText={t(
        'settings.channels.googleChat.help',
        'Google Chat (Workspace) bot. Paste your service-account JSON keyfile and provide the expected JWT audience (project number or app URL) for webhook verification.',
      )}
    >
      <GoogleChatConfigForm pluginStatus={pluginStatus} onStatusChange={setPluginStatus} />
    </ChannelDetailLayout>
  );
};

export default GoogleChatSetup;
