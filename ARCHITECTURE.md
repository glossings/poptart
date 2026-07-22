# poptart — architecture

A livecoding environment with Strudel-style mini-notation, `note`/`n`/`scale`, and continuous
signals, driving real VST2/VST3 plugins — as instruments *and* as effects — over OSC, with
genuinely continuous, sample-accurate parameter modulation.

This is a self-contained implementation, not a wrapper around Strudel's own packages - see
"Pattern language" below for why.

Example target syntax (from the original brief):

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

(The original brief wrote this as `.filter1(...)` via a per-plugin alias table; aliases were
later dropped in favor of always using real VST parameter names through `.param()`, with editor
autocomplete and a params panel making those names as convenient as aliases were.)

## Why this is hard

Strudel's pattern engine is pure JS/WebAudio. It has no way to load a VST — that requires
native code outside any browser sandbox. Three ways to bridge that gap were considered:

1. **SuperCollider + Christof Ressi's `VSTPlugin` UGen, driven over OSC** (the Tidal/SuperDirt
   model). Fastest to a prototype — VST hosting and parameter automation are already solved —
   but you're scripting someone else's server process instead of owning the audio graph.
   **This is the one we're building** (see below for why the original choice changed).
2. **Script an existing DAW** (Bitwig Controller API / REAPER ReaScript) that already hosts
   the VSTs. Least new infrastructure, but automation rate and API shape are whatever that
   DAW gives you.
3. **Custom native host**: a JUCE-based audio engine, embedded as a Node native addon, hosting
   VST3/AU directly and driven in-process by the pattern engine. Full control over scheduling
   precision, at the cost of owning VST hosting/scanning robustness ourselves. **This is what was
   originally built, and later abandoned** — see "Why option 3 was abandoned" below.

### Why option 3 was abandoned

The custom JUCE host got fairly far: it hosted real plugins, its native LFOs drove genuinely
continuous parameter modulation, and after an in-process scanner segfaulted on a real plugin
("Cardinal"/"CardinalFX", a VST3 that embeds an entire VCV Rack instance and hundreds of
third-party modules), scanning was moved into a crash-isolated worker subprocess with signal
handlers, dead-man's-pedal checkpointing, and bounded retries. Even that hardened scanner then
hung/looped indefinitely on a real plugin set. That's the second time in-house VST hosting caused
a real, demonstrated failure — not a one-off bug, but a general property of VST hosting: plugins
are third-party native code with wildly inconsistent behavior on scan/load, and any host that
owns this itself is signing up to keep re-deriving crash *and* hang isolation forever. Option 1
was already on the table for exactly this reason ("VST hosting and parameter automation are
already solved") but wasn't picked initially because owning the audio graph seemed worth the
cost; the second failure changed that calculus. `VSTPlugin~` has been hardening this exact
problem for years — using it means that work is no longer ours to redo.

This also meant dropping Electron: with no more in-process native addon, there was no more
Electron-specific reason (N-API/ABI matching, sharing Electron's Cocoa run loop with JUCE's
message loop) to keep it. The editor is now a plain page served by a small Node server, opened in
any browser.

## System overview

```
┌──────────────────┐  HTTP/fetch   ┌──────────────────────────────┐  OSC (UDP)  ┌───────────────────────────┐
│ browser (any)     │◄─────────────►│ packages/web-app (Node)      │◄───────────►│ sclang (SuperCollider)     │
│  editor            │              │  serves public/ (static)     │             │  OSCdefs for /poptart/*   │
│  pattern viz/errors│              │  pattern-core                │             │  VSTPluginController      │
│  plugin browser    │              │   own mini-notation parser   │             │   (scan/open/map/set)     │
│  transport controls│              │   unified Sig (signal) model │             │  drives scsynth ──────┐   │
└────────────────────┘              │   Scheduler                  │             └────────────────────────┼───┘
                                     │   (note edges + LFO/poll)    │                                      │
                                     └───────────────┬───────────────┘                                      ▼
                                                       │ OscEngine (packages/osc-engine)          scsynth: VSTPlugin~
                                                       │ same interface Scheduler always used       per-track SynthDef,
                                                       └────────────────────────────────────────►   sample-accurate
                                                                                                      OSC-bundle scheduling,
                                                                                                      native UGen LFOs
                                                                                                            │
                                                                                                            ▼
                                                                                                  audio interface → speakers
                                                                                    (+ each plugin's own native editor
                                                                                     window, opened on demand via
                                                                                     VSTPluginController#editor)
```

`packages/web-app`'s Node server is the scheduling authority (its wall clock is what `Scheduler`
computes lookahead deadlines against, via `OscEngine#getTime()`) and spawns `sclang` as a
subprocess rather than embedding any native addon — there's no more N-API/ABI-matching or
message-loop-sharing concern that Electron+JUCE had, since the browser and the audio engine are
now separate processes talking a network protocol (loopback OSC) instead of sharing an address
space. `OscEngine` (see `packages/osc-engine/index.js`) implements the exact same engine
interface `Scheduler` was always written against — the swap from native addon to OSC adapter
required no changes to `pattern-core`'s scheduling logic, only a new adapter underneath it.

