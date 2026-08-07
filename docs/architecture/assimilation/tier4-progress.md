# Tier 4 (зөв ажиллагаа) — гүйцэтгэлийн явц

`upstream-sync-2026-07.md`-ийн Tier 4 хэсэг: **36 мөр**. 5 агент бодит кодтой тулгаж
шалгав (A routing, B provider, C ACP, D Windows, E UX).

Байдал: 2026-08-05. Tier 3 бүрэн дууссан — [tier3-progress.md](tier3-progress.md).

> **Тайлангийн ✅ тэмдэг = «fork хийх үед энэ согог БАЙСАН»**, «зассан» гэсэн утга
> биш. Долдугаар сарын тайлан mn.8-ын аудитаас өмнө бичигдсэн тул хэтрүүлж тоолдог.

## Аль хэдийн зассан / хамааралгүй (шалгалтаар тогтоов)

| sha | шалтгаан |
|-----|----------|
| `a6691f494` | `modelRegistryIpc.ts` дээр catalog chat-start + `undecryptable`/`unsupported` ялгалт аль хэдийн байна |
| `c6e4375b7` | `shouldInjectMcpServer` нэрлэгдэж, `builtin === true` шалгалт аль хэдийн авагдсан |
| `ef922bde7` | `safeSpawn.ts:66` POSIX эрхийн шалгалтыг win32 дээр аль хэдийн алгасдаг |
| `2f4932b5c` | `TeammateManager` өөр механизмаар (conversationId + 5s TTL) dedup хийдэг |
| `d30782b87` | Манай fork-д апп доторх engine updater огт байхгүй (engine нь bundled) |
| `0b00ac45a` (хэсэг) | `chatgpt-subscription` провайдер манай fork-д байхгүй |
| `f9e334b8b` (хэсэг) | credential-recovery UI (`AcpAuthFailureCard` + remedy registry) аль хэдийн бий |
| `227230be6` (хэсэг) | `*_BASH_SHELL` хувьсагч манай кодод огт уншигддаггүй → портлох зүйлгүй |

## Зассан

| sha | юу | commit |
|-----|----|--------|
| `529c6bc34` | MiniMax: түлхүүрийг баталгаажуулсан хостоор inference хийх (`.io`) | `7680276af` |
| `4513ee711` | Perplexity `/v1/models` (хувилбартай зам) | `7680276af` |
| `37bde83dd` | Google `AQ.`, OpenAI `sk-svcacct`/`sk-admin` түлхүүр таних | `7680276af` |
| `3fdd52417` | GitHub Models PAT; үхмэл `dg_`/`aai_`/`xi-api-` дүрэм устгах | `7680276af` |
| — (олдсон) | `modelRegistryIpc.ts` дэх түүхий NUL байт → файл бүхэлдээ хайлтад үл үзэгдэх | `7680276af` |
| `7475523b9` | Claude контекстийн цонх: цэгтэй түлхүүр → зураастай, snapshot-оор баталсан | `cf261801e` |
| `773f3c589` | embedding/rerank/speech загварыг чатын picker-ээс хасах (token boundary) | `cf261801e` |
| — (serge асуув) | зурган загвар чат ба зурган picker **хоёуланд нь** байхгүй байсан (`dall-e-*`) | `7fc6d4c19` |
| `b3ed2e7b5` | татгалзсан зөвшөөрөл ногоон «амжилттай» гэж харагддаг | `a804a147a` |
| `2c8e42654` | `$5 .. $10` мөнгөн дүн LaTeX болж гажих | `a804a147a` |
| `06dc49e8b` | `401` дэд-мөр хаана ч тохиолдвол дахин нэвтрэх рүү явуулах | `a804a147a` |
| `199f304cc` | Windows: MCP session-д `npx` тайлагдахгүй (5 хэрэглэгч нэг resolver руу) | `1e8a26356` |
| — (serge асуув) | зардлыг **төгрөгөөр** харуулах: өдрийн ханш мөр бүрд, авто+гарын ханш | `84260e015`…`e17608f0f` |
| `131fd7c9d` | Streamed текст давхарлаж ТҮҮХЭД хадгалагдах («PongPong») | `9ca46abf9` |
| `b0e708ebe` | Cron: өөртэйгээ давхцахгүй + шинэ-яриа хурдан хуваарийг хаах | `feb195e49` |
| `de7986801`/`15e1f5510` | Өнчин engine/gateway процесс: tree-kill + бүртгэл + quit-sweep + `app.exit()` синхрон reaper | `ac4aa1866` |
| `3f478f346`/`2a1371b30` | Загварын сонголт удаан уншилтад дарагдахаа болив (хоёр picker нэг цөм) | `834d45b80` |
| `a3d08f387` (өөр согог олдов) | Arco-ийн 13 хэлнээс 8 нь англи руу унадаг байсныг зассан + **монгол Arco locale бичив** | `a75791a01` |
| `16baed24a` | Update-on-quiesce: ажиллаж байхад restart хойшлогдоно, idle/quit үед drain-ий СҮҮЛД суулгана; алсын дуудагчаас quit-and-install хаагдсан | `88ca6e730` |
| `c9139aeec` | Эвдэрсэн turn мөнхөд «бичиж байна» гэж үлддэгийг асаалтад засна | `e86612b58` |
| `227230be6`/`4faa14596` | `LD_LIBRARY_PATH`, `NVM_DIR`, `VOLTA_HOME` allowlist-д (Linux сан + node manager) | `97b04e7f4` |
| `4ec2deef5` | ACP контекст хэмжигчийг загвараас хэмжинэ; slot нэр («opus»/«haiku»); цагираг гажихаа болив | `63e13f0bf` |

