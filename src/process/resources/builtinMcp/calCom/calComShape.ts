/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Normalisers that flatten Cal.com's raw payloads into the stable shapes an
 * agent sees.
 *
 * Cal.com renames fields between API versions (`duration` vs `lengthInMinutes`,
 * `attendees[].timeZone` vs `.timezone`, `uid` vs `id`). Every rename that has
 * been observed is absorbed here, so a version bump upstream changes ONE file
 * instead of every tool description and every downstream prompt.
 *
 * Pure functions, no I/O - unit-testable against captured fixtures.
 */

import type { CalBooking, CalEventType } from './types';

export function normaliseBooking(raw: unknown): CalBooking {
  const b = asRecord(raw);
  const start = readString(b.start ?? b.startTime);
  const end = readString(b.end ?? b.endTime);
  return {
    uid: readString(b.uid ?? b.id) ?? '',
    title: readString(b.title ?? b.eventTitle) ?? '(untitled)',
    status: readString(b.status) ?? 'unknown',
    start,
    end,
    durationMinutes: readNumber(b.duration ?? b.lengthInMinutes) ?? minutesBetween(start, end),
    attendees: asArray(b.attendees).map((a) => {
      const at = asRecord(a);
      return {
        name: readString(at.name),
        email: readString(at.email),
        timeZone: readString(at.timeZone ?? at.timezone),
      };
    }),
    location: readString(b.location ?? b.meetingUrl),
    meetingUrl: readString(b.meetingUrl ?? b.videoCallUrl),
    eventTypeId: readNumber(b.eventTypeId ?? asRecord(b.eventType).id),
    cancelUrl: readString(b.cancelUrl ?? b.absentCancelUrl),
    rescheduleUrl: readString(b.rescheduleUrl),
  };
}

export function normaliseEventType(raw: unknown): CalEventType {
  const e = asRecord(raw);
  const slug = readString(e.slug) ?? '';
  const owner = readString(asRecord(e.owner).username ?? e.username);
  return {
    id: readNumber(e.id),
    title: readString(e.title) ?? slug ?? '(untitled)',
    slug,
    lengthMinutes: readNumber(e.lengthInMinutes ?? e.length),
    hidden: e.hidden === true,
    description: readString(e.description),
    bookingUrl: owner && slug ? `https://cal.com/${owner}/${slug}` : null,
  };
}

// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Derive a duration when the payload omits it but carries both timestamps. */
function minutesBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 60_000);
}
