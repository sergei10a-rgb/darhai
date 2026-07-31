/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The desktop runtime must have a real user identity, and the three surfaces
 * keyed on it must actually list and actually write.
 *
 * The defect this guards: `AuthContext` treated the desktop runtime as
 * "authenticated with no user", so `user?.id ?? ''` was empty in
 * `useCalendar` / `useNotes` / `useDocuments`. An empty id makes the SWR key
 * `null` (the list request is never issued) and short-circuits every create
 * callback before it reaches the bridge. Nothing throws, nothing is logged, no
 * toast appears - the page renders perfectly, the composer closes as if it
 * saved, and the row never exists. Three whole features were dead in the
 * shipped app while every bridge-level test passed.
 *
 * That is why this spec refuses to call the bridge to *perform* the action:
 * driving providers directly is exactly what let the bug ship. Every write here
 * goes through a real click on a real button. The bridge is used only as an
 * independent oracle afterwards - "is the row actually in the database" - and
 * the final test relaunches the app against the same profile to prove the row
 * survived the process, not just the render.
 */
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchVisualApp, closeVisualApp, quitVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

/** Distinct per run so a leftover profile can never make an assertion pass. */
const RUN_TAG = `LU${Date.now().toString(36).toUpperCase()}`;
const CALENDAR_TITLE = `${RUN_TAG} ХУРАЛ`;
const NOTE_TITLE = `${RUN_TAG} ТЭМДЭГЛЭЛ`;
const DOCUMENT_TITLE = `${RUN_TAG} БАРИМТ`;

/** Autosave debounce in DocumentsPage is 800ms; allow the write to land after it. */
const AUTOSAVE_SETTLE_MS = 2_500;

/** Wire key of the `agent.config` storage namespace setter (@office-ai/platform). */
const CONFIG_SET_KEY = 'agent.config.storage.set';

type LocalUserIdentity = { id: string; username: string };

let visual: VisualApp;
let identity: LocalUserIdentity;

/**
 * Complete first-run onboarding before the overlay can open.
 *
 * The overlay is an Arco `Modal` with `closable`, `maskClosable` and
 * `escToExit` all false, and its mask swallows pointer events across the whole
 * window - the audit hit exactly this and could not click anything. Other specs
 * CSS-hide `.arco-modal-*`, but this one has to click *inside* two Arco modals
 * (the event and note composers), so hiding that layer would break the very
 * thing under test. Instead we set the same flag the overlay reads
 * (`ConfigStorage.get('onboardingCompleted')`, OnboardingOverlay.tsx:34) and
 * reload, so onboarding is genuinely finished rather than merely invisible.
 */
async function completeOnboarding(page: Page): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await invokeBridge(page, CONFIG_SET_KEY, { key: 'onboardingCompleted', data: true }, 30_000);

    // Electron rejects a reload that races the renderer's own in-flight
    // navigation, which is a scheduling accident rather than a real failure -
    // the checks below are the actual gate, so the rejection is swallowed here
    // exactly as onboarding.visual.ts does.
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page
      .waitForFunction(() => typeof (window as { electronAPI?: unknown }).electronAPI !== 'undefined', null, {
        timeout: 90_000,
      })
      .catch(() => {});
    await waitForSettle(page);

    if ((await page.locator('.arco-modal-mask').count()) === 0) return;
  }
  throw new Error('first-run onboarding overlay was still up after two dismissal attempts');
}

/** Navigate the hash router and wait for the new screen to stop moving. */
async function gotoHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((target: string) => {
    window.location.hash = target;
  }, hash);
  await waitForSettle(page);
}

/** Titles the calendar bridge reports around now, for the resolved identity. */
async function listCalendarTitles(page: Page): Promise<string[]> {
  const now = Date.now();
  const occurrences = await invokeBridge<Array<{ title?: string }>>(page, 'calendar.list', {
    userId: identity.id,
    startMs: now - 30 * 86_400_000,
    endMs: now + 30 * 86_400_000,
  });
  return occurrences.map((o) => o.title ?? '');
}

async function listNoteTitles(page: Page): Promise<string[]> {
  const notes = await invokeBridge<Array<{ title?: string }>>(page, 'note.list', {
    userId: identity.id,
    includeArchived: true,
  });
  return notes.map((n) => n.title ?? '');
}

