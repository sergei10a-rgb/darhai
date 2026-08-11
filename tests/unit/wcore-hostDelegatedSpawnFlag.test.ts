/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wiring: importing the engine agent installs a deliverer, and only then
 * does a spawn ask the engine to delegate its sends.
 *
 * WHY THIS IS ITS OWN FILE. `hostDelegatedDeliveryCapability` is a
 * process-wide singleton, and `agent/wcore/index.ts` mutates it at module
 * scope. A file that also wanted to observe the "no deliverer installed" arm
 * would have to depend on import order to see it, so the two arms are split:
 * `wcore-hostDelegatedDeliverer.test.ts` owns the gate in both directions with
 * an injected source, and this file owns the one thing only the real module can
 * prove - that the production build actually installs something.
 *
 * MUTATION-FACING BY DESIGN. Delete the `setMessageDeliverer(...)` statement in
 * `agent/wcore/index.ts` and both tests below go red; that is the whole point of
 * reading the gate from live capability state instead of from a caller's
 * boolean or a comment.
 */

import { describe, expect, it } from 'vitest';

import { buildEngineSpawnEnv, HOST_DELEGATED_SEND_ENV } from '@process/agent/wcore/envBuilder';
import { hostDelegatedDeliveryCapability } from '@process/agent/wcore/capabilities/handlers/hostDelegatedDelivery';

// Imported for its module-scope side effect, which is the subject of this file.
// `WCoreAgent` is named so the import cannot be dropped as unused.
import { WCoreAgent } from '@process/agent/wcore/index';

describe('agent/wcore/index installs the channel deliverer', () => {
  it('leaves the shared capability with a delivery transport once loaded', () => {
    expect(typeof WCoreAgent).toBe('function');
    expect(hostDelegatedDeliveryCapability.hasMessageDeliverer()).toBe(true);
  });

  it('makes the spawn env carry WAYLAND_SEND_MESSAGE_HOST_DELEGATE=1', () => {
    // No `hostDelivery` override: this is exactly the call `WCoreAgent.start`
    // makes, so what passes here is what the engine is really launched with.
    const env = buildEngineSpawnEnv({ providerEnv: {}, waylandHome: '/tmp/profile-x' });

    expect(env[HOST_DELEGATED_SEND_ENV]).toBe('1');
  });
});
