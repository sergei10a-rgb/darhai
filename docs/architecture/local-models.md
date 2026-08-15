# Local Models

How Darhai turns "I want this model" into a running, locally-served model — with no
Ollama, no LM Studio, and no hand-installed llama.cpp.

Every number below was measured on 2026-08-15 on one machine (see
[Reference machine](#reference-machine)) against llama.cpp release b10441. Nothing here is
an estimate unless it is explicitly labelled as one — where the text compares a prediction
to reality, the prediction is Darhai's own `speedTps` and the reality is llama-server's
`predicted_per_second`.

---

## 1. What happens when the user presses the button

```
  ┌── hwfit ─────────────────┐   scanHardware() probes the host once (cached 60 s)
  │  RTX 4070 / 8 GB / cuda  │   and types the backend as cuda|rocm|metal|cpu_x86|cpu_arm
  └────────────┬─────────────┘
               │ backend
               ▼
  ┌── LlamaCppProvisioner ───┐   1. resolve   GitHub release metadata + per-asset sha256
  │  ensureInstalled()       │   2. download  into downloads/<asset>.part, HTTP-Range resume
  │                          │   3. verify    sha256 of the bytes ON DISK vs the API digest
  │                          │   4. extract   into staging/<tag>-<rand>/, symlinks included
  │                          │   5. gate      every library the binaries declare must resolve
  │                          │   6. install   write receipt LAST, rename staging -> versions/<tag>
  │                          │   7. discard   the archives; they are reproducible
  └────────────┬─────────────┘
               │ userData/llamacpp/versions/b10441/llama-server.exe
               ▼
  ┌── ModelDownloadManager ──┐   HF tree API picks the *.gguf matching the ranked quant,
  │  download()              │   streams it to <model>.gguf.tmp, renames on success
  └────────────┬─────────────┘
               │ userData/models/gguf/<model>.gguf
               ▼
  ┌── LocalServeManager ─────┐   resolveLlamaServer(): override -> PATH -> llamaServerCandidates()
  │  start({ ggufPath, ngl })│   allocates a free loopback port, spawns, waits for readiness
  └────────────┬─────────────┘
               │ http://127.0.0.1:<ephemeral>/v1
               ▼
  ┌── CookbookServeService ──┐   registers the served model as a keyless loopback
  │  registerCookbookServe   │   OpenAI-compatible provider
  └──────────────────────────┘
```

The step that used to be missing is the provisioner. `LocalServeManager` has always
searched `PATH` and then `this.deps.llamaServerCandidates()`, but that dep defaulted to
`() => []` with nothing injecting it, so a machine without a hand-installed llama.cpp
reported `llamaServer: false` and the flow degraded to printing a shell command.
`cookbookServeSingleton.ts` now injects `llamaServerCandidates(app.getPath('userData'))`
from `@process/services/llamacpp`, read fresh on every call so a mid-session install is
visible to the very next serve attempt. The default stays `[]`, so the degraded path is
unchanged on a machine with nothing installed.

**Measured** — with `C:\claude\llamacpp` (a hand-installed llama.cpp) removed from `PATH`,
so nothing but the managed install could satisfy the lookup:

```
llama-server still on scrubbed PATH? null
candidates from provisioner: ["C:\\Users\\...\\Darhai\\llamacpp\\versions\\b10441\\llama-server.exe"]
resolveLlamaServer() -> C:\Users\...\Darhai\llamacpp\versions\b10441\llama-server.exe
detectAvailability() -> {"ollama":true,"llamaServer":true,"vllm":false}
```

Ordering matters: `resolveLlamaServer()` prefers `PATH` over the managed install, so a
user who already has llama.cpp keeps using theirs.

---

## 2. Where things are stored

All paths are under `app.getPath('userData')` — on Windows
`%APPDATA%\Darhai`.

```
userData/
├── llamacpp/
│   ├── versions/
│   │   └── b10441/                   <- a complete install, and only ever complete
│   │       ├── llama-server.exe
│   │       ├── ggml-cuda.dll
│   │       ├── cudart64_13.dll, cublas64_13.dll, cublasLt64_13.dll
│   │       ├── … (55 files total)
│   │       └── darhai-llamacpp.json  <- the receipt, written LAST
│   ├── downloads/                    <- in-flight archives; deleted once installed
│   └── staging/                      <- extraction scratch, renamed into versions/ on success
└── models/
    └── gguf/
        ├── Qwen_Qwen2.5-0.5B-Instruct.gguf
        ├── Qwen_Qwen2.5-7B-Instruct.gguf
        └── openai_gpt-oss-20b.gguf
```

Two properties this layout buys, both structural rather than best-effort:

- **A killed install can never look installed.** The receipt is the last file written into
  `staging/`, and only then is the directory renamed into `versions/<tag>`. `staging/` and
  `downloads/` are not on the search path, so a half-extracted tree is invisible, not
  merely incomplete.
- **An upgrade cannot damage a working install.** `versions/` is keyed by release tag, so
  fetching b10500 writes a sibling directory and b10441 keeps running.
- **A staging directory cannot leak.** Every exit from a failed install removes it, and a
  process killed outright is swept on the next attempt (anything older than an hour).
  Otherwise the retry after an out-of-disk failure consumed the space that would have let
  it succeed.

Readiness is a filesystem fact, not a flag — and deliberately not a fact the extractor
gets to assert about itself. The receipt (schema 2) records the explicit list of files
installed **and** the library names the installed binaries declare they need, read out of
the binaries: Mach-O `LC_LOAD_DYLIB`/`LC_ID_DYLIB`, ELF `DT_NEEDED`/`DT_SONAME`. Only
install-local names count — `libggml-base.so.0` does, `libc.so.6` never does.
`isInstalled()` then requires the receipt to parse at the current schema and name its own
tag, the server binary to exist, every recorded file to exist, and every required library
name to resolve. `existsSync` follows symlinks, so a dangling link reads as missing.

Schema 1 counted files instead, and the count came from the same extractor that wrote
them — so an extraction that dropped 19 of 62 members certified itself ready at 43 ≥ 43.
A schema-1 receipt now reads as **not** ready, so a machine carrying one reinstalls rather
than re-certifying a broken tree.

---

## 3. Which llama.cpp build is chosen, and why

`planLlamaAssets()` is pure: platform × arch × backend × _the asset names the release
actually ships_. It never constructs a name that could 404. When the requested backend has
no build, it says so through `fallback.code` (a stable identifier to key i18n off) rather
than silently degrading.

| Host                      | hwfit backend | Chosen build                                                                             | Acceleration | Fallback code                           |
| ------------------------- | ------------- | ---------------------------------------------------------------------------------------- | ------------ | --------------------------------------- |
| Windows x64 + NVIDIA      | `cuda`        | `llama-<tag>-bin-win-cuda-<ver>-x64.zip` **+ `cudart-llama-bin-win-cuda-<ver>-x64.zip`** | cuda         | —                                       |
| Windows x64 + AMD         | `rocm`        | `llama-<tag>-bin-win-rocm-<ver>-x64.zip`                                                 | rocm         | —                                       |
| Windows + Intel/other GPU | `cpu_x86`     | `llama-<tag>-bin-win-cpu-x64.zip`                                                        | cpu          | — (note `VULKAN_BUILD_NOT_REQUESTABLE`) |
| macOS arm64               | `metal`       | `llama-<tag>-bin-macos-arm64.tar.gz`                                                     | metal        | —                                       |
| macOS x64                 | `metal`       | `llama-<tag>-bin-macos-x64.tar.gz`                                                       | cpu          | `METAL_REQUIRES_APPLE_SILICON`          |
| Linux + NVIDIA/AMD        | `cuda`/`rocm` | `llama-<tag>-bin-ubuntu-x64.tar.gz`                                                      | cpu          | `NO_GPU_BUILD_FOR_TARGET`               |

Linux is the surprising row and it is not a bug in the mapper: release b10441 ships
`ubuntu-{x64,arm64}` and `ubuntu-vulkan-{x64,arm64}` and **no CUDA or ROCm build at all**.
A Linux NVIDIA box therefore gets the CPU build, and `fallback` says so out loud.

### The CUDA runtime split — the expensive decision

The Windows CUDA server archive contains `ggml-cuda.dll` but **not** `cudart64_13.dll`,
`cublas64_13.dll` or `cublasLt64_13.dll`. Those ship with the CUDA _Toolkit_; the NVIDIA
_driver_ installs only `nvcuda.dll` into System32. So the 373 MB `cudart-…` archive is
required unless the machine already resolves those three DLLs, which is what
`hasCudaRuntime()` probes.

**Measured** — this is not a theoretical difference. Installing with
`cudaRuntimePresent: true` into a throwaway userData produced a 180.3 MB install with the
three DLLs absent, and then:

```
--- WITH C:\claude\llamacpp on PATH ---
exit=0   Available devices:
           CUDA0: NVIDIA GeForce RTX 4070 Laptop GPU (8187 MiB, 7068 MiB free)

--- WITHOUT it (a machine that only has Darhai) ---
exit=0   Available devices:
           (none)
```

The GPU disappears, exit code is **0**, and nothing is logged. llama-server falls back to
CPU — a silent 4.8× slowdown (see §5). The full install, with the cudart archive, was
verified self-contained: `--list-devices` reports CUDA0 with `C:\claude\llamacpp` scrubbed
from `PATH`.

### The driver floor — why the newest CUDA line is not always the right one

A release ships several CUDA lines (b10441 has 12.4 and 13.3). Taking the newest
unconditionally is wrong in a way that is invisible: a 13.x build on a pre-580 driver
reports `Available devices: (none)`, **exits 0**, logs nothing, and runs on the CPU — after
a 512 MB download. Exactly the §3 failure above, from a different cause.

So the driver version is now measured, not assumed. `NVIDIA_QUERY_ARGS` asks nvidia-smi for
`driver_version` alongside memory and name, the Windows PowerShell probe carries it through
as `gpu_driver`, and `assetMap` checks it against `CUDA_MIN_DRIVER_MAJOR` (`12` → 525,
`13` → 580) before choosing a line. Below every floor it falls back to CPU with
`CUDA_DRIVER_TOO_OLD` rather than downloading a build that cannot load. An empty string
means _not measured_ and is never treated as a version — in that case it offers the newest
line, which is the pre-existing behaviour, not a silent downgrade.

The reference machine reports driver **610.62**, so it clears the 13.x floor and gets
`cuda-13.3`.

`hasCudaRuntime()` searches `CUDA_PATH\bin`, every `PATH` entry, then `System32`. On the
reference machine it returned `true` — because a _third-party_ directory
(`C:\claude\llamacpp`, a hand-installed llama.cpp) was on `PATH`. `excludeDirs` only
excludes Darhai's own install root. See [What is not handled yet](#7-what-is-not-handled-yet).

---

## 4. What it costs — disk and time

### Provisioning llama.cpp (measured, one clean run)

|                                   |                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Release resolved                  | `b10441`, 26 assets, metadata fetch **595 ms**                                                                                         |
| Assets planned                    | `llama-b10441-bin-win-cuda-13.3-x64.zip` 146,779,155 B (140.0 MB)<br>`cudart-llama-bin-win-cuda-13.3-x64.zip` 390,970,417 B (372.9 MB) |
| **Total download**                | **512.8 MB**                                                                                                                           |
| Wall time, download → runnable    | **20.6 s**                                                                                                                             |
| Phase offsets                     | downloading 1.4 s · verifying 6.3 s · extracting 6.7 s · installing 20.6 s · done 20.6 s                                               |
| Peak observed rate                | 53.1 MB/s                                                                                                                              |
| Installed size                    | **670 MB**, 55 files + receipt                                                                                                         |
| Retained archives in `downloads/` | **0** — deleted after the install commits (they are reproducible and already verified)                                                 |
| **Total `llamacpp/` footprint**   | **670 MB**                                                                                                                             |
| Second `ensureInstalled()`        | `cached=true` in **0.6 s**, and with no network I/O at all when the tag is pinned                                                      |

Extraction and verification, not the network, dominate the tail: bytes were on disk at
6.3 s and the install completed at 20.6 s. Most of that is the 373 MB cudart archive —
`cublasLt64_13.dll` alone is 460 MB uncompressed.

Skipping the cudart archive (when the runtime genuinely is present) costs 140.0 MB and
7.0 s instead — a 3.7× smaller download, at the cost described in §3.

### Downloading models (measured)

| Model                 | GGUF on disk | Download time | Effective rate |
| --------------------- | ------------ | ------------- | -------------- |
| Qwen2.5-0.5B-Instruct | 379.4 MB     | 14.3 s        | 26.5 MB/s      |
| Qwen2.5-7B-Instruct   | 4,466.1 MB   | 136.4 s       | 32.7 MB/s      |
| openai/gpt-oss-20b    | 13,153.7 MB  | 365.2 s       | 36.0 MB/s      |

Rates are from one machine on one network on one day; the sizes are exact.

### Loading a model (measured, time from spawn to readiness)

| Model                 | `-ngl 24`   | `-ngl 99` | `-ngl 0` |
| --------------------- | ----------- | --------- | -------- |
| Qwen2.5-0.5B-Instruct | 1.5 s       | —         | —        |
| Qwen2.5-7B-Instruct   | 4.6 s       | 3.8 s     | 3.5 s    |
| openai/gpt-oss-20b    | 11.6–14.4 s | 12.1 s    | —        |

---

## 5. What an 8 GB card actually means

### The card is not 8 GB

**Measured.** With no model loaded but a normal desktop session running, `nvidia-smi`
reported **2,169 MiB of 8,188 MiB already in use** (Explorer, WebView2, the NVIDIA
overlay, and so on). llama.cpp saw **7,068 MiB free**. Budget against ~6.9 GB, not 8.

### The catalog offers 121 models, not 912

**Measured.** `getCatalogSize()` is 912, but only **121** entries carry a `ggufSources`
repo, and `rankModels()` drops non-GGUF models on Windows, macOS and consumer AMD — the
platforms that can only be served through llama.cpp. On the reference machine
`rankCatalog(hw, { limit: 9999 })` returned 121 results:
**47 `gpu`, 54 `cpu_offload`, 20 `no_fit`.**

So: of everything Darhai knows about, a bit under half of what it can serve here runs on
the GPU, a bit under half needs system RAM, and one in six does not fit at all.

### What the top of the ranking actually does

The catalog's highest-scoring entries for this rig are all 7–9B at Q4_K_M, marked
`runMode: gpu`, `fitLevel: perfect`. Taking rank #2 (`Qwen/Qwen2.5-7B-Instruct`, the
highest-ranked general-purpose model) and rank #16 (`openai/gpt-oss-20b`, the
highest-ranked model that needs offload), all served through `LocalServeManager`:

