# Tier 3 (өгөгдөл алдагдах / эвдрэх) — гүйцэтгэлийн явц

`upstream-sync-2026-07.md`-ийн Tier 3 хэсгийг **бодит кодтой тулгаж шалгасны дараах** байдал.
4 агент 9 зүйлийг тусад нь шалгав; тайлангийн 2 таамаг буруу байсныг залруулав (доор).

Байдал: 2026-08-05. Tier 2 бүрэн дууссан — [tier2-progress.md](tier2-progress.md).

## Шийдвэрийн хүснэгт

| sha | юу | шийдвэр | commit |
|-----|----|---------|--------|
| `272c54a01` | cron numeric weekday → долоо хоног тутмын хуваарь устдаг | ЭВДЭРСЭН → **зассан** | `7b9856f49` |
| `d878b430a` (a) | Refresh нь Ollama-гийн каталогийг устгана | ЭВДЭРСЭН → **зассан** | `9a0f079eb` |
| `6c95abd26` | custom assistant засвар хадгалагдахгүй мөртлөө «амжилттай» | ЭВДЭРСЭН → **зассан** | `9a0f079eb` |
| `96ca1f6e7` | paste хийсэн зураг бүр `image.png` → эхнийх нь давтагдана | ЭВДЭРСЭН → **зассан** | `737721b22` |
| `bb5215972` | илгээгээгүй ноорог reload дээр алга болно | ЭВДЭРСЭН → **зассан** | `737721b22` |
| `b602d9d9f` | claude-mem импорт native санах ойг алддаг | **АЛЬ ХЭДИЙН ЗАССАН** (`claudeNativeImporter.ts`) | — |
| `2bbe1cc47` (c) | watchdog алга | **АЛЬ ХЭДИЙН БАЙГАА** (`Watchdog.ts` + inactivity) | — |
| `c1345c656` | resume үед түүх сэргэдэггүй | ЭВДЭРСЭН → **зассан** | `1f9c7b701` |
| `7db58d06a` | ACP: turn дунд илгээсэн мессеж алга болно | ЭВДЭРСЭН (upstream-ээс ч дор) → **зассан** | `1f9c7b701` |
| `9f4df293a` | нэрлэсэн профайл default-ийн дата дээр ажиллана | ЭВДЭРСЭН → **зассан** | `848a0842f` |
| `d1457cf18` | өнчин team-child мөр → migration DB-г brick хийнэ | ЭВДЭРСЭН → **зассан** | `848a0842f` |
| `d878b430a` (b) | ACP picker хоосон | ЭВДЭРСЭН | ⏳ үлдсэн |
| `a11477782` | Дархай хэрэглэгчийн `~/.codex/config.toml`-ыг өөрчилнө | ЭВДЭРСЭН | ⏳ үлдсэн |
| `9c93ba86f` | төслийн reference файл чимээгүй хаягдана | ЭВДЭРСЭН | ⏳ үлдсэн |
| `2bbe1cc47` (a) | leader-ийн mailbox сэрэх үед алга болно | ЭВДЭРСЭН | ⏳ үлдсэн |
| `2bbe1cc47` (b) | codex-add / claude-fire deadlock | ЭВДЭРСЭН | ⏳ үлдсэн |
| `2bbe1cc47` (d) | Teams: model cache sync (SWR revalidate алга) | ЭВДЭРСЭН | ⏳ үлдсэн |
| `056296c76` | төслийн байнгын workspace алга (том порт) | ЭВДЭРСЭН | ⏳ үлдсэн |

**Дууссан: 9/17. Үлдсэн: 7 (доорх дарааллаар).**

## Үлдсэн ажлын нарийвчилсан төлөвлөгөө

Дараагийн сесс энэ хэсгээс шууд үргэлжлүүлнэ. Бүгд бодит кодтой тулгагдсан, файл/мөр заасан.

### 1. `a11477782` — Дархай хэрэглэгчийн codex тохиргоог өөрчилдөг (АЮУЛГҮЙ БАЙДАЛ)

