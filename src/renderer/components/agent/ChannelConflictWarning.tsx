/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { AlertCircle } from 'lucide-react';
import { Alert, Button, Link, Space, Typography } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

const { Paragraph, Text } = Typography;

interface ChannelConflictWarningProps {
  platform: 'lark' | 'telegram';
  openclawConfigPath: string;
  onDisableOpenClaw?: () => void;
  onIgnore?: () => void;
}

/**
 * Warning component when OpenClaw channel conflicts with Дархай Channels
 */
export const ChannelConflictWarning: React.FC<ChannelConflictWarningProps> = ({
  platform,
  openclawConfigPath,
  onDisableOpenClaw,
  onIgnore,
}) => {
  const { t } = useTranslation();
  const platformName = platform === 'lark' ? 'Lark/Feishu' : 'Telegram';
  const channelKey = platform === 'lark' ? 'feishu' : 'telegram';

  return (
    <Alert
      type='warning'
      icon={<AlertCircle />}
      title={t('settings.channelConflict.title', {
        platform: platformName,
        defaultValue: '{{platform}} Channel Conflict Detected',
      })}
      content={
        <Space direction='vertical' size='medium' style={{ width: '100%' }}>
          <Paragraph>
            <Text bold>
              {t('settings.channelConflict.headline', {
                platform: platformName,
                defaultValue: 'OpenClaw is handling {{platform}} messages, not Дархай.',
              })}
            </Text>
          </Paragraph>

          <Paragraph>
            {t('settings.channelConflict.credsAlso', {
              platform: platformName,
              defaultValue: 'Your {{platform}} bot credentials are also configured in OpenClaw. This means:',
            })}
            <ul>
              <li>
                <Text type='error'>
                  {t('settings.channelConflict.effectNoSwitch', {
                    defaultValue: '✗ Switching agents in Дархай will have no effect',
                  })}
                </Text>
              </li>
              <li>
                <Text type='error'>
                  {t('settings.channelConflict.effectProcessed', {
                    defaultValue: "✗ Messages are processed by OpenClaw's agent",
                  })}
                </Text>
              </li>
              <li>
                <Text type='success'>
                  {t('settings.channelConflict.effectStillWork', {
                    defaultValue: '✓ Messages still work (via OpenClaw)',
                  })}
                </Text>
              </li>
            </ul>
          </Paragraph>

          <Paragraph>
            <Text bold>
              {t('settings.channelConflict.toUse', {
                defaultValue: 'To use Дархай Channels and switch agents:',
              })}
            </Text>
          </Paragraph>

          <Paragraph>
            <Text type='secondary'>
              {t('settings.channelConflict.option1', {
                platform: platformName,
                defaultValue: 'Option 1: Disable OpenClaw {{platform}} (Recommended)',
              })}
            </Text>
            <br />
            {t('settings.channelConflict.option1Edit', { defaultValue: 'Edit:' })}{' '}
            <Text code>{openclawConfigPath}</Text>
            <br />
            {t('settings.channelConflict.option1Set', { defaultValue: 'Set:' })}{' '}
            <Text code>{`channels.${channelKey}.enabled = false`}</Text>
            <br />
            {t('settings.channelConflict.option1Restart', {
              defaultValue: 'Then restart OpenClaw and Дархай.',
            })}
          </Paragraph>

          <Paragraph>
            <Text type='secondary'>
              {t('settings.channelConflict.option2', { defaultValue: 'Option 2: Use a different bot' })}
            </Text>
            <br />
            {t('settings.channelConflict.option2Body', {
              platform: platformName,
              defaultValue: 'Create a new {{platform}} bot with different credentials for Дархай.',
            })}
          </Paragraph>

          <Paragraph>
            <Text type='secondary'>
              {t('settings.channelConflict.option3', { defaultValue: 'Option 3: Keep using OpenClaw' })}
            </Text>
            <br />
            {t('settings.channelConflict.option3Body', {
              platform: platformName,
              defaultValue: "Disable {{platform}} in Дархай Channels and continue using OpenClaw's integration.",
            })}
          </Paragraph>

          <Space>
            {onDisableOpenClaw && (
              <Button type='primary' onClick={onDisableOpenClaw}>
                {t('settings.channelConflict.helpDisable', {
                  platform: platformName,
                  defaultValue: 'Help me disable OpenClaw {{platform}}',
                })}
              </Button>
            )}
            {onIgnore && (
              <Button type='text' onClick={onIgnore}>
                {t('settings.channelConflict.ignore', { defaultValue: "Ignore (I know what I'm doing)" })}
              </Button>
            )}
          </Space>
        </Space>
      }
      closable={false}
      style={{ marginBottom: 16 }}
    />
  );
};

/**
 * Compact warning banner (for settings page)
 */
export const ChannelConflictBanner: React.FC<{ platform: 'lark' | 'telegram'; onLearnMore: () => void }> = ({
  platform,
  onLearnMore,
}) => {
  const { t } = useTranslation();
  const platformName = platform === 'lark' ? 'Lark/Feishu' : 'Telegram';

  return (
    <Alert
      type='warning'
      content={
        <Space>
          <Text>
            {t('settings.channelConflict.bannerText', {
              platform: platformName,
              defaultValue: "⚠️ OpenClaw {{platform}} conflict detected - Agent switching won't work.",
            })}
          </Text>
          <Link onClick={onLearnMore}>
            {t('settings.channelConflict.learnMore', { defaultValue: 'Learn more' })}
          </Link>
        </Space>
      }
      closable
      style={{ marginBottom: 12 }}
    />
  );
};
