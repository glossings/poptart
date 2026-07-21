# poptart

A livecoding environment with Strudel-style mini-notation, `note`/`n`/`scale`, and continuous
signals, that plays and modulates real VST/AU instruments and effects instead of samples.

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design, what's implemented vs. still
scaffolded, and the reasoning behind the harder calls (why SuperCollider + `VSTPlugin~` over OSC
instead of a custom native host, why there's no Strudel/Tidal dependency, how modulation stays
genuinely continuous down to the audio thread).

## Layout

- `packages/pattern-core` — the pattern language: mini-notation parser, `n`/`note`/`scale`,
  `sine`/`saw`/`tri`/`square`, and `Scheduler`, which drives any engine implementing its plain
  interface (see `scheduler.mjs`). Pure JS, engine-agnostic - can be used and tested on its own.
- `packages/osc-engine` — the engine adapter: talks OSC to a spawned `sclang` (SuperCollider)
  process, which hosts VST2/VST3 plugins via the `VSTPlugin` extension and answers a small
  `/poptart/*` OSC command set. See `sc/poptart.scd`. (No AudioUnit support - VSTPlugin is
  VST2/VST3 only; in practice nearly every AU also ships a VST3.)
- `packages/web-app` — a plain Node HTTP server + browser page: editor, transport, plugin
  browser. No Electron - open the served page in any browser.

## Setup

Requires Node 20+, **SuperCollider** (`sclang` on PATH), and the **VSTPlugin** server extension.
VSTPlugin is a compiled binary extension, *not* a Quark: download the macOS zip from
https://git.iem.at/pd/vstplugin/-/releases and unzip its `sc/VSTPlugin` folder into
`~/Library/Application Support/SuperCollider/Extensions/`.

On this machine both are already installed (SuperCollider 3.14.1 via `brew install --cask
supercollider`, VSTPlugin v0.6.2), with `sclang`/`scsynth` wrapper scripts in
`/opt/homebrew/bin`. Note: those wrappers are tiny `exec` scripts, not symlinks - a symlinked
`sclang` resolves its class library relative to the symlink's location and fails to compile.

```sh
npm install     # installs all workspaces
npm run dev      # starts the Node server (spawns sclang itself - no separate step)
```

Then open `http://localhost:4000` in a browser.

## Using it

