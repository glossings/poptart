# Compiled devices

The devices in `src/devices` are poptart's own, written in JavaScript and bundled by
`build/bundle-worklets.mjs`. This folder is for the other half of the catalog: DSP from other
projects, compiled to WebAssembly and wrapped as worklets.

`sources.json` is the list, with each entry's license and what still has to be checked about it,
and it is the file to edit when that changes — the build script, the credits and the planning all
read it rather than keeping their own copies.

What is built: Galactic, Cloud Seed, Shift, and the Mutable modules Plaits, Rings, Elements,
Braids and Clouds. Their binaries are committed under `public/devices`, their descriptors under
`src/devices`. Warps is built by the script and deliberately absent from the catalog — the reason
is in `src/devices/mutable.mjs`.

## Two targets, one list of recipes

`build-devices.mjs` resolves the pins, reads each device's descriptor out of its own source and
describes how to compile it. What to do with that is the target's business:

- **`build-devices.mjs`** compiles each device to its own `.wasm` for the browser.
- **`native.mjs`** compiles all of them into one scsynth extension for the desktop
  (`packages/osc-engine/native/devices/bin/PoptartDevices.scx`, universal, committed), plus the
  catalog `devices.json` the desktop engine resolves a name against. Needs a C++ compiler, not
  emscripten.

One list for both, because the sources, the include paths, the upstream switches and the shimmed
headers are the same answers either way — and a device that was compiled differently for one
engine is a device that sounds different there, with nothing to point at.

`native.mjs` also builds the devices whose DSP poptart wrote - the wavetable, FM and granular
synths and the effects - which have no recipe and no upstream: their C++ is hand-written beside the UGen in
`packages/osc-engine/native/devices/own/`, and all this build does for them is generate the
header of control indexes they index their parameter block with (from the same descriptors the
browser registers, so a reordered control list cannot silently move a control) and compile them
in. They are translations of the browser's own `src/dsp` and `src/devices` rather than the same
source twice, and `osc-engine/native-device-parity.test.mjs` is what keeps the two honest: both
are played the same input and the output is compared sample for sample.

The convolver is in that list with an asterisk: in the browser it is a `ConvolverNode`, so there
is no JavaScript of ours to translate and none to compare against. Its C++ is written to
Chromium's behavior instead, with Blink's own files cited where each piece came from, and the
test holds it to definitions rather than to a second implementation - the convolution against a
direct sum over its taps, and the gain a normalized response is given against the closed form of
Blink's formula. The five synthesized spaces are poptart's JavaScript, and those ARE compared
sample for sample against the browser's own function.

The one thing that differs is where a PORTED device keeps its state. The generated wrapper holds it in
file-scope globals, which is right for a worklet (one module instance per node) and allows one
instance per process, which is wrong for a server where every track may want a Plaits. The native
target lifts that state into a struct — `structify`, which moves no DSP: every `g_params` in the
bodies becomes the member of the same name. The WebAssembly target compiles the wrapper exactly
as it always did, so the committed `.wasm` binaries stay reproducible from the same templates.

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

## Building

    EMSDK=/path/to/emsdk node build/devices/build-devices.mjs    # the .wasm for the browser
    node build/devices/native.mjs                                # the .scx for the desktop

Emscripten for the first, a C++ compiler for the second; both fetch the pinned upstream sources
the first time and cache them under `.pack-cache/devices`. `--only <Device>` narrows either one
to a single device while working on it (the native build then leaves the catalog alone, since a
catalog naming one device would take the rest off the desktop), and `--plan-only` / `--emit-only`
resolve and read without compiling.

For the Faust sources still on the list, `@grame/faustwasm` from npm runs in Node and needs no
native toolchain at all; its UI JSON gives the descriptor away for free.
