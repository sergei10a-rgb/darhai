# Хөдөлгүүрийг fork хийх төлөвлөгөө

> **Төлөв:** судалгаа дууссан, хэрэгжүүлээгүй. Шийдвэр гаргаагүй.
> **Хэмжсэн:** 2026-08-10. Бүх тоо тухайн өдрийн бодит утга.
> **Асуулт:** `wayland-core` хөдөлгүүрийг fork хийж, Дархайн өөрийн болгох уу?

---

## 1. Одоо юу болж байна вэ

Дархай хөдөлгүүрийн эх кодыг агуулдаггүй. `scripts/prepareWaylandCore.js`
тодорхой tag-аас **бэлэн бинар татаж** `resources/bundled-wayland-core/` дотор
савладаг. Хэрэглэгч суулгахад тэр бинар хамт очно.

| Хэмжсэн зүйл | Утга |
|---|---|
| Upstream repo | `FerroxLabs/wayland-core` — **PUBLIC**, **Apache-2.0**, Rust |
| Repo үүссэн | 2026-06-08 (2 сарын настай) |
| Эх код | **1,817 `.rs` файл · 883,842 мөр · 56 crate** |
| Upstream-ийн сүүлийн release | **v0.12.26** (2026-08-08) |
| Дархайн бэхэлсэн хувилбар | **v0.12.26** (2026-08-10-нд v0.10.0-аас ахиулсан) |
| Бинарын хэмжээ | 57.8 МБ (win32-x64) |
| Release asset | 10 (6 платформ + checksums + SBOM + manifest + desktop-contract) |
| CI workflow | 10+ (`release.yml`, `release-please.yml`, `release-rehearsal.yml` орно) |
| Идэвх | 2026-06-29 – 07-05 хооронд **өдөрт 1-2 release** |

### Rebrand хийх ёстой нэрсийн тархалт (эх кодод)

| Нэр | Хэдэн файлд |
|---|---|
| `wayland-core` | **382** |
| `.wayland` (зам) | **163** |
| `WAYLAND_HOME` | **148** |
| `wayland_config_dir` | **42** |

Эдгээр нь **интерфейс**, брэндийн чимэг биш. 2026-08-10-нд хэмжсэнээр
`DARHAI_HOME` өгвөл хөдөлгүүр үл тоомсорлодог; зөвхөн `WAYLAND_HOME` ажилладаг
(`tests/unit/wcore-engineHome.test.ts` үүнийг бинар дээр шалгадаг).

---

## 2. Fork хийвэл юу хийх ёстой вэ

### Ф0. Бэлтгэл (0.5 өдөр)
- `FerroxLabs/wayland-core` → `sergei10a-rgb/darhai-core` fork
- Apache-2.0 шаардлага: `LICENSE` хадгалах, `NOTICE`-д өөрчлөлтөө тэмдэглэх,
  анхны зохиогчийн эрхийн мэдэгдлийг арилгахгүй
- Upstream-ийг `upstream` remote болгож холбох

### Ф1. Нэрийн давхарга (2-3 өдөр)
Хамгийн эрсдэлтэй хэсэг — 700+ файлд тархсан нэрс.

1. `WAYLAND_HOME` → `DARHAI_HOME`, **хуучин нэрийг fallback болгож үлдээх**
   (хуучин суулгацууд шууд эвдрэхгүй)
2. `wayland_config_dir()` → `darhai_config_dir()`, дотор нь precedence хэвээр
3. Config хавтас `wayland-core` → `darhai-core`
4. Бинарын нэр `wayland-core` → `darhai-core`
5. `.wayland/` төслийн хавтас → `.darhai/`

**Заавал:** алхам бүрийн дараа `cargo test` ажиллуулж, нэр солих нь зөвхөн
нэр солих байхыг батлах. Rust-ийн тест иж бүрдэл байгаа (`ci.yml`, `e2e.yml`).

### Ф2. Барилтын CI (2-4 өдөр)
6 target барих ёстой:

```
x86_64-pc-windows-msvc      aarch64-pc-windows-msvc
x86_64-apple-darwin         aarch64-apple-darwin
x86_64-unknown-linux-gnu    aarch64-unknown-linux-gnu
```

- Upstream-ийн `release.yml`-ийг хуулж, өөрийн repo руу тохируулах
- macOS бинар **гарын үсэг + notarize** шаардана (эс тэгвээс Gatekeeper блоклоно).
  ⚠️ Дархай **Wayland-ийн Apple сертификатыг ашиглахгүй** — өөрийн Apple
  Developer бүртгэл (жилд $99) хэрэгтэй
- Release asset-уудыг upstream шиг нэрлэх (checksums, SBOM, manifest)

