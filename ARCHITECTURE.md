# poptart — Architecture

A high-level map of how poptart is put together and *why* it is shaped this way. This is a living
experiment log: it records the load-bearing design decisions and the trade-offs behind them, not a
line-by-line API reference (the README covers usage). Keep it high-level; update it when a
structural decision changes.

---

## What poptart is

A livecoding environment that plays **real VST/VST3 plugins** from terse, Strudel-style patterns.
You write patterns in a browser editor; the system plays and continuously modulates actual plugin
instruments and effects, with LFOs and per-note envelopes running sample-accurately in the audio
engine. There is no Strudel/Tidal dependency — the pattern language is its own small
implementation.

## The three-package split

The system is a Node workspace of three packages, each independently usable and testable. The split
is deliberate: the pattern language knows nothing about audio, and the audio engine knows nothing
about the language.

```
┌──────────────────┐     evaluates patterns,      ┌──────────────────┐
│   web-app        │     serves editor UI          │  pattern-core    │
│  (HTTP + browser)│ ────────────────────────────▶ │ (language +      │
│                  │     imports & drives           │  scheduler)      │
└────────┬─────────┘                                └────────┬─────────┘
         │ small plain-object engine interface               │ drives any engine
         ▼                                                     ▼
┌──────────────────┐   /poptart/* OSC command set   ┌──────────────────┐
│   osc-engine     │ ─────────────────────────────▶ │  SuperCollider   │
│ (Node ↔ sclang)  │                                 │  (sclang/scsynth │
│                  │                                 │   + VSTPlugin~)  │
└──────────────────┘                                 └──────────────────┘
```

### `packages/pattern-core` — the language and scheduler
Pure JS, ES modules, engine-agnostic, no audio dependencies. This is the heart of the system and
the most unit-testable part.

- `mini.mjs` — the mini-notation parser (sequences, rests, brackets/stacks, alternation, euclidean
  rhythms, fast/slow, replicate, weight, ties, per-cycle rates).
- `signal.mjs` — the `Signal` abstraction: the shared prototype behind every pattern, LFO, and
  (via string shims) mini string. Constant signals, LFO builders (`sine`/`saw`/`tri`/`square`),
  ranges, and the prototype users extend live from the editor.
- `notes.mjs` — `n`/`note`/`scale` and pitch handling.
- `scheduler.mjs` — the `Scheduler` that queries patterns per cycle and emits timed events to
  *any* engine implementing a small plain-object interface. This interface boundary is what keeps
  the language decoupled from SuperCollider.
- `labels.mjs` — the block model: named blocks (`bass: …`) must evaluate to patterns; anonymous
  code and `$:` blocks run as setup (shared `const`s, `Signal.prototype` extensions, statements).
- `macros.mjs`, `midi.mjs`, `shape.mjs`, `record.mjs` — macro controls, MIDI CC input, LFO/envelope
  shape encoding, and recording helpers.
- `midifile.mjs` — reading a dropped `.mid` into lanes, guessing the grid its rhythm sits on and
  the key it's in, and writing each lane out as the arguments of a roll — which the editor files
  under the lane's name and plays with `pianoroll("name")` — so an import lands in the editable form
  and the roll's own →♪ converts it to mini-notation when that's wanted.
- `index.mjs` — the public surface that stitches these together.

### `packages/osc-engine` — the engine adapter
The concrete engine implementation the scheduler drives. Bridges Node and audio.

- `index.js` — spawns a SuperCollider (`sclang`) process and speaks a small `/poptart/*` OSC
  command set to it: load plugin into a track slot, set parameters, trigger notes, start/stop
  native LFOs and envelopes, tempo, routing. Implements the plain-object engine interface the
  scheduler expects.
- `samples.js` — the sampler side: reads audio folders, resolves one exact file for `se()`, expands
  a hand-picked `sp()` pack's files and folders,
  transient/slice analysis (Node-side, WAV-only), and sample event handling.