`src/process/task/codexConfig.ts:45` `writeCodexSandboxMode` нь `~/.codex/config.toml` дотор
`sandbox_mode`-ыг **бодитоор бичдэг** (бусад мөрийг хадгална, бүхэлд нь дардаггүй — тайлангийн
«overwrite» гэдэг нь хэтрүүлсэн). Дуудагдах газар: `AcpAgentManager.ts:780` (codex асаах бүрд)
болон `:1695` (`setMode`).

Хор нь: хэрэглэгчийн **өөрийнх нь** `codex` CLI-ийн зан төлөв Дархайгаас болж өөрчлөгдөнө —
`danger-full-access` бичигдвэл терминал дээрх codex нь sandbox-гүй ажиллана.

Зөв засвар (upstream-ийнх): `<userData>/codex-home` хаяглалт үүсгэж, хэрэглэгчийн config-ийг
хуулаад зөвхөн `sandbox_mode`-ыг дарж бичих; `auth.json`-г symlink (Windows дээр EPERM бол
`copyFile`) хийж OAuth сэргээлт хэрэглэгчийн файл руу бичигдэхээр үлдээх; codex CLI-г асаах
env-д `CODEX_HOME` заах (`acpConnectors.ts:549 prepareCodex` → `cleanEnv`). Дараа нь
`AcpAgentManager`-ийн хоёр дуудлагыг устгана.

⚠️ **Эрсдэл:** `auth.json`-г буруу холбовол Windows дээр codex-ийн нэвтрэлт эвдэрнэ. Symlink
бүтэлгүйтвэл copy руу шилжих, мөн refresh хийгдсэн token-ыг буцааж хуулах логик хэрэгтэй.
Тиймээс энэ нь болгоомжтой, тусад нь хийх ажил.

### 2. `9c93ba86f` — төслийн reference файл чимээгүй хаягдана

`src/process/services/projectKnowledge/knowledge.ts:332` — `confinePath` null буцаавал
`continue` (чимээгүй алгасна). `addProjectReference` нь алдааны мэдээлэл буцаадаггүй
(`knowledge.ts:356`), UI нь **хаясан** тоогоор бус **чирсэн** тоогоор амжилт харуулна
(`ProjectReferencePanel.tsx:64`).

Засвар: `confinePath`-д `{ allowOutsideRoots }` сонголт нэмэх (зөвхөн эцсийн root-containment
шалгалтыг алгасна, `hasUnsafePathForm` гэх мэт бусад шалгалт хэвээр); `addProjectReference`
`{ files, failed }` буцаах; IPC гэрээ (`ipcBridge.ts:2894`) + `projectBridge.ts:189` өргөтгөх;
UI-д хэсэгчилсэн алдааг харуулах + `projects.json` i18n түлхүүр.

### 3. `2bbe1cc47` (a)+(b) — Teams mailbox + codex-add deadlock

Нэг суурь дутагдал: `Mailbox`-д **уншаад тэмдэглэдэггүй** `peekUnread` алга
(`Mailbox.ts:70` зөвхөн `readUnreadAndMark`). `TeammateManager.finalizeTurn` (`:770-787`)
leader-ийн хайрцгийг огт шалгадаггүй, `wake()` нь `activeWakes` хамгаалалтаар (`:244`)
давхар сэрэхийг алгасдаг → сэрэх үед ирсэн мессеж мөнхөд хэвтэнэ.

(b)-ийн codex тал: `AcpAgentManager.ts:1029-1031` `toolTitle.includes('wayland-team')` —
codex-acp нь «Approve MCP tool call» гэсэн ерөнхий гарчигтай ирдэг тул хэзээ ч таарахгүй →
`team_spawn_agent` мөнхөд батлагдахыг хүлээнэ. Gemini-ийн зам аль хэдийн зөв
(`GeminiAgentManager.ts:728`).

Засвар: `ITeamRepository`+`SqliteTeamRepository`-д уншилтгүй `peekUnread`; `Mailbox.peekUnread`;
`finalizeTurn`-д leader-ийн салаа; `AcpAgentManager`-т `isTeamMcpPermission(toolCall)`
(гарчгийн anchored regex + codex-д `rawInput.server_name` шалгах).

