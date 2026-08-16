# Монгол дуу хоолой — TTS + STT цөмийн шингээлт

Дархайн дуу хоолойн давхаргыг бүрэн орлуулах загвар. Хоёр чиглэл хоёулаа
**CPU дээр** ажиллана — GPU огт шаардахгүй.

## Юуг юугаар сольж байна

Өвлөсөн давхарга бодитоор хэзээ ч ажиллаагүй (2026-08-16-нд хэмжсэн):
`voiceBinaryManifest.ts`-ийн гурван URL бүгд **404** (whisper.cpp v1.7.1 нь
asset огт гаргаагүй; onnxruntime бол номын сан, CLI биш), `kokoro-local` нь
байхгүй CLI интерфейс дуудна, `system-native` нь Windows дээр чимээгүй хоосон
аудио буцаана. Kokoro нь монгол хэл огт дэмждэггүй.

| Чиглэл | Шинэ цөм | Хэмжсэн (Ryzen 9 7845HX, 2026-08-16) |
|---|---|---|
| **TTS** | Kitten-mn шавь загвар (StyleTTS2 дистилл, ONNX, Python embedded) | RTF **0.18** (4 урсгал) / 0.128 (8 урсгал) · RAM 575 МБ · ачаалалт ~2 сек |
| **STT** | Nemotron Монгол v13mn ASR (audio.cpp GGUF Q8) | Бодит цагаас **12.4× хурдан** · ачаалалт ~1.1 сек · CER 15.03% |

Яагаад хоёр өөр runtime вэ: STT-д audio.cpp нь Python-гүй ганц exe (24 МБ),
OpenAI-нийцтэй сервер, streaming дэмжлэгтэй — өрсөлдөгчгүй. TTS-д audio.cpp-ийн
цорын ганц монгол загвар нь OmniVoice (ерөнхий олон хэлний) бөгөөд kitten-mn-ийн
монгол G2P урд бэлтгэлгүй (тоо, товчлол, огноо, утасны дугаар, латин үг) —
чанараар харьцуулшгүй. audio.cpp-д StyleTTS2/Kitten family байхгүй гэдгийг
эх кодоос нь баталсан тул шавь загварыг GGUF болгох зам одоогоор хаалттай.

## Бэхэлсэн asset-ууд (хэмжсэн sha256)

| Asset | Эх сурвалж | sha256 | Хэмжээ |
|---|---|---|---|
| audio.cpp win32-x64 cpu-balance | `0xShug0/audio.cpp` release-0.6 (`audiocpp-windows-cpu-balance-bb15edd7.zip`) | `3c618e98b9b780dac35033a4993f43ecf9b8da23c2634051e7ae411b4bb034af` | 24,231,095 |
| Nemotron mn v13m GGUF Q8 | Дархайн release `voice-v1` (нийтлэгдэнэ) | `e6d88cea0072ed2911f4350dfb514f94f0fdd58500643cc14f02b422d40a777f` | 931,233,056 |
| kitten-mn TTS багц (CPU, ONNX) | Дархайн release `voice-v1` (баригдана) | багц баригдмагц бэхлэгдэнэ | ~550-600 МБ задаргаатай |

Балансын profile-ийг сонгосон шалтгаан: upstream README нь үүнийг «AVX2 хэрэглэдэг
ч AVX512/native сонголтоос зайлсхийдэг, орчин үеийн ихэнх PC-д тохирох анхдагч»
гэж зөвлөдөг; release-0.6 binary энэ машин дээр 12.0× бодит цагаас хурдан гэж
шууд хэмжигдсэн (хуучин build-тэй ижил гаралт, ижил хурд).

⚠️ **Платформын хамрах хүрээ**: audio.cpp release-0.6 нь зөвхөн Windows prebuilt
гаргадаг. macOS/Linux дээр STT-г эх кодоос барих боломжтой (Apache 2.0) — энэ нь
төслийн дэмждэг зам, гэхдээ одоогоор Дархай суулгаж өгөхгүй. TTS багц нь эхний
ээлжид win32-x64 (embedded CPython). Хоёулаа платформ нэмэгдэхээр manifest-д
мөр нэмэгдэнэ.

