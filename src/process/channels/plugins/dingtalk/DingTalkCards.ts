/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelAgentType } from '../../types';

/**
 * DingTalk Message Cards for Personal Assistant
 *
 * DingTalk uses interactive message cards (ActionCard).
 * Cards support markdown content, buttons, and action callbacks.
 *
 * Card Structure:
 * - title: Card title
 * - text: Markdown content
 * - btnOrientation: Button layout ('0' vertical, '1' horizontal)
 * - btns: Array of buttons with title and actionURL
 *
 * For AI Card streaming, a different API flow is used (create -> stream -> finish).
 * These cards are used for static interactive messages.
 */

// ==================== Types ====================

/**
 * DingTalk card button
 */
export interface DingTalkButton {
  title: string;
  actionURL: string;
}

/**
 * DingTalk ActionCard structure
 */
export interface DingTalkCard {
  title: string;
  text: string;
  btnOrientation?: string;
  btns?: DingTalkButton[];
  singleTitle?: string;
  singleURL?: string;
}

/**
 * Agent info for card display
 */
export interface AgentDisplayInfo {
  type: ChannelAgentType;
  emoji: string;
  name: string;
}

// ==================== Helpers ====================

/**
 * Build a callback action URL for DingTalk card buttons
 * Uses a custom protocol that the plugin will intercept
 */
function actionUrl(action: string, params?: Record<string, string>): string {
  const allParams = { action, ...params };
  return `dtmd://dingtalkclient/sendMessage?content=${encodeURIComponent(JSON.stringify(allParams))}`;
}

/**
 * Build button from action info
 */
function btn(label: string, action: string, params?: Record<string, string>): DingTalkButton {
  return {
    title: label,
    actionURL: actionUrl(action, params),
  };
}

// ==================== Card Builders ====================

/**
 * Create main menu card
 */
export function createMainMenuCard(): DingTalkCard {
  return {
    title: 'Дархай туслах',
    text: '### Дархай туслах\n\nТавтай морил! Доорх үйлдлээс сонгоно уу:',
    btnOrientation: '1',
    btns: [
      btn('Шинэ чат', 'session.new'),
      btn('Агент', 'agent.show'),
      btn('Төлөв', 'session.status'),
      btn('Тусламж', 'help.show'),
    ],
  };
}

/**
 * Create pairing card
 */
export function createPairingCard(pairingCode: string): DingTalkCard {
  return {
    title: 'Хослуулалт шаардлагатай',
    text: [
      '### Хослуулалт шаардлагатай',
      '',
      'Бүртгэлээ Дархайтай хослуулна уу:',
      '',
      `**Хослуулалтын код:** \`${pairingCode}\``,
      '',
      '1. Дархайн тохиргоог нээнэ үү',
      '2. Сувгууд > DingTalk руу орно уу',
      '3. Энэ хослуулалтын кодыг оруулна уу',
      '',
      'Кодын хүчинтэй хугацаа 10 минут.',
    ].join('\n'),
    btnOrientation: '1',
    btns: [btn('Код шинэчлэх', 'pairing.refresh'), btn('Тусламж', 'pairing.help')],
  };
}

/**
 * Create pairing status card
 */
export function createPairingStatusCard(pairingCode: string): DingTalkCard {
  return {
    title: 'Зөвшөөрөл хүлээж байна',
    text: [
      '### Зөвшөөрөл хүлээж байна',
      '',
      'Таны хослуулалтын хүсэлт зөвшөөрөл хүлээж байна.',
      '',
      `**Хослуулалтын код:** \`${pairingCode}\``,
      '',
      'Дархайн тохиргоонд зөвшөөрнө үү:',
      '1. Дархай аппыг нээнэ үү',
      '2. WebUI > Сувгууд руу орно уу',
      '3. Энэ кодын ард "Зөвшөөрөх" дарна уу',
    ].join('\n'),
    btnOrientation: '1',
    btns: [btn('Төлөв шалгах', 'pairing.check'), btn('Шинэ код', 'pairing.refresh')],
  };
}

/**
 * Create pairing help card
 */
