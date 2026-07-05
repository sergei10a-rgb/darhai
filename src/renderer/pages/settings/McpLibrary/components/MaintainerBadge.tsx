import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MaintainerType } from '../types';

// Untranslated fallbacks for the localized `mcpLibrary.maintainer.*` keys.
// The `wayland` maintainerType id is an internal catalog value - display only.
const fallbackLabels: Record<MaintainerType, string> = {
  official: 'Official',
  community: 'Community',
  wayland: 'Built by Darhai',
};

export function MaintainerBadge({ type }: { type: MaintainerType }) {
  const { t } = useTranslation();
  return (
    <span className={`mcp-maintainer-badge mcp-maintainer-${type}`}>
      {t(`mcpLibrary.maintainer.${type}`, { defaultValue: fallbackLabels[type] })}
    </span>
  );
}