async function listDocumentTitles(page: Page): Promise<string[]> {
  const documents = await invokeBridge<Array<{ title?: string }>>(page, 'documents.list', {
    userId: identity.id,
  });
  return documents.map((d) => d.title ?? '');
}

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await completeOnboarding(visual.page);
  identity = await invokeBridge<LocalUserIdentity>(visual.page, 'local-user.get');
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test.describe('Desktop identity: the per-user surfaces list and write', () => {
  test('the main process resolves a real local user backed by a users row', async () => {
    expect(identity?.id, 'local-user.get returned no id').toBeTruthy();
    expect(typeof identity.username).toBe('string');

    // The premise the whole cluster rests on: rows keyed on this id must satisfy
    // the users(id) foreign key. A bad id fails the FK inside the store, which
    // the bridge would report back as an error rather than a created row.
    const probe = await invokeBridge<{ id?: string; userId?: string }>(visual.page, 'note.create', {
      userId: identity.id,
      title: `${RUN_TAG} FK-PROBE`,
    });
    expect(probe?.id, `note.create under ${identity.id} did not return a row: ${JSON.stringify(probe)}`).toBeTruthy();
    expect(probe.userId).toBe(identity.id);
  });

  test('first-run onboarding is out of the way, so the pages are clickable', async () => {
    // Guard the premise. If the overlay were still up, every click below would
    // fail with an opaque timeout instead of a readable message.
    const blockingModals = await visual.page.locator('.arco-modal-mask').count();
    expect(blockingModals, 'the first-run overlay is still capturing clicks').toBe(0);
  });

  test('#/calendar: clicking through the composer creates an event that is listed', async () => {
    const { page } = visual;
    await gotoHash(page, '#/calendar');

    const before = await listCalendarTitles(page);
    expect(before).not.toContain(CALENDAR_TITLE);

    await page.getByTestId('calendar-new').click();
    await page.getByTestId('event-composer-title').fill(CALENDAR_TITLE);
    await page.getByTestId('event-composer-save').click();

    // The composer closing is NOT proof of a save - it closed unconditionally
    // before the fix too. Wait for the row itself.
    await expect.poll(async () => listCalendarTitles(page), { timeout: 15_000 }).toContain(CALENDAR_TITLE);

    await waitForSettle(page);
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown, 'the saved event is in the database but the page does not show it').toContain(CALENDAR_TITLE);
  });

  test('#/notes: clicking through the composer creates a note that is listed', async () => {
    const { page } = visual;
    await gotoHash(page, '#/notes');

    const before = await listNoteTitles(page);
    expect(before).not.toContain(NOTE_TITLE);

    await page.getByTestId('notes-new').click();
    await page.getByTestId('note-composer-title').fill(NOTE_TITLE);
    await page.getByTestId('note-composer-save').click();

    await expect.poll(async () => listNoteTitles(page), { timeout: 15_000 }).toContain(NOTE_TITLE);

    await waitForSettle(page);
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown, 'the saved note is in the database but the page does not show it').toContain(NOTE_TITLE);
  });

  test('#/documents: clicking new creates a document that is listed', async () => {
    const { page } = visual;
    await gotoHash(page, '#/documents');

    const before = await listDocumentTitles(page);
    expect(before).not.toContain(DOCUMENT_TITLE);

    // DocumentsPage has no composer: the button creates the row directly and
    // opens it, then the title is autosaved from the editor pane.
    await page.getByTestId('documents-new').click();
    await expect
      .poll(async () => (await listDocumentTitles(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(before.length);

    await page.getByTestId('documents-title-input').fill(DOCUMENT_TITLE);
    await page.waitForTimeout(AUTOSAVE_SETTLE_MS);

    await expect.poll(async () => listDocumentTitles(page), { timeout: 15_000 }).toContain(DOCUMENT_TITLE);

    await waitForSettle(page);
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown, 'the saved document is in the database but the page does not show it').toContain(DOCUMENT_TITLE);
  });

  test('everything created through the UI survives an app restart', async () => {
    const runRoot = visual.runRoot;
    await quitVisualApp(visual);

    // Same profile, new process: proves the writes reached SQLite and that the
    // identity is stable across restarts rather than minted per launch.
    visual = await launchVisualApp({}, { reuseRunRoot: runRoot });
    const { page } = visual;
    await waitForSettle(page);

    const reopened = await invokeBridge<LocalUserIdentity>(page, 'local-user.get');
    expect(reopened.id, 'the local user id changed across a restart').toBe(identity.id);

    expect(await listCalendarTitles(page)).toContain(CALENDAR_TITLE);
    expect(await listNoteTitles(page)).toContain(NOTE_TITLE);
    expect(await listDocumentTitles(page)).toContain(DOCUMENT_TITLE);

    // And the pages still render them for the restarted renderer.
    await gotoHash(page, '#/notes');
    expect(await page.evaluate(() => document.body.innerText)).toContain(NOTE_TITLE);
  });
});