## Pattern language: one primitive, not two

An earlier draft of this package imported `@strudel/core` + `@strudel/mini` + `@strudel/tonal`
wholesale and tried to reconcile Strudel's `Pattern`/`Hap` object model (discrete note events
vs. continuous `signal()`-based patterns, distinguished by `hap.whole === undefined`) with a
separate parallel builder for LFOs. That meant two different "is this continuous?" models to
keep in sync, a generic-string-vs-mini-notation collision (see below), and pulling in a
Pattern/Hap object system this project never otherwise needs. It was scrapped in favor of
something simpler: **everything is a `Sig`** (see `src/signal.mjs`) — a plain function of
time, `(tSeconds, cps) => value`. A note sequence from mini-notation and an LFO like
`sine({rate:0.3})` are the same *kind* of thing; the only difference is whether a `Sig` also
carries known step boundaries (`stepsForCycle`), which lets the scheduler compute exact
onset/offset edges instead of just sampling. This is much closer to a modular synth's CV/gate
mental model than to Tidal's Hap algebra: a mini-notation pattern is a held (sample-and-hold)
control-voltage signal that happens to have gaps (rests) and known edges, not a fundamentally
different kind of object from an LFO.

Concretely, `pattern-core` is entirely self-contained - **no Strudel/Tidal npm packages at
all**:

- **`src/mini.mjs`** — a small hand-written mini-notation parser/interpreter covering the
  high-value subset: sequences (`"0 2 3"`), rests (`~`), brackets (`[a b]`), stacks (`[a,b]`),
  alternation (`<a b>`), fast/slow (`*`/`/`), replicate (`!`), weight (`@`), and euclidean
  rhythms (`bd(3,8)`), and per-cycle alternation rates (`a*<2 3>`). It does not (yet) support
  polymeter (`{a b, c d}`), degrade (`?`), cycle-internal rate patterns (`a*[2 3]`), or
  pattern-valued euclid arguments - these raise a clear parse error rather than silently
  misbehaving. The entry point is `getStepsForCycle(ast, cycleNumber)`,
  which returns that cycle's steps as plain `{start, end, value, loc}` objects (fractions of a
  cycle; `loc` is the atom's character range in the source string, which is what the editor's
  live playback highlighting consumes) - verified against hand-computed expectations for every
  operator during development, including the fast/slow/alternation cycle-threading math
  (slow(n) requires knowing the *absolute* cycle number to decide which 1/n slice of the inner
  pattern to show, not just a 0..1 phase). Deliberately dependency-free so the browser can
  import it directly (served under `/pattern-core/` by web-app) and compute exactly the steps
  the server plays.
- **`src/labels.mjs`** — Strudel-style pattern labels: `splitLabeledBlocks(code)` splits the
  editor buffer into blocks on column-0 `name:` / `$:` lines, with `_name:`/`name_:` marking a
  block muted and `Sname:`/`nameS:` soloing it (if anything is soloed, only soloed blocks
  play; mute wins over solo). Each block becomes its own engine track named after the label.
  Unlabeled code is one implicit anonymous block, so single-expression usage is unchanged.
  Also dependency-free and served to the browser (block boundaries scope autocomplete and
  highlighting).
- **`src/notes.mjs`** — note-name parsing (`"f#3"` → MIDI, `c5 = 60`) and a small hardcoded
  scale-interval table (major/minor/modes/pentatonics/blues/chromatic), so `.scale("F minor")`
  needs no tonal.js dependency. Scale name parsing splits on whitespace *or* colon, so both
  `"F minor"` (as in the original brief) and Tidal's own `"F:minor"` convention work.
