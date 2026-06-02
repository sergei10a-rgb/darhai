const { execSync } = require('child_process');

exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  // Lazy-load notarize because @electron/notarize is ESM-only
  const { notarize } = await import('@electron/notarize');

  const appName = context.packager.appInfo.productFilename;
  const appBundleId = context.packager.appInfo.id;
  const appPath = `${appOutDir}/${appName}.app`;

  // Check if app is actually signed before attempting notarization
  try {
    execSync(`codesign --verify --verbose "${appPath}"`, { stdio: 'pipe' });
    console.log(`App ${appName} is properly code signed`);
  } catch (error) {
    console.log(`App ${appName} is not code signed, applying ad-hoc signature...`);
    try {
      execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
      console.log(`Ad-hoc signature applied successfully to ${appName}`);
    } catch (adHocError) {
      console.error('Ad-hoc signing failed:', adHocError.message);
    }
    return;
  }

  // Skip notarization if credentials are not provided
  if (!process.env.appleId || !process.env.appleIdPassword) {
    console.log('Skipping notarization - missing Apple ID credentials');
    return;
  }

  console.log(`Starting notarization for ${appName} (${appBundleId})...`);

  // Notarization must never hang or hard-fail the release. Apple's notary queue
  // can stall for hours, and notarytool's `--wait` then blocks indefinitely so
  // the build never returns (observed: a release job stuck for hours). Race the
  // submission against a hard timeout and treat ANY timeout/failure as
  // best-effort: the app stays Developer-ID signed (just not stapled), which
  // installs with a one-time Gatekeeper prompt and can be re-released to staple
  // once Apple recovers. This keeps the whole multi-platform release from being
  // held hostage to Apple's queue.
  const NOTARIZE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`notarization timed out after ${NOTARIZE_TIMEOUT_MS / 60000} minutes`)),
      NOTARIZE_TIMEOUT_MS
    );
  });

  try {
    await Promise.race([
      notarize({
        tool: 'notarytool',
        appBundleId,
        appPath: appPath,
        appleId: process.env.appleId,
        appleIdPassword: process.env.appleIdPassword,
        teamId: process.env.teamId,
      }),
      timeout,
    ]);
    console.log('Notarization completed successfully');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Non-fatal on purpose — see the comment above. Surface it loudly so a
    // stalled queue is visible in the build summary, but let the build finish.
    console.warn(`::warning title=Notarization not completed::${message}`);
    console.warn(
      `⚠️ Continuing with a signed-but-unstapled build for ${appName}. Re-release to staple once Apple's notary service recovers.`
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
};
