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
- `index.mjs` — the public surface that stitches these together.

### `packages/osc-engine` — the engine adapter
The concrete engine implementation the scheduler drives. Bridges Node and audio.

- `index.js` — spawns a SuperCollider (`sclang`) process and speaks a small `/poptart/*` OSC
  command set to it: load plugin into a track slot, set parameters, trigger notes, start/stop
  native LFOs and envelopes, tempo, routing. Implements the plain-object engine interface the
  scheduler expects.
- `samples.js` — the sampler side: reads audio folders, transient/slice analysis (Node-side,
  WAV-only), and sample event handling.
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
- **Plugin state lives in the code, not in a store the code points at.** Editing a plugin in its
  own window writes its whole program back into the call — `synth("Serum 2", { state: "H4sIA…" })`,
  gzip+base64, megabytes and all — so a patch is self-contained: the file is the sound. It briefly
  worked the other way, with a content-addressed store under `~/.poptart/states` and a short `st_…`
  chip in the code. That made buffers small, but it made a patch a *pointer*, and pointers dangle:
  states went missing, and a patch that can lose its own sound is worse than a big one. The reason
  big buffers hurt was never the bytes anyway — it was the label splitter re-lexing an accumulating
  block once per line, which put megabytes of quadratic work in front of every eval on the same
  event loop as the note scheduler. Fixing that (labels.mjs, 2MB: 225ms → 11ms) left inline state
  costing ~23ms per eval for one pinned Serum and ~55ms for three, which buys a great deal.
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

---

*This document is a high-level orientation and rationale log. When a structural decision changes,
update the relevant section here rather than appending conversation notes.*