| Configuration                                           | Layers on GPU | gen tok/s (steady median) | TTFT (warm) | VRAM total |
| ------------------------------------------------------- | ------------- | ------------------------- | ----------- | ---------- |
| Qwen2.5-7B, `-ngl 24` (what Darhai passed before)       | 24 / 29       | **24.6**                  | 50–62 ms    | 7,468 MiB  |
| **Qwen2.5-7B, `-ngl 99` ≡ `auto`** (what it passes now) | 29 / 29       | **41.6**                  | 31 ms       | 7,505 MiB  |
| Qwen2.5-7B, `-ngl 0` (pure CPU)                         | 0 / 29        | **8.7**                   | 124–139 ms  | 1,713 MiB  |
| gpt-oss-20b, `-ngl 24` (before)                         | 24            | **6.8**                   | —           | 7,486 MiB  |
| gpt-oss-20b, `-ngl 99`                                  | auto          | **6.7**                   | —           | 7,531 MiB  |
| gpt-oss-20b, `-ngl 99 --n-cpu-moe 16`                   | auto          | **21.7**                  | —           | 7,026 MiB  |

Numbers are llama-server's own `predicted_per_second`, median of runs 2–N (run 1 is
excluded: it includes CUDA graph capture and clock ramp, and was consistently 5–20%
slower). Each run generated 200–400 tokens at `temperature: 0`.

