/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IActionContext, IActionResult, IRegisteredAction, ActionHandler } from './types';
import { PlatformActionNames, createSuccessResponse, createErrorResponse } from './types';
import { getPairingService } from '../pairing/PairingService';
import {
  createPairingCodeKeyboard,
  createPairingStatusKeyboard,
  createMainMenuKeyboard,
} from '../plugins/telegram/TelegramKeyboards';
import {
  createPairingCard,
  createPairingStatusCard,
  createMainMenuCard,
  createPairingHelpCard,
} from '../plugins/lark/LarkCards';
import {
  createMainMenuCard as createDingTalkMainMenuCard,
  createPairingCard as createDingTalkPairingCard,
  createPairingStatusCard as createDingTalkPairingStatusCard,
  createPairingHelpCard as createDingTalkPairingHelpCard,
} from '../plugins/dingtalk/DingTalkCards';

/**
 * PlatformActions - Handlers for platform-specific actions
 *
 * Supports both Telegram and Lark platforms with platform-specific UI components.
 * These actions are handled by the plugin itself, not through the Gateway.
 */

// ==================== Platform-specific Markup Helpers ====================

/**
 * Get main menu markup based on platform
 */
function getMainMenuMarkup(platform: string) {
  if (platform === 'lark') {
    return createMainMenuCard();
  }
  if (platform === 'dingtalk') {
    return createDingTalkMainMenuCard();
  }
  return createMainMenuKeyboard();
}

/**
 * Get pairing code markup based on platform
 */
function getPairingCodeMarkup(platform: string, code: string) {
  if (platform === 'lark') {
    return createPairingCard(code);
  }
  if (platform === 'dingtalk') {
    return createDingTalkPairingCard(code);
  }
  return createPairingCodeKeyboard();
}

/**
 * Get pairing status markup based on platform
 */
function getPairingStatusMarkup(platform: string, code: string) {
  if (platform === 'lark') {
    return createPairingStatusCard(code);
  }
  if (platform === 'dingtalk') {
    return createDingTalkPairingStatusCard(code);
  }
  return createPairingStatusKeyboard();
}

/**
 * Get pairing help markup based on platform
 */
function getPairingHelpMarkup(platform: string) {
  if (platform === 'lark') {
    return createPairingHelpCard();
  }
  if (platform === 'dingtalk') {
    return createDingTalkPairingHelpCard();
  }
  return createPairingCodeKeyboard();
}

/**
 * Handle pairing.show - Show pairing code to user
 * Called when user sends /start or first message
 */
export const handlePairingShow: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (await pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: [
        '✅ <b>Зөвшөөрөгдсөн</b>',
        '',
        'Таны бүртгэл аль хэдийн хослуулагдсан, ашиглахад бэлэн.',
        '',
        'Чатлаж эхлэхийн тулд мессеж илгээх эсвэл доорх товчнуудыг ашиглана уу.',
      ].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Generate pairing code
  try {
    const { code, expiresAt } = await pairingService.generatePairingCode(context.userId, platform, context.displayName);

    const expiresInMinutes = Math.ceil((expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: [
        '🔗 <b>Төхөөрөмж хослуулах</b>',
        '',
        'Энэ хослуулалтын хүсэлтийг Дархай апп дотор зөвшөөрнө үү:',
        '',
        `<code>${code}</code>`,
        '',
        `⏱ Хүчинтэй хугацаа: ${expiresInMinutes} минут`,
        '',
        '<b>Алхмууд:</b>',
        '1. Дархай аппыг нээнэ үү',
        '2. Тохиргоо → Сувгууд руу орно уу',
        '3. Хүлээгдэж буй хослуулалтын хүсэлтийг зөвшөөрнө үү',
      ].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingCodeMarkup(platform, code),
    });
  } catch (error: any) {
    return createErrorResponse(`Failed to generate pairing code: ${error.message}`);
  }
};

/**
 * Handle pairing.refresh - Refresh pairing code
 */