- `recordings.js` — where bounced tracks live (`~/.poptart/recordings/<YYYY-MM>/<name>.wav`) and
  how they're named. Owns all path building, like web-app's `pattern-files.js`.
- `wav.js` — WAV read/write plus the recorder's trim pass (see the per-track recording decision
  below). The RIFF parsing all tracks live here; `samples.js` mixes down from it.
- `analysis.js` + `analysis-worker.js` — the above two functions, off the event loop (see the
  nothing-blocks-the-music decision below).
- `sc/poptart.scd` — the SuperCollider class/def code: hosts plugins via the `VSTPlugin~` server
  extension, builds one `SynthDef` per track (fixed 8-slot chain: 1 instrument + 7 effects), and
  runs the native LFOs/envelopes sample-accurately inside the audio graph.
- `audio-devices.js` + `native/` — device enumeration and the aggregate device that lets `input()`
  reach several interfaces. scsynth opens exactly **one** audio device, so combining a mic and an
  interface means building a real CoreAudio aggregate: `native/poptart-audio.swift` (committed
  **prebuilt**, so installing poptart needs no Swift toolchain — rebuild with `native/build.sh`)
  creates it with drift compensation on every non-master member and reads the subdevice order back,
  which is what turns `input("Scarlett", 1)` into an absolute channel. Everything degrades to
  `system_profiler` and a single device if the helper is unavailable.

### `packages/web-app` — the server and editor
- `server.js` — a plain Node HTTP server (no Electron). Serves the page, exposes plugin scan /
  sample browse / settings / pattern-save endpoints, spawns the engine, and mediates between the
  browser and pattern-core + osc-engine.
- `public/client.js` — the browser app: CodeMirror editor, transport, plugin browser, sample
  browser, params panel, macros, settings, theming.
- `public/api-docs.js` — the editor's API reference: one entry per userland name (signature +
  description). Drives the autocomplete word lists, the popup's doc panel, and the ctrl-hover
  tooltip; `api-docs.test.js` checks it against the real builders and `Sig.prototype`.
- `param-mapping.js` — loads `mappings/*.json` unit files that turn normalized `0..1` VST
  parameters into real-world units (Hz, etc.) with min/max/curve; hot-reloads per eval.
- `pattern-files.js` — the two kinds of file under `~/.poptart/patterns`: named saves, and the
  work-in-progress session files (`wip/<YYYY-MM>/…`) the editor writes as you type. Owns all
  path building, so a request names a pattern or a session, never a path.
- `public/pattern-meta.js` — parses the `@title`/`@by`/`@tags` a pattern carries in its own
  comments, and the files tab's search. Loaded in the browser *and* required by the server, so
  the tab title and the file list agree on what a pattern is called.

## How a pattern becomes sound (data flow)

1. Editor sends code to the server on **eval**.
2. Code is evaluated into blocks (`labels.mjs`): named blocks → patterns; anonymous/`$:` → setup.
3. The `Scheduler` queries each pattern per cycle and emits timed events.
4. Events cross the plain-object engine interface into `osc-engine`.
5. `osc-engine` translates them into `/poptart/*` OSC messages to `sclang`.
6. SuperCollider hosts the plugins (`VSTPlugin~`), applies parameters, triggers notes, and runs
   native LFOs/envelopes on the audio thread — modulation stays continuous down to the audio thread
   with no per-note OSC traffic.

## Load-bearing design decisions

- **SuperCollider + `VSTPlugin~` over a custom native host.** Buys a mature, sample-accurate audio
  graph and battle-tested plugin hosting for free, and keeps modulation continuous to the audio
  thread. Cost: an external `sclang`/`scsynth` dependency and a compiled `VSTPlugin` extension
  (VST2/VST3 only — no AudioUnit, though nearly every AU also ships a VST3).
- **Language decoupled from engine via a tiny plain-object interface.** pattern-core can be
  developed and unit-tested with a mock engine; the OSC engine is one concrete implementation. New
  backends are possible without touching the language.
