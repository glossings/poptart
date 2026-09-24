# `@poptart/web-engine`

The browser half of poptart: a Web Audio implementation of the engine interface the pattern
language drives, and the catalog of built-in instruments and effects that takes the place of
plugin hosting when there is no SuperCollider and no VST to host.

`osc-engine` is the same idea for the desktop. Both satisfy the interface documented at the top
of `pattern-core/src/scheduler.mjs`, and the pattern language cannot tell them apart — which is
the point of that boundary existing.

## What is here

```
src/descriptor.mjs     what a device says about itself; the contract everything else reads
src/registry.mjs       name to device, with every version kept resolvable
src/catalog.mjs        the devices this build ships
src/panel.mjs          a device editor, as data, generated from the descriptor
src/figures.mjs        the pictures that editor draws, computed from the DSP that plays them
src/devices/           one file per device: its descriptor and its processor
src/dsp/               the synthesis, in plain modules that unit-test in node
src/engine/            the track graph, the modulators, and the engine itself
src/packs/             sample pack manifests and the ported-DSP source list
src/worklets/          thin AudioWorkletProcessor wrappers around the DSP
build/                 the worklet bundler, the pack renderer, a WAV writer
public/                the built artifacts, committed
```

## The descriptor is the contract

A VST describes itself, so the desktop host can ask it what its parameters are called. In the
browser there is nobody to ask, so every device ships a descriptor instead, and that one object
is what `synth("Wavetable")` resolves, what `.param("Cutoff", 2000)` looks a name up in, what the
params panel draws, and what a later SuperCollider mirror of a web device would have to match.

**A parameter takes a position, 0..1**, exactly as a plugin parameter does. That is the rule
the whole language is built on - an `lfo()` runs 0..1, a macro is 0..1, a MIDI control is 0..1 -
so any modulator points at any control without a `.range()`. The descriptor says what the
position means: `min`, `max` and `curve` turn it into the Hz, seconds or semitones the DSP
reads and the readout prints (a cutoff sweeps by ratio, a semitone box lands on whole steps), and
that conversion happens once, on the audio thread, in `worklets/shared.mjs`. A switch takes its
option's name (`.param("Mode", "fold")`) or an index, an on/off takes 0 or 1, and a control that
loads a sample - a wavetable, an impulse response - takes the sample's name, `"pack:3"` or
`"files:table.wav"`. A saved state and a panel readout are in the real units, so a program is
readable and a knob says what it does.

Because the descriptor also says which widget a control wants, which section it sits in and
whether a signal can drive it, every device gets a usable editor window without anybody drawing
one. That is `panel.mjs`, and it returns data rather than DOM so it can be tested without a
browser.

A rack of knobs is the honest answer for a ported module and the wrong one for a synth we wrote: a
wavetable's position knob reads `0.42` where what somebody wants to know is which waveform that is,
and an envelope is four knobs saying what one curve says at a glance. So a descriptor may also
declare **figures** — named pictures, each bound to a few of its own parameters — and `figures.mjs`
computes what they show, in data, for the browser to draw. A figure may take a parameter's knob over
rather than joining it, which is how the Wavetable's envelope curve stands in for its four envelope
knobs and the FM synth's matrix for its sixty-four cells. A descriptor may also say how its window
is laid out - how wide, and which sections sit side by side - and which controls are number boxes
rather than knobs: a transposition is typed, not turned.

Every number in a figure comes out of the DSP that plays it: the response curve from coefficients
read off a real filter, the unison spread from the function the oscillator spreads with, the
waveform through the real warp, the envelope through the real curve. That is deliberate and it is
the reason the module sits here rather than in the editor — a picture computed from a second copy of
the maths goes stale the first time somebody tunes the original, and a picture that disagrees with
what you are hearing is worse than no picture at all.

## A shipped device's sound is frozen

Somebody's song is a recording of how these devices sounded on the day it was written. So an
improvement that changes what a song sounds like is registered as a **new version** beside the old
one, both stay resolvable for ever, and a song records the version it used. Retiring a version is
a decision with a cost, not a cleanup. See `registry.mjs`.

## Signals into parameters

`.param("Osc 1 Phase", audio("mod"))` connects a track or bus to a parameter at audio rate. In
Web Audio any node can drive an AudioParam, so this is a real patch cable rather than anything
poptart has to simulate — which is what makes phase modulation possible at all. A value the
scheduler polls every thirty milliseconds and ramps between is a sweep, not a modulator.

