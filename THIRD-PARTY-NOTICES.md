# Third-party notices

Poptart is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
It includes work from the projects below, each under its own license, reproduced or referenced
here as that license asks. Every one is pinned: the compiled devices to the commits in
`packages/web-engine/build/devices/devices.lock.json`, the native helpers to the versions in
their build scripts under `packages/osc-engine/native/`.

## Compiled into the browser build

The devices under `packages/web-engine/public/devices/` are WebAssembly builds of the sources
below, made by `packages/web-engine/build/devices/build-devices.mjs`. Each device's descriptor
carries its license and source, and the About screen in settings prints them from the catalog.

### Mutable Instruments eurorack firmware, with stmlib

Copyright Emilie Gillet (emilie.o.gillet@gmail.com).
https://github.com/pichenettes/eurorack and https://github.com/pichenettes/stmlib

Used for Plaits, Braids, Rings, Elements and Clouds, and for the shim header
`packages/web-engine/build/devices/shim/clouds/dsp/window.h`, which is a copy of one upstream file
with its notice kept.

License: MIT, stated in the header of each source file (the repositories declare no license of
their own). Text below.

### Airwindows

Copyright Chris Johnson (airwindows.com).
https://github.com/airwindows/airwindows

Used for Galactic.

License: MIT, stated in each plugin's own source. Text below.

### Cloud Seed

Copyright Ghost Note Engineering Ltd.
https://github.com/GhostNoteAudio/CloudSeedCore

Used for CloudSeed.

License: MIT. Text below.

### Signalsmith Stretch, with Signalsmith Linear

Copyright Signalsmith Audio Ltd.
https://github.com/Signalsmith-Audio/signalsmith-stretch and
https://github.com/Signalsmith-Audio/linear

Used for Shift.

License: MIT. Text below.

### The MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Compiled into the desktop engine

The native helpers under `packages/osc-engine/native/` are built from the sources below by the
`build.sh` beside each, and the built binaries are committed.

### Rubber Band Library 4.0.0

Copyright Particular Programs Ltd.
https://breakfastquay.com/rubberband/

Used for the PoptartPitchShift scsynth extension, which is the DJ keylock.

License: GNU General Public License, version 2 or later (see [LICENSES/GPL-2.0.txt](LICENSES/GPL-2.0.txt)).
Poptart as a whole is distributed under the AGPL v3, which is compatible with it.

### Ableton Link 3.1.5

Copyright Ableton AG, Berlin.
https://github.com/Ableton/link

Used for the poptart-link helper, which is Poptart's Link peer.

License: GNU General Public License, version 2 or later (see [LICENSES/GPL-2.0.txt](LICENSES/GPL-2.0.txt)).

### asio 1.30.2

Copyright Christopher M. Kohlhoff.
https://github.com/chriskohlhoff/asio

Used by Ableton Link.

License: Boost Software License 1.0.

## Shipped sounds

The two sample packs under `packages/web-engine/public/packs/` are rendered from Poptart's own
DSP and are Poptart's own. The sourced packs the browser build can load are not in this
repository; they live in a repository of their own with their licenses beside them.