## Хадгалалтын зохион байгуулалт

```
<userData>/voice/mongol/
  downloads/                  # *.part — Range-аар үргэлжлэх таталт
  stt/versions/<tag>/         # задалсан audio.cpp + darhai-voice.json receipt
  stt/models/                 # nemotron GGUF (ганц файл)
  tts/versions/<tag>/         # задалсан kitten багц + receipt
```

llama.cpp provisioner-ийн зарчмуудыг яг давтана: татах → sha256 → задлах →
receipt-ийг ХАМГИЙН СҮҮЛД бичих → staging-аас нэрлэсэн хавтас руу rename.
Receipt-гүй хавтас = дуусаагүй суулгалт, дараагийн оролдлого цэвэрлэнэ.
Hash заавал — hash-гүй asset-ыг татахаас ТАТГАЛЗАНА (voiceAssetRegistry-ийн
«анхааруулаад өнгөрөх» замыг энд хэрэглэхгүй).

## Kitten TTS багцын гэрээ (bundle.json)

Багцын дотоод бүтцээс Дархай ХАМААРАХГҮЙ — зөвхөн үндсэн хавтасны
`bundle.json`-ийг уншина:

```json
{
  "name": "kitten-mn-tts",
  "version": 1,
  "api": "kitten-v1",
  "entry": "python/python.exe",
  "args": ["service/server.py", "--onnx", "--port", "{port}"],
  "healthPath": "/api/status",
  "speakPath": "/api/speak"
}
```

- `{port}` орлуулагдана; сервер зөвхөн 127.0.0.1 дээр сонсоно (kitten server.py
  анхдагч host нь loopback гэдгийг эх кодоос баталсан).
- `POST /api/speak` `{text, voice?, speed?}` → `audio/wav` байт + `X-Rtf` толгойнууд.
- `GET /api/status` → `{voices: [...], max_chars, min_speed, max_speed, ...}`.
- Багц баригч нь kitten-mn төслийн дотор (`tools/`-д) байна — Дархай зөвхөн
  бэлэн zip-ийг татна.

## Процессын эзэмшил

Хоёр сервер хоёулаа Дархайн **өөрийн** процесс: Дархай асаана, эрүүл эсэхийг
шалгана, унавал дараагийн хүсэлт дээр дахин асаана, апп хаагдахад зогсооно
(`before-quit`). Хэрэглэгчийг гуравдагч програм руу явуулахгүй; доор нь юу
ажиллаж байгааг Voice тохиргооны хуудас харуулна.

- `AudioCppServer` — тохиргооны JSON үүсгэж (`host: 127.0.0.1`, `backend: cpu`,
  nemotron загвар streaming горимоор), `audiocpp_server.exe --config` асаана.
- `KittenTtsServer` — `<багц>/python/python.exe service/server.py --onnx --port N`
  (PYTHONIOENCODING=utf-8, PYTHONUTF8=1 — Windows кирилл pipe-ийн занга).
- Порт: чөлөөт loopback портыг Дархай өөрөө сонгож аргументаар өгнө.

## Төрлийн өөрчлөлт

- `TextToSpeechProvider` += `'kitten-mn'`; анхдагч provider `'kitten-mn'` болно.
  `'kokoro-local'` union-д хэвээр (хуучин тохиргоо эвдэхгүй) ч UI-д гарахгүй,
  дуудвал ойлгомжтой алдаа буцаана.
- `SpeechToTextProvider` += `'nemotron-mn'`; локал анхдагч. `'whisper-local'`
  union-д хэвээр, UI-д гарахгүй (404 хамаарлууд арилтал).
- `system-native` нь зөвхөн macOS дээр сонгогдоно (UI gate — кодын тайлбар
  амлаад хэрэгжүүлээгүй байсныг гүйцээв).

## Аудио хөрвүүлэлт (STT оролт)

