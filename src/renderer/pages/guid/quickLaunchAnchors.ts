/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The 6 quick-launch anchors surfaced on the launchpad cold-start page.
 * Clicking a card: (1) sets the assistant as active preset via
 * useGuidAgentSelection.handleSelect - appears as PresetAgentTag in
 * the action row; (2) prefills the input with `prefill`; (3) fires
 * 'launchpad.card_clicked' telemetry for Phase 2 PredictiveEngine.
 *
 * Cowork is anchor #1 (place-anchor / Sutherland) - the universal
 * autonomous-execution button. Other 5 are recurring entrepreneur jobs.
 */

import i18n from '@/renderer/services/i18n';

export type QuickLaunchAnchorId =
  | 'cowork'
  | 'write-copy'
  | 'close-deal'
  | 'launch-it'
  | 'numbers'
  | 'quiet-money';

export type QuickLaunchAnchor = {
  id: QuickLaunchAnchorId;
  /** English source copy - the i18n fallback when a locale lacks the key. */
  label: string;
  sub: string;
  prefill: string;
  assistantId: string;
  lucideIcon: string;
};

/**
 * i18n key prefix for an anchor's user-facing strings.
 *
 * These six cards are the most prominent text on the home screen, and they
 * shipped as hardcoded English - a Mongolian user saw "Cowork / Write copy /
 * Close a deal" on an otherwise fully translated page. The English in
 * {@link QUICK_LAUNCH_ANCHORS} stays as the source copy AND the fallback, so
 * a missing translation degrades to English instead of an empty card.
 *
 * Keys: `guid.launchpad.anchors.<id>.{label,sub,prefill}`.
 */
export const anchorI18nKey = (id: QuickLaunchAnchorId, field: 'label' | 'sub' | 'prefill'): string =>
  `guid.launchpad.anchors.${id}.${field}`;

/**
 * Translate one anchor field, falling back to its English source copy.
 *
 * Uses the i18next instance directly (not the `useTranslation` hook) because
 * the catalog resolver is a plain function called from several components.
 */
export const translateAnchorField = (
  anchor: Pick<QuickLaunchAnchor, 'id' | 'label' | 'sub' | 'prefill'>,
  field: 'label' | 'sub' | 'prefill'
): string => {
  const fallback = anchor[field];
  const translated = i18n.t(anchorI18nKey(anchor.id, field), { defaultValue: fallback });
  return typeof translated === 'string' && translated.length > 0 ? translated : fallback;
};

export const QUICK_LAUNCH_ANCHORS: readonly QuickLaunchAnchor[] = [
  { id: 'cowork',      label: 'Cowork',       sub: 'Autonomous',         prefill: 'Cowork: ',                  assistantId: 'builtin-cowork',         lucideIcon: 'zap' },
  { id: 'write-copy',  label: 'Write copy',   sub: 'Email, ad, page',    prefill: 'Draft me ',                 assistantId: 'ext-copy',               lucideIcon: 'pen-line' },
  { id: 'close-deal',  label: 'Close a deal', sub: 'Outreach · follow',  prefill: 'Help me close ',            assistantId: 'ext-sales',              lucideIcon: 'handshake' },
  { id: 'launch-it',   label: 'Launch it',    sub: 'Product · promo',    prefill: 'Plan the launch for ',      assistantId: 'ext-product-launch',     lucideIcon: 'rocket' },
  { id: 'numbers',     label: 'Numbers',      sub: 'Runway · ROI',       prefill: 'Run the numbers on ',       assistantId: 'ext-coin',               lucideIcon: 'bar-chart-3' },
  { id: 'quiet-money', label: 'Quiet Money',  sub: 'Wealth coach',       prefill: 'Quiet Money - ',            assistantId: 'ext-quiet-money',        lucideIcon: 'landmark' },
] as const;
