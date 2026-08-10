# Engine desktop contract (vendored)

The `desktop-contract-v1` bundle published alongside each `wayland-core`
release. It is the authoritative description of the Desktop↔engine protocol:
every command Darhai may send, every event the engine may emit, their JSON
schemas, and adversarial/compat fixtures that exercise the cases a host is
expected to survive.

**Version: `v0.12.26`** — matches `DEFAULT_WCORE_VERSION` in
`scripts/prepareWaylandCore.js`. `tests/unit/engineContractVersion.test.ts`
fails if those drift apart.

## Why it is checked in

Before this, "does the engine still speak the protocol we implement?" could
only be answered by reading code and guessing. With the bundle in-tree:

- tests can assert Darhai's `protocol.ts` against the real surface, offline;
- the adversarial fixtures become executable regression cases rather than
  documentation;
- an engine upgrade shows up as a **diff**, not a surprise at runtime.

## Layout

```
desktop/v1/
  manifest.json      every command/event with capability + criticality + correlation key
  commands/          23 example payloads, one per Desktop→engine command
  events/            52 example payloads, one per engine→Desktop event
  schema/            JSON Schema for core events, host commands, producer-complete
  types/             shared sub-object shapes
  adversarial/       83 fixtures a correct host must handle (see below)
  compat/            forward/backward-compat payloads
gap-matrix.json      generated: what Darhai implements vs what the contract defines
```

### Adversarial fixtures by subsystem

| Directory | Count | What it attacks |
|---|---|---|
| `adversarial/anvil` | 11 | receipt tampering, replay, sequence gaps, version mismatch |
| `adversarial/commands` | 16 | malformed / overflowing / unicode command payloads |
| `adversarial/events` | 6 | malformed event payloads |
| `adversarial/policy` | 6 | execution-policy revision gaps, duplicates, version mismatch |
| `adversarial/recovery` | 5 | session/turn recovery edge cases |
| `adversarial/types` | 2 | invalid durable-child shapes |
| `adversarial/workflow` | 8 | workflow lifecycle ordering |

## Refreshing after an engine bump

```bash
gh release download <tag> --repo FerroxLabs/wayland-core --pattern "*desktop-contract*"
tar -xzf wayland-core-<tag>-desktop-contract-v1.tar.gz
# replace desktop/ wholesale, then regenerate the gap matrix and run the suite
```

Do not hand-edit anything under `desktop/` — it is generated upstream
(`generator: wcore-desktop-contract-gen/13`) and carries digests
(`fixture_digest`, `schema_digest`, `source_inputs_digest`) that must stay
consistent with the release it came from.
