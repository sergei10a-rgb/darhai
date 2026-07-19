# mn.6 Assimilation Charter

> Master plan for merging ECC, Superpowers, IJFW and Odysseus capabilities into
> ONE Darhai monolith — code-level, seamless, nothing dropped silently.
> Ground rules: [README.md](README.md). Evidence base: [../codemap/00-overview.md](../codemap/00-overview.md)
> (§3 master anchor table — every phase below references its anchors).

## Phases

| # | Phase | Scope | Anchors | Deliverables | Gate |
|---|---|---|---|---|---|
| 0 | **Codemap** | 17-section evidence base + master anchors | — | `docs/architecture/codemap/*` | DONE (this commit) |
| 1 | **Superpowers merge** | 14 best-of process skills into builtin sanctum per [superpowers-dedup-verdicts.json](superpowers-dedup-verdicts.json) merge_plans; default-active wiring | §3c | `src/process/resources/skills/<name>/` ×13 + `_builtin/skill-creator` grafts; `ledger/superpowers.md` | frontmatter parses; no `superpowers:` refs; format/lint green |
| 2 | **ECC content** | 271 skills → SkillLibrary source/corpus; 114 rules → prompt-composition + project knowledge; 92 commands → workflow/skill entries; 67 agents → assistant merge | §3a | conversion pipeline + converted content + `ledger/ecc-*.md` (one row per item: converted / rewritten / dropped+reason) | dedup rule: one concept = one skill (vs phase-1 winners); SkillGuard passes |
| 3 | **Native guard (ECC hooks)** | Rewrite hook LOGIC as Darhai app-level enforcement at the tool-approval boundary — works for wcore, local models, every CLI; GateGuard-style toggles in settings | §3b | guard service + approval-pipeline integration + settings pane + `ledger/ecc-hooks.md` | red-team tests for the new surface; `~/.claude` hook materialization becomes claude-CLI-only compatibility layer |
| 4 | **IJFW absorption** | Memory engine behind `ijfwMcpClient.invoke()` seam becomes an in-app module; kill external `~/.ijfw` install; data migration; keep zod trust boundary | §3d | in-app engine + migration + `ledger/ijfw.md` | old memories survive migration (tested); archive/import/wiki flows unchanged |
| 5 | **Odysseus features** | 9 features, native TS rewrites (Python is idea-source only) | §3e (per-row: service dir · bridge ns · page · i18n · analog) | per-feature vertical slices + `ledger/odysseus.md` | each slice: service + bridge (+REMOTE_DENIED for mutations) + page + i18n ×13 + unit/red-team tests |
| 6 | **One roof + branding** | Engine homes under Darhai's namespace (CLAUDE_CONFIG_DIR study incl. auth migration), third-party names disappear from UI | §3a/§3d install rows | relocation + migration + Darhai-branded naming | existing installs upgrade losslessly |

Phase 5 internal order (user-priority first): cookbook-serve → memory auto-extraction →
notes+tasks+scheduler → deep research → documents editor → compare → email triage →
calendar → web search.

## Ledger contract (binding, per README rule 1)

`docs/architecture/assimilation/ledger/<source>.md` — one row per source item:

| item | decision (converted / rewritten / dropped) | target path | evidence (commit / verdict) | notes |

No silent omissions: a dropped item MUST carry its reason.

## Sequencing & releases

- mn.5 (9 commits, incl. this docs base) ships first — awaiting serge's go.
- Phases land as mn.6.x releases, each phase independently releasable.
- Every phase follows repo law: AGENTS.md conventions, i18n gate, ≥80% coverage
  target, security review for new IPC surfaces (`REMOTE_DENIED_KEYS` for mutations).

## Known debts to absorb en route (from codemap §4)

- `archive`/`wiki`/`conversations` mn-MN-only i18n modules → register properly when
  phase 4/5 touches those surfaces (§15).
- `resolveMemoryDir()` project-scope stub → complete during phase 4 (§04).
- SkillGuard LLM seam unwired → candidate during phase 2 (§05).
- `SkillRuleGenerator.tsx` unmounted → resurrect during phase 1/2 skill-creation loop (§13).