- **Real plugin parameter names, no alias layer.** `.param("Filter 1 Freq", …)` addresses the VST
  directly. Optional `mappings/*.json` files add real-world units on top; absent a mapping,
  parameters are normalized `0..1`. Avoids maintaining a translation table per plugin.
- **Native LFOs/envelopes inside the SynthDef.** Sample-accurate and cheap, but constrains what can
  modulate: engine-side oscillators take fixed lo/hi, so signal-valued bounds fall back to a polled
  path.
- **Fixed 8-slot chain per track (1 instrument + 7 effects).** `VSTPlugin~` instances live inside a
  `SynthDef`'s UGen graph and can't be added to a running `Synth`, so chain length is baked in.
  Swapping which plugin occupies a slot is fine; growing past 8 is not handled yet.
- **A file carries its plugin state; a buffer carries a handle to it.** Editing a plugin in its own
  window captures its whole program — gzip+base64, megabytes and all. Where that program *lives*
  splits on one line: anything that can leave this machine carries it in full, and anything local
  and transient carries a `@…` handle into the content-addressed store at `~/.poptart/blobs`
  (`blobs.js`). Saved patterns and exports are hydrated on the way out, so a patch file is still
  self-contained — the file is the sound. The live buffer, the wip autosave and history snapshots
  keep handles, so `_preset("lead", "Serum 2", "@2f9a1c3d5e7b")` is what CodeMirror holds, what the
  1.2s autosave writes, what every checkpoint stores and what each eval ships. (A patch from before
  presets pins the same thing onto the call — `synth("Serum 2", { state: "@…" })` — and the editor
  converts each such call into a named preset the next time the buffer is evaluated.)

  An earlier attempt at a store (`~/.poptart/states`, `st_…` chips) was rolled back because it made
  the *patch* a pointer, and pointers dangle: states went missing and a patch that can lose its own
  sound is worse than a big one. The split above is the part that was wrong there — a file someone
  can hand to someone else never points at anything. What remains pointing is what was already
  machine-local and already disposable. The store is collected rather than capped: content
  addressing stops a program being stored twice, but a knob held for a minute is a hundred
  *different* programs, so what nothing can still name is released and everything else stays
  however old it gets — a mark and sweep over the wip and snapshot folders, run after they are
  pruned, with half an hour's grace for states too new to have been written down anywhere yet. So a
  handle outlives every buffer that mentions it, which an LRU cap could not promise. Hydrating on
  save reports any handle it can't resolve rather than writing a hole silently.
- **What bounds the state store is session retention.** A sweep can only release what nothing
  names, so every file that keeps a handle sets a floor. Snapshots cap themselves at 500. Sessions
  did not, and there was one per *page load* — 620 files in a month, each pinning the programs that
  were live when it was last written, forever. Two things fix the floor rather than the sweep: a
  session now follows the buffer rather than the tab (its id rides `sessionStorage`, so a refresh
  continues the same file and only opening a different buffer rolls a new one), and the settings tab
  offers a retention policy in months. That policy is **off by default and priced before it is
  agreed to** — the dialog says how many sessions and how many megabytes go — because a session file
  is the only copy of work that was never given a name, and deleting it is not a decision the app
  gets to make quietly.

  Buffer size was not the *only* cost, and the earlier fix for it stands: the label splitter used to
  re-lex an accumulating block once per line, putting megabytes of quadratic work in front of every
  eval on the note scheduler's own event loop (labels.mjs, 2MB: 225ms → 11ms). What it left was
  ~23ms per eval for one pinned Serum and ~55ms for three — plus a copy of those megabytes through
  `getValue`, sessionStorage, the autosave and the snapshot on a loop while you type. Measured over
  this machine's pattern folder: 56.8MB of patches become 109.5KB of editor buffers backed by 116
  distinct programs, and one month of playing had left 519MB of autosaves and 448MB of snapshots.
