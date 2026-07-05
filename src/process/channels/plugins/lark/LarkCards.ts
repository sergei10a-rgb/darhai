/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChannelAgentType } from '../../types';

/**
 * Lark Message Cards for Personal Assistant
 *
 * Lark uses interactive message cards instead of keyboard buttons.
 * Cards support markdown content, buttons, and various interactive elements.
 *
 * Card Structure:
 * - config: Card configuration (wide_screen_mode, etc.)
 * - header: Optional card header with title
 * - elements: Array of content elements (markdown, buttons, dividers, etc.)
 */

// ==================== Types ====================

/**
 * Lark card structure
 */
export interface LarkCard {
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
  };
  header?: {
    title: {
      tag: 'plain_text';
      content: string;
    };
    template?:
      | 'blue'
      | 'wathet'
      | 'turquoise'
      | 'green'
      | 'yellow'
      | 'orange'
      | 'red'
      | 'carmine'
      | 'violet'
      | 'purple'
      | 'indigo'
      | 'grey';
  };
  elements: LarkCardElement[];
}

/**
 * Lark card element types
 */
export type LarkCardElement = LarkMarkdownElement | LarkDividerElement | LarkActionElement | LarkNoteElement;

export interface LarkMarkdownElement {
  tag: 'markdown';
  content: string;
}

export interface LarkDividerElement {
  tag: 'hr';
}

export interface LarkActionElement {
  tag: 'action';
  actions: LarkButtonElement[];
}

export interface LarkButtonElement {
  tag: 'button';
  text: {
    tag: 'plain_text';
    content: string;
  };
  type?: 'default' | 'primary' | 'danger';
  value: Record<string, string>;
}

export interface LarkNoteElement {
  tag: 'note';
  elements: Array<{
    tag: 'plain_text';
    content: string;
  }>;
}

// ==================== Card Builders ====================

/**
 * Agent info for card display
 */
export interface AgentDisplayInfo {
  type: ChannelAgentType;
  emoji: string;
  name: string;
}

/**
 * Create main menu card
 * Displayed after authorization or session actions
 */
export function createMainMenuCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Дархай туслах' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: 'Тавтай морил! Доорх үйлдлээс сонгоно уу:',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🆕 Шинэ чат' },
            type: 'primary',
            value: { action: 'session.new' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Агент' },
            type: 'default',
            value: { action: 'agent.show' },
          },
        ],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📊 Төлөв' },
            type: 'default',
            value: { action: 'session.status' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❓ Тусламж' },
            type: 'default',
            value: { action: 'help.show' },
          },
        ],
      },
    ],
  };
}

/**
 * Create pairing card
 * Shown during pairing process
 */
export function createPairingCard(pairingCode: string): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔗 Хослуулалт шаардлагатай' },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          'Бүртгэлээ Дархайтай хослуулна уу:',
          '',
          `**Хослуулалтын код:** \`${pairingCode}\``,
          '',
          '1. Дархайн тохиргоог нээнэ үү',
          '2. Сувгууд → Lark руу орно уу',
          '3. Энэ хослуулалтын кодыг оруулна уу',
          '',
          'Кодын хүчинтэй хугацаа 10 минут.',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Код шинэчлэх' },
            type: 'primary',
            value: { action: 'pairing.refresh' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❓ Тусламж' },
            type: 'default',
            value: { action: 'pairing.help' },
          },
        ],
      },
    ],
  };
}

/**
 * Create pairing status card
 * Shows waiting for approval status with code
 */
export function createPairingStatusCard(pairingCode: string): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⏳ Зөвшөөрөл хүлээж байна' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          'Таны хослуулалтын хүсэлт зөвшөөрөл хүлээж байна.',
          '',
          `**Хослуулалтын код:** \`${pairingCode}\``,
          '',
          'Дархайн тохиргоонд зөвшөөрнө үү:',
          '1. Дархай аппыг нээнэ үү',
          '2. WebUI → Сувгууд руу орно уу',
          '3. Энэ кодын ард "Зөвшөөрөх" дарна уу',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Төлөв шалгах' },
            type: 'primary',
            value: { action: 'pairing.check' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔁 Шинэ код' },
            type: 'default',
            value: { action: 'pairing.refresh' },
          },
        ],
      },
    ],
  };
}

/**
 * Create pairing help card
 * Shows detailed pairing instructions
 */
export function createPairingHelpCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '❓ Хослуулалтын тусламж' },
      template: 'turquoise',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Хослуулалт гэж юу вэ?**',
          'Хослуулалт нь таны Lark/Feishu бүртгэлийг локал Дархай апптай холбоно.',
          'AI туслахыг ашиглахын өмнө хослуулах шаардлагатай.',
          '',
          '**Хэрхэн хослуулах вэ:**',
          '1. Энэ ботод дурын мессеж илгээнэ үү',
          '2. Танд хослуулалтын код ирнэ',
          '3. Дархай десктоп аппыг нээнэ үү',
          '4. WebUI → Сувгууд → Lark руу орно уу',
          '5. Кодынхоо ард "Зөвшөөрөх" дарна уу',
          '',
          '**Түгээмэл асуулт:**',
          '• Хослуулалтын код 10 минут хүчинтэй',
          '• Дархай апп ажиллаж байх ёстой',
          '• Нэг бүртгэл зөвхөн нэг удаа хослуулна',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 Хослуулалтын код авах' },
            type: 'primary',
            value: { action: 'pairing.show' },
          },
        ],
      },
    ],
  };
}

