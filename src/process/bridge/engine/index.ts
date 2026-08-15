/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges over the local execution substrate - the WCore engine and the
 * machine it runs on. Config, engine control and runtime diagnostics are the
 * three faces of the engine itself; hwfit scans the hardware and ranks which
 * models would fit it; cookbook is the write side of that advice, downloading
 * a model and serving it locally; llamaRuntime provisions the llama.cpp binary
 * cookbook's serve path spawns, so a fresh machine needs nothing installed by
 * hand. They belong together because each one is
 * about *running* a model on this host, as opposed to `model/`, which is about
 * choosing which model to call. Things that extend the engine's tool surface
 * live in `extensions/`.
 */

export * from './cookbookBridge';
export * from './hwfitBridge';
export * from './llamaRuntimeBridge';
export * from './wcoreConfigBridge';
export * from './wcoreDiagnosticsBridge';
export * from './wcoreEngineBridge';
export * from './extensions';
