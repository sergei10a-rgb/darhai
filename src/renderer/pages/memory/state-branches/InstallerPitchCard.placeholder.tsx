/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 placeholder for {@link InstallerPitchCard}. Wave 4 replaces this
 * with the real "install IJFW" pitch surface (CTA + install progress wiring).
 * Props signature matches the planned real component (none for this branch).
 */
import React from 'react';

const InstallerPitchCardPlaceholder: React.FC = () => {
  return (
    <div
      className='flex flex-col items-center justify-center gap-8px p-24px rd-12px bg-fill-2 border border-solid border-[var(--color-border-2)]'
      data-testid='memory-installer-pitch-placeholder'
    >
      <h2 className='text-16px font-semibold text-t-primary m-0'>InstallerPitchCard</h2>
      <p className='text-14px text-t-secondary m-0'>Wave 4 will replace this with the real install pitch.</p>
    </div>
  );
};

export default InstallerPitchCardPlaceholder;
