# Releasing

A release is one command:

```bash
git tag v0.9.7-mn.12
git push origin v0.9.7-mn.12
```

That push runs `.github/workflows/build-and-release.yml`, which builds all six
platforms, computes the updater feeds, and publishes a GitHub Release with
sixteen assets. Nothing else is manual.

## The one rule: push the tag, never let a release create it

**Do not run `gh release create` for a tag that does not exist yet.**

`gh release create <tag>` creates the tag through the Releases API. A ref born
that way emits no `push` event, so no workflow starts — and afterwards
`git push origin <tag>` is a no-op (`Everything up-to-date`), so pushing it
"again" starts nothing either. That is exactly why `build-and-release.yml` had
**zero runs** in this fork while eleven releases went out by hand.

Measured 2026-08-14: `gh api repos/sergei10a-rgb/darhai/actions/workflows/<id>/runs`
returned `total_count: 0` for this workflow, while a throwaway tag pushed with
`git push` started it normally.

So the order is always:

1. Bump `package.json` and commit it (see the `bump-version` skill).
2. `git push origin main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Watch `gh run watch` — the release publishes itself.

If the release already exists as a draft from a failed earlier attempt, delete
it before re-tagging; the workflow will complete a draft but refuses to touch a
release that is already published with assets.

## What the tag push produces

Ten installers, from the six-platform matrix:

| Platform    | Assets                                                         |
| ----------- | -------------------------------------------------------------- |
| Windows     | `Darhai-<v>-win-x64.exe`, `Darhai-<v>-win-arm64.exe`           |
| macOS       | `Darhai-<v>-mac-x64.dmg`, `Darhai-<v>-mac-arm64.dmg`           |
| Linux x64   | `linux-x86_64.AppImage`, `linux-amd64.deb`, `linux-x86_64.rpm` |
| Linux arm64 | `linux-arm64.AppImage`, `linux-arm64.deb`, `linux-aarch64.rpm` |

Plus six electron-updater feeds — one per platform/arch, because electron-updater
fetches exactly one channel file whose name it derives itself and a missing one
is `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` on every check for that platform, not a
degraded update:

| Runtime       | Channel file             | Installers it carries              |
| ------------- | ------------------------ | ---------------------------------- |
| Windows x64   | `latest.yml`             | `.exe`                             |
| Windows arm64 | `latest-win-arm64.yml`   | `.exe`                             |
| macOS x64     | `latest-mac.yml`         | `.dmg`                             |
| macOS arm64   | `latest-arm64-mac.yml`   | `.dmg`                             |
| Linux x64     | `latest-linux.yml`       | `.AppImage`, `.deb`, `.rpm`        |
| Linux arm64   | `latest-linux-arm64.yml` | `.AppImage`, `.deb`, `.rpm`        |

Sixteen files total. The names are not stylistic: `latest-arm64-mac.yml` is the
channel from `getUpdateChannel()` (`src/process/services/autoUpdaterService.ts`)
with electron-updater's own platform suffix, and getting one character wrong is
indistinguishable from not shipping it.

Every installer appears in some feed, which is a hard requirement of the *other*
consumer. The in-app updater (`src/process/bridge/desktop/updateBridge.ts`) picks
an asset, downloads it, then demands a SHA-512 for that exact file name from a
`latest*.yml` on the release; with no digest it deletes the download and reports
an error rather than opening an unverified installer. On Linux the asset it
recommends is the `.deb` (or `.rpm`), never the AppImage, so a feed listing only
the AppImage leaves the recommended download unusable. Releases up to and
including v0.9.7-mn.10 shipped three feeds for ten installers: five of the six
platform/arch pairs could not update by either path.

The feeds are written by `scripts/make-updater-feeds.mjs`, not by
electron-builder. Every build runs `--publish=never` on purpose, so
electron-builder emits no `latest*.yml` at all; the script computes each feed
from the installer actually staged for upload — base64 SHA-512 (electron-updater
rejects hex) and the real byte size. Hand-writing these is how a release ends up
with a digest that does not match the file beside it, and every installed copy
then refuses to update with an opaque checksum error.

That script also owns the installer list. The workflow asks it (`--list-installers`,
`--list-feeds`) instead of restating the names, so an installer cannot be uploaded
without a channel file carrying its digest, and there is no asset-count constant
to keep in sync — which is what previously had to be edited before a missing feed
could even be added.

### macOS updates go through the DMG, not electron-updater

electron-updater's `MacUpdater` needs a `.zip` to self-update from. The mac
targets in `electron-builder.yml` do build one (`mac.target: [dmg, zip]`), but
`upload_installers_only: true` runs `rm -f out/*.zip` in `_build-reusable.yml`
before upload, so no zip reaches the release. Shipping one would not help while
this fork has no code-signing credentials — macOS builds are ad-hoc signed
(`scripts/afterSign.js`), and Squirrel.Mac will not apply an update whose
signature does not satisfy the installed app's designated requirement.

So macOS updates by downloading the new DMG through the in-app updater, and that
path works because `latest-mac.yml` / `latest-arm64-mac.yml` give the DMG its
digest. `UpdateModal.tsx` prefers the manual download whenever a compatible asset
exists, so it does not route macOS into the electron-updater path that has no zip
to fetch.

## Guards that will stop a bad release

Each of these fails the job rather than publishing something subtly wrong:

- **Tag disagrees with `package.json`.** electron-builder names installers from
  `package.json`, never from the tag, so a `v1.2.3` tag on a commit that says
  `1.2.2` would publish a release full of mismatched names and feeds pointing at
  files that do not exist.
- **An installer is missing or duplicated.** Assets are collected by exact
  expected name, one match required. A rename in `electron-builder.yml` fails
  here instead of quietly shipping five platforms.
- **A feed is missing or empty.**
- **An installer has no digest in any feed.** This is the one that catches the
  failure the whole job exists to prevent: an installer nobody can verify is a
  platform that cannot update, and it is invisible in a release listing. Both
  the release job and `Release Script Test` in `pr-checks.yml` check it.
- **The tag is already published with assets.** Re-running would replace files
  people may be mid-download on. Delete the release first, or cut a new version.
  The rule lives in `scripts/check-release-overwrite.mjs` rather than inline
  shell so `tests/unit/releaseWorkflow.test.ts` can drive all four states — as
  a workflow `if` its threshold could be raised past any real release and the
  suite stayed green.
- **`fail_on_unmatched_files`.** A release with notes and no binaries is not a
  release.

The final asset count is derived from the writer's own lists, so it is a
consistency check on the steps above rather than an independent guard — no
number in this doc or the workflow has to be edited to add a platform.

## What this fork does not have

- **No Actions environments** and **no repository secrets** (`gh api
.../environments` and `.../actions/secrets` both return `total_count: 0`). The
  release job therefore names no `environment:` and uses the built-in
  `GITHUB_TOKEN` with the `contents: write` granted at the top of the workflow.
- **No code-signing credentials.** macOS builds are ad-hoc signed and
  notarization failures are downgraded to warnings in `_build-reusable.yml`.
- **No `dev` branch.** The `create-tag` job in `build-and-release.yml` only runs
  for pushes to `dev` and depends on a `GH_TOKEN` secret that does not exist
  here, so it is dormant.

## Manual builds

`🔨 Manual Build` (`build-manual.yml`, `workflow_dispatch`) still exists for
building a branch without releasing it. It uploads installers as workflow
artifacts and publishes nothing. Use it to test a build; use a tag to ship one.