export function createPairingHelpCard(): DingTalkCard {
  return {
    title: 'Хослуулалтын тусламж',
    text: [
      '### Хослуулалтын тусламж',
      '',
      '**Хослуулалт гэж юу вэ?**',
      'Хослуулалт нь таны DingTalk бүртгэлийг локал Дархай апптай холбоно.',
      'AI туслахыг ашиглахын өмнө хослуулах шаардлагатай.',
      '',
      '**Хэрхэн хослуулах вэ:**',
      '1. Энэ ботод дурын мессеж илгээнэ үү',
      '2. Танд хослуулалтын код ирнэ',
      '3. Дархай десктоп аппыг нээнэ үү',
      '4. WebUI > Сувгууд > DingTalk руу орно уу',
      '5. Кодынхоо ард "Зөвшөөрөх" дарна уу',
      '',
      '**Түгээмэл асуулт:**',
      '- Хослуулалтын код 10 минут хүчинтэй',
      '- Дархай апп ажиллаж байх ёстой',
      '- Нэг бүртгэл зөвхөн нэг удаа хослуулна',
    ].join('\n'),
    btns: [btn('Хослуулалтын код авах', 'pairing.show')],
  };
}

/**
 * Create agent selection card
 */
export function createAgentSelectionCard(
  availableAgents: AgentDisplayInfo[],
  currentAgent?: ChannelAgentType
): DingTalkCard {
  const currentAgentInfo = availableAgents.find((a) => a.type === currentAgent);
  const currentAgentName = currentAgentInfo ? `${currentAgentInfo.emoji} ${currentAgentInfo.name}` : 'Байхгүй';

  const agentButtons: DingTalkButton[] = availableAgents.map((agent) => {
    const label =
      currentAgent === agent.type ? `[Одоогийнх] ${agent.emoji} ${agent.name}` : `${agent.emoji} ${agent.name}`;
    return btn(label, 'agent.select', { agentType: agent.type });
  });

  return {
    title: 'Агент солих',
    text: [
      `### Агент солих`,
      '',
      `Харилцан ярианд ашиглах AI агентаа сонгоно уу:`,
      '',
      `Одоогийнх: **${currentAgentName}**`,
    ].join('\n'),
    btnOrientation: '0',
    btns: agentButtons,
  };
}

/**
 * Create session status card
 */
export function createSessionStatusCard(session?: {
  id: string;
  agentType: ChannelAgentType;
  createdAt: number;
  lastActivity: number;
}): DingTalkCard {
  if (!session) {
    return {
      title: 'Сешний төлөв',
      text: [
        '### Сешний төлөв',
        '',
        'Идэвхтэй сешн алга.',
        '',
        'Шинэ яриа эхлүүлэхийн тулд мессеж илгээх эсвэл "Шинэ чат" товчийг дарна уу.',
      ].join('\n'),
      btns: [btn('Шинэ сешн', 'session.new')],
    };
  }

  const duration = Math.floor((Date.now() - session.createdAt) / 1000 / 60);
  const lastActivity = Math.floor((Date.now() - session.lastActivity) / 1000);

  return {
    title: 'Сешний төлөв',
    text: [
      '### Сешний төлөв',
      '',
      `- **Агент:** ${session.agentType}`,
      `- **Үргэлжилсэн:** ${duration} мин`,
      `- **Сүүлийн үйлдэл:** ${lastActivity} сек өмнө`,
      `- **Сешний ID:** \`${session.id.slice(-8)}\``,
    ].join('\n'),
    btnOrientation: '1',
    btns: [btn('Шинэ сешн', 'session.new'), btn('Шинэчлэх', 'session.status')],
  };
}

/**
 * Create help card
 */
export function createHelpCard(): DingTalkCard {
  return {
    title: 'Дархай туслахын тусламж',
    text: [
      '### Дархай туслахын тусламж',
      '',
      'DingTalk-оор дамжуулан Дархайтай харилцах алсын туслах.',
      '',
      '**Түгээмэл үйлдлүүд:**',
      '- Шинэ чат - Шинэ сешн эхлүүлэх',
      '- Агент - AI агент солих',
      '- Төлөв - Одоогийн сешний төлөвийг харах',
      '- Тусламж - Энэ тусламжийг харуулах',
      '',
      'AI туслахтай чатлахын тулд мессеж илгээгээрэй.',
    ].join('\n'),
    btnOrientation: '0',
    btns: [
      btn('Боломжууд', 'help.features'),
      btn('Хослуулалтын заавар', 'help.pairing'),
      btn('Зөвлөмж', 'help.tips'),
    ],
  };
}

/**
 * Create features card
 */
