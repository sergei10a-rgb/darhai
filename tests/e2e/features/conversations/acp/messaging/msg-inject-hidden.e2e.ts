import { test, expect } from '../../../../fixtures';
import {
  invokeBridge,
  goToGuid,
  selectAgent,
  sendMessageFromGuid,
  waitForSessionActive,
  waitForAiReply,
  takeScreenshot,
} from '../../../../helpers';
import {
  cleanupMockWorkspaces,
  createMockAgentConversation,
  readPersistedMessages,
  sendToMockAgent,
  waitForJsonRpc,
} from '../../../../helpers/mockAgentConversation';

const AI_MSG_SELECTOR = '.message-item.text.justify-start';

const createdIds: string[] = [];

test.afterAll(async ({ page }) => {
  for (const id of createdIds) {
    await invokeBridge(page, 'remove-conversation', { id }).catch(() => {});
  }
  createdIds.length = 0;
});

test.describe('F-MSG-03 AI rules auto-injected on first message', () => {
  let conversationId: string;

  test.beforeAll(async ({ page }) => {
    await goToGuid(page);
    await selectAgent(page, 'claude');
    conversationId = await sendMessageFromGuid(page, 'What capabilities do you have?');
    createdIds.push(conversationId);
    await waitForSessionActive(page, 120_000);
  });

  test('AI replies normally after first message is sent', async ({ page }) => {
    const replyText = await waitForAiReply(page, 120_000);
    expect(replyText.length).toBeGreaterThan(0);
  });

  test('injected content is not visible to the user (UI shows only the original user message)', async ({ page }) => {
    const userMessages = page.locator('.message-item.text.justify-end');
    const firstUserMsg = userMessages.first();
    await expect(firstUserMsg).toBeVisible({ timeout: 10_000 });

    const visibleText = await firstUserMsg.innerText();
    expect(visibleText).toContain('What capabilities do you have?');
    expect(visibleText.length).toBeLessThan(500);
  });

  test('DB stores the original message (injection is handled transparently at the transport layer)', async ({ page }) => {
    await page.waitForTimeout(2_000);

    const messages = await invokeBridge<{ content?: unknown; position?: string; type?: string }[]>(
      page,
      'database.get-conversation-messages',
      { conversation_id: conversationId }
    );

    const getTextContent = (m: { content?: unknown }): string => {
      if (!m.content) return '';
      if (typeof m.content === 'string') return m.content;
      if (typeof m.content === 'object' && m.content !== null && 'content' in m.content) {
        return String((m.content as Record<string, unknown>).content ?? '');
      }
      return JSON.stringify(m.content);
    };

    const userMsgs = messages.filter((m) => m.position === 'right' && m.type === 'text');
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);

    const firstMsgText = getTextContent(userMsgs[0]);
    expect(firstMsgText).toContain('What capabilities do you have?');
  });

  test('subsequent messages can be sent and receive replies normally', async ({ page }) => {
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill('Tell me a short joke.');
    await textarea.press('Enter');

    const replyText = await waitForAiReply(page, 120_000);
    expect(replyText.length).toBeGreaterThan(0);

    await takeScreenshot(page, 'msg-03-inject-second-msg');
  });

});

/**
 * What the agent ACTUALLY received.
 *
 * The two placeholders here ("requires pre-configured workspace", "requires
 * clearing rule config") both asked a question the UI cannot answer: injection
 * happens at the transport layer, below everything the DOM shows. The mock
 * agent records every JSON-RPC request it is handed, so these assert on the
 * wire instead of on the screen.
 */
