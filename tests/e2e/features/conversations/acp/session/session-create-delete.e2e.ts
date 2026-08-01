import { test, expect } from '../../../../fixtures';
import {
  invokeBridge,
  goToGuid,
  selectAgent,
  sendMessageFromGuid,
  deleteConversation,
  goToNewChat,
  waitForSessionActive,
  takeScreenshot,
  AGENT_PILL,
  agentPillByBackend,
} from '../../../../helpers';
import {
  assistantText,
  cleanupMockWorkspaces,
  createMockAgentConversation,
  readPersistedMessages,
  sendToMockAgent,
  waitForJsonRpc,
  waitForMessages,
} from '../../../../helpers/mockAgentConversation';

const BACKENDS = ['claude', 'codex'] as const;
const createdIds: string[] = [];

test.afterAll(async ({ page }) => {
  for (const id of createdIds) {
    await invokeBridge(page, 'remove-conversation', { id }).catch(() => {});
  }
  createdIds.length = 0;
});

test.describe('F-SESSION-01 Create new session', () => {
  test('guid page shows available agent pill', async ({ page }) => {
    await goToGuid(page);
    await expect(page.locator(AGENT_PILL).first()).toBeVisible({ timeout: 15_000 });
  });

  for (const backend of BACKENDS) {
    test(`select ${backend} backend and create session`, async ({ page }) => {
      if (backend === 'codex') test.setTimeout(240_000);

      await goToGuid(page);
      await selectAgent(page, backend);

      const selectedPill = page.locator(`${agentPillByBackend(backend)}[data-agent-selected="true"]`);
      await expect(selectedPill).toBeVisible({ timeout: 5_000 });

      const conversationId = await sendMessageFromGuid(page, `E2E session create test - ${backend}`);
      createdIds.push(conversationId);

      expect(conversationId).toBeTruthy();
      expect(conversationId.length).toBeGreaterThan(0);

      await expect(page.locator(`#c-${conversationId}`)).toBeVisible({ timeout: 15_000 });

      const timeout = backend === 'codex' ? 180_000 : 120_000;
      await waitForSessionActive(page, timeout);
    });
  }

  test('sidebar screenshot after successful creation', async ({ page }) => {
    await takeScreenshot(page, 'session-01-sidebar-after-create');
  });

  test.skip('create session via tray menu (E2E cannot interact with system-level tray menu)', async () => {});

  test('verify session data exists via bridge', async ({ page }) => {
    for (const id of createdIds) {
      const conv = await invokeBridge<{ id: string; type: string }>(page, 'get-conversation', { id });
      expect(conv).toBeTruthy();
      expect(conv.id).toBe(id);
    }
  });
});

