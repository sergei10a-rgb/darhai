/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 placeholder for {@link InstallFailedCard}. Wave 4 replaces this with
 * the real error surface (retry button, log viewer, copy-to-clipboard). Props
 * mirror the {@link IjfwStatusPayload.errorReason} field so Wave 4 can render
 * the localized failure-reason copy without a props refactor.
 */
import React from 'react';

interface InstallFailedCardPlaceholderProps {
  errorReason?: string;
}

const InstallFailedCardPlaceholder: React.FC<InstallFailedCardPlaceholderProps> = ({ errorReason }) => {
  return (
    <div
      className='flex flex-col items-center justify-center gap-8px p-24px rd-12px bg-[rgba(var(--danger-6),0.08)] border border-solid border-[rgba(var(--danger-6),0.32)]'
      data-testid='memory-install-failed-placeholder'
    >
      <h2 className='text-16px font-semibold text-danger m-0'>InstallFailedCard</h2>
      <p className='text-14px text-t-secondary m-0'>{errorReason ?? 'IJFW install failed.'}</p>
      <p className='text-12px text-t-tertiary m-0'>Wave 4 will replace this with the real retry surface.</p>
    </div>
  );
};

export default InstallFailedCardPlaceholder;
