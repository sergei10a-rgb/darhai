/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that add or gate capability the core engine does not ship with. MCP
 * servers, installed extensions and the hub they are installed from are the
 * supply side; the ECC harness and the IJFW memory framework are bundled
 * harnesses with the same install/toggle shape; the hook guard and ECC's
 * GateGuard are the matching kill switches that decide whether a tool call is
 * allowed to run at all. `ActivitySnapshotBuilder` sits here because it is the
 * extension registry's own aggregation helper and has no caller outside it.
 * Grouping the supply side with its guards keeps "what can be added" and "what
 * may actually execute" reviewable in one place.
 */

export * from './ActivitySnapshotBuilder';
export * from './eccBridge';
export * from './extensionsBridge';
export * from './hookGuardBridge';
export * from './hubBridge';
export * from './ijfwBridge';
export * from './ijfwDropBridge';
export * from './mcpBridge';
