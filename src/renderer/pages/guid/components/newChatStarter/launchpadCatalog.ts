/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Zap,
  PenLine,
  Handshake,
  Rocket,
  BarChart3,
  Landmark,
  Bot,
  type LucideIcon,
} from 'lucide-react';
import type { PaletteKey } from '@/renderer/pages/guid/components/AssistantIconTile';
import { categoryToPaletteKey } from '@/renderer/pages/guid/components/AssistantIconTile';
import { QUICK_LAUNCH_ANCHORS } from '@/renderer/pages/guid/quickLaunchAnchors';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';
import { ASSISTANT_PRESETS } from '@/common/config/presets/assistantPresets';

/**
 * Visual + click payload for one launchpad bar entry. The bar holds an
 * ordered array of these. Renderer maps each to a button card; click
 * runs through GuidPage.handleQuickLaunchAnchor (which expects the
 * shape used by QuickLaunchAnchor — id, label, prefill, assistantId).
 */
export type LaunchpadBarEntry = {
  /** Stable runtime id used by the bar order array and dnd-kit sortable key. */
  id: string;
  /** assistantId passed to selectPresetAssistant — same field as QuickLaunchAnchor.assistantId. */
  assistantId: string;
  /** Display label for the card body. */
  label: string;
  /** Sub-label for the card body (one line). */
  sub: string;
  /** Lucide icon component. Pre-resolved here so the renderer stays dumb. */
  Icon: LucideIcon;
  /** Tile palette key — feeds AssistantIconTile color. */
  palette: PaletteKey | undefined;
  /** Avatar string from the source (lucide:Foo / emoji / image path). Optional. */
  avatar?: string;
  /** Source flag — bars rendered from the default-shipped anchors render the cowork halo. */
  isAnchor: boolean;
  /** Prefill text appended to the input when card is clicked. Defaults to empty for non-anchor picks. */
  prefill?: string;
};

const LUCIDE_ICON_MAP: Record<string, LucideIcon> = {
  'zap': Zap,
  'pen-line': PenLine,
  'handshake': Handshake,
  'rocket': Rocket,
  'bar-chart-3': BarChart3,
  'landmark': Landmark,
};

const stripPrefix = (id: string): string =>
  id.startsWith('builtin-') ? id.slice('builtin-'.length) : id;

/**
 * Resolve a raw assistant id (as stored in bar order) into the shape the
 * bar renderer needs. Resolution order:
 *
 *   1. QUICK_LAUNCH_ANCHORS — the 6 originally-shipped defaults. These
 *      come pre-loaded with label/sub/icon/palette/prefill so the bar
 *      looks identical to v0.5.0 on first launch.
 *   2. `assistants[]` — the full assistant catalogue (built-in + extension)
 *      passed in by the renderer. Avatar / category / nameI18n drive
 *      label and icon.
 *   3. ASSISTANT_PRESETS — fallback for ids that don't appear in (2)
 *      yet (e.g. before useAssistantList finishes loading).
 *
 * Returns null when nothing matches — the renderer silently skips. We
 * deliberately do NOT prune unknown IDs from the persisted order; an
 * extension reinstall should restore its card to the same slot.
 */
export function resolveBarEntry(
  rawId: string,
  assistants: AssistantListItem[],
  localeKey: string
): LaunchpadBarEntry | null {
  // 1. Default anchors — preserve their hand-tuned copy.
  const anchor = QUICK_LAUNCH_ANCHORS.find((a) => a.assistantId === rawId);
  if (anchor) {
    return {
      id: rawId,
      assistantId: rawId,
      label: anchor.label,
      sub: anchor.sub,
      Icon: LUCIDE_ICON_MAP[anchor.lucideIcon] ?? Zap,
      palette: anchorPalette(anchor.id),
      isAnchor: true,
      prefill: anchor.prefill,
    };
  }

  // 2. Live catalogue.
  const bareId = stripPrefix(rawId);
  const fromCatalogue = assistants.find((a) => a.id === rawId || a.id === bareId);
  if (fromCatalogue) {
    return entryFromAssistant(rawId, fromCatalogue, localeKey);
  }

  // 3. Preset catalogue (covers built-ins before useAssistantList resolves).
  const preset = ASSISTANT_PRESETS.find((p) => p.id === bareId);
  if (preset) {
    const label = preset.nameI18n[localeKey] || preset.nameI18n['en-US'] || preset.id;
    const description = preset.descriptionI18n?.[localeKey] || preset.descriptionI18n?.['en-US'] || '';
    return {
      id: rawId,
      assistantId: rawId,
      label,
      sub: truncate(description, 28),
      Icon: Bot,
      palette: categoryToPaletteKey(preset.category),
      avatar: preset.avatar,
      isAnchor: false,
    };
  }

  return null;
}

function entryFromAssistant(rawId: string, a: AssistantListItem, localeKey: string): LaunchpadBarEntry {
  const label = a.nameI18n?.[localeKey] || a.nameI18n?.['en-US'] || a.name || a.id;
  const description = a.descriptionI18n?.[localeKey] || a.descriptionI18n?.['en-US'] || a.description || '';
  // Extension assistants carry their category on the raw record; for the renderer
  // we only have the resolved AssistantListItem so fall back to a heuristic on id.
  const palette = categoryToPaletteKey(a._kind) ?? heuristicPaletteFromId(a.id);
  return {
    id: rawId,
    assistantId: rawId,
    label,
    sub: truncate(description, 28),
    Icon: Bot,
    palette,
    avatar: a.avatar,
    isAnchor: false,
  };
}

function anchorPalette(anchorId: string): PaletteKey {
  switch (anchorId) {
    case 'cowork':
      return 'cowork';
    case 'write-copy':
      return 'write';
    case 'close-deal':
      return 'sales';
    case 'launch-it':
      return 'launch';
    case 'numbers':
    case 'quiet-money':
      return 'finance';
    default:
      return 'cowork';
  }
}

function heuristicPaletteFromId(id: string): PaletteKey | undefined {
  const lower = id.toLowerCase();
  if (lower.includes('copy') || lower.includes('write')) return 'write';
  if (lower.includes('sales') || lower.includes('sell')) return 'sales';
  if (lower.includes('launch')) return 'launch';
  if (lower.includes('research')) return 'research';
  if (lower.includes('coin') || lower.includes('money') || lower.includes('wealth')) return 'finance';
  if (lower.includes('dev') || lower.includes('engineer')) return 'dev';
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
