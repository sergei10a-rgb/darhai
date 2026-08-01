/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End to end, over real sockets: `email_send` cannot send until a human presses
 * Send, and when they do, the message really goes.
 *
 * What is REAL here
 * -----------------
 *   - the confirmation gate, listening on a real loopback TCP port;
 *   - the subprocess client, reaching it with real framed TCP requests;
 *   - a real SMTP server on loopback, whose received bytes are asserted;
 *   - the real `email_send` tool body, reached exactly as the stdio entrypoint
 *     reaches it (`createImapServer(...).sendMessage(...)`).
 *
 * What is a DOUBLE
 * ----------------
 * `imapflow` only. There is no mail account in CI, so the IMAP side (threading
 * lookup and filing the Sent copy) runs against a controlled client that
 * records what it was asked to APPEND and into which mailbox. The SMTP hop -
 * the one that actually delivers - is a genuine socket carrying genuine RFC
 * 5322 bytes.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';

/** Everything the fake IMAP client was asked to do, per test. */
const imapLog: { appended: Array<{ mailbox: string; mime: string; flags: string[] }> } = { appended: [] };

vi.mock('imapflow', () => {
  class FakeImapFlow {
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    close(): void {}
    async list() {
      return [
        { path: 'INBOX', name: 'INBOX', specialUse: undefined, subscribed: true },
        { path: 'Sent', name: 'Sent', specialUse: '\\Sent', subscribed: true },
      ];
    }
    async append(mailbox: string, mime: Buffer, flags: string[]) {
      imapLog.appended.push({ mailbox, mime: mime.toString('utf8'), flags });
      return { uid: 4242 };
    }
    async getMailboxLock() {
      return { release: (): void => undefined };
    }
    async fetchOne() {
      return { uid: 7, envelope: { messageId: '<seed-1@example.mn>', subject: 'Тайлан' } };
    }
  }
  return { ImapFlow: FakeImapFlow };
});

import { createImapServer } from '@process/resources/builtinMcp/imap/imapServer';
import { ToolConfirmationService } from '@process/services/toolConfirmation/ToolConfirmationService';
import { ToolConfirmationTcpServer } from '@process/services/toolConfirmation/ToolConfirmationTcpServer';
import {
  TOOL_CONFIRM_PORT_ENV,
  TOOL_CONFIRM_TOKEN_ENV,
  type ToolConfirmationRequest,
} from '@process/services/toolConfirmation/types';

// ---------------------------------------------------------------------------
// A real, very small SMTP server. Enough of RFC 5321 for nodemailer.
// ---------------------------------------------------------------------------

type SmtpCapture = { envelopeFrom: string; envelopeTo: string[]; data: string };

type FakeSmtp = { port: number; received: SmtpCapture[]; close: () => Promise<void> };

async function startSmtpServer(): Promise<FakeSmtp> {
  const received: SmtpCapture[] = [];

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: SmtpCapture = { envelopeFrom: '', envelopeTo: [], data: '' };
    let expecting: 'none' | 'auth-user' | 'auth-pass' = 'none';

    socket.write('220 localhost ESMTP darhai-test\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      if (inData) {
        const terminator = buffer.indexOf('\r\n.\r\n');
        if (terminator === -1) return;
        current.data = buffer.slice(0, terminator);
        buffer = buffer.slice(terminator + 5);
        inData = false;
        received.push(current);
        current = { envelopeFrom: '', envelopeTo: [], data: '' };
        socket.write('250 2.0.0 Ok: queued as TESTQUEUE1\r\n');
      }

      let newline = buffer.indexOf('\r\n');
      while (!inData && newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (expecting === 'auth-user') {
          expecting = 'auth-pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (expecting === 'auth-pass') {
          expecting = 'none';
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (/^EHLO/i.test(line)) {
          // No STARTTLS advertised: this listener is the "local bridge" case,
          // which the config layer only reaches when SMTP_TLS is explicitly
          // false. A server that advertised STARTTLS would have to honour it.
          socket.write('250-localhost\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n');
        } else if (/^HELO/i.test(line)) {
          socket.write('250 localhost\r\n');
        } else if (/^AUTH LOGIN/i.test(line)) {
          expecting = 'auth-user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:/i.test(line)) {
          current.envelopeFrom = line.replace(/^MAIL FROM:\s*/i, '').replace(/\s+SIZE=\d+/i, '');
          socket.write('250 2.1.0 Ok\r\n');
        } else if (/^RCPT TO:/i.test(line)) {
          current.envelopeTo.push(line.replace(/^RCPT TO:\s*/i, ''));
          socket.write('250 2.1.5 Ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
        newline = buffer.indexOf('\r\n');
      }
    });

    socket.on('error', () => socket.destroy());
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });

  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------