- **`src/signal.mjs`** — the `Sig` class and the public builders: `n(...)` (scale-degree,
  numeric until `.scale()` runs), `note(...)` (explicit MIDI/note-name), `mini(...)` (generic
  string-or-number signal, used internally whenever a control is given a plain value), and the
  continuous builders `sine`/`saw`/`tri`/`square`/`ramp`/`rand` (continuous smoothed random),
  all taking `{rate, phase}` (or a bare rate number), plus `lfo(shapeString, {rate, mode})` for
  hand-drawn breakpoint shapes (see `shape.mjs` and "custom shapes" below), and the live MIDI
  builders `midicc`/`midikeys` (see "Live MIDI input" below). Stepped random is
  `rand(r).hold("1*8")` - `Sig#hold(trigPattern)` is a general sample-and-hold that samples any
  signal at the trigger pattern's onsets and holds between them. `Sig#scale(name)` maps
  degree values to MIDI via `notes.mjs`. `Sig#range/.fast/.rate/.phase` update an LFO's
  symbolic parameters directly when present (see Tier 2 below), or fall back to a generic
  value-mapping otherwise. Signals also carry arithmetic/comparison operators
  (`.add/.sub/.mul/.div/.mod/.round/.abs/.floor/.ceil/.clamp/.gte/.gt/.lte/.lt/.eq/.neq`) with
  structure-from-the-left semantics, and `.when(cond, fn)` (apply `fn` wherever `cond` is
  truthy, switching on cond's step grid). Linear ops (`mul/add/sub/div`) with a plain-number
  operand on a Tier-2 LFO/env rewrite its `min`/`max` symbolically, so it *stays* a native
  modulator; non-linear ops demote an LFO to Tier-1 polling and are an error on `env()` (whose
  value only exists engine-side). `.range()` always accepts signal-valued bounds (it's just
  `.mul(max - min).add(min)` over a unipolar 0..1 signal): on a Tier-2 LFO/env the bound
  signals stay in the IR and the scheduler polls only them, re-sending lo/hi as in-place
  updates to the running native modulator - so even `env()` and note-synced `lfo()` shapes
  take signal bounds without leaving the fast path. `Sig#gain`/`Sig#pan`/`Sig#o` are
  track-level channel-strip controls (gain 1 = unity, post-chain; pan -1..1; o = which stereo
  output pair the track plays to, 1 = channels 1/2, 2 = 3/4, wrapping past the device's last
  pair) accepting all the same value kinds - engine-side they address pseudo-slot -1, the
  track synth's own control inputs, mapped/set exactly like VST params. `Sig#as(spec)` destructures multi-field tokens
  Strudel-style - `` `<36:1:4 ~ 47:0.5:3 ~>*8`.as("note:vel:clip") `` splits each token on `:`
  and reads fields in spec order (`note` = MIDI/name, `n` = degree, `vel` = per-event velocity
  carried on the step and consumed by the scheduler's noteOn, `clip` = duration as a multiple
  of the token's own step width, so notes ring past their slot without `@` weight chains); this
  is the form midi-record emits (see `record.mjs` and "Live MIDI input" below). web-app's eval
  additionally extends `String.prototype` with these methods so `"0 0.5 1 0.3".gte(0.5)` works
  directly, Strudel-style.
- **`src/record.mjs`** — `recordingToMini(events, { cycles, grid, startCycle })`: converts a
  captured live-MIDI performance into the `` `<...>*n`.as("note:vel:clip") `` house style - one
  token per grid slot (rest, `note:vel:clip`, or a `[a:v:c,b:v:c]` stack for chords, with
  per-note velocity and duration), 8 tokens per line, rest runs collapsed via `~!k` only when
  recording unquantized (96 slots/cycle). Because `<...>*n` indexes by absolute cycle, the
  token list is rotated by `startCycle` so the loop replays on the same cycles it was recorded
  on. Self-checks its output through `parseMini` before returning.
- **`src/scheduler.mjs`** — `Scheduler`, a lookahead clock in the same spirit as
  Tidal/SuperDirt's "compute absolute deadlines slightly ahead of playback" model, just
  operating on `Sig`/plain step objects instead of Hap objects queried from a Pattern. Each
  tick extends the scheduled-until cycle boundary by a fixed lookahead, walks any newly-
  entered steps, and turns onset/offset step edges into `noteOn`/`noteOff` calls with exact
  target times. `Scheduler` only ever calls a plain engine-interface object (never touches
  `osc-engine` or SuperCollider concepts directly) — see "System overview" above.

## The hard problem: making modulation *actually* continuous

This is the part a naive Tidal-alike gets wrong, and it's the reason the brief calls out
"continuous" so emphatically: in stock Tidal/Strudel, setting a discrete pattern's parameter
from a continuous one (`.lpf(sine.range(200,2000))`) doesn't produce audio-rate modulation —
the continuous value gets sampled once per discrete onset, so a `"bd*8"` pattern gets 8 filter
values per cycle, not a smooth sweep. Fine for percussive step sequencing, wrong for a filter
LFO.

Because every control value here is just a `Sig` (a function of time, not tied to any note's
onset), there's no "collapse to note density" step to work around in the first place - a
`Sig` assigned to `.param(...)` is sampled/compiled on its own timeline, completely
independent of whatever `Sig` is driving note triggers on the same track. The scheduler
resolves each parameter `Sig` via one of two tiers:

- **Tier 1 — generic polling.** Any `Sig` without a recognized LFO shape (an arbitrary
  mini-notation string, a hand-written custom signal) is sampled at a fixed rate (default
  ~30ms, see `POLL_INTERVAL_MS` in `scheduler.mjs`) and forwarded as a one-shot value
  (`setParam(track, slot, name, value, targetTime)` → an OSC `/poptart/setParam` message,
  scheduled via `Server#sendBundle` for that exact target time). Always works, at the cost of
  ~30ms quantization and a little OSC traffic per tick - fine for musical modulation rates but
  not "free."
- **Tier 2 — compile to a native LFO (the fast path).** `sine`/`saw`/`tri`/`square` carry their
  parameters symbolically (`Sig#lfoIR = { shape, rateHz, phaseCycles, min, max }`) rather than
  being sampled at all. `Scheduler#setPattern` hands this IR to the engine once
  (`setParamLFO(track, slot, name, ir)`). Under `osc-engine`, this maps a control bus to the VST
  parameter (`VSTPluginController#map`) and drives that bus with a UGen (`SinOsc.kr` etc.)
  running **inside scsynth's audio callback** (see `sc/poptart.scd`'s `poptart_lfo` SynthDef) -
  zero OSC traffic after the initial call, sample-accurate, immune to JS GC pauses or Node event
  loop jank - genuinely continuous, the direct SC equivalent of what a native `LFO.h` oscillator
  gave the old JUCE host. Re-evaluating the code (a livecoding edit that only changes rate/range)
  re-sends `setParamLFO`, which updates the running modulator Synth's args in place. Native LFOs
  are not left free-running against the note grid: the audio device's sample clock skews against
  the scheduler's wall clock by tens of ppm (milliseconds per minute), so the scheduler re-anchors
  every free-running LFO's phase to the transport clock every few seconds
  (`anchorParamLFO` → a timestamped `\t_trig`/`\phase` reset, see `LFO_ANCHOR_INTERVAL_SEC` in
  `scheduler.mjs`). Each correction is only the skew accumulated since the last anchor -
  microseconds, inaudible - and the anchor phase uses the same wall-clock formula as the JS-side
  `sampleLfoIR`, so an LFO's phase is a deterministic function of time: reproducible across
  re-evals, in step with its Tier-1 sampled twin, and locked to the groove indefinitely.

`env({attack, decay, sustain, release, curve})` is a third modulator kind riding the same
Tier-2 mechanism: it carries a symbolic `envIR`, compiles to a native `EnvGen` (`poptart_env`
SynthDef) mapped to the parameter via a control bus, and is *gated by the track's own note
on/offs* - the noteOn/noteOff handlers set the gate in the same timestamped bundle as the MIDI
event, so envelope attacks line up sample-accurately with their notes (a held-note count keeps
the gate open across chords; retrigger starts from the envelope's current level, so legato
lines don't click). `curve` (SC convention: negative = scoop, 0 = linear, positive = bulge;
also settable via `.curve(c)`) is a plain control input into the Env, so re-evals update it in
place. An envelope can't ride Tier 1 at all - its value depends on note onsets, which only the
engine sees - so unlike LFOs there is no polling fallback.

Random-shaped modulation is covered by `rand` (continuous smoothed random, `LFDNoise3.kr`
natively - a full Tier-2 citizen); its JS-side `sample()` uses deterministic hash noise, so
Tier-1 uses (e.g. inside an arithmetic expression, or stepped via `.hold(...)`) are
reproducible - the JS and native values differ (both random), only the rate/range contract is
shared.

**Custom shapes** (`lfo(...)`) are a fourth modulator kind: `shape.mjs` defines a compact
breakpoint format (`"x,y[,c] …"`, c = per-segment curvature, SC curve semantics) with a
parser/serializer/sampler shared verbatim between Node and the browser. In the editor, putting
the cursor inside an `lfo(...)` call opens an interactive shape panel (drag points, drag a
segment to bend it, presets, rate + mode) that serializes every change straight back into the
code - the code string stays the single source of truth. Engine-side,
`/poptart/setParamShapeLFO` compiles a small SynthDef from the breakpoints (an `IEnvGen`
indexed by a `Sweep`-driven phase) on the same bus+map mechanism as the basic LFOs. Three
modes: `free` (loops on its own clock), `retrigger` (loops, phase reset by each noteOn - the
noteOn handler pulses `t_trig` on any shape modulator that wants it), `envelope` (one pass per
note over 1/rate seconds, then holds its final level). A re-send with identical points+mode
only updates rate/range in place (phase preserved across livecoding edits); changed shapes
recompile the def and swap the synth on the same bus. JS-side sampling exists for `free` only -
like `env()`, the note-synced modes hold their start level outside the engine.

Note *events themselves* (the top-level pattern's own `stepsForCycle`) are scheduled with
exact onset/offset times, same as before - only *parameter* signals go through the tiered
continuous-modulation path, since notes are inherently discrete triggers rather than
continuously-varying values.

## Live MIDI input

Two builders (`src/signal.mjs` + the live-value store in `src/midi.mjs`) bring hardware in,
both device-addressed by case-insensitive substring of the CoreMIDI name ("Twister" matches
"Midi Fighter Twister"); the same matching rule runs on both sides of the OSC boundary, so
Node and sclang always agree on which controller a name means. All MIDI I/O happens in sclang
(`MIDIClient`/`MIDIdef` - CoreMIDI is built into SuperCollider), so this added **no native Node
dependency** - the very thing the OSC pivot was for. MIDI is initialized lazily engine-side on
first use (any MIDI-flavored `/poptart/*` command, or `/poptart/midiInit` which web-app sends
after an eval that mentioned a MIDI builder).

- **`midicc(device)`** returns a *function* `(ccNumber, channel?) → Sig`: with
  `const cc = midicc("Midi Fighter Twister")`, `cc(12, 1)` is the continuous 0..1 signal of
  CC 12 on channel 1, and `cc(12)` aggregates all 16 channels (last event on any wins). Like
  the LFO builders it's symbolic (`ccIR`, a fourth modulator kind next to lfo/env/shape):
  assigned to `.param()`/`.gain()`/`.pan()` it compiles to a native engine-side binding
  (`/poptart/setParamCC`: a `MIDIdef` writes each incoming value, scaled into lo..hi, straight
  to a control bus mapped onto the parameter - same bus+map mechanism as `setParamLFO`), so a
  hardware knob drives its parameter with no Node round-trip, no polling, and no scheduler
  lookahead latency. `.range(lo, hi)` (signal bounds welcome) and linear math rewrite the IR
  bounds symbolically; re-evals update lo/hi in place, rescaling the knob's last position onto
  the new range so a `.range()` edit doesn't jump the parameter. Non-linear math (or `.hold()`
  etc.) demotes it to Tier-1 like any signal: sclang forwards every CC to Node as
  `/poptart/midiIn`, web-app feeds `midi.mjs`'s store, and the demoted signal samples that at
  poll rate. Until a knob first moves, a cc signal reads as a rest (null), so parameters hold
  their current value rather than jumping to a guess. Unit mapping applies as usual -
  `MappedEngine` converts setParamCC bounds through `mappings/*.json` like it does LFO/env.
- **`midikeys(device)`** returns `(channel?) → Sig`: `midikeys("Arturia KeyStep 32")(1)
  .synth("Serum 2")` plays Serum live from channel 1 (channel omitted = all). The scheduler
  only *arms* the route (`setMidiNotes` → `/poptart/midiRoute`); the notes themselves never
  touch Node - sclang `MIDIdef`s forward the whole performance stream (note on/off with
  velocity, pitch bend, channel + poly aftertouch, and raw CCs so mod wheel/sustain work) to
  the track's instrument immediately, deliberately *not* through the timestamped-bundle path:
  live playing wants "now", not a lookahead deadline, so latency is the MIDI driver's rather
  than the pattern clock's. Live notes run the same held-count bookkeeping as scheduled ones,
  so `env()` modulators gate and note-synced `lfo()` shapes retrigger from the keyboard
  exactly like from pattern notes. Because the route plays engine-side with no scheduler tick
  involved, `Scheduler#stop` (mute, stop-all, label removal) tears it down explicitly - with
  CC 123 all-notes-off on every channel so a held key doesn't drone - and re-evals re-arm it.

To make the `const cc = midicc(...)` idiom work, `buildPattern` (web-app) evaluates blocks via
direct `eval` instead of wrapping them in `return (...)`: a block may now contain statements,
and its result is the completion value (the last expression), so plain single-expression
blocks behave exactly as before. Blocks are still separate scopes - a `const` declared in one
block isn't visible in another, so each block declares the devices it uses. A named device
that isn't connected warns once engine-side (listing what *is* connected) and binds nothing;
plug it in and re-evaluate.

**MIDI record** turns a live `midikeys()` take into pattern code. The route's MIDIdef handlers
in sclang forward every note edge (post scale-quantization, so what's recorded is what
sounded) to Node as `/poptart/midiNoteIn`; web-app's `/api/midiRecord/start` arms a window
that opens at the next 4-cycle phrase boundary - the wait is the count-in - and runs for a
chosen number of cycles at a chosen grid (1/4..1/32 of a cycle, or unquantized). The editor's
`● rec` button (with a cycles/quantize dropdown) polls `/api/midiRecord/status`, shows the
count-in/progress against the header's phrase indicator (four clock-face circles, one per
cycle of the phrase, the current one filling like a clock hand and all four resetting each
phrase), and when the window closes, `recordingToMini` (see `record.mjs` above) converts each
routed track's events and the client swaps the block's `kb(...)`/`midikeys(...)(...)` call for
the resulting `` `<...>*n`.as("note:vel:clip") `` template literal, drops a directly-chained
`.scale()` (the recorded notes are already absolute), and re-evaluates - so the loop takes
over from the live keys at the next boundary, looper-style.