## Үлдсэн (7 агентаар кодтой тулгаж БАТАЛСАН, засаагүй)

23 мөрийг бүгдийг нь бодит кодтой тулгаж шалгав — **бүгд «real»**, нэг нь ч
хуучирсан/хамааралгүй биш байв. Хэмжээгээр эрэмбэлэв (S = хагас өдөр, L = хэд хоног).

| хэмжээ | sha | юу |
|--------|-----|----|
| S | `0b00ac45a` | DashScope hardcoded coding-plan catalog outdated; live /v1/models never queried |
| S | `cf6950939` | Keyless local Ollama: wcore spawn omits OPENAI_API_KEY so the engine bails at init |
| S | `60b8c17d9` | Idle timer not reset during streaming — bridge torn down around long turns |
| S | `1f3926f06` | acceptEdits mode advertised but not honored at ACP permission gate |
| S | `346f71831` | Respawn-storm: identical crash banners stack (no per-episode msg_id dedup) |
| S | `854c0c19e` | MCP Library Browse page has no 'add custom server' entry point |
| S | `3afb6b93c` | Uninstaller leaves HKCU residue: darhai:// protocol handler + start-on-boot Run/StartupApproved entries survive uninstall |
| M | `3b1f59382` | max_tokens guessed from model NAME substring - breaks unknown/custom model ids |
| M | `58566e9ed` | Custom OpenAI-compatible endpoint without /models hard-fails connect (no chat-completions fallback, no no-models landing) |
| M | `3f0dc9e2e` | ACP allow-always approvals forgotten after restart (no persistence) |
| M | `e41615065` | WCore turn stall watchdog missing — silent turn spins forever |
| M | `e2f75273b` | No right-click cut/copy/paste menu; Ctrl+C on agent messages copies nothing (shadow DOM) |
| M | `none` | Closing active tab shows wrong conversation (no navigation, jumps to last tab); Ctrl+Z cannot undo a paste in the composer |
| M | `c98088d05+49a49fcd9` | Engine mcp_failed events swallowed; all engine stderr logged as console.error |
| M | `03a31bd06` | Windows triple fix: Hermes stdio hardening, OpenClaw localhost/IPv4 divergence, OpenClaw PATHEXT resolution |
| L | `f8725979e + 26d6b9eed` | Chat auto-scroll snaps to bottom while user reads history |
| L | `dc52d184d` | User-enabled MCP connectors silently missing on some backends (Codex/wcore/Gemini) |
| L | `f9e334b8b` | Real session-start failure cause hidden — user sees only generic start-failure strings |

