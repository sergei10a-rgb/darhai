/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `buildStorage`, rebuilt on top of OUR provider factory.
 *
 * Why this file exists
 * --------------------
 * `withBridgeErrorPropagation` (see `bridgeError.ts`) repairs the vendored
 * platform's missing provider error path, and `bridgeAllowlist.buildProvider`
 * applies it to every provider we declare. Storage was the hole in that: the
 * platform's own `storage.buildStorage` calls `bridge.buildProvider` INTERNALLY
 * - not our wrapped one - so the four wire keys it registers
 * (`<namespace>.storage.{get,set,clear,remove}`) went to the renderer through
 * the unrepaired protocol.
 *
 * The consequence was the same defect the wrapper was written for: a storage
 * interceptor that throws (a corrupt JSON profile, an EPERM on the config file,
 * a full disk, the `EEXIST` that `buildMessageListStorage` raises for an
 * unknown conversation id) emitted NOTHING back, so the renderer's promise
 * stayed pending forever. `ConfigStorage.get` is on the boot path of most
 * screens, so that is an app that never finishes loading, with no error.
 *
 * `node_modules` must not be patched, so the ~30 lines of the platform's
 * `buildStorage` are re-implemented here against an injected factory. The wire
 * shape is copied verbatim from `@office-ai/platform/dist/index.js` (function
 * `L`) so main and renderer keep talking the same protocol:
 *
 *   get     `<ns>.storage.get`     params: `String(key)`
 *   set     `<ns>.storage.set`     params: `{ key: String(key), data }`
 *   remove  `<ns>.storage.remove`  params: `String(key)`
 *   clear   `<ns>.storage.clear`   params: none
 *
 * The factory is a parameter rather than an import so this module has no
 * dependency on the allowlist that uses it (which would be a cycle).
 */

/** Minimal view of one provider pair, enough for the four storage verbs. */
export type StorageProviderApi = {
  provider: (handler: (params: never) => Promise<unknown>) => void;
  invoke: (params?: unknown) => Promise<unknown>;
};

/** How a namespace obtains a provider for one wire key. */
export type StorageProviderFactory = (key: string) => StorageProviderApi;

/** Main-process (or renderer-side) handlers backing a namespace. */
export type StorageInterceptor<S> = Partial<{
  get<K extends keyof S>(key: K): Promise<S[K]>;
  set<K extends keyof S>(key: K, data: S[K]): Promise<S[K]>;
  clear(): Promise<unknown>;
  remove<K extends keyof S>(key: K): Promise<unknown>;
}>;

/** The object `buildStorage` hands back. Mirrors the platform's shape. */
export type BridgeStorage<S> = {
  get<K extends keyof S>(key: K): Promise<S[K]>;
  set<K extends keyof S>(key: K, data: S[K]): Promise<unknown>;
  clear(): Promise<unknown>;
  remove(key: keyof S): Promise<void>;
  debug(debug: boolean): void;
  interceptor(interceptor: StorageInterceptor<S>): void;
};

/** The four wire keys a namespace registers. Exported so the allowlist can record them. */
export function storageWireKeys(namespace: string): readonly string[] {
  return [
    `${namespace}.storage.get`,
    `${namespace}.storage.set`,
    `${namespace}.storage.clear`,
    `${namespace}.storage.remove`,
  ];
}

/**
 * `window.localStorage` when there is one.
 *
 * The platform's debug mode answers from `localStorage` instead of the bridge.
 * Nothing in this app enables it, but the parity is kept - guarded, because
 * this module is loaded in the main process too, where `localStorage` does not
 * exist and an unguarded read would throw instead of degrading.
 */
function localStore(): Storage | undefined {
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate && typeof candidate.getItem === 'function' ? candidate : undefined;
}

/**
 * Build a storage namespace whose four providers come from `factory`.
 *
 * Pass `bridgeAllowlist.buildProvider` as the factory and every storage call
 * inherits both fixes it carries: the C1 inbound allowlist registration, and
 * the error propagation that turns a throwing interceptor into a rejected
 * caller promise instead of a permanent hang.
 */
export function buildBridgeStorage<S>(
  namespace: string,
  factory: StorageProviderFactory,
  options?: { debug: boolean }
): BridgeStorage<S> {
  const [getKey, setKey, clearKey, removeKey] = storageWireKeys(namespace);
  const getProvider = factory(getKey);
  const setProvider = factory(setKey);
  const clearProvider = factory(clearKey);
  const removeProvider = factory(removeKey);

  let useLocal = options?.debug === true;

  /** Bridge path unless debug mode asked for the local one. */
  const route = <T>(viaBridge: () => Promise<T>, viaLocal: () => Promise<T>): Promise<T> => {
    if (!useLocal) return viaBridge();
    const store = localStore();
    return store ? viaLocal() : viaBridge();
  };

  return {
    get<K extends keyof S>(key: K): Promise<S[K]> {
      return route(
        () => getProvider.invoke(String(key)) as Promise<S[K]>,
        async () => {
          const raw = localStore()?.getItem(String(key));
          if (!raw) return undefined as S[K];
          try {
            return JSON.parse(raw) as S[K];
          } catch (error) {
            console.error(`[storage] ${namespace}.${String(key)} is not valid JSON:`, error);
            return undefined as S[K];
          }
        }
      );
    },

    set<K extends keyof S>(key: K, data: S[K]): Promise<unknown> {
      return route(
        () => setProvider.invoke({ key: String(key), data }),
        async () => localStore()?.setItem(String(key), JSON.stringify(data))
      );
    },

    clear(): Promise<unknown> {
      return route(
        () => clearProvider.invoke(),
        async () => localStore()?.clear()
      );
    },

    async remove(key: keyof S): Promise<void> {
      await route(
        () => removeProvider.invoke(String(key)),
        async () => localStore()?.removeItem(String(key))
      );
    },

    debug(debug: boolean): void {
      useLocal = debug;
    },

    interceptor(interceptor: StorageInterceptor<S>): void {
      const { get, set, clear, remove } = interceptor;
      if (get) getProvider.provider(((key: keyof S) => get(key)) as (params: never) => Promise<unknown>);
      if (set) {
        setProvider.provider(((params: { key: keyof S; data: S[keyof S] }) => set(params.key, params.data)) as (
          params: never
        ) => Promise<unknown>);
      }
      if (clear) clearProvider.provider(clear as (params: never) => Promise<unknown>);
      if (remove) removeProvider.provider(((key: keyof S) => remove(key)) as (params: never) => Promise<unknown>);
    },
  };
}
