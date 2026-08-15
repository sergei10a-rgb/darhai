/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that decide which model a call reaches and what that call costs.
 * `modelBridge` owns the merged provider catalogue every other caller reads;
 * routing and the OmniRoute gateway pick a target when none is pinned; compare
 * and fusion fan one prompt across several targets; cost and usage are the
 * accounting side of the same calls. Vendor-specific connection code lives one
 * level down in `providers/` so this directory stays about *choosing* a model
 * rather than about speaking any one vendor's dialect.
 */

export * from './compareBridge';
export * from './costBridge';
export * from './fusionBridge';
export * from './modelBridge';
export * from './omnirouteGatewayBridge';
export * from './routingBridge';
export * from './usageBridge';
export * from './providers';
