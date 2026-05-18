/**
 * @license
 * Copyright 2026 Wayland (tradecanyon.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * IMessageSetup — settings detail page for the macOS iMessage channel plugin.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { channel } from '@/common/adapter/ipcBridge';
import type { IChannelPluginStatus } from '@process/channels/types';
import IMessageConfigForm from '@renderer/components/settings/SettingsModal/contents/channels/messaging/IMessageConfigForm';
import ChannelDetailLayout from '../../ChannelDetailLayout';

const IMessageSetup: React.FC = () => {
  const { t } = useTranslation();
  const [pluginStatus, setPluginStatus] = useState<IChannelPluginStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const result = await channel.getPluginStatus.invoke();
      if (result.success && result.data) {
        setPluginStatus(result.data.find((p) => p.type === 'imessage') ?? null);
      }
    } catch (error) {
      console.error('[IMessageSetup] loadStatus failed:', error);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const unsub = channel.pluginStatusChanged.on(({ status }) => {
      if (status.type === 'imessage') setPluginStatus(status);
    });
    return () => unsub();
  }, []);

  return (
    <ChannelDetailLayout
      channelId='imessage'
      displayName='iMessage'
      pluginId='imessage_default'
      helpText={
        t(
          'settings.channels.imessage.help',
          'macOS-only. Polls chat.db (requires Full Disk Access) and sends via AppleScript (requires Automation consent for Messages.app — accept the OS prompt when it appears, or grant in System Settings → Privacy & Security → Automation).',
        ) +
        ' ' +
        t(
          'settings.channels.imessage.attachmentsHelp',
          'Text-only — image, video, and audio attachments are dropped silently on inbound and not supported on outbound.',
        )
      }
    >
      <IMessageConfigForm pluginStatus={pluginStatus} onStatusChange={setPluginStatus} />
    </ChannelDetailLayout>
  );
};

export default IMessageSetup;
