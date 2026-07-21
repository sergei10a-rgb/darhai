# Third-party notices

Darhai (Дархай) is a derivative work of **Wayland** by Ferrox Labs
(https://github.com/FerroxLabs/wayland, AGPL-3.0-or-later), which is itself built on,
and includes substantial source code from, **AionUi**. The full chain of attribution —
Darhai → Wayland → AionUi — is preserved below; the sections that follow are the
upstream notices kept intact. References to "Wayland" in these notices describe the
upstream project this fork derives from. This notice satisfies the attribution
requirement of the Apache License, Version 2.0, Section 4(c).

## AionUi

- **Project:** AionUi (aionui.com)
- **Source:** https://github.com/iOfficeAI/AionUi
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright 2025 AionUi (aionui.com)
- **Use in Wayland:** Wayland is a derivative work of AionUi. The original AionUi source
  forms the foundation of the Wayland application: the Electron main process, IPC bridge,
  renderer UI scaffolding, agent client protocol integration, MCP services, and the
  multi-CLI cowork architecture all originate from AionUi.

Per the Apache 2.0 License, Section 4(b), files modified by Wayland carry no removal of
the original copyright notices. The full Apache License is included as `LICENSE` at the
root of this repository.

## Wayland-Core (fork of aionrs)

- **Project:** Wayland-Core, a Ferrox Labs-maintained fork of aionrs
- **Upstream source:** https://github.com/iOfficeAI/aionrs
- **License:** Apache License, Version 2.0
- **Copyright:** Copyright 2025 aionrs contributors (upstream); modifications Copyright
  2026 Ferrox Labs
- **Use in Wayland:** Wayland integrates Wayland-Core as its Rust engine. Source code
  under `src/process/agent/wcore/`, `scripts/prepareWaylandCore.js`, and related
  integration points references the engine as `wayland-core`.
- **Modifications:** Per Apache-2.0 Section 4(b), the following changes have been made
  to the upstream aionrs source. See `engine/CHANGELOG.md` (Unreleased section) for the
  authoritative divergence summary:
  - All 11 workspace crates renamed (`aion-*` → `wcore-*`).
  - Compiled binary renamed (`aionrs` → `wayland-core`).
  - Default config file renamed (`.aionrs.toml` → `.wcore.toml`).
  - User config directory renamed (`~/.aionrs` → `~/.wcore`).
  - New `WCORE_*` env vars and template tokens added as primary names; legacy
    `AIONRS_*` forms retained as backward-compat aliases.
  - Original aionrs Apache-2.0 copyright headers are preserved in all forked source
    files.

---

## Darhai-specific integrations (MIT-licensed)

Beyond the upstream Wayland → AionUi → aionrs chain, Darhai integrates several
independent MIT-licensed projects. Each MIT license requires its copyright and
permission notice to be reproduced; the notices are consolidated below, and where a
project is bundled as-is its own `LICENSE` file is also retained in its bundle
directory. Some of these were reimplemented from scratch in TypeScript (only the
ideas/behavior were adopted, no source copied) and are credited here as a courtesy;
the distinction is noted per entry.

### ECC (everything-claude-code)

- **Project:** ECC — <https://github.com/affaan-m/ECC>
- **License:** MIT
- **Copyright:** Copyright (c) 2026 Affaan Mustafa
- **Use in Darhai:** The ECC agent harness (rules, skills, agents, commands) is
  bundled at `resources/bundled-ecc/` with its original `LICENSE` retained, and is
  installed into the user's `~/.claude` on first run. Portions of the ECC skill
  corpus were adapted into Darhai's skills library
  (`src/process/resources/skills-library/`).

### IJFW Memory

- **Project:** `@ijfw/memory-server`
- **License:** MIT
- **Copyright:** Copyright (c) Sean Donahoe
- **Use in Darhai:** The IJFW Memory MCP server is bundled at
  `resources/bundled-ijfw/mcp-server/` and seeded into `~/.ijfw/mcp-server` on first
  run to power the local memory engine.

### Superpowers

- **Project:** Superpowers (Anthropic) — official Claude Code plugin
- **License:** MIT
- **Copyright:** Copyright (c) Anthropic
- **Use in Darhai:** Fourteen process skills were adapted from the Superpowers
  skill set into Darhai's built-in process skills.

### Odysseus

- **Project:** Odysseus — <https://github.com/pewdiepie-archdaemon/odysseus>
- **License:** MIT
- **Copyright:** Copyright (c) 2025 Odysseus Contributors
- **Use in Darhai:** Nine end-user features (model compare, web search, notes,
  calendar, documents, deep research, email triage, local model cookbook, memory
  auto-extract) were **reimplemented from scratch in TypeScript** based on the
  Odysseus feature set. No Odysseus source code is included.

### OmniRoute

- **Project:** OmniRoute — MIT-licensed AI gateway
- **License:** MIT
- **Use in Darhai:** Engineering ideas only (token compression, routing strategies,
  provider resilience) were **reimplemented natively in TypeScript**. No OmniRoute
  source code is included; credited as a courtesy.

> The full text of the MIT License permission notice applies to each of the above:
> permission is granted free of charge to use, copy, modify, merge, publish, and
> distribute, provided the copyright notice and this permission notice are included.
> The bundled projects (`resources/bundled-ecc/`, `resources/bundled-ijfw/`) retain
> their own upstream license files.

---

### How to update this file

When Darhai adds, removes, or substantially modifies its dependency on an Apache-2.0,
MIT, or similarly attribution-required upstream, edit this file. Never remove an
existing upstream notice. Do not edit `LICENSE` - that is the canonical license text
and must remain unchanged.