Held events (mini-notation ties: `"73 _"`, `<a _>`, `a/2`) extend this model minimally rather
than importing Strudel's whole/part hap machinery: the onset step's `end` may exceed 1 (the
event rings into later cycles, and the scheduler's noteOff lands there), and later cycles
report the still-sounding span as steps flagged `cont: true` - which the scheduler skips for
triggering but samplers and the editor's highlighter treat normally. The same `cont` flag is
how the structural controls (`Sig#vel`, and `Sig#note` on samplers) intersect a pattern's step
grid with the control's grid without spurious retriggers: an overlap is a fresh onset only if
one side starts a non-`cont` step exactly there.

## `.synth()`, `.fx()`, and signal chains

One naming snag shaped the `Sig` API: any control that accepts a plain string is run through
`mini(...)` (see `toSignal()` in `signal.mjs`), because that's what makes
`.param("Filter 1 Freq", "200 1000 3000")`-style stepped modulation possible. But plugin names routinely contain spaces -
`"Serum 2"`, `"Massive X"`, `"Kontakt 7"` - and mini-notation reads a bare space as a sequence
separator, so if `.synth(...)`/`.fx(...)` went through the same path, `.synth("Serum 2")` would
silently become the two-step sequence `"Serum" "2"`, not one atomic plugin id. So `Sig#synth()`
and `Sig#fx()` deliberately do **not** call `toSignal()`/`mini()` at all: a plugin id is always
one static, literal string per pattern (`this._clone({ instrument: pluginId })`), never
patterned over time - which also matches reality, since swapping a track's loaded VST
mid-cycle isn't something you'd want happening automatically anyway. The one actual *parameter*
control, `.param(name, value)`, goes through `toSignal()` and so accepts mini-notation strings,
numbers, `Sig`s, or the LFO builders interchangeably.

Each pattern is associated with a **track**: a named, ordered chain of loaded plugins,
`[instrument, effect, effect, ...]`, mirrored on the SuperCollider side as one `SynthDef` per
track containing a fixed-length chain of `VSTPlugin.ar` UGens (see "`osc-engine` internals"
below). The editor buffer holds any number of patterns via labels (`keys: …`, `$: …` - see
`labels.mjs` above): `/api/evaluate` splits the buffer into blocks, evaluates each, and runs
one `Scheduler` + engine track per label, stopping tracks whose label disappeared or got
muted/un-soloed since the last eval. The browser also gets `cps` and each block's source range
back from an eval, which (with the shared mini parser and its per-step `loc` ranges, plus the
shared wall clock - browser and Node run on the same machine) is everything needed to light up
the currently-sounding mini-notation atom in the editor with no polling, Strudel-style. The
buffer itself is also kept base64url-encoded in `location.hash` (again Strudel-style), so a
patch shares as a plain URL and opening a shared link restores the code.

- `.synth("Serum 2")` — resolves "Serum 2" against the scanned/known-plugins list and assigns it
  as the track's instrument slot (loaded once, reused; note on/off events are just MIDI to
  that one instance — Serum 2 handles its own polyphony, same as any other synth).
