# ECC Assimilation — Phase 2a Classification Ledger (draft)

> **Status**: phase-2a classification complete (2026-07-20). This document IS the
> phase-2 ledger draft required by [README.md](README.md) ground rule 1 and the
> [CHARTER.md](CHARTER.md) ledger contract: **one row per source item, no omissions,
> every drop carries its reason.** Verdicts are final for phase 2a; per-item conversion
> evidence (target path, commit) lands in `ledger/ecc-*.md` as the conversion pipeline
> executes. Anchor base: [../codemap/00-overview.md](../codemap/00-overview.md) §3a.

Source: vendored ECC bundle (`resources/bundled-ecc`) — 271 skills, 92 commands,
67 agents, 114 rules. ECC **hooks** are intentionally out of scope here: hook LOGIC
is rewritten natively as the Darhai tool-approval guard in phase 3 (charter row 3);
the dropped `*/hooks.md` rule files below are the prompt-side face of that same lane.

## 1. Summary

| Category | Verdict | Count | Conversion destination |
| --- | --- | ---: | --- |
| skills | `keep-corpus` | 174 | skills-library corpus (index.json + bodies/) |
| skills | `adapt` | 19 | corpus after edit pass (gateguard: native tool-gate, phase 3) |
| skills | `drop` | 78 | not converted (reason per row) |
| **skills** | **total** | **271** | |
| commands | `workflow` | 10 | type:'workflow' library entry (workflow runtime) |
| commands | `skill` | 30 | corpus skill entry |
| commands | `drop` | 52 | not converted (reason per row) |
| **commands** | **total** | **92** | |
| agents | `profile` | 53 | agent-profile corpus entry + agentProfileSkills curation |
| agents | `drop` | 14 | not converted (reason per row) |
| **agents** | **total** | **67** | |
| rules | `core` | 3 | constitution overlay (always-on prompt composition) |
| rules | `conditional` | 84 | projectKnowledge per-project-type load |
| rules | `drop` | 27 | not converted (reason per row) |
| **rules** | **total** | **114** | |
| **all** | **grand total** | **544** | |

### Verdict vocabulary

| Category | Verdict | Meaning / destination |
| --- | --- | --- |
| skills | `keep-corpus` | Convert as-is into the skills-library corpus (`index.json` + `bodies/`). |
| skills | `adapt` | Corpus after a documented edit pass (de-brand ECC/claude-CLI framing, re-map `~/.claude` machinery to Darhai surfaces). Exception: `gateguard` adapts into a **native tool-gate**, not corpus — see spotlight. |
| skills | `drop` | Not converted. Drop criteria referenced in reasons: **a** = absorbed in phase 1 (superpowers merge), **b** = hard-bound to machinery Darhai does not ship (claude-CLI config/hooks, external MCP, ECC scripts), **c** = near-duplicate of an existing skills-library entry, **d** = superseded or broken. |
| commands | `skill` | Body is a self-contained playbook → convert to a normal corpus skill entry. |
| commands | `workflow` | Multi-phase orchestration playbook → `type:'workflow'` library entry driven by the workflow runtime. |
| commands | `drop` | ECC plugin/install/session/hook machinery or duplicate of a classified skill. |
| agents | `profile` | Convert to a `type:'agent-profile'` corpus entry + curated `agentProfileSkills.json` row → assistant merge. |
| agents | `drop` | Tool-bound or duplicate of an existing library agent-profile / Darhai skill. |
| rules | `core` | Always-on, engine-neutral discipline → constitution overlay in prompt composition. |
| rules | `conditional` | Language/framework layer → per-project-type knowledge load (path-frontmatter gated). |
| rules | `drop` | Almost entirely the claude-CLI hook-config lane (returns natively in phase 3) or duplicates of Darhai AGENTS.md / kept skills. |

## 2. Classification tables (full ledger — one row per source item)

### 2.1 Skills (271)