There is no separate list of modulation inputs: a parameter a signal can drive IS one. Phase
modulation is a signal on an oscillator's Phase and vibrato a signal on its Cents, and the devices
we wrote read every continuous control **per sample** when something is moving it — `voice.mjs`
says which few are read once a block and why. Cross-modulation between the sources inside the
Wavetable - linear, through-zero FM, phase modulation and ring modulation from the other
oscillator, the sub or the noise - is a mode on each oscillator's warp switch, with the warp
amount as its depth (`warp.mjs`). The ported modules take a value per block, as the hardware they
came from does, and a device with a **sidechain** - the compressor's key, the ducker's
modulator, a cross-modulator's carrier - takes it from `.audio("other")` on the effect.

`.mul()` and `.add()` on the handle become a gain and an offset in the graph. They are the only
arithmetic an audio handle accepts: there is nothing to sample, so anything else would quietly do
nothing, and saying so is better than letting somebody spend an afternoon on a modulation that
was never connected.

## Testing

`node --test`, like the rest of the repository, and the same posture: unit-test the logic, and
check what needs real audio by hand. What that means here in practice:

- **The DSP is tested by measurement, not by eye.** The oscillator's band-limiting is checked by
  rendering a note and measuring how much of its energy is inharmonic, against the naive read it
  replaces. A claim like "this does not alias" is worth nothing unless something fails when it
  does.
- **The graph is tested against a stand-in audio context** (`fake-context.mjs`), which records
  what is connected to what. That catches the bugs that are invisible by ear until a track goes
  silent mid-set: a slot rebuilt when it should have been left alone, a modulator not cleared on
  a re-evaluation, a route torn down by the wrong name.
- **The built worklets are tested as artifacts.** They are read from `public/`, run in a sandbox
  with the few globals an AudioWorkletGlobalScope provides, and driven block by block. A bundler
  bug that dropped a module would pass every other test in the package and fail there.
- **The engine is checked against the scheduler's own source** for every method it calls. The
  desktop side learned to need that the hard way: routing methods existed on the real engine, the
  scheduler called them, and the wrapper in between did not have them, so every route silently
  did nothing.

## Building

```
npm run build --workspace packages/web-engine
```

Flattens the worklets and re-renders the sample packs. Both outputs are committed, so a clone and
a static server are enough to run the web build — nobody should need a toolchain to work on the
pattern language. The tests fail if a committed bundle is out of date with its source.

## The sample packs that are not ours

Two kinds ship, and they are delivered differently on purpose.

`pt_kit` and `pt_keys` are rendered from the DSP above, committed here, and loaded with the page.
They are what makes a fresh load playable with no network at all, and rendering them is also what
sidesteps the licensing question entirely: these are sounds poptart made, so poptart can give
them away.

Everything else is somebody else's recording. Those are far too large to live in this repository
and are not ours to re-license, so `build/fetch-packs.mjs` assembles them into a repository of
their own — audio, a manifest per pack, and generated credits — which is then served from a CDN
and read through the index format in `src/packs/library.mjs`.

```
node build/fetch-packs.mjs --plan-only              # resolve and choose, download nothing
node build/fetch-packs.mjs --out ../../../poptart-packs
```

Every upstream reference is resolved to a commit and written to `build/packs/upstream.lock.json`,
and later runs use what is written there. That is not tidiness: a pack that changed underneath a
song is a song that no longer sounds the way it was written, and whoever wrote it would have no
way to find out what happened.

What goes in is decided by reading each project's own LICENSE file rather than its front page.
"Free", "royalty free" and "free to use in your productions" all grant permission to USE and say
nothing about permission to REDISTRIBUTE, which is what shipping a pack is; only a public domain
dedication or an attribution license clears that bar. `build/packs/upstream.mjs` is the record of
what was checked, and it is worth reading before adding anything to it.

## What this engine does not do

MIDI input, hardware audio input, sidechain injection into a device, and the channel-strip
controls beyond gain, postgain, pan, dry and the per-slot wet levels. Each warns once, names what
it dropped, and lets the rest of the track play — the same rule userland mistakes follow, and for
the same reason: a track that refuses to sound is the worse failure.

No code from any other project is compiled into this package. `build/devices/sources.json` is the
list of DSP that would change that, with each entry's license and what still has to be checked
about it, and the credits are generated from it — so a page built from this can say what it
contains without claiming code that is not there.