### Ф3. Дархайг холбох (0.5 өдөр)
- `scripts/prepareWaylandCore.js` → шинэ repo, шинэ asset нэр
- `binaryResolver.ts` — `BINARY_CANDIDATES` шинэ нэрээр, хуучин нэрийг fallback
- `envBuilder.ts` — `DARHAI_HOME` (fallback `WAYLAND_HOME`)
- `profilePaths.ts` толин тусгалыг шинэчлэх
- `tests/unit/wcore-engineHome.test.ts` — шинэ бинар дээр дахин хэмжинэ

### Ф4. Хэрэглэгчийн дата нүүлгэх (1-2 өдөр)
Одоо байгаа хэрэглэгчид `%APPDATA%\wayland-core\` дотор config.toml, memory.db,
skills, sessions хадгалдаг. Шинэ нэр рүү шилжихэд:

- Хуучин хавтас байгаад шинэ нь байхгүй бол **нэг удаа хуулж** авах
  (устгахгүй — буцах боломж үлдээнэ)
- Нүүлгэлт амжилтгүй бол хуучин хавтсыг үргэлжлүүлэн ашиглах
- Энэ загварыг Дархайд аль хэдийн хийсэн: `getDevAppName()` (`src/common/platform/index.ts`)

### Ф5. Байнгын үүрэг (release бүрт)
Upstream release гармагц:
1. `git fetch upstream && git merge upstream/v<tag>`
2. Нэрийн давхарга дээр conflict гарвал шийдэх
3. 6 платформд барих, тест ажиллуулах
4. Дархайн бэхэлсэн хувилбарыг ахиулах

**Хэмжсэн давтамж:** хамгийн идэвхтэй үедээ **өдөрт 1-2 release**. Одоо саруудаа
1-3. Дундажаар сард **~2-4 нэгтгэлт**.

---

## 3. Зардал ба ашиг

### Нэг удаагийн зардал
| Ажил | Хугацаа |
|---|---|
| Ф0 бэлтгэл | 0.5 өдөр |
| Ф1 нэрийн давхарга | 2-3 өдөр |
| Ф2 CI + 6 платформ | 2-4 өдөр |
| Ф3 Дархайг холбох | 0.5 өдөр |
| Ф4 дата нүүлгэх | 1-2 өдөр |
| **Нийт** | **6-10 өдөр** |

### Байнгын зардал
- Release бүрт нэгтгэх: **1-3 цаг** (conflict-оос хамаарна)
- Сард **~2-4 нэгтгэлт** → сард **3-12 цаг**
- Apple Developer: **жилд $99**
- CI минут: 6 платформ × release тутам

### Ашиг
- Бүрэн эзэмшил: upstream устгасан, лиценз өөрчилсөн, чиглэл сольсон ч Дархай зогсохгүй
- Нэрс бүрэн Дархай болно (`DARHAI_HOME`, `darhai-core`)
- Өөрийн засвар шууд нэвтрүүлэх боломж (одоо upstream-ийг хүлээх ёстой)
- Монгол хэлний дэмжлэгийг хөдөлгүүрийн түвшинд нэмэх боломж

### Эрсдэл
- **Хамгийн том:** 884K мөр Rust код, 2 сард 12 minor хувилбар гарсан. Fork нь
  тэр хурдтай хөгжлөөс салангид болж, нэгтгэх өртөг цаг хугацаанд өснө.
- macOS гарын үсэг/notarize нь тусдаа дэд төсөл
- 56 crate-ийн хамаарал — нэрийн өөрчлөлт хаана нөлөөлөхийг урьдчилан мэдэхгүй

---

## 4. Шийдвэрийн цэгүүд

Fork хийх **шаардлагатай** болох дохио (аль нэг нь хангалттай):

1. Upstream repo архивлагдсан, эсвэл 3 сараас удаан шинэчлэгдээгүй
2. Upstream лицензээ Apache-2.0-оос хаалттай руу сольсон
3. Дархайд заавал хэрэгтэй засварыг upstream 2 сараас удаан хүлээж авахгүй байгаа
4. Дархай олон мянган төлбөрт хэрэглэгчтэй болж, гуравдагч талын хуваарьт
   хараат байх нь бизнесийн эрсдэл болсон

Fork хийхээс **татгалзах** дохио:

1. Upstream идэвхтэй хэвээр (одоо: өчигдөр түлхсэн ✅)
2. Дархай upstream-ийн шинэ боломжуудаас ашиг хүртсээр байгаа
3. Нэгтгэх ажлыг байнга хийх хүн хүчин байхгүй

---

## 5. Одоогийн зөвлөмж

**Fork хийхгүй. Оронд нь:**

### ✅ Хийгдсэн (2026-08-10): хөдөлгүүрийг v0.12.26 руу ахиулсан

Дархай **v0.10.0** дээр, upstream **v0.12.26** дээр байсан — 16 minor хувилбар
хоцорсон. Одоо ижил хувилбар дээр.

**Юуг хэмжсэн (таамаглаагүй):**

| Шалгалт | Үр дүн |
|---|---|
| Дархайн илгээдэг 9 команд гэрээнд байгаа эсэх | **9/9 байна** |
| Дархайн боловсруулдаг 33 event гэрээнд байгаа эсэх | **33/33 байна** |
| CLI флаг (13 ширхэг, Дархайн ашигладаг бүгд) | **13/13 хэвээр** |
| `WAYLAND_HOME` precedence | **хэвээр** (`wcore-engineHome.test.ts` бинар дээр) |
| Approval дохионы дараалал | **хэвээр** — `tool_request` эхэлнэ, 0.0–0.1мс |
| Бүрэн unit suite | **10,187 ногоон** |

**Эвдрэх өөрчлөлт байгаагүй.** Протокол зөвхөн ӨРГӨЖСӨН.

**Гэхдээ нэг бодит үр дагавар олдсон:** v0.12.26 нь Дархайн мэддэггүй 23 төрлийн
event илгээдэг, үүнээс асаалт бүрт **27 мөр** (`capability_activation` дан 24).
Дархайн декодер мэдэхгүй event-ийг warn-оор унагаадаг тул лог дүүрэх байсан.
Шийдэл: `ACKNOWLEDGED_UNHANDLED_EVENTS` (protocol.ts) — мэдэгдэж буй, зориудаар
идэвхгүй жагсаалт. Warn одоо зөвхөн ЖИНХЭНЭ шинэ зүйлд гарна.
`tests/unit/wcore-eventCoverage.test.ts` жагсаалтыг үнэн байлгана.

**Ашиглаагүй боломжууд** (гэрээнд байгаа, Дархай хараахан авaaгүй): session
recovery, turn recovery, budget grant, goal subsystem, workflow, runtime
diagnostics, anvil receipts. Эдгээр нь ирээдүйн ажил, эвдрэл биш.

### Дараагийн шинэчлэлтийг хэрхэн хийх вэ

```bash
# 1. Шинэ tag-ийн checksum-ыг бүртгэх (release-ийн гарын үсэгтэй файлаас)
gh release download <tag> --repo FerroxLabs/wayland-core --pattern "*checksums.txt"
#    -> scripts/bundled-wcore-shasums.json-д нэмэх