- **Captures are debounced per gesture, and there is no cheap one.** Asking a plugin for its
  program is `writeProgram`, and VSTPlugin's docs are explicit that plugin processing is
  *suspended* while it serializes — a couple of megabytes for a Serum patch, and audible. (The
  `async: false` alternative moves the same work onto the audio thread, which is worse.)
  Compression at both ends runs on the threadpool, so the scheduler's loop never sees our half.
  The default is to spend that suspension immediately, one per gesture: the buffer then always
  describes what you hear, and no sound design exists anywhere but the code. `POPTART_AUTOPIN=
  deferred` trades that for an uninterrupted performance — captures made while the clock runs are
  held until the next eval/stop/save/export/link — at the cost of a window where the plugin and the
  buffer disagree and a closed tab loses the difference. "Capture when the editor window closes"
  would be the signal worth waiting for and isn't available: VSTPlugin's events are `/vst_param`,
  `/vst_auto`, `/vst_program*`, `/vst_latency`, `/vst_midi`, `/vst_sysex`, `/vst_update` and
  `/vst_crash` — nothing reports an editor being closed.
- **A pending capture is bound to a plugin, not just a slot.** A chain slot is a position, and
  reordering `.fx(...)` calls moves which plugin sits at one. A capture records what occupied the
  slot when the gesture happened, and both ends check it — the server drops a capture whose slot
  changed hands, and the editor refuses to write a state into a call naming a different plugin —
  so a reorder mid-tweak can't put one plugin's program in another's call.
- **The URL carries a snapshot id, not the buffer.** Checkpoints (eval/save/load) store the code
  server-side under `~/.poptart/snapshots` and put a short `#s=…` in the address bar. Keeping the
  whole buffer there was the obvious design and was wrong twice over: `pushState` with a
  megabyte-long URL costs real main-thread time in front of every eval, and Chrome's history
  database drops URLs past a couple of kilobytes, so the states never became findable in
  `chrome://history` — the one thing the encoding was for. Snapshots are pruned to the most recent
  500, so history is a recovery net, not an archive. Sharing still builds a self-contained base64
  URL, on demand, because an id means nothing on another machine.
