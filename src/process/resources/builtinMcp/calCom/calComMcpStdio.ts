/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stdio MCP subprocess entrypoint for the built-in Cal.com server.
 *
 * Bundled by `scripts/build-mcp-servers.js` into
 * `out/main/builtin-mcp-cal-com.js`, unpacked from the asar by
 * `electron-builder.yml`, and spawned as a plain `node` child. It needs nothing
 * from the Electron app - only outbound HTTPS to Cal.com - so, like the news
 * server and unlike `builtin-mcp-personal-data.js`, there is no loopback
 * bridge.
 *
 * A MISSING API KEY IS NOT FATAL. The server still registers every tool and
 * answers `initialize` / `tools/list`, then returns a precise setup error at
 * call time. Exiting instead would make a configuration gap look exactly like a
 * broken bundle to `scripts/verify-mcp-scripts.js`.
 *
 * NOTE: stdout is the MCP transport. Diagnostics must go to stderr only.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_CAL_COM_NAME } from '../constants';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, readCalConfig } from './calComClient';
import { createCalComServer, DEFAULT_ITEMS, MAX_ITEMS } from './calComServer';
import { makeCalRedactor, redactSecrets } from './types';

/** Bound to the configured key, so a self-hosted token shape is covered too. */
const redact = makeCalRedactor(readCalConfig().apiKey);

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_ITEMS)
  .optional()
  .describe(`Optional. Maximum items to return (default ${DEFAULT_ITEMS}, max ${MAX_ITEMS}).`);

const timeoutSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`Optional. Per-request deadline in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`);

const isoSchema = (label: string) => z.string().min(4).describe(`${label} as ISO 8601, e.g. 2026-08-05T09:00:00Z.`);

/** Every tool answers with pretty JSON; failures answer with redacted `isError` text. */
async function respond(toolName: string, run: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: redact(JSON.stringify(await run(), null, 2)) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `${toolName} error: ${redact(message)}` }], isError: true };
  }
}

function registerTools(server: McpServer, handler: ReturnType<typeof createCalComServer>): void {
  server.tool(
    'cal_whoami',
    'Show which Cal.com account the configured API key belongs to (id, email, username, time zone). Use this first to confirm the key works. Read-only.',
    { timeoutMs: timeoutSchema },
    async (args) => respond('cal_whoami', async () => handler.me(args))
  );

  server.tool(
    'cal_list_bookings',
    'List bookings on the connected Cal.com account. `status` picks upcoming (default), past, cancelled or all. Each booking has uid, title, status, start/end, duration, attendees, location and the Cal.com cancel/reschedule links. Read-only - this server never changes a booking.',
    {
      status: z
        .enum(['upcoming', 'past', 'cancelled', 'all'])
        .optional()
        .describe('Which bookings to return (default "upcoming").'),
      attendeeEmail: z.string().optional().describe('Optional. Only bookings with this attendee.'),
      limit: limitSchema,
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('cal_list_bookings', async () => handler.listBookings(args))
  );

  server.tool(
    'cal_get_booking',
    'Fetch ONE booking by its Cal.com uid (the value `cal_list_bookings` returns as `uid`). Returns the same normalised shape, including the cancel and reschedule links to hand to the user. Read-only.',
    { uid: z.string().min(1).describe('Cal.com booking uid.'), timeoutMs: timeoutSchema },
    async (args) => respond('cal_get_booking', async () => handler.getBooking(args))
  );

  server.tool(
    'cal_list_event_types',
    'List the event types on the account - the bookable templates other people choose from (title, slug, length, hidden flag, public booking URL). You need an `id` from here before checking availability. Read-only.',
    { limit: limitSchema, timeoutMs: timeoutSchema },
    async (args) => respond('cal_list_event_types', async () => handler.listEventTypes(args))
  );

  server.tool(
    'cal_get_available_slots',
    'Free slots for one event type between two instants, grouped by day. This route is public on Cal.com, so it answers even before an API key is configured. Read-only.',
    {
      eventTypeId: z.number().int().positive().describe('Event type id from `cal_list_event_types`.'),
      start: isoSchema('Range start'),
      end: isoSchema('Range end'),
      timeZone: z.string().optional().describe('Optional IANA zone, e.g. Asia/Ulaanbaatar.'),
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('cal_get_available_slots', async () => handler.getAvailableSlots(args))
  );

  server.tool(
    'cal_draft_booking',
    'Prepare a booking for the USER to confirm - it does NOT book anything. Checks the requested time against Cal.com availability, then returns the composed draft, whether the slot is genuinely free, alternative times on that day when it is not, and the Cal.com link the user clicks to make it real. ' +
      "This server has no create, cancel or reschedule tool on purpose: a booking is another person's time, and a booking or cancellation the user did not approve sends mail that cannot be un-sent.",
    {
      eventTypeId: z.number().int().positive().describe('Event type id from `cal_list_event_types`.'),
      start: isoSchema('Requested start'),
      attendeeName: z.string().min(1).describe('Name of the person attending.'),
      attendeeEmail: z.string().min(3).describe('Email address of the person attending.'),
      timeZone: z.string().optional().describe('Optional IANA zone, e.g. Asia/Ulaanbaatar.'),
      notes: z.string().optional().describe('Optional note to include with the booking request.'),
      timeoutMs: timeoutSchema,
    },
    async (args) => respond('cal_draft_booking', async () => handler.draftBooking(args))
  );
}

async function main(): Promise<void> {
  const server = new McpServer({ name: BUILTIN_CAL_COM_NAME, version: '1.0.0' });
  registerTools(server, createCalComServer());
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`[CalComMCP] Fatal error: ${redactSecrets(String(error))}\n`);
  process.exit(1);
});