/**
 * Create agent selection card
 * Shows available agents with current selection marked
 */
export function createAgentSelectionCard(
  availableAgents: AgentDisplayInfo[],
  currentAgent?: ChannelAgentType
): LarkCard {
  const agentButtons: LarkButtonElement[] = availableAgents.map((agent) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: currentAgent === agent.type ? `✓ ${agent.emoji} ${agent.name}` : `${agent.emoji} ${agent.name}`,
    },
    type: currentAgent === agent.type ? 'primary' : 'default',
    value: { action: 'agent.select', agentType: agent.type },
  }));

  // Split buttons into rows of 2
  const actionRows: LarkActionElement[] = [];
  for (let i = 0; i < agentButtons.length; i += 2) {
    actionRows.push({
      tag: 'action',
      actions: agentButtons.slice(i, i + 2),
    });
  }

  const currentAgentInfo = availableAgents.find((a) => a.type === currentAgent);
  const currentAgentName = currentAgentInfo ? `${currentAgentInfo.emoji} ${currentAgentInfo.name}` : 'Байхгүй';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔄 Агент солих' },
      template: 'indigo',
    },
    elements: [
      {
        tag: 'markdown',
        content: `Харилцан ярианд ашиглах AI агентаа сонгоно уу:\n\nОдоогийнх: **${currentAgentName}**`,
      },
      ...actionRows,
    ],
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
}): LarkCard {
  if (!session) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📊 Сешний төлөв' },
        template: 'grey',
      },
      elements: [
        {
          tag: 'markdown',
          content: 'Идэвхтэй сешн алга.\n\nШинэ яриа эхлүүлэхийн тулд мессеж илгээх эсвэл "Шинэ чат" товчийг дарна уу.',
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🆕 Шинэ сешн' },
              type: 'primary',
              value: { action: 'session.new' },
            },
          ],
        },
      ],
    };
  }

  const duration = Math.floor((Date.now() - session.createdAt) / 1000 / 60);
  const lastActivity = Math.floor((Date.now() - session.lastActivity) / 1000);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 Сешний төлөв' },
      template: 'green',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `🤖 **Агент:** ${session.agentType}`,
          `⏱ **Үргэлжилсэн:** ${duration} мин`,
          `📝 **Сүүлийн үйлдэл:** ${lastActivity} сек өмнө`,
          `🔖 **Сешний ID:** \`${session.id.slice(-8)}\``,
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🆕 Шинэ сешн' },
            type: 'default',
            value: { action: 'session.new' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📊 Шинэчлэх' },
            type: 'default',
            value: { action: 'session.status' },
          },
        ],
      },
    ],
  };
}

/**
 * Create help menu card
 */
export function createHelpCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '❓ Дархай туслахын тусламж' },
      template: 'turquoise',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          'Lark-аар дамжуулан Дархайтай харилцах алсын туслах.',
          '',
          '**Түгээмэл үйлдлүүд:**',
          '• 🆕 Шинэ чат - Шинэ сешн эхлүүлэх',
          '• 🔄 Агент - AI агент солих',
          '• 📊 Төлөв - Одоогийн сешний төлөвийг харах',
          '• ❓ Тусламж - Энэ тусламжийг харуулах',
          '',
          'AI туслахтай чатлахын тулд мессеж илгээгээрэй.',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🤖 Боломжууд' },
            type: 'default',
            value: { action: 'help.features' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 Хослуулалтын заавар' },
            type: 'default',
            value: { action: 'help.pairing' },
          },
        ],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💬 Зөвлөмж' },
            type: 'default',
            value: { action: 'help.tips' },
          },
        ],
      },
    ],
  };
}

/**
 * Create features card
 */
export function createFeaturesCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Боломжууд' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**AI чат**',
          '• Энгийн хэлээр харилцах',
          '• Урсгал гаралт, бодит цагт харагдана',
          '• Контекст ой санамжийн дэмжлэг',
          '',
          '**Сешний удирдлага**',
          '• Нэг сешний горим',
          '• Контекстийг хүссэн үедээ цэвэрлэх',
          '• Сешний төлөвийг харах',
          '',
          '**Зурвасын үйлдлүүд**',
          '• Хариултын агуулгыг хуулах',
          '• Хариултыг дахин үүсгэх',
          '• Яриаг үргэлжлүүлэх',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← Тусламж руу буцах' },
            type: 'default',
            value: { action: 'help.show' },
          },
        ],
      },
    ],
  };
}

