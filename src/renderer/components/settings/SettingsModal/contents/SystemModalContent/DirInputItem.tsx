/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { FolderOpen } from 'lucide-react';
import { ipcBridge } from '@/common';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Form, Tooltip } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Directory selection input component
 * Used for selecting and displaying system directory paths
 */
const DirInputItem: React.FC<{
  label: string;
  field: string;
  /**
   * Friendly name shown on the primary line instead of the raw path.
   *
   * The default work directory still lives in the on-disk `wayland` folder
   * (renaming it would strand existing user data), so the row leads with a
   * branded label and demotes the absolute path to a secondary line. The path
   * stays visible, selectable, and in the tooltip.
   */
  displayName?: string;
}> = ({ label, field, displayName }) => {
  const { t } = useTranslation();
  return (
    <Form.Item label={label} field={field}>
      {(value, form) => {
        const currentValue = form.getFieldValue(field) || '';

        const handlePick = () => {
          ipcBridge.dialog.showOpen
            .invoke({
              defaultPath: currentValue,
              properties: ['openDirectory', 'createDirectory'],
            })
            .then((data) => {
              if (data?.[0]) {
                form.setFieldValue(field, data[0]);
              }
            })
            .catch((error) => {
              console.error('Failed to open directory dialog:', error);
            });
        };

        const pathText = currentValue || t('settings.dirNotConfigured');

        return (
          <div
            className={`aion-dir-input flex items-center rounded-8px border border-solid border-transparent pl-14px bg-[var(--fill-0)] ${
              displayName ? 'min-h-[46px] py-4px' : 'h-[32px]'
            }`}
          >
            <Tooltip content={pathText} position='top'>
              <div className='flex-1 min-w-0'>
                {displayName ? (
                  <>
                    <div className='text-13px text-t-primary truncate'>{displayName}</div>
                    <div
                      className='text-11px text-t-tertiary truncate'
                      style={{ userSelect: 'text', cursor: 'text' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {pathText}
                    </div>
                  </>
                ) : (
                  <div className='text-13px text-t-primary truncate '>{pathText}</div>
                )}
              </div>
            </Tooltip>
            <Button
              type='text'
              style={{ borderLeft: '1px solid var(--color-border-2)', borderRadius: '0 8px 8px 0' }}
              icon={<FolderOpen size={18} color={iconColors.primary} />}
              onClick={(e) => {
                e.stopPropagation();
                handlePick();
              }}
            />
          </div>
        );
      }}
    </Form.Item>
  );
};

export default DirInputItem;
