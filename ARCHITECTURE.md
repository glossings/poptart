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
- **Plugin state captured into the code automatically (gzip+base64 in the URL hash).** Editing a
  plugin in its own window writes its state back into the `synth()`/`fx()` call, so the code always
  describes the sound and sharing a link shares it exactly. Debounced: a capture is a disk write in
  sclang plus a synchronous gzip on the scheduler's event loop, so it runs once per gesture, not
  per knob sample. Opaque by design; the editor folds the blob into a pill.
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
