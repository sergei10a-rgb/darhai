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
  assistantText,
  cleanupMockWorkspaces,
  createMockAgentConversation,
  readJsonRpcDump,
  readPersistedMessages,
  sendToMockAgent,
  waitForMessages,
} from '../../../../helpers/mockAgentConversation';

const USER_MSG_SELECTOR = '.message-item.text.justify-end';
const AI_MSG_SELECTOR = '.message-item.text.justify-start';

const createdIds: string[] = [];

test.afterAll(async ({ page }) => {
  for (const id of createdIds) {
    await invokeBridge(page, 'remove-conversation', { id }).catch(() => {});
  }
  createdIds.length = 0;
});

test.describe('F-MSG-01 Send text message', () => {
  let conversationId: string;

  test.beforeAll(async ({ page }) => {
    await goToGuid(page);
    await selectAgent(page, 'claude');
    conversationId = await sendMessageFromGuid(page, 'E2E msg-send test: Hello AI');
    createdIds.push(conversationId);
    await waitForSessionActive(page, 120_000);
  });

  test('User message appears immediately in the conversation area after sending', async ({ page }) => {
    const userMessages = page.locator(USER_MSG_SELECTOR);
    await expect(userMessages.first()).toBeVisible({ timeout: 10_000 });
    const count = await userMessages.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('AI streaming reply received after sending', async ({ page }) => {
    const replyText = await waitForAiReply(page, 120_000);
    expect(replyText.length).toBeGreaterThan(0);
    await takeScreenshot(page, 'msg-01-ai-reply');
  });

  test('Conversation appears in the sidebar list after sending', async ({ page }) => {
    const row = page.locator(`#c-${conversationId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
  });

  test('Empty message is not sent', async ({ page }) => {
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });

    const msgCountBefore = await page.locator(USER_MSG_SELECTOR).count();

    await textarea.fill('');
    await textarea.press('Enter');
    await page.waitForTimeout(1_000);

    const msgCountAfter = await page.locator(USER_MSG_SELECTOR).count();
    expect(msgCountAfter).toBe(msgCountBefore);
  });

  test('Input box is enabled and accepts follow-up messages after AI reply completes', async ({ page }) => {
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    expect(await textarea.isDisabled()).toBe(false);

    await textarea.fill('Follow-up message for F-MSG-01');
    await textarea.press('Enter');

    const replyText = await waitForAiReply(page, 120_000);
    expect(replyText.length).toBeGreaterThan(0);
  });

  test('Verify via bridge that messages are persisted to the database', async ({ page }) => {
    await page.waitForTimeout(2_000);

    const messages = await invokeBridge<{ content?: unknown; position?: string; type?: string }[]>(
      page,
      'database.get-conversation-messages',
      { conversation_id: conversationId }
    );
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const userMsgs = messages.filter((m) => m.position === 'right');
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);

    await takeScreenshot(page, 'msg-01-db-verified');
  });

  test.skip('Multiple queued messages merged and sent (partially implemented, to be completed when full feature ships)', async () => {});
});

/**
 * The failure and boundary half of F-MSG-01, driven against a mock ACP agent.
 *
 * These were empty `test.skip`s reading "E2E cannot reliably simulate backend
 * connection failure" and "defensive boundary". Both are now reachable: the
 * mock agent binary can be made to die on startup, and a conversation id that
 * was never created needs no agent at all. Neither needs a signed-in CLI, so
 * this block runs even when the agent picker has no usable backend.
 */
test.describe('F-MSG-01 Send text message - failure paths', () => {
  test.afterAll(() => {
    cleanupMockWorkspaces();
  });

  test('Sending to a conversation that does not exist is rejected, not silently accepted', async ({ page }) => {
    const missingId = `no-such-conversation-${Date.now()}`;

    const result = await sendToMockAgent(page, missingId, 'E2E send into the void', 30_000);

    expect(result.success, `send into a missing conversation was accepted: ${JSON.stringify(result)}`).toBe(false);
    expect(result.msg ?? '', `rejection carried no reason: ${JSON.stringify(result)}`).not.toBe('');

    // And nothing may have been conjured into existence for that id.
    const messages = await readPersistedMessages(page, missingId).catch((): unknown[] => []);
    expect(messages.length, `a missing conversation gained messages: ${JSON.stringify(messages)}`).toBe(0);
  });

  test('A backend that dies on startup never produces a fabricated assistant reply', async ({ page }) => {
    test.setTimeout(180_000);

    const conversation = await createMockAgentConversation(page, {
      name: 'e2e failing backend',
      failOnStartup: { code: 1, stderr: 'mock agent: not authenticated' },
    });
    createdIds.push(conversation.id);

    const sendResult = await sendToMockAgent(page, conversation.id, 'E2E connection failure probe', 120_000);

    // Give the failure every chance to land before reading.
    const messages = await waitForMessages(
      page,
      conversation.id,
      (msgs) => msgs.some((m) => m.position !== 'right'),
      30_000
    );

    // The agent never started, so no assistant text can legitimately exist.
    // A reply here would mean the app invented one - the exact "reports success
    // while nothing happened" failure the audit found on the happy path.
    const reply = assistantText(messages);
    expect(reply, `assistant text appeared although the backend never started: ${reply}`).not.toContain('mock reply');

    // The user must be told. Either the send itself reports the failure, or the
    // conversation carries an error/notice row - a silent no-op is the defect.
    const surfaced = sendResult.success === false || messages.some((m) => m.position !== 'right');
    expect(
      surfaced,
      `backend failure was silent: send=${JSON.stringify(sendResult)} messages=${JSON.stringify(messages)}`
    ).toBe(true);

    // The agent binary really did exit before the handshake.
    const requests = readJsonRpcDump(conversation.dumpPath);
    expect(
      requests.map((r) => r.method),
      `a dead agent answered JSON-RPC: ${JSON.stringify(requests)}`
    ).not.toContain('session/prompt');
  });
});
