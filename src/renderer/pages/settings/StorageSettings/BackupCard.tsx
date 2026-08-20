import { Button, Checkbox, Input, Message, Modal } from '@arco-design/web-react';
import { Archive } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, PreferenceRow } from '@renderer/components/settings/shared';
import { storage } from '@/common/adapter/ipcBridge';

/**
 * Report the outcome of a backup operation.
 *
 * Both handlers used to end in a bare `.finally`, so the spinner stopped and
 * nothing else happened: a finished restore looked exactly like a refused one.
 * That mattered most on the refusal path - `backupImport` throws rather than
 * overwrite a real database with a truncated or non-SQLite archive, and a
 * silent refusal reads to the user as success.
 *
 * A dismissed OS dialog is not a failure and stays quiet.
 */
function reportOutcome(result: { ok: boolean; canceled?: boolean }, successText: string, failureText: string): void {
  if (result.canceled) return;
  if (result.ok) Message.success(successText);
  else Message.error(failureText);
}

/** Surface the reason, not just that something went wrong. */
function reportThrow(error: unknown, failureText: string): void {
  const reason = error instanceof Error ? error.message : String(error);
  Message.error(reason ? `${failureText}: ${reason}` : failureText);
}

const BackupCard: React.FC = () => {
  const { t } = useTranslation();
  const [includeKeys, setIncludeKeys] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = () => {
    setExporting(true);
    void storage.exportAll
      .invoke({ includeKeys, passphrase: includeKeys ? passphrase : undefined })
      .then((result) =>
        reportOutcome(result, t('settings.storagePage.exportSuccess'), t('settings.storagePage.exportFailed'))
      )
      .catch((error: unknown) => reportThrow(error, t('settings.storagePage.exportFailed')))
      .finally(() => setExporting(false));
  };

  const runImport = () => {
    setImporting(true);
    void storage.importBackup
      .invoke({})
      .then((result) =>
        reportOutcome(result, t('settings.storagePage.restoreSuccess'), t('settings.storagePage.restoreFailed'))
      )
      .catch((error: unknown) => reportThrow(error, t('settings.storagePage.restoreFailed')))
      .finally(() => setImporting(false));
  };

  // Ask before opening the file dialog, not after: a successful restore
  // relaunches the app, which interrupts whatever turn is in flight. The
  // dialog's own cancel button is not consent for that.
  const handleImport = () => {
    Modal.confirm({
      title: t('settings.storagePage.restoreConfirmTitle'),
      content: t('settings.storagePage.restoreConfirmBody'),
      okButtonProps: { status: 'warning' },
      onOk: runImport,
    });
  };

  return (
    <Card title={t('settings.storagePage.backupTitle')} titleIcon={Archive}>
      <PreferenceRow label={t('settings.storagePage.exportIncludeKeys')}>
        <Checkbox checked={includeKeys} onChange={setIncludeKeys} />
      </PreferenceRow>

      {includeKeys && (
        <PreferenceRow label={t('settings.storagePage.exportPassphraseLabel')}>
          <Input
            type='password'
            value={passphrase}
            onChange={setPassphrase}
            placeholder={t('settings.storagePage.exportPassphrasePlaceholder')}
            style={{ width: 220 }}
            size='small'
          />
        </PreferenceRow>
      )}

      <div className='flex gap-8px mt-4px'>
        <Button type='primary' size='small' loading={exporting} onClick={handleExport}>
          {t('settings.storagePage.exportAll')}
        </Button>
        <Button size='small' loading={importing} onClick={handleImport}>
          {t('settings.storagePage.restore')}
        </Button>
      </div>
    </Card>
  );
};

export default BackupCard;
