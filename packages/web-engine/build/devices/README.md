# Compiled devices

The devices in `src/devices` are poptart's own, written in JavaScript and bundled by
`build/bundle-worklets.mjs`. This folder is for the other half of the catalog: DSP from other
projects, compiled to WebAssembly and wrapped as worklets.

Nothing here is built yet. `sources.json` is the list, with each entry's license and what still
has to be checked about it, and it is the file to edit when that changes — the build script, the
credits and the planning all read it rather than keeping their own copies.

## The rules

**Artifacts are committed.** A clone plus a static server has to be enough to run the web build.
Nobody should need Emscripten installed to work on the pattern language, and a first-time
contributor should not meet a toolchain before they meet the code. The build scripts and the
pinned toolchain versions live beside the artifacts so that rebuilding is possible and rare.

**One file per device.** The WebAssembly is inlined into the worklet rather than fetched beside
it, because a static host that serves `.js` correctly may not serve `.wasm` with the media type
the streaming compiler insists on, and diagnosing that from a bug report is miserable. It costs
about a third in size against the base64 encoding and buys a build that works wherever it is put.

**A license is checked before anything is compiled, not after.** `licenseVerified: false` in
`sources.json` means the license recorded there is what the project is generally understood to
use, and that nobody has read the headers of the specific files being ported. Two of these
projects have per-file or per-function licenses that differ from what the repository as a whole
suggests. The Faust standard library is the sharp one: its license is stated per function, above
each function, and several of the reverbs are GPL where the filters are not.

**Copyleft is a one-way door.** The web build is AGPL-3.0-only, so GPL-3 code can go into it.
What it cannot do afterwards is come back out: once a GPL dependency is compiled in, the build
can only ever be distributed under copyleft terms, and offering it under anything else means
removing that dependency first. Each entry in `sources.json` is marked, so the question can be
answered by reading rather than by remembering.

**A shipped device's sound is frozen.** Recompiling against a newer upstream release is a new
device version, not an update in place — see `src/registry.mjs`. Somebody's song is a recording
of how these sounded on the day it was written.

## What a device needs

Each compiled device is a small C++ shim plus a descriptor:

- the shim exposes `init(sampleRate)`, `process(inputs, outputs, frames)` and a setter per
  parameter, and nothing else. Keeping it thin is what makes the upstream code updatable.
- the descriptor is written in the same form as every other device (`src/descriptor.mjs`), with
  real units and real names. Where the upstream project already names its parameters — Airwindows
  gives every one a name and a 0..1 range, Faust emits a JSON description with units and widget
  kinds — the descriptor should be generated from that rather than transcribed.

## Building, when there is something to build

Emscripten for the C++ sources, and `@grame/faustwasm` from npm for the Faust ones, which runs in
Node and needs no native toolchain at all. Both need network access to fetch the upstream sources
the first time. The Faust half is the one to start with: it is the least work per device and its
UI JSON gives the descriptor away for free.
