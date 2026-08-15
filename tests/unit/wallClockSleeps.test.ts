/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guard against reintroducing wall-clock sleeps into the test suite.
 *
 * `await new Promise((r) => setTimeout(r, 80))` is a bet that a fire-and-forget
 * pipeline finishes inside 80 ms of WALL CLOCK. A full `vitest run` puts 24
 * forks on 24 cores, so a fork can sit unscheduled for hundreds of
 * milliseconds: the timer still expires on time, the pipeline behind it has not
 * advanced, and the test asserts against a half-finished state. Measured on
 * this repo, that is why `tests/unit/channels/weixinLogin.test.ts` and
 * `weixinMonitor.test.ts` failed in 19 of 20 loaded runs and passed all 20 idle
 * ones - the suite needed two attempts to go green.
 *
 * `tests/helpers/eventLoop.ts` fixes that by counting event-loop turns instead
 * of milliseconds, and the two suites above were converted. But a helper only
 * helps the files that import it, and 40 other files still hold 93 of these
 * sleeps. Nothing stopped the next one from being written, so the rule is
 * checked mechanically here rather than remembered - the same shape as
 * `tests/unit/vitestIoLane.test.ts`.
 *
 * The list below is a RATCHET, not a permanent exemption: it may shrink, never
 * grow. New file with a sleep -> red. Sleep removed from a listed file -> also
 * red, until the entry is deleted, so the debt cannot quietly stay on the books
 * after it has been paid.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_ROOTS = ['tests/unit', 'tests/integration', 'tests/regression'];
const SELF = 'tests/unit/wallClockSleeps.test.ts';

/**
 * `new Promise(... setTimeout(..., <nonzero>))` - a promise whose only job is
 * to wait out a delay.
 *
 * A ZERO delay is deliberately not matched: `setTimeout(resolve, 0)` yields one
 * event-loop turn rather than betting on the clock, which is exactly what
 * `eventLoop.ts` itself is built from. `[^;]` keeps the match inside a single
 * statement so an unrelated `setTimeout` further down the file cannot be
 * stitched onto an earlier `new Promise`.
 */
const WALL_CLOCK_SLEEP = /new Promise\b[^;]{0,200}?setTimeout\([^;]{0,120}?,\s*(\d+)\s*\)/g;

/**
 * Files that still wait on wall clock, measured 2026-08-15: 40 files, 93
 * occurrences. Shrink this list by converting a file to `settleUntil` /
 * `settleTurns`; do not add to it.
 */
const KNOWN_WALL_CLOCK_SLEEPERS = [
  'tests/integration/team-real-components.test.ts',
  'tests/integration/team-stress-concurrency.test.ts',
  'tests/unit/BaseAgentManagerDecouple.test.ts',
  'tests/unit/ConversationSearchPopover.dom.test.tsx',
  'tests/unit/EditModeModal.dom.test.tsx',
  'tests/unit/OfficeDocViewer.dom.test.tsx',
  'tests/unit/OpenClawAgentManagerBootstrap.test.ts',
  'tests/unit/PptViewer.dom.test.tsx',
  'tests/unit/RemoteAgentCore.test.ts',
  'tests/unit/RemoteAgentManager.test.ts',
  'tests/unit/RemoteSendBox.dom.test.tsx',
  'tests/unit/WCoreManagerCron.test.ts',
  'tests/unit/acpConnectionStartupExit.test.ts',
  'tests/unit/acpKillChild.test.ts',
  'tests/unit/channels/telegramPlugin.test.ts',
  'tests/unit/channels/weixinPlugin.test.ts',
  'tests/unit/chat/exportHelpers.test.ts',
  'tests/unit/cookbook/LocalServeManager.test.ts',
  'tests/unit/extensions/sandboxHost.test.ts',
  'tests/unit/geminiBootstrapRejection.test.ts',
  'tests/unit/officeWatchBridge.test.ts',
  'tests/unit/omnirouteGateway/OmnirouteRuntimeManager.test.ts',
  'tests/unit/omnirouteGateway/killProcessTree.test.ts',
  'tests/unit/pptPreviewBridge.test.ts',
  'tests/unit/process/channels/plugins/tier1/signal/SignalDaemon.restart.test.ts',
  'tests/unit/process/channels/plugins/tier2/imessage/ImessagePlugin.poll.test.ts',
  'tests/unit/process/channels/plugins/tier3/nextcloud-talk/NextcloudTalkPlugin.send.test.ts',
  'tests/unit/process/channels/plugins/tier3/nostr/NostrPlugin.security.test.ts',
  'tests/unit/process/channels/plugins/tier3/nostr/NostrPlugin.send.test.ts',
  'tests/unit/process/channels/webhook/connection-tokens.test.ts',
  'tests/unit/process/services/ijfwSystemService.bootstrap.test.ts',
  'tests/unit/process/services/import/dropFolderWatcher.test.ts',
  'tests/unit/process/team/Watchdog.test.ts',
  'tests/unit/renderer/pages/memory/EmptyStateHero.dom.test.tsx',
  'tests/unit/renderer/pages/memory/FullPanelShell.dom.test.tsx',
  'tests/unit/renderer/teams/TeamLauncherPage.dom.test.tsx',
  'tests/unit/renderer/usePendingSendOnWake.dom.test.tsx',
  'tests/unit/tray.test.ts',
  'tests/unit/useFileChanges.dom.test.ts',
  'tests/unit/useGuidSend.dom.test.ts',
];

function listTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(test|e2e)\.tsx?$/.test(entry.name) || /^test_.*\.ts$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const root of SEARCH_ROOTS) walk(path.join(REPO_ROOT, root));
  return found.toSorted();
}

function sleepsOnWallClock(relativePath: string): boolean {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  WALL_CLOCK_SLEEP.lastIndex = 0;
  let match = WALL_CLOCK_SLEEP.exec(source);
  while (match !== null) {
    if (Number(match[1]) > 0) return true;
    match = WALL_CLOCK_SLEEP.exec(source);
  }
  return false;
}

describe('wall-clock sleeps in tests', () => {
  it('lists only files that still sleep on wall clock', () => {
    const stale = KNOWN_WALL_CLOCK_SLEEPERS.filter(
      (rel) => !fs.existsSync(path.join(REPO_ROOT, rel)) || !sleepsOnWallClock(rel)
    );

    expect(
      stale,
      'These files no longer sleep on wall clock (or no longer exist). Delete them from ' +
        'KNOWN_WALL_CLOCK_SLEEPERS - the list only ratchets down.'
    ).toEqual([]);
  });

  it('covers every test file that sleeps on wall clock', () => {
    const known = new Set(KNOWN_WALL_CLOCK_SLEEPERS);
    const unlisted = listTestFiles()
      .filter((rel) => rel !== SELF)
      .filter((rel) => !known.has(rel))
      .filter(sleepsOnWallClock);

    expect(
      unlisted,
      'These tests wait on wall clock, which a loaded 24-fork run does not respect - the ' +
        'timer fires while the pipeline behind it is still mid-flight. Wait on event-loop ' +
        'turns instead: settleUntil / settleTurns from tests/helpers/eventLoop.ts.'
    ).toEqual([]);
  });
});
