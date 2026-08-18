/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ImportDrawer - 480px push-content right drawer surfacing 4 import sources.
 *
 * Width transitions 0→480 over 0.22s via CSS (push-content, NOT overlay).
 *
 * Sources:
 *   1. claude-mem   - imports from Claude Code memory + claude-mem DB
 *   2. Obsidian     - auto-detects vaults (obsidian.json + ~/Documents), user
 *                     picks one and imports; a folder picker covers vaults the
 *                     detection cannot see. Import streams a progress counter.
 *   3. ~/dev scan   - scans dev directory for IJFW memory dirs
 *   4. Drop folder  - ~/Documents/Darhai-Memory/ watcher + one-shot process
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Message } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import styles from './ImportDrawer.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImportDrawerProps = {
  open: boolean;
  onClose: () => void;
};

type ImportStatus = 'idle' | 'checking' | 'ready' | 'unavailable' | 'importing';

type VaultEntry = {
  path: string;
  mdCount: number;
};

type ImportProgress = {
  done: number;
  total: number;
};

/** Bytes → human-readable megabytes for the vault preview message. */
function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImportDrawer({ open, onClose }: ImportDrawerProps): React.ReactElement | null {
  const { t } = useTranslation();

  // ── claude-mem state ────────────────────────────────────────────────────
  const [claudeMemStatus, setClaudeMemStatus] = useState<ImportStatus>('idle');
  const [claudeMemCount, setClaudeMemCount] = useState<number | null>(null);

  // ── obsidian state ──────────────────────────────────────────────────────
  const [obsidianStatus, setObsidianStatus] = useState<ImportStatus>('idle');
  const [obsidianVaults, setObsidianVaults] = useState<VaultEntry[]>([]);
  const [selectedVault, setSelectedVault] = useState<string | null>(null);
  const [obsidianCount, setObsidianCount] = useState<number | null>(null);
  const [obsidianProgress, setObsidianProgress] = useState<ImportProgress | null>(null);

  // ── dev scan state ──────────────────────────────────────────────────────
  const [devStatus, setDevStatus] = useState<ImportStatus>('idle');
  const [devCount, setDevCount] = useState<number | null>(null);

  // ── drop folder state ───────────────────────────────────────────────────
  const [dropStatus, setDropStatus] = useState<ImportStatus>('idle');
  const [dropCount, setDropCount] = useState<number | null>(null);

  const DROP_FOLDER_PATH = '~/Documents/Darhai-Memory/';

  // Track mount to avoid setState after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Esc closes drawer
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Bumped on every open. An in-flight scan/import captures the current epoch
  // and bails on resolve if it changed — the drawer only hides its body on
  // close (never unmounts), so mountedRef alone can't catch a close→reopen
  // that would let a stale async write clobber the fresh reset or pop a late toast.
  const obsidianEpochRef = useRef(0);

  // Guard an async result against a close→reopen (stale epoch) or unmount.
  const obsidianLive = useCallback(
    (epoch: number): boolean => mountedRef.current && obsidianEpochRef.current === epoch,
    []
  );

  // Detect vaults (obsidian.json + ~/Documents scan) and populate the list.
  // A single hit auto-selects; multiple require an explicit pick. `announce`
  // controls whether an empty result surfaces a toast (manual re-scan) or
  // stays silent (auto-detect on open).
  const runObsidianScan = useCallback(
    async (announce: boolean) => {
      const epoch = obsidianEpochRef.current;
      setObsidianStatus('checking');
      try {
        const res = await ipcBridge.memory.import.obsidianDetectVaults.invoke();
        if (!obsidianLive(epoch)) return;
        const vaults = res.vaults ?? [];
        setObsidianVaults(vaults);
        setSelectedVault(vaults.length === 1 ? vaults[0].path : null);
        setObsidianStatus('idle');
        if (vaults.length === 0 && announce) {
          Message.info(
            t('memory.archive.import.obsidian.noVaults', {
              defaultValue: 'No Obsidian vaults found — use “Choose folder…”',
            })
          );
        }
      } catch {
        if (!obsidianLive(epoch)) return;
        setObsidianStatus('idle');
        setObsidianVaults([]);
        if (announce) {
          Message.error(
            t('memory.archive.import.obsidian.scanError', { defaultValue: 'Vault scan failed. Try again.' })
          );
        }
      }
    },
    [t, obsidianLive]
  );

  // Latest-ref for the scan so the on-open effect depends on `open` alone:
  // `runObsidianScan` re-materialises whenever `t` does, and re-running the
  // reset effect on that identity change would loop (epoch bump → state reset
  // → render → new callback → effect again).
  const runObsidianScanRef = useRef(runObsidianScan);
  useEffect(() => {
    runObsidianScanRef.current = runObsidianScan;
  }, [runObsidianScan]);

  // On open: bump the epoch, reset the card and auto-detect silently.
  useEffect(() => {
    if (!open) return;
    obsidianEpochRef.current += 1;
    setObsidianStatus('idle');
    setObsidianVaults([]);
    setSelectedVault(null);
    setObsidianCount(null);
    setObsidianProgress(null);
    void runObsidianScanRef.current(false);
  }, [open]);

  // While open, stream the main-process import progress counter.
  useEffect(() => {
    if (!open) return;
    const off = ipcBridge.memory.import.obsidianProgress.on((p) => {
      if (!mountedRef.current) return;
      setObsidianProgress(p);
    });
    return off;
  }, [open]);

  // ── claude-mem import ────────────────────────────────────────────────────
  const handleClaudeMemImport = useCallback(async () => {
    setClaudeMemStatus('importing');
    try {
      const result = await ipcBridge.memory.import.claudeMem.invoke();
      if (!mountedRef.current) return;
      setClaudeMemStatus('ready');
      setClaudeMemCount(result.count);
      Message.success(
        t('memory.archive.import.claudeMem.success', {
          count: result.count,
          errors: result.errors.length,
          defaultValue: 'Imported {{count}} entries · {{errors}} errors',
        })
      );
      // Fire refresh event for any listening list components
      window.dispatchEvent(new CustomEvent('wayland:memory:imported'));
    } catch {
      if (!mountedRef.current) return;
      setClaudeMemStatus('idle');
      Message.error(t('memory.archive.import.claudeMem.error', { defaultValue: 'Import failed. Try again.' }));
    }
  }, [t]);

  // ── obsidian import (shared by the selected-vault button and the picker) ──
  const runObsidianImportPath = useCallback(
    async (vaultPath: string) => {
      const epoch = obsidianEpochRef.current;
      setObsidianStatus('importing');
      setObsidianProgress(null);
      try {
        const result = await ipcBridge.memory.import.obsidianVault.invoke({ vaultPath });
        if (!obsidianLive(epoch)) return;
        setObsidianStatus('ready');
        setObsidianCount(result.count);
        setObsidianProgress(null);
        if (result.capped && result.total) {
          Message.info(
            t('memory.archive.import.obsidian.capped', {
              count: result.count,
              total: result.total,
              defaultValue_one: 'Imported the {{count}} most recent note of {{total}}',
              defaultValue_other: 'Imported the {{count}} most recent of {{total}} notes',
            })
          );
        } else {
          Message.success(
            t('memory.archive.import.obsidian.success', {
              count: result.count,
              errors: result.errors.length,
              defaultValue: 'Imported {{count}} entries · {{errors}} errors',
            })
          );
        }
        window.dispatchEvent(new CustomEvent('wayland:memory:imported'));
      } catch {
        if (!obsidianLive(epoch)) return;
        setObsidianStatus('idle');
        setObsidianProgress(null);
        Message.error(
          t('memory.archive.import.obsidian.error', { defaultValue: 'Obsidian import failed. Try again.' })
        );
      }
    },
    [t, obsidianLive]
  );

  const handleObsidianImport = useCallback(() => {
    if (!selectedVault) return;
    void runObsidianImportPath(selectedVault);
  }, [selectedVault, runObsidianImportPath]);

  // Folder-picker fallback for vaults the detection cannot see (a
  // OneDrive-redirected Documents on Windows, Desktop, a repo). The picked
  // directory is previewed (note count + size) and added to the list as the
  // selection; the import itself stays behind the explicit Import press. The
  // main-process handler re-validates the path (home dir or configured vault).
  const handleObsidianChooseFolder = useCallback(async () => {
    const epoch = obsidianEpochRef.current;
    let picked: string[] | undefined;
    try {
      picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
    } catch {
      picked = undefined;
    }
    if (!obsidianLive(epoch)) return;
    const dir = picked?.[0];
    if (!dir) return;
    setObsidianStatus('checking');
    try {
      const preview = await ipcBridge.memory.import.obsidianPreview.invoke({ vaultPath: dir });
      if (!obsidianLive(epoch)) return;
      setObsidianStatus('idle');
      if (!preview.ok) {
        Message.error(t('memory.archive.import.obsidian.scanError', { defaultValue: 'Vault scan failed. Try again.' }));
        return;
      }
      setObsidianVaults((prev) => [{ path: dir, mdCount: preview.mdCount }, ...prev.filter((v) => v.path !== dir)]);
      setSelectedVault(dir);
      Message.info(
        t('memory.archive.import.obsidian.previewInfo', {
          count: preview.mdCount,
          size: formatMb(preview.totalBytes),
          defaultValue_one: '{{count}} note · {{size}} — press Import to confirm',
          defaultValue_other: '{{count}} notes · {{size}} — press Import to confirm',
        })
      );
    } catch {
      if (!obsidianLive(epoch)) return;
      setObsidianStatus('idle');
      Message.error(t('memory.archive.import.obsidian.scanError', { defaultValue: 'Vault scan failed. Try again.' }));
    }
  }, [t, obsidianLive]);

  // ── dev scan import ──────────────────────────────────────────────────────
  const handleDevScanImport = useCallback(async () => {
    setDevStatus('importing');
    try {
      const result = await ipcBridge.memory.import.scanDevDir.invoke();
      if (!mountedRef.current) return;
      setDevStatus('ready');
      setDevCount(result.count);
      Message.success(
        t('memory.archive.import.devScan.success', {
          count: result.count,
          projects: result.projectsFound ?? 0,
          defaultValue: 'Imported {{count}} entries from {{projects}} projects',
        })
      );
      window.dispatchEvent(new CustomEvent('wayland:memory:imported'));
    } catch {
      if (!mountedRef.current) return;
      setDevStatus('idle');
      Message.error(t('memory.archive.import.devScan.error', { defaultValue: 'Dev scan import failed. Try again.' }));
    }
  }, [t]);

  // ── drop folder ──────────────────────────────────────────────────────────
  const handleOpenFolder = useCallback(() => {
    // ipcBridge.shell.openExternal takes a string arg - use it for folder paths too
    void ipcBridge.shell.openExternal.invoke(DROP_FOLDER_PATH).catch(() => {
      // Best-effort; if it fails, fall back silently.
    });
  }, []);

  const handleProcessDropFolder = useCallback(async () => {
    setDropStatus('importing');
    try {
      const result = await ipcBridge.memory.import.processDropFolder.invoke();
      if (!mountedRef.current) return;
      setDropStatus('ready');
      setDropCount(result.count);
      Message.success(
        t('memory.archive.import.dropFolder.success', {
          count: result.count,
          errors: result.errors.length,
          defaultValue: 'Processed {{count}} files · {{errors}} errors',
        })
      );
      window.dispatchEvent(new CustomEvent('wayland:memory:imported'));
    } catch {
      if (!mountedRef.current) return;
      setDropStatus('idle');
      Message.error(t('memory.archive.import.dropFolder.error', { defaultValue: 'Processing failed. Try again.' }));
    }
  }, [t]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  function statusPillClass(status: ImportStatus): string {
    if (status === 'ready') return `${styles.statusPill} ${styles.pillReady}`;
    if (status === 'checking' || status === 'importing') return `${styles.statusPill} ${styles.pillChecking}`;
    if (status === 'unavailable') return `${styles.statusPill} ${styles.pillUnavailable}`;
    return `${styles.statusPill} ${styles.pillChecking}`;
  }

  function statusPillLabel(status: ImportStatus): string {
    switch (status) {
      case 'ready':
        return t('memory.archive.import.status.ready', { defaultValue: 'ready' });
      case 'checking':
        return t('memory.archive.import.status.checking', { defaultValue: 'checking' });
      case 'importing':
        return t('memory.archive.import.status.importing', { defaultValue: 'importing' });
      case 'unavailable':
        return t('memory.archive.import.status.unavailable', { defaultValue: 'unavailable' });
      default:
        return t('memory.archive.import.status.idle', { defaultValue: 'idle' });
    }
  }

  /** Subline of the Obsidian card: progress > result count > hint. */
  function obsidianSubline(): string {
    if (obsidianStatus === 'importing' && obsidianProgress) {
      return t('memory.archive.import.obsidian.progress', {
        done: obsidianProgress.done,
        total: obsidianProgress.total,
        defaultValue: 'Importing… {{done}} / {{total}}',
      });
    }
    if (obsidianCount !== null) {
      return t('memory.archive.import.obsidian.count', {
        count: obsidianCount,
        defaultValue: '~{{count}} entries imported',
      });
    }
    return t('memory.archive.import.obsidian.hint', { defaultValue: 'Click to scan for vaults' });
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className={`${styles.drawer}${open ? ` ${styles.drawerOpen}` : ''}`}
      data-testid='import-drawer'
      aria-hidden={!open}
    >
      {open && (
        <div className={styles.inner} data-testid='import-drawer-inner'>
          {/* Header */}
          <div className={styles.header}>
            <h2 className={styles.title} data-testid='import-drawer-title'>
              {t('memory.archive.import.title', { defaultValue: 'Import memories' })}
            </h2>
            <Button
              className={styles.closeBtn}
              shape='circle'
              size='mini'
              type='secondary'
              icon={<Close theme='outline' size='12' />}
              onClick={onClose}
              aria-label={t('memory.archive.import.close', { defaultValue: 'Close import drawer' })}
              data-testid='import-drawer-close-btn'
            />
          </div>

          {/* Body - 4 source cards */}
          <div className={styles.body} data-testid='import-drawer-body'>
            {/* Card 1 - claude-mem */}
            <div className={styles.card} data-testid='import-card-claudemem'>
              <div className={styles.cardTopRow}>
                <div className={styles.iconTile} aria-hidden>
                  🧠
                </div>
                <span className={styles.cardTitle}>
                  {t('memory.archive.import.claudeMem.title', { defaultValue: 'Claude' })}
                </span>
                {claudeMemStatus !== 'idle' && (
                  <span className={statusPillClass(claudeMemStatus)} data-testid='import-pill-claudemem'>
                    {statusPillLabel(claudeMemStatus)}
                  </span>
                )}
              </div>
              <p className={styles.subline} data-testid='import-subline-claudemem'>
                {claudeMemCount !== null
                  ? t('memory.archive.import.claudeMem.count', {
                      count: claudeMemCount,
                      defaultValue: '~{{count}} entries imported',
                    })
                  : t('memory.archive.import.claudeMem.hint', {
                      defaultValue: 'Import from Claude Code memory (~/.claude/projects) and claude-mem',
                    })}
              </p>
              <Button
                type='primary'
                long
                loading={claudeMemStatus === 'importing'}
                disabled={claudeMemStatus === 'importing'}
                onClick={() => {
                  void handleClaudeMemImport();
                }}
                data-testid='import-btn-claudemem'
              >
                {claudeMemStatus === 'importing'
                  ? t('memory.archive.import.importing', { defaultValue: 'Importing…' })
                  : t('memory.archive.import.claudeMem.btn', { defaultValue: 'Import' })}
              </Button>
            </div>

            {/* Card 2 - Obsidian vault */}
            <div className={styles.card} data-testid='import-card-obsidian'>
              <div className={styles.cardTopRow}>
                <div className={styles.iconTile} aria-hidden>
                  📓
                </div>
                <span className={styles.cardTitle}>
                  {t('memory.archive.import.obsidian.title', { defaultValue: 'Obsidian vault' })}
                </span>
                {obsidianStatus !== 'idle' && (
                  <span className={statusPillClass(obsidianStatus)} data-testid='import-pill-obsidian'>
                    {statusPillLabel(obsidianStatus)}
                  </span>
                )}
              </div>
              <p className={styles.subline} data-testid='import-subline-obsidian'>
                {obsidianSubline()}
              </p>

              {/* Vault list (auto-detected on open, or added via the folder picker) */}
              {obsidianVaults.length > 0 && (
                <div className={styles.vaultList} data-testid='import-vault-list'>
                  {obsidianVaults.map((v) => (
                    <div
                      key={v.path}
                      className={`${styles.vaultRow}${selectedVault === v.path ? ` ${styles.vaultRowSelected}` : ''}`}
                      role='button'
                      tabIndex={0}
                      onClick={() => setSelectedVault(v.path)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedVault(v.path);
                        }
                      }}
                      data-testid='import-vault-row'
                    >
                      <input
                        type='radio'
                        className={styles.vaultRadio}
                        checked={selectedVault === v.path}
                        onChange={() => setSelectedVault(v.path)}
                        aria-label={v.path}
                        readOnly
                      />
                      <span className={styles.vaultPath}>{v.path}</span>
                      <span className={styles.vaultMdCount}>{v.mdCount} .md</span>
                    </div>
                  ))}
                </div>
              )}

              <Button
                type='primary'
                long
                loading={obsidianStatus === 'importing' || obsidianStatus === 'checking'}
                disabled={
                  obsidianStatus === 'importing' ||
                  obsidianStatus === 'checking' ||
                  (obsidianVaults.length > 0 && !selectedVault)
                }
                onClick={() => {
                  // No vaults known → (re)scan; once a vault is selected → import.
                  if (obsidianVaults.length > 0) {
                    handleObsidianImport();
                  } else {
                    void runObsidianScan(true);
                  }
                }}
                data-testid='import-btn-obsidian'
              >
                {obsidianStatus === 'importing'
                  ? t('memory.archive.import.importing', { defaultValue: 'Importing…' })
                  : obsidianVaults.length > 0
                    ? t('memory.archive.import.obsidian.btn', { defaultValue: 'Import' })
                    : t('memory.archive.import.obsidian.scanBtn', { defaultValue: 'Scan for vaults' })}
              </Button>

              {/* Fallback for vaults the detection cannot see (Windows/OneDrive, etc.) */}
              <Button
                type='text'
                long
                disabled={obsidianStatus === 'importing' || obsidianStatus === 'checking'}
                onClick={() => {
                  void handleObsidianChooseFolder();
                }}
                data-testid='import-btn-obsidian-choose'
              >
                {t('memory.archive.import.obsidian.chooseFolderBtn', { defaultValue: 'Choose folder…' })}
              </Button>
            </div>

            {/* Card 3 - ~/dev scan */}
            <div className={styles.card} data-testid='import-card-devscan'>
              <div className={styles.cardTopRow}>
                <div className={styles.iconTile} aria-hidden>
                  📁
                </div>
                <span className={styles.cardTitle}>
                  {t('memory.archive.import.devScan.title', { defaultValue: 'Dev projects' })}
                </span>
                {devStatus !== 'idle' && (
                  <span className={statusPillClass(devStatus)} data-testid='import-pill-devscan'>
                    {statusPillLabel(devStatus)}
                  </span>
                )}
              </div>
              <p className={styles.subline} data-testid='import-subline-devscan'>
                {devCount !== null
                  ? t('memory.archive.import.devScan.count', {
                      count: devCount,
                      defaultValue: '~{{count}} entries imported',
                    })
                  : t('memory.archive.import.devScan.hint', {
                      defaultValue: 'Scans common dev folders for IJFW projects',
                    })}
              </p>
              <Button
                type='primary'
                long
                loading={devStatus === 'importing'}
                disabled={devStatus === 'importing'}
                onClick={() => {
                  void handleDevScanImport();
                }}
                data-testid='import-btn-devscan'
              >
                {devStatus === 'importing'
                  ? t('memory.archive.import.importing', { defaultValue: 'Importing…' })
                  : t('memory.archive.import.devScan.btn', { defaultValue: 'Import' })}
              </Button>
            </div>

            {/* Card 4 - Drop folder */}
            <div className={styles.card} data-testid='import-card-dropfolder'>
              <div className={styles.cardTopRow}>
                <div className={styles.iconTile} aria-hidden>
                  📥
                </div>
                <span className={styles.cardTitle}>
                  {t('memory.archive.import.dropFolder.title', { defaultValue: 'Drop folder' })}
                </span>
                {dropStatus !== 'idle' && (
                  <span className={statusPillClass(dropStatus)} data-testid='import-pill-dropfolder'>
                    {statusPillLabel(dropStatus)}
                  </span>
                )}
              </div>
              <p className={styles.subline} data-testid='import-subline-dropfolder'>
                {dropCount !== null
                  ? t('memory.archive.import.dropFolder.count', {
                      count: dropCount,
                      defaultValue: '{{count}} files processed',
                    })
                  : t('memory.archive.import.dropFolder.hint', {
                      defaultValue: `Drop .md / .txt / .json files into ${DROP_FOLDER_PATH}`,
                    })}
              </p>
              <p className={styles.dropPath} data-testid='import-dropfolder-path'>
                {DROP_FOLDER_PATH}
              </p>
              <div className={styles.cardBottomRow}>
                <Button type='secondary' long onClick={handleOpenFolder} data-testid='import-btn-openfolder'>
                  {t('memory.archive.import.dropFolder.openBtn', { defaultValue: 'Open folder' })}
                </Button>
                <Button
                  type='primary'
                  loading={dropStatus === 'importing'}
                  disabled={dropStatus === 'importing'}
                  onClick={() => {
                    void handleProcessDropFolder();
                  }}
                  data-testid='import-btn-dropfolder'
                >
                  {dropStatus === 'importing'
                    ? t('memory.archive.import.importing', { defaultValue: 'Importing…' })
                    : t('memory.archive.import.dropFolder.processBtn', { defaultValue: 'Process now' })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ImportDrawer;
