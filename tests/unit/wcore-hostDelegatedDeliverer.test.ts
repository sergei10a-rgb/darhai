/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The deliverer that closes host-delegated delivery, and the gate that decides
 * whether the engine is asked to delegate at all.
 *
 * WHAT THIS FILE IS ABOUT. `hostDelegatedDelivery` has always been able to
 * ANSWER a delegated send; until now it had nothing to answer it WITH, so every
 * request was declined with "no delivery transport is installed" and the spawn
 * flag was deliberately withheld. Two things had to become true together, and
 * they are tested together here:
 *
 *  1. {@link createChannelDeliverer} delivers through Darhai's OWN channel
 *     fleet - the plugins the Settings pane configures and starts - and refuses,
 *     out loud and with a reason, in every case where it cannot;
 *  2. `buildEngineSpawnEnv` sets `WAYLAND_SEND_MESSAGE_HOST_DELEGATE` ONLY when
 *     a deliverer is installed. That direction matters: asking the engine to
 *     delegate on a build with no deliverer takes `send_message` away from the
 *     model entirely, which is worse than leaving delivery with the engine.
 *
 * WHY DELEGATING IS AN IMPROVEMENT AT ALL, measured rather than assumed. The
 * engine reads its channels from `<WAYLAND_HOME>/channels` and Darhai never
 * writes there - channel config lives in Darhai's own database. Run against the
 * bundled v0.12.26 binary under the profile Darhai spawns it with,
 * `wayland-core channel list` answers "no channels configured in
 * ...\wayland-core\channels". So the undelegated tool can reach nothing; the
 * fleet driven below is the only thing in this app that can reach anything.
 *
 * The fleet is a STUB here on purpose. A `BasePlugin` drags in baileys,
 * matrix-js-sdk, imapflow and discord.js; what is under test is the resolution
 * and refusal logic, and `DeliveryChannel` is the exact structural contract the
 * real plugins satisfy - `tsc` proves that at the wiring site, not this file.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildEngineSpawnEnv, HOST_DELEGATED_SEND_ENV } from '@process/agent/wcore/envBuilder';
import {
  createChannelDeliverer,
  createHostDelegatedDeliveryCapability,
  hostDelegatedDeliveryCapability,
  DELIVERABLE_PLUGIN_STATUS,
  MAX_WIRE_ID_LENGTH,
  PLATFORM_PLUGIN_TYPES,
  type DeliveryChannel,
  type DeliveryRequest,
} from '@process/agent/wcore/capabilities/handlers/hostDelegatedDelivery';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import type { IUnifiedOutgoingMessage, PluginStatus, PluginType } from '@process/channels/types';
import { examplePayload, validateCommand } from '../helpers/engineContract';

/* ------------------------------- harness -------------------------------- */

type SentMessage = { chatId: string; message: IUnifiedOutgoingMessage };

type FakeChannel = DeliveryChannel & { sent: SentMessage[] };

function fakeChannel(
  type: PluginType,
  options: {
    status?: PluginStatus;
    selfTarget?: string | null;
    messageId?: string;
    fail?: string;
  } = {}
): FakeChannel {
  const sent: SentMessage[] = [];
  return {
    type,
    status: options.status ?? DELIVERABLE_PLUGIN_STATUS,
    sent,
    getSelfTarget: () => options.selfTarget ?? null,
    sendMessage: async (chatId, message) => {
      sent.push({ chatId, message });
      if (options.fail !== undefined) throw new Error(options.fail);
      return options.messageId ?? 'platform-msg-1';
    },
  };
}

function request(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    callId: 'call-send-001',
    platform: 'email',
    pluginTypes: PLATFORM_PLUGIN_TYPES.email,
    body: 'The run completed.',
    ...overrides,
  };
}

type Recorder = CapabilityContext & { commands: Record<string, unknown>[]; warns: string[] };

function makeContext(): Recorder {
  const commands: Record<string, unknown>[] = [];
  const warns: string[] = [];
  return {
    commands,
    warns,
    sendCommand: (command) => commands.push(command as Record<string, unknown>),
    emit: () => {},
    activeMsgId: () => 'msg-1',
    log: () => {},
    warn: (message) => warns.push(message),
  };
}