| name | verdict | reason |
| --- | --- | --- |
| accessibility | keep-corpus | WCAG 2.2 AA design+implement+audit guide; library accessibility-review is narrower (review-only, WCAG 2.1) so not a near-duplicate. |
| agent-architecture-audit | keep-corpus | 12-layer agent-app diagnostic (wrapper regression, memory pollution); distinct from library ai-agent-builder which covers build-side patterns, not auditing. |
| agent-eval | keep-corpus | Head-to-head coding-agent comparison methodology with YAML task/judge harness; grep shows 0 claude-CLI machinery refs; no library counterpart. |
| agent-harness-construction | keep-corpus | Action-space/tool-definition/observation-format design knowledge; engine-neutral, no library duplicate. |
| agent-introspection-debugging | keep-corpus | Capture/diagnose/contained-recovery workflow for agent failures; complements but does not duplicate phase-1 systematic-debugging (which targets code bugs, not agent-run failures). |
| agent-payment-x402 | keep-corpus | Niche x402/agentwallet-sdk payment-integration knowledge; library wallet hits (wallet-security-advisor etc.) are end-user finance topics, not agent payment rails. |
| agent-self-evaluation | keep-corpus | 5-axis output scorecard rubric (7 files); not covered by phase-1 verification-before-completion (evidence verification, not quality self-rating); 0 machinery refs. |
| agent-sort | drop | Whole purpose is building ECC install plans (DAILY vs LIBRARY buckets over ECC skills/commands/rules/hooks) — ECC-bundle machinery made obsolete by Darhai shipping ECC as a searchable corpus (criterion b). |
| agentic-engineering | keep-corpus | Compact eval-first/decomposition/model-tier-routing operating principles (2kb); engine-neutral, no library duplicate. |
| agentic-os | adapt | Target corpus, but 14 claude-CLI machinery refs (~/.claude paths, CLAUDE.md, slash-command wiring) must be re-mapped to Darhai host concepts (assistants, skills, cron tools) and de-branded. |
| ai-first-engineering | keep-corpus | Team-level AI-first operating model (process/review/architecture shifts); engine-neutral, no library counterpart. |
| ai-regression-testing | keep-corpus | Sandbox-API regression strategy + same-model-writes-and-reviews blind-spot patterns; only 1 trivial claude ref; library qa-engineer/visual-regression-tester cover different ground. |
| android-clean-architecture | keep-corpus | Clean-Architecture module/dependency rules for Android+KMP; library android-developer covers MVVM/stack breadth, not this layering discipline — not a near-duplicate. |
| angular-developer | keep-corpus | 36-file/132kb comprehensive Angular reference (signals, SSR, forms, testing); library has only narrow angular-signals-patterns and angular-testing-patterns. |
| api-connector-builder | keep-corpus | Match-the-repo's-existing-integration-pattern how-to for adding providers; engine-neutral, no library duplicate. |
| api-design | drop | Near-duplicate of library api-designer + rest-api-design (resource naming, pagination, filtering, versioning, error formats, rate limiting all covered there) — criterion c. |
| architecture-decision-records | drop | Nygard ADR format + ADR log duplicated by library adr-writing (and architecture-documenter); its only residue is Claude-Code-session auto-detect glue — criterion c. |
| article-writing | drop | Umbrella covered piecewise by library long-form-article, blog-post-writing, tutorial-writing, newsletter-writing (formats) and ghostwriter (source-derived voice adaptation) — criterion c. |
| automation-audit-ops | adapt | Keep/merge/cut automation-inventory workflow is portable ops knowledge; target corpus after stripping ECC branding and ECC skill-stack cross-refs (ecc-tools-cost-audit is ECC-sibling-repo-specific). |
| autonomous-agent-harness | adapt | Valuable autonomous-operation patterns but 10 machinery refs to Claude Code native crons/dispatch/~/.claude; target corpus with refs re-mapped to Darhai's own scheduler/task/memory surfaces. |
| autonomous-loops | adapt | 25kb of loop/DAG architecture patterns worth keeping, but 38 claude-CLI refs (claude -p invocations, ~/.claude) must be rewritten engine-neutral before corpus conversion. |
| backend-patterns | keep-corpus | Broad Node/Express/Next.js server-side reference; library has persona backend-architect plus topical pattern entries but no single near-duplicate of this consolidated doc. |
| benchmark | keep-corpus | Baseline/regression performance measurement workflow (2kb); library 'benchmark' hits are unrelated domains (compensation, market research). |
| benchmark-methodology | keep-corpus | 9-dimension weighted competitor scoring with 1-5 rubrics; middle link of the competitive-platform-analysis → competitive-report-structure chain (both later in inventory) — must survive together. |
| benchmark-optimization-loop | keep-corpus | Recursive measured-variant optimization loop; distinct from 'benchmark' (baseline capture) and no library counterpart. |
| blender-motion-state-inspection | keep-corpus | Rig/pose/retargeting state-inspection technique beyond screenshots; 0 machinery refs, MCP-agnostic; library blender hits are unrelated (3d-printing-guide etc.). |
| blueprint | drop | Ledger superpowers.md §writing-plans counterpart row: README-form whose promised catalogs are missing from the files (broken), and the planning concept was absorbed into phase-1 writing-plans — criteria a+d. |
| brand-discovery | keep-corpus | 8-module resumable brand-identity interview methodology (laddering, 5 Whys, projective techniques, 90_SYNTHESIS.md brandbook); no library counterpart. |
| brand-voice | drop | Near-duplicate of library voice-tone-guide (brand voice/tone documentation with samples) plus ghostwriter (voice adaptation from real source material) — criterion c. |
| browser-qa | adapt | Unique post-deploy smoke workflow (blast-radius safety, CWV thresholds) not in library (browser-automator/visual-regression-tester are tool-pattern refs); needs claude-in-chrome MCP ref de-branded to generic host browser tooling before corpus conversion. |
| bun-runtime | keep-corpus | Bun runtime/package-manager/test-runner reference; directly relevant since Darhai itself builds with bun; no library duplicate. |
| canary-watch | keep-corpus | Post-deploy URL/SSE/asset/console verification workflow; library cicd-architect/service-mesh-operator do not cover this smoke-canary lane. |
| carrier-relationship-management | keep-corpus | 23kb freight/carrier domain expertise (scorecards, RFPs, routing guides); pure knowledge, no library counterpart. |
| cisco-ios-patterns | keep-corpus | Cisco IOS/IOS-XE review and change-window knowledge; part of the network-* domain cluster, no library duplicate. |
| ck | drop | Hard-bound to claude-CLI machinery: /ck:* slash commands running Node scripts at ~/.claude/skills/ck/commands/ with ~/.claude/ck data dir and CC native memory — Darhai ships its own project-memory system (criterion b). |
| claude-devfleet | drop | Ledger superpowers.md §dispatching-parallel-agents counterpart row: bound to localhost:18801 MCP server, non-portable, nothing grafted — criteria a+b. |
| click-path-audit | keep-corpus | State-sequence audit for buttons that individually work but cancel each other; a distinct technique explicitly positioned for when systematic-debugging (phase-1) finds nothing — complement, not duplicate. |
| clickhouse-io | drop | Near-duplicate of library clickhouse-analyst (MergeTree engines, materialized views, query optimization, ingestion, partition management all covered) — criterion c. |
| code-tour | keep-corpus | CodeTour .tour authoring with persona-targeted walkthroughs; 0 machinery refs; library 'tour' hits are unrelated domains (music-industry, eco-travel). |
| codebase-onboarding | adapt | Ерөнхий repo-судалгааны сайн workflow (234 мөр) боловч гаралт нь «starter CLAUDE.md» + «setting up Claude Code» гэж claude-CLI-д хүрээлэгдсэн — corpus-т оруулахдаа CLAUDE.md→host-neutral AGENTS.md/agent-guide болгож, Claude Code framing-ийг Дархай-neutral болгох; library-ийн legacy-code-archaeologist нь reverse-engineering тал тул давхардал биш. |
| codehealth-mcp | drop | CodeScene MCP server (@codescene/codehealth-mcp, CS_ACCESS_TOKEN, mcp-configs/mcp-servers.json, ECC_DISABLED_MCPS)-д бүхэлдээ уяатай — Дархай тээхгүй гадаад MCP machinery (criterion b). |
| coding-standards | drop | Library-ийн clean-code (naming, function design, SOLID, DRY, code organization)-ийн near-duplicate; error-handling хэсэг нь sibling ECC error-handling skill-тэй давхардана, мөн ECC rules/common/coding-style.md давхаргад cross-ref-тэй (criterion c). |
| competitive-platform-analysis | keep-corpus | Гурван-skill competitive pipeline-ийн 1-р шат (competitor-set scoping, Direct/Adjacent/Aspirational tier); library-ийн competitive-analysis/competitive-analyst нь ерөнхий матриц бөгөөд энэ positioning-brief-first scoping арга зүйг хамардаггүй. |
| competitive-report-structure | keep-corpus | Мөн pipeline-ийн 3-р шат — scored cards→decision-grade report (white-space, strategic tension map); library-д report-assembly түвшний ийм entry алга, pipeline-ээ бүтэн авч үлдээнэ. |
| compose-multiplatform-patterns | keep-corpus | KMP/Compose Multiplatform (iOS/Desktop/Web target) патернууд — library-ийн android-compose-patterns, jetpack-compose-dev нь Android-only тул multiplatform тал нь нэмүү мэдлэг. |
| config-gc | drop | ~/.claude layout (skills/, memory/, hooks/, settings.json, .claude.json, gc_log.md)-ийн GC процедур — claude-CLI config machinery-д бүхэлдээ уяатай (criterion b). |
| configure-ecc | drop | ECC-ийн interactive installer: ECC repo clone, /plugin install ecc@ecc, ~/.claude зам руу хуулах алхмууд — ECC plugin machinery өөрөө (criterion b); Дархай ECC-г bundled corpus-оор шингээж буй тул installer утгагүй. |
| connections-optimizer | keep-corpus | X/LinkedIn network-ийг review-first prune/expand хийх арга зүй; x-api, lead-intelligence гэдэг нь «Preferred» sibling-corpus лавлагаа (хатуу binding биш); library-ийн linkedin-optimizer нь profile-optimization тул давхардахгүй. |
| content-engine | keep-corpus | Platform-native, voice-first контент систем (X/LinkedIn/TikTok/YouTube/newsletter) — library-ийн content-repurposer/newsletter-* нь format-хөрвүүлэлт талдаа, энэ нь source-first + brand-voice давхаргатай нэгдсэн систем тул нэмүү. |
| content-hash-cache-pattern | keep-corpus | SHA-256 content-hash кэшийн инженерийн патерн (path-independent, auto-invalidating) — library-д дүйцэх entry алга, tool-binding-гүй цэвэр мэдлэг. |
| context-budget | drop | Аудитын процедур нь бүхэлдээ claude-CLI компонент layout (agents/*.md, skills/*/SKILL.md, rules/**, .mcp.json, /context-budget команд)-д уяатай (criterion b); Дархайн skills-library-д шууд буухгүй. |
| continuous-agent-loop | drop | 46 мөрийн туранхай router: /quality-gate, /harness-audit ECC slash + ralphinho-rfc-pipeline/nanoclaw-repl рүү чиглүүлэхээс өөр бие даасан агуулгагүй (criterion b); autonomous-loops-ийг «суперсийд» гэдэг ч өөрөө индекс төдий. |
| continuous-learning | drop | Өөрийн description-даа [DEPRECATED - use continuous-learning-v2] гэж зарлагдсан v1 stop-hook extractor — v2 нь strict superset (criterion d). |
| continuous-learning-v2 | drop | Claude Code PreToolUse/PostToolUse hooks, ~/.claude/homunculus + ecc-homunculus XDG storage, instinct CLI/evolve командуудад бүхэлдээ уяатай learning-инфра (criterion b) — Дархайн engine-д хуулбарлагдахгүй, концепц нь тусдаа engine-ажил. |
| cost-aware-llm-pipeline | keep-corpus | Model-routing, budget tracking, retry, prompt caching — provider-neutral LLM зардлын патернууд; library-ийн llm-integrator нь API integration талдаа тул давхардал сул. |
| cost-tracking | drop | ECC-ийн stop:cost-tracker hook-ийн бичдэг ~/.claude/metrics/costs.jsonl лог дээр бүрэн тулгуурласан — Дархай тээхгүй ECC hook machinery (criterion b). |
| council | keep-corpus | Дөрвөн-дуут (Skeptic/Pragmatist/Critic) шийдвэрийн сахилга — phase-1-ийн 14 builtin-д байхгүй, санамсаргүй subagent хэрэглээ нь Дархайд буудаг; library-д council/structured-disagreement дүйцэл олдсонгүй. Near-always хэрэггүй тул builtin биш corpus. |
| cpp-coding-standards | keep-corpus | C++ Core Guidelines-д суурилсан стандарт — skills-library index-д 'c++' огт алга (0 hit), цоорхой нөхнө. |
| cpp-testing | keep-corpus | GoogleTest/CTest/sanitizer мэдлэг — library-д C++ testing entry огт алга, цоорхой нөхнө. |
| crosspost | keep-corpus | Платформ-тусгай хувилбарчлалын арга зүй (identical copy хориглоно); content-engine/brand-voice sibling-corpus ref-үүд л бий, tool-binding-гүй; library-д crosspost дүйцэл алга. |
| csharp-testing | drop | Library-ийн csharp-testing-patterns (xUnit, Moq, FluentAssertions, WebApplicationFactory, test architecture)-ийн near-duplicate — сэдэв, stack, хамрах хүрээ бараг ижил (criterion c). |
| customer-billing-ops | keep-corpus | Billing ops runbook (refund triage, duplicate subscription, churn) — «connected billing tools such as Stripe» гэсэн зөөлөн, tool-agnostic хэллэгтэй; library-ийн payment-system-architect нь integration-архитектур тул өөр өнцөг. |
| customs-trade-compliance | keep-corpus | HS/HTS ангилал, FTA, denied-party screening, penalty mitigation — жинхэнэ domain expertise (Apache-2.0); library-д «customs» нь зөвхөн аяллын ёс заншил тул давхардалгүй. |
| dart-flutter-patterns | keep-corpus | 564 мөр copy-paste-ready код: Dart null safety, Freezed, Dio, testing, GoRouter — library-ийн flutter-architect/flutter-state-management-аас өргөн superset (хэлний түвшний Dart патернууд + networking/error handling нэмэлттэй) тул near-duplicate биш. |
| dashboard-builder | keep-corpus | Operator-question-driven monitoring dashboard (Grafana/SigNoz) — library-ийн dashboard-designer нь BI/analytics (Metabase/Looker) чиглэлтэй тул observability тал нь нэмүү. |
| data-scraper-agent | keep-corpus | 765 мөрийн end-to-end бие даасан гарын авлага (requests/Playwright + Gemini Flash + GitHub Actions + Notion/Sheets/Supabase, бүгд үнэгүй stack) — library-ийн web-scraper/web-scraping-engineer нь техник төдий, agent-бүтээх дамжлага нь нэмүү. |
| data-throughput-accelerator | keep-corpus | Ingestion/backfill/ETL-ийг correctness хадгалан хурдасгах патернууд — library-ийн etl-architect/data-pipeline нь дизайн талдаа, throughput-acceleration өнцөг нь нэмүү. |
| database-migrations | drop | Library-ийн database-migration-expert (zero-downtime, backfill) + database-migration-patterns + data-migration гурвуул нэг сэдвийг хамарсан — near-duplicate (criterion c); ORM-тусгай жижиг ялгаа нь orm-specialist-д мөн бий. |
| deep-research | drop | «MCP Requirements: firecrawl/exa» гэж хатуу шаардсан, өөрөө «drift-prone» гэж анхааруулсан — Дархай тээхгүй MCP-д уяатай (criterion b); library-ийн research-orchestrator multi-source research-ийг engine-neutral хамардаг (criterion c). |
| defi-amm-security | keep-corpus | AMM-тусгай checklist (donation/inflation attack, CEI, slippage) — library-ийн blockchain-security-auditor ерөнхий ангилал тул AMM гүнзгийрэл нь нэмүү мэдлэг. |
| deployment-patterns | drop | Library-ийн deployment-strategies (blue-green/canary/rolling) + cicd-architect + ci-cd-pipeline-design хамтдаа агуулгыг нь бүрэн хамарна — near-duplicate (criterion c); Docker тал нь sibling docker-patterns skill-д тусдаа бий. |
| design-system | keep-corpus | Codebase-scan→token extraction→DESIGN.md generate + 10-хэмжээст visual audit гэсэн үйлдлийн workflow — library-ийн design-system-foundations/component-library нь spec-бичих чиглэлтэй тул audit-mode нь давхардахгүй; «browser MCP» дурдалт нэг optional алхам төдий. |
| django-celery | keep-corpus | Django+Celery тусгай (beat, canvas, retries) — library-д 'django' 0 hit, background-job-designer нь framework-neutral тул цоорхой нөхнө. |
| django-patterns | keep-corpus | DRF, ORM, caching, signals, middleware — library-д Django entry огт алга (0 hit), том цоорхой нөхнө. |
| django-security | keep-corpus | Django-тусгай CSRF/XSS/SQLi + secure deployment config — library-д Django counterpart алга, security-auditor нь framework-neutral. |
| django-tdd | keep-corpus | pytest-django, factory_boy, DRF testing — stack-тусгай тул phase-1 builtin test-driven-development-ийн процесс-сахилгатай давхардахгүй (ledger нь зөвхөн generic ecc tdd-workflow-г хассан); library-д Django testing алга. |
| django-verification | keep-corpus | Django-тусгай verification runbook (migrations check, coverage, security scan) — phase-1 builtin verification-before-completion нь ерөнхий сахилга, ledger-ийн хассан ecc verification-loop нь generic хувь; Django-хэрэглэгчийн corpus мэдлэг болж үлдэнэ. |
| dmux-workflows | drop | Ledger superpowers.md counterpart мөр (§dispatching-parallel-agents): «tmux/dmux + ECC script-д уяатай; юу ч залгаагүй» — phase-2-т хасахаар түр хойшлуулсан drop-ийг энд гүйцэтгэнэ (criterion a+b). |
| docker-patterns | drop | Near-duplicate of skills-library docker-compose-patterns + docker-production-patterns (plus docker-engineer, docker-quick-fix) which together cover the same span: compose/local-dev, container security, networking, orchestration. |
| documentation-lookup | drop | Hard-bound to Context7 MCP machinery — entire body is resolve-library-id/query-docs invocation steps plus ~/.claude.json claude-CLI config; zero standalone knowledge value without that MCP, which Darhai does not ship. |
| dotnet-patterns | drop | Near-duplicate of skills-library csharp suite (csharp-modern-idioms, csharp-async-patterns, csharp-aspnet-patterns, csharp-project-setup, csharp-performance, csharp-testing-patterns) covering the same DI/async-await/idioms ground. |
| dynamic-workflow-mode | keep-corpus | Engine-neutral harness-design discipline (task-local harness template, decision tree, eval gates, handoff artifacts) directly relevant to Darhai as an agent host; only trigger phrasing mentions Claude Code, content is portable. |
| e2e-testing | drop | Near-duplicate of skills-library e2e-test-architect (Playwright, POM, wait strategies, flaky mgmt, CI integration) + e2e-testing-patterns — identical coverage to its own description line-for-line. |
| ecc-guide | drop | Hard-bound to ECC repo machinery: runs node scripts/ci/catalog.js and scripts/install-plan.js, navigates ECC README/commands/hooks/install profiles Darhai does not ship; ledger superpowers.md row 'ecc ecc-guide' deferred it here for own-merit evaluation — no standalone value survives. |
| ecc-tools-cost-audit | drop | Hard-bound to the sibling ECC-Tools repo (webhook handlers, queue workers, GitHub App billing paths) per its own Scope Guardrails ('work in the sibling ECC-Tools repo'); no portable content. |
| email-ops | adapt | Core evidence-first mailbox operator workflow (draft-first, Sent-folder proof, account discipline) is portable to Darhai's mail integrations → target skills-library corpus; edits: remove the ECC-native Skill Stack section (brand-voice, investor-outreach, customer-billing-ops, knowledge-ops, research-ops), the messages-ops handoff ref, and 'for ECC' framing. |
| energy-procurement | keep-corpus | 30KB dense C&I energy procurement domain expertise (tariffs, PPAs, hedging, demand charges); library's only neighbor energy-optimizer is consumer home-energy — no overlap; frontmatter desc uses '>' block scalar but parses fine, not broken. |
| enterprise-agent-ops | keep-corpus | Long-lived agent workload operations knowledge (observability, security boundaries, lifecycle) with no skills-library counterpart and direct relevance to Darhai's agent-hosting domain. |
| error-handling | drop | Near-duplicate of skills-library error-handler (hierarchy design, retries, graceful degradation, user-facing messages, boundaries) plus per-language go-error-handling/python-error-handling/nodejs-error-handling/rust-error-handling covering its TS/Python/Go span. |
| eval-harness | adapt | EDD for agent sessions (capability/regression evals, grader types, pass@k) is valuable to Darhai as an agent host and distinct from library's ML-model-eval entries (ai-evaluation-patterns, model-evaluator) → target corpus; edits: de-brand 'Claude Code sessions' to engine-neutral agent-session wording throughout. |
| evm-token-decimals | keep-corpus | Niche, concrete EVM decimal-mismatch prevention knowledge (runtime lookup, bridged-token drift, normalization); no skills-library counterpart (crypto entries are consumer-finance guides). |
| exa-search | drop | Hard-bound to Exa MCP server (npx exa-mcp-server + EXA_API_KEY in ~/.claude.json, tool-surface docs for web_search_exa/get_code_context_exa); self-declared drift-prone; nothing survives without the MCP. |
| fal-ai-media | drop | Hard-bound to fal.ai MCP server (npx fal-ai-mcp-server + FAL_KEY in ~/.claude.json, MCP tool catalog); self-declared drift-prone model/pricing data; no portable knowledge beyond the paid tool surface. |
| fastapi-patterns | keep-corpus | FastAPI/Pydantic v2/DI/async/testing reference with zero skills-library counterpart (index grep for 'fastapi' returns nothing). |
| finance-billing-ops | drop | Hard-bound to ECC-the-product's own revenue operations (Stripe MRR of ECC, team-seat/quota truth in ECC code, sibling-repo github-ops stack refs); the reusable customer-remediation half already lives in customer-billing-ops (separate inventory item). |
| flox-environments | keep-corpus | Unique Flox/Nix declarative environment knowledge (manifest.toml, flox activate, service pinning); index grep for 'flox\|nix' returns nothing. |
| flutter-dart-code-review | keep-corpus | Library-agnostic Flutter/Dart review checklist; skills-library flutter-architect/flutter-architecture-patterns/flutter-state-management cover build-time architecture, none provide a review checklist — complementary, not duplicate. |
| foundation-models-on-device | keep-corpus | Unique Apple FoundationModels (iOS 26+) knowledge — @Generable guided generation, tool calling, snapshot streaming; no skills-library counterpart. |
| frontend-a11y | keep-corpus | React/Next-specific a11y code patterns with tsx examples (htmlFor pairing, ARIA misuse, focus mgmt in components); library accessibility-auditor/wcag-compliance-auditor are audit-methodology oriented, not framework code patterns — complementary; '>' desc is a YAML block scalar, not broken. |
| frontend-design-direction | adapt | Portable design-direction discipline (purpose/audience/tone/memorable-detail/constraints before coding) → target corpus; edits: strip 'ECC-specific' branding, the PR #1659 salvage provenance note, and the anthropics/skills upstream-install pointer. |
| frontend-patterns | drop | Near-duplicate of skills-library react-component-patterns + react-state-management + react-performance-patterns + nextjs-app-router-patterns/nextjs-data-patterns covering the same composition/state/fetching/perf/forms span. |
| frontend-slides | keep-corpus | Code-generating HTML/animated web presentation + PPTX-to-web conversion workflow; library slide skills (slide-design-principles, presentation-builder, pitch-deck-structure) are content/design guidance, not web implementation — distinct. |
| fsharp-testing | keep-corpus | F# testing (xUnit, FsUnit, Unquote, FsCheck property-based) with zero skills-library counterpart (index grep for 'fsharp\|f#' returns nothing). |
| gan-style-harness | keep-corpus | Generator-Evaluator adversarial harness design knowledge directly relevant to Darhai's agent-orchestration domain; no skills-library counterpart; engine-neutral concepts. |
| gateguard | adapt | Per the darhai-ecc-bundling decision (GateGuard as env-toggled Darhai feature), target = native Darhai tool-gate, not corpus: port the DENY/FORCE/ALLOW three-stage logic and per-gate fact demands from claude-CLI PreToolUse hook machinery into Darhai's tool pipeline with an env toggle; strip hooks.json wiring. |
| generating-python-installer | keep-corpus | Unique commercial Python packaging depth (Nuitka extreme compilation, dist slimming, DLL analysis, Inno Setup); no library counterpart; bilingual Chinese trigger text in description is harmless and normalized at corpus conversion. |
| git-workflow | drop | Exact-name near-duplicate of skills-library git-workflow (branching strategies, commit conventions, merge vs rebase, conflict resolution, CI) plus git-branching-strategy and git-pr-workflow covering the remainder. |
| github-ops | keep-corpus | gh-CLI operational playbook (issue triage, PR mgmt, releases, stale items, security monitoring); library only covers GitHub Actions CI/CD (github-actions, github-actions-patterns) — repo-operations gap is real. |
| golang-patterns | drop | Near-duplicate of skills-library go suite: go-idioms + go-api-patterns + go-concurrency-patterns + go-performance + go-project-setup + go-error-handling jointly cover its idiomatic-Go span. |
| golang-testing | drop | Near-duplicate of skills-library go-testing-patterns whose description matches point-for-point: table-driven tests, benchmarks, fuzz testing, test organization. |
| google-workspace-ops | keep-corpus | Connector-agnostic Workspace operator workflow (find→inspect→edit discipline, dedupe, migration) that names no MCP tool IDs or claude-CLI config — portable to any Drive/Docs/Sheets/Slides integration Darhai wires up. |
| healthcare-cdss-patterns | keep-corpus | Deep CDSS engineering patterns (drug interactions, NEWS2/qSOFA scoring, alert severity); library healthcare entries (healthcare-compliance-navigator, clinical-trial-navigator) are business/consumer-facing — no engineering overlap. |
| healthcare-emr-patterns | keep-corpus | EMR/EHR engineering patterns (encounter workflows, prescription generation, clinical-safety UI); nearest library entry health-tech-developer is generic — no near-duplicate. |
| healthcare-eval-harness | keep-corpus | Patient-safety deployment gate knowledge (CDSS accuracy suites, PHI-exposure tests, blocking deploys on safety failures); unique — completes the healthcare-* engineering set with cdss/emr/phi siblings. |
| healthcare-phi-compliance | keep-corpus | PHI/PII engineering compliance depth (data classification, audit trails, leak vectors); library compliance-checker is generic security posture — HIPAA-specific engineering content has no counterpart. |
| hermes-imports | drop | Hard-bound to the Hermes operator shell and ECC release-pack publication pipeline ('Hermes is the operator shell, ECC is the reusable workflow layer', ~/.hermes paths); its sanitization checklist is generic but the workflow target does not exist in Darhai. |
| hexagonal-architecture | drop | Exact-name duplicate of skills-library hexagonal-architecture (skills/software-engineering/hexagonal-architecture) covering the same Ports & Adapters / dependency-inversion ground. |
| hipaa-compliance | keep-corpus | Thin HIPAA overlay with self-contained decision gates/guardrails; routes by name to sibling ECC skills (healthcare-phi-compliance, security-review) that live in the same corpus; library hipaa hits (healthcare-compliance-navigator, compliance-checker) are broad compliance personas, not this dev-workflow overlay. |
| homelab-network-readiness | keep-corpus | Self-contained pre-change readiness checklist; library grep homelab/vlan/wireguard = 0 hits, no duplicate. |
| homelab-network-setup | keep-corpus | Self-contained home-network planning knowledge; no library counterpart (homelab grep = 0). |
| homelab-pihole-dns | keep-corpus | Pi-hole ops how-to; library dns-specialist covers generic record types/DNSSEC, not Pi-hole installation/blocklists — no near-duplicate. |
| homelab-vlan-segmentation | keep-corpus | UniFi/pfSense/MikroTik VLAN how-to; no library counterpart (vlan grep = 0). |
| homelab-wireguard-vpn | keep-corpus | WireGuard server/peer setup how-to; library vpn-privacy-advisor is consumer VPN selection, different scope — no duplicate. |
| hookify-rules | keep-corpus | Self-contained rule-syntax reference for the hookify engine Darhai ships in bundled-ecc (commands/hookify*.md + hooks/hooks.json script machinery; install-modules.json:258 lists this skill) — hooks default-off is a toggle, not an omission; no library dupe (hookify grep = 0). |
| inherit-legacy-style | keep-corpus | Language-agnostic anti-style-drift workflow producing .ai-style-rules.md; uses only standard tools, sole slash ref is self-referential; library legacy-code-archaeologist is codebase comprehension, not style inheritance — no dupe. |
| intent-driven-development | drop | Ledger superpowers.md counterpart row: AC-NNN format, Pass/Fail Rubric and discovered-facts-vs-constraints rule were absorbed into the phase-1 brainstorming skill ('давхардал болно'), drop explicitly deferred to phase 2 — this phase executes it. |
| inventory-demand-planning | keep-corpus | 25KB self-contained retail demand-planning expertise (forecast method selection, ABC/XYZ, safety stock math, promo lift); inventory '>' in the inventory dump is folded-YAML, not a broken file; library inventory-manager is a generic small-biz skill, not a dupe. |
| investor-materials | keep-corpus | Consistency-first fundraising-asset workflow (single source-of-truth rule, memos/models/accelerator apps); complements rather than duplicates library pitch-deck-builder/pitch-deck-creator which are deck-only; sole sibling ref (frontend-slides) stays in corpus. |
| investor-outreach | keep-corpus | Investor-specific outreach discipline (hard-ban list, follow-up cadence, forwardable blurbs); library cold-outreach-email is job-hunting, fundraising-narrative is pitch content — no near-duplicate. |
| ios-icon-gen | keep-corpus | Self-contained tool skill with own scripts (generate_icons.swift for SF Symbols, iconify_gen.sh against the public Iconify API); no MCP/plugin bindings, no library counterpart (icon hits are design-brief skills). |
| iterative-retrieval | keep-corpus | Generic DISPATCH→EVALUATE→REFINE→LOOP subagent-context pattern; NOT absorbed in phase 1 (ledger dispatching-parallel-agents merge cites only parallel-execution-optimizer); no library dupe (retrieval hits are RAG/PKM personas). |
| ito-basket-compare | keep-corpus | Read-only, ITO_API_KEY-gated niche vertical with self-contained guardrails; env-var gating is portable, not claude-CLI machinery; no library counterpart. |
| ito-data-atlas-agent | keep-corpus | Architecture/workflow-planning teaser for Itô research agents, self-contained, no tool bindings; no library counterpart. |
| ito-market-intelligence | keep-corpus | Verified source: env-gated read-only workflow with explicit no-advice guardrails; chains to siblings (deep-research, exa-search, x-api) by name only — all remain in corpus; no library dupe. |
| ito-trade-planner | keep-corpus | Non-advisory trade-planning worksheet, read-only, self-contained; no library counterpart. |
| java-coding-standards | keep-corpus | Spring Boot + Quarkus standards (naming, Optional, streams, CDI, reactive); library java-modern-idioms/java-spring-patterns overlap partially but neither covers Quarkus/CDI nor the standards framing — not a near-duplicate. |
| jira-integration | adapt | Target: skills-library corpus. Edit needed: MCP setup section instructs adding mcp-atlassian to `~/.claude.json → mcpServers` — repoint to Darhai's MCP config surface; the JQL/REST-API-v3 fallback content is portable as-is. |
| jpa-patterns | keep-corpus | JPA/Hibernate entity/query/transaction patterns; library has zero JPA/Hibernate coverage (jpa grep = 0). |
| knowledge-ops | adapt | Target: skills-library corpus. Edits needed: strip claude-CLI bindings — `mcp__memory__create_entities/search_nodes` tool names, `~/.claude/projects/*/memory/` layer, TodoWrite ref — and generalize to Darhai's own memory/retrieval layers; the layered-KB architecture + dedupe-before-store workflow is the portable core. |
| kotlin-coroutines-flows | drop | Near-duplicate of library `kotlin-coroutines-patterns` (software-engineering/languages-runtimes): identical scope — structured concurrency, launch/async/Flow/StateFlow/SharedFlow selection, dispatcher choice, runTest/Turbine testing — and the library entry is broader (Ktor/Spring backend included). |
| kotlin-exposed-patterns | keep-corpus | JetBrains Exposed ORM + HikariCP/Flyway patterns (22KB); no Exposed coverage anywhere in the library (exposed grep = 0). |
| kotlin-ktor-patterns | keep-corpus | Ktor routing/plugins/Koin/WebSockets patterns (20KB); no Ktor entry in the library (ktor grep = 0). |
| kotlin-patterns | keep-corpus | General idiomatic Kotlin (null safety, DSL builders, conventions, 19KB); library kotlin entries are android-, coroutines-, or setup-specific — no general-idioms counterpart exists. |
| kotlin-testing | keep-corpus | Kotest/MockK/coroutine-testing/Kover patterns (21KB); library has no Kotlin testing entry (kotlin grep shows only patterns/setup skills). |
| kubernetes-patterns | drop | Near-duplicate of library `kubernetes-operator` (devops-cloud): both cover deployments, probes, services/ingress, ConfigMaps/Secrets, RBAC, HPA, resource limits and pod troubleshooting with YAML examples; library additionally has kubernetes-workload-design and kubernetes-configuration covering the residue. |
| laravel-patterns | drop | Near-duplicate of library `php-laravel-patterns` (software-engineering/languages-runtimes): both cover service layers, Eloquent best practices/N+1, queues/jobs/events, API architecture; the library entry is broader (CQRS/DDD/hexagonal in Laravel context). |
| laravel-plugin-discovery | adapt | Target: skills-library corpus. Edit needed: setup section hardcodes `~/.claude.json` mcpServers block — repoint to Darhai's MCP config; LaraPlugins.io is a free public HTTP MCP (not localhost/ECC machinery), and the SearchPluginTool/GetPluginDetailsTool docs + health-evaluation flow are portable. |
| laravel-security | keep-corpus | 27KB Laravel security depth (auth, Eloquent safety, CSRF/XSS, API, deploy config); library php-laravel-patterns explicitly excludes this scope — no duplicate. |
| laravel-tdd | keep-corpus | PHPUnit/Pest/factories/Sanctum testing strategies (18KB); no Laravel testing entry in the library. |
| laravel-verification | keep-corpus | Verified source: pure artisan/composer/pint/phpstan command pipeline, zero ECC machinery; stack-specific, so distinct from the generic ecc verification-loop the ledger flags as covered by Darhai testing/oss-pr skills. |
| latency-critical-systems | keep-corpus | Verified self-contained: metric-split (p50/p95/p99, freshness), hot-path mapping, 8-step optimization order, standard tools only; library real-time-systems-designer covers WebSocket/SSE/CRDT design — different focus, not a dupe. |
| lead-intelligence | keep-corpus | 5-stage pipeline + 4 self-contained sub-agent briefs; prerequisites (Exa MCP, X API creds) are declared external services, not claude-CLI/ECC plugin machinery; sibling refs (brand-voice, x-api) stay in the same corpus; no library counterpart for lead-gen tooling. |
| liquid-glass-design | keep-corpus | iOS 26 Liquid Glass API knowledge for SwiftUI/UIKit/WidgetKit (9KB); nothing comparable in the library (glass grep = 0). |
| llm-trading-agent-security | keep-corpus | Agent-security patterns (prompt injection, spend limits, pre-send simulation, circuit breakers, key handling); library defi/tokenomics entries are strategy skills, not agent security — no duplicate. |
| logistics-exception-management | keep-corpus | 17KB self-contained freight-claims expertise (exception taxonomy, Carmack 9-month window, detention disputes); '>' in inventory is folded-YAML, not a broken file; library logistics hits are life-skills, no counterpart. |
| make-interfaces-feel-better | keep-corpus | Concrete self-contained design-engineering details (concentric radius, hit areas, states), salvaged community content with no tool bindings; library interface hits are UX-audit/persona skills — no near-duplicate. |
| manim-video | keep-corpus | Self-contained Manim explainer how-to + bundled starter asset (assets/network_graph_scene.py); refs video-editing/remotion-video-creation/content-engine are sibling bundled-ECC corpus entries; no manim counterpart in skills-library index. |
| market-research | keep-corpus | Partial overlap with library market-researcher/market-research-brief but adds distinct investor/fund-diligence and tech-vendor-scan modes plus source-attribution quality gate — not a near-duplicate. |
| marketing-campaign | keep-corpus | Richer than library campaign-planning/create-marketing-campaign: 4-phase orchestration, output contract, hard-ban copy list; refs brand-voice/content-engine/crosspost/seo are sibling bundled-ECC corpus entries. |
| mcp-server-patterns | keep-corpus | Node/TS MCP SDK reference (tools/resources/prompts, Zod, stdio vs Streamable HTTP); Context7 mention is an advisory pointer, no hard tool binding; no library counterpart. |
| messages-ops | keep-corpus | Generic evidence-first DM/text/OTC-code retrieval workflow (source-first, exact-evidence output); ECC skill-stack refs (email-ops, connections-optimizer, lead-intelligence, knowledge-ops) all enter the same corpus; no CLI/MCP machinery binding. |
| ml-adoption-playbook | keep-corpus | ML-into-legacy-codebase methodology (problem framing, data readiness, decoupling); no bindings; library ml-pipeline/ml-ops-engineer cover pipeline/ops, not adoption. |
| mle-workflow | keep-corpus | Production MLE lifecycle (data contracts, reproducible training, monitoring, rollback) complementing library ml-ops-engineer/ml-pipeline without duplicating either. |
| motion-advanced | keep-corpus | Advanced layer of the coherent 3-skill motion/react suite (drag, gestures, useAnimate); library animation-designer/web-animation-master are shallow surveys, not counterparts. |
| motion-foundations | keep-corpus | Base layer (motionTokens, springs map, shouldAnimate gate, reduced-motion, SSR hydration safety) that motion-patterns/motion-advanced explicitly depend on; no library counterpart. |
| motion-patterns | keep-corpus | Pattern layer (button/modal/toast/stagger/page transitions) built on motion-foundations tokens; part of the coherent suite, no library counterpart. |
| motion-ui | drop | Monolithic v4.2 predecessor: heading-by-heading same ground (motion tokens, performance rules, device adaptation, accessibility, SSR safety, modal/stagger/scroll examples) as the motion-foundations+motion-patterns+motion-advanced suite kept at 163-165 — near-duplicate within the incoming pool. |
| mysql-patterns | keep-corpus | Broader than library mysql-optimizer (schema, transactions, replication, connection-pool vs optimization-only) — complementary, not near-duplicate; no bindings. |
| nanoclaw-repl | drop | Hard-bound to ECC repo script scripts/claw.js and claude -p CLI REPL (criterion b) — the entire skill is operating guidance for machinery Darhai will not ship; meaningless standalone. |
| nestjs-patterns | keep-corpus | NestJS architecture reference (modules, DTO validation, guards, interceptors); zero NestJS coverage in skills-library index; no bindings. |
| netmiko-ssh-automation | keep-corpus | Self-contained Python/Netmiko safe-automation patterns (bounded batch SSH, TextFSM, guarded config changes); grep shows no slash/MCP/script bindings; no library counterpart. |
| network-bgp-diagnostics | keep-corpus | Diagnostics-only BGP troubleshooting reference; no bindings; skills-library has no networking-infrastructure content at all. |
| network-config-validation | keep-corpus | Pre-deployment router/switch config check reference (dangerous commands, subnet overlaps, management-plane risk); no bindings, no library counterpart. |
| network-interface-health | keep-corpus | Interface error/CRC/duplex/flap diagnostics reference for network gear and Linux hosts; no bindings, no library counterpart. |
| nextjs-turbopack | keep-corpus | Turbopack/bundling-specific content the library nextjs-* entries (app-router, data, deployment, performance) do not cover; no bindings. |
| nodejs-keccak256 | keep-corpus | Narrow high-value gotcha (Node sha3-256 = NIST SHA3, not Ethereum Keccak-256, silently breaks selectors/addresses); no counterpart — library layer2-specialist/crypto-navigator don't touch hashing. |
| nutrient-document-processing | keep-corpus | Nutrient DWS API how-to (OCR/redact/sign/fill; user supplies own key); the library 'nutrient' index hits are all food-nutrition skills, unrelated; no machinery binding. |
| nuxt4-patterns | keep-corpus | Nuxt 4 hydration/route-rules/useFetch patterns; only library vue-builder mentions Nuxt in passing — no counterpart; no bindings. |
| openclaw-persona-forge | keep-corpus | Self-contained functioning zh-CN persona-generator for the OpenClaw platform (bundled gacha.py, graceful no-image-skill fallback); niche but not ECC/claude-CLI-bound, not broken, no duplicate; inventory mojibake is an encoding artifact — source file is clean UTF-8. |
| opensource-pipeline | drop | Hard-bound to /opensource slash command and Agent(subagent_type=opensource-forker/opensource-sanitizer/opensource-packager) ECC agent chain (criterion b) — the entire protocol is spawn instructions for agents Darhai will not ship. |
| orch-add-feature | drop | Thin wrapper over the orch-pipeline engine (dropped, ledger superpowers.md row 'ecc orch-pipeline') delegating to ECC agents (security-reviewer) + /feature-dev slash ref; its Research-Plan-TDD-Review-Commit substance is covered by phase-1 builtins writing-plans/executing-plans/test-driven-development/requesting-code-review (criteria a+b). |
| orch-build-mvp | drop | Same orch-pipeline engine binding plus additional hard binds to /gan-build slash, gan-harness/spec.md machinery, and gan-planner/gan-generator/gan-evaluator ECC agents (criterion b). |
| orch-change-feature | drop | Thin wrapper over dropped orch-pipeline engine delegating to security-reviewer ECC agent; behavior-change-via-tests substance covered by phase-1 test-driven-development + executing-plans builtins (criteria a+b). |
| orch-fix-defect | drop | Thin wrapper over dropped orch-pipeline engine + security-reviewer agent; failing-regression-test-first substance covered by phase-1 systematic-debugging + test-driven-development builtins (criteria a+b). |
| orch-pipeline | drop | Ledger superpowers.md counterpart row: 'ECC agent/slash-д уяатай intake-ангилагч', drop deferred to phase 2 — now executed; shared engine is inseparable from the ECC agent map and slash gates Darhai will not ship (criterion b). |
| orch-refine-code | drop | Thin wrapper over dropped orch-pipeline engine delegating to refactor-cleaner ECC agent; behavior-preserving-refactor discipline covered by phase-1 test-driven-development + verification-before-completion builtins (criteria a+b). |
| parallel-execution-optimizer | drop | Ledger superpowers.md row: Lane Matrix, Execution Rules, and Failure Modes already grafted into the phase-1 builtin dispatching-parallel-agents — absorbed, remainder is duplication (criterion a). |
| perl-patterns | keep-corpus | Modern Perl 5.36+ idioms; skills-library has zero Perl content (index hit 'knife-skills' is kitchen knives); no bindings. |
| perl-security | keep-corpus | Perl taint mode/DBI parameterized queries/perlcritic security reference; unique in the corpus, no bindings. |
| perl-testing | keep-corpus | Test2::V0/prove/Devel::Cover testing reference; unique in the corpus, no bindings. |
| plan-orchestrate | drop | Ledger superpowers.md row: 'ECC /orchestrate slash + agent catalogue-оос салгаж болохгүй', drop deferred to phase 2 — now executed; emits /orchestrate prompts against an agent catalogue Darhai will not ship (criteria a+b). |
| plankton-code-quality | drop | Integration reference for external Plankton hard-bound to Claude Code hook machinery: PostToolUse multi_linter.sh, claude -p fix subprocesses with model-tier routing, PreToolUse config-guard hooks — none of which Darhai ships (criterion b). |
| postgres-patterns | keep-corpus | Compact Supabase-flavored cheat sheet (RLS wrap-in-SELECT, SKIP LOCKED queue, cursor pagination, covering/partial indexes) complementary to library postgres-expert's deep-dive (partitioning/VACUUM/pg_stat) — not near-duplicate; database-reviewer agent ref is a soft pointer. |
| prediction-market-oracle-research | keep-corpus | Source-grounded research methodology for market-implied probabilities as oracle signals; no bindings, no library counterpart, explicitly no-investment-advice framing. |
| prediction-market-risk-review | keep-corpus | Compliance/safety/data-quality review checklist for trading-agent workflows; no bindings, no library counterpart; pairs with kept ito-*/defi skills in other slices. |
| prisma-patterns | keep-corpus | Prisma-specific depth (updateMany returns count, $transaction timeouts, migrate-dev reset traps); library has only ORM-generic orm-specialist (486L) — complementary, not near-dup; no bindings. |
| product-capability | adapt | Target: skills-library corpus — solid PRD-to-capability-contract method, but de-brand 'ECC-native PRD-to-SRS lane' in description and fix/inline the ECC-repo template ref docs/examples/product-capability-template.md which won't exist in Darhai. |
| product-lens | keep-corpus | Engine-neutral product diagnostic (YC-style 7-question rubric, founder review, PRODUCT-BRIEF.md output); hands off to product-capability which is kept; no library counterpart, no bindings. |
| production-audit | keep-corpus | Already a maintainer-safe engine-neutral rewrite (explicitly bans unpinned remote execution/third-party upload); local-evidence readiness triage not covered by library security-auditor entries. |
| production-scheduling | keep-corpus | Manufacturing scheduling domain expertise (TOC/drum-buffer-rope, SMED, OEE, disruption response); no library counterpart, no tool bindings. |
| project-flow-ops | keep-corpus | GitHub-vs-Linear execution-flow ops knowledge (triage lanes, merge/port/close/park classification); service-specific but not claude-CLI/ECC-machinery bound. |
| prompt-optimizer | drop | Phase 3 is a routing table into ECC commands/skills/agents Darhai won't ship (/plan, /tdd, tdd-workflow, verification-loop, planner, blueprint, /prompt-optimize slash — criterion b); the generic prompt-critique remainder duplicates library prompt-engineer, prompt-engineering, ai-prompt-crafter (criterion c). |
| python-patterns | drop | Umbrella near-dup of library python family: python-idioms (723L idioms/comprehensions/dataclasses), python-type-system (type hints/Protocol), python-error-handling — verified heading overlap on readability/EAFP/type-hints/exception sections (criterion c). |
| python-testing | drop | Near-dup of library python-testing-patterns (835L, foundry-skills): identical pytest/fixtures/parametrize/mocking/TDD/coverage scope confirmed by heading comparison (criterion c). |
| pytorch-patterns | keep-corpus | No PyTorch content anywhere in skills-library index (grep pytorch → 0 hits); training-pipeline/reproducibility knowledge, no bindings. |
| quality-nonconformance | keep-corpus | Regulated-manufacturing QA expertise (NCR lifecycle, CAPA, SPC, FDA/IATF-16949/AS9100); no library counterpart, no bindings. |
| quarkus-patterns | keep-corpus | No Quarkus content in library (grep quarkus → 0); localhost hit is an app-under-test JDBC URL, not MCP machinery; 723L of Camel/Panache/CDI stack knowledge. |
| quarkus-security | keep-corpus | Quarkus-specific JWT/OIDC/RBAC security patterns; no library counterpart, no bindings. |
| quarkus-tdd | keep-corpus | Stack-specific TDD (JUnit5/Mockito/REST Assured/Camel/JaCoCo); phase-1 test-driven-development ledger row deliberately keeps stack mandates out of the builtin — this is the Quarkus slice; no counterpart. |
| quarkus-verification | keep-corpus | Quarkus verify pipeline (native build, SonarQube, k6, health endpoints); localhost refs are app-under-test URLs; distinct from the generic ecc verification-loop already drop-deferred in ledger superpowers.md. |
| ralphinho-rfc-pipeline | keep-corpus | Engine-neutral RFC→DAG work-unit pattern (unit spec, complexity tiers, merge-queue rules); no ledger row and complements — does not duplicate — phase-1 subagent-driven-development; zero tool bindings. |
| react-patterns | drop | Umbrella near-dup of library react family: react-component-patterns + react-architect + react-server-components + react-state-management jointly cover its hooks-discipline/RSC-boundary/composition/state-tree/forms territory (criterion c). |
| react-performance | keep-corpus | Vercel agent-skills-derived priority ruleset (waterfalls, barrel imports, RSC serialization, server-side caching) — verified different axis from library react-performance-patterns whose headings are client-render profiling/memoization/virtualization; not a near-dup. |
| react-testing | drop | Near-dup of library react-testing-patterns (746L): verified headings cover the same RTL query priority, async handling, dependency mocking, renderHook, a11y+coverage scope (criterion c). |
| recsys-pipeline-architect | keep-corpus | Six-stage Source→Hydrator→Filter→Scorer→Selector→SideEffect framework knowledge; no recsys content in library, no bindings. |
| recursive-decision-ledger | keep-corpus | Generic bounded-rollout method with JSONL ledger contract, coherence marks, and promotion gates; tools are plain Read/Write/Bash; no counterpart. |
| redis-patterns | drop | Near-dup of library redis-specialist (525L): identical data-structure/caching/rate-limiting/distributed-lock/pub-sub/streams scope per both descriptions and headings (criterion c). |
| regex-vs-llm-structured-text | keep-corpus | Unique regex-vs-LLM routing decision framework; library regex-cheatsheet/regex-master cover regex syntax only, not the escalation decision. |
| remotion-video-creation | keep-corpus | 29 upstream Remotion rule files (3D, captions, Mediabunny, transitions) sourced from official docs; no Remotion content in library; no bindings. |
| repo-scan | adapt | Target: corpus — keep the self-contained methodology (file classification, embedded-library detection, four-level verdicts, depth levels) but strip the Installation section that git-fetches github.com/haibindev/repo-scan into ~/.claude/skills (claude-CLI path + external fetch). |
| research-ops | adapt | Target: corpus — useful research-lane router, but de-brand 'workflow for ECC' and re-point the Skill Stack refs (exa-search, deep-research, market-research, lead-intelligence, knowledge-ops) at those skills' corpus fates per their own phase-2 verdicts. |
| returns-reverse-logistics | keep-corpus | Returns/RMA/disposition-economics/fraud/warranty domain expertise; no library counterpart, no bindings. |
| rules-distill | drop | Hard-bound to ECC plugin machinery: invokes bash ~/.claude/skills/rules-distill/scripts/scan-skills.sh and scan-rules.sh and operates on the ~/.claude/rules pool — Darhai ships neither the scripts layout nor the ECC rules system (criterion b). |
| rust-patterns | drop | Umbrella near-dup of library rust family: rust-ownership-patterns (Cow/smart pointers), rust-error-handling (thiserror/anyhow), rust-async-patterns, rust-performance cover the same ownership/errors/traits/concurrency territory (criterion c). |
| rust-testing | drop | Near-dup of library rust-testing-patterns (580L): same unit/integration/proptest/criterion/mocking/organization scope per both descriptions (criterion c). |
| safety-guard | drop | Bound to claude-CLI machinery: PreToolUse hook interception, /safety-guard slash modes, ~/.claude/safety-guard.log, 'ECC 2.0' observability integration (criterion b); the destructive-op-guard role in Darhai is already carried by the bundled gateguard skill chosen as the env-toggled guard in the bundling decision. |
| santa-method | keep-corpus | Engine-neutral dual-independent-reviewer convergence gate (both must pass); distinct from phase-1 requesting/receiving-code-review single-reviewer discipline — no ledger row claims it; no bindings. |
| scientific-db-pubmed-database | keep-corpus | PubMed/NCBI E-utilities API workflow knowledge (MeSH, PMID, citation retrieval); plain HTTP, no MCP/CLI bindings, no counterpart. |
| scientific-db-uspto-database | keep-corpus | USPTO PatentSearch/TSDR/assignment API workflow; library ip-protection-overview is legal-concepts-level, not record-lookup workflow — complementary. |
| scientific-pkg-gget | keep-corpus | gget CLI/Python genomics query workflow (open Apache tool); no bioinformatics content in library, no machinery bindings. |
| scientific-thinking-literature-review | keep-corpus | Full systematic-review pipeline (search plan, screening, dedup, extraction, citation verification, search log); library literature-review (thematic writing) and literature-search (query design) each cover only one slice — verified by heading comparison, not a near-dup. |
| scientific-thinking-scholar-evaluation | keep-corpus | 9-dimension rubric for evaluating papers/proposals/methods; nearest library entry research-advisor covers CRAAP source evaluation, not artifact review — no near-dup. |
| search-first | adapt | Target: corpus — the preflight→parallel-search→evaluate→adopt/extend/build workflow is valuable and uncovered by phase 1 (ledger shows skill-creator absorbed only skill-scout's skill-creation gate), but replace the ECC 'researcher agent' invocation with generic subagent phrasing and re-point catalog checks at ~/.claude/skills + ~/.claude/settings.json (SKILL.md:76-85) to Darhai's skills-library search and host tool inventory. |
| security-bounty-hunter | keep-corpus | Bounty-triage angle (remotely-reachable CWE in-scope table plus explicit low-signal skip-list) distinct from library's two security-auditor entries which are broad best-practice audits; no bindings. |
| security-review | keep-corpus | Concrete implementation-time security checklist with TS/zod/env code patterns + cloud-infrastructure-security.md reference; library security-auditor is audit/assessment-report expertise (different function, not a near-dup); not absorbed in phase 1. |
| security-scan | drop | Hard-bound to claude-CLI config machinery: entire skill is 'npx ecc-agentshield scan' of .claude/ dir (CLAUDE.md, settings.json, mcp.json, hooks, agents/*.md) — none of which Darhai ships. |
| seo | drop | Near-duplicate of skills-library seo-advisor (keyword research, on-page, technical SEO audit, Core Web Vitals, schema markup, content strategy — same topic set) with further overlap in seo-optimizer and seo-content-strategy. |
| skill-comply | drop | Hard-bound to claude-CLI: runs 'claude -p' with stream-json tool-call traces via bundled uv/pyproject scripts and targets ~/.claude/rules\|skills paths — non-portable test harness. |
| skill-scout | drop | Absorbed in phase 1: ledger superpowers.md row 'ecc skill-scout' — search-before-create gate merged into builtin skill-creator Step 1; retention would duplicate it. |
| skill-stocktake | drop | Hard-bound to claude-CLI layout: /skill-stocktake slash command auditing ~/.claude/skills + {cwd}/.claude/skills with bash scripts caching to ~/.claude/skills/skill-stocktake/results.json. |
| social-graph-ranker | keep-corpus | Portable methodology: weighted bridge-score formula B(m)=Σ w(t)·λ^(d-1), decay/traversal model for warm-intro ranking; no tool bindings; no library counterpart (library social-media-* are content strategy). |
| social-publisher | keep-corpus | Vendor-integration how-to for SocialClaw (REST API + socialclaw CLI, SC_API_KEY env) across 13 platforms; portable like x-api; no library counterpart for publishing automation. |
| springboot-patterns | keep-corpus | Complementary to library java-spring-patterns (DI/auto-config/actuator): covers REST API design, layered services, caching, async, logging — ~60% distinct coverage, not a near-dup. |
| springboot-security | keep-corpus | Spring Security authn/authz/CSRF/headers/rate-limit reference; no skills-library counterpart (library security entries are stack-agnostic). |
| springboot-tdd | keep-corpus | Stack-specific TDD reference (JUnit 5, Mockito, MockMvc, Testcontainers, JaCoCo); phase-1 builtin test-driven-development is stack-agnostic, so this is complementary knowledge, not a dup. |
| springboot-verification | keep-corpus | Spring-specific build/static-analysis/coverage/security verify loop; stack knowledge complementing the generic builtin verification-before-completion; no library counterpart. |
| strategic-compact | drop | Hard-bound to claude-CLI machinery: /compact command, transcript JSONL usage records, [1m] model marker, and suggest-compact.js PreToolUse hook wired via ~/.claude/settings.json — Darhai ships none of these. |
| swift-actor-persistence | keep-corpus | Focused Swift technique (actor-isolated file-backed cache eliminating data races); no library counterpart at this specificity. |
| swift-concurrency-6-2 | keep-corpus | Version-specific Swift 6.2 Approachable Concurrency (@concurrent, isolated conformances); library swift-concurrency-patterns is generic autogen boilerplate without 6.2 content — distinct. |
| swift-protocol-di-testing | keep-corpus | Specific technique (protocol-based DI mocks for FS/network with Swift Testing); library swift-testing-patterns is generic autogen wording without this technique — distinct. |
| swiftui-patterns | drop | Near-duplicate of skills-library swiftui-developer (declarative composition, Observable state, NavigationStack, architecture, performance — same topic set), with further overlap in swift-swiftui-patterns and ios-swiftui-architecture. |
| taste | keep-corpus | Unique creative-direction vocabulary (angelcore/cloud-trance/hyperpop mood+color+light system with references/); no overlap in library or phase 1. |
| tdd-workflow | drop | Ledger superpowers.md row 'ecc tdd-workflow' (§test-driven-development): wrong-stack examples + self-contradicting E2E, nothing grafted; concept owned by builtin test-driven-development; library also has its own tdd-workflow entry. |
| team-agent-orchestration | drop | Ledger superpowers.md row 'ecc team-agent-orchestration' (§subagent-driven-development): Kanban framing without execution mechanics, nothing grafted; superseded by builtin subagent-driven-development. |
| team-builder | drop | Hard-bound to claude-CLI/ECC machinery: discovery via 'claude agents' command including plugin agents (everything-claude-code:*) and ~/.claude/agents globs; dispatch role covered by builtin dispatching-parallel-agents. |
| terminal-ops | adapt | Portable evidence-first operator discipline (changed/verified/committed/pushed distinctions, inspect-before-edit) worth corpus; target skills-library, but must strip the Skill Stack cross-refs to dropped ECC skills (verification-loop, tdd-workflow, security-review by old name, github-ops, knowledge-ops) and de-brand 'for ECC'. |
| tinystruct-patterns | keep-corpus | Niche Java framework (tinystruct Application/@Action) reference; no library counterpart, no tool bindings. |
| token-budget-advisor | keep-corpus | Portable response-depth negotiation protocol (input-token heuristics + complexity multipliers); inventory description showed '>-' only because of YAML folded-scalar frontmatter — source is intact; note it cross-links ../context-budget which the corpus converter must resolve. |
| ui-demo | keep-corpus | Playwright-based demo-video recording how-to (cursor overlay, WebM output, 466-line workflow); portable tooling, no claude-CLI binding, no library counterpart. |
| ui-to-vue | keep-corpus | Distinct workflow (batch screenshot/design-export → Vue 3 + Vant/Element Plus components conversion); not a dup of library vue-builder which is patterns knowledge, not conversion. |
| uncloud | keep-corpus | Uncloud cluster ops how-to (services, Caddy ingress, ports, scaling); portable CLI knowledge, no counterpart anywhere in library. |
| unified-notifications-ops | adapt | Alert routing/dedup/escalation/digest-first policy is portable ops knowledge (library notification-system is app-feature design — different domain), but needs de-branding of 'ECC-native lane' framing and generalization of hook/session-lifecycle + Linear assumptions; target skills-library. |
| verification-loop | drop | Ledger superpowers.md row 'ecc verification-loop' (§verification-before-completion): stack-specific QA checklist, nothing grafted, covered by builtin verification-before-completion plus Darhai's own testing/oss-pr skills. |
| video-editing | keep-corpus | AI-assisted editing pipeline (FFmpeg, Remotion, ElevenLabs, fal.ai, DaVinci hand-off); library video-editing-master is human NLE craft (Premiere/Resolve) — complementary, not a near-dup. |
| videodb | keep-corpus | Vendor-integration reference for VideoDB Python SDK (ingest/index/search/timeline/RTSP alerts, scripts + reference dirs); portable given API key; claude-ish allowed-tools/argument-hint frontmatter is handled by generic corpus normalization. |
| visa-doc-translate | keep-corpus | Distinct workflow (visa document images → English translation → bilingual PDF); library visa-passport-guide/visa-requirements-checker are travel-info guides, not translation — no dup. |
| vite-patterns | keep-corpus | Vite config/plugins/HMR/SSR/library-mode reference; zero library counterpart (no vite entries in index.json). |
| vue-patterns | drop | Near-duplicate of skills-library vue-builder (Composition API, Pinia, Vue Router, composables, Nuxt, reactivity — identical topic list), with further overlap in vue-composition-patterns and vue-state-management. |
| windows-desktop-e2e | keep-corpus | Specialized pywinauto/UIA testing for WPF/WinForms/Win32/Qt; library e2e-testing-patterns is web-oriented autogen — distinct platform coverage. |
| workspace-surface-audit | drop | Hard-bound to claude-CLI/ECC harness: audits .claude/settings*.json, .mcp.json, plugins/connectors and recommends 'ECC-native skills, hooks, agents' — the audited surface and the recommendation catalogue both do not exist in Darhai. |
| x-api | keep-corpus | X/Twitter API integration reference (OAuth, rate limits, posting/search/analytics); library twitter-thread is copywriting, not API — no dup. |

### 2.2 Commands (92)

| name | verdict | reason |
| --- | --- | --- |
| aside | skill | Single-purpose session protocol (freeze task state, answer read-only, resume with ASIDE wrapper); no ECC tool bindings, portable to any chat harness including Darhai's. |
| auto-update | drop | Pure ECC install machinery: runs scripts/auto-update.js + install-apply.js via CLAUDE_PLUGIN_ROOT resolution blob, disable-model-invocation:true; meaningless outside the ECC plugin. |
| build-fix | skill | Single-purpose incremental build-fix procedure: detect-build-system table (npm/tsc/cargo/mvn/gradle/go/py), one-error-at-a-time loop, guardrails, recovery table; parent of the language-specific *-build skills. |
| checkpoint | skill | Single-purpose checkpoint procedure via git stash/commit + .claude/checkpoints.log with create/verify/list/clear; standalone despite referencing /verify. |
| code-review | workflow | 8-phase dual-mode orchestration (local + GitHub PR): fetch, context, 7-category review, per-stack validation, decision matrix, artifact at .claude/reviews/, gh pr review publish; overlaps Darhai's native pr-review skill only at the surface, PR-publish pipeline is richer. |
| cost-report | drop | Duplicate of phase-1 cost-tracking skill: same ~/.claude/metrics/costs.jsonl from ECC's stop:cost-tracker hook, same latest-row-per-session aggregation; bound to ECC hook machinery. |
| cpp-build | skill | Single-purpose C++ build-fix procedure with cmake/clang-tidy/cppcheck diagnostics and a common-errors fix table (undeclared identifier, undefined reference, multiple definition); agent invocation is incidental, playbook content stands alone. |
| cpp-review | skill | Single-purpose C++ review checklist (RAII, Rule of Five, data races, const-correctness severity tiers) + static-analysis commands; distinct from phase-1 cpp-coding-standards which is writing standards, not a review procedure. |
| cpp-test | drop | Duplicate of phase-1 cpp-testing skill: same GoogleTest/CTest TDD RED-GREEN-REFACTOR + gcov/lcov coverage scope; its own Related section cites skills/cpp-testing/. |
| ecc-guide | drop | Exact name+scope duplicate of phase-1 ecc-guide skill, and pure ECC-repo navigation machinery (reads ECC README, agent.yaml, manifests/install-*.json, scripts/ci/catalog.js). |
| epic-claim | drop | One-line shim over node scripts/github-coordination.js claim (ECC SQLite cache + label machinery); no assimilable playbook content, value lives in the ECC script. |
| epic-decompose | drop | One-line shim over node scripts/github-coordination.js decompose; ECC coordination-script machinery, same drop class as epic-claim. |
| epic-publish | drop | One-line shim over node scripts/github-coordination.js publish; ECC coordination-script machinery, same drop class as epic-claim. |
| epic-review | drop | One-line shim over node scripts/github-coordination.js review --review; ECC coordination-script machinery, same drop class as epic-claim. |
| epic-sync | drop | One-line shim over node scripts/github-coordination.js sync; ECC coordination-script machinery, same drop class as epic-claim. |
| epic-unblock | drop | One-line shim over node scripts/github-coordination.js unblock; ECC coordination-script machinery, same drop class as epic-claim. |
| epic-validate | drop | One-line shim over node scripts/github-coordination.js validate; ECC coordination-script machinery, same drop class as epic-claim. |
| evolve | drop | Executes skills/continuous-learning-v2/scripts/instinct-cli.py evolve — CLI machinery of the phase-1 continuous-learning-v2 skill (which bundles instinct-cli.py among its 12 files); classifying it again would double-count. |
| fastapi-review | skill | Single-purpose FastAPI review checklist (DI, Pydantic schema separation, async DB, CORS/auth) with severity output format; complements phase-1 fastapi-patterns (build patterns, not review) so not a duplicate. |
| feature-dev | workflow | 7-phase feature-development orchestration delegating to code-explorer, code-architect, and code-reviewer agents with explicit wait-for-user gates between exploration, design, and implementation. |
| flutter-build | skill | Single-purpose Dart/Flutter build-fix procedure (flutter analyze, pub get, build_runner, platform builds) with incremental verify loop; no phase-1 duplicate covers Flutter build repair. |
| flutter-review | drop | Duplicate of phase-1 flutter-dart-code-review skill — descriptions match word-for-word ('widget best practices, state management, performance, accessibility, and security'); the 23kb skill is the fuller artifact. |
| flutter-test | skill | Single-purpose Flutter test procedure covering unit/widget/golden/integration + --update-goldens and coverage; no phase-1 Flutter testing skill exists (only review and patterns), so not a duplicate. |
| gan-build | workflow | Three-agent (gan-planner/gan-generator/gan-evaluator) bounded generator-evaluator loop with pass-threshold, plateau detection, and build-report artifacts; operationalizes the phase-1 gan-style-harness reference skill rather than duplicating it. |
| gan-design | workflow | Distinct design-focused generator-evaluator loop: own rubric (Design 0.35 / Originality 0.30 / Craft 0.25 / Functionality 0.10), no planner, visual-excellence generator directive — a separate entry point, not a duplicate of gan-build. |
| go-build | skill | Single-purpose Go build-fix procedure (go build/vet, staticcheck, golangci-lint, go mod verify) with incremental verify loop; playbook content stands alone beyond the go-build-resolver agent reference. |
| go-review | skill | Single-purpose Go review checklist (goroutine leaks, race conditions, error wrapping, context propagation severity tiers); distinct from phase-1 golang-patterns which is writing idioms, not a review procedure. |
| go-test | drop | Duplicate of phase-1 golang-testing skill: identical scope — table-driven tests, TDD RED-GREEN-REFACTOR, 80%+ coverage via go test -cover. |
| gradle-build | skill | Single-purpose Android/KMP Gradle fix procedure with KMP-specific error table (expect/actual, composeApp, KSP, Compose compiler version alignment); overlaps kotlin-build (idx 37, other slice) but carries the Gradle/KMP specifics that command lacks — merge candidate at reconciliation, not a silent drop. |
| harness-audit | drop | Thin wrapper mandating 'Always run node scripts/harness-audit.js' with a fixed rubric ('do not invent additional dimensions') — bound to ECC's deterministic scorer script and 12-category ECC-repo rubric. |
| hookify-configure | drop | 0.4kb toggle for enabled: fields in .claude/hookify.*.local.md — configuration machinery of ECC's hookify hook engine; rule authoring is already covered by the phase-1 hookify-rules skill. |
| hookify-help | drop | Reference doc for ECC hookify rule syntax consumed by the ECC hook engine (.claude/hookify.*.local.md); syntax/guidance already covered by phase-1 hookify-rules skill. |
| hookify-list | drop | 0.5KB table-printer over .claude/hookify.*.local.md rule files; pure ECC hookify runtime mechanics with no standalone content. |
| hookify | drop | Rule creation bound to ECC conversation-analyzer agent and the hookify hook engine; rule format duplicated by phase-1 hookify-rules skill. |
| instinct-export | drop | Front-end for continuous-learning-v2's instinct-cli.py writing ~/.claude/homunculus paths; machinery ships inside phase-1 continuous-learning-v2 skill (12 files, 192KB). |
| instinct-import | drop | Source literally runs ${CLAUDE_PLUGIN_ROOT}/skills/continuous-learning-v2/scripts/instinct-cli.py import; ECC plugin machinery duplicated by phase-1 continuous-learning-v2 skill. |
| instinct-status | drop | Hardcodes an ECC plugin-root resolution JS blob (issue #2037) to call instinct-cli.py status; inseparable from ECC plugin install layout, covered by phase-1 continuous-learning-v2. |
| jira | drop | Slash face of phase-1 jira-integration skill — file's Related section points to skills/jira-integration/ and get/comment/transition/search are all covered by that skill's description verbatim. |
| kotlin-build | skill | Self-contained incremental Gradle/detekt/ktlint build-fix checklist (error-to-fix table, one-fix-at-a-time strategy, stop conditions); agent reference is soft, content stands alone and is not in kotlin-patterns. |
| kotlin-review | skill | Severity-gated Kotlin review checklist (!! force-unwrap, GlobalScope, coroutine safety, injection scan) with approval criteria; procedural review content absent from phase-1 kotlin-patterns. |
| kotlin-test | drop | Kotest/MockK/Kover TDD procedure duplicating phase-1 kotlin-testing skill, whose description already states 'Kotest, MockK, coroutine testing ... Kover coverage. Follows TDD methodology'. |
| learn-eval | skill | Manual session-pattern extraction with checklist quality gate and Save/Improve/Absorb/Drop verdict system; strict superset of /learn, writes plain skill files with no ECC runtime dependency. |
| learn | drop | Base version explicitly superseded — learn-eval (index 41) opens with 'Extends /learn with a quality gate, save-location decision'; keep only the superset. |
| loop-start | drop | 1KB launcher requiring ECC_HOOK_PROFILE hook machinery and ECC loop profiles; the loop patterns themselves live in phase-1 autonomous-loops (25KB) and continuous-agent-loop skills. |
| loop-status | drop | Depends on 'npx --package ecc-universal ecc loop-status' scanning ~/.claude/projects transcript JSONL; claude-CLI/ECC package machinery unusable outside that runtime. |
| marketing-campaign | drop | Same name and identical deliverable list (landing page, email sequence, social, ads, video scripts, calendar) as phase-1 marketing-campaign skill; command merely delegates to marketing-agent/brand-voice/content-engine. |
| model-route | drop | 0.7KB haiku/sonnet/opus heuristic fully covered by phase-1 cost-aware-llm-pipeline skill ('model routing by task complexity, budget tracking'). |
| multi-backend | drop | Header prerequisite: external ccg-workflow runtime (codeagent-wrapper + ~/.claude/.ccg/prompts role files) 'not part of the base ECC install' — inoperable without third-party machinery (grep: 3 hits). |
| multi-execute | drop | Same absent ccg-workflow/codeagent-wrapper dependency (grep: 4 hits); execution phase of the same external multi-model runtime family as multi-backend. |
| multi-frontend | drop | Same ccg-workflow prerequisite (grep: 3 hits); Gemini-led variant of the same external-runtime family as multi-backend. |
| multi-plan | drop | Same ccg-workflow prerequisite (grep: 2 hits); planning phase of the external codeagent-wrapper runtime family. |
| multi-workflow | drop | Same ccg-workflow prerequisite (grep: 3 hits); umbrella command over the other four multi-* commands, all dropped for the same absent runtime. |
| orch-add-feature | drop | 1.2KB wrapper — body says 'Invoke the orch-add-feature skill with $ARGUMENTS'; same-named orch-add-feature skill exists in phase-1 inventory. |
| orch-build-mvp | drop | Description self-identifies as 'Wrapper for the orch-build-mvp skill'; same-named skill exists in phase-1 inventory. |
| orch-change-feature | drop | Description self-identifies as 'Wrapper for the orch-change-feature skill'; same-named skill exists in phase-1 inventory. |
| orch-fix-defect | drop | Description self-identifies as 'Wrapper for the orch-fix-defect skill'; same-named skill exists in phase-1 inventory. |
| orch-refine-code | drop | Description self-identifies as 'Wrapper for the orch-refine-code skill'; same-named skill exists in phase-1 inventory. |
| plan-prd | workflow | 4-phase gated PRD pipeline (FRAME→GROUND→DECIDE→GENERATE) with wait-for-user gates, artifact contract (.claude/prds/*.prd.md), success criteria, and explicit handoff to /plan — an orchestration playbook, not a checklist. |
| plan | workflow | Multi-mode planning pipeline (restate→pattern-grounding table→phased plan→mandatory user CONFIRM gate) with PRD-artifact mode that writes .claude/plans/*.plan.md and mutates milestone state — full orchestration playbook. |
| pm2 | skill | Single-purpose PM2 service scaffolding: framework/port detection tables plus Windows-specific .cjs ecosystem config generation; no agent orchestration, one deliverable. |
| pr | skill | Single-purpose PR-creation checklist (validate→template discovery→commit/file analysis→push→gh pr create); procedural gh mechanics not covered by phase-1 git-workflow patterns skill. |
| project-init | drop | ECC install machinery — drives scripts/install-plan.js, scripts/install-apply.js, and config/project-stack-mappings.json to onboard ECC itself into a repo; meaningless once ECC is assimilated. |
| projects | drop | Thin wrapper over continuous-learning-v2/scripts/instinct-cli.py reading ~/.claude/homunculus/projects.json via CLAUDE_PLUGIN_ROOT — instinct machinery of phase-1 skill continuous-learning-v2, useless without the plugin runtime. |
| promote | drop | Same instinct-cli.py wrapper as /projects (promote subcommand writing ~/.claude/homunculus/instincts/personal/) — continuous-learning-v2 plugin machinery, not portable prompt content. |
| prp-commit | skill | Single-purpose smart-commit checklist: natural-language staging table (glob/'except tests'/'the auth changes') + conventional-commit rules; only commit command in the bundle, no phase-1 duplicate, fully tool-agnostic git. |
| prp-implement | workflow | Multi-phase plan-execution playbook (DETECT pm → LOAD plan → PREPARE git → execute with validation loop after every change, checkpoints, never-accumulate-broken-state rule); consumes the plan artifact format prp-plan emits — orchestration, not a checklist. |
| prp-plan | workflow | 14KB multi-phase planning pipeline (PRD-phase parsing, complexity gate, codebase pattern extraction into a self-contained plan doc) whose output sections (Patterns to Mirror, Validation Commands) prp-implement's LOAD phase requires; NOT a dup of lean confirm-gate plan.md — different depth and coupled downstream consumer. |
| prp-pr | drop | Duplicate of commands/pr.md: identical description string ('Create a GitHub PR from current branch with unpushed commits — discovers templates, analyzes changes, pushes') and near-verbatim Phase 1 VALIDATE table; also overlaps darhai's own oss-pr project skill. |
| prp-prd | drop | Superseded by commands/plan-prd.md — same problem-first hypothesis-driven PRD generator (shared 'anti-fluff / TBD-needs-research' rule), plan-prd is the leaner ECC-native successor that explicitly hands off to /plan; keeping both duplicates the requirements phase. |
| prune | drop | Third instinct-cli.py wrapper (prune subcommand, 30-day expiry of ~/.claude/homunculus pending instincts) — continuous-learning-v2 plugin machinery like /projects and /promote. |
| python-review | skill | Single-purpose Python review checklist (ruff/mypy/pylint runs + CRITICAL/HIGH/MEDIUM severity taxonomy: pickle, mutable defaults, bare except); invokes python-reviewer agent but the checklist stands alone; phase-1 python-patterns/python-testing cover patterns, not review — no dup. |
| quality-gate | drop | Operator wrapper for the ECC PostToolUse hook scripts/hooks/quality-gate.js — driven by hook stdin JSON, ECC_QUALITY_GATE_* env toggles, wired in hooks/hooks.json; pure plugin hook machinery with no standalone prompt value. |
| react-build | skill | Single-purpose React build-fix checklist (bundler detection table, error layering TS/config/runtime/hydration, one-error-at-a-time loop, explicit scope split vs /build-fix); invokes react-build-resolver agent but procedure is self-contained. |
| react-review | skill | Single-purpose React review checklist (hooks correctness, render perf, RSC boundaries, a11y) invoking react-reviewer + typescript-reviewer with non-overlapping lanes; same template family as python-review/vue-review — corpus review skill. |
| react-test | skill | Single-purpose React TDD checklist: RTL role-first queries + userEvent + MSW, Vitest/Jest runner detection, RED-GREEN-REFACTOR enforcement; complements (not duplicates) phase-1 react-testing patterns skill which is reference material, not an enforcement procedure. |
| refactor-clean | skill | Single-purpose dead-code removal checklist (knip/depcheck/vulture tool table, SAFE/CAUTION/DANGER tiers, one-deletion-at-a-time with test verification and revert rule); linear steps, no subagent orchestration — corpus skill. |
| resume-session | drop | Claude-CLI session mechanics: loads *-session.tmp files from ~/.claude/session-data/ per SESSION_FILENAME_REGEX conventions of ECC session-manager.js — counterpart of /save-session, meaningless outside the ECC plugin session store. |
| review-pr | workflow | Multi-agent orchestration playbook: fans out 6 specialized reviewer agents (code-reviewer, comment-analyzer, pr-test-analyzer, silent-failure-hunter, type-design-analyzer, code-simplifier), then dedupes/ranks with an 80-confidence gate; distinct from darhai's local pr-review project skill (single-context review). |
| rust-build | skill | Single-purpose Rust build-fix checklist (borrow checker, dependency errors, incremental one-fix-at-a-time via rust-build-resolver agent); same self-contained template family as react-build — corpus skill. |
| rust-review | skill | Single-purpose Rust review checklist (ownership, lifetimes, unsafe usage, error handling) invoking rust-reviewer agent; phase-1 rust-patterns/rust-testing are pattern references, not review procedures — no dup. |
| rust-test | skill | Single-purpose Rust TDD checklist: tests-first enforcement with cargo-llvm-cov 80% coverage verification; complements phase-1 rust-testing patterns skill the same way react-test complements react-testing. |
| santa-loop | workflow | Adversarial convergence orchestration: builds a PASS/FAIL rubric, launches two independent reviewer subagents in parallel (different models, no shared context), dual-NICE verdict gate, fix-and-rerun up to 3 rounds; the runner for phase-1 santa-method skill, not a duplicate of it. |
| save-session | drop | Session-file machinery: writes ~/.claude/session-data/YYYY-MM-DD-<id>-session.tmp per SESSION_FILENAME_REGEX in ECC session-manager.js — bound to the plugin session store; Darhai has its own session persistence. |
| security-scan | drop | Duplicate of phase-1 skill security-scan (file itself links 'Skill: skills/security-scan/SKILL.md') and hard-depends on the external npx ecc-agentshield scanner + everything-claude-code:security-reviewer agent frontmatter. |
| sessions | drop | Entirely inline node scripts requiring ECC plugin internals (scripts/lib/session-manager, session-aliases) with a CLAUDE_PLUGIN_ROOT resolution blob probing ~/.claude/plugins/ecc@ecc paths — session-store plugin machinery, zero portable prompt content. |
| setup-pm | drop | Claude-Code config machinery: wraps ECC scripts/setup-package-manager.js writing ~/.claude/package-manager.json and CLAUDE_PACKAGE_MANAGER env; frontmatter disable-model-invocation:true marks it pure slash mechanics; Darhai is bun-locked anyway. |
| skill-create | skill | Single-purpose generator procedure: mine git log for commit conventions/co-change/workflow patterns and emit SKILL.md files; linear pipeline, no orchestration; the optional --instincts flag (continuous-learning-v2) is severable machinery, core is portable. |
| skill-health | drop | Pure wrapper around ECC scripts/skills-health.js --dashboard with a 20-line CLAUDE_PLUGIN_ROOT resolver blob repeated 3x — skill-tracking plugin machinery; portfolio management already covered by phase-1 skills skill-stocktake/skill-scout. |
| test-coverage | skill | Single-purpose coverage-gap checklist: framework detection table (jest/vitest/pytest/cargo-llvm-cov/jacoco/go), worst-first gap analysis, happy-path→error→edge→branch test-generation priority, repeat-until-80% — linear procedure, no subagents. |
| update-codemaps | skill | Single-purpose doc-generation checklist: scan structure, emit token-lean codemaps (architecture/backend/frontend/data/dependencies, <1000 tokens each) with 30%-diff approval gate and freshness headers; linear, self-contained. |
| update-docs | skill | Single-purpose doc-sync checklist: regenerate command reference from package.json scripts, env docs from .env.example, API reference from routes, CONTRIBUTING/RUNBOOK updates — source-of-truth-driven linear procedure, no dup in phase-1 skills. |
| vue-review | skill | Single-purpose Vue review checklist (reactivity, composables, v-html template security, Pinia/Router, a11y) invoking vue-reviewer + typescript-reviewer with explicit lane split vs /code-review; phase-1 vue-patterns is a patterns reference, not review — no dup. |

### 2.3 Agents (67)

| name | verdict | reason |
| --- | --- | --- |
| a11y-architect | profile | WCAG 2.2 audit/design persona; no accessibility profile among the 25 wayland-library agent-profiles; persona complements (not duplicates) the phase-1 `accessibility` reference skill. |
| agent-evaluator | profile | External fresh-context judge with read-only Bash verification workflow; companion executor that the bundled `agent-self-evaluation` skill dispatches — complementary, not superseded (skill=self-rating rubric, agent=independent evaluator). |
| architect | profile | General system-design/scalability persona; library only has backend-scoped `backend-architect`, no general software architect; core node of ECC orchestration workflows (agents.md planner/architect chain). |
| build-error-resolver | profile | Generic build/TypeScript error fixer with minimal-diff discipline; no library equivalent; referenced by ECC workflow rules as a standard worker. |
| chief-of-staff | drop | Tool-bound: requires email/Slack/LINE/Messenger channel fetch plus hook-enforced post-send follow-through and SOUL.md convention — Darhai bundling ships hooks disabled by default and has none of these channel connectors. |
| code-architect | profile | Feature-level blueprint designer (analyze repo conventions → concrete files/interfaces/build order); distinct from system-level `architect`; part of the code-explorer→code-architect feature-dev chain, no library dup. |
| code-explorer | profile | Codebase tracing/execution-path mapping worker feeding code-architect; pure Read/Grep persona, no tool binding, no library dup. |
| code-reviewer | drop | Exact-name duplicate: skills-library index.json already contains agent-profile `code-reviewer` (engineering, wayland-library). |
| code-simplifier | profile | Behavior-preserving simplification pass persona; no equivalent library agent-profile; generic tools only. |
| comment-analyzer | profile | Narrow but concrete comment-rot/accuracy audit persona (Read+Grep only); no library dup and no skill covering this niche. |
| conversation-analyzer | drop | Bound to ECC /hookify command infrastructure ("Triggered by /hookify without arguments", emits hookify rules); Darhai ships ECC with hooks disabled by default, so its only invocation path is absent. |
| cpp-build-resolver | profile | C++/CMake/linker error-fix playbook worker; complements phase-1 cpp skills which cover standards/testing but not build triage; no dup. |
| cpp-reviewer | profile | C++ memory-safety/concurrency review persona — dispatchable reviewer form of the phase-1 `cpp-coding-standards` reference; matches the per-language reviewer pattern in the user's code-review rules; no library dup. |
| csharp-reviewer | profile | .NET/async/nullable review persona; only language-neutral `code-reviewer` exists in library; complements phase-1 `csharp-testing`/`dotnet-patterns` skills. |
| dart-build-resolver | profile | Flutter/Dart analyze/pub/build_runner error-fix worker with concrete playbooks; no library dup, not tool-bound. |
| database-reviewer | profile | PostgreSQL SQL/migration/schema review persona; no DB reviewer in library agent-profiles; complements phase-1 `postgres-patterns` reference skill. |
| django-build-resolver | profile | Django pip/Poetry/migration-conflict repair worker (10kb concrete playbooks); distinct from django-reviewer; no dup. |
| django-reviewer | profile | Django ORM/DRF/migration-safety review persona; reviewer form complementing phase-1 django-* skills; no library dup. |
| doc-updater | drop | Bound to ECC slash-commands /update-codemaps and /update-docs plus repo-specific scripts/codemaps/generate.ts; generic documentation persona already covered by library agent-profile `technical-writer`. |
| docs-lookup | drop | Hard tool-bound: frontmatter tools list mcp__context7__resolve-library-id/query-docs (Context7 MCP required); also duplicates bundled `documentation-lookup` skill from the phase-1 slice. |
| e2e-runner | drop | Primary workflow bound to Vercel Agent Browser CLI (`npm install -g agent-browser`); Playwright patterns already carried by phase-1 `e2e-testing` skill and library agent-profile `qa-engineer` covers the persona. |
| fastapi-reviewer | profile | FastAPI async/DI/Pydantic review persona; complements phase-1 `fastapi-patterns` reference skill; no library dup. |
| flutter-reviewer | profile | Library-agnostic Flutter/Dart reviewer persona (15kb checklist); dispatchable reviewer form of phase-1 `flutter-dart-code-review` reference; no library dup. |
| fsharp-reviewer | profile | F# functional-idiom/type-safety review persona; niche but self-contained, not tool-bound, no dup; pairs with phase-1 `fsharp-testing` skill. |
| gan-evaluator | profile | Required worker of the GAN harness trio — the phase-1 `gan-style-harness` skill dispatches planner/generator/evaluator; live-app testing uses generic Playwright/Bash, not a bound MCP. |
| gan-generator | profile | GAN harness implementer worker; companion to gan-planner/gan-evaluator required by the phase-1 `gan-style-harness` skill; generic tools only. |
| gan-planner | profile | GAN harness spec-expansion worker (prompt → product spec/sprints/rubric); third member of the trio the `gan-style-harness` skill orchestrates. |
| go-build-resolver | profile | Go build/vet/lint error-fix worker; complements phase-1 `golang-patterns`/`golang-testing` references which lack build-triage playbooks; no dup. |
| go-reviewer | profile | Idiomatic-Go/concurrency review persona named in the user's code-review agent table pattern; no library dup. |
| harmonyos-app-resolver | profile | Self-contained HarmonyOS/ArkTS V2-state/ArkUI expert persona; niche but not tool-bound, no dup, and no phase-1 skill covers ArkTS (only the ECC arkts rules dir). |
| harness-optimizer | drop | Bound to ECC harness surface: workflow step 1 is `Run /harness-audit`, and its object is ~/.claude harness config (hooks/evals/routing) across Claude Code/Cursor/Codex — meaningless inside Darhai's app runtime. |
| healthcare-reviewer | profile | Clinical-safety/CDSS/PHI review persona; complements the four phase-1 healthcare-* reference skills as their dispatchable reviewer; no library dup. |
| homelab-architect | profile | Staged-plan/rollback network-design persona that explicitly routes into the phase-1 homelab-*/network-* skills — entry-point persona adds planning workflow beyond those references; Read+Grep only, no dup. |
| java-build-resolver | profile | Maven/Gradle build-fix worker with Spring Boot/Quarkus auto-detection (12kb playbooks); complements phase-1 java/quarkus/springboot skills which lack build triage; no dup. |
| java-reviewer | profile | 13KB Spring/Quarkus-aware review checklist; library has only java-*-patterns knowledge entries (java-spring-patterns, java-testing-patterns), no Java reviewer persona. |
| kotlin-build-resolver | profile | Gradle/kotlinc build-error fixer using only standard CLIs (no MCP/ECC scripts); library has kotlin-*-patterns only, no build-fixer persona. |
| kotlin-reviewer | profile | Kotlin/Android/KMP idiom+coroutine-safety reviewer; library kotlin entries (kotlin-android-patterns, kotlin-coroutines-patterns) are knowledge skills, no reviewer. |
| loop-operator | drop | 2KB thin operator bound to the ECC autonomous-loop harness (ecc:loop-start/loop-status commands, autonomous-loops/continuous-agent-loop skills); Darhai has no such loop harness, body has no standalone value. |
| marketing-agent | drop | Duplicate of library `marketing-strategist` (campaign planning, channel selection, copy, KPIs) plus create-marketing-campaign/marketing-strategy entries already in skills-library/index.json. |
| mle-reviewer | profile | 10KB production-ML review checklist (data contracts, training reproducibility, serving, rollback); library ml-ops-engineer/mlops-engineer are ops knowledge profiles, not reviewers. |
| network-architect | profile | Self-contained multi-site network design workflow (tools: Read/Grep only); ECC skill cross-refs are optional routing hints, body stands alone; library networking-* entries are career networking, unrelated. |
| network-config-reviewer | profile | Router/switch config review persona (security, stale refs, change-window risk); no computer-network reviewer exists in the library index. |
| network-troubleshooter | profile | Read-only OSI-layer diagnostic persona with evidence-backed RCA workflow; no library equivalent. |
| opensource-forker | profile | Self-contained fork+secret-strip workflow (generic rsync/regex/bash, 20+ patterns, .env.example generation); stage 1 of the opensource-pipeline trio — keep the set intact. |
| opensource-packager | profile | Generates README/LICENSE/CONTRIBUTING/issue templates for a sanitized repo; independently useful and no library equivalent; stage 3 of the opensource-pipeline trio. |
| opensource-sanitizer | profile | PASS/FAIL leak-scan verifier (secrets/PII/internal refs, 20+ regex) with generic tools only; stage 2 of the opensource-pipeline trio. |
| performance-optimizer | drop | Duplicate of library `performance-engineer` (bottlenecks, load testing, profiling) + `performance-profiler` (flame graphs, Big-O, benchmarking) already in index.json. |
| php-reviewer | profile | PSR-12/type-system/Eloquent review persona; library has php-*-patterns knowledge entries only, no PHP reviewer. |
| planner | profile | Core implementation-planning subagent targeted by ECC orchestration commands; library `roadmap-planner`/`milestone-planning` are product-roadmap personas, not code-feature planning — no duplicate. |
| pr-test-analyzer | drop | 2KB generic checklist; duplicated by library `testing-coverage-analyzer` (coverage gaps, test quality scorecard) and by Darhai's in-repo pr-review skill which already reviews PR test coverage. |
| python-reviewer | profile | PEP8/typing/security review persona; library python-* entries (python-idioms, python-testing-patterns) are knowledge skills, no Python reviewer. |
| pytorch-build-resolver | profile | CUDA/tensor-shape/DataLoader/mixed-precision error fixer; zero pytorch entries anywhere in the library index. |
| react-build-resolver | profile | 11KB Vite/webpack/Next/CRA build-failure and hydration-mismatch fixer; library react-* entries are patterns/builder personas, no build-fixer. |
| react-reviewer | profile | Hook-correctness/render-perf/RSC-boundary reviewer; library has react-architect (builder) and react-*-patterns, no React reviewer. |
| refactor-cleaner | profile | Dead-code elimination persona running knip/depcheck/ts-prune (generic npm CLIs, not MCP); distinct from library `refactoring-guru` (Fowler-catalog restructuring, no dead-code tooling) and fits Darhai's TS stack. |
| rust-build-resolver | profile | Cargo/borrow-checker build-error fixer with minimal-diff discipline; library rust-* entries are knowledge skills, no build-fixer. |
| rust-reviewer | profile | Ownership/lifetimes/unsafe review persona; library has rust-ownership-patterns etc. but no Rust reviewer. |
| security-reviewer | drop | Direct duplicate of library `security-auditor` (two entries: threat modeling + OWASP Top 10 code review) and `security-audit-codebase` already in index.json. |
| seo-specialist | drop | Duplicate of library `seo-advisor` (technical SEO audit, CWV, schema) + `seo-optimizer` (on-page, meta, structured data); marketing:seo-audit skill also covers audits. |
| silent-failure-hunter | profile | Unique review niche — swallowed errors, bad fallbacks, missing propagation (Anthropic review-agent family); no library equivalent. |
| spec-miner | profile | 15KB opus-grade self-bootstrapping behavioral-spec extractor; OpenSpec output format fully embedded in the body, tools read-only with Write guardrail — not MCP/ECC-bound, no library equivalent. |
| swift-build-resolver | profile | swift build/Xcode/SPM/code-signing error fixer; library swift-* entries are patterns/builder (swiftui-developer), no build-fixer. |
| swift-reviewer | profile | Protocol-oriented design/ARC/Swift Concurrency reviewer; no Swift reviewer in the library index. |
| tdd-guide | drop | Duplicate of library `tdd-workflow` entry and superseded by Darhai's assimilated superpowers TDD skill (task #26 best-of consolidation; CLAUDE.md routes TDD as a peer specialist skill). |
| type-design-analyzer | profile | Unique niche — type encapsulation/invariant-expression review (Anthropic review-agent family); no library equivalent (library type-* hits are unrelated). |
| typescript-reviewer | profile | TS/JS type-safety/async/security reviewer; library `typescript-guru` is a knowledge persona not a reviewer, and TS is Darhai's own stack — highest-value reviewer in the slice. |
| vue-reviewer | profile | 15KB Composition-API/reactivity/template-security reviewer; library vue entries (vue-builder, vue-composition-patterns) are builder/knowledge, no Vue reviewer. |

### 2.4 Rules (114)

| name | verdict | reason |
| --- | --- | --- |
| angular/coding-style | conditional | Angular-only style extension of common/coding-style with path frontmatter (**/*.component.ts etc.); load only for Angular projects. |
| angular/hooks | drop | Pure claude-CLI ~/.claude/settings.json PostToolUse/Stop hook config (Prettier, ng lint, tsc --noEmit, ng build) — hook lane, not a prompt rule; verified by source read. |
| angular/patterns | conditional | Angular framework patterns extending common/patterns; per-project-type load via path frontmatter. |
| angular/security | conditional | Angular-specific security extension of common/security; only relevant in Angular repos. |
| angular/testing | conditional | Angular-specific testing extension of common/testing; per-project-type load. |
| arkts/coding-style | conditional | HarmonyOS/ArkTS-only style rules; load when project knowledge detects ArkTS. |
| arkts/hooks | drop | HarmonyOS build/validation hook-config extending common/hooks — claude-CLI hook lane, same uniform pattern verified in angular/cpp/dart hooks samples. |
| arkts/patterns | conditional | HarmonyOS/ArkTS-specific patterns; per-project-type load. |
| arkts/security | conditional | HarmonyOS-specific security practices; per-project-type load. |
| arkts/testing | conditional | HarmonyOS-specific testing practices; per-project-type load. |
| common/agents | drop | Roster of ~/.claude/agents (planner, tdd-guide, code-reviewer...) plus Task-tool parallelism advice — claude-CLI agent-roster specific; the agent definitions themselves carry this info, and Darhai owns its own orchestration law. |
| common/code-review | drop | Severity ladder + review triggers duplicated inside ECC reviewer agents and Darhai's own .claude/skills/pr-review + pr-fix; its agent table (code-reviewer/security-reviewer/typescript-reviewer rows) is claude-CLI bound. |
| common/coding-style | core | 3KB engine-neutral universal discipline (immutability, KISS/DRY/YAGNI, early returns, explicit error handling, naming) — the archetypal always-on overlay; only minor naming overlap with Darhai AGENTS.md, rest is unique. |
| common/development-workflow | drop | Pipeline hard-bound to gh search/Context7/Exa MCPs and planner/tdd-guide/code-reviewer agents; the Research-Plan-TDD-Review-Commit flow is already inside kept ecc:orch-* skills and Darhai's pr-ship skill. |
| common/git-workflow | drop | Duplicates (and conflicts with) Darhai AGENTS.md Git Conventions — AGENTS.md mandates `<type>(<scope>): <subject>` + NEVER AI signatures while this rule says `<type>: <description>`; PR flow already in Darhai oss-pr skill. |
| common/hooks | drop | Claude-CLI harness config only: PreToolUse/PostToolUse/Stop hook types, auto-accept permissions, TodoWrite tips — zero engine-neutral discipline. |
| common/patterns | drop | Skeleton-project-first advice duplicated by ecc:search-first skill; repository pattern and API response envelope live verbatim in kept api-design/backend-patterns skills (and in csharp/patterns etc. conditional files). |
| common/performance | drop | Haiku/Sonnet/Opus model routing, Option+T thinking toggle, MAX_THINKING_TOKENS, alwaysThinkingEnabled — entirely claude-CLI/Anthropic-model specific, wrong for multi-engine Darhai. |
| common/security | core | 1KB pre-commit security checklist (no hardcoded secrets, input validation, parameterized queries, XSS/CSRF, secret rotation) — constitution-grade; deep how-to stays in security-review/security-scan skills. Conversion edit: Security Response Protocol step 2 references the **security-reviewer** agent (dropped in §2.3) — strip/remap that line at overlay conversion. |
| common/testing | core | 1KB universal WHAT-standard (80% coverage, TDD RED/GREEN/REFACTOR, AAA, three test tiers) per ECC's rules-vs-skills split; consistent with Darhai AGENTS.md's own >=80% coverage law, how-detail lives in kept tdd/testing skills. Conversion edit: two **tdd-guide** agent references (Troubleshooting + Agent Support sections; agent dropped in §2.3) — strip at overlay conversion. |
| cpp/coding-style | conditional | Modern C++/RAII/smart-pointer style rules, path-gated to *.cpp/*.hpp; per-project-type load alongside ecc:cpp-coding-standards skill. |
| cpp/hooks | drop | clang-format/clang-tidy/cmake/ctest pre-commit hook commands extending common/hooks — hook-config lane; identical commands already in ecc:cpp-build and ecc:cpp-testing skills. |
| cpp/patterns | conditional | C++-specific patterns (RAII FileHandle, rule-of-five); per-project-type load. |
| cpp/security | conditional | C++ memory-safety rules (no raw new/delete, bounds-checked access); per-project-type load. |
| cpp/testing | conditional | GoogleTest/CTest framework choice + run commands; per-project-type load. |
| csharp/coding-style | conditional | C#-specific style extension; load for .NET projects. |
| csharp/hooks | drop | C# extension of common/hooks — claude-CLI hook-config lane, same uniform 1KB pattern as the sampled angular/cpp/dart hooks files. |
| csharp/patterns | conditional | C# ApiResponse record + IRepository implementations of the common patterns; load for .NET projects. |
| csharp/security | conditional | C#-specific security extension; load for .NET projects. |
| csharp/testing | conditional | xUnit/FluentAssertions/Moq/Testcontainers conventions; load for .NET projects, complements ecc:csharp-testing skill. |
| dart/coding-style | conditional | Dart/Flutter-specific style rules, path-gated to *.dart/pubspec.yaml; per-project-type load. |
| dart/hooks | drop | Literal ~/.claude/settings.json PostToolUse JSON (dart format/analyze on $CLAUDE_FILE_PATHS) — claude-CLI hook config, verified by source read. |
| dart/patterns | conditional | Dart/Flutter ecosystem patterns; per-project-type load alongside ecc:dart-flutter-patterns skill. |
| dart/security | conditional | Dart/Flutter/mobile-specific security extension; per-project-type load. |
| dart/testing | conditional | Dart/Flutter-specific testing extension; per-project-type load. |
| fsharp/coding-style | conditional | F#-specific style extension; load for F# projects. |
| fsharp/hooks | drop | F# extension of common/hooks — claude-CLI hook-config lane, same uniform pattern as all other language hooks files in this bundle. |
| fsharp/patterns | conditional | F# Result/railway-oriented error-handling patterns (verified by source read); load for F# projects. |
| fsharp/security | conditional | F#-only secret-management/config patterns (paths **/*.fs, appsettings*.json); load only in F# projects, extends common/security which is judged elsewhere. |
| fsharp/testing | conditional | F#-only test stack (xUnit+FsUnit/FsCheck/Unquote, paths **/*.fs); per-project load; deep 'how' lives in kept skill ecc:fsharp-testing, this stays the short 'what' layer. |
| golang/coding-style | conditional | Go idiom layer (gofmt, pointer-receiver override of common immutability rule); paths **/*.go — Go projects only. |
| golang/hooks | drop | Pure claude-CLI hook config — file literally says 'Configure in ~/.claude/settings.json' PostToolUse gofmt/vet/staticcheck; Darhai engine has no settings.json hooks, and formatter/linter discipline is already in Darhai AGENTS.md quality-check pattern. |
| golang/patterns | conditional | Go-specific patterns (45 lines, paths **/*.go); per-project; deep counterpart is skill ecc:golang-patterns. |
| golang/security | conditional | Go-specific security checklist extending common/security; only relevant in Go projects. |
| golang/testing | conditional | Go test conventions (31 lines, paths **/*.go); per-project; deep counterpart is skill ecc:golang-testing. |
| java/coding-style | conditional | Java-only style rules (114 lines, paths **/*.java, pom.xml); per-project; overlaps skill ecc:java-coding-standards but rules stay the concise 'what' tier. |
| java/hooks | drop | claude-CLI hook config — 'Configure in ~/.claude/settings.json' PostToolUse google-java-format/checkstyle/mvnw; harness-bound, not engine-neutral, same drop rationale as golang/hooks. |
| java/patterns | conditional | Java-specific design patterns (147 lines, paths **/*.java); loaded only for Java projects. |
| java/security | conditional | Java-specific security extension of common/security (101 lines); Java projects only. |
| java/testing | conditional | Java test-framework specifics (JUnit stack, 133 lines); Java projects only. |
| kotlin/coding-style | conditional | Kotlin idiom layer (86 lines, paths **/*.kt); per-project load. |
| kotlin/hooks | drop | claude-CLI hook config — '~/.claude/settings.json' PostToolUse ktfmt/ktlint/detekt/gradlew; harness-bound, duplicates generic quality-check discipline already in Darhai AGENTS.md. |
| kotlin/patterns | conditional | Kotlin/Android/KMP patterns (146 lines); per-project; deep counterpart is skill ecc:kotlin-patterns. |
| kotlin/security | conditional | Kotlin/Android-specific security extension (82 lines); Kotlin projects only. |
| kotlin/testing | conditional | Kotlin/Android test specifics (128 lines); per-project; deep counterpart is skill ecc:kotlin-testing. |
| nuxt/coding-style | conditional | Nuxt-specific style rules (47 lines, paths nuxt.config.*, **/*.vue); framework-conditional load. |
| nuxt/hooks | drop | Self-declared harness config — file states 'These are Claude Code harness hooks... They run via the harness, not Claude' with a PostToolUse chain (nuxi typecheck/eslint/prettier); claude-CLI-bound, not engine-neutral. |
| nuxt/patterns | conditional | Nuxt-specific patterns (54 lines); framework-conditional; deep counterpart is skill ecc:nuxt4-patterns. |
| nuxt/security | conditional | Nuxt-specific security extension (48 lines, server/** paths); framework-conditional load. |
| nuxt/testing | conditional | Nuxt-specific testing rules (49 lines); framework-conditional load. |
| perl/coding-style | conditional | Perl idiom layer (46 lines, paths **/*.pl,**/*.pm); Perl projects only. |
| perl/hooks | drop | claude-CLI hook config — '~/.claude/settings.json' PostToolUse perltidy/perlcritic; harness-bound, same drop rationale as the other */hooks.md files. |
| perl/patterns | conditional | Perl-specific patterns (76 lines); per-project; deep counterpart is skill ecc:perl-patterns. |
| perl/security | conditional | Perl-specific security extension (69 lines); per-project; deep counterpart is skill ecc:perl-security. |
| perl/testing | conditional | Perl test conventions (54 lines, paths **/*.t); per-project; deep counterpart is skill ecc:perl-testing. |
| php/coding-style | conditional | PHP idiom layer (40 lines, paths **/*.php, composer.json); PHP projects only. |
| php/hooks | drop | claude-CLI hook config — '~/.claude/settings.json' PostToolUse Pint/PHPStan/PHPUnit plus var_dump warnings; harness-bound, not engine-neutral. |
| php/patterns | conditional | PHP-specific patterns (33 lines); PHP projects only; framework depth lives in ecc:laravel-patterns skill. |
| php/security | conditional | PHP-specific security extension (37 lines); language layer distinct from framework skill ecc:laravel-security. |
| php/testing | conditional | PHP test conventions PHPUnit/Pest (39 lines); PHP projects only. |
| python/coding-style | conditional | Python idiom layer (42 lines, paths **/*.py); Python projects only. |
| python/fastapi | conditional | Framework-specific (paths **/app/**/*.py, **/*_api.py), loads only atop python rules in FastAPI projects; deep counterpart is skill ecc:fastapi-patterns. |
| python/hooks | drop | claude-CLI hook config — '~/.claude/settings.json' PostToolUse black/ruff/mypy plus print() warning; harness-bound, same drop rationale as golang/hooks; verified by direct read. |
| python/patterns | conditional | Python-specific patterns (39 lines); per-project; deep counterpart is skill ecc:python-patterns. |
| python/security | conditional | Python-specific security extension (30 lines); Python projects only. |
| python/testing | conditional | pytest-stack conventions (38 lines); per-project; deep counterpart is skill ecc:python-testing. |
| react/coding-style | conditional | React-only file-extension/component style extending typescript+common; load only for React project type. |
| react/hooks | conditional | Genuine React runtime-hook rules (useState/useEffect, rules-of-hooks) — header explicitly says NOT Claude Code hooks; React projects only. |
| react/patterns | conditional | React composition/state patterns extending typescript/patterns; framework-specific, per-project load. |
| react/security | conditional | React XSS/dangerouslySetInnerHTML specifics extending typescript/security; React projects only. |
| react/testing | conditional | React Testing Library specifics extending typescript/testing; React projects only. |
| README | drop | Installer/structure meta doc (install.sh, cp -r recipes, rules-vs-skills, layering priority) — duplicates Darhai's own bundling/loader mechanics and AGENTS.md layering law; zero runtime discipline value. |
| ruby/coding-style | conditional | Ruby/Rails idiom style extending common/coding-style; Ruby projects only. |
| ruby/hooks | drop | claude-CLI hook-config: PostToolUse wiring for rubocop/brakeman/rspec commands in settings.json; the debugger/pry warnings duplicate ruby/coding-style content. |
| ruby/patterns | conditional | Rails service-object/AR patterns extending common/patterns; Ruby projects only. |
| ruby/security | conditional | Rails CSRF/mass-assignment/SQL specifics extending common/security; Ruby projects only. |
| ruby/testing | conditional | RSpec/minitest specifics extending common/testing; Ruby projects only. |
| rust/coding-style | conditional | Rust idiom style (rustfmt, ownership, error handling) extending common/coding-style; Rust projects only. |
| rust/hooks | drop | claude-CLI hook-config: literally 'Configure in ~/.claude/settings.json' for cargo fmt/clippy/check PostToolUse — no engine-neutral content. |
| rust/patterns | conditional | Rust-specific patterns extending common/patterns; Rust projects only. |
| rust/security | conditional | Rust unsafe/deps-audit specifics extending common/security; Rust projects only. |
| rust/testing | conditional | cargo test/proptest specifics extending common/testing; Rust projects only. |
| swift/coding-style | conditional | Swift style extending common/coding-style; Swift/iOS projects only. |
| swift/hooks | drop | claude-CLI hook-config: 'Configure in ~/.claude/settings.json' SwiftFormat/SwiftLint/swift-build PostToolUse; the print()-vs-Logger warning belongs in swift/coding-style anyway. |
| swift/patterns | conditional | Swift-specific patterns extending common/patterns; Swift projects only. |
| swift/security | conditional | Swift/iOS keychain-ATS-style security extending common/security; Swift projects only. |
| swift/testing | conditional | XCTest specifics extending common/testing; Swift projects only. |
| typescript/coding-style | conditional | TS/JS style (strict types, naming, module conventions) extending common/coding-style; TS/JS projects only — Darhai itself is TS, so this is a prime per-project-load candidate, not always-on. |
| typescript/hooks | drop | claude-CLI hook-config: 'Configure in ~/.claude/settings.json' Prettier/tsc/console.log PostToolUse+Stop hooks; console.log discipline already lives in common/code-review checklist and typescript/coding-style. |
| typescript/patterns | conditional | TS-specific patterns (discriminated unions, result types) extending common/patterns; TS projects only. |
| typescript/security | conditional | TS/Node security specifics extending common/security; TS projects only. |
| typescript/testing | conditional | Vitest/Jest specifics extending common/testing; TS projects only. |
| vue/coding-style | conditional | Vue SFC style extending common/coding-style; Vue projects only. |
| vue/hooks | drop | claude-CLI hook-config: PostToolUse targets for vue-tsc/eslint-plugin-vue/prettier; the one useful nugget (vue-tsc not tsc for SFCs) is tool-wiring advice, not standalone discipline — merge candidate into vue/testing if ever needed. |
| vue/patterns | conditional | Vue composition-API/Pinia patterns extending common/patterns; Vue projects only. |
| vue/security | conditional | Vue v-html/XSS specifics extending common/security; Vue projects only. |
| vue/testing | conditional | Vue Test Utils specifics extending common/testing; Vue projects only. |
| web/coding-style | conditional | Frontend-specific (CSS custom properties, compositor-only animation, semantic HTML) extending common/coding-style; load for web-frontend projects only. |
| web/design-quality | conditional | Anti-template design policy — frontend-only and overlaps design skills in the roster (design-taste-frontend, ecc:frontend-design-direction); keep as conditional web-project rule unless the skills slice confirms a kept skill covering it, then demote to drop. |
| web/hooks | drop | claude-CLI hook-config: pure PostToolUse/PreToolUse/Stop JSON blocks (pnpm prettier/eslint/tsc-incremental, 800-line write guard, pnpm build) — settings.json wiring with no engine-neutral rule content. |
| web/patterns | conditional | Frontend patterns (compound components, server-vs-client state, URL-as-state, SWR/optimistic) extending common/patterns; web projects only. |
| web/performance | conditional | CWV targets, bundle budgets, image/font loading — web-frontend-specific extension of common/performance; per-project load. |
| web/security | conditional | CSP/security-headers/XSS specifics extending common/security; web projects only. |
| web/testing | conditional | Visual-regression/a11y/cross-browser/Playwright priorities extending common/testing; web projects only. |

## 3. Conversion recipes (codemap anchors)

Each lane below follows an existing, proven mechanism in the codebase — no new
architecture is invented for phase 2. Master rows: codemap
[00-overview.md](../codemap/00-overview.md) §3a.

### 3.1 Skills (`keep-corpus` + edited `adapt`) → skills-library corpus

Per §3a row "ECC skills" (00-overview.md:153) and
[05-process-skills-system.md](../codemap/05-process-skills-system.md) extension
recipe 2 ("Vendoring a large skill corpus"):

- Extend `src/process/resources/skills-library/index.json` + `bodies/` (relative
  paths, `security.verdict:'unscanned'`), **or** copy the `bundled-workflows`
  optional-corpus pattern + `electron-builder.yml` extraResources (§05 anchor 2).
- Retrieval namespace: `semantic/types.ts` + a lane mirroring
  `skillSemanticLane.ts` (§02 anchor 6).
- SkillGuard scan-before-persist applies to every imported body; `blocked` =
  fail-closed (§05). `adapt` items pass through their per-item edit note first.
- Generic corpus normalization handles claude-ish frontmatter (`allowed-tools`,
  `argument-hint`), YAML folded scalars, and cross-links to dropped siblings
  (resolve or strip — e.g. `token-budget-advisor` → dropped `context-budget`).

### 3.2 Commands (`workflow` / `skill`) → workflow-typed and skill-typed entries

Per §3a row "ECC commands" (00-overview.md:155):

- `skills.list` already supports `type:'workflow'`
  ([09-process-bridge-ipc.md](../codemap/09-process-bridge-ipc.md), `ipcBridge.ts:394-400`)
  — `workflow`-verdict commands become workflow-typed library entries.
- Workflow runtime: `WorkflowSessionService` + `parseSteps` +
  `dispatchAutonomousStep` (§02 anchor 5); in-message command protocols mirror the
  cron trio `CronCommandDetector` → `MessageMiddleware` (§07 anchor 3).
- `skill`-verdict commands convert through the same corpus pipeline as 3.1
  (their bodies are linear playbooks, not orchestrations).
- ECC agent references inside kept bodies re-point to the surviving
  agent-profiles of §2.3 (e.g. `/review-pr` → six reviewer profiles).

### 3.3 Agents (`profile`) → agent-profile corpus + assistant merge

Per §3a row "ECC agents" (00-overview.md:156) and
[10-process-extensions-hub.md](../codemap/10-process-extensions-hub.md):

- Follow `agentProfileMerge.ts` — SKILL.md body → assistant `context` +
  `prompts.system`, avatar/category mapping, id-dedup with live records winning —
  invoked from `ExtensionRegistry.resolveContributions` (§10 anchor 2).
- Each kept profile gets a **curated** skill-slug row in `agentProfileSkills.json`
  (BM25-derived + hand-audited, §10) pointing at its companion corpus skills
  (e.g. `django-reviewer` → `django-*` skills from §2.1).
- Presets surface via `ASSISTANT_PRESETS` (`src/common/config/presets/assistantPresets.ts`, §15).

### 3.4 Rules (`core` / `conditional`) → constitution overlay vs project knowledge

Per §3a row "ECC rules" (00-overview.md:154) and
[02-process-services-general.md](../codemap/02-process-services-general.md):

- `core` → byte-stable constitution overlay via `constitution/composePrompt.ts`
  (§02) — always-on, engine-neutral text only (3 files, see spotlight).
- `conditional` → per-project knowledge: `projectKnowledge/knowledge.ts`
  KNOWLEDGE_FILE map + `ConversationServiceImpl.injectProjectKnowledge` writing
  `extra.presetRules`/`presetContext` (§02 anchor 8); the rules' existing `paths:`
  frontmatter drives project-type gating. System-prompt overlays live in
  `agentUtils.ts` (`prepareFirstMessageWithSkillsIndex` /
  `buildSystemInstructionsWithSkillsIndex`, §07 anchor 4).
- Dropped `*/hooks.md` files are settings.json hook wiring — their enforcement
  logic (format/lint/typecheck gates) is phase-3 native-guard scope, not prompt text.

## 4. Spotlight — items needing human-visible attention (core / builtin / assistant lanes)

Short list of verdicts that go beyond the mechanical corpus pipeline:

- **Core constitution rules ×3** — `common/coding-style`, `common/security`,
  `common/testing` become **always-on prompt text for every session** via
  `composePrompt.ts`. Wording needs serge's sign-off before landing (it applies
  globally, and must not conflict with AGENTS.md — note `common/git-workflow` was
  dropped precisely for such a conflict).
- **`gateguard` (skills, adapt)** — the one `adapt` whose target is NOT the corpus:
  its DENY/FORCE/ALLOW three-stage logic ports into Darhai's native tool-approval
  gate with an env toggle (per the darhai-ecc-bundling decision). Hand off to
  **phase 3** (native guard), do not push through the corpus converter.
- **Workflow commands ×10** — `code-review`, `feature-dev`, `gan-build`,
  `gan-design`, `plan`, `plan-prd`, `prp-implement`, `prp-plan`, `review-pr`,
  `santa-loop` become user-visible workflow entries; user-facing naming must be
  Darhai-branded (README rule 4). Coupled sets: `prp-plan`→`prp-implement`
  (shared plan-artifact contract); `gan-build`/`gan-design` depend on the
  `gan-style-harness` skill + `gan-planner`/`gan-generator`/`gan-evaluator`
  profiles; `santa-loop` runs the `santa-method` skill; `review-pr` fans out six
  reviewer agents of which four survive as profiles here (`code-reviewer` and
  `pr-test-analyzer` were dropped as existing-library duplicates — re-point to
  those library profiles).
- **Agent-profiles ×53** — every kept profile needs a hand-audited
  `agentProfileSkills.json` curation row (§10). Ship trios intact:
  `opensource-forker`/`-sanitizer`/`-packager` and the gan trio.
- **Merge-at-reconciliation flags** — commands `gradle-build` vs `kotlin-build`
  overlap (one concept = one skill, README rule 3); `token-budget-advisor`
  cross-links dropped `context-budget`; `email-ops`/`terminal-ops`/`research-ops`
  Skill Stack sections must re-point to surviving corpus names only.
- **`hookify-rules` (keep-corpus)** — documents the bundled hookify engine that
  ships default-off; keep its toggle story coherent when phase 3 rewrites hook
  enforcement natively.
- **`bun-runtime` (keep-corpus)** — directly relevant to Darhai's own build stack;
  candidate for pinning/priority in retrieval rather than plain corpus placement.
