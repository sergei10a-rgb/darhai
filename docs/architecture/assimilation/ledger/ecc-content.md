# Ledger — ECC content (phase 2b)

Per-item verdicts for all 544 ECC assets live in
[../ecc-classification.md](../ecc-classification.md) (the authoritative row-by-row
ledger). This file records what phase 2b **materialized** into the Darhai
skills-library from the "keep" verdicts.

## Materialized (286 new library bodies + index entries)

| Source verdict | Count | Target | Notes |
| --- | --- | --- | --- |
| skills → keep-corpus | 174 | `bodies/skills/<category>/<name>/` | copied whole dir (SKILL.md + references), frontmatter normalized (name/category/tags), de-branded |
| skills → adapt | 19 | `bodies/skills/<category>/<name>/` | kept with the edits the verdict named (stripped tool refs, de-branded) |
| commands → workflow | 10 | `bodies/workflows/<slug>/SKILL.md` | slash mechanics rewritten to plain prose |
| commands → skill | 30 | `bodies/skills/<category>/<slug>/SKILL.md` | single-purpose prompt/checklist |
| agents → profile | 53 | `bodies/agents/<area>/<name>/SKILL.md` | persona + methodology; each given a 6–12 skill curated set in `agentProfileSkills.json` (auto-matched by tag/category overlap) |

Total library entries: 2105 → **2391**. All authored `darhai`, `source: wayland-library`,
`security.verdict: unscanned` (SkillGuard rescans lazily at load; `SKILL_SCANNER_VERSION` unchanged).

## Dropped (deferred, see classification)

| Source | Dropped | Reason class |
| --- | --- | --- |
| skills | 78 | phase-1 duplicate · claude-CLI/ECC-plugin-bound · library duplicate · broken |
| commands | 52 | ECC-plugin/install machinery · slash-only mechanics · duplicates |
| agents | 14 | tool-bound (MCP/scripts) · duplicate of existing Darhai assistant/profile |

Every dropped item carries its evidence in `ecc-classification.md`. No silent omissions.

## Rules (114) — phase 2c

3 core + 84 conditional = 87 keep; 27 drop. **Design decision:** ECC rules carry a
`paths:` glob frontmatter for a path-triggered rule system Darhai does not have, and
`projectKnowledge` is reserved for the USER's own per-project `.darhai/rules.md` (not
pre-baked standards). So the 87 keeps were converted into **skills-library reference
skills** (same corpus as the ECC skills), retrievable when an agent works in that
language — no prompt-composition change, no constitution bloat, zero risk.

| Rule tier | Kept | Target | Naming |
| --- | --- | --- | --- |
| core (common/*) | 3 | `skills/{software-engineering,security,testing-quality}/engineering-<topic>/` | `engineering-coding-style`, `engineering-security`, `engineering-testing` |
| conditional (lang/*) | 84 → **79 written** | `skills/<category>/<lang>-<topic>/` | `typescript-coding-style`, `python-security`, … |

79 written + 8 name-collisions with phase-2b skills (`cpp-testing`, `kotlin-patterns`,
`perl-*`, `web-performance`, `fsharp-testing`, `kotlin-testing` — the rule content is
already covered by the identically-named imported skill, so deduped, not lost).
Library grows 2391 → **2470**. `paths:` frontmatter dropped, bodies de-branded.

## De-brand sweep

All shipped `bodies/**` de-branded: `foundry-skills`/`obra`/`evos`/`affaan-m` authorship →
`darhai`; `everything-claude-code` → `darhai`; `superpowers:` refs stripped; `_schema.json`
author `const` updated to `darhai`; ECC homepage URLs repointed to `sergei10a-rgb/darhai`.
Residual third-party brand tokens in `bodies/`: **0** (grep-verified). This aligned the 2105
pre-existing library bodies (which still carried `foundry-skills`) with the index, which was
already `darhai` — committed separately as the author-alignment change.
