/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 placeholder for {@link FullPanelShell}. Wave 4 replaces this with
 * the real memory browser shell (left nav, list, detail pane). Props
 * signature matches the planned real component (none for this branch —
 * Wave 5 wires the active brain scope from {@link useActiveBrainScope}).
 */
import React from 'react';

const FullPanelShellPlaceholder: React.FC = () => {
  return (
    <div
      className='flex flex-col items-center justify-center gap-8px p-24px rd-12px bg-fill-2 border border-solid border-[var(--color-border-2)]'
      data-testid='memory-full-panel-placeholder'
    >
      <h2 className='text-16px font-semibold text-t-primary m-0'>FullPanelShell</h2>
      <p className='text-14px text-t-secondary m-0'>Wave 4 will replace this with the real memory browser.</p>
    </div>
  );
};

export default FullPanelShellPlaceholder;