Three things fall out of that table.

**A model that fits ran at 59% speed — this is what the fix changed.**
`ngpuLayersForVram()` returns `floor(vramGb × 3)` = **24** for any 8 GB card, regardless
of model. Qwen2.5-7B has 28 layers + output = 29. At `-ngl 24`, llama.cpp reports:

```
load_tensors: offloaded 24/29 layers to GPU
load_tensors:   CPU_Mapped model buffer size =   969.10 MiB
load_tensors:        CUDA0 model buffer size =  3491.35 MiB
llama_kv_cache:        CPU KV buffer size =   320.00 MiB
llama_kv_cache:      CUDA0 KV buffer size =  1472.00 MiB
```

969 MB of weights and 320 MB of KV cache sit in system RAM, and every token pays for them.
At `-ngl 99` the same model reports `offloaded 29/29`, and total VRAM is _unchanged_
(7,505 vs 7,468 MiB) — because llama.cpp spends whatever is left on KV cache either way,
trimming the context from 32,768 to 31,232 to fit. The conservative layer count buys **no
VRAM headroom** and costs **41% of throughput**.

**llama.cpp b10441 already solves this, and `-ngl` switches it off.** Launched with _no_
`--n-gpu-layers` flag at all, it self-sizes:

```
common_params_fit_impl: entire model can be fit by reducing context
load_tensors: offloaded 29/29 layers to GPU
```