# 2. Татах (checksum шалгагдана)
WCORE_VERSION=<tag> WCORE_FORCE_DOWNLOAD=1 node scripts/prepareWaylandCore.js

# 3. Хоёр тогтмолыг ахиулах: DEFAULT_WCORE_VERSION + PINNED_VERSION
#    (enginePinnedVersion.test.ts зөрүүг барина)

# 4. Гэрээг татаж протоколын ялгааг харах
gh release download <tag> --repo FerroxLabs/wayland-core --pattern "*desktop-contract*"

# 5. Бинар дээр хэмжих
node ./node_modules/vitest/vitest.mjs run tests/unit/wcore-engineHome.test.ts
node scripts/measure-approval-order.mjs <binary> 3 --model <model>
```

### Дунд хугацаанд: бэлтгэл хийх
Fork хийхгүй ч бэлтгэлтэй байх:
- Upstream release-ийг хянах автомат мэдэгдэл (шинэ tag гармагц)
- `wcore-engineHome.test.ts` шиг **бинар дээр шалгадаг** тестүүдийг нэмэх —
  upstream интерфейсээ өөрчилвөл Дархайн CI шууд барина
- Энэ баримтыг release бүрт шинэчлэх (upstream хувилбар, хоцрогдол)

### Fork-ийн шийдвэрийг дахин хэлэлцэх үе
- Upstream 3 сар чимээгүй болвол
- Эсвэл Дархай төлбөрт үйлчилгээ болж эхлэхэд

---

## 6. Хэрхэн дахин хэмжих вэ

```bash
# Upstream-ийн одоогийн байдал
gh repo view FerroxLabs/wayland-core --json visibility,licenseInfo,pushedAt
gh api repos/FerroxLabs/wayland-core/releases --jq '.[0].tag_name'

# Дархайн бэхэлсэн хувилбар
grep DEFAULT_WCORE_VERSION scripts/prepareWaylandCore.js

# Хөдөлгүүр ямар env уншдаг (бинар дээр шууд)
node ./node_modules/vitest/vitest.mjs run tests/unit/wcore-engineHome.test.ts
```
