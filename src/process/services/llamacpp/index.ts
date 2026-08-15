/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public surface of the llama.cpp provisioner.
 *
 * Nothing here is wired into `LocalServeManager`, the IPC bridge or the UI yet -
 * that is the next phase. The two entry points it will need are
 * {@link LlamaCppProvisioner.ensureInstalled} (download + install) and
 * {@link llamaServerCandidates} (the sync `() => string[]` that
 * `LocalServeManager`'s `llamaServerCandidates` dep expects).
 */

export {
  planLlamaAssets,
  serverBinaryName,
  cudaRuntimeDllNames,
  type LlamaAcceleration,
  type LlamaArch,
  type LlamaArchiveFormat,
  type LlamaAssetPlan,
  type LlamaAssetPlanInput,
  type LlamaAssetPlanResult,
  type LlamaAssetRef,
  type LlamaAssetRole,
  type LlamaAssetUnsupported,
  type LlamaBackendFallback,
  type LlamaFallbackCode,
  type LlamaPlatform,
} from './assetMap';

export {
  LlamaCppProvisioner,
  LlamaProvisionError,
  type LlamaInstallResult,
  type LlamaProvisionDeps,
  type LlamaProvisionErrorCode,
  type LlamaProvisionPhase,
  type LlamaProvisionProgress,
  type LlamaProvisionRequest,
} from './LlamaCppProvisioner';

export { LlamaReleaseClient, LlamaReleaseError, type LlamaRelease, type LlamaReleaseAsset } from './releaseClient';

export {
  RECEIPT_NAME,
  RECEIPT_SCHEMA,
  downloadsDir,
  installDir,
  installedServerPath,
  isInstalled,
  listInstalledTags,
  llamaRoot,
  llamaServerCandidates,
  readReceipt,
  stagingDir,
  versionsDir,
  type LlamaFsProbe,
  type LlamaInstallReceipt,
  type LlamaInstalledAsset,
} from './installLayout';

export { hasCudaRuntime, cudaSearchDirs, type CudaProbeDeps, type CudaProbeEnv } from './cudaRuntimeProbe';

export { ArchiveError, commonRootPrefix, safeEntryPath, stripRoot, type ArchiveEntry } from './archiveEntry';
export { extractZip } from './zipReader';
export { extractTarGz } from './tarReader';