### 4. `2bbe1cc47` (d) — Teams model cache

`TeamPage.tsx:76` болон `:328` нь `useSWR`-ийг **revalidate захиалгагүй** ашиглана. Шинэ
`useTeamConversation` hook (`ipcBridge.conversation.listChanged.on` → `mutate()`) нэмээд
хоёр дуудлагыг солино. Бусад 3 уншигч ижил SWR key хуваалцдаг тул дагаад засагдана.

### 5. `d878b430a` (b) — ACP picker хоосон

`modelRegistryIpc.ts:929-945` — enumerable CLI хоосон буцаавал models.dev fallback алга,
`ACP_BACKEND_UNDERLYING_PROVIDER` зураглал алга (grok→xai, kimi→moonshot, qwen→qwen,
vibe→mistral) → эдгээр backend бүр хоосон picker өгнө.

### 6. `056296c76` — төслийн байнгын workspace (ХАМГИЙН ТОМ)

9 файл, 3 нь шинэ. `initAgent.ts:219` `wcore-temp-<ts>` анхдагчийг арилгах;
`ProjectServiceImpl.createProject`-д workspace хуваарилах; `ConversationServiceImpl`-д
`ensureProjectWorkspace`; `WorkerTaskManager.getOrBuildTask`-д дахин бэхлэх (drift засах);
`useGuidSend.ts:142` `isCustomWorkspace`-ийг засах (одоо project workspace-ийг «custom» гэж
үзээд skill symlink суулгахыг алгасдаг).

⚠️ Хэрэглэгчийн одоо байгаа чатууд `~/.darhai`-д байгаа тул шилжүүлэх/дахин бэхлэх логик
болгоомжтой байх ёстой.

## Тайлангийн залруулга (шалгалтаар илэрсэн)

1. **`056296c76`** — «OS арчдаг temp» гэсэн нь **буруу**. `getSystemDir().workDir` нь
   `<userData>/wayland` → `~/.darhai`, өөрөөр хэлбэл апп-ын дата, OS цэвэрлэдэггүй. Гэхдээ
   хэрэглэгчид үл үзэгдэх директор + төслийн чат буруу газар орох гэдэг нь үнэн.
2. **`d1457cf18`** — «FK чангатгах migration ирвэл» гэсэн нөхцөл энэ fork-д **байхгүй**
   (v51–v55 нь notes/calendar/documents/research/email, FK хөддөггүй). Гэвч
   `migrations.ts:2545`-ийн `foreign_key_check` нь **глобал бөгөөд нөхцөлгүй**, бүх migration
   нэг transaction дотор — тиймээс v50-аас доош DB бүр эхний ачаалалт дээр энэ шалгалтад орно.
   Эрсдэл байна, зөвхөн шалтгаан нь өөр.

## Замдаа олсон зүйлс

- `parseCronExpr` болон `formatSchedule` тус тусдаа гараг-хөрвүүлэх хүснэгэлтэй байсан → жагсаалт
  «Лхагва гараг» гэж, засварын цонх «Өдөр бүр 09:00» гэж хардаг байв. Одоо нэг хүснэгт хуваалцана.
- `DARHAI_TIMESTAMP_SEPARATOR` тогтмолын **утга** нь `'_wayland_'` хэвээр (нэр нь л солигдсон).
  Солих нь диск дээр байгаа файлуудыг эвдэнэ тул хөдөлгөөгүй — брэндийн үлдэгдэл, өгөгдлийн алдаа биш.
- **Тестийн сургамж:** SWR-ийн cache нь модуль-глобал. `cleanup()` нь түүнийг устгадаггүй тул
  «reload» дуурайсан тест persistence-гүйгээр ч тэнцэж байв. Одоо тест бүр `SWRConfig`-оор
  өөрийн cache-тэй. Мутацийн шалгалт: persistence устгавал 6-аас 4 унана.

## Шалгалтын байдал

Засвар бүрийг мутацийн шалгалтаар нотолсон (тестийг санаатай эвдээд унадгийг баталсан).
`tsc` 0, холбогдох тестүүд бүгд ногоон.
