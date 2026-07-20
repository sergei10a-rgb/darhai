/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure, defensive normalizers shared by the triage service (LLM output ->
 * result) and the repository (DB row -> entry). Everything crossing these
 * boundaries is untrusted (a model can hallucinate a fake urgency or an
 * off-list tag; a DB row can be corrupt), so each helper clamps to a known-good
 * value with a safe fallback.
 */

import { EMAIL_TRIAGE_TAGS, type EmailTag, type EmailUrgency } from '@/common/types/emailTriage';

const URGENCY_VALUES: ReadonlySet<string> = new Set<EmailUrgency>(['critical', 'high', 'medium', 'low', 'none']);

const TAG_VALUES: ReadonlySet<string> = new Set<EmailTag>(EMAIL_TRIAGE_TAGS);

/** Max tags kept per email - the classify prompt asks for 1-2; cap defends against a flood. */
const MAX_TAGS = 3;

/** Clamp any value to a valid urgency, defaulting to `none`. */
export function normalizeUrgency(value: unknown): EmailUrgency {
  return typeof value === 'string' && URGENCY_VALUES.has(value) ? (value as EmailUrgency) : 'none';
}

/**
 * Allow-list an array of tag candidates: keep only known tags, de-duplicate,
 * and cap the count. A non-array (or a corrupt element) degrades to `[]`.
 */
export function normalizeTags(value: unknown): EmailTag[] {
  if (!Array.isArray(value)) return [];
  const out: EmailTag[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (TAG_VALUES.has(tag) && !out.includes(tag as EmailTag)) {
      out.push(tag as EmailTag);
      if (out.length >= MAX_TAGS) break;
    }
  }
  return out;
}

/** Parse the JSON `tags` column defensively - a corrupt value degrades to `[]`. */
export function parseTagsJson(value: string | null): EmailTag[] {
  if (!value) return [];
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}
