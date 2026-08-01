/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * LIVE IMAP CHECK for the built-in email MCP server. OPT-IN ONLY.
 *
 * Against a throwaway server (no account, no secrets, ~15s):
 *
 *     docker run -d --name darhai-greenmail \
 *       -p 3325:3025 -p 3343:3143 \
 *       -e 'GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 \
 *           -Dgreenmail.users=darhai:nuuts123@darhai.test' \
 *       greenmail/standalone:2.1.9
 *
 *     DARHAI_IMAP_LIVE=1 IMAP_HOST=127.0.0.1 IMAP_PORT=3343 IMAP_TLS=false \
 *     IMAP_USER=darhai IMAP_PASSWORD=nuuts123 DARHAI_IMAP_LIVE_SMTP_PORT=3325 \
 *       node ./node_modules/vitest/vitest.mjs run \
 *       tests/unit/process/resources/builtinMcp/imapLive.network.test.ts
 *
 * The same command with a real host, port 993, TLS on and an app password runs
 * this file against Gmail/Fastmail/Outlook unchanged - which is the point: the
 * IMAP dialect differences that fixtures cannot fake (SPECIAL-USE flags, folder
 * naming, UTF-7 mailbox names, MIME shapes) only show up against a real server.
 *
 * Why opt-in: it needs a server, and a suite that goes red because a container
 * is not running teaches everyone to ignore red. The DETERMINISTIC coverage -
 * header injection, draft-mailbox pinning, body fencing - lives in
 * `imapSecurity.test.ts` and always runs.
 *
 * NOTE ON PORTS: this machine reserves 2280-3179/tcp, so GreenMail's documented
 * 3025/3143 cannot be bound on the host. The mapping above deliberately uses
 * 3325/3343. See the dynamic-port-range note in the repo's testing docs.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as net from 'node:net';
import { createImapServer } from '../../../../../src/process/resources/builtinMcp/imap/imapServer';

const LIVE = process.env.DARHAI_IMAP_LIVE === '1';
const SMTP_PORT = Number(process.env.DARHAI_IMAP_LIVE_SMTP_PORT ?? '0');
const TIMEOUT_MS = 60_000;

/** Cyrillic on purpose: encoding is the failure this suite exists to catch. */
const SUBJECT = 'Дархай шалгалт: ноорог ба унших';
const BODY = 'Сайн байна уу. Энэ бол автомат шалгалтын захиа. Өө, Үү, Ёё бүгд байх ёстой.';

/**
 * Deliver one message by speaking SMTP directly.
 *
 * A raw socket rather than nodemailer, so that ARRIVING mail does not depend on
 * the very transport the send path uses - if both used nodemailer, a bug in it
 * could make this file green by cancelling itself out.
 */
async function deliverViaSmtp(port: number): Promise<void> {
  const mime = [
    'From: sender@darhai.test',
    'To: darhai@darhai.test',
    `Subject: =?UTF-8?B?${Buffer.from(SUBJECT, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(BODY, 'utf8').toString('base64'),
  ].join('\r\n');

  const script = [
    'HELO darhai.test',
    'MAIL FROM:<sender@darhai.test>',
    'RCPT TO:<darhai@darhai.test>',
    'DATA',
    `${mime}\r\n.`,
    'QUIT',
  ];

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let step = -1; // -1 = waiting for the greeting
    const fail = (reason: string) => {
      socket.destroy();
      reject(new Error(reason));
    };

    socket.setTimeout(15_000, () => fail('SMTP server did not answer in time'));
    socket.on('error', (error) => reject(error));
    socket.on('data', (chunk) => {
      const reply = chunk.toString('utf8');
      if (/^[45]/.test(reply)) return fail(`SMTP rejected step ${step}: ${reply.trim()}`);
      step += 1;
      if (step >= script.length) {
        socket.end();
        return resolve();
      }
      socket.write(`${script[step]}\r\n`);
    });
    socket.on('close', () => resolve());
  });
}

describe.skipIf(!LIVE)('IMAP MCP against a live server', () => {
  beforeAll(async () => {
    if (SMTP_PORT > 0) await deliverViaSmtp(SMTP_PORT);
  }, TIMEOUT_MS);

  it(
    'reports itself configured and lists real mailboxes',
    async () => {
      const server = createImapServer();
      expect(server.isConfigured(), 'IMAP_* env vars are incomplete').toBe(true);

      const result = await server.listMailboxes();
      expect(result.mailboxes.length).toBeGreaterThan(0);
      // Every server in existence exposes INBOX; if this fails, the connection
      // succeeded but we are talking to something that is not IMAP.
      expect(result.mailboxes.some((box) => box.path.toUpperCase() === 'INBOX')).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'lists and reads a message with Cyrillic intact end to end',
    async () => {
      const server = createImapServer();
      const listed = await server.listMessages({ mailbox: 'INBOX', limit: 20 });
      expect(listed.count).toBeGreaterThan(0);

      const target = listed.messages.find((message) => message.subject?.includes('Дархай шалгалт'));
      expect(
        target,
        `Cyrillic subject not found among: ${listed.messages.map((m) => m.subject).join(' | ')}`
      ).toBeTruthy();

      const read = await server.readMessage({ uid: target!.uid, mailbox: 'INBOX' });
      // Decoded, not raw: a base64 or =?UTF-8?B? artefact here means the decode
      // step is missing, which fixtures with pre-decoded bodies never catch.
      expect(read.subject).toContain('ноорог');
      expect(read.body).toContain('Өө, Үү, Ёё');
      expect(read.body).not.toContain('=?UTF-8?B?');
    },
    TIMEOUT_MS
  );

  it(
    'either files a draft into a real Drafts mailbox or says plainly that there is none',
    async () => {
      const server = createImapServer();
      const { draftsMailbox } = await server.listMailboxes();

      if (!draftsMailbox) {
        // A bare server (GreenMail out of the box) has no Drafts folder. The
        // contract is that this is an explicit, readable refusal - never a
        // silent success that loses the user's text.
        await expect(server.saveDraft({ to: ['someone@darhai.test'], subject: SUBJECT, body: BODY })).rejects.toThrow(
          /[Dd]raft/
        );
        return;
      }

      const saved = await server.saveDraft({ to: ['someone@darhai.test'], subject: SUBJECT, body: BODY });
      expect(saved.saved).toBe(true);
      expect(saved.sent, 'saving a draft must never send').toBe(false);
      expect(saved.draftsMailbox).toBe(draftsMailbox);

      const drafts = await server.listMessages({ mailbox: draftsMailbox, limit: 20 });
      expect(drafts.messages.some((message) => message.subject?.includes('Дархай шалгалт'))).toBe(true);
    },
    TIMEOUT_MS
  );

  it(
    'fails with a readable error on a wrong password rather than hanging',
    async () => {
      // The server reads credentials from `env`, never from a settings object -
      // overriding the password any other way silently leaves the REAL one in
      // place and the test passes while proving nothing.
      const server = createImapServer({
        env: { ...process.env, IMAP_PASSWORD: 'definitely-not-the-password' },
      });
      const started = Date.now();

      await expect(server.listMailboxes()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(30_000);
    },
    TIMEOUT_MS
  );
});
