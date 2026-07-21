# Upstream судалгаа: wayland v0.9.6-rc.1 → v0.11.18 (829 commit)

Дархай (fork @ `bbc231cd`, 2026-06-21, 66 өөрийн commit) дээр порт хийх шийдвэрт зориулсан бүрэн тайлан.
8 шинжээч тус бүр ~104 commit-ийг хамарч, superseded/skip-ийг хассан цэвэр олдвор.

---

## 1. Товч дүгнэлт

- Upstream 13 хувилбарын турш голдуу **тогтворжуулалт** хийсэн: pre-fork surface дээрх security/crash/data-loss засварын том давалгаа + Windows платформын зөв ажиллагаа + agent-ийн turn lifecycle найдвартай байдал. Ихэнх нь Дархайн **суурь код** дээр яг адилхан үйлчилнэ.
- Дархайд хамгийн чухал нэг олдвор: **`darhai-search-skills` MCP бүх skill body-г буцаадаг** (metadata биш) — 2470 body дээр context-ыг дэлбэлж skill хайлтыг бараг эвддэг. Хоёр шинжээч fork point дээр **баталсан**.
- Аюулгүй байдлын жинхэнэ асуудлууд: webserver/LAN openness arc, isolated-profile credential шифрлэлтгүй хадгалагдах, log-д tool output/secret задрах, `resetPasswordCLI` bcrypt 10 vs 12 (HEAD дээр **баталсан**), auto-mode approval эргэлт.
- Windows-first үзэгчдэд шууд цохих: npx/npm.cmd resolution, packaged-app child-spawn (fork-bomb эрсдэл), process-tree reaping, engine update file-lock, uninstall registry үлдэгдэл.
- Өндөр үнэ цэнэтэй **шинэ** боломжууд Дархайн философид (OAuth-first, solo-dev, монгол) сайн тохирно: ChatGPT-subscription catalog, cost circuit-breaker, Concierge in-app туслах, MCP tool-scaling, agent observability, Obsidian memory import.
- Дархай **аль хэдийн илүү** хийсэн: OmniRoute (бүх Flux gateway commit хэрэггүй), native memory auto-extract + Cyrillic retrieval (IJFW FTS5 давсан), pre-tool guard (catastrophic-command classifier давсан), cookbook local serve, bun-PATH installer.
- Гол хязгаарлалт: heavy divergence тул cherry-pick цэвэр гарахгүй — **гараар дахин хэрэглэх** (renamed identifiers, шилжсэн файлууд). Тул засваруудыг эрэмбэлж багцлан порт хийх стратеги хэрэгтэй.

---

## 2. ⚠️ ЗААВАЛ АВАХ засварууд (security / crash / data-loss)

Хүнд байдлаар эрэмбэлэв. Олон шинжээч давхар мэдээлсэн arc-уудыг нэгтгэв. **✅ = fork point дээр баталсан.**

### Tier 0 — Дархайд онцгой нөлөө (skills-library)

| sha | юу | яагаад чухал | хэмжээ |
|-----|----|--------------|--------|
| `75c7f0f57` / `881208b59` ✅ | `darhai-search-skills` metadata л буцаах (body биш) | 2470 body-г результатад цутгаж context/token дэлбэлж skill search-ыг эвднэ. Дархайн rebrand хийж default-оор ачаалдаг яг тэр tool. **Хамгийн өндөр нөлөө.** | M |
| `4dde456db` | Always-on skill injection-ыг builtin+enabled болгож багасгах; per-turn skill match WCore дээр асаах | ПРОМПТ БҮРТ ~3,200 token skill index шахаж, `buildTurnSkillContext` default surface (WCore) дээр огт fire болдоггүй. 2470 body үүнийг олон дахин томруулна. Helper-ууд Дархайн `agentUtils.ts`-д аль хэдийн байгаа тул порт шууд. | S |
| `e6f8b8b08` | `agentProfileMerge` packed skill body уншиж чадахгүй | packed body уншиж чадахгүй бол skill-ийг agent profile-оос чимээгүй алдана — 2470 body шууд өртдөг. | S |
| `46566348d` / `d0e2fb301` ✅ | asar доторх bundled skill/extension pack-ийг байран дээр унших + asar dir-ийг asset serve-д allowlist | Packaged (asar) build-д bundled ECC/skills pack ачаалагдахгүй; Дархай packaged build яг энэ эвдрэлд орно. | M |
| `1fd66b96a` (+`c281db4f0`) | Vendored skill/workflow body-г offset-indexed blob болгож pack хийх + build-д шалгах | 2470 body-г бүрэн ачаалж parse хийхээс сэргийлж memory/startup хэмнэнэ; build-time шалгалт эвдэрсэн pack илгээхээс сэргийлнэ. | M |

### Tier 1 — Security

