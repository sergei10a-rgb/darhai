# Handout — IJFW ба Windows-ийн атомт бичилтийн согог

**Огноо:** 2026-08-07 · **Хамрах хүрээ:** Дархайг хөгжүүлж буй бүх session

Энэ баримт хоёр зүйл мэдэгдэнэ:
1. Дархайн session-ууд IJFW ашигладаг — түүнд илэрсэн согог ба засвар
2. **Дархайн ӨӨРИЙН кодод яг ижил ангиллын согог байна** — энэ нь илүү чухал

---

## 1. Дархай IJFW ашигладаг

`C:\claude\darhai\.ijfw\` байдаг. IJFW нь Claude Code-ийн глобал plugin
(`~/.claude/settings.json` → `enabledPlugins.ijfw@ijfw`) тул Дархайн session бүрд идэвхтэй.

**Хувилбар:** 2026-08-07-нд v1.6.3 → **v1.6.5** шинэчилсэн.

**Санах ой:** ажиллах хэв маягийн 18 глобал preference `~/.ijfw/memory/global/preferences.md`-д
байна (монголоор хариулах, тоо таамаглахгүй хэмжих, backup авах, lint ажиллуулах,
UI-г зургаар шалгах г.м.). Session эхлэхэд `ijfw_memory_prelude` дуудвал ирнэ.

---

## 2. IJFW-д илэрсэн согог (жишээ болгон)

`~/.ijfw`-д **239 өнчин файл, 66 МБ** хуримтлагдсан байв. `C:\claude\.ijfw`-д бас
**115 файл, 35 МБ**. Нийт **354 файл, 101 МБ** — 3 долоо хоногт, хэн ч анзаараагүй.

**Шалтгаан** (`mcp-server/src/scan-resume.js` → `writeScanState`):

```js
writeFileSync(tmpPath, ...);
try {
  renameSync(tmpPath, finalPath);
} catch (err) {
  if (!err || err.code !== 'EXDEV') throw err;   // ← EPERM энд шидэгдэнэ
}                                                //    tmp цэвэрлэгдэхгүй
```

Эх кодын тайлбар өөрөө шалтгааныг илчилнэ: *«POSIX rename(2) is atomic on the same fs»*.
POSIX дээр үнэн — **Windows дээр худал**.

### ⚠️ Хэмжсэн баримт (win32 10.0.26200 / Node 24)

**ЭХ файл нээлттэй байхад** (`r` / `r+` / `a` / `w`, зорилтот байхгүй):

| Нөхцөл | Үр дүн |
|---|---|
| Эх файлыг ямар ч горимоор нээсэн | ✅ **OK — саад болохгүй** |

**ЗОРИЛТОТ файл БАЙГАА бөгөөд нээлттэй байхад:**

| Нөхцөл | Үр дүн |
|---|---|
| Зорилтот: `r` (зөвхөн унших!) | ❌ **EPERM** |
| Зорилтот: `r+` | ❌ EPERM |
| Зорилтот: `a` | ❌ EPERM |
| Зорилтот байгаа, аль нь ч нээгээгүй | ✅ OK |
| Зорилтот байхгүй | ✅ OK |

### 🎯 Гол мэдэгдэхүүн — эндээс л шүүлтүүр гарна

**Зөвхөн ЗОРИЛТОТ файл байгаа БӨГӨӨД өөр handle барьж байвал унана.**
Эх файл нээлттэй байх нь саад болохгүй (Node `FILE_SHARE_DELETE`-тэй нээдэг).

Практик дүгнэлт:
- **`tmp → байгаа файл`** хэлбэрийн атомт бичилт → 🔴 **эрсдэлтэй** (зорилтот үргэлж байдаг)
- **`файл → цагийн тэмдэгтэй шинэ нэр`** (лог эргэлт) → 🟢 аюулгүй (зорилтот байдаггүй)
- **`файл → тогтмол нэр`** (`.1`, `.migrated`, `.old`) → 🟠 хоёр дахь удаагаас эрсдэлтэй

Linux/macOS дээр аль нь ч унадаггүй тул хөгжүүлэгч анзаардаггүй — зөвхөн Windows
хэрэглэгч дээр гарна.

### Хийсэн засвар

`EPERM`/`EBUSY`/`EACCES`-ыг `EXDEV`-тэй адилаар copy+unlink рүү чиглүүлж, бусад
алдааны үед ч tmp-г заавал цэвэрлэдэг болгосон.

Патч: `~/.ijfw/local-patches/0001-windows-eperm-atomic-write.patch`

⚠️ **IJFW шинэчлэх бүрд дахин хэрэглэнэ** (git checkout дарж бичдэг):

    cd ~/.ijfw && git apply local-patches/0001-windows-eperm-atomic-write.patch

---

## 3. 🔴 Дархайн кодод ижил согог байна

Дархай **Windows хэрэглэгчдэд түгээгддэг** тул энэ нь онолын биш, бодит эрсдэл.

### 3.1 `src/process/bridge/constitutionBridge.ts:242-249`

```ts
const tmp = `${path}.tmp`;
writeFileSync(tmp, content, 'utf-8');
renameSync(tmp, path);
// ...
} catch (err) {
  console.error('[constitutionBridge] write failed:', err);
  return false;
}
```

**Асуудал:** яг IJFW-ийн загвар. Windows дээр өөр процесс (эсвэл өөр цонх) constitution
файлыг уншиж байвал EPERM → **бичилт чимээгүй бүтэлгүйтнэ** (`return false`), `.tmp`
файл үлдэнэ. Хэрэглэгчийн засвар алдагдана, шалтгаан нь консолын логд л үлдэнэ.

Мөр **348**-д ижил загвар (`renameSync(tmp, overlayPath)`).

**Нэмэлт эрсдэл:** tmp нэр нь тогтмол (`${path}.tmp`, PID-гүй) тул хоёр процесс зэрэг
бичихэд бие бие рүүгээ бичнэ.

### 3.2 `src/process/channels/webhook/audit-log.ts:71-79`

```ts
function rotateIfNeeded(logPath: string): void {
  try {
    const stats = statSync(logPath);
    if (stats.size < MAX_BYTES) return;
    const rotated = `${logPath}.1`;
    renameSync(logPath, rotated);
  } catch {
    // File missing → nothing to rotate.
  }
}
```

**Асуудал (🟠 дунд зэрэг — эхний тайлбараас нарийсгав):** зорилтот нэр нь `.1` гэсэн
**тогтмол** нэр тул хоёр дахь эргэлтээс эхлээд аль хэдийн байдаг. Хэрэв тэр `.1`
файлыг өөр handle барьж байвал EPERM. `catch` нь бүх алдааг «файл байхгүй» гэж
үзэх тул **эргэлт чимээгүй алгасагдаж**, `MAX_BYTES` хязгаар хүчингүй болно.

Эх лог файл нээлттэй байх нь **саад болохгүй** (дээрх хүснэгтийг хар) — тиймээс
энэ нь `constitutionBridge`-ээс бага эрсдэлтэй, гэхдээ `catch {}` нь `ENOENT`-ыг
`EPERM`-ээс ялгадаггүй нь согог хэвээр.

### 3.3 `src/process/bridge/ijfwDropBridge.ts:237`

`await fs.promises.rename(src, dest)` — нөхцөлийг шалгах шаардлагатай.

### 3.4 Prior art — багт мэдлэг АЛЬ ХЭДИЙН бий

`src/process/agent/acp/acpConnectors.ts` (мөр 196, 476-483, 743) —
«Windows Defender EPERM on cache move» гэсэн бүтэн илрүүлэлт + retry логиктой.

Өөрөөр хэлбэл баг энэ ангиллын алдааг мэддэг, гэхдээ зөвхөн **нэг газарт** зассан.
Тэр мэдлэгийг ерөнхий туслах функц болгож бүх бичилтэд хэрэглэх нь зөв.

---

## 4. Санал болгож буй засвар

### Нэг туслах функц гаргаж бүх газар ашиглах

```ts
import { renameSync, copyFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Атомт бичилт — Windows-д тэсвэртэй.
 *
 * POSIX-ийн rename(2) нь зорилтот файл нээлттэй байсан ч амжилттай болдог.
 * Windows-ийн MoveFileEx НЭ — өөр процесс зорилтот файлыг зөвхөн уншихаар
 * нээсэн байхад ч EPERM буцаана. Тиймээс EPERM/EBUSY/EACCES-ыг copy+unlink
 * рүү чиглүүлж, бүх тохиолдолд tmp-г цэвэрлэнэ.
 */
export function writeFileAtomic(target: string, data: string | Buffer): void {
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;  // PID-тэй — мөргөлдөхгүй
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EXDEV' || code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      try {
        copyFileSync(tmp, target);
      } finally {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
      }
    } else {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw err;
    }
  }
}
```

### Лог эргэлтэд

`catch {}` доторх алдааг **ялгах**: `ENOENT` бол үнэхээр «файл байхгүй»;
`EPERM`/`EBUSY` бол дахин оролдох эсвэл өөр нэрээр бичих. Одоогийн код хоёрыг
ялгахгүй тул Windows дээр эргэлт мөнхөд алгасагдана.

### Асаах үед шүүрдэх

`<dir>/*.tmp.*` хэлбэрийн 24 цагаас хуучин файлыг цэвэрлэх — IJFW-д энэ байхгүй
байсан тул 101 МБ хуримтлагдсан.

---

## 5. Хэрхэн шалгах

### Дархайн одоогийн байдал

```powershell
# Өнчин tmp файл байгаа эсэх
Get-ChildItem C:\claude\darhai -Recurse -File -Filter "*.tmp.*" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules' } | Measure-Object

# IJFW-ийн төлөв
Get-ChildItem C:\claude\darhai\.ijfw -Filter "scan-state.json.tmp.*" | Measure-Object
```

### Засвар ажилласан эсэхийг батлах

Тест бичихдээ **зорилтот файлыг нээж барьсан** нөхцөлийг заавал давт — энэ л
жинхэнэ бүтэлгүйтлийн нөхцөл:

```ts
const h = fs.openSync(target, 'r');     // өөр процессыг дуурайв
writeFileAtomic(target, 'шинэ агуулга'); // патчгүй бол EPERM шидэнэ
fs.closeSync(h);
// шалгах: агуулга бичигдсэн БА .tmp үлдээгүй
```

---

## 6. Товч дүгнэлт

| Юу | Байдал |
|---|---|
| IJFW v1.6.5 болсон | ✅ |
| IJFW-ийн EPERM согог зассан (локал патч) | ✅ шинэчлэл бүрд дахин хэрэглэнэ |
| Өнчин 354 файл / 101 МБ цэвэрлэсэн | ✅ |
| **Дархайн `constitutionBridge.ts` (2 газар)** | ❌ **засаагүй** |
| **Дархайн `audit-log.ts` лог эргэлт** | ❌ **засаагүй** |
| `ijfwDropBridge.ts:237` | ⚠️ шалгах шаардлагатай |
| Ерөнхий `writeFileAtomic` туслах функц | ❌ байхгүй |

**Хамгийн эхэнд хийх:** `writeFileAtomic` туслах функц гаргаад `constitutionBridge.ts`-ийн
хоёр газарт хэрэглэ. Тэр нь хэрэглэгчийн өгөгдөл алддаг цорын ганц зам.

---

## 7. Бэлэн жишээ — darhairoute дээр аль хэдийн хэрэгжүүлсэн

Ижил согогийг `C:\OpenCode\darhairoute` төсөл дээр 2026-08-07-нд бүрэн зассан.
Тэндээс кодыг нь **шууд хуулж авч болно**:

| Файл | Юу вэ |
|---|---|
| `src/lib/fsAtomic.ts` | `writeFileAtomicSync` · `writeFileAtomic` · `moveFileSync` · `moveFile` · `isRenameFallbackError` |
| `tests/unit/lib/fsAtomic.test.ts` | 12 тест — зорилтот файлыг нээж барьсан нөхцөлийг давтдаг |

`moveFileSync`-д гурван fallback горим бий:
- `"unlink"` (анхдагч) — жинхэнэ зөөлт
- `"truncate"` — идэвхтэй лог эргүүлэхэд (нээлттэй бичигчийн handle хүчинтэй хэвээр)
- `"keep"` — эвдэрсэн DB-г шинжилгээнд хадгалахад

**Хэмжсэн үр дүн (darhairoute):** 52 тест / 44 тэнцсэн / 8 унасан, харин өөрчлөлтгүй
baseline нь 40 / 32 / **8** — өөрөөр хэлбэл 12 шинэ тест бүгд тэнцэж, унасан тоо
хэвээр. ESLint 0 алдаа.