Passing an explicit `-ngl` disables that fit (`n_gpu_layers already set by user to 99,
abort` appears when other placement flags are combined with it). The heuristic in
`LocalServeManager` predated this llama.cpp capability.

**What it does now.** `LocalServeManager` probes the resolved binary's `--help` once per
binary path (measured 261 ms, 57 KB, exit 0; cached) and passes `--n-gpu-layers auto`
when the build offers it, so llama.cpp measures **free** VRAM and fits the layers itself.
`ngpuLayersForVram()` survives only as the fallback for builds whose help text does not
list `auto` — which is why the probe reads the flag's own help entry structurally rather
than grepping the whole text for the word.

**For MoE models, the useful knob is not `-ngl`.** gpt-oss-20b is 13.2 GB of weights on a
6.9 GB budget, so `-ngl` barely matters (6.8 vs 6.7). Moving _expert_ tensors to the CPU
instead of whole layers keeps attention on the GPU. Measured sweep:

| `--n-cpu-moe` | 8    | 12   | **16**   | 20   |
| ------------- | ---- | ---- | -------- | ---- |
| gen tok/s     | 10.4 | 11.5 | **21.7** | 18.2 |

The best setting is **3.2× faster** than what Darhai passes today. The optimum is
model- and VRAM-specific — 16 was best here, and both 12 and 20 were worse — so this
wants a short measured probe, not a formula.

