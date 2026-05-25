/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '@office-ai/platform';
import { initAllBridges } from '../bridge';
import { SqliteChannelRepository } from '@process/services/database/SqliteChannelRepository';
import { SqliteConversationRepository } from '@process/services/database/SqliteConversationRepository';
import { ConversationServiceImpl } from '@process/services/ConversationServiceImpl';
import { cronService } from '@process/services/cron/cronServiceSingleton';
import { workerTaskManager } from '@process/task/workerTaskManagerSingleton';
import { TeamSessionService, SqliteTeamRepository } from '@process/team';
import { initTeamGuideService } from '@process/team/mcp/guide/teamGuideSingleton';
import { CronRitualScheduler, makeExtensionRegistryRitualsResolver } from '@process/team/ritualScheduler';
import { prewarmProviderSdks } from '@process/utils/prewarmProviders';
import { getDatabase } from '@process/services/database';
import { SqliteUsageEventRepository } from '@process/services/usage/SqliteUsageEventRepository';
import { UsageEventLogger } from '@process/services/usage/UsageEventLogger';
import { ensureUsageProviderRegistered, initUsageBridge } from '@process/bridge/usageBridge';

logger.config({ print: true });

const repo = new SqliteConversationRepository();
const conversationServiceImpl = new ConversationServiceImpl(repo);
const channelRepo = new SqliteChannelRepository();
const teamRepo = new SqliteTeamRepository();
// Standing-Company rituals: installs cron rows on promote / bundle-create so
// the marketed autonomy actually fires. Resolver pulls ritual definitions
// from the live ExtensionRegistry — same source the team-export bridge uses.
const ritualScheduler = new CronRitualScheduler(cronService, makeExtensionRegistryRitualsResolver());
const teamSessionService = new TeamSessionService(
  teamRepo,
  workerTaskManager,
  conversationServiceImpl,
  ritualScheduler
);

// Initialize all IPC bridges
initAllBridges({
  conversationService: conversationServiceImpl,
  conversationRepo: repo,
  workerTaskManager,
  channelRepo,
  teamSessionService,
});

// Initialize cron service (load jobs from database and start timers).
// Once jobs are loaded, pre-warm the AI SDKs referenced by enabled jobs
// so scheduled tasks don't pay the lazy-load latency on first fire.
// Backends with no in-process SDK (ACP CLIs, wcore, remote, etc.) are
// no-ops in the pre-warmer — see prewarmProviders.ts.
//
// v0.4.7.1 (G-M-2) — also publish the cron readiness promise via
// `setCronReadyPromise` so the kickoff bridge can await it before
// running Level-1 ritual detection. Without this, a first-launch
// Standing-Company user could open the first new-chat before any
// ritual cron was loaded and miss the Level-1 card.
const cronReadyPromise = cronService
  .init()
  .then(async () => {
    try {
      const jobs = await cronService.listJobs();
      const backends = jobs
        .filter((job) => job.enabled)
        .map((job) => job.metadata.agentType as string)
        .filter((b): b is string => !!b);
      if (backends.length > 0) {
        await prewarmProviderSdks(backends);
      }
    } catch (error) {
      console.warn('[initBridge] Provider SDK pre-warm skipped:', error);
    }
  })
  .catch((error) => {
    console.error('[initBridge] Failed to initialize CronService:', error);
  });

void cronReadyPromise.then(() => {
  // No-op: published via setCronReadyPromise below; this `then` only keeps
  // the chain alive so rejection surfaces in the .catch above.
});

// Publish the cron-ready promise so the kickoff bridge can await it
// before reading the cron store. Imported indirectly to avoid a
// circular module dep at initBridge load time.
void import('@process/services/cron/cronReadiness').then(({ setCronReadyPromise }) => {
  setCronReadyPromise(cronReadyPromise);
});

// Start in-process Wayland Core MCP server for team-guide tools (aion_create_team)
void initTeamGuideService(teamSessionService).catch((error) => {
  console.error('[initBridge] Failed to initialize TeamGuideMcpServer:', error);
});

// Usage telemetry bridge. Register the IPC provider EAGERLY so the first
// renderer-side telemetry call (e.g. `guid.foreground`, fired in a `useEffect`
// on mount) is never dropped during the cold-start window where `getDatabase()`
// is still resolving. Events that arrive before the logger lands are buffered
// in arrival order inside `usageBridge.ts` and flushed once `initUsageBridge`
// wires the SQLite-backed logger (writes to the usage_events table from
// migration v40). This closes the cross-audit Gemini-HIGH race.
ensureUsageProviderRegistered();
void getDatabase()
  .then((db) => {
    const usageRepo = new SqliteUsageEventRepository(db.getDriver());
    const usageLogger = new UsageEventLogger(usageRepo);
    initUsageBridge(usageLogger);
  })
  .catch((error) => {
    console.error('[initBridge] Failed to initialize usage telemetry bridge:', error);
  });