/** Let the deliverer's promise chain and the capability's `.then` settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* -------------------------- what it delivers through --------------------- */

describe('createChannelDeliverer routes through Darhai channel plugins', () => {
  it('sends through the running plugin and returns the platform message id', async () => {
    const telegram = fakeChannel('telegram', { messageId: 'tg-77' });
    const deliver = createChannelDeliverer(async () => [telegram]);

    const outcome = await deliver(
      request({ platform: 'telegram', pluginTypes: PLATFORM_PLUGIN_TYPES.telegram, chatId: '-100123' })
    );

    expect(outcome).toEqual({ ok: true, messageId: 'tg-77' });
    expect(telegram.sent).toEqual([{ chatId: '-100123', message: { type: 'text', text: 'The run completed.' } }]);
  });

  it('honours the REQUEST preference order, not the order the fleet reports', async () => {
    // `email` maps to email-imap then email-agentmail: the user's own mailbox
    // before the hosted relay. A fleet that lists the relay first must not win.
    const relay = fakeChannel('email-agentmail', { messageId: 'relay-1' });
    const own = fakeChannel('email-imap', { messageId: 'imap-1' });
    const deliver = createChannelDeliverer(async () => [relay, own]);

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome).toEqual({ ok: true, messageId: 'imap-1' });
    expect(relay.sent).toEqual([]);
  });

  it('falls through to the next candidate type when the preferred one is not running', async () => {
    const own = fakeChannel('email-imap', { status: 'stopped' });
    const relay = fakeChannel('email-agentmail', { messageId: 'relay-1' });
    const deliver = createChannelDeliverer(async () => [own, relay]);

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome).toEqual({ ok: true, messageId: 'relay-1' });
    expect(own.sent).toEqual([]);
  });

  it('carries the subject through to the channel', async () => {
    const own = fakeChannel('email-imap');
    const deliver = createChannelDeliverer(async () => [own]);

    await deliver(request({ chatId: 'operator@example.invalid', subject: 'Darhai update' }));

    expect(own.sent[0].message).toEqual({
      type: 'text',
      text: 'The run completed.',
      subject: 'Darhai update',
    });
  });

  it('leaves subject ABSENT when the request carried none', async () => {
    const own = fakeChannel('email-imap');
    const deliver = createChannelDeliverer(async () => [own]);

    await deliver(request({ chatId: 'operator@example.invalid' }));

    expect('subject' in own.sent[0].message).toBe(false);
  });

  it('uses the channel default target when the request named no chat_id', async () => {
    const own = fakeChannel('email-imap', { selfTarget: 'me@example.invalid' });
    const deliver = createChannelDeliverer(async () => [own]);

    const outcome = await deliver(request());

    expect(outcome.ok).toBe(true);
    expect(own.sent[0].chatId).toBe('me@example.invalid');
  });

  it('treats an EMPTY chat_id as absent rather than delivering to nowhere', async () => {
    // The schema puts no minLength on `chat_id`, so `""` is a contract-legal
    // request; handing it to a plugin as a target is not a thing any plugin does.
    const own = fakeChannel('email-imap', { selfTarget: 'me@example.invalid' });
    const deliver = createChannelDeliverer(async () => [own]);

    await deliver(request({ chatId: '' }));

    expect(own.sent[0].chatId).toBe('me@example.invalid');
  });
});

/* ----------------------------- stated refusals --------------------------- */