Renderer-ийн микрофон бичлэг webm/opus байж болно; audio.cpp-д wav өгнө.
Хөрвүүлэлт: Дархайд аль хэдийн буй ffmpeg резолюцийг (видео фрэймийн зам)
дахин ашиглаж 16 кГц моно WAV болгоно. wav ирвэл шууд дамжуулна.

## Аюулгүй байдал

- Хоёр сервер зөвхөн loopback; түлхүүргүй.
- zip доторх зам: audio.cpp-ийн zip нь **backslash тусгаарлагчтай** (Windows
  хэрэгслээр баригдсан, APPNOTE-ийн зөрчил). Шалгаж баталсан: `safeEntryPath`,
  `commonRootPrefix`, `stripRoot` гурвуулаа `\`→`/` нормчилдог тул задаргаа ч,
  receipt-ийн замууд ч зөв гарна; `..\` traversal мөн адил няцаагдана.
  Энэ зан төлөвт зориулсан тест нэмнэ (upstream zip-ийн бодит хэлбэр учраас).
- Receipt-д файлын жагсаалт; дутуу задаргаа = суулгаагүйд тооцно.

## Хэрэгжүүлэлтийн файлууд

`src/process/services/voice/mongol/` — `manifest.ts` · `installLayout.ts` ·
`MongolVoiceProvisioner.ts` · `AudioCppServer.ts` · `NemotronStt.ts` ·
`KittenTtsServer.ts` · `KittenTts.ts`. Dispatch өөрчлөлт:
`TextToSpeechService.ts`, `bridge/media/voice/SpeechToTextService.ts`.
UI: `VoiceSettings/` + `ToolsModalContent.tsx`. IPC: voice bridge-д
install/status/progress/cancel verb-үүд.

## Адверсарь ревьюгийн дараах бэхжүүлэлт (2026-08-16)

Бүх өөрчлөлт дээр skeptic ревью хийлгэж, олдвор бүрийг улаан тест →
засвар → ногоон замаар хаасан:

- **Зэрэгцээ `ensureRunning` (Kitten)** хоёр python.exe асааж нэгийг нь
  өнчрүүлдэг байсныг туршилтаар нотолж, health-шалгалтыг хуваалцсан
  promise-ийн дотор оруулж засав (AudioCpp-ийн загвар).
- **Давхар `install()`** нэг `.part`-д хоёр урсгал бичдэг байсныг компонент
  бүрийн in-flight promise dedup-ээр хаав; `cancel` одоо цорын ганц идэвхтэй
  ажлыг таслана.
- **TTS цөм бүтээгдэхүүнээс дуудагддаггүй байсан** (voiceSynth.speak-ийн
  дуудагч тэг) — «Хоолой турших» жинхэнэ хөдөлгүүрээр, `autoReadResponses`
  нь response stream-ийн `finish` дээр, мессеж бүрд «Уншуулах» товч.
- Voice settings нээхэд л TTS сервер асдаг гаж нөлөөг `ttsVoices`-ийн
  `startIfNeeded:false`-аар арилгав.
- STT анхдагч `'nemotron-mn'` болж баримттай нийцэв; хадгалагдсан
  `whisper-local` (404 binary) хоёр талдаа `nemotron-mn` руу шилжинэ;
  Windows дээрх `system-native` чимээгүй хоосон аудионы оронд typed
  `TTS_SYSTEM_NATIVE_UNSUPPORTED` шиддэг боллоо.
- Бүх STT/TTS алдааны код 13 хэлээр локалчлагдаж, суулгаагүй үед
  Тохиргоо → Дуу хоолой руу чиглүүлдэг боллоо.

## Түгээлт

Release tag `voice-v1` (sergei10a-rgb/darhai) дээр: nemotron GGUF + kitten
багцын zip. audio.cpp binary нь upstream release-ээс шууд (Apache 2.0,
sha256-аар бэхэлсэн тул дур мэдэн солигдохоос хамгаалагдсан). GitHub release
asset-ийн 2 ГБ хязгаарт бүгд багтана.