### The speed estimates were optimistic, and are now calibrated

`speedModel.ts` produces a `speedTps` shown next to every model. As first measured it was
3–5× high, so the column was a ranking dressed up as a number:

| Model                 | Predicted (before) | Measured (as shipped then) | Over-estimate |
| --------------------- | ------------------ | -------------------------- | ------------- |
| Qwen2.5-0.5B-Instruct | 1,122.2            | 235.2                      | 4.8×          |
| Qwen2.5-7B-Instruct   | 72.8               | 24.6                       | 3.0×          |
| openai/gpt-oss-20b    | 26.0               | 6.8                        | 3.8×          |

Two real defects were behind most of it:

- **Every laptop GPU was given its desktop namesake's bandwidth.** nvidia-smi reports
  "NVIDIA GeForce RTX 4070 Laptop GPU", and the substring lookup matched the desktop
  `4070` key — 504 GB/s for a part with a 128-bit bus. Mobile SKUs are now their own keys,
  kept longer than the desktop name so they win the longest-first match.
- **The model had no per-token cost**, so predicted throughput went to infinity as the
  model shrank. That is why the 0.5B was the worst offender at 4.8×.

After fixing both and re-measuring against a real `/completion` (warm, median of 3):

| Model                 | Predicted (after) | Measured          | Error      |
| --------------------- | ----------------- | ----------------- | ---------- |
| Qwen2.5-0.5B-Instruct | 296.9             | 299.44 (272–302)  | **−0.8 %** |
| Qwen2.5-7B-Instruct   | 33.8              | 33.97 (32.8–41.1) | **−0.5 %** |
| openai/gpt-oss-20b    | 20.2              | (offload branch)  | —          |