describe('createChannelDeliverer refuses out loud, never silently', () => {
  it('refuses when no channel of the mapped types is configured, and says which', async () => {
    const deliver = createChannelDeliverer(async () => [fakeChannel('telegram')]);

    const outcome = await deliver(request({ platform: 'slack', pluginTypes: PLATFORM_PLUGIN_TYPES.slack }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('no slack channel is configured in Darhai');
  });

  it('distinguishes "configured but not connected" from "not configured"', async () => {
    const slack = fakeChannel('slack', { status: 'error' });
    const deliver = createChannelDeliverer(async () => [slack]);

    const outcome = await deliver(request({ platform: 'slack', pluginTypes: PLATFORM_PLUGIN_TYPES.slack }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('configured but not connected');
    expect(outcome.ok === false && outcome.error).toContain('slack=error');
    expect(slack.sent).toEqual([]);
  });

  it('does not deliver through a plugin that is merely "ready" (initialized, not started)', async () => {
    const telegram = fakeChannel('telegram', { status: 'ready' });
    const deliver = createChannelDeliverer(async () => [telegram]);

    const outcome = await deliver(
      request({ platform: 'telegram', pluginTypes: PLATFORM_PLUGIN_TYPES.telegram, chatId: '-100123' })
    );

    expect(outcome.ok).toBe(false);
    expect(telegram.sent).toEqual([]);
  });

  it('refuses when there is no chat_id and the channel has no default target', async () => {
    const telegram = fakeChannel('telegram', { selfTarget: null });
    const deliver = createChannelDeliverer(async () => [telegram]);

    const outcome = await deliver(request({ platform: 'telegram', pluginTypes: PLATFORM_PLUGIN_TYPES.telegram }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('no chat_id');
    expect(outcome.ok === false && outcome.error).toContain('no default target');
    expect(telegram.sent).toEqual([]);
  });

  it('turns a plugin throw into ok:false rather than propagating it', async () => {
    const own = fakeChannel('email-imap', { fail: 'SMTP 535 auth failed' });
    const deliver = createChannelDeliverer(async () => [own]);

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('SMTP 535 auth failed');
  });

  it('turns an unreadable fleet into ok:false rather than propagating it', async () => {
    const deliver = createChannelDeliverer(async () => {
      throw new Error('ChannelManager not initialised');
    });

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('ChannelManager not initialised');
  });

  it('survives a fleet that resolves to nothing', async () => {
    const deliver = createChannelDeliverer(async () => undefined as unknown as DeliveryChannel[]);

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('is configured in Darhai');
  });
});

/* --------------------- a sent message is never called failed ------------- */

describe('a message that really went out is never reported as a failure', () => {
  it('reports ok:true without a receipt when the plugin returned an empty message id', async () => {
    // The alternative is `readDeliveryOutcome`'s "success with an unusable
    // message id" arm, which answers the engine ok:false - and the model is then
    // entitled to send the same email a second time.
    const own = fakeChannel('email-imap', { messageId: '' });
    const deliver = createChannelDeliverer(async () => [own]);

    const outcome = await deliver(request({ chatId: 'operator@example.invalid' }));

    expect(outcome).toEqual({ ok: true });
  });

  it('drops an over-long receipt but still reports the send as delivered', async () => {
    const own = fakeChannel('email-imap', { messageId: 'x'.repeat(MAX_WIRE_ID_LENGTH + 1) });
    const deliver = createChannelDeliverer(async () => [own]);

    expect(await deliver(request({ chatId: 'operator@example.invalid' }))).toEqual({ ok: true });
  });
});

/* ------------------ end to end: the engine's own fixture ----------------- */

describe('the engine fixture reaches a channel and is answered on the wire', () => {
  it('delivers the contract example and answers host_send_message_result ok:true', async () => {
    const own = fakeChannel('email-imap', { messageId: 'desktop-message-001' });
    const capability = createHostDelegatedDeliveryCapability();
    capability.setMessageDeliverer(createChannelDeliverer(async () => [own]));
    const ctx = makeContext();

    const event = examplePayload('event', 'host_send_message_request');
    expect(capability.handle(event, ctx)).toBe(true);
    await flush();

    expect(own.sent).toEqual([
      {
        chatId: 'operator@example.invalid',
        message: { type: 'text', text: 'The run completed.', subject: 'Wayland update' },
      },
    ]);
    expect(ctx.commands).toEqual([
      {
        type: 'host_send_message_result',
        call_id: 'call-send-001',
        ok: true,
        message_id: 'desktop-message-001',
        error: '',
      },
    ]);
    expect(validateCommand(ctx.commands[0]).valid).toBe(true);
    expect(capability.inFlightCallIds()).toEqual([]);
  });

  it('answers ok:false with the refusal text when the fleet cannot serve the platform', async () => {
    const capability = createHostDelegatedDeliveryCapability();
    capability.setMessageDeliverer(createChannelDeliverer(async () => []));
    const ctx = makeContext();

    expect(capability.handle(examplePayload('event', 'host_send_message_request'), ctx)).toBe(true);
    await flush();

    const answer = ctx.commands[0];
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).toContain('is configured in Darhai');
    expect(validateCommand(answer).valid).toBe(true);
  });
});

/* ---------------------------- the spawn-flag gate ------------------------ */

describe('WAYLAND_SEND_MESSAGE_HOST_DELEGATE is gated on a deliverer existing', () => {
  it('is absent when no deliverer is installed', () => {
    const env = buildEngineSpawnEnv({ providerEnv: {}, hostDelivery: { hasMessageDeliverer: () => false } });

    expect(env[HOST_DELEGATED_SEND_ENV]).toBeUndefined();
  });

  it('is "1" - the value the engine names - once a deliverer is installed', () => {
    const env = buildEngineSpawnEnv({ providerEnv: {}, hostDelivery: { hasMessageDeliverer: () => true } });

    expect(env[HOST_DELEGATED_SEND_ENV]).toBe('1');
  });

  it('cannot be switched on by a forwarded tool key of the same name', () => {
    // The allowlist stops a SHELL-exported value; tool keys are layered in after
    // it under names their own store chooses, so the gate must delete rather
    // than merely decline to set.
    const env = buildEngineSpawnEnv({
      providerEnv: {},
      toolKeys: { [HOST_DELEGATED_SEND_ENV]: '1' },
      hostDelivery: { hasMessageDeliverer: () => false },
    });

    expect(env[HOST_DELEGATED_SEND_ENV]).toBeUndefined();
  });

  it('cannot be switched on by a provider env entry of the same name', () => {
    const env = buildEngineSpawnEnv({
      providerEnv: { [HOST_DELEGATED_SEND_ENV]: '1' },
      hostDelivery: { hasMessageDeliverer: () => false },
    });

    expect(env[HOST_DELEGATED_SEND_ENV]).toBeUndefined();
  });

  it('cannot be inherited from the launching shell even when a deliverer exists', () => {
    // Inheriting it would make delegation a property of the environment rather
    // than of the build, so the name stays off ENGINE_ENV_ALLOWLIST; with a
    // deliverer the value is the engine's own "1", never the shell's.
    vi.stubEnv(HOST_DELEGATED_SEND_ENV, 'inherited-nonsense');
    try {
      expect(
        buildEngineSpawnEnv({ providerEnv: {}, hostDelivery: { hasMessageDeliverer: () => false } })[
          HOST_DELEGATED_SEND_ENV
        ]
      ).toBeUndefined();
      expect(
        buildEngineSpawnEnv({ providerEnv: {}, hostDelivery: { hasMessageDeliverer: () => true } })[
          HOST_DELEGATED_SEND_ENV
        ]
      ).toBe('1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults to the shared capability, so the gate reads live state', () => {
    // No `hostDelivery` argument: this is the shape a real spawn uses. Both arms
    // are driven through the singleton itself, which is what the wiring in
    // `agent/wcore/index.ts` installs into.
    hostDelegatedDeliveryCapability.setMessageDeliverer(null);
    expect(buildEngineSpawnEnv({ providerEnv: {} })[HOST_DELEGATED_SEND_ENV]).toBeUndefined();

    hostDelegatedDeliveryCapability.setMessageDeliverer(async () => ({ ok: true }));
    expect(buildEngineSpawnEnv({ providerEnv: {} })[HOST_DELEGATED_SEND_ENV]).toBe('1');

    hostDelegatedDeliveryCapability.setMessageDeliverer(null);
  });
});
