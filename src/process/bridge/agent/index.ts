/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that answer "which agents exist on this machine, can we reach them,
 * and what can they do". Health checks and custom-connection probes drive a
 * real round trip against a backend; onboarding runs the same question as a
 * first-run sweep; the remote-agent and Star Office bridges discover agents
 * that live outside this process; the skills bridge is the capability
 * catalogue those agents draw on. What they have in common is discovery and
 * capability - once work is actually being handed to an agent it belongs in
 * `orchestration/`, and once a turn is running it belongs in `conversation/`.
 */

export * from './checkAgentHealth';
export * from './onboardingBridge';
export * from './remoteAgentBridge';
export * from './skillsBridge';
export * from './starOfficeBridge';
export * from './testCustomAgentConnection';
export * from './orchestration';
