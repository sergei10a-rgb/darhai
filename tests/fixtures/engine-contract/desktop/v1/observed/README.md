# Observed frames — NOT part of the published contract bundle

Everything else under `desktop/v1/` is the vendored `desktop-contract-v1` bundle
as upstream published it. This directory is the one exception: it holds frames
**captured from the bundled binary**, for events the bundle declares but does
not describe.

`DEFERRED.md` (one level up) lists seven `ProtocolEvent` variants that the
production sink emits and that `producer-complete.schema.json` gives only a bare
`type` discriminator — `additionalProperties: true`, zero declared properties.
For those, "drive the real fixture" is impossible from the bundle alone, because
the bundle ships no fixture. Measuring the binary is the only honest substitute,
and inventing a payload that merely *looks* like one would prove nothing.

Keep measured data here, not next to the vendored fixtures, so nobody later
mistakes it for something upstream promised.

## `capability_activation.default.jsonl` — 24 frames

Captured 2026-08-10 from
`resources/bundled-wayland-core/win32-x64/wayland-core.exe`
(`wayland-core 0.12.26`, sha256 `6840f56a…33df`, per the bundle manifest), on
win32-x64, in an isolated empty engine home:

```sh
WAYLAND_HOME=<empty dir> ANTHROPIC_API_KEY=sk-ant-dummy \
  wayland-core.exe --json-stream < /dev/null \
  | grep '"capability_activation"'
```

The dummy key is required: with no key at all the engine exits at init before
emitting any activation frame. The whole start produced 27 frames — `ready`,
`execution_policy`, `workspace_policy`, and these 24.

Eight capabilities; six reach `ready`; `pricing_refresher`, `learned_policy` and
`smart_handoff` stop at `unavailable / disabled_by_config`; `delegate_isolation`
stops at `unavailable / isolation_not_enforced` — a different token, and a
platform fact rather than an opt-out.

## `capability_activation.smart-enabled.jsonl` — 26 frames

The same command in a second isolated home whose `config.toml` contains exactly:

```toml
[compact]
smart_enabled = true
```

`smart_handoff` then walks `declared → configured → constructed → ready`, so the
frame count is 26, not 24. That is why nothing in
`tests/unit/wcore-capabilityActivation.test.ts` asserts a frame count: 24 is the
path length of eight capabilities under one particular config, not a contract.

This pair is also the counter-check for the gate itself. If an engine bump
renames the key, the second capture stops showing `smart_handoff` at `ready`,
and any future settings toggle built on `[compact] smart_enabled` is lying to
the user. Re-capture both with the commands above after every engine bump.
