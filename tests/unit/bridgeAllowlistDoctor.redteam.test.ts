import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Doctor diagnostics are local-renderer-only: the report aggregates the host's
 * install/connectivity posture (which runtimes are on disk and where, which
 * local services answer, free disk space) in one payload - reconnaissance a
 * paired-device WebSocket caller has no legitimate use for. The whole
 * `doctor.*` namespace is denied via the prefix in bridgeAllowlist.ts,
 * mirroring the upstream decision at introduction (e4324b592). The dispatcher
 * receives each wire key as `subscribe-<key>`.
 */
describe('isAllowedForRemote - doctor.* denied to remote callers', () => {
  it('denies doctor.run for remote callers', () => {
    expect(isAllowedForRemote('subscribe-doctor.run')).toBe(false);
  });

  // The denylist must not leak to non-doctor namespaces: a sibling read the
  // paired WebUI legitimately needs stays allowed (denylist, not whitelist).
  it('still allows a read-only sibling namespace for remote callers', () => {
    expect(isAllowedForRemote('subscribe-usage.queryFrequentlyUsedModels')).toBe(true);
  });
});
