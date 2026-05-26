/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 placeholder for {@link InstallingCard}. Wave 4 replaces this with
 * the real "installing / upgrading / pending activation" surface (spinner,
 * version label, progress text). Props are forward-compatible with the
 * real signature: `version` is optional so the lifecycle states
 * `installing`, `upgrading`, and `installed_pending_activation` can all
 * mount the same component.
 */
import React from 'react';

interface InstallingCardPlaceholderProps {
  version?: string;
}

const InstallingCardPlaceholder: React.FC<InstallingCardPlaceholderProps> = ({ version }) => {
  return (
    <div
      className='flex flex-col items-center justify-center gap-8px p-24px rd-12px bg-fill-2 border border-solid border-[var(--color-border-2)]'
      data-testid='memory-installing-placeholder'
    >
      <h2 className='text-16px font-semibold text-t-primary m-0'>InstallingCard</h2>
      <p className='text-14px text-t-secondary m-0'>
        {version ? `Activating IJFW ${version}…` : 'Installing IJFW…'}
      </p>
      <p className='text-12px text-t-tertiary m-0'>Wave 4 will replace this with the real progress surface.</p>
    </div>
  );
};

export default InstallingCardPlaceholder;
