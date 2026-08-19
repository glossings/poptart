# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] Visualize velocity and probability in pianoroll
[ ] Double check what's going on with `arp`. It seems to have some weird `squeeze`-like behavior
[ ] see if we can get highlighting to work with string templates
[ ] signal in format string
```js
const myInt = rand().mul(8).round()
$: `<
  0 4 ${myInt}
  0 4 ${myInt}
>*8`.as("n").scale("F3 minor")
```
[ ] Evict sample packs that haven't been played in a while. Packs load whole and stay for the
    session (`_packs` in osc-engine/index.js, `samplePacks` in poptart.scd) — nothing frees them
    but reloading the same pack. numBuffers is 16384 now so the *count* is fine, but the audio is
    real RAM: a 15G library is only a few big packs away from hurting. Wants an LRU keyed on last
    play, freeing the SC buffers and dropping the Node entry so the next event reloads it.
[ ] Instance-based presets — considered and deferred 2026-08-19, on CPU/RAM. Written down so it
    isn't re-derived from scratch, not because it's queued.

    `.preset("<a b>")` currently swaps a plugin's whole state by pushing a different program into
    ONE instance (`readProgram`, see `_schedulePresetSwaps` in pattern-core/src/scheduler.mjs). The
    alternative is one live plugin per named preset, where a swap is just "route notes to the other
    instance".

    What it buys: swaps stop clicking (routing is instant and sample-accurate, a program load is
    not); `a`'s release tail rings out while `b` starts, instead of being cut by a reprogram of the
    synth underneath it; editing is unambiguous by construction, since `a`'s plugin window *is* `a`.
    And it deletes the machinery that only exists because one instance is time-shared —
    `Scheduler#holdPreset`/`_presetHold`, server.js's `presetHolds` lease + TTL + renewal on the
    pluginEdits poll, `heldSlotsFor`'s highlight suppression, the gesture-time preset attribution
    in `handlePluginEdited`, and the whole hand-editing freeze (`Scheduler#holdPluginState`,
    server.js's `handTaken`/`uncaptured`, the editor's held marks and commit reporting, and
    poptart.scd's `waitForLoad` note queue and the `/poptart/statePending` announce that arms it) —
    all of which exists because a knob turn, a swap and a note fight over the one instance.

    What it costs, and why it lost: one live plugin per name — `<a b c d>` of a heavy synth is four
    of it, on the machine already running the whole stack. Adding a name to a pattern becomes a
    plugin open (hundreds of ms) rather than a data change. And sc/poptart.scd bakes a fixed
    `maxSlots` grid of `VSTPlugin.ar` UGens per track, whose own header notes that growing a chain
    "would need a def rebuild (not handled yet)" — instances-per-slot lands squarely on that.

    Shape to build if it's ever revisited:
    - Instrument slot only. An fx slot processes the chain signal, so N instances is N× the CPU
      *and* switching still cuts the unselected one's tail — most of the win, all of the cost.
      Keep reprogramming (and therefore the hold) for fx.
    - A fixed number of instance sockets baked into the SynthDef (`slot0`, `slot0_1`, …), summed —
      no gating needed, since only the active socket is sent notes and the rest are silent. Fixed,
      not sized-to-pattern: a def rebuild whenever a name count changes would fire mid-set.
    - Names past the cap share the last socket and reprogram it, with one warning.
    - The Node scheduler picks the socket per onset and sends it with noteOn/noteOff — a
      language-side "active socket" would race the lookahead, since notes and swaps arrive early
      and out of order. A noteOff must go to the socket its noteOn went to, so pair them rather
      than recomputing at offset time.
    - New engine args (`loadInstrument`, `noteOn`/`noteOff`, `setPluginState`) must be forwarded
      through web-app/param-mapping.js's MappedEngine or they silently no-op.
    - Open question: `.param("Cutoff", …)` addresses a slot. With several instances in it, fan the
      modulation out to ALL of them — a param is that plugin's, and presets are variations of one
      plugin; targeting only the sounding one drops the modulation at every swap.