/**
 * Create pairing guide card
 */
export function createPairingGuideCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔗 Хослуулалтын заавар' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Анхны тохиргоо:**',
          '1. Ботод дурын мессеж илгээнэ үү',
          '2. Бот хослуулалтын код харуулна',
          '3. Дархайн тохиргоонд хослуулалтыг зөвшөөрнө үү',
          '4. Хослуулсны дараа ашиглахад бэлэн',
          '',
          '**Тэмдэглэл:**',
          '• Хослуулалтын код 10 минут хүчинтэй',
          '• Дархай апп ажиллаж байх ёстой',
          '• Нэг Lark бүртгэл зөвхөн нэг удаа хослуулна',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← Тусламж руу буцах' },
            type: 'default',
            value: { action: 'help.show' },
          },
        ],
      },
    ],
  };
}

/**
 * Create tips card
 */
export function createTipsCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💬 Зөвлөмж' },
      template: 'purple',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Үр дүнтэй харилцахын тулд:**',
          '• Тодорхой, оновчтой бичээрэй',
          '• Нэмэлт асуулт чөлөөтэй асуугаарай',
          '• Сэтгэл ханамжгүй бол дахин үүсгээрэй',
          '',
          '**Шуурхай үйлдлүүд:**',
          '• Хурдан хандахын тулд картын товчнуудыг ашиглаарай',
          '• Үйлдэл хийхийн тулд зурвасын товчийг дараарай',
          '• Шинэ чат түүхийн контекстийг цэвэрлэнэ',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← Тусламж руу буцах' },
            type: 'default',
            value: { action: 'help.show' },
          },
        ],
      },
    ],
  };
}

/**
 * Create response actions card
 * Buttons attached to AI response messages
 */
export function createResponseActionsCard(text: string): LarkCard {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📋 Хуулах' },
            type: 'default',
            value: { action: 'chat.copy' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Дахин үүсгэх' },
            type: 'default',
            value: { action: 'chat.regenerate' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💬 Үргэлжлүүлэх' },
            type: 'default',
            value: { action: 'chat.continue' },
          },
        ],
      },
    ],
  };
}

/**
 * Create error recovery card
 */
export function createErrorRecoveryCard(errorMessage?: string): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ Алдаа' },
      template: 'red',
    },
    elements: [
      {
        tag: 'markdown',
        content: errorMessage || 'Алдаа гарлаа. Дахин оролдоно уу.',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Дахин оролдох' },
            type: 'primary',
            value: { action: 'error.retry' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🆕 Шинэ сешн' },
            type: 'default',
            value: { action: 'session.new' },
          },
        ],
      },
    ],
  };
}

/**
 * Create tool confirmation card
 * @param callId - The tool call ID for tracking
 * @param options - Array of { label, value } options
 */
export function createToolConfirmationCard(
  callId: string,
  title: string,
  description: string,
  options: Array<{ label: string; value: string }>
): LarkCard {
  const buttons: LarkButtonElement[] = options.map((opt) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: opt.label },
    type: 'default',
    value: { action: 'system.confirm', callId: callId, value: opt.value },
  }));

  // Split buttons into rows of 2
  const actionRows: LarkActionElement[] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    actionRows.push({
      tag: 'action',
      actions: buttons.slice(i, i + 2),
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'markdown',
        content: description,
      },
      ...actionRows,
    ],
  };
}

/**
 * Create confirmation card (generic)
 */
export function createConfirmationCard(message: string, confirmAction: string, cancelAction: string): LarkCard {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'markdown',
        content: message,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ Зөвшөөрөх' },
            type: 'primary',
            value: { action: confirmAction },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ Цуцлах' },
            type: 'danger',
            value: { action: cancelAction },
          },
        ],
      },
    ],
  };
}

/**
 * Create settings card
 */
export function createSettingsCard(): LarkCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚙️ Тохиргоо' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          'Сувгийн тохиргоог Дархай апп дотор хийнэ.',
          '',
          'Дархай → WebUI → Сувгууд гэж нээнэ үү',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '← Буцах' },
            type: 'default',
            value: { action: 'help.show' },
          },
        ],
      },
    ],
  };
}

// ==================== Utilities ====================

/**
 * Create a simple text card without buttons
 */
export function createTextCard(text: string, title?: string, template?: LarkCard['header']['template']): LarkCard {
  const card: LarkCard = {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
    ],
  };

  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title },
      template: template || 'blue',
    };
  }

  return card;
}

/**
 * Extract action info from card button value
 */
export function parseCardButtonValue(value: Record<string, string>): {
  action: string;
  params: Record<string, string>;
} | null {
  const action = value.action;
  if (!action) return null;

  const params: Record<string, string> = {};
  Object.entries(value).forEach(([key, val]) => {
    if (key !== 'action') {
      params[key] = val;
    }
  });

  return { action, params };
}
