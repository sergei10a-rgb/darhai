/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Brain } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { wiki as wikiBridge } from '@/common/adapter/ipcBridge';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

/**
 * SiderMemoryEntry - top-zone nav entry for the IJFW Memory section.
 *
 * A plain nav row: clicking navigates to /memory (Archive). Wiki is reached
 * via the Archive/Wiki switcher inside the memory pages, so the sidebar stays
 * a single row. An orange 8px dot badge appears when wiki.orphanCandidates > 0.
 */
interface SiderMemoryEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick?: () => void;
}

const SiderMemoryEntry: React.FC<SiderMemoryEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const label = t('sider.memory');

  const [orphanCount, setOrphanCount] = useState(0);

  // Fetch orphan count on mount + subscribe to wiki state changes (Fix 12).
  // Uses wiki.getState to get orphanCandidates on cold load without waiting
  // for a stateChanged event.
  useEffect(() => {
    let cancelled = false;
    const fetchOrphans = async (): Promise<void> => {
      try {
        const state = await wikiBridge.getState.invoke(undefined);
        if (!cancelled && state) {
          setOrphanCount(state.orphanCandidates.length);
        }
      } catch {
        // Non-fatal
      }
    };
    void fetchOrphans();
    const unsub = wikiBridge.stateChanged.on((state) => {
      if (!cancelled) setOrphanCount(state.orphanCandidates.length);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={label} position='right'>
        <div
          className={classNames(
            'w-full h-40px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary relative',
            isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
          data-testid='sider-memory-entry'
        >
          <Brain size={20} className='block leading-none shrink-0' style={{ lineHeight: 0 }} />
          {orphanCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--orange, #FF7A45)',
              }}
              role='img'
              aria-label={t('sider.emergingConcepts', {
                count: orphanCount,
                defaultValue: '{{count}} emerging concepts',
              })}
            />
          )}
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <div
        className={classNames(
          'box-border h-40px w-full flex items-center justify-start gap-8px px-10px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-[rgba(var(--primary-6),0.12)] text-primary' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
        data-testid='sider-memory-entry'
      >
        <span className='w-28px h-28px flex items-center justify-center shrink-0 relative'>
          <Brain size={20} className='block leading-none' style={{ lineHeight: 0 }} />
          {orphanCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--orange, #FF7A45)',
              }}
              role='img'
              aria-label={t('sider.emergingConcepts', {
                count: orphanCount,
                defaultValue: '{{count}} emerging concepts',
              })}
            />
          )}
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-medium leading-24px'>{label}</span>
      </div>
    </Tooltip>
  );
};

export default SiderMemoryEntry;