- `.fx("ValhallaRoom")` — appends an effect plugin to the chain; the track's audio output runs
  through the instrument, then each `.fx(...)` in order, before hitting the master bus.
- The parameter control `.param("Filter 1 Freq", ...)` targets the **last plugin added to the
  chain** (the instrument if no `.fx()` has been added yet, otherwise the most recent effect) —
  mirroring how you'd naturally read the chain left-to-right. Names are always the plugin's
  real VST parameter names — there is no alias layer; the editor's autocomplete (type
  `param("` and suggestions appear from the loaded chain) and the searchable params panel are
  what make raw names ergonomic. A per-plugin mapping table still exists, but only for *unit
  conversion* (see below), never renaming.
- Because a plugin's exposed parameters are only known once it's loaded, `osc-engine` exposes
  `getParams(trackId, slotIndex)` for introspection (name, index, label) — this is what feeds
  the editor's `param(` autocomplete and params panel (via `GET /api/chainParams`, which caches
  per plugin and retries while a freshly-evaluated plugin is still opening), and what mapping
  files (`mappings/*.json`, unit ranges/curves per parameter) are authored against rather than
  guessed.

## `osc-engine` internals (SuperCollider)

- **`index.js`** — `OscEngine`, the same method surface `pattern-core`'s `Scheduler` was always
  written against (`createTrack`/`loadInstrument`/`loadEffect`/`noteOn`/`noteOff`/`setParam`/
  `setParamLFO`/`getTime`/...), implemented over OSC instead of N-API. `getTime()` returns
  Node's own wall clock — Node stays the scheduling authority, same role it played reading
  JUCE's audio clock before. Calls that mutate state (`noteOn`, `setParam`, ...) are
  fire-and-forget UDP sends, matching `Scheduler`'s synchronous calling convention; calls that
  need data back (`scanPlugins`, `getKnownPlugins`, `getParams`) return a Promise resolved by a
  correlated `/poptart/*.reply` message. `start()` spawns `sclang` running `sc/poptart.scd` and
  resolves once it reports `/poptart/ready`.