describe('email_send over real sockets', () => {
  let smtp: FakeSmtp;
  let gate: ToolConfirmationTcpServer;
  let service: ToolConfirmationService;
  let shown: ToolConfirmationRequest[];
  const originalEnv = { port: process.env[TOOL_CONFIRM_PORT_ENV], token: process.env[TOOL_CONFIRM_TOKEN_ENV] };

  beforeAll(async () => {
    smtp = await startSmtpServer();
  });

  afterAll(async () => {
    await smtp.close();
  });

  beforeEach(async () => {
    imapLog.appended = [];
    smtp.received.length = 0;
    shown = [];
  });

  afterEach(async () => {
    await gate?.stop();
    if (originalEnv.port === undefined) delete process.env[TOOL_CONFIRM_PORT_ENV];
    else process.env[TOOL_CONFIRM_PORT_ENV] = originalEnv.port;
    if (originalEnv.token === undefined) delete process.env[TOOL_CONFIRM_TOKEN_ENV];
    else process.env[TOOL_CONFIRM_TOKEN_ENV] = originalEnv.token;
  });

  /**
   * Stand up a live gate, publish its address the way `initToolConfirmationGate`
   * does in production, and hand back a `press()` that answers whatever dialog
   * is currently open - i.e. the human.
   */
  async function liveGate(options: { hasWindow?: boolean; timeoutMs?: number } = {}) {
    service = new ToolConfirmationService({
      hasWindow: () => options.hasWindow !== false,
      emitRequest: (request) => {
        shown.push(request);
      },
      emitCancel: () => undefined,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    gate = new ToolConfirmationTcpServer(service);
    const runtime = await gate.start();
    process.env[TOOL_CONFIRM_PORT_ENV] = String(runtime.port);
    process.env[TOOL_CONFIRM_TOKEN_ENV] = runtime.token;

    return async function press(approved: boolean): Promise<void> {
      await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0), { timeout: 5000 });
      service.respond({ requestId: shown[shown.length - 1].requestId, approved });
    };
  }

  function server() {
    return createImapServer({
      env: {
        IMAP_HOST: '127.0.0.1',
        IMAP_PORT: '1143',
        IMAP_USER: 'bat@example.mn',
        IMAP_PASSWORD: 'imap-app-password',
        IMAP_TLS: 'false',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.port),
        SMTP_TLS: 'false',
      },
    });
  }

  it('delivers the message, and files a copy in Sent, once the user presses Send', async () => {
    const press = await liveGate();
    const sending = server().sendMessage({
      to: ['ganbat@example.mn'],
      cc: ['nomin@example.mn'],
      bcc: ['darkhan@example.mn'],
      subject: 'Долоо хоногийн тайлан',
      body: 'Сайн байна уу.\n\nТайланг хавсаргав.',
    });

    // The dialog is up and nothing has been delivered yet.
    await vi.waitFor(() => expect(shown).toHaveLength(1), { timeout: 5000 });
    expect(smtp.received).toHaveLength(0);
    expect(shown[0].kind).toBe('email.send');
    expect(shown[0].details.find((d) => d.label === 'Message')?.value).toBe('Сайн байна уу.\n\nТайланг хавсаргав.');
    expect(shown[0].details.find((d) => d.label === 'Bcc')?.value).toBe('darkhan@example.mn');

    await press(true);
    const result = await sending;

    expect(result.sent).toBe(true);
    expect(smtp.received).toHaveLength(1);
    // Envelope carries every recipient including the blind one...
    expect(smtp.received[0].envelopeTo.sort()).toEqual([
      '<darkhan@example.mn>',
      '<ganbat@example.mn>',
      '<nomin@example.mn>',
    ]);
    expect(smtp.received[0].envelopeFrom).toBe('<bat@example.mn>');
    // ...but the transmitted headers never name the blind recipient.
    expect(smtp.received[0].data).not.toMatch(/^Bcc:/m);
    expect(smtp.received[0].data).toMatch(/^To: ganbat@example\.mn$/m);
    expect(smtp.received[0].data).toMatch(/^Cc: nomin@example\.mn$/m);
    expect(Buffer.from(smtp.received[0].data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString()).toBe(
      'Сайн байна уу.\n\nТайланг хавсаргав.'
    );

    // The copy is filed in the SERVER-resolved Sent mailbox, not a caller path.
    expect(imapLog.appended).toHaveLength(1);
    expect(imapLog.appended[0].mailbox).toBe('Sent');
    expect(imapLog.appended[0].flags).toEqual(['\\Seen']);
    expect(imapLog.appended[0].mime).toBe(smtp.received[0].data + '\r\n');
    expect(result.sentMailbox).toBe('Sent');
    expect(result.sentCopyUid).toBe(4242);
  });

  it('sends NOTHING when the user presses Cancel', async () => {
    const press = await liveGate();
    const sending = server().sendMessage({
      to: ['ganbat@example.mn'],
      subject: 'Долоо хоногийн тайлан',
      body: 'Сайн байна уу.',
    });

    await press(false);

    await expect(sending).rejects.toThrow(/was NOT sent.*declined/s);
    expect(smtp.received).toHaveLength(0);
    expect(imapLog.appended).toHaveLength(0);
  });

  it('sends NOTHING when nobody answers the dialog', async () => {
    await liveGate({ timeoutMs: 150 });
    await expect(server().sendMessage({ to: ['ganbat@example.mn'], subject: 's', body: 'b' })).rejects.toThrow(
      /was NOT sent.*timeout/s
    );
    expect(smtp.received).toHaveLength(0);
    expect(imapLog.appended).toHaveLength(0);
  });

  it('sends NOTHING when there is no window to ask in', async () => {
    await liveGate({ hasWindow: false });
    await expect(server().sendMessage({ to: ['ganbat@example.mn'], subject: 's', body: 'b' })).rejects.toThrow(
      /was NOT sent.*no-window/s
    );
    expect(shown).toHaveLength(0);
    expect(smtp.received).toHaveLength(0);
  });

  it('sends NOTHING when the gate is not reachable at all', async () => {
    // The MCP subprocess started before the app published the gate address, or
    // the listener never bound. Refusing is the only safe answer.
    delete process.env[TOOL_CONFIRM_PORT_ENV];
    delete process.env[TOOL_CONFIRM_TOKEN_ENV];
    await expect(server().sendMessage({ to: ['ganbat@example.mn'], subject: 's', body: 'b' })).rejects.toThrow(
      /was NOT sent.*not-available/s
    );
    expect(smtp.received).toHaveLength(0);
  });

  it('sends NOTHING when the caller presents the wrong gate token', async () => {
    await liveGate();
    process.env[TOOL_CONFIRM_TOKEN_ENV] = 'a-token-that-is-not-the-real-one';
    await expect(server().sendMessage({ to: ['ganbat@example.mn'], subject: 's', body: 'b' })).rejects.toThrow(
      /was NOT sent/
    );
    expect(shown, 'an unauthorised caller must not even raise a dialog').toHaveLength(0);
    expect(smtp.received).toHaveLength(0);
  });

  it('threads a reply and shows the derived subject before sending it', async () => {
    const press = await liveGate();
    const sending = server().sendMessage({ to: ['ganbat@example.mn'], subject: '', body: 'За.', replyToUid: 7 });
    await press(true);
    const result = await sending;

    expect(result.subject).toBe('Re: Тайлан');
    expect(smtp.received[0].data).toMatch(/^In-Reply-To: <seed-1@example\.mn>$/m);
  });

  it('refuses when sending was never configured, without asking the user anything', async () => {
    await liveGate();
    const readOnly = createImapServer({
      env: {
        IMAP_HOST: '127.0.0.1',
        IMAP_USER: 'bat@example.mn',
        IMAP_PASSWORD: 'imap-app-password',
      },
    });
    expect(readOnly.canSend()).toBe(false);
    await expect(readOnly.sendMessage({ to: ['ganbat@example.mn'], subject: 's', body: 'b' })).rejects.toThrow(
      /SMTP_HOST is empty/
    );
    expect(shown).toHaveLength(0);
  });

  it('answers two dialogs independently: approving one does not send the other', async () => {
    await liveGate();
    const first = server().sendMessage({ to: ['first@example.mn'], subject: 'first', body: 'first body' });
    const second = server().sendMessage({ to: ['second@example.mn'], subject: 'second', body: 'second body' });

    await vi.waitFor(() => expect(shown).toHaveLength(2), { timeout: 5000 });
    const forSecond = shown.find((r) => r.details.some((d) => d.value === 'second@example.mn'));
    const forFirst = shown.find((r) => r.details.some((d) => d.value === 'first@example.mn'));
    expect(forSecond?.requestId).not.toBe(forFirst?.requestId);

    service.respond({ requestId: forSecond?.requestId ?? '', approved: true });
    service.respond({ requestId: forFirst?.requestId ?? '', approved: false });

    await expect(first).rejects.toThrow(/was NOT sent/);
    await expect(second).resolves.toMatchObject({ sent: true });
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].envelopeTo).toEqual(['<second@example.mn>']);
  });
});
