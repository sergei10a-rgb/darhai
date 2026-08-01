/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool bodies for the built-in Cal.com MCP server.
 *
 * READ-ONLY BY CONSTRUCTION. Every handler below reaches Cal.com through
 * {@link calGet}, and `calComClient.ts` implements no HTTP verb other than GET.
 * `cal_draft_booking` is the closest thing to a write and it still only reads:
 * it checks that the slot the model picked is genuinely free and returns a
 * ready-to-confirm summary plus the public booking link for the HUMAN to click.
 *
 * Why no create / cancel / reschedule tool - the decision, recorded here so the
 * next person does not have to rediscover it:
 *
 *   1. A Cal.com booking is OTHER PEOPLE'S time. A surprise booking or a
 *      surprise cancellation sends mail to attendees the user never approved
 *      and cannot be un-sent. That is strictly worse than the surprise-write
 *      hazard `darhai-personal-data` was made read-only to avoid.
 *   2. The API key is account-scoped, not booking-scoped. A model that can
 *      cancel one booking can cancel every booking.
 *   3. Дархай's MCP spawn path has no per-tool human-confirmation primitive.
 *      There is nowhere to put "are you sure?" that the user actually sees
 *      BEFORE the HTTP request leaves the machine, so an approval gate would be
 *      decoration.
 *
 * The user still books in one click - from the link `cal_draft_booking`
 * returns - and the confirmation happens where Cal.com already put it.
 */

import { calGet, createCalHttpGet, readCalConfig, DEFAULT_TIMEOUT_MS, type CalHttpGet } from './calComClient';
import { normaliseBooking, normaliseEventType } from './calComShape';
import { CAL_API_KEY_ENV, CalComError, type CalBooking, type CalEventType } from './types';

export const MAX_ITEMS = 100;
export const DEFAULT_ITEMS = 20;

export type BookingStatusFilter = 'upcoming' | 'past' | 'cancelled' | 'all';

export type CalServerDeps = {
  /** Injected in tests; production builds one from env. */
  httpGet?: CalHttpGet;
  env?: NodeJS.ProcessEnv;
};

export type ListBookingsInput = {
  status?: BookingStatusFilter;
  attendeeEmail?: string;
  limit?: number;
  timeoutMs?: number;
};
export type GetBookingInput = { uid: string; timeoutMs?: number };
export type ListEventTypesInput = { limit?: number; timeoutMs?: number };
export type SlotsInput = { eventTypeId: number; start: string; end: string; timeZone?: string; timeoutMs?: number };
export type DraftBookingInput = {
  eventTypeId: number;
  start: string;
  attendeeName: string;
  attendeeEmail: string;
  timeZone?: string;
  notes?: string;
  timeoutMs?: number;
};

