# Third-Party Notices

This document records the upstream codebases that the Darhai (Дархай) desktop app
inherits from and the licenses that govern those contributions.

Darhai (Дархай) is a derivative work of **Wayland** by Ferrox Labs
(<https://github.com/FerroxLabs/wayland>), which is itself built on, and includes
substantial source code from, **AionUi**. The full chain of attribution —
Darhai → Wayland (Ferrox Labs) → AionUi — is preserved below; the sections that
follow keep the upstream notices intact. References to "Wayland" in these notices
describe the upstream project this fork derives from. This document satisfies the
attribution requirements of the Apache License, Version 2.0 for derivative works.
See [`/LICENSE`](../../LICENSE) for the license governing this repository.

The current codebase has been substantively modified from its upstreams and
constitutes a new work for copyright purposes. The notices below preserve the
original copyright statements as required by the Apache License.

## Wayland (Ferrox Labs)

The upstream Wayland desktop app is © 2026 Ferrox Labs and is
distributed under the Apache License, Version 2.0.

Wayland's Rust engine (`wayland-core`) is a separate fork of `iOfficeAI/aionrs`
maintained in its own repository under the same Apache License, Version 2.0.

## AionUi

Portions of this codebase derive from AionUi
(<https://github.com/iOfficeAI/AionUi>), an open-source chat application
originally published by AionUi.

> Copyright 2025 AionUi (aionui.com)
>
> Licensed under the Apache License, Version 2.0 (the "License"); you may not
> use this file except in compliance with the License. You may obtain a copy of
> the License at
>
> <http://www.apache.org/licenses/LICENSE-2.0>
>
> Unless required by applicable law or agreed to in writing, software
> distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
> WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
> License for the specific language governing permissions and limitations
> under the License.

## OpenClaw

The channels subsystem (`src/process/services/channels/...` and related code)
incorporates work derived from OpenClaw, licensed under the MIT License. See
the per-file headers under that subtree for original copyright statements.
