/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that hand work to agents and track it while it runs. A task is a
 * single unit of delegated work, a workflow is a multi-step chain of them, a
 * cron entry is one scheduled on a clock, a team session is one shared across
 * several agents, and mission control is the unified ledger the renderer reads
 * all of them back from. They sit together because they all own work that
 * outlives the request that started it - unlike `../` above, which only
 * answers what an agent *is*.
 */

export * from './cronBridge';
export * from './missionControlBridge';
export * from './taskBridge';
export * from './teamBridge';
export * from './workflowBridge';
