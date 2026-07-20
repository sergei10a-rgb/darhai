/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Preference row layout for the email channel forms - a left-aligned
 * label/description with a right-aligned control. Shared by the IMAP config
 * form and its triage toggles so both read consistently.
 */
export const PreferenceRow: React.FC<{
  label: string;
  description?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}> = ({ label, description, required, children }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      <div className='flex items-center gap-8px'>
        <span className='text-14px text-t-primary'>
          {label}
          {required && <span className='text-red-500 ml-2px'>*</span>}
        </span>
      </div>
      {description && <div className='text-12px text-t-tertiary mt-2px'>{description}</div>}
    </div>
    <div className='flex items-center'>{children}</div>
  </div>
);

export default PreferenceRow;
