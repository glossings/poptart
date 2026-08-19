## Preamble

Hey, [Glossing](https://linktr.ee/glossing) here. Poptart is like the evil stepsister of other livecoding environments in that it uses (almost exclusively) VSTs instead of built-in synths. I wanted to see if that was possible and if it was fun. So far, the answer to both is yes :p

Did I use AI to assist with this? YEP. Whole bunch. That said, all of the API design, planning, and testing was done by me, and has been inspired by the many many hours I've poured into developing tools for Max and Strudel by hand.

I think whether we should be using technology like this to build our tools is a complicated question and I'm by no means trying to take a stance by releasing this. Honestly I built something fun for myself to test out ideas locally and then others wanted to take it for a spin as well, so here we are. It felt weirder to keep it secret than just release it with this preamble.

This leads to the next point: this was never meant to be a large-scale open source framework. I'm likely going to just keep developing it as a silly little sideproject for myself to augment my music. If such improvements bring some joy to others, then that would be a wonderful bonus.

I hope you enjoy! AI slop readme begins in 3.. 2.. 1..

# Poptart

A livecoding environment for real instruments. You arrange your music in simple notation; Poptart
plays and continuously modulates actual VST/VST3 plugins.

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

That's a synth line in F minor played through Serum, with its filter cutoff swept by a 0.3 Hz sine. Edit the code, hit eval, and the sound changes underneath your hands.

(Glossing again. If you somehow ended up here without previously checking out [Tidal Cycles](https://tidalcycles.org) and [Strudel](https://strudel.cc), please do yourself a favor and give them a try - Poptart mirrors a lot of the patterning concepts and mini notation pioneered in those programs.)

## Highlights

- **Real plugins as instruments and effects.** `.synth("…")` loads any VST2/VST3 instrument;
  `.fx("…")` chains effects after it. Parameters are addressed by their real plugin names
  (`.param("Filter 1 Freq", …)`) — no alias layer to learn or maintain.
- **Genuinely continuous modulation.** LFOs (`sine`/`saw`/`tri`/`square`) and per-note ADSR
  envelopes (`env(...)`) run natively inside the audio engine, sample-accurate, with no OSC
  traffic per note. Any parameter can take a number, a mini-notation string, an LFO, or an
  envelope.
- **Strudel-style mini-notation.** `n`/`note`/`scale`, sequences, rests, brackets and stacks,
  alternation, euclidean rhythms, fast/slow, replicate, weight, ties, and per-cycle rates.
- **A sampler alongside the synths.** `s("pack")` plays folders of audio files with slicing,
  timestretch, repitch, per-event velocity, and the same effects chain as instrument tracks;
  `se("path")` and `sr("name")` play one exact file, or one of your own bounces.
- **Bounce a track from the keyboard.** ctrl+b records the block the cursor is in — starting on the
  next phrase, for as many cycles as you asked — files the audio, mutes the source, and writes the
  playback line in below it. `.record()` gives you the same thing with a panel and a live meter.
- **Shareable patches.** A plugin's full state (preset, every knob, wavetables) is written into the
  code automatically, so the patch *is* the sound — **export** hands someone a single file that
  plays exactly what you hear, and **link** puts a whole plain-code patch in the clipboard.
- **Extensible from the editor.** Extend `Signal.prototype` live, define shared constants, and
  build your own vocabulary the same way you would in Strudel.

## How it works

Three packages, each usable on its own:

- **`packages/pattern-core`** — the pattern language and scheduler. The mini-notation parser,
  `n`/`note`/`scale`, the `sine`/`saw`/`tri`/`square` signal builders, and a `Scheduler` that
  drives any engine implementing its small plain-object interface. Pure JS, engine-agnostic,
  independently testable.
- **`packages/osc-engine`** — the engine adapter. It spawns a SuperCollider (`sclang`) process
  and talks a small `/poptart/*` OSC command set to it; SuperCollider hosts the plugins via the
  `VSTPlugin` server extension and runs the native LFOs/envelopes. (No AudioUnit support —
  `VSTPlugin` is VST2/VST3 only; in practice nearly every AU also ships a VST3.)
- **`packages/web-app`** — a plain Node HTTP server plus a browser page: the editor, transport,
  plugin browser, sample browser, and settings. No Electron; open the served page in any browser.

Why SuperCollider + `VSTPlugin~` over OSC rather than a custom native host: it gives a mature,
sample-accurate audio graph and battle-tested plugin hosting for free, and keeps the modulation
continuous all the way down to the audio thread. There is no Strudel or Tidal dependency; the
pattern language is its own small implementation.

## Requirements

- **Node 20+**
- **SuperCollider** — install it (`brew install --cask supercollider` on macOS). poptart
  auto-detects `sclang` at the standard install location (`/Applications/SuperCollider.app` on
  macOS, `C:\Program Files\SuperCollider` on Windows), so you don't have to put it on your
  `PATH` yourself. If yours lives somewhere non-standard, point poptart straight at the binary
  with `POPTART_SCLANG=/full/path/to/sclang`.
- **The VSTPlugin server extension — installed for you.** On first run poptart detects it's
  missing, downloads the pinned build for your platform (checksum-verified), and unzips it
  into your SuperCollider `Extensions` directory. On macOS the pinned build comes from
  [poptart's vstplugin fork](https://github.com/glossings/vstplugin/releases): upstream v0.6.2
  with a fix for a probe crash that wrongly puts some plugins (Auto-Tune Pro, sforzando,
  Arturia V Collection, …) on the scan cache's ignore list. Manual fallback, should the
  auto-install fail (it's a compiled binary extension, *not* a Quark): download the macOS zip
  from the fork releases page (other platforms:
  <https://git.iem.at/pd/vstplugin/-/releases>) and unzip its `sc/VSTPlugin` folder into the
  `Extensions` directory (on macOS, `~/Library/Application Support/SuperCollider/Extensions/`).

> **Troubleshooting "engine did not finish booting":** the error message includes the last lines
> of SuperCollider's own log plus a diagnosis — read that first; it names the actual cause. The
> usual suspects:
>
> - **Orphaned processes from an earlier run** holding poptart's ports or the audio device:
>   `pkill -f sclang; pkill -f scsynth`, then retry. (Also quit the SuperCollider IDE if open.)
> - **A leftover `sclang` symlink on your `PATH`** from a manual install. A symlinked `sclang`
>   can't find its class library and fails to compile; poptart finds the real binary by itself,
>   so the symlink only gets in the way. Check for one:
>   ```sh
>   which -a sclang            # lists every sclang on your PATH (poptart needs none of them)
>   ls -l "$(which sclang)"    # a symlink shows an arrow: /opt/homebrew/bin/sclang -> /Applications/SuperCollider.app/...
>   ```
>   If the `ls -l` line contains a `->`, it's a symlink — delete it (only removes the link, not
>   the real app):
>   ```sh
>   rm "$(which sclang)"       # add sudo if it lives in /usr/local/bin or /opt/homebrew/bin and rm reports "Permission denied"
>   ```
>   Repeat `which -a sclang` until it prints nothing, then retry poptart.
> - **VSTPlugin missing** — see above; poptart warns at startup if it isn't in the standard
>   Extensions folder.
> - **Broken files in `~/Library/Application Support/SuperCollider/`** (a half-installed
>   extension, a bad `startup.scd`) left over from other SuperCollider projects. In the error's
>   sclang output, look for lines starting with `ERROR:` or `WARNING:` — especially
>   `duplicate Class found`, `Class not defined`, or `Library has not been compiled
>   successfully` — and for any file path under `.../SuperCollider/Extensions/`. That path is the
>   culprit. Move the offending extension out and retry:
>   ```sh
>   # back the whole Extensions folder out of the way (keeps VSTPlugin too, so you'll re-add that)
>   mv ~/Library/Application\ Support/SuperCollider/Extensions ~/Desktop/sc-extensions-backup
>   ```
>   then reinstall just VSTPlugin (see above) into a fresh `Extensions/` and retry. Reinstalling
>   SuperCollider itself does **not** help — the installer never touches this user directory, so
>   the broken file survives.
> - **The log has no `ERROR:` at all — it just stops.** The `poptart:` checkpoint lines say how
>   far boot got, and the diagnosis reads them for you. The three cases:
>   - *Nothing after the `Welcome to SuperCollider` banner*: sclang runs your personal
>     `~/Library/Application Support/SuperCollider/startup.scd` **before** poptart's engine
>     script, so a startup file that boots a server or opens a window hangs there forever. Move
>     it aside (`mv ~/Library/Application\ Support/SuperCollider/startup.scd ~/Desktop/`) and
>     retry.
>   - *Nothing after `poptart: booting scsynth (…)`*: macOS blocked the audio server from
>     starting. Launch SuperCollider.app once by hand (right-click it in `/Applications`, choose
>     **Open**) so Gatekeeper approves it, and check **System Settings → Privacy & Security →
>     Microphone** for a pending prompt for your terminal. Then retry.
>   - *Some device output but never `server booted, ready`*: the audio device is wedged or
>     misreporting. Pick a different output device in the settings tab — or replay poptart's
>     exact boot config in the SuperCollider IDE, where the device's real complaint is visible
>     instead of swallowed by the timeout. Copy the values from the error's `boot config` note:
>     ```supercollider
>     s.options.sampleRate = 48000;            // "sr"
>     s.options.blockSize = 256;               // "block"
>     s.options.numOutputBusChannels = 2;      // "out: Nch"
>     s.options.numInputBusChannels = 0;       // "in: Nch"
>     // only if boot config names a device (not "system default"):
>     // s.options.inDevice = s.options.outDevice = "That Device Name";
>     s.boot;
>     ```
>     If a plain `s.boot` in a fresh IDE session works but this doesn't, re-add the options one
>     at a time — whichever one breaks the boot is what your hardware rejects (and worth
>     reporting as a poptart issue: forced 48 kHz on a rate-locked device is the usual one).

## Getting started

```sh
npm install     # installs all workspaces
npm run dev     # starts the server; it spawns sclang itself — no separate step
```

The first run prints a short setup report: it checks for SuperCollider (and tells you the
install command if it's missing), auto-installs the VSTPlugin extension if needed, and warns
about known boot-wreckers (stale `sclang` symlinks, orphaned engine processes) before booting.

Then open <http://localhost:4000>. The server listens on `127.0.0.1` only — evaluated code
runs with your user's privileges, so it must not be reachable from the network. If you
knowingly want LAN access (say, a collaborative jam on a trusted network), set
`POPTART_HOST=0.0.0.0`; poptart will print a warning explaining what that exposes.

1. Click **rescan** to scan for installed VST2/VST3 plugins (via SuperCollider's
   `VSTPlugin.search`). Click a result to copy its exact name — that's the string `.synth()` and
   `.fx()` expect. Plugins that crash or hang their probe are skipped automatically (each probe
   runs in a disposable subprocess with a timeout); watch the server log for `error!`/`timed out`
   lines to see which.
2. Write a pattern in the editor and press **eval** (Cmd/Ctrl+Enter). A *named* block (`bass: …`)
   must evaluate to a pattern. Anonymous code — bare lines outside any label, or `$:` blocks —
   may be anything, Strudel-style: patterns play, and everything else (shared `const`
   declarations, `Signal.prototype` extensions, one-off statements) runs as setup for the blocks
   below it.
3. **stop** halts playback (Cmd/Ctrl+.).

The editor autocompletes plugin names inside `.synth("…")`/`.fx("…")`, real VST parameter names
inside `.param("…")` (from the loaded chain — evaluate once with a `.synth(...)` so the plugin
loads, then `param(` completions appear), and method/builder names elsewhere (Ctrl+Space opens
it manually). Builder and method completions come with their signature and a one-line
description, and the highlighted one is described in full in a panel beside the popup; hold
**Ctrl** and hover over any name already in the buffer to see the same thing. Both live in
`public/api-docs.js`, and both switch off under *settings → editor → documentation tooltips*.
The **params** panel lists every parameter of every plugin in the current chain,
searchable; click one to copy its name. Eval/stop hotkeys work with focus anywhere on the page,
and the editor uses CodeMirror's sublime keymap.

## The language

### Parameters and units

Parameters are always addressed by their real VST names — `.param("Filter 1 Freq", …)`. Values
are the VST's normalized `0..1` unless a **mapping file** says otherwise. Mapping files in
`mappings/*.json` (see `packages/web-app/param-mapping.js` for the format) declare per-parameter
units:

```json
"Filter 1 Freq": { "min": 8, "max": 22050, "curve": "log" }
```

With that in place, `.range(200, 5000)` means *Hertz* and is converted (then clipped) to
normalized values. `mappings/serum2.json` ships as a worked example; mapping files hot-reload on
every eval. With it, this plays and sweeps in real Hertz:

```js
n("0 2 3")
  .scale("F minor")
  .synth("Serum 2")
  .param("Filter 1 On", 1)
  .param("Filter 1 Freq", sine({ rate: 0.3 }).range(200, 5000))
```

Notes work on either side of `.synth()` — `synth("Serum 2").n("0 2 3").scale("F minor")` is the
same pattern — and a note-less `synth("Serum 2")` plays a default C2 every cycle, so a bare synth
makes sound immediately.

#### Duplicate parameter names

Some plugins reuse a parameter name across sections — Diva, for instance, has three parameters
named `Frequency`, one per filter model. A plain `.param("Frequency", …)` targets the **first**
one. To address a specific one, append its parameter index: `.param("Frequency#95", …)`. You
rarely type this by hand: the params panel and autocomplete show the `#index` form automatically
for any name that collides, and the **conf** capture button writes it for you when the knob you
touch in the plugin's own editor is one of a duplicated set. A parameter whose real name happens
to contain `#` is matched exactly first, so the suffix only kicks in when there's no literal match.

### Modulators

Any `.param(...)` value can be a number, a mini-notation string (stepped), an LFO, or an envelope:

- **LFOs:** `sine`/`saw`/`tri`/`square`, e.g. `sine({ rate: 0.3 }).range(200, 5000)`.
- **Envelopes:** `env({ attack, decay, sustain, release })` — an ADSR (times in seconds, sustain
  `0..1`) retriggered by the track's own notes: a per-note filter/mod envelope, like a synth's own
  envelope section. `.range(lo, hi)` scales it exactly like an LFO.

LFOs and envelopes both run natively inside the audio engine (sample-accurate, no per-note OSC).
`.range(min, max)` bounds can themselves be signals — `lfo().range("200 300", 4000)` sweeps from a
stepped floor (signal bounds move that modulator from the native path to the polled path, since
the engine-side oscillator takes only fixed lo/hi).

For static sound-design settings that are fiddly as normalized numbers (unison voices, detune),
click **ui** next to a plugin in the track panel — or double-click the `synth` / `fx` name in the
code itself — to open that plugin's own editor window, set them by hand, and keep livecoding the
rest.

### Constants and extending the language

`Signal(x)` is the constant-signal constructor (no `new`): `Signal(1)` is a continuous 1, and it
accepts anything a control takes — a number, a mini string, or an existing signal (identity). A
bare number stays continuous with no step grid, which is what controls want; use
`n(...)`/`note(...)`/`mini(...)` when a constant should instead *trigger* as a whole-cycle step.

`Signal.prototype` is the shared prototype of every pattern, LFO, and (via string shims) mini
string — extend it right from the editor, exactly like Strudel's `Pattern.prototype`:

```js
const cc = midicc("Midi Fighter Twister")
Signal.prototype.co = function (num) {
  return this.o(num).gain("1".sub(cc(num - 1, 2)));
};

drums: s("bd hh sd hh").co(1)
```

New methods work on bare mini strings too (`"bd*4".co(1)`), never shadowing a real String method,
and persist across evals until the server restarts. These `Signal.prototype.…` / `const …` lines
are ordinary top-level statements: put them on their own column-0 line **anywhere** in the buffer,
between tracks or above them — each becomes its own setup block. (A bare `$: Signal(0.5)` is *not*
setup: it evaluates to a signal, so it becomes a silent track with no synth. To reuse a constant,
name it — `const half = Signal(0.5)` — and reference it.)

### Prebake: setup that runs at startup

Anything you'd otherwise paste into the top of every session — personal helpers, custom scales,
`Signal.prototype` extensions — goes in a **prebake** file that Poptart runs **once at load**,
before any pattern plays. Edit it in the browser from the **settings** tab → **edit prebake…**
(saving re-runs it immediately, no restart needed), or edit `~/.poptart/prebake.js` directly:

```js
// ~/.poptart/prebake.js
Signal.prototype.co = function (num) {
  return this.o(num).gain("1".sub(midicc("Midi Fighter Twister")(num - 1, 2)));
};
const kick = s("bd*4")           // reusable named building blocks
const acid = (p) => p.lpf(300).lpq(8)
```

Prebake runs as **setup**, exactly like a `$:` block: nothing auto-plays. What it leaves behind is
available everywhere after — `Signal.prototype.…` methods (globally) and top-level
`const`/`let`/`var` bindings, which are injected into every buffer so you can write `drums:
kick.co(1)` or `bass: acid(n("0 3 5").synth("Serum 2"))` in any pattern without redefining them. A
buffer can still shadow a prebake name by redeclaring it locally.

For more than one file, add a `~/.poptart/prebake/` folder: its `*.js` files run after `prebake.js`
in filename order (so `10-scales.js` before `20-drums.js`), each seeing the previous ones'
bindings (these folder files are disk-only — the in-browser editor edits just `prebake.js`). A
prebake file that throws is logged and skipped — it never blocks startup, and the in-browser editor
surfaces the error on save. One caveat: *removing* a `Signal.prototype` extension needs a restart,
since the prototype keeps methods already added to it.

### Plugin state in the code

`synth("Serum 2")` leaves the sound to the plugin's own default. The moment you change anything in
the plugin's own window — a knob, a preset from its browser — that state is captured and written
into the code for you, as the call's second argument: `synth("Serum 2", { state: "H4sIAAAA…" })`,
same for `.fx(...)`. Nothing to press; the code keeps describing what you're hearing.

That string is the plugin's whole program — every knob, the preset, the wavetables — gzipped and
base64'd, often megabytes of it. It folds on screen to a `{◆ 2184kb}` chip you can click open, so
it takes one line of reading space. **The patch is the file**: what you save, export or paste
carries its own sound, with nothing to resolve and nothing that can go missing behind it. That's
also what makes the obvious workflow work — duplicate a line, change the preset on one copy, and
switch between them by commenting one out. Both states are right there in the text.

The state lands about half a second after you let go of the knob, so the code is never behind what
you're hearing and closing the tab can't cost you a preset. Asking a plugin for its program does
suspend it while it serializes — on a big instrument that's a brief interruption you can hear — so
there's a quieter mode for performing: start the server with `POPTART_AUTOPIN=deferred` and captures
made while the clock is running are held until the next moment the code has to be true about the
sound (play, stop, save, export, copy a link), leaving a jam uninterrupted. The trade is that your
sound design lives only inside the plugin until one of those happens; the editor says so once when
it starts holding one.

To share a patch, use **export** and send the file; the other end opens it with **import**, or just
drops it in `~/.poptart/patterns`. The **link** button copies a self-contained URL of the buffer,
which is the quickest way to pass around a patch with no pinned plugins — with one, the URL runs to
megabytes and the address bar will truncate it, so the editor tells you to export instead.

(The address bar itself holds a short `#s=…` snapshot id rather than the buffer — see
ARCHITECTURE.md. Back/Forward walk your evals.)

Capture is debounced, so a knob sweep writes once when you let go rather than continuously, and
the writes collapse into a single undo step. Delete the `{ state }` argument and the call goes back
to meaning "however the plugin defaults" — on the next eval, not retroactively: the plugin keeps
sounding how it sounds until something reloads it.

### Sampler

`s("pack")` plays sample packs alongside the VST tracks. A pack is a folder of audio files under
the sample library root, addressed by index in filename order:

```js
drums: s("bd*4 hh*8")    // "bd:4" picks a file inline, Strudel-style: = s("bd").i(4)
  .i("<0 1 2>")          // which file of the pack (Strudel's `n`, renamed to avoid our n())
  .begin(0).end(1)       // play region, 0..1
  .loop()                // loop the region for the event's length instead of one-shot
  .speed("1 -1")         // playback rate off .begin(); negative wraps backwards (and loops)
  .flip("<0 1>")         // reverse the region INTO the beat: lands on .begin() at the step's end
  .stretch(2)            // timestretch (granular; pitch preserved)
  .fit()                 // repitch to the nearest power-of-2 measures (.fit(3) = exactly 3)
  .slice("0 1 2 3")      // play the nth detected transient (WAV files only; wraps)
  .note("45 _ 52 57")    // repitch by MIDI note (24/"c2" = as recorded)
  .n("0 2 4")            // scale degrees; add .scale("F minor") to map them, like on synths
  .vel("1 .5 ~ 1")       // velocity: linear volume scaling per event
  .attack(0.1).decay(0.2).sustain(0.6).release(0.2) // amplitude ADSR (or .adsr(a,d,s,r))
```

To play one *exact* file rather than a folder, `se("path")` names it relative to the sample
library root, and `sr("name")` names one of your own bounces (see **Bouncing** below). Both are
the same sampler — everything above applies unchanged:

```js
stab: se("'hits/stab 01.wav'").slice("0 2")   // quoted: a path holds mini-notation operators
loop: sr("bass").slow(8)                       // an 8-cycle bounce, played whole
```

A path contains characters mini-notation reads as operators — `/` is slow, a space separates
steps — so anything beyond a bare filename goes in **single quotes**, which make it one literal
value. Quoting works in any mini string, not just `se`. Recording names never need it. The editor
autocompletes both: `se("` offers a folder at a time, `sr("` offers every take you've made.

The ADSR shapes the voice's amplitude. `attack`/`decay`/`release` are **multiples of the played
duration**: `.decay(0.5)` reaches the sustain level halfway through the note, while `.attack(2)`
ramps for twice the note's length and so never reaches full before it ends. `sustain` is a `0..1`
level. Attack → decay → sustain play across the note; once its duration ends the envelope releases
from wherever it is (a `.loop()` or cut one-shot releases at its gate-off instead). Left unset,
playback is unchanged.

`speed` is a *rate*, read continuously off `.begin()`: the playhead leaves `begin` at that speed,
so positive runs up to `.end()` and `0` plays nothing. Going the other way it walks **backwards out
of `begin`**, which wraps round to `.end()` — the region is a circle, so a negative speed **loops
by default** and `.speed(-1)` is the familiar "play it backwards from the end", repeating for as
long as the event lasts. `.loop(0)` opts out and gives you a single backwards pass.

`.flip()` is the other way to go backwards: over `0.5` it plays `begin..end` backwards **once**
and delays the voice so it lands on `begin` exactly at the step's end, which is what makes a
flipped hit sweep *into* the next one — `s("sd").flip("<0 1>*2")`.

The sample library root defaults to `~/.poptart/samples` — drop or symlink your sample folders in
and they appear. You can change it in the **settings** tab (type a path or click **browse…** to
navigate to a folder), or set the `POPTART_SAMPLES_DIR` environment variable (which overrides the
setting). Packs load on first use, so the first
evaluation of a new pack is silent for a beat while its files are read.

Sampler events are always **gated**: a sample rings exactly as long as its event and is cut there
(Ableton Sampler gate mode), so a bare `s("longsample")` cuts at each cycle instead of piling up.
`.note()` and `.vel()` are *structural* controls — a patterned value splits events on its step
grid (all grids mix: each fresh step retriggers, a `~` drops the event, and event lengths come
from the exact overlaps). To let a sample ring *longer*, make its event longer: `s("long/2")`,
`"long@2"`, or ties. `.vel()` works on synth tracks too, where it sets MIDI velocity (`0..1`).

Sample tracks run through the same `.fx()`/`.param()` chain as instruments, and their onsets gate
`env()` modulators and retrigger note-synced `lfo()` shapes just like notes.

### Bouncing a track

Put the cursor in any named block and press **ctrl+b**. Recording starts at the next phrase
boundary and runs for the chosen number of cycles, capturing that track's own post-fader audio.
The take is filed under `~/.poptart/recordings/<YYYY-MM>/`, the source block is **muted**, and the
bounce goes in below it under the same label:

```js
// before
bass: note("c2 eb2 g2 _").synth("Serum 2").record({ cycles: 8 })

// after ctrl+b
_bass: note("c2 eb2 g2 _").synth("Serum 2").record({ cycles: 8 })
bass: sr("bass").slow(8)
```

Sharing a label is the point: the bounce takes the original's place on that engine track, so the
mix doesn't move and un-muting one line puts the synth back. Only one of the two may be live at a
time, which is what the mute guarantees. This is a bounce, not a freeze — the plugin stays loaded,
ready for that un-mute, so it doesn't buy back CPU.

`.record({ cycles })` anywhere in a chain adds a panel: double-click the `record` name and it opens
on that block showing its **live level**, with the length and the name to file under, each change
written straight back into the call the way `lfo()` and `pianoroll()` work. (Double-click is the
rule for every in-code panel — `lfo`, `pianoroll`, `record`, `synth`, `fx` — so none of them can
open under a stray click while you edit.) A finished take is drawn normalized to its own peak, with
that peak's true level in dBFS printed in the corner. It changes nothing about the sound. Names are minted unique across every month folder when the recording is made, so
`sr("bass")` means the same file forever and a second bounce of the same label becomes `bass-2`.

`wrapTail: true` folds the release tail back over the head, for a track that was **silent** going
in. It's off by default because the usual case is bouncing a pattern that is *already* looping:
the previous pass's tail is still sounding at the window's start and gets recorded into the head,
so adding the outgoing tail would play it twice.

### Tempo

`setbpm(140)` in any block sets the global tempo (4 beats per cycle; the default is 120). It
accepts signals too — `setbpm("120 140")`, `setbpm(sine(0.01).range(100, 160))` — polled and
applied as continuous, phase-preserving tempo changes shared by every track.

### Key

A patch is nearly always in one key, so the key is a property of the *document* rather than of
each pattern. `setscale("F minor")` sets it and `.sc()` reads it — `n("0 2 4").sc()` is
`n("0 2 4").scale("F minor")`, on notes as on degrees:

```js
setscale("C minor")

bass: n("0 3 5").sc(3).synth("Serum 2")
lead: n("0 2 4 7").sc(5).synth("Diva")
```

`.sc(3)` puts the scale's **root** in octave 3, exactly like writing `.scale("c3 minor")` by hand;
bare `.sc()` leaves it where `setscale` put it (octave 5 unless the name said otherwise). A
patterned octave works too — `.sc("<3 4>")` alternates octaves per cycle.

`setscale` is **hoisted**: whichever one comes last in the buffer is the key the whole buffer plays
in, including the patterns written *above* it. So re-keying a patch mid-set is one edit wherever
it's convenient to make it — drop a new `setscale("F minor")` at the bottom and everything follows.
(Only a line that is nothing but a `setscale(...)` call hoists; one tangled up with other code runs
in its place, in document order.) Like the tempo, the key persists until something changes it.

The piano roll follows the key: in-key keys and lanes are tinted with the accent colour (the tonic
hardest), out-of-key ones are dimmed, and the **fold** button collapses the roll to the scale's
notes alone — plus any pitch the roll actually uses, so folding never hides a note you drew.
Clicking the key chip in the roll's header snaps every note into the key. Roll edits have their own
undo: **cmd-Z** / **cmd-shift-Z** while the grid has focus.

Folded, the roll also converts *in the key*: **→♪** writes the drawn notes out as scale degrees —
`n(\`<0 2 4 ~>*16\`).sc(3)` rather than raw MIDI numbers — so re-keying the patch afterwards moves
them with it. The octave goes in `.sc()`, chosen so no degree comes out negative. (Unfolded, the
roll is chromatic and so is what it converts to. A note that's out of key has no degree of its own
and is written as the nearest one, which the log says out loud.)

### Audio output

The **settings** tab picks the audio output device (the list shows each device's output channel
count; the choice persists). Applying a change restarts the audio engine — scsynth only picks its
device at boot — so playing tracks stop; re-evaluate to resume.

On a multichannel device, `.o(n)` routes a track's stereo output to a channel pair: `.o(1)` is
channels 1/2 (the default), `.o(2)` is 3/4, and so on, wrapping past the device's last pair — on
stereo speakers every `.o(n)` is channels 1/2, so nothing is ever routed somewhere silent. (Pairs
are counted on the output device you picked, not on the combined device built for *extra inputs*
below: those inputs' own outputs go nowhere you can hear.) It's a channel-strip control like
`.gain()`/`.pan()`, so patterns and signals work too.

### Audio input

`input()` runs a hardware input through a chain. Channels are numbered from **1**, as labelled on
the interface; one channel is mono and lands centred, two make a stereo pair (they need not be
adjacent):

```js
gtr:  input(3).fx("Amp Room").fx("ValhallaRoom")
room: input(5, 6).fx("Pro-C 2")
bass: note("c2*8").synth("Serum 2").fx("Pro-C 2").audio(input(1))   // ducked by a live mic
```

SuperCollider opens exactly **one** audio device, so by default those are the channels of whatever
device you're playing through. To use several interfaces at once — a mic *and* an interface — tick
them under **extra inputs** in the settings tab: poptart builds a single combined (aggregate) audio
device from them, with drift correction so independent clocks don't slide apart, and opens that
instead. Applying restarts the engine, like an output device change.

Once several devices are combined, the optional leading name says *whose* channels you mean, so
you don't have to count offsets by hand (autocomplete inside `input("` lists what's available and
the channel range each one occupies):

```js
vox: input("Scarlett", 1).fx("Pro-Q 4")   // channel 1 of that interface, wherever it landed
```

A name that isn't there warns in the console and falls back to plain channel numbering rather than
stopping playback. Unplugging a combined interface renumbers the channels after it — poptart says
so in its log when that happens.

The combined device is built **around the output device** (it's the clock master, and its channels
are the ones playback lands on), so changing the output device rebuilds it — and so does every
engine start, from whatever is connected at the time. Unplug an interface and the next restart
simply rebuilds without it; plug it back in and the next restart brings it back. Your selection is
never edited behind your back: a device that's merely slow to enumerate after a wake would be the
one thing an auto-untick would silently throw away, along with the ordering that sets `input()`'s
channel numbers. It stays ticked, marked *not plugged in*, and unticking it is how you forget it.

If the combined device is somehow wrong anyway, poptart will *not* keep playing into whatever is
left of it: it falls back to the output device directly and says so, in the console and as a
warning under **extra inputs**. That safety net matters because this failure is inaudible in the
worst way — with the engine feeding, say, a BlackHole loopback, every meter in the app keeps moving
and nothing comes out of the speakers.

## Configuration

Most things work out of the box; a few can be pointed elsewhere.

| What | Where | Default |
| --- | --- | --- |
| Sample library folder | **settings** tab, or `POPTART_SAMPLES_DIR` | `~/.poptart/samples` |
| Audio output device | **settings** tab | system default |
| Extra audio **inputs** (combined into one device, so `input()` can reach several interfaces) | **settings** tab | none |
| Plugin scan directories | `POPTART_VST_DIRS` (colon-separated) | `~/.poptart/plugins` if it exists, else the standard VST locations |
| Plugins to skip when scanning | `POPTART_VST_EXCLUDE` (colon-separated paths) | none |
| Prefer VST3 over VST2 (hide VST2 builds whose name also exists as VST3) | **settings** tab | on |
| Probe plugins in parallel while scanning | `POPTART_VST_PARALLEL=1` | off (one plugin at a time) |
| Saved patterns (and autosaved sessions, under `wip/`) | `POPTART_PATTERNS_DIR` | `~/.poptart/patterns` |
| Bounced tracks (filed by month, played with `sr()`) | `POPTART_RECORDINGS_DIR` | `~/.poptart/recordings` |
| Startup setup file / folder | `POPTART_PREBAKE_FILE`, `POPTART_PREBAKE_DIR` | `~/.poptart/prebake.js`, `~/.poptart/prebake/` |
| Persisted settings | `POPTART_SETTINGS_FILE` | `~/.poptart/settings.json` |
| OSC / scsynth ports | `POPTART_OSC_NODE_PORT`, `POPTART_OSC_SC_PORT`, `POPTART_SCSYNTH_PORT` | `57140` / `57150` / `57110` |
| SuperCollider binary | `POPTART_SCLANG` | auto-detected (PATH, then the standard install location) |

To make an environment variable permanent, add it to your shell profile. For the default zsh on
macOS:

```sh
echo 'export POPTART_SAMPLES_DIR="$HOME/Music/samples"' >> ~/.zshrc
```

Then open a new terminal (or `source ~/.zshrc`). Prefer the settings tab for the sample folder and
audio device — the environment variables exist for scripted or multi-machine setups.

### Curating the plugin scan

Scanning every default plugin location can be slow, and some plugins crash or hang their probe.
Two knobs help:

- `POPTART_VST_DIRS` narrows the scan to specific directories. A common setup is a folder of
  symlinks to just the plugins you play, at `~/.poptart/plugins` (used automatically when it
  exists) — this keeps scans fast and avoids problem plugins entirely.
- `POPTART_VST_EXCLUDE` skips individual plugins by absolute path (VSTPlugin prunes them from the
  traversal so they're never probed). Use it for copy-protection, metering, or analysis plugins
  that fail to probe headlessly.

Plugins are probed one at a time. VSTPlugin's default is to probe in parallel, which is faster but
segfaults scsynth partway through a large scan on at least one machine (a null dereference inside
`VSTPlugin.scx` on scsynth's audio thread — VSTPlugin's own result handling, reached regardless of
which plugins are in the folder). Set `POPTART_VST_PARALLEL=1` if you want the fast path back; it
only affects plugins that actually need probing, since cached entries re-verify without a probe.

A probe that fails is not fatal — it is reported as `error!` in the scan log and that plugin is
simply absent from the list. Plugins with copy protection or their own startup dialogs commonly
fail to probe headlessly while working fine in a DAW.

Many plugins install both a VST2 and a VST3 build. By default poptart lists only the VST3 when
both exist (the **prefer VST3 over VST2** toggle in the settings tab), and `.synth("Name")` /
`.fx("Name")` resolve name collisions to the VST3. Both builds are still scanned, and the VST2
stays loadable by its exact id (e.g. `.synth("Mangle")` vs `.synth("Mangle.vst3")` — VST2 dict
ids carry no extension).

## Limitations

- If `scsynth` dies mid-session, nothing detects or restarts it — the UI keeps reporting "engine
  ready" while notes go nowhere. Restart `npm run dev` for now; supervision is on the roadmap.
- Parameter values are normalized `0..1` for any parameter without a `mappings/*.json` units
  entry; only `mappings/serum2.json` ships so far, so real-world units for other plugins need a
  mapping file first.
- Each track's plugin chain has a fixed maximum length (8 slots: 1 instrument + 7 effects), baked
  into one `SynthDef` per track, since `VSTPlugin~` instances live inside a `SynthDef`'s UGen graph
  and can't be added to a running `Synth`. Swapping *which* plugin occupies a slot is fine;
  growing the chain past 8 isn't handled yet.
- Mini-notation supports sequences, rests, brackets/stacks, alternation, fast/slow, replicate,
  weight, elongation/ties, euclidean rhythms, per-cycle alternation rates, degrade (`?`), and
  random choice (`|`). Polymeter (`{a b, c d}`) and cycle-internal rate patterns (`a*[2 3]`)
  aren't implemented yet.
- `.slice()` transient analysis is Node-side and WAV-only; other formats play fine but have no
  slices.
- Bouncing a track (ctrl+b / `.record()`) doesn't free its plugin — it stays loaded in the track's
  slot, ready for the un-mute — so it's a bounce, not a freeze, and doesn't buy back CPU. The
  window is also converted from cycles to seconds when the recording is armed, so a tempo change
  mid-bounce puts the result out of step with the grid.

## License

Poptart is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only) — see
[LICENSE](LICENSE).

In plain terms: you can use it, study it, share it, and modify it freely. Make whatever music you
like with it and sell that music — your tracks are yours, the license doesn't touch them. The one
condition is on the *code*: if you distribute a modified version, or run one as a network service,
you have to make your source available under the same license. That's deliberate — it keeps Poptart
open for artists and hobbyists while stopping anyone from quietly rolling it into a closed,
proprietary product.