test.describe('F-SESSION-07 Delete session', () => {
  let deleteTargetId: string;

  test.beforeAll(async ({ page }) => {
    await goToNewChat(page);
    await selectAgent(page, 'claude');
    deleteTargetId = await sendMessageFromGuid(page, 'E2E session delete test');
    createdIds.push(deleteTargetId);
    await waitForSessionActive(page, 120_000);
  });

  test('delete session via bridge and verify it disappears', async ({ page }) => {
    const row = page.locator(`#c-${deleteTargetId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const msgsBefore = await invokeBridge<unknown[]>(page, 'database.get-conversation-messages', {
      conversation_id: deleteTargetId,
    }).catch(() => []);
    expect(msgsBefore.length).toBeGreaterThan(0);

    await invokeBridge(page, 'remove-conversation', { id: deleteTargetId });
    await page.waitForTimeout(3_000);

    await expect(row).not.toBeVisible({ timeout: 10_000 });

    const idx = createdIds.indexOf(deleteTargetId);
    if (idx !== -1) createdIds.splice(idx, 1);
  });

  test('message history is also cleared after deletion', async ({ page }) => {
    const msgsAfter = await invokeBridge<unknown[]>(page, 'database.get-conversation-messages', {
      conversation_id: deleteTargetId,
    }).catch(() => []);
    expect(msgsAfter.length).toBe(0);
  });

  test('bridge query returns empty after deletion', async ({ page }) => {
    const conv = await invokeBridge<Record<string, unknown> | null>(page, 'get-conversation', {
      id: deleteTargetId,
    }).catch(() => null);
    const isGone = !conv || !conv.id;
    expect(isGone).toBe(true);
  });

  test.skip('delete via tray menu (E2E cannot interact with system-level tray menu)', async () => {});
});

/**
 * Session lifecycle against a mock ACP agent - no signed-in CLI required.
 *
 * The create/delete boundary cases above were empty `test.skip`s marked "not
 * covered by E2E". They are covered now: `create-conversation` validates the
 * conversation type in the main process, `remove-conversation` has to tolerate
 * an id that was never stored, and a full create -> delete cycle can be driven
 * end-to-end through a mock agent binary.
 */
test.describe('F-SESSION-01/07 lifecycle boundaries (mock agent)', () => {
  test.afterAll(() => {
    cleanupMockWorkspaces();
  });

  test('creating a session with an invalid conversation type is rejected', async ({ page }) => {
    const created = await invokeBridge<{ id?: string } | { success?: boolean; msg?: string }>(
      page,
      'create-conversation',
      {
        type: 'definitely-not-a-backend',
        name: 'e2e invalid type',
        model: { id: 'mock', name: 'mock', platform: 'custom', useModel: 'mock' },
        extra: { backend: 'custom' },
      },
      30_000
    ).catch((err: unknown) => ({ success: false, msg: String(err) }));

    const id = (created as { id?: string })?.id;
    if (id) createdIds.push(id);
    expect(id, `an unknown conversation type was accepted and stored as ${id}`).toBeFalsy();
  });

  test('deleting an id that was never created is a no-op, not a crash', async ({ page }) => {
    const ghostId = `no-such-conversation-${Date.now()}`;

    // Must not reject...
    await invokeBridge(page, 'remove-conversation', { id: ghostId }, 30_000).catch((err: unknown) => {
      throw new Error(`remove-conversation threw on an unknown id: ${String(err)}`);
    });
    // ...and must not take the main process down with it. A real create/read
    // round-trip afterwards is the liveness proof: it exercises the same bridge
    // and the same database the delete just touched.
    const survivor = await createMockAgentConversation(page, { name: 'e2e post-ghost-delete liveness' });
    createdIds.push(survivor.id);

    const stored = await invokeBridge<{ id?: string }>(page, 'get-conversation', { id: survivor.id }, 30_000);
    expect(stored?.id, 'the bridge stopped answering after deleting an unknown id').toBe(survivor.id);
  });

  test('a mock-agent session survives a full create -> converse -> delete cycle', async ({ page }) => {
    test.setTimeout(240_000);

    const conversation = await createMockAgentConversation(page, {
      name: 'e2e mock lifecycle',
      responses: [{ type: 'text', chunks: ['lifecycle', ' ok'] }],
    });

    // (a) created and readable
    const stored = await invokeBridge<{ id?: string }>(page, 'get-conversation', { id: conversation.id }, 30_000);
    expect(stored?.id, `created conversation not readable back: ${JSON.stringify(stored)}`).toBe(conversation.id);

    // (b) a turn really reaches the agent and comes back persisted
    const sendResult = await sendToMockAgent(page, conversation.id, 'E2E lifecycle probe');
    expect(sendResult.success, `send failed: ${sendResult.msg}`).toBe(true);

    const messages = await waitForMessages(page, conversation.id, (msgs) =>
      assistantText(msgs).includes('lifecycle ok')
    );
    expect(assistantText(messages), `agent reply never persisted: ${JSON.stringify(messages)}`).toContain(
      'lifecycle ok'
    );

    const requests = await waitForJsonRpc(conversation.dumpPath, 'session/prompt', 30_000);
    expect(requests.map((r) => r.method)).toContain('initialize');
    expect(requests.map((r) => r.method)).toContain('session/new');

    // (c) delete removes the conversation AND its messages
    await invokeBridge(page, 'remove-conversation', { id: conversation.id }, 30_000);

    const afterMessages = await readPersistedMessages(page, conversation.id).catch(() => []);
    expect(afterMessages.length, `messages survived deletion: ${JSON.stringify(afterMessages)}`).toBe(0);

    const afterConversation = await invokeBridge<{ id?: string } | null>(
      page,
      'get-conversation',
      { id: conversation.id },
      30_000
    ).catch(() => null);
    expect(!afterConversation || !afterConversation.id, 'conversation still readable after deletion').toBe(true);
  });
});
