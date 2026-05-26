/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wave 3 placeholder for {@link OnboardingEmptyState}. Wave 4 replaces this
 * with the real "you have no memories yet — here is what they are" onboarding
 * surface. Props signature matches the planned real component (none for
 * this branch — Wave 5 will pass the active brain scope through).
 */
import React from 'react';

const OnboardingEmptyStatePlaceholder: React.FC = () => {
  return (
    <div
      className='flex flex-col items-center justify-center gap-8px p-24px rd-12px bg-fill-2 border border-solid border-[var(--color-border-2)]'
      data-testid='memory-onboarding-empty-placeholder'
    >
      <h2 className='text-16px font-semibold text-t-primary m-0'>OnboardingEmptyState</h2>
      <p className='text-14px text-t-secondary m-0'>No memories yet — Wave 4 will explain what memory is.</p>
    </div>
  );
};

export default OnboardingEmptyStatePlaceholder;
