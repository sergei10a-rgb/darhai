# Local Models

How Darhai turns "I want this model" into a running, locally-served model.

There are two halves to that, and they are not the same promise.

**A machine with nothing on it** gets a model running anyway — no Ollama, no LM Studio, no
hand-installed llama.cpp, one press. That is what §1–§5 are about: Darhai's own bundled
llama.cpp, and every decision it has to make on the user's behalf because there is nobody
else to make them.

**A machine that already has a local runtime** gets a different promise: the user picks
their own tool by name and Darhai downloads nothing. Ollama and LM Studio are the two
tools a knowledgeable user expects to see there, so both are detected, both appear in the
chooser, and both are served through without a byte crossing the network. §6 is LM Studio,
which is the harder of the two because Darhai does not own its process.

Every number below was measured on one machine (see [Reference machine](#7-reference-machine)):
§1–§5 on 2026-08-15 against llama.cpp release b10441, §6 on 2026-08-16 against the LM
Studio install on that same machine. Nothing here is an estimate unless it is explicitly
labelled as one — where the text compares a prediction to reality, the prediction is
Darhai's own `speedTps` and the reality is llama-server's `predicted_per_second`.

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

### Who gets offered what

`selectBackend` (`backendPolicy.ts`) answers two questions, not one:

| field           | means                      | example: host with Ollama only |
| --------------- | -------------------------- | ------------------------------ |
| `viable`        | can serve **now**          | `['ollama']`                   |
| `chosen`        | most capable of those      | `'ollama'`                     |
| `provisionable` | Darhai could make it serve | `['llama-server']`             |

The split exists because "is it installed" is the wrong question for the one backend
that ships inside the app. Building the whole choice list from `viable` meant a machine
with Ollama on it got `viable: ['ollama']` — llama.cpp was not in the dropdown, and
`chosen` was not `'none'`, which is the only value that opens the pre-download
disclosure. That machine had **no route at all** to Darhai's own runtime.

The row now offers `viable ∪ provisionable`, and picking a provisionable backend runs
the same disclosure a bare machine gets, so nothing is fetched before the user says yes.
A machine with nothing installed is deliberately unchanged: `viable` is still `[]`, so it
still sees no chooser and is never shown the words "llama.cpp".

`provisionable` is gated on `isLlamaServerProvisionable(platform, arch)` — the same
coarse win32/darwin/linux × x64/arm64 test `planLlamaAssets` applies before it touches
the network. Whether a given release ships the asset is still a network question, and
the plan call answers it honestly ("no build for this machine").

The same two lists carry LM Studio, with a different verb: `viable` when its server is
answering, `provisionable` when only the app is present. The act behind a provisionable
entry is per backend — a download for llama.cpp, a request to the user for LM Studio —
which is §6. Ranking is **vllm > ollama > lm-studio > llama-server**, and the order
decides only the default; every entry is offered.

### One backend, five places

`CookbookBackend` is a union declared in `src/common/types/cookbook.ts`, but adding a
member to it is not one edit. It obliges five more, and `tsc` catches exactly **one**:

| downstream site                             | needs                         | who catches a miss                        |
| ------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `BACKEND_LABEL_KEY` (CookbookServeControls) | an i18n **key**               | **tsc** — it is a `Record` over the union |
| 13 × `modelAdvisor.json`                    | the **string** that key names | the guard test                            |
| `selectBackend` (backendPolicy)             | a branch that emits it        | the guard test                            |
| `CookbookServeService.serve`                | a dispatch branch             | the guard test                            |
| `VALID_BACKENDS` (cookbookBridge)           | acceptance over IPC           | **construction**                          |

A backend added to the union and the label map alone compiles, lints and passes every
pre-existing test, while:

- rendering `modelAdvisor.cookbook.backend.<name>` as literal screen text in all 13
  languages (i18next falls back to the key, so a missing string looks like a label);
- appearing in no host's chooser, because `selectBackend` never emits it;
- falling off the end of `serve()` into the "copy this shell command" path meant for a
  machine with **no** backend at all; and
- having the IPC validator rewrite the user's explicit pick to `undefined`, which
  `serve()` reads as "no override", so the hardware default is served instead.

None of those four raises an error anywhere.

The last one is now closed by **construction** rather than by an assertion, which is
stronger: `VALID_BACKENDS` is `new Set(COOKBOOK_BACKENDS)` instead of a second literal
list, and `SERVEABLE_COOKBOOK_BACKENDS` is the union minus `'none'` instead of a third.
The other three cannot be expressed in the type system at all, so they are measured over
the runtime array in `tests/unit/cookbook/backendSurfaceCoverage.dom.test.tsx`. That is
the same shape `LLAMA_RUNTIME_FALLBACK_CODES` uses (§3), for the same reason: a union is
invisible at runtime, so only a runtime array can be iterated — and a test that hard-codes
its own copy of the list drifts the moment someone adds a backend, which is the bug.

MEASURED by mutation, three ways — every one restored afterwards:

| mutation                                                  | result                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| add a fake `'mlx'` member to `COOKBOOK_BACKENDS`          | **16 tests fail** (13 locales + label map + key-name check + reachability), and `tsc` fails at `BACKEND_LABEL_KEY` |
| delete `cookbook.backend.lmStudio` from `mn-MN` only      | **2 tests fail**, naming `mn-MN modelAdvisor.cookbook.backend.lmStudio`                                            |
| delete the `chosen === 'lm-studio'` branch from `serve()` | **1 test fails**: `serve(override=lm-studio) fell through: expected 'none' to be 'lm-studio'`                      |

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

### What the extractor refuses

The archive names the files it writes, so `src/process/services/llamacpp/archiveEntry.ts`
is the boundary. The sha256 check in step 3 is not a second opinion here: the digest comes
from the same GitHub API that served the bytes, so a compromised release or a MITM'd
download supplies both. Three rules, all enforced before anything is opened for writing:

| Rule                                            | Refuses                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| An entry may not be **placed** outside the root | `../../../.bashrc`, `C:\Windows\…`, `//server/…` |
| A link may not **point** outside the root       | `libllama.dylib -> /etc/passwd`, `-> ../secret`  |
| No member may be placed **under** a link        | `d -> .` plus `d/x -> ../victim`                 |

Placement was always checked; the other two were added after a review built a tarball with
a directory symlink escaping the staging tree and a hard link written through it, and got a
real regular file created outside the destination with the extraction reporting success.
The placement check cannot see that on its own — it is lexical, and `d/.profile` still
looks inside. The third rule exists because two individually-contained links compose: `.`
is the root and `../victim` normalises to `victim`, yet on disk `d` **is** the root, so
`d/x` lands at the root and its `..` leaves the tree. Refusing to place anything under a
link removes the precondition instead of the instance.

The rule is _inside the root_, not _no `..`_: llama.cpp's own chains are relative
(`libggml.dylib -> libggml.0.dylib -> libggml.0.20.0.dylib`), and a link that climbs out of
a subdirectory back into the tree still works.

MEASURED that this costs the real archives nothing — same four release archives, extracted
before and after the checks, every file sha256'd against a libarchive extraction of the
same archive:

| Archive                                  | Members declared                 | Written              | Tree sha256 before → after |
| ---------------------------------------- | -------------------------------- | -------------------- | -------------------------- |
| `llama-b10441-bin-macos-arm64.tar.gz`    | 62 (43 files + 18 links + 1 dir) | 61, 18 real symlinks | `91eb3b42…` unchanged      |
| `llama-b10441-bin-ubuntu-x64.tar.gz`     | 63 (52 files + 10 links + 1 dir) | 62, 10 real symlinks | `197463b8…` unchanged      |
| `llama-b10441-bin-win-cpu-x64.zip`       | 51                               | 51                   | `ea1da47e…` unchanged      |
| `llama-b10441-bin-win-cuda-13.3-x64.zip` | 52                               | 52                   | `3bfec497…` unchanged      |

A zero-length zip member is also legal and now extracts. It used to abort the whole
install: the reader asks for the byte range `[start, start - 1]`, and Node rejects that
with a raw `ERR_OUT_OF_RANGE` before opening anything, so one empty file (a placeholder, an
empty `LICENSE` stub) anywhere in a release zip would fail every Windows install of that
release with a message about `"start"`. None of the four archives above contains one today
— measured, 0 zero-byte members — so this was latent, not live.

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
as `gpu_driver`, and `assetMap` checks it against `CUDA_MIN_DRIVER` before choosing a line.
Below every floor it falls back to CPU with `CUDA_DRIVER_TOO_OLD` rather than downloading a
build that cannot load. An empty string means _not measured_ and is never treated as a
version — in that case it offers the newest line, which is the pre-existing behaviour, not
a silent downgrade.

The floors are the versions NVIDIA publishes, whole, and compared whole — not their integer
part. From Table 3 of the CUDA Toolkit release notes (re-read 2026-08-15):

| CUDA line | Linux x86_64 | Windows                                         |
| --------- | ------------ | ----------------------------------------------- |
| 12.0 GA   | `525.60.13`  | `527.41`                                        |
| 13.0 GA   | `580.65.06`  | `N/A` — driver unbundled, Linux minimum applies |

Keyed by CUDA _major_ on purpose: minor version compatibility means a binary built against
12.4 runs on any driver meeting the **12.0** floor, so 12.4's own `550.54.14` is not the
number to test. What was wrong was the comparison, not the keying — the table used to store
`{'12': 525}` and test `driverMajor >= 525`, which admits every Windows driver from 525.00
to 527.40. Those are r525-branch drivers the file's own comment already cited as below the
floor, and they were handed a CUDA 12 build that cannot initialise: `Available devices:
(none)`, exit 0, CPU — one branch below the case the floor was added to catch.

The reference machine reports driver **610.62**, so it clears the 13.x floor and gets
`cuda-13.3`.

### `latest` can name a release whose assets have not uploaded yet

A GitHub release is created **before** its archives exist. **Measured** on the live API
(`GET /repos/ggml-org/llama.cpp/releases?per_page=6`, 2026-08-15) — b10442 was created at
14:58:24Z and its 26 assets landed one at a time afterwards:

```
+15 s  cudart-llama-bin-win-cuda-12.4-x64.zip   <- first asset of the release
+37 s  llama-b10442-bin-macos-arm64.tar.gz
+51 s  llama-b10442-bin-ubuntu-x64.tar.gz
+53 s  llama-b10442-bin-win-cpu-x64.zip
+64 s  llama-b10442-bin-win-cuda-13.3-x64.zip
+92 s  llama-b10442-xcframework.zip             <- last asset
```

The five releases before it took **88–134 s** for the same upload, and six releases were
published inside 19.5 h. Observed directly: at 15:0x the same `plan()` call answered

```json
{ "kind": "unsupported", "reason": "llama.cpp release b10442 ships no build for win32/x64
  (expected asset \"llama-b10442-bin-win-cpu-x64.zip\")" }
```

and three minutes later returned `ok`. `LLAMACPP_UNSUPPORTED` is terminal in the UI — no
retry is offered — so a 90-second upload window was presenting as "your computer cannot run
local models at all".

`LlamaCppProvisioner.plan()` now distinguishes the two kinds of "no build": `cause:
'platform' | 'arch'` are permanent facts about the machine, `cause: 'asset-missing'` is a
fact about one release. Only the last one walks back, taking the newest of the recent
releases that does ship a build for this machine (one extra API request, and only in that
case). An explicitly pinned `tag` is never walked back, and when no recent release has the
asset either, the honest `unsupported` stands.

`hasCudaRuntime()` searches `CUDA_PATH\bin` and `System32` — and deliberately **not**
`PATH`. It used to, and on the reference machine it returned `true` because a
_third-party_ directory (`C:\claude\llamacpp`, a hand-installed llama.cpp) was on `PATH`
with its own cudart copies: the 373 MB archive was skipped, and deleting that unrelated
directory later would silently lose the GPU exactly as measured above. A directory Darhai
does not own says nothing durable about the machine, so the probe now reads only the two
locations the runtime is installed to by its owners. Erring this way costs at most a
re-download of an archive the machine already had; erring the old way cost the GPU.

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
binary path and passes `--n-gpu-layers auto` when the build offers it, so llama.cpp
measures **free** VRAM and fits the layers itself. `ngpuLayersForVram()` survives only as
the fallback for builds whose help text does not list `auto` — which is why the probe
reads the flag's own help entry structurally rather than grepping the whole text for the
word.

**The probe does not block the main process, and its cost is a cold cost.** An earlier
version of this section quoted 261 ms; that was a warm re-run, and the run that actually
happens is by construction the cold one — the first serve after the provisioner writes
~670 MB of new files. Re-measured against the managed b10441 with the shipped
`execFile`-based probe, counting 1 ms timer ticks that fire _during_ the call:

| probe                    | wall time | stdout   | event-loop ticks during the call |
| ------------------------ | --------- | -------- | -------------------------------- |
| async, cold              | 1,504 ms  | 57,162 B | 102                              |
| async, warm              | 223 ms    | 57,162 B | 21                               |
| `execFileSync` (pre-fix) | 225 ms    | 57,162 B | **0**                            |

Zero ticks is the defect: `execFileSync` parked the Electron main process — no IPC, no
repaint — for the whole probe, and the ceiling it allowed was 15 s, which is reachable
when a Windows AV real-time scan holds a just-extracted tree. The probe result is only
needed to build argv, and that path is already async, so blocking was a choice.

**A failed probe is no longer cached.** `defaultProbeHelpText` used to turn every failure
— timeout, `EACCES`, `EBUSY`, non-zero exit — into `''`, which `parseServerCapabilities`
reads as a measured `{autoGpuLayers: false, corsOrigins: false}`; that answer was then
memoised for the app session. One unlucky first serve therefore reverted **both** fixes
below (the 41% throughput loss and the CORS exposure) for every later serve, silently.
The probe now rejects on failure, an empty dump counts as a failure, only a measured
answer is cached, and the failure is logged.

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

## 6. The backend Darhai does not own: LM Studio

Everything above is a runtime Darhai fetches, spawns, flags and kills. LM Studio is none
of those. It is a GUI application the user opened, holding weights the user chose, serving
an OpenAI-compatible `/v1` on a port the user can change, in a process Darhai must never
touch. Serving through it is a **registration**, not a launch.

That difference is the whole design, and it starts one level earlier than the serve path:
"is it installed" — the single question that answers ollama, vLLM and llama-server — is
not enough to describe an LM Studio host.

### Two facts, not one

```
  INSTALLED   the `lms` CLI is on this machine       ->  Darhai can say "start it"
  SERVING     something is answering LM Studio's     ->  a model can be reached
              own REST API on loopback right now         without touching anything
```

A host with LM Studio installed and its server off is **not** the same host as one with no
LM Studio at all, and the UI has to tell them apart: the first can be asked to start it,
the second can only be told to install it. Collapsing both into one boolean would force a
choice between never offering an installed-but-idle LM Studio and claiming a dead endpoint
is usable. So `BackendAvailability` carries `lmStudioServing` and `lmStudioInstalled`
separately, `selectBackend` maps SERVING onto `viable` and INSTALLED-but-not-SERVING onto
`provisionable`, and neither is derived from the other — a portable copy of LM Studio the
CLI search cannot see is still completely usable when its server is up.

**Measured** on the reference machine (2026-08-16), through the repo's own code:

```
resolveOnPath("lms")     -> null
resolveOnPath("lms.exe") -> C:\Users\serge\.lmstudio\bin\lms.exe
detectAvailability()     -> {"ollama":true,"llamaServer":true,"vllm":false,
                             "lmStudioServing":true,"lmStudioInstalled":true}
```

The first two lines are why `LM_STUDIO_CLI_BINARIES` holds both spellings.
`~/.lmstudio/bin` **was** on this user's `PATH` and the extensionless name still missed,
because that directory contains exactly one file — `lms.exe`, 120,749,240 B. Probing one
name would have reported "not installed" on a machine that has it. The home-directory
candidates exist for the opposite machine: LM Studio only puts `lms` on `PATH` when the
user runs `lms bootstrap`, so "not on `PATH`" says nothing at all.

### Why the probe is HTTP and not the CLI

`lms` can answer both questions on its own — `lms server status --json` returned
`{"running":true,"port":1234}` — and it is still the wrong instrument. Measured,
alternating cold and warm:

| probe                                   | cost                                             |
| --------------------------------------- | ------------------------------------------------ |
| `GET /api/v0/models` (what Darhai uses) | **39.3 ms** cold, then 4.0 / 2.6 / 11.8 / 7.9 ms |
| `lms server status`                     | 530.2 ms, then 379.5 ms                          |
| `lms ps`                                | 449.3 ms, then 411.5 ms                          |

Warm against warm that is **~65×**, and every CLI run pays it again: an invocation is that
115 MB binary starting up, while the HTTP probe is one loopback request. The HTTP probe
also answers a question the CLI does not — **what** LM Studio is holding — in the same
round trip, which is why `probeLmStudioServer` returns `serving` and the model list
together rather than making the caller ask twice.

The cost that actually needed bounding is the machine **without** LM Studio, because that
machine must not pay for a feature it is not using. It does not:

| host                            | `detectAvailability()`                       |
| ------------------------------- | -------------------------------------------- |
| LM Studio installed and serving | 33.7 / 30.6 / 31.7 ms                        |
| nothing installed, port closed  | 24.4 ms first, then 1.5 / 1.0 / 1.0 / 1.0 ms |

A `fetch` to a closed loopback port rejects with `ECONNREFUSED` in **0.7–2.3 ms** (five
runs). The 1500 ms timeout in `defaultFetchLmStudioModels` is there for a hung socket, not
for the common case — nothing on a bare host waits for it.

### The one question that IS the CLI's: the port

The HTTP probe can only knock on a port it was told about, and the port is a user setting.
The CLI is the instrument that reports it, and it does so in **both** server states —
measured (2026-08-17), exit 0 each time:

```
server up                             ->  {"running":true,"port":1234}     313.8 / 329.1 ms
server stopped                        ->  {"running":false,"port":1234}    416.3 ms
after `lms server start --port 12399` ->  {"running":true,"port":12399}
```

The `port` field is the **configured** port, present even while nothing listens on it —
which is exactly right for the probe, whose job is to find out whether anything does. With
the server moved to 12399, `/api/v0/models` answered 8 models there while 1234 **refused**;
that host is the one a probe pinned to 1234 misreports as "no LM Studio".

So `detectLmStudioPort` runs `lms server status --json` **only when the CLI was found**,
once per availability read, and every failure — no CLI, non-zero exit, timeout,
unparseable stdout — falls back to 1234, the exact behaviour the module had before the
port was read at all. The ~300–420 ms status cost lands solely on machines that HAVE LM
Studio; the bare host keeps its measured ~1 ms refusal. The result is never cached across
reads, because the user can move the port mid-session, and a session-long cache would
re-create the very defect this closes.

### Why LM Studio's own endpoint, and not the `/v1` shim

Both are up on 1234. They are not interchangeable, for two independent reasons.

**The shim cannot carry the answer.** Measured against the same eight models:

| endpoint         | fields per model                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/models`     | `id`, `object`, `owned_by`                                                                                                       |
| `/api/v0/models` | `id`, `object`, `type`, `publisher`, `arch`, `compatibility_type`, `quantization`, `state`, `max_context_length`, `capabilities` |

One entry, verbatim:

```json
{
  "id": "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive",
  "object": "model",
  "type": "vlm",
  "publisher": "HauhauCS",
  "arch": "qwen35moe",
  "compatibility_type": "gguf",
  "quantization": "Q4_K_M",
  "state": "not-loaded",
  "max_context_length": 262144,
  "capabilities": ["tool_use"]
}
```

`type` is what keeps an embeddings model from being registered as a chat model — the
reference install holds one (`text-embedding-nomic-embed-text-v1.5`), and the `/v1` shim
lists it beside the seven chat models with nothing to tell them apart. The eight break
down as **4 `vlm`, 3 `llm`, 1 `embeddings`**; `lms ls` reports the same eight as
**93.48 GB on disk**.

**A 200 on `/v1/models` identifies nothing.** Any OpenAI-compatible process that happened
to bind 1234 answers it, and Darhai would report "LM Studio is available" about something
else entirely. `/api/v0/` is LM Studio's alone, so a well-formed answer from it is the
identification. `probeLmStudioServer` requires **both** a reachable endpoint and a `data`
array, so a captive portal returning 200-with-HTML does not read as LM Studio; an empty
`data` array is still `serving: true`, because a running LM Studio with nothing downloaded
is up but not useful, and those are different sentences for the caller to say.

### `state` is a snapshot of memory, and it moves

This is the field most likely to be misread. `state` is `"loaded"` or `"not-loaded"`, and
it describes **memory right now**, not the model list — which is a disk inventory either
way. Measured, at the moment of the reading:

```
/api/v0/models  ->  8 models, by state: {"not-loaded": 8}
lms ps          ->  "No models are currently loaded."
```

Eight models, 93.48 GB on disk, none in memory. So "the models LM Studio has" and "the
models LM Studio has loaded" are different sets, and a `/v1/models` listing — which is
what a naive integration would read — cannot express the second one at all.

Darhai treats `state` as a **latency hint and never a gate**: a not-loaded model is not
excluded, it is only ranked below an equally-matching loaded one. That is correct because
LM Studio loads on first request — `justInTimeModelLoading: true`, read from
`~/.lmstudio/.internal/http-server-config.json` on the reference install. It also means
`lms load` is never run: loading a 20B evicts whatever the user has in memory and takes
minutes, and if the user never sends a message, nothing was ever loaded.

### How it differs from ollama, and from Darhai's own llama.cpp

|                                    | Darhai's llama.cpp                          | ollama                      | LM Studio                          |
| ---------------------------------- | ------------------------------------------- | --------------------------- | ---------------------------------- |
| who installs it                    | **Darhai** (§1)                             | the user                    | the user                           |
| who starts the server              | Darhai (`spawn`)                            | a background service        | **a person, in a GUI**             |
| who stops it                       | Darhai, incl. on quit                       | the service manager         | **the person**                     |
| can Darhai fetch a chosen model    | yes (GGUF, §4)                              | yes (`ollama pull hf.co/…`) | **no — it serves what it holds**   |
| serve cost for a catalog model     | download + spawn                            | `pull` + register           | **register only, 0 bytes**         |
| port                               | ephemeral, allocated per serve              | 11434                       | 1234 by default, **user-settable** |
| bind address (measured, `netstat`) | `127.0.0.1` (`--host`)                      | `127.0.0.1:11434`           | **`0.0.0.0:1234`**                 |
| CORS (measured)                    | `*` by default → pinned to `localhost` (§5) | n/a                         | none sent (`cors: false`)          |
| API key                            | none, deliberately (§5)                     | none                        | none                               |

Two rows deserve the argument behind them.

**LM Studio is ranked below ollama, and above llama-server.** Below ollama for one
concrete reason: this selector serves a model the user picked from Darhai's catalog, and
ollama can go and _get_ that model. LM Studio serves what it already holds, so defaulting
to it would mean defaulting to a backend that may not have the chosen model at all — and
`matchLmStudioModel` correctly refuses rather than serving a lookalike. A second reason
points the same way: ollama runs as a background service, LM Studio's server lives inside
a GUI app, and a default should be the choice most likely to still answer in an hour.
Above llama-server because a server already answering beats one Darhai must download a
GGUF for and spawn.

**The bind address is measured, and it is not loopback.** Side by side on the reference
machine:

```
TCP    0.0.0.0:1234       LISTENING    10344      <- LM Studio
TCP    127.0.0.1:11434    LISTENING    11344      <- ollama
```

`~/.lmstudio/.internal/http-server-config.json` says why: `"networkInterface": "0.0.0.0"`.

Darhai _connects_ to `127.0.0.1:1234` (`LM_STUDIO_HOST` is loopback, and both URL guards
let that through on purpose — `assertSafeBaseUrl` in `modelBridge.ts` is a narrow
deny-list that rejects `169.254.0.0/16` and non-http schemes while deliberately keeping
loopback and RFC-1918 usable, and its comment names LM Studio on `127.0.0.1:1234` by way
of example; `isLocalHost` in `urlValidation.ts` is what permits an empty API key for a
local host at all). But connecting to loopback does not make the LISTENER loopback-only.
§5 makes the point that binding `127.0.0.1` does not contain a browser; this is the other
half of the same lesson: Darhai can pin its **own** server's host and CORS, and it can pin
neither on a process it does not own. What it _can_ do is not misrepresent it, and today
it says nothing at all — see §8.

The one piece of good news here is measured too. With `"cors": false`, a `GET` carrying
`Origin: https://evil.example` came back **200 with no `Access-Control-Allow-Origin` and
no `Access-Control-Allow-Credentials` header at all**, so a browser cannot read the
response cross-origin. That is LM Studio's setting, not Darhai's, and the user can flip it.

### What "provisionable" means when Darhai cannot start it

For llama.cpp, a provisionable backend means a download Darhai performs after consent. For
LM Studio it means something Darhai deliberately does **not** do.

`resolveLmStudioCli()` finds the absolute path of `lms`, and that path is used for exactly
two things: reporting `lmStudioInstalled`, and asking `lms server status --json` for the
configured port before the probe (see above). Both are reads. Nothing in the app changes
LM Studio's state through it — `lms server start` appears in this repo only in comments. Starting a user's GUI application's server without
being asked is not provisioning, it is a surprise — so the offer is a sentence and a
button that re-checks:

> LM Studio is installed on this computer, but its local server is not running. Start it
> in LM Studio, then press Continue.

Pressing Continue re-probes and branches into one of three states, each of which says a
different true thing — `off` (not asked yet), `stillOff` (asked, still silent), and
`checkFailed` (the probe itself failed, so "still off" would be a claim about LM Studio
that was never measured). The state is re-read at serve time as well, not remembered: the
dropdown was built when `lmStudioServing` was true, and the user can quit LM Studio
between then and pressing Serve, so the probe inside `serveViaLmStudio` is the one that
decides.

Serving stops any server **Darhai** spawned first, which reaps only its own child and
never LM Studio; without that a llama-server would keep the GPU while the single
`cookbook-local` provider had moved away from it.

---

## 7. Reference machine

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

## 8. What is not handled yet

Each item below was observed, not anticipated. Items that _were_ fixed are recorded in
§1–§6 above with their measurements; what follows is only what is still open.

### LM Studio

**Darhai says nothing about the `0.0.0.0` bind.** Measured in §6: LM Studio listens on all
interfaces on the reference install (`"networkInterface": "0.0.0.0"`, confirmed by
`netstat`), while ollama listens on `127.0.0.1`. Darhai registers it as a keyless loopback
provider, which is true of the CONNECTION it makes and not of the LISTENER it connects to,
and the UI draws no distinction between the two. Darhai cannot fix the bind — it does not
own the process — but the honest options are open: read `networkInterface` from
`~/.lmstudio/.internal/http-server-config.json` the same way the port could be read, and
say so once, or say nothing and be silently less safe than the sentence implies. The
mitigating measurement is that `"cors": false` means a browser cannot read the response
cross-origin; a LAN peer is not a browser and is unaffected by that.

**The registered `baseUrl` is still pinned to 1234.** Detection is not, anymore: the
availability probe asks `lms server status --json` for the configured port first (§6), so
a moved server is now correctly reported as viable. But `serveViaLmStudio` still re-probes
and registers against `LM_STUDIO_BASE_URL` — the 1234 constant — so on a moved-port host
the dropdown now honestly offers LM Studio and pressing Serve then fails with "not
answering", about a server that IS answering one port over. The failure moved closer to
the truth (the backend appears, and the serve-time message invites a re-check) but the
remaining half of the fix is threading the detected port through `BackendAvailability`
into the registration site, so the serve path aims where detection already looked.

**Nothing re-probes while a serve is live.** `serveViaLmStudio` re-reads the state at the
moment of serving — which closes the "dropdown said yes, user quit the app" window — but
after that the provider stays registered against `127.0.0.1:1234` for the rest of the
session. Quitting LM Studio mid-conversation leaves a registered provider pointing at a
closed port, and the first symptom is a failed request rather than a status change. Darhai
does not own that lifecycle, so it cannot prevent it; it could notice.

**A not-loaded model's first message pays for the load, unannounced.** Measured in §6: all
eight models on the reference install were `not-loaded`. `justInTimeModelLoading: true`
means the weights arrive on the first request, so the first message after a serve sits for
the length of a model load — the largest single model on that install is 22.07 GB
(`lms ls`), and the loading is LM Studio's, un-instrumented from here. Darhai reads
`state` and uses it to rank, but never surfaces it, so the UI reports `ready` for a model
that will make the user wait. Not a defect in the choice — preferring the loaded one is
right, and refusing the unloaded one would be wrong — a defect in what is said about it.

**`type` is the only capability that is read.** `capabilities` (e.g. `["tool_use"]`) and
`max_context_length` (262,144 on one measured entry) cross the parse and are then dropped.
An agent that needs tool use has no way to know whether the LM Studio model it was pointed
at supports it, and the context window Darhai reasons about is the catalog's, not the one
LM Studio will actually enforce.

### llama.cpp

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

**`cancel()` is still a no-op during the release lookup.** The metadata fetch itself is
no longer unbounded — `releaseClient.getJson` aborts after 15 s
(`RELEASE_FETCH_TIMEOUT_MS`, ~25× the measured 595 ms healthy fetch) and surfaces the
typed `LLAMACPP_OFFLINE` — but the provisioner's own `AbortController` still does not
exist until after the release lookup, so during that window the UI's "this step cannot
be stopped yet" remains the honest sentence. The spinner is now bounded by the deadline
rather than by the network's patience.

**A resumed session under-reports what is already downloaded.** `status()` reads
`versions/` and never `downloads/*.part`, so after a cancel or an app close mid-download
the state is `missing` and pressing Serve re-discloses the FULL size — even though
`fetchAsset` will resume from those bytes. The disclosure is pessimistic, not wrong, but
it misrepresents the remaining cost.

**The upload-window walk-back only covers a MISSING PLATFORM build, not a missing
accelerated one.** Measured on b10442 above: `llama-b10442-bin-win-cpu-x64.zip` lands at
+53 s but `llama-b10442-bin-win-cuda-13.3-x64.zip` only at +64 s. A Windows NVIDIA machine
resolving in that 11-second gap gets an `ok` plan — the CPU build, with
`NO_GPU_BUILD_FOR_TARGET` — which reads as a permanent statement about the release and is
not. Detecting it needs a comparison against an older release, and doing that on every
degraded plan would cost a second API request for **every** Linux NVIDIA/AMD machine (which
legitimately has no GPU build in any release) on **every** press, against an unauthenticated
limit of 60/hour. So the cheap, wrong-in-one-direction answer stands for now: the user is
offered a working CPU install of the newest release rather than a GPU install of the one
before it. A per-machine "did the previous release ship better?" check, cached for the
session, would close it.

**One outstanding disclosure is re-stated within a day, and only a day.** `plan()`
re-states the resolution it is already holding instead of resolving again, which is what
stops row A's card and row B's card from disagreeing (see
`LlamaRuntimeController.disclosed`). The slot now carries a timestamp: a disclosure older
than 24 h (`DISCLOSURE_TTL_MS`) reads as never-disclosed, so both `plan()` and `install()`
resolve afresh rather than offer or fetch yesterday's tag. A SHORT expiry would re-open
the "confirm A, install B" hole the stable slot closes — two presses seconds apart must
keep getting one answer — and 24 h never fires inside a sitting, while a stale slot is
dropped, never silently installed. Keying the disclosure to the row that asked would
close the remaining day-wide window, but needs a payload on `llamaRuntime.plan` /
`llamaRuntime.install`; both verbs take `void` today, and that is itself a security
property of this remote-denied namespace.

**The multi-asset fields cross IPC and are never rendered.** Progress itself is now
throttled — inside one phase of one asset at most one event per 100 ms
(`PROGRESS_EMIT_INTERVAL_MS`); phase and asset boundaries and the final 100% of a sized
transfer always emit — but `assetName` / `assetIndex` / `assetCount` still go unrendered,
so a two-archive CUDA install (147 MB + 373 MB) shows one merged bar and never says there
are two.

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

**Only one serve at a time, and no crash recovery.** An MVP default, not a hardware limit:
`start()` stops any running server first, and there is no watchdog restart if
`llama-server` dies mid-session. A second Serve pressed while the first model is still
_loading_ is now queued rather than dropped — it used to be handed back the first
server's promise, so it resolved with the first server's port while the caller registered
a provider under the second model's name. Measured against the real b10441 and the real
GGUFs, pressing Serve on Qwen2.5-7B and then on Qwen2.5-0.5B one second later:

```
before: 1 spawn  | 7B port 61699, 0.5B port 61699 | /v1/models at the 0.5B's port -> …7B-Instruct.gguf
after:  2 spawns | 7B port 50606, 0.5B port 61657 | /v1/models at the 0.5B's port -> …0.5B-Instruct.gguf
```

**Nothing measures the host before choosing a quant.** The advisor ranks against
`gpuVramGb` (8), not against free VRAM (6.9 GB here, and lower with a browser open). A
model marked `fitLevel: perfect` can still land in offload on a busy desktop.

---

## Related

- [Architecture overview](overview.md) — process model and IPC boundary
- `src/process/services/llamacpp/` — provisioner, asset mapper, install layout
- `src/process/services/hwfit/` — hardware probe, catalog, fit scoring
- `src/process/services/cookbook/` — GGUF download, serve lifecycle, provider registration
- `src/process/services/cookbook/lmStudioDetect.ts` — the two LM Studio facts (§6) and the
  endpoints they are read from
- `src/common/types/cookbook.ts` — `COOKBOOK_BACKENDS`, the runtime array the union and
  every coverage check are derived from (§1)
- `tests/unit/cookbook/backendSurfaceCoverage.dom.test.tsx` — the guard that fails when a
  backend is added to one of the five sites and forgotten in another
