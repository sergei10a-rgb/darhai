/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EntryEditorModal - edit a single memory entry in place (ported from
 * upstream f55f934b6, #414, re-grounded in Darhai's memory page).
 *
 * Prefilled from the selected entry (summary/type/tags/body). On save it sends
 * only the CHANGED fields to `memory.update-entry` so untouched frontmatter is
 * left verbatim on disk. Changing the summary changes the entry id, so the
 * caller receives the new id via onSaved to re-select the row.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Input, InputTag, Message, Modal, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { memory as memoryBridge } from '@/common/adapter/ipcBridge';
import type { MemoryEntry, MemoryType } from '@/common/types/memory';

const EDITABLE_TYPES: MemoryType[] = ['decision', 'pattern', 'observation', 'session', 'preference'];

export type EntryEditorTarget = MemoryEntry & { body: string };

export type EntryEditorModalProps = {
  open: boolean;
  entry: EntryEditorTarget | null;
  onClose: () => void;
  /** Called after a successful save with the entry's (possibly new) id. */
  onSaved: (newId: string) => void;
};

const EntryEditorModal: React.FC<EntryEditorModalProps> = ({ open, entry, onClose, onSaved }) => {
  const { t } = useTranslation();

  const [summary, setSummary] = useState('');
  const [type, setType] = useState<MemoryType>('observation');
  const [tags, setTags] = useState<string[]>([]);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset the form whenever a new entry is opened.
  useEffect(() => {
    if (entry) {
      setSummary(entry.summary);
      setType(entry.type);
      setTags(entry.tags ?? []);
      setBody(entry.body ?? '');
    }
  }, [entry]);

  const patch = useMemo(() => {
    if (!entry) return null;
    const trimmedSummary = summary.trim();
    const p: { summary?: string; type?: string; tags?: string[]; body?: string } = {};
    if (trimmedSummary && trimmedSummary !== entry.summary) p.summary = trimmedSummary;
    if (type !== entry.type) p.type = type;
    if (JSON.stringify(tags) !== JSON.stringify(entry.tags ?? [])) p.tags = tags;
    if (body !== (entry.body ?? '')) p.body = body;
    return p;
  }, [entry, summary, type, tags, body]);

  const hasChanges = !!patch && Object.keys(patch).length > 0;
  const summaryEmpty = summary.trim().length === 0;
  // A lone `---` line in the body would be read back as an entry separator and
  // corrupt the next entry in the shared file (C1). The main process refuses
  // such a save with `body_contains_separator`; warn ahead of time here.
  const bodyHasSeparator = useMemo(() => /^---\s*$/m.test(body), [body]);

  const handleSave = async (): Promise<void> => {
    if (!entry || !patch || !hasChanges || summaryEmpty || saving) return;
    setSaving(true);
    try {
      const result = await memoryBridge.updateEntry.invoke({ id: entry.id, ...patch });
      if (result.ok) {
        Message.success(t('memory.archive.editor.toastSaved'));
        onSaved(result.newId ?? entry.id);
        onClose();
      } else if (result.error === 'summary_collision') {
        Message.error(t('memory.archive.editor.toastCollision'));
      } else if (result.error === 'body_contains_separator') {
        Message.error(t('memory.archive.editor.toastBodySeparator'));
      } else {
        Message.error(t('memory.archive.editor.toastError'));
      }
    } catch {
      Message.error(t('memory.archive.editor.toastError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t('memory.archive.editor.title')}
      visible={open}
      onCancel={onClose}
      onOk={() => {
        void handleSave();
      }}
      okButtonProps={{ disabled: !hasChanges || summaryEmpty, loading: saving }}
      okText={t('memory.archive.editor.save')}
      cancelText={t('memory.archive.editor.cancel')}
      unmountOnExit
      data-testid='entry-editor-modal'
    >
      <div className='flex flex-col gap-12px'>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('memory.archive.editor.summaryLabel')}</span>
          <Input
            value={summary}
            onChange={setSummary}
            maxLength={500}
            data-testid='entry-editor-summary'
            status={summaryEmpty ? 'error' : undefined}
          />
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('memory.archive.editor.typeLabel')}</span>
          <Select value={type} onChange={(v) => setType(v as MemoryType)} data-testid='entry-editor-type'>
            {EDITABLE_TYPES.map((tp) => (
              <Select.Option key={tp} value={tp}>
                {tp}
              </Select.Option>
            ))}
          </Select>
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('memory.archive.editor.tagsLabel')}</span>
          <InputTag value={tags} onChange={(v) => setTags(v as string[])} data-testid='entry-editor-tags' allowClear />
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-[var(--color-text-3)]'>{t('memory.archive.editor.bodyLabel')}</span>
          <Input.TextArea
            value={body}
            onChange={setBody}
            autoSize={{ minRows: 6, maxRows: 16 }}
            data-testid='entry-editor-body'
          />
          {bodyHasSeparator && (
            <span
              className='text-12px'
              style={{ color: 'var(--color-warning-6, #d97706)' }}
              data-testid='entry-editor-body-separator-warn'
            >
              {t('memory.archive.editor.bodySeparatorWarn')}
            </span>
          )}
        </label>
      </div>
    </Modal>
  );
};

export default EntryEditorModal;