- **Nothing that reads a whole audio file runs on the main thread.** The Node process that hosts
  the scheduler is single-threaded, and the scheduler works a 150ms lookahead ahead of the audio —
  so any synchronous block longer than that is not slow, it is *silence*, and livecoding has no
  moment where that is acceptable. The two analyses that read whole files (transient detection for
  `.slice()`, the recorder's trim pass) therefore run on a worker thread via `analysis.js`; the
  functions themselves stay plain and synchronous in `samples.js`/`wav.js`, so they remain directly
  unit-testable and the worker is only a hop. Slice detection is *also* lazy, per file rather than
  per pack: analyzing a pack up front cost ~2.8s in one tick on a 775-file break folder — the whole
  bug this rule exists for — and most packs are never sliced at all. A `.slice()` on a file whose
  analysis hasn't landed skips that one event, matching the rule the sampler already followed for
  events arriving during a pack load: don't stall the music, just don't play *that sound* yet.
- **A bounce is recorded wide and trimmed in Node.** Per-track recording (`.record()` / ctrl+b)
  taps the track's post-fader output to a private bus and runs a `DiskOut` synth on it, started and
  stopped by *timestamped bundles* — the same mechanism note events use — so the window's edges are
  sample-accurate rather than however long an OSC message took to arrive. But freeing a `DiskOut`
  drops whatever is still in its realtime buffer (up to ~1.4s), so a synth run for exactly the
  wanted window comes back short by an unpredictable amount. What gets written is instead
  `[pre-roll][window][post-roll]`, and `wav.js` cuts the exact window back out. The post-roll that
  exists to cover that buffer doubles as the release tail, which is what makes the optional
  tail-wrap possible at no extra cost.
- **The tail is NOT wrapped by default.** Folding a bounce's release tail over its head is the
  obvious way to make a loop seamless, and it is wrong for the usual case: you bounce a pattern
  that is *already looping*, so at the window's start the previous iteration's tail is still
  sounding and gets recorded into the head. For a pattern whose period divides the window, that
  incoming tail is the same audio the outgoing one would be — adding it again plays it twice. The
  wrap is there for the other case (a track silent going in) and is off unless asked for.
- **A recording is addressed by name, not by path.** Names are minted globally unique across every
  month folder when the bounce is made, so `sr("bass")` resolves to the same file forever and a
  second bounce of the same label becomes `bass-2` rather than quietly changing what existing code
  plays. The `YYYY-MM` folders are filing, never addressing. That also keeps the reference
  spellable as a bare mini-notation atom: `/` is the slow operator, so a month-qualified
  `2026-08/bass` couldn't be written without quoting.
- **Quoted atoms in mini-notation exist for exact file paths.** `se()` genuinely needs paths, and a
  path holds `/` (slow), spaces (the sequence separator), and dots that would read as value
  methods. Rather than special-case one builder, the tokenizer grew `'…'` — one literal value,
  operators suspended — which works in any mini string and also covers sample names with spaces.
  Postfix operators still apply outside the quotes, so nothing else about the notation changed.
- **Named definitions are code in the buffer, resolved lazily by name — and the library is a prebake
  file.** A drawn roll, LFO shape, captured preset or hand-picked sample pack is a `_roll`/`_shape`/
  `_preset`/`_pack` call the editor writes and folds at the foot of the buffer; patterns say the
  name (`pianoroll("bass")`, `sp("kit")`) and a two-layer registry (buffer over prebake) answers at
  cycle-build time, so a definition may sit anywhere and a buffer that fails to evaluate keeps the
  old registry. "Make it permanent" (the ★ in every picker) is therefore nothing new: the server
  copies the definition into `~/.poptart/prebake/pinned.js`, a managed prebake source, and the
  existing prebake layer makes it a name in every project. A sample pack is the one kind the engine
  has to be told about (it loads the files): the server pushes the registry's packs to the engine
  wholesale after every evaluation, prebake run and engine start (`defineSamplePacks`), and the
  engine reloads only a pack whose file list actually changed.
- **`.record()` is a marker, not a mechanism.** It carries the panel's settings in the code and
  gives the editor something to hang the panel off, and changes nothing about playback. The actual
  bounce is keyed on the *block label*, which is why ctrl+b works on any block without it.
- **Plain HTTP + browser, no Electron.** Open the served page in any browser; keeps the footprint
  small.

## Testing posture

Prefer unit-level tests against pattern-core modules (pure JS, no audio) plus syntax checks.
Avoid booting the full stack (server + `sclang` + audio) from tooling to verify changes — it is
slow and the audio path is hard to assert on programmatically. For anything requiring the running
app (HTTP routes, UI, engine, audio), finish the change and describe what to test and watch for by
hand.

## Known limitations / open experiments

- **No engine supervision.** If `scsynth` dies mid-session nothing detects or restarts it; the UI
  still reports "engine ready." Restart the dev server. Supervision is on the roadmap.
- **Sparse parameter mappings.** Only one worked mapping file ships so far; other plugins need a
  mapping file for real-world units.
- **Mini-notation gaps.** Polymeter (`{a b, c d}`) and cycle-internal rate patterns (`a*[2 3]`)
  aren't implemented yet. Degrade (`?`) and random choice (`|`) now are.
- **Slice analysis is WAV-only** and Node-side; other formats play but have no transient slices.
- **Bouncing doesn't free the plugin.** A bounced track keeps its VST loaded in its slot (ready for
  the un-mute), so `.record()` is a bounce, not yet a freeze — it doesn't buy back CPU.
- **A bounce assumes a steady tempo.** The window's edges are converted from cycles to seconds when
  the recording is armed, so a tempo change mid-window desyncs the result from the grid.

---

*This document is a high-level orientation and rationale log. When a structural decision changes,
update the relevant section here rather than appending conversation notes.*
