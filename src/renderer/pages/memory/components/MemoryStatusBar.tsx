/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MemoryStatusBar - 28px bottom strip.
 *
 * Left: green pulse dot + "Brain live" + "N CLIs" + lastDream info.
 * Right: kbd hints ⌘K / J K / / / Esc (K9 fix).
 *
 * cliCount comes from IjfwStatusPayload.cliCount (no-deferment #3).
 * lastDream stats come from MemoryStats.factsExtracted / promoted count (no-deferment #4).
 */

import { formatShortcut } from '@/renderer/utils/ui/shortcutLabel';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import styles from './MemoryStatusBar.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LastDream = {
  factsExtracted: number;
  promoted: number;
  agoMs: number;
};

type DropFolderStatus = {
  path: string;
  watching: boolean;
  ingestedToday: number;
};

export type MemoryStatusBarProps = {
  brainLive: boolean;
  cliCount: number;
  lastDream?: LastDream;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Replace leading $HOME with `~` for display. */
function abbreviatePath(p: string): string {
  try {
    // In the renderer we don't have `os` - fall back to matching common home
    // path prefixes. The server returns an absolute path; we just tidy it up.
    const homePatterns = ['/Users/', '/home/'];
    for (const prefix of homePatterns) {
      const idx = p.indexOf(prefix);
      if (idx !== 0) continue;
      const afterHome = p.slice(prefix.length).indexOf('/');
      if (afterHome === -1) return '~';
      return '~' + p.slice(prefix.length + afterHome);
    }
  } catch {
    // ignore
  }
  return p;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MemoryStatusBar: React.FC<MemoryStatusBarProps> = ({ brainLive, cliCount, lastDream }) => {
  const { t } = useTranslation();
  const [dropStatus, setDropStatus] = useState<DropFolderStatus | null>(null);
  const [openPathError, setOpenPathError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = (): void => {
      ipcBridge.memory.import.getDropFolderStatus
        .invoke()
        .then((status) => {
          if (!cancelled) setDropStatus(status);
        })
        .catch(() => {
          // Non-critical - silently ignore
        });
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleOpenDropFolder = (): void => {
    if (!dropStatus) return;
    setOpenPathError(null);
    ipcBridge.shell.openPath
      .invoke({ path: dropStatus.path })
      .then((result) => {
        if (!result.ok && result.error) {
          setOpenPathError(result.error);
        }
      })
      .catch((err: unknown) => {
        setOpenPathError(String(err));
      });
  };

  return (
    <div className={styles.bar} role='status' data-testid='memory-status-bar'>
      {/* Left: status info */}
      <div className={styles.left}>
        <span className={styles.pill} data-testid='status-brain-pill'>
          <span className={`${styles.dot} ${brainLive ? styles.dotLive : styles.dotOffline}`} aria-hidden />
          <span>
            {brainLive
              ? t('memory.archive.status.brainLive', { defaultValue: 'Brain live' })
              : t('memory.archive.status.brainOffline', { defaultValue: 'Brain offline' })}
          </span>
        </span>

        {cliCount > 0 && (
          <>
            <span className={styles.sep} aria-hidden>
              ·
            </span>
            <span className={styles.pill} data-testid='status-cli-pill'>
              {cliCount} {t('memory.archive.status.clis', { defaultValue: 'CLIs' })}
            </span>
          </>
        )}

        {lastDream && (
          <>
            <span className={styles.sep} aria-hidden>
              ·
            </span>
            <span className={styles.pill} data-testid='status-dream-pill'>
              {t('memory.archive.status.lastDream', {
                ago: formatMs(lastDream.agoMs),
                facts: lastDream.factsExtracted,
                promoted: lastDream.promoted,
                defaultValue: 'Last dream {{ago}} · {{facts}} facts extracted · {{promoted}} candidates near threshold',
              })}
            </span>
          </>
        )}

        {dropStatus !== null && (
          <>
            <span className={styles.sep} aria-hidden>
              ·
            </span>
            <button
              type='button'
              className={styles.dropChip}
              data-testid='status-drop-folder-chip'
              title={
                openPathError
                  ? openPathError
                  : t('memory.archive.statusbar.dropFolder.open', { defaultValue: 'Open folder in Finder' })
              }
              onClick={handleOpenDropFolder}
            >
              <span
                className={`${styles.dot} ${dropStatus.watching ? styles.dotLive : styles.dotOffline}`}
                aria-hidden
              />
              <span aria-hidden>📁</span>
              <span className={styles.dropPath}>{abbreviatePath(dropStatus.path)}</span>
              {dropStatus.ingestedToday > 0 && (
                <span className={styles.dropBadge} data-testid='status-drop-badge'>
                  {t('memory.archive.statusbar.dropFolder.today', {
                    count: dropStatus.ingestedToday,
                    defaultValue_one: '{{count}} today',
                    defaultValue_other: '{{count}} today',
                  })}
                </span>
              )}
            </button>
          </>
        )}
      </div>

      {/* Right: kbd hints (K9) */}
      <div className={styles.right}>
        <span className={styles.kbd} data-testid='status-kbd-search'>
          {formatShortcut(['mod', 'K'])}
        </span>
        <span className={styles.kbdLabel}>{t('memory.archive.status.kbd.search', { defaultValue: 'search' })}</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-nav-j'>
          J
        </span>
        <span className={styles.kbd} data-testid='status-kbd-nav-k'>
          K
        </span>
        <span className={styles.kbdLabel}>{t('memory.archive.status.kbd.navigate', { defaultValue: 'navigate' })}</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-focus'>
          {formatShortcut(['mod', 'K'])}
        </span>
        <span className={styles.kbdLabel}>/</span>
        <span className={styles.kbdSep} aria-hidden>
          ·
        </span>
        <span className={styles.kbd} data-testid='status-kbd-close'>
          Esc
        </span>
        <span className={styles.kbdLabel}>{t('memory.archive.status.kbd.close', { defaultValue: 'close' })}</span>
      </div>
    </div>
  );
};

export default MemoryStatusBar;
