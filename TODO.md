# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] Song decks - real audio files (a bought track, a bounce) on a DJ deck, mixed through the same
    desk as pattern decks. Settled 2026-08-25: the song is ONE ordinary engine track (key `#song`,
    deck b `b:#song`) whose input is a long-file player synth instead of a scheduler, so the whole
    strip (xf, EQ, djf, fader, meters, cue, per-deck stop) applies unchanged. Phases below are
    separate entries; delete each as it lands.

[ ] Songs phase 1 - engine + endpoints: poptart_song_* player defs (Phasor/BufRd; rate/run/seek
    controls), songLoad/Start/Set/Seek/Stop/Free engine methods (forwarded through MappedEngine),
    /api/song/* (load/play/pause/seek/stop), afconvert decode cache for mp3/m4a under
    ~/.poptart/cache/songs (wav/aif/flac go to Buffer.read directly), cycle-quantized start, and
    mix-desk integration (deck broadcasts, clear/eject/stop reach the song track). Whole file
    RAM-resident (a 5-min song ~50MB stereo) - no streaming; scrubbing wants random access anyway.

[ ] Songs phase 2 - playlists hold disk files: typed items ({ kind: 'file', path, title, bpm, key })
    beside saved-name strings in library.json; a server-side file browser to pick them (the client
    can't produce disk paths); deck B's queue offers both kinds; a missing file renders as missing,
    same contract as a deleted save.

[ ] Songs phase 3 - the song deck pane: when the queued item is a file, the deck shows a
    high-resolution DJ waveform instead of CodeMirror - band-colored peak/RMS columns (generalize the
    recorder's canvas renderer + analysis-worker pass, which already do exactly this), full-track
    overview + zoomed scrolling strip, beatgrid + playhead overlays (client mirrors the transport
    clock - engine getTime is Date.now()/1000), click/drag scrub -> songSeek, audition via cue.

[ ] Songs phase 4 - tempo/key + sync + nudge: parse tags (ID3 TBPM/TKEY, vorbis comments, m4a
    tmpo) for bpm/key; native bpm feeds decks[].bpm so /api/mix/tempo migration works unchanged;
    rate lock (rate = master/native; repitch default, Warp1 keylock as an option), beatgrid-anchored
    quantized start, drift servo (expected vs actual playhead, gently trim rate - Node clock and
    scsynth's sample clock drift over minutes); nudge = momentary rate offset + phase jog buttons,
    MIDI-learnable via mixMidi. bpm and grid anchor always user-editable.

[ ] Songs phase 5 - detection fallback when tags are absent: BPM via onset-envelope
    autocorrelation, key via chroma + Krumhansl profiles, in analysis-worker (transient detection
    already lives there); show confidence, keep manual override. Everything earlier works without
    this via manual entry.

[ ] Songs - deferred oddments: complete-mix with a song-ONLY deck b (the promote guard wants
    schedulers today); end-of-file stop is a Node-side timer (the Phasor would wrap and replay
    otherwise - give the def a self-gate later); decode-cache eviction (cache/songs grows
    unbounded); song-deck rows in the strip's per-stem gate list.

[ ] Preset morph: `preset("A").morph("B", sig)` interpolates the plugin's *parameter vector*
    (VSTPlugin getn/setn), not the opaque .fxp chunk - the chunk (wavetables etc.) is why a Serum
    preset is 5MB and it can't be interpolated. Capture the vector with getn at preset-save time
    (the instance is in that state right then) and store it beside the blob; backfill old presets
    on next load. Morph A→B = load A's chunk as usual, then slide only the params that differ
    between A and B toward B (a few dozen, not the 1000+ the plugin exposes). Limits to document:
    non-param state (wavetable choice, FX order) can't morph; discrete params step through their
    intermediate options - `morph({ except: [...] })`, or detect discreteness once per plugin by
    probing the /vst_param display string at a few values and caching it.

[ ] MIDI-FX plugin hosting in the note chain: `note(...).midifx("SomeArp").synth("Serum 2")`.
    VSTPlugin delivers plugin MIDI-out to sclang via `midiReceived`, not plugin-to-plugin on the
    server, so the arp's notes take an OSC round-trip before reaching the synth (a few ms of
    latency/jitter; fine for arps/chord tools). Same path means the output can be captured as a
    pattern later (freeze-to-code).

[ ] `mutate()` - for presets: a seeded random walk over a subset of params (reuses the A/B param
    diff from morph to decide what to touch), evolving per cycle, diff shown in the preset panel.
    For patterns: seeded per-cycle variation of the pattern's events.

[ ] Arrangement: `arrange()` opens an arrangement painter - rows are labeled blocks,
    columns are cycles, paint cells to say when a block is audible. Stored like a pianoroll
    (registry object serialized into the file, panel in the sidebar) and round-trips to a text form
    (`arrange({ kick: "0-8 16-", pad: "8-16" })`). The scheduler masks each label's pattern by its
    painted ranges. NOT a label-token mini string - a section is a *set* of blocks, which is why
    muting several tracks at once was the blocker. To settle: blocks not referenced by the
    arrangement keep playing live (probably yes - that's what keeps it livecoding).

[ ] Alt+drag scrubbing in the editor: on a numeric literal, drag scrubs the value (hot reload
    applies it live); on a string literal in a known list (sound names, presets, scales, lfo
    shapes, plugin names) it steps through the completion list - live-apply for sounds/scales,
    debounce to drag-end for plugin/preset loads. Alt+horizontal drag inside a mini string rotates
    its tokens.

[ ] `env(source)` as an envelope follower: `env("kick")` / `env(audio("kick"), { attack, release })`
    delivered as a control-rate signal the way midicc is. Same word as the note-driven ADSR
    (attack/release mean the same thing in both); the source decides which it is. Unlocks ducking
    without a compressor, `param("Cutoff", env("kick").range(...))`, etc.

[ ] `smooth(t)` - exponential lag on any signal (what lfo glide does, generalized). Not `slew`.

[ ] `read("label")` - another block's Signal as a signal: `.note` / `.vel` (held since its last
    onset), `.trig` (1 at its onsets, usable as struct). No event bus: both patterns are
    deterministic functions of cycle time in one scheduler, so it's a registry lookup that queries
    the other block's Signal at eval time. Warn on read cycles (a reads b reads a). A muted block
    still reads (Cirklon-style: muted tracks keep clocking).

[ ] `count()` - onset counter for the track (or `count(read("x").trig)` for another's), defined as
    the onset integral from cycle 0 so it's pure, survives re-eval and can be cached with cumulative
    sums per cycle. `.mod(4)` gives "every nth hit"; `y.rot(count(read("x").note.gt(24)))` is the
    Cirklon "when X does this, do that to Y" idiom.

[ ] `rot(n)` - rotate the pattern by n steps; n patternable/signal-driven (pairs with count/read).

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

[ ] Performance mixing - two decks, one engine (designed 2026-08-24, all decisions settled with
    Aria; build phases below are separate entries). One shared Transport: evaling a deck joins the
    absolute cycle count in phase, and multi-cycle structures land on the same mod grid
    automatically - there is no "launch", no quantization machinery, no sync button. Settled:
    - "Silent" deck = the mixer state it arrives with (crossfader fully at the playing deck), NOT
      a mute mechanism; the queued song runs in full, ~2x plugin CPU accepted for predictability.
    - Deck-scoped song settings (scale/setbpm/swing become per-deck facts); Signal.prototype stays
      shared, warn on redefinition, last eval wins; consts already per-buffer.
    - Global equal-power crossfader over deck gains + per-track faders; no third fader type.
      Clobber mode = same-label stems linked as one-gesture toggle swaps (never literal track
      sharing - both kicks are separate engine tracks; swapping chains mid-mix would reload
      plugins audibly).
    - Tempo migration, not matching: the ramp/slider moves master cps between the songs' native
      bpms (natives tracked per deck). Transport needs cps ramps w/ continuous cycle position;
      VST bpm mirroring + engine LFO rates follow.
    - Samples keep natural rate through migrations (chop feel; whole-cycle loops get .slice()d);
      per-track repitch-follow flag is a possible later add on the existing repitch channel.
    - Performance state (XF, deck gains, EQ, filter, gates) is EPHEMERAL - never written into song
      code, deliberately unlike mixctl's .gain() edits. Dies with the mix session.
    - Deferred: per-deck cycle rotation (deck-wide .late(k)); repitch-follow; cue/master blend.

[ ] Mixing phase 1 - label→trackId indirection: engine tracks get opaque ids (t1, t2, ...);
    server.js owns label↔id registry (persists per label for the server's life - no destroyTrack
    exists, tracks are forever). Scheduler takes the id as trackId plus a display label for warn
    strings. Translate at every boundary: API handlers (labels in), wireEngine callbacks (ids
    out - note feed, param gestures, pluginEdited, mixer meters), recordings filenames stay
    label-named. This is what makes complete-mix pure re-labeling with zero engine churn.

[ ] Mix MIDI-learn, phase 2 ideas (phase 1 - crossfader + deck controls via settings.mixMidi -
    shipped 2026-08-24): per-stem faders (needs stable addressing across songs - maybe "the Nth
    stem of deck B"), buttons for gates/swap/tempo detents (CC 127/0 edges), and a MIDI map
    panel showing what is bound where (today it's the console lines + settings.json).