**⚠️ `3b1f59382` (max_tokens нэрээр таах) — ЗОРИУД ХОЙШЛУУЛСАН.** Дээрх шалгалт
урьдчилсан нөхцөл илрүүлэв: upstream энэ таамгийг устгаж чадсан нь тэдний
хөдөлгүүр (v0.12.16+) max_tokens-ыг өөрөө загвар тус бүрээр тогтоодог болсон
учраас. Манай fork хөдөлгүүрийг **v0.10.0** дээр тогтоосон. Хуучин хөдөлгүүр
дээр desktop-ийн анхдагчийг устгавал Gemini Pro/reasoning загварууд **хоосон
хариу** буцаах регресст ордог. Тиймээс энэ нь хөдөлгүүрийн хувилбар ахиулах
(+ SHA мөрүүд) шаардана — тусад нь, зориудаар хийх ажил.

## Өнчин процессын засварын тэмдэглэл (`ac4aa1866`)

Тайлан нэг мөр гэж бичсэн ч бодит байдал дээр **гурван тусдаа нүх** байсан:

1. `WCoreAgent.kill()` ба `OpenClawGatewayManager.stop()` хоёулаа нүцгэн
   `kill('SIGTERM')` хийдэг байв. Windows дээр энэ дохио дуурайлган хийгддэг тул
   хөдөлгүүрийн өөрийн салбар (MCP сервер, tool дэд-процесс) хүртэл **хүрдэггүй**.
   Хоёуланг нь `killChild` (ACP-д аль хэдийн хэрэглэдэг платформ-зөв tree-kill)
   рүү чиглүүлэв. `WCoreManager.kill()` одоо түүнийг **хүлээнэ** — салбар үхэхээс
   өмнө буцдаг quit нь юу ч цэвэрлээгүй гэсэн үг. Мөн `stop()` нь `exit` эвентийг
   **хязгааргүй** хүлээдэг байсныг зассан (эвент гарахгүй бол quit мөнхөд гацна).
2. Аягүй цэвэрлэгээ алхам тус бүрд **2 сек** боловч ганц `killChild` нь 3 сек
   (POSIX) / 5 сек (Windows) зөвшөөрөгддөг → удаан үхэх процесс дундаа хаягдана;
   мөн менежергүй spawn хийсэн процесст **огт хүрдэггүй**. Тиймээс spawn бүр
   `childRegistry`-д бүртгэгдэж, процесс дуусахад өөрөө хасагдаж, quit-ийн эцэст
   **өөрийн 6 сек**-ийн төсөвтэй нэг шүүрдэлт хийгдэнэ.
3. `app.exit()` нь `before-quit`/`will-quit` **алийг нь ч гаргадаггүй** — эвдрэл,
   init-ийн бүтэлгүйтэл, гаднаас удирдсан гарц. Яг эдгээр гарц дээр хөдөлгүүр
   үлдэх магадлал хамгийн өндөр. `registerSyncQuitReapers` одоо тэнд ч
   **синхроноор** хатуу устгана (өгөгдлийн сангийн хаалтын хажууд).

Хоёр шүүрдэлт хоёулаа Node аль хэдийн цуглуулсан pid рүү дохио **илгээхгүй** —
тэр pid одоо огт өөр процессынх байж болно; `exitCode`/`signalCode` бол pid дахин
ашиглалтад хууртдаггүй цорын ганц шалгуур.

## Шалгалтын байдал

Засвар бүрийг мутацийн шалгалтаар нотолсон. Энэ ээлжид нэмэгдсэн мутацууд:
gate хойшлуулахгүй · defer түгжээ авсан · idle callback синхроноор буудна ·
on-quit суулгалт албадан дахин асаана · env нэрс allowlist-аас хасагдсан ·
контекстийн хувь clamp-гүй · limit хамгаалалтгүй · slot мөрүүд хасагдсан.

`reconcileInterruptedMessages`-ийн SQL-ийг локал дээр native драйвер Electron
ABI дээр байгаа тул тест алгасагддаг → **жинхэнэ sqlite хөдөлгүүр дээр**
(`node:sqlite`) гараар нотолсон: 2 мөр зассан, `finish` хөндөгдөөгүй, WHERE-г
устгавал 4 мөр (түүх эвдэрнэ), зөвхөн `work` болговол `pending` үлдэнэ.

`tsc` 0, тестийн `tsc` 0, lint 0 алдаа, i18n 0, иж бүрдэл
**11,214 тэнцсэн / 0 унасан**.