| sha | юу | яагаад чухал | хэмжээ |
|-----|----|--------------|--------|
| `e7a3a15a1` (+`24376b36e`,`22a330805`,`99d8fad4c`,`316a74241`) | Webserver/LAN exposure arc: LAN-bind consent, remote config-write denial, tailnet-verified CGNAT trust, proxy-aware loopback demotion | Pre-fork webserver LAN дээр чимээгүй bind хийж чадна; remote peer bridge-ээр `webui.desktop.*` config бичих (config-write ≈ code-exec). `networkTrust.ts` post-fork тул Дархайн pre-fork webserver дээр гараар дахин барина. | L |
| `3be7b096a` | Isolated-profile engine credential-ыг keychain vault passphrase-аар шифрлэх | Pre-fork суурьт provider key диск дээр шифрлэлтгүй хэвтэнэ; local malware/backup leak бол алдагдана. | M |
| `408eeb7cd` | Persistent log-д tool output-ыг redact хийх | `WCoreManager` түүхий tool output (secret/token/файл агуулга) log файлд бичдэг. | S |
| `b72b9b309` ✅ | `resetPasswordCLI` bcrypt 10→12 + `--resetpass` flag хүлээн авах | HEAD дээр **баталсан**: CLI-reset admin нууц үг бусад бүх path-аас сул (10 vs `SALT_ROUNDS=12`); бас `--resetpass` flag чимээгүй юу ч хийдэггүй. | S |
| `602db7db0` / `1154bd4ff` ✅ (#264) | Auto-mode-д `approval_required`-ыг Confirming gate-ээр escalate | Auto-approve mode-д engine-ийн approval_required tool call bypass/stall болно. Дархайн native pre-tool guard яг энэ WCore boundary дээр суудаг тул суурийн алдаа өөрийнх нь guard-ыг сулруулна. | M |
| `111003a4b` (+`e8af32c2e`) | Timeline: inline secret-ыг redact + жинхэнэ shell командыг харуулах | Pre-fork timeline shell доторх secret-ыг plain-text харуулж, батлах командыг ерөнхий label-аар нуудаг. Дархайн secret-WARN hook-той хосолно. | S |
| `d33bf2c02` | BYO MCP connector version-ыг spawn дээр pin хийх | Pin хийгээгүй npx spawn runtime-д latest package татаж hijack эрсдэлд оруулна. | S |
| `f1da11dc8` (+`f5c9d4f70`) | Connector: symlink-safe backup + per-agent write mutex + verify-then-rollback + 0600 credential perm | Config бичих symlink дагадаг, зэрэгцээ бичилт config-ыг эвдэж болно; credential файл owner-only биш. Шинэ module тул цэвэр гараар порт. | M |
| `e6f8af...` (+`1da5b64b7`) | Cleartext-http extension `entryUrl`-ыг gate хийх | http дээрх extension entryUrl → MITM script injection desktop app руу. | S |
| `2c80c93d7` (+`f6ddac4a8`) | Headless file-key JWT secret decrypt + WS reconnect storm хаах | Headless WebUI WS auth mismatched secret ашигладаг (auth эвдэрсэн); хугацаа дуусахад хязгааргүй reconnect storm. | S |
| `0883bd539` | Wire-Force gate + remote cron escalation surface хаах (#495, GHSA-8r7g) | Remote/bridge caller cron/force escalation path-д хүрч чадна (red-team tested). wayland-core v0.12.19 GHSA багцыг core талд шалга. | S |
| `25031fbb1` (+`7ee255460`) | Skill import: builtin-shadowing guard, recursive mkdir, frontmatter validation | Imported skill builtin-ыг shadow хийж чадна (Дархайн bundled ECC/skills-д integrity эрсдэл). | S |

### Tier 2 — Crash / hang / stuck-UI

| sha | юу | яагаад чухал | хэмжээ |
|-----|----|--------------|--------|
| `07ae0df51` ✅ | cmdk command palette default `actions` source | `CommandPalette.tsx` `actions`-ыг guard-гүй destructure — renderer crash. Дархайд guard байхгүйг **баталсан**. | S |
| `9924b4e5b` (+`99ff39816`,`525f71d2b`,`57a7ba8a5`) | Packaged-app child-spawn arc: жинхэнэ JS runtime, safe cwd, ijfw robustness | `process.execPath`-ыг node script-д spawn хийвэл fused binary дахин ачаална (fork-bomb/эвдрэл); bundle-internal cwd бүтэлгүйтэнэ; ijfw non-JSON stdout дээр гацна. Windows exe-д илгээгддэг. | M |
| `ceab1627f` (+`eaa75edfb`,`cd1015a5e`,…) | Hosted MCP OAuth connector + module-init TDZ crash chain | `McpOAuthService` import order TDZ ReferenceError startup дээр (crash-class). Fork point дээр байгаа тул бүх chain хамаарна; aioncli patch дахин үүсгэх шаардлагатай. | M |
| `8f53f18b0` | Local stdio MCP alive байлгах (Electron-as-Node spawn, stderr capture, bun-dir validate) | node-гүй машин дээр builtin stdio MCP `-32000`-оор үхнэ. Дархайн `darhai-*` stdio server end-user машин дээр яг ижил бүтэлгүйтэнэ. | M |
| `e87a53bc2` | Partial bunx extraction-ыг self-heal | Гэмтсэн bunx cache Claude Code ACP agent-ыг мөнхөд эхлүүлэхгүй болгоно (гараар устгах хүртэл). `acpConnectors.ts` байгаа. | S |
| `6f266d51c` ✅ | Sync/remove chokepoint дээр MCP server нэрийг sanitize | reverse-DNS slash бүхий нэр (`com.slack/slack-mcp`) БҮХ config sync-ыг crash хийж, sanitized server-ыг устгаж болдоггүй orphan болгоно. Хоёр файл Дархайд өөрчлөгдөөгүй. | S |
| `55c390ee3` (+`4e9963e3c`) | Skills settings: non-array `metadata.tags` crash guard + pin star hydrate | Гажуудсан metadata-тай skill detail drawer нээхэд TypeError — 2470 third-party body дээр магадлал өндөр. | S |
| `f5239f8f3` (+`7bc4a2625`) | Memory UI crash containment: score-tooltip hover + detail-panel error boundary | Memory score tooltip hover бүх app-ыг цайруулна. | S |
| `155882f2a` (+`e95abea5c`) | Preview file-viewer crash containment + back-after-error nav + Windows npm resolution | Crash хийсэн file viewer бүх conversation route-ыг унагаана; back товч эвдэрнэ. | M |
| `7586560a0` | oneShot: JSON.parse-аас өмнө body унших (HTML 502 crash) | Provider gateway 502/5xx дээр HTML буцаана; JSON.parse throw хийж oneShot completion-ыг үхүүлнэ. Дархайн OmniRoute resilience энэ дээр суудаг. | S |
| `04e838f63` (+`0189a5f16`,`375c7b991`) | Teams: non-array team list white-screen crash + teammate provider auth inherit | Гажуудсан team list renderer crash (цагаан дэлгэц); spawned teammate credential өвлөхгүй auth алдана. | S |
| `372470400` | Google Workspace MCP 1.4.2→1.22.0 (import дээр crash, pydantic) | Fork point дээрх Google Workspace MCP entry import дээр crash. | S |
| `8f6482f6d` / `3ef6269e2` ✅ (+`4c4187def`) | Agentic turn provider error → chat мөнхөд гацахаас сэргийлж error surface хийх | Turn дунд provider error бол chat хариу өгөхгүй болно (restart хүртэл) — crash-эквивалент. Дархайн ACP/WCore manager дээр баталсан. | M |

### Tier 3 — Data-loss / data-corruption

| sha | юу | яагаад чухал | хэмжээ |
|-----|----|--------------|--------|
| `9f4df293a` | Named profile-ыг default profile-ийн data дээр огт ажиллуулахгүй | Named profile default profile-ийн data directory дээр ажиллаж conversation/config-ыг холих/дарж болно. | M |
| `2bbe1cc47` (+`4d59e7a75`,…) | Teams reliability batch: wake үед mailbox delivery, codex/claude flow unstick, watchdog, model cache sync | Leader-ийн wake үед ирсэн mailbox message чимээгүй алдагдана; codex-add/claude-fire deadlock. Teams бүрэн pre-fork. | M |
| `056296c76` / `7918c9179` / `b78f4eaa7` ✅ (+`7f1e88d75`) | Persistent per-project workspace, temp-dir default-ыг устгах | Pre-fork default agent-ийн ажлыг OS-ийн арчдаг temp space-д бичнэ; project chat буруу/түр directory руу орно. `ConversationServiceImpl.ts` дээр баталсан. | M |
| `c1345c656` ✅ | WCore: resume үед recent persisted history seed хийх | engine `--resume` history сэргээж чадахгүй чимээгүй fresh session руу орно — resumed chat бүх context-оо алдана. Дархайн `WCoreManager.ts`-д байхгүйг баталсан. | S |
| `d1457cf18` | DB: orphaned team-child row-ыг эмчлэх (schema upgrade brick сэргийлэх) | Pre-fork teams orphan row үлдээнэ; дараагийн migration user DB-г brick хийж болно. Дархай v51–v55 migration эзэмшдэг тул FK-tightening ирвэл яг тэр landmine. | S |
| `272c54a01` ✅ | Cron: numeric weekday parse (routine засахад долоо хоног→өдөр бүр 09:00 болдог) | `parseCronExpr` зөвхөн нэрлэсэн weekday match хийдэг; numeric DOW schedule засахад устдаг (чимээгүй data corruption). | S |
| `7db58d06a` (+`b72f7c635`) | ACP pending-message single slot → FIFO queue + flush guard | Turn ажиллаж байхад илгээсэн follow-up message error/дарж бичнэ — user input чимээгүй алдагдана. | S |
| `bb5215972` (+`57f1d9e25`) ✅ | Composer draft-ыг reload/restart-д хадгалах | Бичсэн ч илгээгээгүй текст reload/restart дээр чимээгүй алдагдана. Дархайн `useSendBoxDraft.ts` 0 persistence гэж баталсан. | S |
| `d878b430a` (+`750ff39a0`,…) | modelRegistryIpc picker cluster: Refresh Ollama catalog-ыг устгахаа болих | Per-provider Refresh local Ollama catalog-ыг чимээгүй устгана (local-first-д data loss); хоосон/буруу ACP picker. | M |
| `a11477782` | User-ийн `~/.codex/config.toml`-ыг sandbox mode-д дахин бичихээ болих | App user-ийн global codex config-ыг чимээгүй дарж бичдэг. Дархайн ACP/codex path-д үйлчилнэ. | S |
| `9c93ba86f` | Projects: буурсан reference файлыг хадгалж, partial failure мэдээлэх | Project-knowledge ingest дээр reference файл чимээгүй буурч, алдаа мэдээлэгддэггүй. | S |
| `6c95abd26` (chain) | Edited custom agent/assistant-ыг найдвартай хадгалах | Stale `activeAssistant`-тай хадгалахад assistant засвар чимээгүй буурна (data loss). `useAssistantEditor.ts` Дархайд байгаа. | S |
| `96ca1f6e7` ✅ (+`f9a2c7b38`) | Paste: unique clipboard image нэр (дараалсан paste collapse болохоос) | Chromium бүх paste-ыг `image.png` гэж нэрлэнэ; de-dup бүгдийг нэг файл болгож agent БУРУУ зураг авна (privacy + correctness). `PasteService.ts` дээр баталсан. | S |
| `b602d9d9f` | claude-mem importer native Claude Code project memory алддаг | Migration үед project-level memory чимээгүй алдагдана. | S |

### Tier 4 — Correctness (routing / picker / provider / UX)

| sha | юу | яагаад | хэмжээ |
|-----|----|--------|--------|
| `5d06c4d00` (+`34762127b`,`28b113888`) | OpenAI-family model-ыг Anthropic surface-аас зайлуулах | envBuilder OpenAI model-ыг Anthropic surface руу илгээж hard fail. | M |
| `dc52d184d` / `c6e4375b7` (#478) | Enabled MCP connector бүх backend (Codex/wcore/Gemini)-д хүрэх | User-enabled MCP зарим backend дээр чимээгүй байхгүй. `darhai-*` rename map хийх. | M |
| `2a1371b30` (chain) | Model/provider binding sweep: native Claude pick барих, Gemini teammate scope, workflow launch bind | 4 буруу binding (pick дарагдах, teammate буруу provider руу гоожих). Дархайн compare/fusion яг энэ layer дээр. | M |
| `a6691f494` (chain) | Model-registry chat-start / allowlist-drift fix chain | Catalog provider chat эхлүүлж чадахгүй (picker Settings руу үсэрнэ), disable/availability desync. | M |
| `3f478f346` / `c32a1ccfb` | Model-selection stability: race-аар pick revert; disconnect дээр stale model буулгах | Хэрэглэгчийн сонголт чимээгүй өөр model руу очно (correctness + cost). | M |
| `773f3c589` | Picker-ээс embedding/image/audio model хасах | bge/image/audio model chat-д сонгож эвдэрсэн conversation. | S |
| `4ec2deef5` / `7475523b9` (chain) | Context meter sizing: жинхэнэ model window, 1M model зөв тооцоо | Буруу/1M default-аас sized meter → context-overflow fail, буруу compaction timing. | S |
| `3b1f59382` | max_tokens-ыг нэрээр таахаа болих (engine per-model size) | Нэрний substring-аас гарган авах output limit unknown/custom model-ыг эвднэ — Дархайн local/монгол custom id-д онц хамаатай. | S |
| `cf6950939` (chain) | Keyless local Ollama: placeholder key init + picker force-enable | Key-гүй local Ollama init fail, picker-т гарахгүй — cookbook local serve-д хамаатай. | M |
| `58566e9ed` | `/models`-гүй custom OpenAI-compatible endpoint холбох | vLLM/llama.cpp server ихэвчлэн `/models`-гүй — Дархайн local-model audience-д шууд. | S |
| `0b00ac45a` (chain) | Live model catalog (DashScope/MiniMax/ChatGPT-sub) + MiniMax native route | Hardcoded жагсаалт хуучирч dead model санал болгоно; MiniMax буруу provider path. | M |
| `529c6bc34` (+`4513ee711`) | MiniMax international host + Perplexity versioned `/v1/models` | MiniMax mainland-CN host руу очно (Монголоос хүрэхгүй); Perplexity connect эвдэрсэн. | S |
| `37bde83dd` (+`3fdd52417`) | Шинэ API-key format (Google `AQ.`, OpenAI `sk-svcacct`/`sk-admin`, GitHub Models) | Суурь эдгээрийг invalid гэж татгалзана — Gemini user-д onboarding blocker. | S |
| `227230be6` / `c48e373ad` ✅ (#197,#233) | `ENGINE_ENV_ALLOWLIST` passthrough: `LD_LIBRARY_PATH` + `WAYLAND_BASH_SHELL`(→`DARHAI_*`) | GUI-spawned engine local-model native lib (CUDA) болон shell сонголтын env алдана. Rename гараар. | S |
| `199f304cc` / `ef922bde7` ✅ | Windows: MCP session-д npx resolve + ijfw safeSpawn npm.cmd | `npx` vs `npx.cmd`, POSIX perm check `npm.cmd`-ыг татгалзана — Windows-first `darhai-*` + user MCP-д шууд цохино. | S |
| `1f3926f06` ✅ | ACP: Accept Edits mode-ыг permission gate дээр хүндэтгэх | acceptEdits mode advertised ч `agentModes.ts` `shouldAutoApproveAcpEdit`-гүй — mode зарлагдсан ч хэрэгждэггүй. | S |
| `60b8c17d9` ✅ (#60) | ACP: streaming үед idle clock амьд байлгах | `IdleReclaimer` зөвхөн send дээр refresh хийдэг тул идэвхтэй stream mid-conversation suspend болж bridge үхнэ. `touchActivity()`-гүйг баталсан. | S |
| `e41615065` (#746) | Идэвхгүй turn-ыг idle watchdog-оор зогсоох | WCore turn output-гүй мөнхөд гацаж finalize болохгүй. | M |
| `ac1bbc45d` (+`346f71831`) | ACP mid-run error recovery + respawn-storm banner collapse | Mid-run ACP error agent-ыг мөнхөд зогсоож, гэмтсэн adapter respawn storm + banner spam үүсгэнэ. | M |
| `2f4932b5c` (+`14c53f780`) (#787) | Turn-finalize dedup (turn_id-аар) | Teammate re-wake хийхэд finalize event давхарлаж side-effect давхар ажиллана. | M |
| `c9139aeec` | Crash-аар тасарсан turn-ыг launch дээр reconcile | Crash-ийн дараа in-flight turn DB-д мөнхөд `running` үлдэнэ. | S |
| `3f0dc9e2e` | Allow-always ACP approval-ыг restart хооронд хадгалах | "always allow" restart дээр мартагдаж дахин prompt. Дархайн ACP approval-boundary guard-тай харилцана. | S |
| `de7986801` / `15e1f5510` / `be7bfe69e` (chain) | Orphaned core/ACP engine child-ыг quit + uninstall дээр reap (process-tree kill) | Engine child app quit-ийн дараа амьд үлдэж хуримтлагдана (RAM/CPU) + файл lock-оор update/uninstall эвднэ. Windows-first (StreamFlex NSIS-тэй ижил анги). | M |
| `d30782b87` (+`dcf931288`) | Windows engine update: boot дээр stage + apply | Ажиллаж байхад bundled engine binary солигдож чадахгүй (file lock) — engine update чимээгүй fail (#492). | M |
| `3afb6b93c` | Windows uninstall: protocol handler + start-on-boot registry цэвэрлэх | NSIS uninstall устгасан binary руу зааж буй registry үлдээнэ. | S |
| `03a31bd06` | Windows: Hermes hook/unbuffered output + OpenClaw IPv4 shim | Hermes/OpenClaw backend Windows дээр IPv4 localhost shim-гүй буруу ажиллана. | S |
| `4faa14596` (#628) | GUI (Finder) launch дээр nvm/volta/fnm node resolve | Desktop-аас асаахад agent node олохгүй. Дархай bun bundle хийдэг ч node-хамаарал бүхий agent-д хамаатай. | S |
| `f9e334b8b` / `66a210518` (chain) | Жинхэнэ agent/session start-failure шалтгааныг surface хийх + credential recovery UI | Суурь код startup/connect failure-ыг залгиж чимээгүй гацсан agent үлдээдэг — solo-dev product-д support-killer. | M |
| `c98088d05` (+`49a49fcd9`) | Engine `mcp_failed` event surface + engine stderr-ыг зөв log level рүү map | MCP failure чимээгүй унтарч tool алга болно (алдаагүй). `darhai-*` builtin MCP-д шууд. | S |
| `b0e708ebe` | High-frequency cron new-conversation job guard + overlap skip | Хамгаалалтгүй high-frequency scheduled job хязгааргүй conversation spawn (self-DoS + жинхэнэ API зарцуулалт). | S |
| `16baed24a` (+`fa08bc2ad`) | Session/task/team ажиллаж байхад auto-update restart хойшлуулах | Auto-updater mid-run restart хийж in-flight session алж болно (work-loss). | S |
| `f8725979e` / `26d6b9eed` / `e2f75273b` (chain) | Chat UI: түүх уншиж байхад snap-to-bottom болих, tab-close nav, paste undo, right-click paste, shadow-DOM copy | Өдөр тутам цохих pre-fork UX алдаанууд (#700 г.м.). | S |
| `131fd7c9d` (chain) | Streamed output doubling (Claude text, wcore thinking) | Assistant/thinking давхар render — transcript болон downstream memory-г эвднэ. | S |
| `a3d08f387` ✅ | i18n: imperative delete dialog-д `cancelText` тавих (antd Chinese default) | `Modal.confirm` cancel товч 取消 (хятад) Дархайн бүрэн-монгол UI руу гоожно. `SiderWorkflowsSection.tsx:120`, `BudgetsPanel.tsx:120` дээр баталсан — бүх call site шүүр. | S |
| `854c0c19e` ✅ | MCP Library browse page-д "Add custom MCP" товч сэргээх | Дархайн `BrowsePage.tsx`-д custom-MCP affordance байхгүйг баталсан — library-аас custom server нэмж чадахгүй. | S |
| `b3ed2e7b5` / `06dc49e8b` / `2c8e42654` | Denied approval-ыг denied харуулах; HTTP 401-ыг bounded token match; currency-ыг LaTeX болгохоо болих | Approval UX хуурамч ногоон success; bare `401` substring хуурамч re-auth; `$5..$10` markdown math болж гажина. | S |

---

## 3. 💎 ӨНДӨР ҮНЭ ЦЭНЭТЭЙ шинэ боломжууд

Монгол solo-dev product-д value-per-effort-оор эрэмбэлэв. Дархайд аль хэдийн байгаа зүйлийг **хассан** (§4-ийг үз).

### Хямд ялалт (S/M, өндөр тохироо)

| sha | тайлбар | хэмжээ |
|-----|---------|--------|
| `1ae108c58` (#617) | Provider бүрд custom/manual model ID оруулах — Дархайн local монгол fine-tune + OmniRoute provider mix-д шууд хэрэгтэй. | S |
| `608149440` | electron-vite bundling V8 heap ceiling өсгөх — Дархайн bundle upstream-ээс том (skills-library, locale) тул яг тэр OOM хана. Solo maintainer-т trivial даатгал. | S |
| `8fca3bc41` (#465) | Playwright MCP browser capability-г bundle + auto-enable — Дархайд native дүйцэлгүй browser automation; low-friction. | S |
| `b79ed0b0c` | Skill-scan progress stream + library sweep багцлах — 2470 body-д pathological case-ыг засна. | S |
| `29de59583` | Assistant-ыг credential-redacted SKILL.md болгож export — skills-library ecosystem + community sharing-д шууд. | S |
| `e869050e7` / `882335e39` / `2c468699d` (#553,#165,#209) | Obsidian vault + Claude Code project memory import (folder picker, харагдах үр дүн) — **serge өөрөө Obsidian vault ажиллуулдаг**; Cyrillic retrieval-д тэжээл. | S |
| `f55f934b6` (#414/#641) | Memory entry засах/устгах UI — native auto-extract-д user-facing удирдлага байхгүй; backend өөр ч UX хамаарна. | S |
| `5aaf8094b` (arc) | Native Claude ACP agent-д in-app model switching (ANTHROPIC_MODEL respawn) — serge-ийн setup-д шууд UX ялалт. | M |
| `7c0eb987e` (+`67037c808`) (#258) | Windows дээр WSL доторх coding CLI (claude/codex/gemini) detect (memoized probe) — монгол Windows dev түгээмэл WSL-д CLI хадгалдаг; одоо ACP бүрэн алддаг. | M |
| `e4324b592` (+`b1896dac8`) (#35) | Doctor: diagnostic check registry + runner + UI — support ачаа бууруулна; hwfit-ийг давхардуулахгүй (Doctor app/provider health, hwfit model sizing). | M |
| `0494a2b9d` (arc) (#28) | User-defined slash command: registry, persistence, slash-menu, authoring UI — монгол user skill файлд хүрэлгүй reusable prompt үүсгэнэ; ECC/skills layer-ийн companion. | M |
| `36305501c` (#582) | Skill import + scan + verify security sweep (LLM skill guard, content-hash) — 2470 body + import-д malicious-skill scan; pre-tool guard-ыг өөр давхаргад нөхнө. | M |

### OAuth-first / зардал (Дархайн философид тохирсон)

| sha | тайлбар | хэмжээ |
|-----|---------|--------|
| `b3694a18f` (arc #870-883) / `0bf5332a9` (+`b8454f9ef`,…) | ChatGPT-subscription model catalog (live codex OAuth token) + Sign-in-with-ChatGPT (Codex `auth.json` bridge) — ChatGPT Plus/Pro-г API key-гүй chat picker-т ажиллуулна. fusion-lab OAuth CLI хандлагатай яг ижил; free-tier/OAuth-first-д хүчтэй тохироо. | M |
| `7318d695e` (+`837fba534`) | Cost circuit-breaker: runaway-turn loop detector + pre-turn pause-budget gate — OmniRoute resilience зөвхөн provider/key түвшинд; энэ нь **зарцуулалтын хамгаалалт** нэмнэ (turn бүрийн өмнө budget enforce). subscription/quota user-д өндөр. | M |
| `f5925df05` | Codex backend-ыг `@agentclientprotocol/codex-acp` App Server adapter руу шилжүүлэх — Дархайн хуучин codex adapter ялзарна; maintained adapter codex-ыг амьд байлгана. | M |

### QoL / distribution

| sha | тайлбар | хэмжээ |
|-----|---------|--------|
| `5ace74288` (+`25d517764`) (#579) | Task-completion notification: quiet-hours, per-chat focus, redaction, i18n — урт autonomous task ажиллуулдаг solo dev-д өндөр QoL; mn-MN localization хэрэгтэй. | M |
| `9b4f80487` (#512) / `a9d05e5d2` | Credential-redacted portable workflow export + type-aware assistant/workflow import — монгол community-д workflow key-гүй түгээх; skills-library-тэй хос. | M |
| `7f0ee13c3` (#715) | Blockmap release chain — differential auto-update (жижиг татаж авалт) Дархайн GitHub release-д. SkillGuard хагас нь post-fork, үл тоо. | S |
| `27f1db3ad` (+`2947ce4f2`) / `3be194236` | Project Files UX: drag-drop move, click preview, file-type classify, pin favorites — inherited projects surface-ыг тав тухтай болгоно (documents v53-г давхардуулахгүй). | M |
| `842686e9b` (+`f8712dbf5`) (#587/#626) | Workflow дотор model switcher (ACP/codex/remote) — Дархайн base workflow-д in-workflow model switch байгаагүй cap gap. | S |

### Том хөрөнгө оруулалт (L, өндөр үнэ цэнэ)

| sha | тайлбар | хэмжээ |
|-----|---------|--------|
| `ae4ca5900` / `e52f16a70` (arc) | **Concierge** in-app self-diagnosing support assistant (500+ мөр builtin diag MCP, /doctor, one-click bug report) — "монгол dev монгол user-т хийсэн" positioning-д тохирч solo-dev support ачааг эрс бууруулна. `concierge.md` prompt + UI бүрэн монголчлол; bug-report target → Дархайн repo. | L |
| `dee7f9cf4` (arc #343-348) | **MCP tool-scaling & scoping suite**: per-conversation server scoping, per-server allowedTools, BM25 ToolSelector + per-provider cap, Connected-MCPs overview — том `darhai-*` catalog + BYO tool-count blowout бүх provider-ыг доройтуулна. BM25 ToolSelector Дархайн Cyrillic tokenizer-ыг дахин ашиглаж болно. | L |
| `c48c410ff` / `f2fd568b8` (arc #252) | **Agent observability suite**: live activity timeline, sub-agent tree, orbit thinking indicator, per-turn cost — urt agentic turn (fusion-judge, deep research) ажиллуулдаг product-д хүчтэй ялгарал; OmniRoute cost routing-той байгалиасаа хосолно. Эцсийн төлөвийг ав. | L |
| `21ce4e426` (arc) | **MCP Library overhaul**: 51-connector catalog, URL-first add flow, hosted api-key/OAuth connect, Claude Code/Codex install — MCP setup-ыг гар JSON-оос browsable catalog болгоно; MCP config мэддэггүй монгол user-т standout. Catalog brand-neutral. | L |
| `f26de6373` (arc) | Composer '+' add menu: SkillsFlyout + ConnectorsFlyout + proactive skill suggest — 2470 skill-д per-conversation attach + `skills.suggest` нь library-д дутдаг discovery UX; `4dde456db` lean-injection засвартай шууд хос. | M |
| `a885000f4` (arc) | Unified ModelSelectorFlyout + per-conversation reasoning-effort persistence — home/in-chat нэг searchable picker (pin/recent/local) + effort sub-row. Flux-tier bit-ийг алгас. | L |
| `d89add29f` (arc) / `e9ce0d4f7` (+`e7caeab34`) | Auth-failure failover interactive chat (failed turn replay) + Per-workspace Chat/Cowork trust axis — OmniRoute-ыг oneShot text path-аас ACP turn руу өргөтгөнө; workspace-level trust dimension pre-tool guard-ыг нөхнө. UI toggle upstream нуусан (`1b1c1e911`) — model-ыг порт, UI-г тусад нь шийд. | L |
| `659567822` / `3d81821c5` (arc) | Browser-style chat tab + pop-out/tear-off window — олон chat power-user capability Дархайд огт байхгүй; agentic desktop workhorse-д хүчтэй. | L |

---

## 4. ♻️ Дархай аль хэдийн ИЛҮҮ хийсэн (давхар ажил бүү хий)

- **Flux Router-ийн БҮХ commit** (Дархайн OmniRoute native орлуулна): `6e5b63b0c`, `758d2750c`, `12253811f`, `0c72357b7`, `2a0947d9c`, `dd00e587e`, `22b9df385`, `a2e9a1778`, `516b8d58d`, `d72be0370`, `1c08cc4ba`, `ce913acfa`, `b891c3714`, `27879cf51` — routing strategy (cost/priority/weighted/p2c), resilience (circuit breaker/lockout/key rotation), opt-in gateway toggle бүгд native.
- **IJFW memory plumbing** (Дархайн native opt-in auto-extract + Cyrillic hybrid retrieval давсан): `2a628414c`, `b5a96577d`, `800d6b1eb` — FTS5 recall Монголд Cyrillic tokenizer муу; Дархай илүү.
- **Ignition/expert-skill preset** (ECC harness + 2470-body skills-library давсан): `83da608a2`, `e4a894d03`, `520e36347`.
- **Keyless local model** (cookbook hardware-adaptive local serve vLLM/llama.cpp/ollama + hwfit advisor давсан): `0c72357b7`.
- **Catastrophic-command classifier / guarded-auto** (native pre-tool guard `defaultRules.ts` WCore+ACP boundary дээр catastrophic rule агуулдгийг баталсан): `ced76fc14`, `62b626c39`.
- **Bun PATH installer resolution** (Дархайн v0.9.6-mn.1 release recipe аль хэдийн шийдсэн): `8f74caf22`, `d9746847e`.
- **Exa hosted endpoint** (native builtin web_search MCP tavily/brave/exa эзэмшдэг): `1c27aefc1` — зөвхөн endpoint шинэ эсэхийг харах.

> **Ёс суртал**: Дархайн голлох ялгарлууд (OmniRoute, Cyrillic memory, pre-tool guard, cookbook, монгол UI) upstream-ийн хамгийн их churn хийсэн газруудыг аль хэдийн **давсан** — эдгээр 25+ commit-ыг огт хөндөх шаардлагагүй.

---

## 5. 📦 Порт хийх стратеги

**Бодит байдал**: 66 commit divergence + renamed identifier (`BUILTIN_WAYLAND_*`→`BUILTIN_DARHAI_*`, `wayland-search-skills`→`darhai-search-skills`, `WAYLAND_*` env) + шилжсэн файл тул cherry-pick бараг хэзээ ч цэвэр гарахгүй. Бүгд **гараар дахин хэрэглэх**.

### Санал болгож буй дараалал (засвар эхэнд)

1. **Урьдчилсан алхам (0.5 өдөр)**: fork point дээр §2-ийн ✅-гүй эргэлзээтэй засваруудыг `grep`-ээр батал (§2-ийн ихэнх нь аль хэдийн баталгаатай). rename map-ыг нэг файлд бэлд.
2. **Багц A — Tier 0 skills (1-1.5 өдөр)**: `75c7f0f57`+`4dde456db`+`e6f8b8b08`+`46566348d`+`1fd66b96a`. Дархайд хамгийн өндөр нөлөө, бие даасан. Эндээс эхэл.
3. **Багц B — Security (2-3 өдөр)**: `e7a3a15a1` (L, LAN arc), `3be7b096a`, `408eeb7cd`, `b72b9b309`, `602db7db0`, `111003a4b`, `d33bf2c02`, `f1da11dc8`. LAN arc-ыг тусад нь (том re-derivation).
4. **Багц C — Crash/hang (1.5-2 өдөр)**: `07ae0df51`, `9924b4e5b`, `ceab1627f`, `8f53f18b0`, `e87a53bc2`, `6f266d51c`, `55c390ee3`, `f5239f8f3`, `8f6482f6d`, `e41615065`, `ac1bbc45d`.
5. **Багц D — Data-loss (1.5-2 өдөр)**: `9f4df293a`, `2bbe1cc47`, `056296c76`, `c1345c656`, `d1457cf18`, `272c54a01`, `7db58d06a`, `bb5215972`, `d878b430a`.
6. **Багц E — Windows (1 өдөр)**: `199f304cc`, `de7986801`/`15e1f5510`, `d30782b87`, `3afb6b93c`, `03a31bd06`, `4faa14596`. Windows-first audience-д чухал.
7. **Багц F — Correctness/MCP OAuth chain (1.5 өдөр)**: `dc52d184d`, `2a1371b30`, `a6691f494`, MCP OAuth arc (`c277b78ca`/`27ad6608b`/`f84d584f8`), model catalog/picker.
8. **Багц G — i18n/UX жижиг (0.5 өдөр)**: `a3d08f387` (хятад leak!), `854c0c19e`, `f8725979e`, `b3ed2e7b5`, `2c8e42654`.
9. **Дараа нь боломжууд**: §3-ийн S/M ялалт (custom model ID, V8 heap, Playwright, Obsidian import, Doctor, slash commands, ChatGPT-subscription, cost circuit-breaker) → дараа нь L хөрөнгө оруулалт (Concierge, MCP tool-scaling, observability) хэрэгцээгээр.

### Бодит хүчин чармайлт

- **Заавал авах засвар бүгд (§2)**: ~9-12 хүн-өдөр (LAN arc L + бусад олон S/M).
- **Багц A + B + C + E** (хамгийн эрсдэлтэй анги) хамгийн түрүүнд — ~6 өдөр, аюулгүй байдал/crash/Windows-ийн 80%-ийг хамарна.
- **Өндөр үнэ цэнэтэй S/M боломж 6-8**: ~5-7 өдөр.
- **L хөрөнгө оруулалт** (Concierge/MCP-scaling/observability/MCP Library): тус бүр ~3-5 өдөр, зөвхөн product roadmap-д тохирвол.

### Тогтмол upstream-sync зуршил — **ТИЙМ, үнэ цэнэтэй**

- Upstream 6-8 хоног тутам release гаргаж, security/crash засварыг тасралтгүй нийлүүлдэг тул нэг удаагийн catch-up-аас илүү **улирал тутмын sync** (2-3 сар) хийвэл сайн. Багц бүр 100+ commit хуримтлагдахаас өмнө хийвэл гараар порт хийх ачаа бага.
- **Автоматжуулах**: (1) upstream tag хооронд `git log --oneline` + path филтрээр pre-fork файлыг хөндсөн commit-ыг ялгах скрипт; (2) rename-map-ыг тогтмол файлд; (3) §4-ийн Flux/IJFW/Ignition path-ыг skip allowlist болгож дахин ангилахаас сэргийлэх.
- Дархайн divergence зөвхөн нэмэгдэх тул эрт эхэлбэл порт бүр хямд. Одоо §2-ыг цэвэрлэвэл дараагийн sync баазын шугам болно.
