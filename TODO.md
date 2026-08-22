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
[ ] Mixer analysis: peak followers → RMS, and a true windowed correlation. The band analyzer in
    sc/poptart.scd (`buildMixDef`) measures each band with `Amplitude.kr`, which peak-follows the
    rectified signal. Two consequences, both display-only — nothing here affects audio:
    - The spectrum reads peaks, not energy, so it sits higher and jumpier than an RMS analyzer
      and the makeup constant (`MIXER_SPEC_MAKEUP_DB` in client.js) is tuned around that.
      `RunningSum.rms` or `Integrator` on the squared signal would give real band energy.
    - The stereo image's angle is `atan2(|side|, |mid|)` of two independent envelope followers,
      which approximates correlation rather than measuring it. The exact relation is `r = cos 2θ`
      (hence the ±45° safe lines being r = 0), but that identity assumes equal channel power and
      a proper statistical average — so a hard-panned *and* phasey band reads approximately, and
      brief attack/release mismatches between the two followers make θ wobble. A real windowed
      correlation per band — `E[LR] / sqrt(E[L²]E[R²])` over a short window, all three sums
      available from the same filtered pair — would be both more honest and cheaper to explain,
      and would let the display show a signed correlation number per band.
    Worth doing together: both are the same change to how the bands are summarized, and the
    client's `mixerBandLevel`/`mixerBandAngle` are the only readers.

[ ] Live-audition a shape while its breakpoint is being dragged, the way the mixer's channel
    holds do (`Scheduler#holdChannel`). The LFO panel writes the call on release and re-evaluates
    150ms later (`lfoScheduleEval` in client.js), so a shape being drawn is silent until you let
    go — the same complaint the mixer had, but it can't be fixed the same way.

    A drawn shape reaches the engine as a whole modulator IR (`_sendModulator` in
    pattern-core/src/scheduler.mjs, where `lfoShapes(ir)` turns the name into `points`/`shapes`),
    and the only in-place update sc/poptart.scd offers is `setParamShape` — an index swap between
    shapes compiled *up front*. There is no "replace these breakpoints on the running synth", so
    live dragging means re-sending `setParamLFO`, which restarts the shape's phase (see
    `phaseOriginSec` in `_anchorLFOs`): every mouse move would retrigger the LFO.

    So this is an engine change, not a client one — a `/poptart/setParamShapePoints` that rewrites
    the running shape buffer while leaving the phase pointer alone, then a hold on top of it. Only
    worth it if drawing-while-hearing turns out to matter; the 150ms debounce already covers
    "pause mid-drag and listen", which may well be enough.

[ ] Evict sample packs that haven't been played in a while. Packs load whole and stay for the
    session (`_packs` in osc-engine/index.js, `samplePacks` in poptart.scd) — nothing frees them
    but reloading the same pack. numBuffers is 16384 now so the *count* is fine, but the audio is
    real RAM: a 15G library is only a few big packs away from hurting. Wants an LRU keyed on last
    play, freeing the SC buffers and dropping the Node entry so the next event reloads it.
[ ] A selector join drops its children's note channels. `selectorJoin` (pattern-core/src/signal.mjs)
    returns `new Sig(sample, { stepsForCycle })` — the child's *events* come through, its
    `noteChannels` do not. So `cat(s("hh*8").swing(1/3), s("hh*8"))` plays dead straight, and the
    same goes for anything a child carries as a channel rather than as a stamp on the event: swing,
    swinggrid, a `.nudge()`/`.vel()`/`.clip()` attached to the child rather than merged into it.
    `buildJoin` carries pitchKind and the instrument chain across, but nothing else.

    Found 2026-08-22 via the piano roll: a roll's own swing lives on `noteChannels`, so a roll played
    by NAME — `pianoroll("<0 chorus>")`, which is every roll with an id — swung not at all, while the
    panel's commit button appeared to work because it writes per-note nudges and those are stamped ON
    the event. Fixed there by stamping the roll's swing onto its steps as well (the tail of
    `pianoroll()`), which is a fix for rolls, not for the join.

    Why the general fix wasn't taken: the honest version is for the join to sample each child's
    channels at each contributed step's onset and stamp them, which is defensible — a join is a cut
    between running patterns, so flattening a child's channels onto the events it contributes says
    exactly what is heard. But `channelAt` prefers a stamp over a channel, so stamping every channel
    would invert precedence for anything set on the OUTSIDE: `cat(a, b).vel(0.5)` would stop
    overriding a vel that `a` already carried. Getting that right means deciding, per channel, who
    wins when both an option and the joined pattern set it — a real design question, not a patch.

    One channel bundle genuinely can't answer for every option (the pick is per cycle), so whatever
    is decided, the data has to end up on the events. The question is only whether the outer
    pattern's later word can still clear it, the way `crossMerge`'s clear-then-restamp does today.

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