The 7B spread reaches 41.1 tok/s, so the 41.6 in the table above is the top of that
distribution rather than a contradiction — llama.cpp's own `predicted_per_second` varies
run to run by roughly a quarter on this machine. The calibration is anchored in
`tests/unit/hwfitSpeedCalibration.test.ts`, so a future edit to the model that walks away
from the measurements fails.

### Who can reach the served model

llama.cpp's own startup banner, captured verbatim from a Darhai-spawned server before the
fix:

> `CORS is set to allow all origins ('*') and no API key is set`
> `this can be a security risk (cross-origin attacks)`

Binding to `127.0.0.1` does **not** contain this, and that is the part worth stating
plainly: a browser is a local process. Any web page the user happens to have open can
script a cross-origin request to the served model and read the answer back. Measured with
an `Origin: https://evil.example` preflight against `/v1/chat/completions`:

```
default:                 Access-Control-Allow-Origin: https://evil.example
                         Access-Control-Allow-Credentials: true      (preflight AND GET)
--cors-origins localhost: no allow-origin header at all
```

`start()` now appends `--cors-origins localhost` whenever the capability probe finds the
flag. No API key is set, deliberately — the endpoint is registered as a keyless loopback
provider, and a key stored beside the thing it protects protects nothing.

### Proof the chain works

The point of all this is that a completion comes back. It does — through the managed
binary, with the hand-installed llama.cpp removed from `PATH`:

```
SPAWN: C:\Users\...\Darhai\llamacpp\versions\b10441\llama-server.exe
       -m C:\Users\...\Darhai\models\gguf\Qwen_Qwen2.5-7B-Instruct.gguf
       --host 127.0.0.1 --port 53856 --n-gpu-layers auto --cors-origins localhost

TTFT: 50 ms | 200 tokens | 24.8 tok/s
"A bicycle derailleur is a mechanical device that shifts gears on a bicycle by moving
 the chain from one sprocket (chainring or cog) to another. …"
```

---

## 6. Reference machine

Detected by the repo's own `scanHardware(true)` (probe took 3,269 ms), not asserted:

```json
{
  "totalRamGb": 63.2,
  "availableRamGb": 27.4,
  "cpuCores": 24,
  "cpuName": "AMD Ryzen 9 7845HX with Radeon Graphics",
  "hasGpu": true,
  "gpuName": "NVIDIA GeForce RTX 4070 Laptop GPU",
  "gpuVramGb": 8,
  "gpuCount": 1,
  "backend": "cuda",
  "platform": "windows",
  "gpuError": null
}
```

`process.platform=win32`, `process.arch=x64`. NVIDIA driver 610.62, CUDA UMD 13.3,
`CUDA_PATH` empty (no CUDA Toolkit installed). llama.cpp release b10441.

---

## 7. What is not handled yet

Each item below was observed, not anticipated. Items that _were_ fixed are recorded in
§2–§5 above with their measurements; what follows is only what is still open.

**MoE models have no expert-offload path.** `--n-cpu-moe` is not passed at all;
measured 3.2× on gpt-oss-20b. The optimum is not a formula (16 beat both 12 and 20), so
this needs a short probe at first serve, cached per model. `--n-gpu-layers auto` does not
cover this: for a model far larger than VRAM the layer count barely matters (6.8 vs 6.7),
and it is the _expert_ tensors that need to move.

**The Vulkan build is still not requestable.** `HwfitBackend` has no `vulkan` member, so a
Windows machine with an Intel or AMD integrated GPU maps to `cpu_x86` and gets the CPU
build even though release b10441 ships `llama-<tag>-bin-win-vulkan-x64.zip` (34.6 MB). The
user is now _told_ this — `VULKAN_BUILD_NOT_REQUESTABLE` crosses IPC as a note code and is
rendered in 13 locales — but telling is not wiring. Doing it properly means a new backend
in hwfit, not a special case in the asset mapper.

