/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The /refine rules card: a small surface for the scope-aware behavioral rules
 * that sit on top of Darhai's fact memory. Session rules live for this run;
 * global rules are durable cross-session lessons. Each add/remove is a one-edit
 * refinement pass, and the Rollback button undoes the LAST pass. Hosted on the
 * IJFW Memory settings panel.
 */

import { Button, Input, Radio } from '@arco-design/web-react';
import { RotateCcw, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RuleScope } from '@process/services/memory/refine/rule';
import { useRefineRules } from '../hooks/useRefineRules';

export const RefineRulesCard: React.FC = () => {
  const { t } = useTranslation();
  const { scope, setScope, rules, canRollback, busy, addRule, removeRule, rollback } = useRefineRules();
  const [draft, setDraft] = useState('');

  const handleAdd = (): void => {
    void addRule(draft).then(() => setDraft(''));
  };

  return (
    <div
      className='px-[12px] md:px-[24px] py-[20px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'
      data-testid='refine-rules-card'
    >
      <div className='flex items-center justify-between gap-12px mb-12px'>
        <div className='flex flex-col gap-2px'>
          <span className='text-14px text-t-primary'>{t('settings.refineRules.title')}</span>
          <span className='text-12px text-t-tertiary'>{t('settings.refineRules.description')}</span>
        </div>
        <Radio.Group type='button' size='small' value={scope} onChange={(next: RuleScope) => setScope(next)}>
          <Radio value='session'>{t('settings.refineRules.scopeSession')}</Radio>
          <Radio value='global'>{t('settings.refineRules.scopeGlobal')}</Radio>
        </Radio.Group>
      </div>

      <div className='flex items-center gap-8px mb-12px'>
        <Input
          size='small'
          value={draft}
          placeholder={t('settings.refineRules.addPlaceholder')}
          onChange={(next: string) => setDraft(next)}
          onPressEnter={handleAdd}
          className='flex-1'
          data-testid='refine-rule-input'
        />
        <Button size='small' type='primary' loading={busy} onClick={handleAdd} data-testid='refine-rule-add'>
          {t('settings.refineRules.add')}
        </Button>
      </div>

      {rules.length === 0 ? (
        <span className='text-12px text-t-tertiary'>{t('settings.refineRules.empty')}</span>
      ) : (
        <div className='flex flex-col gap-6px'>
          {rules.map((rule) => (
            <div
              key={rule.id}
              className='flex items-center justify-between gap-8px py-4px border-b border-solid border-[var(--color-border-1)]'
              data-testid={`refine-rule-${rule.id}`}
            >
              <span className='text-12px text-t-primary flex-1 break-words'>{rule.text}</span>
              <Button
                size='mini'
                status='danger'
                icon={<Trash2 size={13} />}
                onClick={() => void removeRule(rule.id)}
                aria-label={t('settings.refineRules.remove')}
              />
            </div>
          ))}
        </div>
      )}

      <div className='flex items-center gap-8px mt-12px'>
        <Button
          size='small'
          icon={<RotateCcw size={13} />}
          disabled={!canRollback || busy}
          onClick={() => void rollback()}
          data-testid='refine-rollback'
        >
          {t('settings.refineRules.rollback')}
        </Button>
        <span className='text-12px text-t-tertiary'>{t('settings.refineRules.rollbackHint')}</span>
      </div>
    </div>
  );
};

export default RefineRulesCard;