- **`sc/poptart.scd`** — the sclang control script; the only place that talks to
  `VSTPlugin~`/`VSTPluginController` directly. Boots `scsynth`, runs `VSTPlugin.search` to
  populate the known-plugins list, and registers `OSCdef`s answering the `/poptart/*` command
  set `OscEngine` sends. Each track is one `SynthDef` containing a fixed-length chain (currently
  8 slots: 1 instrument + 7 effects) of `VSTPlugin.ar` UGens, each with a distinct `id` symbol -
  loading/swapping which plugin occupies a slot only calls `VSTPluginController#open` on that
  slot's controller, no `SynthDef` rebuild required (only *growing* the chain past 8 would need
  one). `noteOn`/`noteOff`/`setParam` convert an incoming target-time-as-latency into
  `Server#sendBundle(latency, msg)` so `scsynth` executes them at the precise sample - the OSC
  equivalent of the old native engine's sample-timestamped event queue, and the same technique
  SuperDirt/Tidal use for sample-accurate OSC scheduling.
- Verified end-to-end on the dev machine (SuperCollider 3.14.1 + VSTPlugin v0.6.2): the brief's
  own pattern shape - `n("0 2 3").scale("F minor").synth("Serum 2").param("Filter 1 Freq",
  sine({rate:0.5}).range(0.1,0.8))` - was evaluated through the browser API, loaded the real
  Serum 2 VST3, produced audible notes, and the recorded master bus shows the 0.5Hz filter
  sweep. `getParams` returned Serum 2's full 2,621-entry parameter list. Two implementation
  notes that came out of that verification: OSC *reply* payloads travel via temp file because
  real parameter lists blow past the ~64KB UDP datagram limit, and track state is stored with
  `[\symbol]` indexing rather than Event field syntax because `.synth`/`.group` are existing
  `Event` methods that shadow key lookup.
