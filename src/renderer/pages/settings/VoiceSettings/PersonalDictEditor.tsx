/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';

type PersonalDictEditorProps = {
  /** Stored wrong → right pairs (`tools.speechToText.personalDict`). */
  dict: Record<string, string>;
  /** Called with the FULL next dictionary - the parent persists it. */
  onChange: (next: Record<string, string>) => void;
};

/**
 * The personal-dictionary table in the STT settings: words the recognizer
 * keeps mishearing for this user's voice, fixed as whole-word replacements
 * («коён» → «хоёр») by personalDict.ts after glossfix. A small pair list with
 * add/remove - deliberately not a grid component, because two inputs and a
 * button are the entire interaction.
 */
const PersonalDictEditor: React.FC<PersonalDictEditorProps> = ({ dict, onChange }) => {
  const { t } = useTranslation();
  const [wrong, setWrong] = useState('');
  const [right, setRight] = useState('');

  const entries = Object.entries(dict);
  const canAdd = wrong.trim().length > 0 && right.trim().length > 0;

  const add = (): void => {
    if (canAdd === false) return;
    onChange({ ...dict, [wrong.trim()]: right.trim() });
    setWrong('');
    setRight('');
  };

  const remove = (key: string): void => {
    const { [key]: _removed, ...rest } = dict;
    onChange(rest);
  };

  return (
    <div className='flex flex-col gap-8px'>
      <span className='text-12px text-t-tertiary'>{t('settings.speechToTextPersonalDictDescription')}</span>
      {entries.length === 0 ? (
        <span className='text-12px text-t-tertiary'>{t('settings.speechToTextPersonalDictEmpty')}</span>
      ) : (
        <div className='flex flex-col gap-4px'>
          {entries.map(([from, to]) => (
            <div key={from} className='flex items-center gap-8px'>
              <span className='text-13px text-t-primary flex-1 break-all'>{from}</span>
              <span aria-hidden='true' className='text-12px text-t-tertiary'>
                →
              </span>
              <span className='text-13px text-t-primary flex-1 break-all'>{to}</span>
              <Button size='mini' icon={<Delete />} onClick={() => remove(from)}>
                {t('settings.speechToTextPersonalDictRemove')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className='flex items-center gap-8px'>
        <Input
          size='small'
          value={wrong}
          placeholder={t('settings.speechToTextPersonalDictWrong')}
          onChange={setWrong}
        />
        <Input
          size='small'
          value={right}
          placeholder={t('settings.speechToTextPersonalDictRight')}
          onChange={setRight}
        />
        <Button size='small' type='primary' icon={<Plus />} disabled={canAdd === false} onClick={add}>
          {t('settings.speechToTextPersonalDictAdd')}
        </Button>
      </div>
    </div>
  );
};

export default PersonalDictEditor;
