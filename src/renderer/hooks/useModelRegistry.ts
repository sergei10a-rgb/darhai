import { useCallback, useEffect, useRef, useState } from 'react';
import { modelRegistry } from '@/common/adapter/ipcBridge';
import type {
  IModelRegistryCatalogView,
  IModelRegistryConnectResult,
  IModelRegistryCreds,
  IModelRegistryDetectedKey,
  IModelRegistryProviderView,
  IModelRegistryTestResult,
} from '@/common/adapter/ipcBridge';
import type { CuratedModel, ProviderId } from '@process/providers/types';

/**
 * Renderer wrapper around the full `ipcBridge.modelRegistry` IPC contract.
 *
 * Owns the connected-providers list + its loading/error state, and exposes
 * thin pass-throughs for every other method so the Models page, the Manage
 * page (Packet 2B), the Browse modal (2C) and the home picker (2E) all consume
 * the same surface without re-implementing IPC plumbing.
 *
 * `modelRegistry.*.invoke()` resolves to the bare contract type (no
 * `{ success, data }` envelope — that wrapper only applies to namespaces whose
 * declared return type is `IBridgeResponse`).
 */
export type UseModelRegistry = {
  /** Connected providers with live state + model counts. */
  providers: IModelRegistryProviderView[];
  /** True while the initial `list()` is in flight. */
  loading: boolean;
  /** Last error from `list()`, or null. */
  error: string | null;
  /** Re-fetch the connected-providers list. */
  reload: () => Promise<void>;

  /** Auto-discover provider keys already on the machine. */
  detectKeys: () => Promise<IModelRegistryDetectedKey[]>;
  /** Connect a provider via key / cloud fields / a discovered key. */
  connect: (providerId: ProviderId, creds: IModelRegistryCreds) => Promise<IModelRegistryConnectResult>;
  /** Run a connectivity test against an already-connected provider. */
  testConnection: (providerId: ProviderId) => Promise<IModelRegistryTestResult>;
  /** Enriched catalog + curated view for one provider. */
  getCatalog: (providerId: ProviderId) => Promise<IModelRegistryCatalogView>;
  /** Enable / disable a single model. */
  toggleModel: (providerId: ProviderId, modelId: string, enabled: boolean) => Promise<{ ok: boolean }>;
  /** Re-fetch + re-enrich a provider's model list. */
  refresh: (providerId: ProviderId) => Promise<{ ok: boolean }>;
  /** Disconnect a provider and drop its catalog. */
  disconnect: (providerId: ProviderId) => Promise<{ ok: boolean }>;
  /** Replace a connected provider's credentials. */
  rekey: (providerId: ProviderId, creds: IModelRegistryCreds) => Promise<IModelRegistryConnectResult>;
  /** Curated model list scoped to a CLI agent / backend key. */
  curatedForAgent: (agentKey: string) => Promise<CuratedModel[]>;
};

export function useModelRegistry(): UseModelRegistry {
  const [providers, setProviders] = useState<IModelRegistryProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Monotonic request sequence. Concurrent mutations each `await reload()`;
  // `list()` calls can resolve out of order, so a stale snapshot could win.
  // Each reload captures its sequence number and only commits its result if no
  // newer reload has started since.
  const reloadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const list = await modelRegistry.list.invoke();
      if (seq !== reloadSeq.current) return; // a newer reload superseded this one
      setProviders(Array.isArray(list) ? list : []);
    } catch (err) {
      if (seq !== reloadSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reloadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const detectKeys = useCallback(() => modelRegistry.detectKeys.invoke(), []);

  const connect = useCallback(
    async (providerId: ProviderId, creds: IModelRegistryCreds) => {
      const res = await modelRegistry.connect.invoke({ providerId, creds });
      await reload();
      return res;
    },
    [reload]
  );

  const testConnection = useCallback(
    (providerId: ProviderId) => modelRegistry.testConnection.invoke({ providerId }),
    []
  );

  const getCatalog = useCallback((providerId: ProviderId) => modelRegistry.getCatalog.invoke({ providerId }), []);

  const toggleModel = useCallback(
    (providerId: ProviderId, modelId: string, enabled: boolean) =>
      modelRegistry.toggleModel.invoke({ providerId, modelId, enabled }),
    []
  );

  const refresh = useCallback(
    async (providerId: ProviderId) => {
      const res = await modelRegistry.refresh.invoke({ providerId });
      await reload();
      return res;
    },
    [reload]
  );

  const disconnect = useCallback(
    async (providerId: ProviderId) => {
      const res = await modelRegistry.disconnect.invoke({ providerId });
      await reload();
      return res;
    },
    [reload]
  );

  const rekey = useCallback(
    async (providerId: ProviderId, creds: IModelRegistryCreds) => {
      const res = await modelRegistry.rekey.invoke({ providerId, creds });
      await reload();
      return res;
    },
    [reload]
  );

  const curatedForAgent = useCallback((agentKey: string) => modelRegistry.curatedForAgent.invoke({ agentKey }), []);

  return {
    providers,
    loading,
    error,
    reload,
    detectKeys,
    connect,
    testConnection,
    getCatalog,
    toggleModel,
    refresh,
    disconnect,
    rekey,
    curatedForAgent,
  };
}
