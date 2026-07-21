import { describe, it, expect } from 'vitest';
import { isAllowedForRemote } from '@/common/adapter/bridgeAllowlist';

/**
 * Defense-in-depth red-team coverage: fs/project providers that leak arbitrary
 * file access must NOT be reachable by a remote (paired-device WebSocket) caller.
 * Each wire key below is the exact string passed to buildProvider() in
 * ipcBridge.ts; the dispatcher receives it as `subscribe-<key>`.
 */
describe('isAllowedForRemote - fs/project arbitrary-path providers denied', () => {
  const deniedKeys: ReadonlyArray<[string, string]> = [
    ['getFileMetadata', 'get-file-metadata'],
    ['getFilesByDir', 'get-file-by-dir'],
    ['listWorkspaceFiles', 'list-workspace-files'],
    ['getImageBase64', 'get-image-base64'],
    ['createZip', 'create-zip-file'],
    ['copyFilesToWorkspace', 'copy-files-to-workspace'],
    ['project.generate-knowledge-draft', 'project.generate-knowledge-draft'],
  ];

  it.each(deniedKeys)('denies %s (subscribe-%s) for remote callers', (_provider, key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });
});

/**
 * Channel config / authorization mutation surface must NOT be reachable by a
 * remote (paired-device WebSocket) caller. enable/disable reconfigure a
 * channel, sync-channel-settings can set WhatsApp mode='dedicated' +
 * ownerNumbers (auto-authorizing an arbitrary number), revoke/get-authorized
 * mutate and disclose authorization, rotate-webhook-token mutates the webhook
 * secret, and test-plugin makes an outbound call with caller-supplied creds.
 * Consistent with the channel.*-pairing trio.
 */
/**
 * The ECC GateGuard toggle persists a config mutation that changes the env of
 * every future claude agent spawn (an attacker could silently weaken the
 * quality gate). Mutation stays local-only; the read-only status stays remote.
 */
describe('isAllowedForRemote - ecc harness providers', () => {
  it('denies subscribe-ecc.set-gate-guard for remote callers', () => {
    expect(isAllowedForRemote('subscribe-ecc.set-gate-guard')).toBe(false);
  });

  it('still allows the read-only ecc.get-status for remote callers', () => {
    expect(isAllowedForRemote('subscribe-ecc.get-status')).toBe(true);
  });
});

describe('isAllowedForRemote - channel config/auth providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'channel.enable-plugin',
    'channel.disable-plugin',
    'channel.rotate-webhook-token',
    'channel.sync-channel-settings',
    'channel.revoke-user',
    'channel.get-authorized-users',
    'channel.test-plugin',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read-only channel.get-plugin-status for remote callers', () => {
    expect(isAllowedForRemote('subscribe-channel.get-plugin-status')).toBe(true);
  });
});

/**
 * WebUI admin/auth surface must NOT be reachable by a remote (paired-device
 * WebSocket) caller. The webui.* bridge providers carry no in-handler remote
 * guard (unlike the gated webui-direct-* ipcMain handlers), so a paired browser
 * could otherwise mint/return admin credentials: start -> initialPassword,
 * reset-password -> broadcast a new plaintext admin password to every paired
 * client, generate/verify-qr-token -> a full admin session token, and
 * change-password/username rewrite the admin login with no current-password
 * check. Deny the mutating/secret-minting ops; keep the read-only views.
 */
describe('isAllowedForRemote - webui admin/auth providers denied', () => {
  const deniedKeys: ReadonlyArray<string> = [
    'webui.start',
    'webui.stop',
    'webui.change-password',
    'webui.change-username',
    'webui.reset-password',
    'webui.generate-qr-token',
    'webui.verify-qr-token',
    'webui.revoke-device',
  ];

  it.each(deniedKeys)('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it.each(['webui.get-status', 'webui.list-paired-devices', 'webui.activity-log'])(
    'still allows the read-only %s for remote callers',
    (key) => {
      expect(isAllowedForRemote(`subscribe-${key}`)).toBe(true);
    }
  );
});

/**
 * Onboarding credential-write providers must NOT be reachable by a remote
 * caller: connect-pasted-key persists an attacker-supplied provider key
 * (injection / overwrite). The read-only onboarding.infer-focus stays allowed.
 */
describe('isAllowedForRemote - onboarding credential writes denied', () => {
  it.each(['onboarding.connect-pasted-key'])('denies subscribe-%s for remote callers', (key) => {
    expect(isAllowedForRemote(`subscribe-${key}`)).toBe(false);
  });

  it('still allows the read-only onboarding.infer-focus for remote callers', () => {
    expect(isAllowedForRemote('subscribe-onboarding.infer-focus')).toBe(true);
  });
});