export const createCalComServer = (deps: CalServerDeps = {}) => {
  const config = readCalConfig(deps.env ?? process.env);
  const httpGet = deps.httpGet ?? createCalHttpGet(config);

  /** Reject early with a setup instruction rather than a bare 401 round-trip. */
  const requireKey = (): void => {
    if (config.apiKey.length > 0) return;
    throw new CalComError(
      `No Cal.com API key is configured. Set ${CAL_API_KEY_ENV} in the server settings ` +
        '(Settings -> MCP -> Cal.com Scheduling). Create a key at ' +
        'https://app.cal.com/settings/developer/api-keys.'
    );
  };

  const readSlots = async (input: SlotsInput): Promise<Record<string, unknown>> => {
    const query = new URLSearchParams({
      eventTypeId: String(input.eventTypeId),
      start: input.start,
      end: input.end,
    });
    if (input.timeZone) query.set('timeZone', input.timeZone);
    // `/v2/slots` is a PUBLIC route - it answers without a key, because booking
    // pages are public. No `requireKey()` here on purpose.
    return await calGet<Record<string, unknown>>(httpGet, 'slots', `/slots?${query}`, timeout(input.timeoutMs));
  };

  return {
    /** Who the configured key belongs to - the fastest way to verify setup. */
    async me({ timeoutMs }: { timeoutMs?: number } = {}) {
      requireKey();
      const data = await calGet<Record<string, unknown>>(httpGet, 'me', '/me', timeout(timeoutMs));
      return {
        id: data?.id ?? null,
        email: data?.email ?? null,
        username: data?.username ?? null,
        timeZone: data?.timeZone ?? null,
      };
    },

    /** Bookings on the connected account, newest scheduled first. */
    async listBookings({
      status = 'upcoming',
      attendeeEmail,
      limit = DEFAULT_ITEMS,
      timeoutMs,
    }: ListBookingsInput = {}): Promise<{ status: BookingStatusFilter; count: number; bookings: CalBooking[] }> {
      requireKey();
      const take = clampLimit(limit);
      const query = new URLSearchParams({ take: String(take) });
      if (status !== 'all') query.set('status', status);
      if (attendeeEmail) query.set('attendeeEmail', attendeeEmail);

      const data = await calGet<unknown>(httpGet, 'bookings', `/bookings?${query}`, timeout(timeoutMs));
      const bookings = toArray(data).map(normaliseBooking).slice(0, take);
      return { status, count: bookings.length, bookings };
    },

    /** One booking by its Cal.com uid. */
    async getBooking({ uid, timeoutMs }: GetBookingInput): Promise<CalBooking> {
      requireKey();
      if (!uid.trim()) throw new CalComError('A booking uid is required.');
      const data = await calGet<unknown>(
        httpGet,
        'bookings',
        `/bookings/${encodeURIComponent(uid.trim())}`,
        timeout(timeoutMs)
      );
      return normaliseBooking(data);
    },

    /** The bookable templates other people choose from. */
    async listEventTypes({ limit = DEFAULT_ITEMS, timeoutMs }: ListEventTypesInput = {}): Promise<{
      count: number;
      eventTypes: CalEventType[];
    }> {
      requireKey();
      const data = await calGet<unknown>(httpGet, 'eventTypes', '/event-types', timeout(timeoutMs));
      const eventTypes = toArray(data).map(normaliseEventType).slice(0, clampLimit(limit));
      return { count: eventTypes.length, eventTypes };
    },

    /** Free slots for one event type in a date range. Public route, no key. */
    async getAvailableSlots(input: SlotsInput): Promise<{ eventTypeId: number; days: number; slots: SlotDay[] }> {
      assertIsoish(input.start, 'start');
      assertIsoish(input.end, 'end');
      const data = await readSlots(input);
      const slots = Object.entries(data ?? {}).map(([day, times]) => ({
        day,
        times: toArray(times)
          .map((t) =>
            typeof t === 'object' && t !== null ? String((t as { start?: unknown }).start ?? '') : String(t)
          )
          .filter(Boolean),
      }));
      return { eventTypeId: input.eventTypeId, days: slots.length, slots };
    },

    /**
     * Compose a booking for a HUMAN to confirm. Reads only.
     *
     * The slot is verified against `/v2/slots` first, so the draft the user is
     * shown is one Cal.com would actually accept - the value a naive "here is a
     * link" answer cannot give. Nothing is written: the returned `bookingUrl`
     * is where the user clicks to make it real.
     */
    async draftBooking(input: DraftBookingInput): Promise<DraftBookingResult> {
      assertIsoish(input.start, 'start');
      if (!input.attendeeEmail.includes('@')) {
        throw new CalComError(`'${input.attendeeEmail}' is not an email address.`);
      }

      const dayStart = input.start.slice(0, 10);
      const available = await readSlots({
        eventTypeId: input.eventTypeId,
        start: `${dayStart}T00:00:00Z`,
        end: `${dayStart}T23:59:59Z`,
        timeZone: input.timeZone,
        timeoutMs: input.timeoutMs,
      });
      const offered = Object.values(available ?? {})
        .flatMap((times) => toArray(times))
        .map((t) => (typeof t === 'object' && t !== null ? String((t as { start?: unknown }).start ?? '') : String(t)))
        .filter(Boolean);
      const slotIsFree = offered.some((slot) => sameInstant(slot, input.start));

      return {
        confirmed: false,
        slotIsFree,
        draft: {
          eventTypeId: input.eventTypeId,
          start: input.start,
          timeZone: input.timeZone ?? null,
          attendee: { name: input.attendeeName, email: input.attendeeEmail },
          notes: input.notes ?? null,
        },
        alternativesOnThatDay: slotIsFree ? [] : offered.slice(0, 10),
        nextStep: slotIsFree
          ? 'NOT BOOKED YET. Show this draft to the user and give them the Cal.com link so THEY confirm it. ' +
            'This server cannot book, cancel or reschedule - by design, because a booking is another ' +
            "person's time."
          : 'That exact time is NOT offered by Cal.com. Show the user `alternativesOnThatDay` and ask ' +
            'which one they want before doing anything else.',
        bookingUrl: `https://cal.com/booking?eventTypeId=${input.eventTypeId}`,
      };
    },
  };
};

export type SlotDay = { day: string; times: string[] };

export type DraftBookingResult = {
  confirmed: false;
  slotIsFree: boolean;
  draft: {
    eventTypeId: number;
    start: string;
    timeZone: string | null;
    attendee: { name: string; email: string };
    notes: string | null;
  };
  alternativesOnThatDay: string[];
  nextStep: string;
  bookingUrl: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeout(value: number | undefined): number {
  return value ?? DEFAULT_TIMEOUT_MS;
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || DEFAULT_ITEMS, 1), MAX_ITEMS);
}

/** Cal.com sometimes nests the list under `data`; tolerate both shapes. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const nested = (value as { data?: unknown }).data;
    if (Array.isArray(nested)) return nested;
  }
  return value === null || value === undefined ? [] : [value];
}

function assertIsoish(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new CalComError(
      `'${value}' is not a parseable date for '${field}'. Use ISO 8601, e.g. 2026-08-05T09:00:00Z.`
    );
  }
}

function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}