**`buildServeCommand()` still emits a numeric `--n-gpu-layers`.** That is the
copy-paste-the-command escape hatch shown when the managed path fails, so the fallback
advice is now worse than what the app itself does. It should print `auto` when the
resolved binary supports it.

**Release-metadata fetches have no timeout.** On a captive portal or blackholed DNS,
`plan()` is an unbounded spinner. `cancel()` is also a genuine no-op during that window —
the provisioner's `AbortController` does not exist until after the release lookup — so
the UI tells the truth ("this step cannot be stopped yet") rather than pretending, but
the underlying gap is real: the one moment a user who just read "512.8 MB" is most likely
to press Cancel is the one moment it cannot work.

**A resumed session under-reports what is already downloaded.** `status()` reads
`versions/` and never `downloads/*.part`, so after a cancel or an app close mid-download
the state is `missing` and pressing Serve re-discloses the FULL size — even though
`fetchAsset` will resume from those bytes. The disclosure is pessimistic, not wrong, but
it misrepresents the remaining cost.

**Progress is emitted per stream chunk with no throttling**, so a 512.8 MB transfer at
53.1 MB/s crosses IPC thousands of times, each one re-rendering the model table.
`assetName` / `assetIndex` / `assetCount` also cross on every frame and are never
rendered, so a two-archive CUDA install (147 MB + 373 MB) shows one merged bar and never
says there are two.

**`hasCudaRuntime()` can be satisfied by a directory Darhai does not own.** It searches
every `PATH` entry and excludes only Darhai's own install root, so an unrelated
third-party llama.cpp on `PATH` makes the probe return `true`, drops the 373 MB cudart
archive, and produces an install that silently loses the GPU if that directory later
disappears (proven in §3: `Available devices: (none)`, exit 0, no log). Options: always
fetch the archive; restrict the probe to `CUDA_PATH\bin` + `System32`; or record the
resolving directory in the receipt and re-verify before serving.

**Reasoning models return an empty answer to a naive client.** gpt-oss-20b emits its
chain of thought as `delta.reasoning_content` and the answer as `delta.content`. Measured:
a 200-token budget produced **200 tokens and zero characters of `content`** (all
reasoning, `finish_reason: "length"`); at 400 tokens, 88 of 183 chunks were still
reasoning. A client that reads only `content` shows an empty bubble after 30 seconds of
apparent work. Whatever consumes the cookbook-local provider must render or at least
account for `reasoning_content`, and the token budget must allow for it.

**GGUF downloads are not integrity-checked.** `ModelDownloadManager` computes a sha256 and
logs it, but no hash is pinned, so nothing is verified — deliberate (GGUF repos rarely
publish one) and worth stating: the llama.cpp binaries are verified, the model weights are
not.

**Turing-era mobile GPUs still match their desktop namesake.** The mobile-SKU bandwidth
keys added during calibration cover the 40/50-series "Laptop GPU" naming; older parts are
reported as e.g. "GeForce RTX 2080 Super with Max-Q Design", which contains no `laptop`
token and so still resolves to the desktop key. The error is the same class the
calibration fixed, just on hardware that was not in front of it.

**Only one serve at a time, and no crash recovery.** An MVP default, not a hardware limit:
`start()` stops any running server first, and there is no watchdog restart if
`llama-server` dies mid-session.

**Nothing measures the host before choosing a quant.** The advisor ranks against
`gpuVramGb` (8), not against free VRAM (6.9 GB here, and lower with a browser open). A
model marked `fitLevel: perfect` can still land in offload on a busy desktop.

---

## Related

- [Architecture overview](overview.md) — process model and IPC boundary
- `src/process/services/llamacpp/` — provisioner, asset mapper, install layout
- `src/process/services/hwfit/` — hardware probe, catalog, fit scoring
- `src/process/services/cookbook/` — GGUF download, serve lifecycle, provider registration
