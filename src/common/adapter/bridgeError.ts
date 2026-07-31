/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error propagation for IPC bridge providers.
 *
 * The @office-ai/platform provider wire protocol emits the reply callback only
 * from the handler's `.then`:
 *
 *   subscribe(key, handler) -> handler(data).then(res => emit(`callback-${key}${id}`, res))
 *   invoke(key, data)       -> new Promise(resolve => on(`callback-${key}${id}`, resolve))
 *
 * There is no `.catch` on the provider side and no reject path on the caller
 * side. A handler that rejects therefore sends NOTHING back: the renderer's
 * promise never settles, and the failure surfaces only as an
 * `[unhandledRejection]` in the main-process log. Every failed write in the app
 * becomes an infinite spinner with no message.
 *
 * The platform package is vendored and must not be patched, so the contract is
 * repaired on our side of it:
 *
 *   - the provider handler is wrapped so a throw becomes a RESOLVED structured
 *     envelope (the wire always gets a reply, and main never sees an unhandled
 *     rejection), and
 *   - `invoke` unwraps that envelope back into a real rejected `Error`.
 *
 * Callers therefore see ordinary promise semantics: success paths are byte-for-
 * byte unchanged, and failures land in whatever `try/catch` / `.catch()` the
 * call site already has instead of hanging.
 */

/**
 * Wire marker identifying a serialized provider failure.
 *
 * Deliberately awkward so it cannot collide with a real provider payload - it
 * travels as an ordinary JSON property through `JSON.stringify`, which rules
 * out a `Symbol`.
 */
export const BRIDGE_ERROR_MARKER = '__darhaiBridgeError';

/** Serializable description of a provider failure. */
export type BridgeErrorPayload = {
  /** Provider key whose handler threw (e.g. `calendar.create`). */
  key: string;
  /** Constructor name of the original error (`Error`, `SqliteError`, ...). */
  name: string;
  /** Human-readable diagnosis; safe to show in the UI. */
  message: string;
  /** `code` carried by SQLite / Node system errors, when the original had one. */
  code?: string;
};

/** What a failing provider puts on the wire in place of its normal result. */
export type BridgeErrorEnvelope = {
  [BRIDGE_ERROR_MARKER]: BridgeErrorPayload;
};

/**
 * The rejection an `invoke` caller receives. A real `Error`, so `instanceof
 * Error`, `error.message` and existing `try/catch` handling all work unchanged.
 */
export type BridgeInvokeError = Error & {
  /** Provider key whose handler threw. */
  bridgeKey: string;
  /** `code` from the original main-process error, when it had one. */
  code?: string;
};

/** Shape of `bridge.buildProvider(key)`, restated so this module imports nothing. */
export type BridgeProviderApi<Data, Params = undefined> = {
  provider: (provider: Params extends undefined ? () => Promise<Data> : (params: Params) => Promise<Data>) => void;
  invoke: Params extends undefined ? () => Promise<Data> : (params: Params) => Promise<Data>;
};

/** Untyped view of the above, used internally so the wrapper needs no `any`. */
type LooseProviderApi = {
  provider: (handler: (params: unknown) => Promise<unknown>) => void;
  invoke: (params?: unknown) => Promise<unknown>;
};

const readString = (source: Record<string, unknown>, field: string): string | undefined => {
  const value = source[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Describe an unknown thrown value without losing what little it carries. */
function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const extras = error as unknown as Record<string, unknown>;
    return {
      name: error.name || 'Error',
      message: error.message || String(error),
      code: readString(extras, 'code'),
    };
  }
  if (typeof error === 'object' && error !== null) {
    const source = error as Record<string, unknown>;
    const message = readString(source, 'message');
    if (message) {
      return { name: readString(source, 'name') ?? 'Error', message, code: readString(source, 'code') };
    }
  }
  return { name: 'Error', message: String(error) };
}

/** Build the envelope a failing provider returns in place of its result. */
export function toBridgeErrorEnvelope(key: string, error: unknown): BridgeErrorEnvelope {
  const { name, message, code } = describeError(error);
  // `stack` is deliberately omitted: it carries absolute host paths and this
  // payload is also delivered to paired-device WebUI clients. The full error
  // (stack included) is logged main-side by `withBridgeErrorPropagation`.
  const payload: BridgeErrorPayload = code ? { key, name, message, code } : { key, name, message };
  return { [BRIDGE_ERROR_MARKER]: payload };
}

/** Type guard: is this provider result a serialized failure rather than data? */
export function isBridgeErrorEnvelope(value: unknown): value is BridgeErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const payload = (value as Record<string, unknown>)[BRIDGE_ERROR_MARKER];
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;
  return typeof record.key === 'string' && typeof record.message === 'string';
}

/** Rebuild a throwable `Error` from an envelope received over the wire. */
export function fromBridgeErrorEnvelope(envelope: BridgeErrorEnvelope): BridgeInvokeError {
  const payload = envelope[BRIDGE_ERROR_MARKER];
  const error = new Error(payload.message) as BridgeInvokeError;
  error.name = payload.name || 'Error';
  error.bridgeKey = payload.key;
  if (payload.code) error.code = payload.code;
  return error;
}

/**
 * Wrap a platform provider so failures cross the bridge instead of stalling it.
 *
 * @param key   Provider key, used for the log line and carried in the envelope.
 * @param base  The object returned by `bridge.buildProvider(key)`.
 * @returns An API of identical shape whose `invoke` rejects when the handler threw.
 */
export function withBridgeErrorPropagation<Data, Params = undefined>(
  key: string,
  base: BridgeProviderApi<Data, Params>
): BridgeProviderApi<Data, Params> {
  const loose = base as unknown as LooseProviderApi;

  const wrapped: LooseProviderApi = {
    provider: (handler) => {
      // `async` matters beyond ergonomics: the platform calls `handler(data).then(...)`
      // unconditionally, so a handler that threw SYNCHRONOUSLY used to blow up
      // inside the emitter. This wrapper always hands back a promise.
      loose.provider(async (params) => {
        try {
          return await handler(params);
        } catch (error) {
          // Report, then answer. The caller gets the error too (see `invoke`),
          // so this is diagnostics - not a swallow.
          console.error(`[bridge] provider "${key}" failed:`, error);
          return toBridgeErrorEnvelope(key, error);
        }
      });
    },
    invoke: async (params) => {
      const result = await loose.invoke(params);
      if (isBridgeErrorEnvelope(result)) throw fromBridgeErrorEnvelope(result);
      return result;
    },
  };

  return wrapped as unknown as BridgeProviderApi<Data, Params>;
}
