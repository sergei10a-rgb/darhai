import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Message, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { IModelRegistryDetectedKey, IModelRegistryProviderView } from '@/common/adapter/ipcBridge';
import type { ProviderId } from '@process/providers/types';
import SettingsPageShell from '@renderer/pages/settings/components/SettingsPageShell';
import { useModelRegistry } from '@renderer/hooks/useModelRegistry';
import ConnectPanel from './components/ConnectPanel';
import ConnectedRow from './components/ConnectedRow';
import EmptyState from './components/EmptyState';
import styles from './ModelsSettings.module.css';

/** Stable identity for a detected key (provider + source). */
function detectedKeyId(dk: IModelRegistryDetectedKey): string {
  return `${dk.providerId}:${dk.source}`;
}

/**
 * Models settings page — the primary surface of the Models & Providers
 * redesign (prototype `#screen-models`).
 *
 * Three regions:
 *  1. Connect a provider (the always-visible hero) — detected-keys strip,
 *     paste-an-API-key with live recognition, Continue with Google, Browse.
 *  2. Connected providers — compact `ConnectedRow`s with a visible Manage.
 *  3. First-run / empty state — when there are no providers and no detected
 *     keys, the connect panel is the whole page plus a one-line nudge.
 */
const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const { providers, loading, error, connect, disconnect, detectKeys } = useModelRegistry();

  const [detectedKeys, setDetectedKeys] = useState<IModelRegistryDetectedKey[]>([]);
  const [ignoredKeys, setIgnoredKeys] = useState<Set<string>>(new Set());

  // Auto-discover keys already on the machine (spec §4.4). Surfaced as the
  // consent strip — never used silently.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const keys = await detectKeys();
        if (!cancelled) setDetectedKeys(Array.isArray(keys) ? keys : []);
      } catch {
        // Auto-discovery is best-effort — a failure leaves the page fully usable.
        if (!cancelled) setDetectedKeys([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detectKeys]);

  const visibleDetected = useMemo(
    () => detectedKeys.filter((dk) => !ignoredKeys.has(detectedKeyId(dk))),
    [detectedKeys, ignoredKeys]
  );

  const connectKey = useCallback((providerId: ProviderId, key: string) => connect(providerId, { key }), [connect]);

  const useDetected = useCallback(
    async (dk: IModelRegistryDetectedKey) => {
      const res = await connect(dk.providerId, { useDiscovered: true });
      if (res.ok) {
        // Connected — drop it from the strip.
        setIgnoredKeys((prev) => new Set(prev).add(detectedKeyId(dk)));
      }
      return res;
    },
    [connect]
  );

  const ignoreDetected = useCallback((dk: IModelRegistryDetectedKey) => {
    setIgnoredKeys((prev) => new Set(prev).add(detectedKeyId(dk)));
  }, []);

  const handleBrowse = useCallback(() => {
    // TODO(2C): open the Browse-all-providers modal built in Packet 2C.
  }, []);

  const handleManage = useCallback((_provider: IModelRegistryProviderView) => {
    // TODO(2B): navigate to the Manage page built in Packet 2B.
  }, []);

  const handleFix = useCallback(
    async (provider: IModelRegistryProviderView) => {
      // TODO(2B): the Manage page owns the re-key dialog. Until 2B lands, the
      // safe recovery is to disconnect so the user can re-connect cleanly.
      try {
        await disconnect(provider.providerId);
      } catch {
        // A failed disconnect leaves the errored provider in place — surface it
        // rather than failing silently with an unhandled rejection.
        Message.error(t('settings.modelsPage.fixFailed'));
      }
    },
    [disconnect, t]
  );

  const showEmptyState = !loading && providers.length === 0 && visibleDetected.length === 0;

  return (
    <SettingsPageShell
      title={t('settings.modelsPage.title')}
      subtitle={t('settings.modelsPage.subtitle')}
      breadcrumb={[{ label: t('settings.modelsPage.crumbAiModels') }, { label: t('settings.modelsPage.title') }]}
    >
      <ConnectPanel
        detectedKeys={visibleDetected}
        onConnectKey={connectKey}
        onUseDetected={useDetected}
        onIgnoreDetected={ignoreDetected}
        onBrowse={handleBrowse}
      />

      {error && (
        <div className={styles.connectError} role='alert'>
          <span>{t('settings.modelsPage.loadError')}</span>
        </div>
      )}

      <div className={styles.sectionLabel}>{t('settings.modelsPage.connectedLabel')}</div>

      {loading && providers.length === 0 && (
        <div className={styles.loadingRow}>
          <Spin />
        </div>
      )}

      {showEmptyState && <EmptyState />}

      {providers.length > 0 && (
        <div className={styles.connectedList}>
          {providers.map((p) => (
            <ConnectedRow key={p.providerId} provider={p} onManage={handleManage} onFix={handleFix} />
          ))}
        </div>
      )}
    </SettingsPageShell>
  );
};

export default ModelsSettings;