export function createFeaturesCard(): DingTalkCard {
  return {
    title: 'Боломжууд',
    text: [
      '### Боломжууд',
      '',
      '**AI чат**',
      '- Энгийн хэлээр харилцах',
      '- Урсгал гаралт, бодит цагт харагдана',
      '- Контекст ой санамжийн дэмжлэг',
      '',
      '**Сешний удирдлага**',
      '- Нэг сешний горим',
      '- Контекстийг хүссэн үедээ цэвэрлэх',
      '- Сешний төлөвийг харах',
      '',
      '**Зурвасын үйлдлүүд**',
      '- Хариултын агуулгыг хуулах',
      '- Хариултыг дахин үүсгэх',
      '- Яриаг үргэлжлүүлэх',
    ].join('\n'),
    btns: [btn('Тусламж руу буцах', 'help.show')],
  };
}

/**
 * Create pairing guide card
 */
export function createPairingGuideCard(): DingTalkCard {
  return {
    title: 'Хослуулалтын заавар',
    text: [
      '### Хослуулалтын заавар',
      '',
      '**Анхны тохиргоо:**',
      '1. Ботод дурын мессеж илгээнэ үү',
      '2. Бот хослуулалтын код харуулна',
      '3. Дархайн тохиргоонд хослуулалтыг зөвшөөрнө үү',
      '4. Хослуулсны дараа ашиглахад бэлэн',
      '',
      '**Тэмдэглэл:**',
      '- Хослуулалтын код 10 минут хүчинтэй',
      '- Дархай апп ажиллаж байх ёстой',
      '- Нэг DingTalk бүртгэл зөвхөн нэг удаа хослуулна',
    ].join('\n'),
    btns: [btn('Тусламж руу буцах', 'help.show')],
  };
}

/**
 * Create tips card
 */
export function createTipsCard(): DingTalkCard {
  return {
    title: 'Зөвлөмж',
    text: [
      '### Зөвлөмж',
      '',
      '**Үр дүнтэй харилцахын тулд:**',
      '- Тодорхой, оновчтой бичээрэй',
      '- Нэмэлт асуулт чөлөөтэй асуугаарай',
      '- Сэтгэл ханамжгүй бол дахин үүсгээрэй',
      '',
      '**Шуурхай үйлдлүүд:**',
      '- Хурдан хандахын тулд картын товчнуудыг ашиглаарай',
      '- Үйлдэл хийхийн тулд зурвасын товчийг дараарай',
      '- Шинэ чат түүхийн контекстийг цэвэрлэнэ',
    ].join('\n'),
    btns: [btn('Тусламж руу буцах', 'help.show')],
  };
}

/**
 * Create response actions card
 * Buttons attached to AI response messages
 */
export function createResponseActionsCard(text: string): DingTalkCard {
  return {
    title: 'Хариулт',
    text: text + '\n\n---',
    btnOrientation: '1',
    btns: [btn('Хуулах', 'chat.copy'), btn('Дахин үүсгэх', 'chat.regenerate'), btn('Үргэлжлүүлэх', 'chat.continue')],
  };
}

/**
 * Create error recovery card
 */
export function createErrorRecoveryCard(errorMessage?: string): DingTalkCard {
  return {
    title: 'Алдаа',
    text: ['### Алдаа', '', errorMessage || 'Алдаа гарлаа. Дахин оролдоно уу.'].join('\n'),
    btnOrientation: '1',
    btns: [btn('Дахин оролдох', 'error.retry'), btn('Шинэ сешн', 'session.new')],
  };
}

/**
 * Create tool confirmation card
 */
export function createToolConfirmationCard(
  callId: string,
  title: string,
  description: string,
  options: Array<{ label: string; value: string }>
): DingTalkCard {
  const buttons: DingTalkButton[] = options.map((opt) =>
    btn(opt.label, 'system.confirm', { callId, value: opt.value })
  );

  return {
    title,
    text: description,
    btnOrientation: '0',
    btns: buttons,
  };
}

/**
 * Create settings card
 */
export function createSettingsCard(): DingTalkCard {
  return {
    title: 'Тохиргоо',
    text: [
      '### Тохиргоо',
      '',
      'Сувгийн тохиргоог Дархай апп дотор хийнэ.',
      '',
      'Дархай > WebUI > Сувгууд гэж нээнэ үү',
    ].join('\n'),
    btns: [btn('Буцах', 'help.show')],
  };
}

// ==================== Utilities ====================

/**
 * Create a simple text card without buttons
 */
export function createTextCard(text: string, title?: string): DingTalkCard {
  return {
    title: title || 'Зурвас',
    text,
  };
}