1. Run `npm run dev`, then open `http://localhost:4000`.
2. Click **rescan** to have `osc-engine` (via SuperCollider's `VSTPlugin.search`) scan for
   installed VST2/VST3 plugins. Click a result to copy its exact name to the clipboard - that's
   the string `.synth()` and `.fx()` expect. Plugins that crash or hang their probe are skipped
   automatically (each probe runs in a disposable subprocess with a timeout) - watch the server
   log for `error!`/`timed out` lines to see which.
3. Write a pattern in the editor and hit **eval** (or Cmd/Ctrl+Enter). The current evaluation
   contract is a single expression that evaluates to a pattern - see `packages/web-app/server.js`.
4. **stop** halts playback (Cmd/Ctrl+.).

The editor autocompletes as you type: plugin names inside `.synth("…")`/`.fx("…")` (from the scan),
real VST parameter names inside `.param("…")` (from the loaded chain - so evaluate once with a
`.synth(...)` to load the plugin, then `param(` completions appear), and method/builder names
elsewhere (Ctrl+Space opens it manually). The **params** sidebar panel lists every parameter of
every plugin in the current chain, searchable; click one to copy its name. Eval/stop hotkeys
work with focus anywhere on the page, and the editor uses CodeMirror's sublime keymap
(Cmd/Ctrl+/ toggles comments, Shift+Cmd/Ctrl+Down duplicates the line, etc.).

### Parameters and units

Parameters are always addressed by their real VST names - `.param("Filter 1 Freq", …)` - there
is no alias layer; the params panel and autocomplete exist so the real names are always at hand
(the raw list is also at `POST /api/params {"trackId":"default","slot":0}`). Values are the
VST's normalized `0..1` unless a mapping file says otherwise: mapping files in `mappings/*.json`
(see `packages/web-app/param-mapping.js` for the format) declare per-parameter **units** -
`"Filter 1 Freq": { "min": 8, "max": 22050, "curve": "log" }` - so `.range(200, 5000)` means
*Hertz* and gets converted (then clipped) to normalized values.

`mappings/serum2.json` ships as the worked example; mapping files hot-reload on every eval.
With it, this plays and sweeps in real Hertz (verified: the recorded master bus shows the
0.3Hz sweep):

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 On", 1)
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

### Modulators

Any `.param(...)` value can be a number, a mini-notation string (stepped), an LFO
(`sine`/`saw`/`tri`/`square`, e.g. `sine({ rate: 0.3 }).range(200, 5000)`), or an envelope:

- `env({ attack, decay, sustain, release })` — an ADSR (times in seconds, sustain 0..1)
  retriggered by the track's own notes, i.e. a per-note filter/mod envelope like a synth's
  own envelope section. `.range(lo, hi)` scales it exactly like an LFO. LFOs and envelopes
  both run natively inside the audio engine (sample-accurate, no OSC traffic per note).

`.range(min, max)` bounds can themselves be signals - `lfo().range("200 300", 4000)` sweeps
from a stepped floor. (Signal bounds drop that modulator from native Tier-2 to the polled
Tier-1 path, since the engine-side oscillator only takes fixed lo/hi.)

For static sound-design settings that are fiddly as normalized numbers (unison voices, detune
amounts …), click **ui** next to a plugin in the track panel to open the plugin's own editor
window, set them by hand, and keep livecoding the rest.

### Pinning plugin state into the code

Click **pin** next to a plugin in the track panel to capture its complete current state
(preset, every knob, wavetables - whatever the plugin serializes) into the code as the call's
second argument: `synth("Serum 2", { state: "H4sI…" })`, same for `.fx(...)`. On every load or
eval that state is restored into the plugin, Ableton-style: the patch sounds identical on a
cold start, and since the whole buffer lives in the URL hash, sharing the link shares the
sound. The blob is gzip+base64 (opaque by design) and the editor folds it - and long `lfo()`
shape strings - down to a small `{⋯}` pill; click the pill to see the raw text. Re-pin after
tweaking to update it; deleting it changes nothing until the next cold start (the plugin just
keeps its current sound).

### Sampler

`s("pack")` plays sample packs alongside the VST tracks - a pack is a folder of audio files
under `~/Downloads/gsamps_for_poptart/<pack>/` (override the root with `POPTART_SAMPLES_DIR`;
the legacy `~/.poptart/samples` is used if the default folder doesn't exist), addressed by
index in filename order. Like everything else, every config accepts numbers, mini strings, or
signals, sampled per event onset:

```js
drums: s("bd*4 hh*8")
  .i("<0 1 2>")          // which file of the pack (strudel's `n`, renamed to avoid our n())
  .begin(0).end(1)       // play region, 0..1
  .loop()                // loop the region for the event's length instead of one-shot
  .speed("1 -1")         // playback rate; negative = reversed
  .stretch(2)            // timestretch (granular; pitch preserved)
  .fit()                 // repitch to the nearest power-of-2 measures (.fit(3) = exactly 3)
  .slice("0 1 2 3")      // play the nth detected transient (WAV files only; wraps)
  .note("45 _ 52 57")    // repitch by MIDI note (60/"c5" = as recorded; .n() is an alias)
  .vel("1 .5 ~ 1")       // velocity: linear volume scaling per event
```

Sampler events are always **gated**: a sample rings exactly as long as its event and is cut
there (Ableton Sampler gate mode), so a bare `s("longsample")` cuts at each cycle instead of
piling up. `.note()` and `.vel()` are *structural* controls - a patterned value splits events
on its step grid (all the grids mix: each fresh step retriggers, a `~` drops the event, and
the event lengths come from the exact overlaps, however complex the pattern). So
`s("longsample").vel("1 1 ~ 1")` is three quarter-cycle hits, adding `.note("20 30 40")` on
top subdivides further onto twelfths, and `vel("1 [1!3] 1 1@3")`-style nesting just works -
each event is clipped to precisely its computed length. To let a sample ring *longer*, make
its event longer: `s("long/2")`, `"long@2"`, or ties. `.vel()` works on synth tracks too,
where it sets MIDI velocity (0..1) with the same structural behavior.

Sample tracks run through the same `.fx()`/`.param()` chain as instruments, and their onsets
gate `env()` modulators / retrigger note-synced `lfo()` shapes just like notes. Packs load on
first use - the first evaluation of a new pack is silent for a beat while its files are read.

### Tempo

`setbpm(140)` in any block sets the global tempo (4 beats per cycle; the default is 120). It
accepts signals too - `setbpm("120 140")`, `setbpm(sine(0.01).range(100, 160))` - polled and
applied as continuous, phase-preserving tempo changes shared by every track.

## Known gaps (see ARCHITECTURE.md for the full list)

- **Scanning the full default plugin locations kills scsynth on this machine** (reproducibly,
  before probing anything - looks like a VSTPlugin scan bug, not one bad plugin). Because of
  this, the scan defaults to `~/.poptart/plugins` when that folder exists - a folder of
  symlinks to just the plugins you play (set up here with ~40 of them - Serum 2, Diva, Vital,
  Pigments, the Soundtoys and FabFilter suites, and more; `ls ~/.poptart/plugins` for the
  current list). `POPTART_VST_DIRS` (colon-separated directories) overrides the default, and
  the full default-location scan only happens if neither exists. Individual plugins that
  crash or spam errors during a scan are skipped via VSTPlugin's exclude option - a few
  known-bad or unwanted ones are baked into `poptart.scd` (Mellotron V, Jun-6 V, Melodyne,
  CloudSeed, SpaceBlender, MORPH 3 PRO), and
  `POPTART_VST_EXCLUDE` (colon-separated paths) adds more.
- If `scsynth` dies mid-session, nothing detects or restarts it - the UI keeps reporting
  "engine ready" while notes go nowhere. Restart `npm run dev` for now; supervision is a to-do.
- Parameter values are normalized `0..1` for any parameter without a `mappings/*.json` units
  entry, and only `mappings/serum2.json` ships so far - real-world units for anything else need
  a mapping file (or the planned auto-calibration) first.
- Each track's plugin chain has a fixed max length (8 slots: 1 instrument + 7 effects) baked into
  one `SynthDef` per track, since `VSTPlugin~` instances live inside a `SynthDef`'s UGen graph and
  can't be added to a running `Synth`. Swapping *which* plugin occupies a slot is fine; growing
  the chain past 8 isn't handled yet.
- Mini-notation supports sequences, rests, brackets/stacks, alternation (nested alternations
  advance strudel-style, one pick per visit), fast/slow, replicate, weight, elongation/ties
  (`"a _ _"`; inside `<...>` a `_` or `@2` holds the previous pick across cycles without
  retriggering), euclidean rhythms, and per-cycle alternation rates (`"[0 2]*<1 2>"`);
  polymeter (`{a b, c d}`), degrade (`?`), and cycle-internal rate patterns (`a*[2 3]`)
  aren't implemented.
- All three OSC/scsynth ports are env-overridable (`POPTART_OSC_NODE_PORT`,
  `POPTART_OSC_SC_PORT`, `POPTART_SCSYNTH_PORT`) so a second stack - tests, a parallel
  session - can run beside the first.
- `.slice()` transient analysis is Node-side and WAV-only; other formats play fine but have no
  slices. Editor playback highlighting mirrors the server's tempo clock per eval, so under a
  *signal-valued* `setbpm` it drifts until the next eval (cosmetic).
