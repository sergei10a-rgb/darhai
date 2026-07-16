/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChevronDown, ChevronRight, LayoutGrid } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

const EXPANDED_LS_KEY = 'wayland.sidebar.tools.expanded';

/**
 * SiderToolsGroup - collapsible top-zone group for secondary nav entries
 * (assistants, workflows, scheduled, teams, mission control, model advisor).
 *
 * Purely presentational: the entries themselves are passed as children so all
 * navigation handlers stay in Sider/index.tsx. Expand/collapse state persists
 * to localStorage (same pattern as SiderMemoryEntry). Defaults to collapsed
 * unless a child route is active on first mount, and shows the active tint on
 * the header while collapsed so the current location stays visible.
 */
interface SiderToolsGroupProps {
  isMobile: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  /** True when the current route belongs to one of the grouped entries. */
  isChildActive: boolean;
  children: React.ReactNode;
}

const SiderToolsGroup: React.FC<SiderToolsGroupProps> = ({
  isMobile,
  collapsed,
  siderTooltipProps,
  isChildActive,
  children,
}) => {
  const { t } = useTranslation();
  const label = t('sider.tools', { defaultValue: 'Tools' });

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(EXPANDED_LS_KEY);
      if (stored !== null) return stored === 'true';
    } catch {
      // Ignore
    }
    // Default expanded when the user is already on a grouped route.
    return isChildActive;
  });

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(EXPANDED_LS_KEY, String(next));
      } catch {
        // Ignore
      }
      return next;
    });
  }, []);

  // Keyboard support mirrors SiderAccordionShell: Enter/Space toggles, so the
  // aria-expanded state sits on a focusable button-role element.
  const handleHeaderKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleExpanded();
      }
    },
    [toggleExpanded]
  );

  const headerActive = isChildActive && !expanded;

  if (collapsed) {
    return (
      <div className='flex flex-col gap-2px' data-testid='sider-tools-group'>
        <Tooltip {...siderTooltipProps} content={label} position='right'>
          <div
            className={classNames(
              'w-full h-40px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary',
              headerActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
            )}
            onClick={toggleExpanded}
            onKeyDown={handleHeaderKeyDown}
            role='button'
            tabIndex={0}
            data-testid='sider-tools-header'
            aria-expanded={expanded}
            aria-label={label}
          >
            <LayoutGrid size={20} className='block leading-none shrink-0' style={{ lineHeight: 0 }} />
          </div>
        </Tooltip>
        {expanded && children}
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-2px' data-testid='sider-tools-group'>
      <div
        className={classNames(
          'box-border h-40px w-full flex items-center justify-start gap-8px px-10px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          headerActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={toggleExpanded}
        onKeyDown={handleHeaderKeyDown}
        role='button'
        tabIndex={0}
        data-testid='sider-tools-header'
        aria-expanded={expanded}
      >
        <span className='w-28px h-28px flex items-center justify-center shrink-0'>
          <LayoutGrid size={20} className='block leading-none' style={{ lineHeight: 0 }} />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-medium leading-24px flex-1'>{label}</span>
        <span className='collapsed-hidden text-t-3 flex items-center'>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </div>
      {expanded && <div className='flex flex-col gap-2px pl-8px'>{children}</div>}
    </div>
  );
};

export default SiderToolsGroup;