- One caveat: VSTPlugin~ hosts VST2/VST3 only, no AudioUnits - in practice nearly every AU
  also ships a VST3, so this hasn't cost anything yet.
- **Audio output device**: the editor's settings tab lists CoreAudio output devices (web-app
  enumerates them with `system_profiler SPAudioDataType -json` - names *and* channel counts,
  which sclang's `ServerOptions.outDevices` doesn't provide) and persists the choice in
  `~/.poptart/settings.json`. scsynth only picks its device at boot, so applying a change
  restarts the whole sclang/scsynth stack (`OscEngine#stop` now waits for sclang to quit
  scsynth cleanly first - an orphaned scsynth would keep the old device and port 57110
  wedged); playing tracks stop and the user re-evaluates. The selected device's channel count
  rides in as `numOutputBusChannels`, which is what `Sig#o`'s stereo-pair wraparound is
  computed against in each track's SynthDef.
- **Sampler** (`s("pack")` patterns): the division of labor is Node-heavy on purpose. Node
  (`samples.js` + `OscEngine#playSample`) owns pack discovery (folder under
  `~/Downloads/gsamps_for_poptart`, overridable via `POPTART_SAMPLES_DIR`, with the legacy
  `~/.poptart/samples` as fallback when the default folder is missing; filename order), WAV parsing and transient
  detection for `.slice()` (energy-flux onset detector; WAV-only, non-WAV files just have no
  slices), and all the per-event math - `fit` (repitch so the region lasts N cycles, N
  defaulting to the nearest power of 2 of its natural length), slice→begin/end resolution,
  index wraparound, one-shot durations. sclang only reads buffers (`/poptart/loadSamplePack`,
  replying with frames/sampleRate/channels - the inputs to Node's math) and spawns voices
  (`/poptart/playSample`): one small SynthDef per (one-shot|loop, plain|timestretch, mono|
  stereo) combination, since each combination wants a different index driver and doneAction.
  Plain voices repitch via `BufRd` index rate; `stretch != 1` picks a `Warp1` granular def with
  time and pitch decoupled. Voices write to a per-track private audio bus that the track's
  `SynthDef` mixes in ahead of the effect slots, so samples run through `.fx()` chains exactly
  like an instrument's output, and sample onsets gate `env()` modulators / retrigger note-synced
  `lfo()` shapes the way notes do.
- **Tempo** (`setbpm`, 4 beats/cycle): one `Transport` (pattern-core) is shared by every
  `Scheduler` - it maps seconds↔cycles through a rebased linear clock (`baseSec`/`baseCycle`/
  `cps`), and every tempo change rebases at the moment of change so cycle position is
  continuous. A signal-valued tempo is just a poll loop of tiny rebases. This is also why
  `Sig#sample` grew an optional third `cyclePos` argument: with variable tempo, cycle position
  is no longer `t * cps`, so the scheduler passes the transport's value through; omitted, it
  falls back to `t * cps` (exact at constant tempo, so standalone pattern-core use is
  unchanged). The tempo is also mirrored into every open VST as emulated DAW transport
  (`Transport#onCpsChange` → `OscEngine#setTempo` → VSTPlugin's `setTempo`/`setTransportPos`,
  with a rolling transport enabled at plugin open), so plugin-internal synced LFOs, delays and
  arpeggiators follow `setbpm`; a periodic beat-position re-sync (same reasoning as the
  scheduler's LFO anchors) keeps the plugins' self-advanced transport from drifting against
  the pattern grid. The transport is also a stoppable clock: it's born paused at cycle 0, the
  first eval with active tracks starts it, and stop (`/api/stop`, or the engine restart on a
  device change) freezes it back at cycle 0 - so playback always restarts from the top of the
  grid, and nothing advances while stopped. `Transport#snapshot` carries the `paused` flag so
  the editor's clock mirror (highlighting, phrase circles) freezes with it.

## What's built vs. what's next

`pattern-core` is fully implemented and verified in isolation (no engine required to test it):
the mini-notation parser/interpreter, note-name/scale tables, the `Sig` model, and `Scheduler`
were all exercised directly against a mock engine object during development -
`n("0 2 3").scale("F minor").synth("Serum 2").param("Filter 1 Freq",
sine({rate:0.3}).range(200,5000))` (the brief's example, via `.param()` now that aliases are
gone) produces the correct MIDI notes (F5/Ab5/Bb5), correct exact onset/offset times, a single
`setParamLFO` call carrying the right IR and zero further calls for that parameter (Tier 2),
and a `.param("Filter 1 Freq", "200 1000 3000")` variant was separately confirmed to fall back
correctly to Tier-1 polling. This is unaffected by the OSC pivot and was re-verified after
the `NativeScheduler` → `Scheduler` rename.

`osc-engine` and `web-app` are new (see "Why option 3 was abandoned" above for why the earlier
JUCE/Electron stack was replaced) and **verified end-to-end against a real `scsynth`** on the
dev machine: browser eval → OSC → sclang loaded the real Serum 2 VST3, played the pattern's
notes on schedule, ran a Tier-2 native LFO on `Filter 1 Freq` (the sweep is visible in a
recorded master-bus WAV, period matching the LFO rate), and `getParams` round-tripped Serum 2's
full 2,621-entry parameter list. The failure path is also verified: with `sclang` missing, the
server reports `loaded: false` with a clear error (mirroring the old `nativeEngineError`
surfacing). LFO phase preservation across livecoding re-evals is handled on the SC side: a
same-shape `setParamLFO` re-send updates the running modulator Synth's args in place.

Not yet done, in rough priority order for a first real jam session:
1. **Full-collection plugin scanning kills scsynth on this machine.** Scanning the entire
   default plugin locations reproducibly made scsynth exit (code 0, before probing - and the
   usual suspects probe fine individually, so it looks like a VSTPlugin scan bug worth
   reporting upstream with a minimal repro, not one bad plugin). Workaround in place:
   `POPTART_VST_DIRS` points the scan at a curated directory of just the plugins being played
   (`~/.poptart/plugins`, a folder of symlinks, on the dev machine). Individual crashing/
   hanging plugins are handled fine - probes are subprocesses with timeouts - it's only the
   whole-collection scan that hits this.
2. **Engine supervision.** If scsynth dies mid-session nothing notices or restarts it - the UI
   keeps saying "engine ready" while notes go nowhere. Needs a heartbeat (e.g. sclang pinging
   Node, or watching `Server.default.serverRunning`) surfaced to `/api/status`.
3. **Chains longer than 8 slots.** Each track's `SynthDef` currently hardcodes a max chain
   length (1 instrument + 7 effects) because `VSTPlugin~` instances live inside a `SynthDef`'s
   UGen graph and can't be added to a running `Synth` - growing a chain past that needs
   rebuilding the track's `SynthDef` and re-opening already-loaded plugins into the new graph.
4. Parameter mapping: the file-based unit layer is **built and verified** (`mappings/*.json` +
   `packages/web-app/param-mapping.js`: real-world-unit → normalized conversion with lin/log
   curves, hot-reloaded per eval; `mappings/serum2.json` makes
   `.param("Filter 1 Freq", sine({rate:0.3}).range(200,5000))` mean Hertz). Aliases were
   deliberately removed from this layer — real parameter names + editor autocomplete replaced
   them. Still to do: a UI for authoring unit mappings from `getParams` output, and
   auto-calibration (probing a parameter's normalized↔display curve by reading value strings
   back from the plugin) so ranges don't have to be guessed per plugin.
5. A proper master bus with metering in the UI. (Per-track `.gain()`/`.pan()` exist - a
   post-chain channel strip on each track synth, signal-modulatable via pseudo-slot -1.
   Label-level mute/solo still works by not scheduling notes, not by the gain stage; a Tier-2
   LFO on a muted track keeps modulating its silent plugin, by design.)
6. Persisting a "rack" (which plugins + mappings are loaded) alongside a saved pattern file.
7. Native perlin/noise modulation, if Tier-1 polling proves audibly stepped in practice.
8. Mini-notation gaps if they turn out to matter in practice: polymeter (`{a b, c d}`),
   degrade (`?`), cycle-internal rate patterns (`a*[2 3]` - per-cycle `a*<2 3>` works).
   (Nested alternation now matches Strudel's slowcat semantics - each `<...>` item sees its
   own "times picked" count, so `<0 2 3 <5 7>>*8` alternates 5/7 on successive visits.)
9. Sampler niceties: velocity/gain per event, a `.chop()`-style even slicer alongside the
   transient-based `.slice()`, spectral-flux onset detection if the energy detector misses
   soft onsets, and slice analysis for non-WAV formats (decode via scsynth or a decoder dep).
