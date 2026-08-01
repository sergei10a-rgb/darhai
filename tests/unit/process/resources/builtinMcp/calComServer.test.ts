/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Cal.com MCP server is READ-ONLY on purpose (see `calComServer.ts` for the
 * recorded decision). Two things therefore have to be pinned mechanically:
 *
 *  1. no handler can ever reach Cal.com with a verb other than GET, and
 *  2. the per-route `cal-api-version` header is correct - a wrong value makes
 *     Cal.com answer a bare 404 that looks exactly like a dead endpoint, which
 *     is a debugging trap rather than an error.
 */

import { describe, expect, it } from 'vitest';
import { createCalComServer } from '@process/resources/builtinMcp/calCom/calComServer';
import { normalizeBaseUrl } from '@process/resources/builtinMcp/calCom/calComClient';
import { CAL_API_VERSIONS, redactSecrets } from '@process/resources/builtinMcp/calCom/types';
import type { CalHttpGet } from '@process/resources/builtinMcp/calCom/calComClient';

type Recorded = { route: string; path: string };

/** Build a server whose HTTP layer records calls and replies with `body`. */
function withStub(body: unknown, status = 200, apiKey = 'cal_live_abcdef0123456789') {
  const calls: Recorded[] = [];
  const httpGet: CalHttpGet = async (route, pathAndQuery) => {
    calls.push({ route, path: pathAndQuery });
    return { status, body };
  };
  const handler = createCalComServer({ httpGet, env: { CALCOM_API_KEY: apiKey } });
  return { handler, calls };
}

describe('calComServer - read-only surface', () => {
  it('sends every request through the route whose cal-api-version matches', async () => {
    const { handler, calls } = withStub({ status: 'success', data: [] });
    await handler.listBookings({});
    await handler.listEventTypes({});
    await handler.getAvailableSlots({ eventTypeId: 7, start: '2026-08-05T00:00:00Z', end: '2026-08-06T00:00:00Z' });

    expect(calls.map((c) => c.route)).toEqual(['bookings', 'eventTypes', 'slots']);
    // The versions themselves were pinned against the live API; assert the
    // table still carries them so a careless edit is caught here.
    expect(CAL_API_VERSIONS.bookings).toBe('2024-08-13');
    expect(CAL_API_VERSIONS.eventTypes).toBe('2024-06-14');
    expect(CAL_API_VERSIONS.slots).toBe('2024-09-04');
  });

  it('refuses to call the API at all when no key is configured', async () => {
    const handler = createCalComServer({
      httpGet: async () => {
        throw new Error('the network must not be touched without a key');
      },
      env: {},
    });
    await expect(handler.listBookings({})).rejects.toThrow(/CALCOM_API_KEY/);
  });

  it('still reads the public slots route without a key', async () => {
    const calls: Recorded[] = [];
    const handler = createCalComServer({
      httpGet: async (route, path) => {
        calls.push({ route, path });
        return {
          status: 200,
          body: { status: 'success', data: { '2026-08-05': [{ start: '2026-08-05T09:00:00Z' }] } },
        };
      },
      env: {},
    });
    const result = await handler.getAvailableSlots({
      eventTypeId: 7,
      start: '2026-08-05T00:00:00Z',
      end: '2026-08-06T00:00:00Z',
    });
    expect(result.days).toBe(1);
    expect(result.slots[0].times).toEqual(['2026-08-05T09:00:00Z']);
    expect(calls).toHaveLength(1);
  });
});

describe('calComServer - draftBooking never writes', () => {
  const draftInput = {
    eventTypeId: 7,
    start: '2026-08-05T09:00:00Z',
    attendeeName: 'Бат',
    attendeeEmail: 'bat@example.mn',
  };

  it('reports the slot as free and hands the confirmation back to the human', async () => {
    const { handler, calls } = withStub({
      status: 'success',
      data: { '2026-08-05': [{ start: '2026-08-05T09:00:00Z' }] },
    });
    const result = await handler.draftBooking(draftInput);

    expect(result.confirmed).toBe(false);
    expect(result.slotIsFree).toBe(true);
    expect(result.draft.attendee).toEqual({ name: 'Бат', email: 'bat@example.mn' });
    expect(result.nextStep).toMatch(/NOT BOOKED YET/);
    // One GET for availability, and nothing else. A write would show up here.
    expect(calls).toEqual([expect.objectContaining({ route: 'slots' })]);
  });

  it('offers alternatives instead of a draft when the time is not on offer', async () => {
    const { handler } = withStub({
      status: 'success',
      data: { '2026-08-05': [{ start: '2026-08-05T11:00:00Z' }, { start: '2026-08-05T13:00:00Z' }] },
    });
    const result = await handler.draftBooking(draftInput);

    expect(result.slotIsFree).toBe(false);
    expect(result.alternativesOnThatDay).toEqual(['2026-08-05T11:00:00Z', '2026-08-05T13:00:00Z']);
    expect(result.nextStep).toMatch(/NOT offered/);
  });

  it('rejects an unparseable start before any network call', async () => {
    const handler = createCalComServer({
      httpGet: async () => {
        throw new Error('must not be reached');
      },
      env: { CALCOM_API_KEY: 'cal_live_abcdef0123456789' },
    });
    await expect(handler.draftBooking({ ...draftInput, start: 'tomorrow-ish' })).rejects.toThrow(/ISO 8601/);
  });
});

describe('calComServer - failure messages', () => {
  it('turns a 401 into an instruction naming the env var', async () => {
    const { handler } = withStub({ error: { message: 'Your api key is not valid' } }, 401);
    await expect(handler.listBookings({})).rejects.toThrow(/CALCOM_API_KEY/);
  });

  it('says a 404 may be a route this deployment does not serve', async () => {
    const { handler } = withStub({ error: { message: 'Cannot GET /v2/event-types' } }, 404);
    await expect(handler.listEventTypes({})).rejects.toThrow(/does not serve that route/);
  });
});

describe('redactSecrets', () => {
  it('removes real Cal.com keys and bearer tokens', () => {
    expect(redactSecrets('key=cal_live_9f2a4b6c8d0e1f23')).toBe('key=cal_***redacted***');
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer ***redacted***');
  });

  it("leaves the server's own tool names alone", () => {
    // A looser `cal_[a-z]+_\w+` pattern rewrote `cal_list_bookings` to
    // `cal_***redacted***` in every error message, which was observed live.
    for (const name of ['cal_list_bookings', 'cal_list_event_types', 'cal_get_available_slots', 'cal_draft_booking']) {
      expect(redactSecrets(`${name} error: something`)).toContain(name);
    }
  });
});

describe('normalizeBaseUrl', () => {
  it('accepts a bare self-hosted host and appends the version segment', () => {
    expect(normalizeBaseUrl('cal.example.com')).toBe('https://cal.example.com/v2');
    expect(normalizeBaseUrl('https://cal.example.com/')).toBe('https://cal.example.com/v2');
    expect(normalizeBaseUrl('https://cal.example.com/v2')).toBe('https://cal.example.com/v2');
    expect(normalizeBaseUrl('')).toBe('https://api.cal.com/v2');
  });
});