export const handlePairingRefresh: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (await pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: '✅ Та аль хэдийн хослуулагдсан байна. Хослуулалтын код шинэчлэх шаардлагагүй.',
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Generate new pairing code
  try {
    const { code, expiresAt } = await pairingService.refreshPairingCode(context.userId, platform, context.displayName);

    const expiresInMinutes = Math.ceil((expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: [
        '🔄 <b>Шинэ хослуулалтын код</b>',
        '',
        `<code>${code}</code>`,
        '',
        `⏱ Хүчинтэй хугацаа: ${expiresInMinutes} минут`,
        '',
        'Энэ хослуулалтын хүсэлтийг Дархайн тохиргоонд зөвшөөрнө үү.',
      ].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingCodeMarkup(platform, code),
    });
  } catch (error: any) {
    return createErrorResponse(`Failed to refresh pairing code: ${error.message}`);
  }
};

/**
 * Handle pairing.check - Check pairing status
 */
export const handlePairingCheck: ActionHandler = async (context) => {
  const pairingService = getPairingService();
  const platform = context.platform;

  // Check if user is already authorized
  if (await pairingService.isUserAuthorized(context.userId, platform)) {
    return createSuccessResponse({
      type: 'text',
      text: [
        '✅ <b>Хослуулалт амжилттай!</b>',
        '',
        'Таны бүртгэл хослуулагдлаа, ашиглахад бэлэн.',
        '',
        'AI туслахтай чатлахын тулд мессеж илгээгээрэй.',
      ].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getMainMenuMarkup(platform),
    });
  }

  // Check for pending request
  const pendingRequest = await pairingService.getPendingRequestForUser(context.userId, platform);

  if (pendingRequest) {
    const expiresInMinutes = Math.ceil((pendingRequest.expiresAt - Date.now()) / 1000 / 60);

    return createSuccessResponse({
      type: 'text',
      text: [
        '⏳ <b>Зөвшөөрөл хүлээж байна</b>',
        '',
        `Хослуулалтын код: <code>${pendingRequest.code}</code>`,
        `Үлдсэн хугацаа: ${expiresInMinutes} минут`,
        '',
        'Хослуулалтын хүсэлтийг Дархайн тохиргоонд зөвшөөрнө үү.',
      ].join('\n'),
      parseMode: 'HTML',
      replyMarkup: getPairingStatusMarkup(platform, pendingRequest.code),
    });
  }

  // No pending request - need to generate new code
  return handlePairingShow(context);
};

/**
 * Handle pairing.help - Show pairing help
 */
export const handlePairingHelp: ActionHandler = async (context) => {
  const platform = context.platform;
  const platformName =
    platform === 'lark'
      ? 'Lark/Feishu'
      : platform === 'dingtalk'
        ? 'DingTalk'
        : platform === 'wecom'
          ? 'WeCom'
          : 'Telegram';

  return createSuccessResponse({
    type: 'text',
    text: [
      '❓ <b>Хослуулалтын тусламж</b>',
      '',
      '<b>Хослуулалт гэж юу вэ?</b>',
      `Хослуулалт нь таны ${platformName} бүртгэлийг локал Дархай апптай холбоно.`,
      'AI туслахыг ашиглахын өмнө хослуулах шаардлагатай.',
      '',
      '<b>Хослуулах алхмууд:</b>',
      '1. Хослуулалтын код авна уу (дурын мессеж илгээх)',
      '2. Дархай аппыг нээнэ үү',
      '3. Тохиргоо → Сувгууд руу орно уу',
      '4. Хүлээгдэж буй хослуулалтын хүсэлтийг зөвшөөрнө үү',
      '',
      '<b>Түгээмэл асуулт:</b>',
      '• Хослуулалтын код 10 минут хүчинтэй, хугацаа дуусвал шинэчилнэ үү',
      '• Дархай апп ажиллаж байх ёстой',
      '• Сүлжээний холболт тогтвортой байх ёстой',
    ].join('\n'),
    parseMode: 'HTML',
    replyMarkup: getPairingHelpMarkup(platform),
  });
};

/**
 * All platform actions
 */
export const platformActions: IRegisteredAction[] = [
  {
    name: PlatformActionNames.PAIRING_SHOW,
    category: 'platform',
    description: 'Show pairing code',
    handler: handlePairingShow,
  },
  {
    name: PlatformActionNames.PAIRING_REFRESH,
    category: 'platform',
    description: 'Refresh pairing code',
    handler: handlePairingRefresh,
  },
  {
    name: PlatformActionNames.PAIRING_CHECK,
    category: 'platform',
    description: 'Check pairing status',
    handler: handlePairingCheck,
  },
  {
    name: PlatformActionNames.PAIRING_HELP,
    category: 'platform',
    description: 'Show pairing help',
    handler: handlePairingHelp,
  },
];
