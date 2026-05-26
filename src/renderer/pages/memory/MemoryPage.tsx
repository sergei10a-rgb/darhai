/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 — Memory page shell + 6-state router.
 *
 * Subscribes to `ipcBridge.ijfw.onStatusChanged` and dispatches one of five
 * Wave-3 placeholder components based on {@link IjfwLifecycleStatus}.
 *
 * Notes on coexistence with Wave 2 (parallel branch):
 *   - This file only READS the `ipcBridge.ijfw` namespace. It does not add
 *     new keys, mutate the bridge module, or touch any file under
 *     `src/process/services/ijfw/` or the bridge wrappers.
 *   - `getStatus` may not be wired yet when this branch lands. The page
 *     calls it defensively: if it throws or resolves with no payload, the
 *     UI stays in its initial "querying" state until the first emit
 *     arrives. The emitter subscription is the load-bearing path.
 *
 * Wave 5 will replace the always-empty `installed_current` branch with a
 * real "has memories?" check.
 */

import React, { useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { IjfwStatusPayload } from '@/common/adapter/ipcBridge';
import InstallerPitchCardPlaceholder from './state-branches/InstallerPitchCard.placeholder';
import InstallingCardPlaceholder from './state-branches/InstallingCard.placeholder';
import InstallFailedCardPlaceholder from './state-branches/InstallFailedCard.placeholder';
import OnboardingEmptyStatePlaceholder from './state-branches/OnboardingEmptyState.placeholder';
import FullPanelShellPlaceholder from './state-branches/FullPanelShell.placeholder';
import styles from './MemoryPage.module.css';

const renderStateBranch = (status: IjfwStatusPayload | null): React.ReactElement => {
  if (!status) {
    return (
      <div className={styles.center} data-testid='memory-loading'>
        <p className='text-14px text-t-secondary m-0'>Checking IJFW status…</p>
      </div>
    );
  }
  switch (status.status) {
    case 'not_installed':
      return <InstallerPitchCardPlaceholder />;
    case 'installing':
      return <InstallingCardPlaceholder version={status.version} />;
    case 'upgrading':
      return <InstallingCardPlaceholder version={status.version} />;
    case 'installed_pending_activation':
      return <InstallingCardPlaceholder version={status.version} />;
    case 'install_failed':
      return <InstallFailedCardPlaceholder errorReason={status.errorReason} />;
    case 'installed_current':
      // Wave 3 placeholder: always treat as "no memories yet". Wave 5 will
      // check the active brain via useActiveBrainScope + brainInvoke and
      // route between OnboardingEmptyState and FullPanelShell.
      return <OnboardingEmptyStatePlaceholder />;
    default:
      // Exhaustiveness guard — keeps FullPanelShell reachable for the
      // typechecker and gives Wave 5 a fallback for unknown states.
      return <FullPanelShellPlaceholder />;
  }
};

const MemoryPage: React.FC = () => {
  const [status, setStatus] = useState<IjfwStatusPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Initial snapshot. Wave 2 owns the provider implementation; if it has
    // not landed in this branch yet, fall through to the emitter path.
    const getStatusProvider = ipcBridge.ijfw.getStatus;
    if (getStatusProvider && typeof getStatusProvider.invoke === 'function') {
      Promise.resolve(getStatusProvider.invoke())
        .then((payload) => {
          if (cancelled) return;
          if (payload && typeof payload === 'object') {
            setStatus(payload as IjfwStatusPayload);
          }
        })
        .catch(() => {
          // Provider may not be wired yet — wait for the next emit.
        });
    }

    const unsubscribe = ipcBridge.ijfw.onStatusChanged.on((payload) => {
      if (cancelled) return;
      setStatus(payload);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className={styles.page} data-testid='memory-page'>
      {renderStateBranch(status)}
    </div>
  );
};

export default MemoryPage;