test.describe('F-MSG-03 what the agent receives (mock agent)', () => {
  test.afterAll(() => {
    cleanupMockWorkspaces();
  });

  test('a custom workspace is handed to the agent as its session cwd', async ({ page }) => {
    test.setTimeout(240_000);

    const conversation = await createMockAgentConversation(page, { name: 'e2e workspace injection' });
    createdIds.push(conversation.id);

    const sendResult = await sendToMockAgent(page, conversation.id, 'E2E workspace probe');
    expect(sendResult.success, `send failed: ${sendResult.msg}`).toBe(true);

    const requests = await waitForJsonRpc(conversation.dumpPath, 'session/new', 60_000);
    const sessionNew = requests.find((r) => r.method === 'session/new');
    expect(sessionNew, `agent never received session/new: ${JSON.stringify(requests)}`).toBeTruthy();

    // The conversation was created with `customWorkspace: true` and a temp dir;
    // that dir is what the agent must be pointed at.
    const params = JSON.stringify(sessionNew?.params ?? {});
    const normalized = params.replace(/\\\\/g, '/');
    expect(normalized, `session/new did not carry the custom workspace: ${params}`).toContain(
      conversation.workspace.replace(/\\/g, '/')
    );
  });

  test('the user text reaches the agent intact, alongside whatever the app injects', async ({ page }) => {
    test.setTimeout(240_000);

    const marker = `E2E-INJECT-MARKER-${Date.now()}`;
    const conversation = await createMockAgentConversation(page, { name: 'e2e prompt passthrough' });
    createdIds.push(conversation.id);

    const sendResult = await sendToMockAgent(page, conversation.id, marker);
    expect(sendResult.success, `send failed: ${sendResult.msg}`).toBe(true);

    const requests = await waitForJsonRpc(conversation.dumpPath, 'session/prompt', 60_000);
    const prompt = requests.find((r) => r.method === 'session/prompt');
    expect(prompt, `agent never received session/prompt: ${JSON.stringify(requests)}`).toBeTruthy();

    const payload = JSON.stringify(prompt?.params ?? {});
    // (a) the user's own words survive injection verbatim
    expect(payload, `session/prompt lost the user text: ${payload}`).toContain(marker);
    // (b) injection is additive, never a replacement - the marker is not the
    //     whole payload, but nothing else may masquerade as the user's message.
    expect(payload.length).toBeGreaterThan(marker.length);

    // (c) the DB stores the ORIGINAL message, not the injected envelope
    const messages = await readPersistedMessages(page, conversation.id);
    const userMessages = messages.filter((m) => m.position === 'right');
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    const storedUserText = JSON.stringify(userMessages[0]?.content ?? '');
    expect(storedUserText).toContain(marker);
    expect(
      storedUserText.length,
      `the injected envelope leaked into stored history: ${storedUserText.slice(0, 400)}`
    ).toBeLessThan(1_000);
  });
});

test.describe('F-MSG-04 hidden messages and silent messages', () => {
  test('hidden messages exist in DB but are not shown in the UI', async ({ page }) => {
    await goToGuid(page);
    await selectAgent(page, 'claude');
    const conversationId = await sendMessageFromGuid(page, 'E2E hidden message test');
    createdIds.push(conversationId);
    await waitForSessionActive(page, 120_000);
    await waitForAiReply(page, 120_000);

    const messages = await invokeBridge<{ hidden?: boolean; position?: string; content?: string }[]>(
      page,
      'database.get-conversation-messages',
      { conversation_id: conversationId }
    );

    const visibleUserMsgs = page.locator('.message-item.text.justify-end');
    const visibleUserCount = await visibleUserMsgs.count();

    const dbUserMsgs = messages.filter((m) => m.position === 'right');

    const hiddenMsgs = messages.filter((m) => m.hidden === true);

    expect(messages.length).toBeGreaterThan(0);
    expect(dbUserMsgs.length).toBeGreaterThanOrEqual(visibleUserCount);

    if (hiddenMsgs.length > 0) {
      const visibleAiMsgs = page.locator(AI_MSG_SELECTOR);
      const visibleAiCount = await visibleAiMsgs.count();
      const dbAiMsgs = messages.filter((m) => m.position === 'left' && !m.hidden);
      expect(visibleAiCount).toBeLessThanOrEqual(dbAiMsgs.length + 1);
    }

    await takeScreenshot(page, 'msg-04-hidden-messages');
  });

  test.skip('silent messages are not recorded in message history (requires internal API trigger; IPC bridge does not support sending silent messages directly)', async () => {});
  test.skip('hidden messages triggered via scheduled task (requires task configuration; E2E wait cost is high)', async () => {});
});
