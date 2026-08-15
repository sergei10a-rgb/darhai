#!/usr/bin/env node
/**
 * Decide whether the release job may write to an existing GitHub release.
 *
 * WHY THIS IS NOT INLINE BASH. `build-and-release.yml` publishes with
 * `draft: false`, and the only thing standing between a re-run and a live
 * release having its binaries replaced under people mid-download is this
 * comparison. As an `if [ ... ] && [ ... ]` inside a workflow `run:` block it
 * was unreachable from any test: the threshold could be raised to a number no
 * release will ever hit and the whole suite stayed green, because the only
 * assertion available was that the step's text still contained the word
 * `exit 1`. Here the decision is a function, so a test can drive the four
 * states and a mutation of the rule turns a named test red.
 *
 * Usage (from the workflow):
 *   gh release view "$TAG" --json isDraft,assets | node scripts/check-release-overwrite.mjs "$TAG"
 *   node scripts/check-release-overwrite.mjs "$TAG" --missing   # no such release
 *
 * Exit 0 = safe to publish, exit 1 = refuse.
 */

import { readFileSync } from 'node:fs';

/**
 * @param {{ exists: boolean, isDraft?: boolean, assetCount?: number }} state
 * @returns {{ ok: boolean, reason: string }}
 */
export function decideOverwrite(state) {
  if (!state.exists) {
    return { ok: true, reason: 'no release exists yet - safe to create' };
  }
  // A draft is a failed earlier attempt: nobody can download it, so completing
  // it is the intended recovery path.
  if (state.isDraft === true) {
    return { ok: true, reason: 'existing release is still a draft - safe to complete' };
  }
  // Published but empty is also a failed earlier attempt - the release was
  // created and the upload never landed.
  if (state.assetCount === 0) {
    return { ok: true, reason: 'existing release is published but carries no assets - safe to complete' };
  }
  return {
    ok: false,
    reason: `already published with ${state.assetCount} asset(s) - publishing again would replace files people are downloading`,
  };
}

/** Read all of stdin. Returns '' when nothing is piped in. */
function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    // No pipe attached (interactive tty, or an already-closed fd 0).
    return '';
  }
}

function main() {
  const [tag, ...flags] = process.argv.slice(2);
  if (!tag) {
    console.error('usage: check-release-overwrite.mjs <tag> [--missing]   (release JSON on stdin)');
    process.exit(2);
  }

  let state;
  if (flags.includes('--missing')) {
    state = { exists: false };
  } else {
    const raw = readStdin().trim();
    if (!raw) {
      console.error(`::error::no release JSON on stdin for ${tag} - pass --missing when the release does not exist`);
      process.exit(2);
    }
    /** @type {{ isDraft?: boolean, assets?: unknown[] }} */
    const parsed = JSON.parse(raw);
    state = {
      exists: true,
      isDraft: parsed.isDraft === true,
      assetCount: Array.isArray(parsed.assets) ? parsed.assets.length : 0,
    };
  }

  const { ok, reason } = decideOverwrite(state);
  if (ok) {
    console.log(`${tag}: ${reason}`);
    return;
  }

  console.error(`::error::${tag} is ${reason}.`);
  console.error('::error::Delete the release first, or cut a new version tag.');
  process.exit(1);
}

// `import.meta.main` is not available on Node 22, so compare argv[1] instead.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('check-release-overwrite.mjs');
if (invokedDirectly) main();
