/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every path that stores a password must use the same bcrypt cost.
 *
 * This is not a theoretical concern. The `--resetpass` CLI hashed at cost 10
 * while the web login path hashed at 12, so an admin who recovered their
 * password through the CLI ended up with the weakest credential in the system
 * - four times cheaper to brute-force than one set through the UI, with
 * nothing on screen to say so. The value now lives in one place, and these
 * tests make a second drift fail loudly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { AUTH_CONFIG } from '@process/webserver/config/constants';

const REPO_ROOT = resolve(__dirname, '../..');

/** bcrypt encodes its cost in the hash: `$2a$12$...`. */
function costOf(hash: string): number {
  const match = /^\$2[aby]?\$(\d{2})\$/.exec(hash);
  if (!match) throw new Error(`not a bcrypt hash: ${hash.slice(0, 12)}...`);
  return Number(match[1]);
}

describe('bcrypt cost factor', () => {
  it('is at least 12, the floor this app committed to', () => {
    // Lowering it is a security decision, not a refactor. If it ever needs to
    // change, this line is where the argument has to be made.
    expect(AUTH_CONFIG.PASSWORD.SALT_ROUNDS).toBeGreaterThanOrEqual(12);
  });

  it('is what a real hash actually carries', async () => {
    // Reading the constant proves nothing on its own - the call site could
    // still pass a literal. This hashes for real and reads the cost back out
    // of the resulting string.
    const hash = await bcrypt.hash('darhai-test-password', AUTH_CONFIG.PASSWORD.SALT_ROUNDS);
    expect(costOf(hash)).toBe(AUTH_CONFIG.PASSWORD.SALT_ROUNDS);
  });

  it('is not hard-coded at any bcrypt.hash call site', () => {
    // The drift happened because two files each chose their own number. A
    // grep-style guard is the only thing that catches a THIRD file doing it
    // again, since no behavioural test covers a path that does not exist yet.
    const hashingFiles = ['src/process/utils/resetPasswordCLI.ts', 'src/process/webserver/auth/service/AuthService.ts'];

    for (const relative of hashingFiles) {
      const source = readFileSync(resolve(REPO_ROOT, relative), 'utf8');

      expect(source, `${relative} does not reference the shared cost factor`).toContain(
        'AUTH_CONFIG.PASSWORD.SALT_ROUNDS'
      );

      // `hashPasswordAsync(password, 10)` and friends: a numeric literal in the
      // cost position is exactly the defect being locked out.
      const literalCost = /hashPasswordAsync\([^,)]+,\s*\d+\s*\)/.exec(source);
      expect(literalCost?.[0], `${relative} passes a literal bcrypt cost`).toBeUndefined();

      const literalBcrypt = /bcrypt\.hash\([^,)]+,\s*\d+\s*[,)]/.exec(source);
      expect(literalBcrypt?.[0], `${relative} calls bcrypt.hash with a literal cost`).toBeUndefined();
    }
  });

  it('matches the cost of the constant-time dummy hash', () => {
    // AuthService compares against a dummy hash so a missing user costs the
    // same as a wrong password. If the dummy's cost drifts from the real one,
    // that timing equalisation stops working and username enumeration returns.
    const source = readFileSync(resolve(REPO_ROOT, 'src/process/webserver/auth/service/AuthService.ts'), 'utf8');
    const dummy = /DUMMY_BCRYPT_HASH\s*=\s*'([^']+)'/.exec(source);

    expect(dummy, 'DUMMY_BCRYPT_HASH not found - has it been renamed?').toBeTruthy();
    expect(costOf(dummy![1])).toBe(AUTH_CONFIG.PASSWORD.SALT_ROUNDS);
  });
});
