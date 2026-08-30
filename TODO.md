# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] Keylock on Linux/Windows: the decks' keylock is the PoptartPitchShift UGen (Rubber Band Live
    Shifter, packages/osc-engine/native/rubberband/) and only the macOS universal .scx is built
    and committed; elsewhere extensions.js finds no prebuilt, logs it at boot, and the def falls
    back to the in-graph SOLA stretcher (works, audibly rougher on dense mixes). The code is
    portable - the work is a build per platform, and it has to be built AND run on that platform
    (no cross-compiling scsynth plugins), so each needs a machine or a CI job:
    - Linux: a build.sh branch - g++ -shared -fPIC, drop -framework Accelerate and let
      RubberBandSingle.cpp use its built-in FFT (it does so automatically off Apple), define
      SC_LINUX instead of SC_DARWIN; one .scx per arch (x86_64, aarch64). extensions.js already
      knows ~/.local/share/SuperCollider/Extensions. ~half a day with a box to test on.
    - Windows: the .scx is a DLL from MSVC (mingw builds generally don't load in scsynth),
      SC_WIN32 in the headers, Rubber Band's single-file build supports MSVC; Extensions path
      is %LOCALAPPDATA%\SuperCollider\Extensions (extensions.js has it). A day-ish, mostly
      toolchain; keep the .scx name so the class file is shared.
    - both: keylock-sclang.test.js already branches on HAS-RB, so it verifies whichever path is
      installed; add a build-matrix job that commits (or releases) the artifacts rather than
      asking users for a compiler - see the header comment in build.sh for why.

[ ] Keylock control lag - uniform-latency graph option: with key on, a deck's controls (nudge,
    jog, cue jump, pause/resume) take effect ~60 ms after the gesture - the pitch shifter's
    pipeline (~rbDelay, probed at boot). The beat grid and position report are already
    compensated, so this is reaction time only, not an offset between decks, and it can't be
    removed: any phase-vocoder keylock needs that look-ahead. What CAN change is the asymmetry:
    today a keylocked deck reacts 60 ms slower than a repitched one, and toggling key changes
    how a deck feels. The option, to try only if that asymmetry turns out to bother in a real
    mix, is a uniform-latency processing graph - every song player carries the same pipeline
    constant whether or not the shifter is in the path (the repitch def gets a DelayN of
    ~rbDelay and the same early-spawn handling in songStart, so its grid and report stay
    compensated exactly as the keylock player's are). Decks then match each other and key
    becomes a pure sound change. The cost is real - the repitched deck gives up 60 ms of
    responsiveness it didn't have to - which is why it isn't the default. Plausibly how
    commercial DJ software ends up uniform (one fixed graph per deck), but that's a guess about
    closed products, not a spec.

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

[ ] Modulation phase 2 - compile composed modulator expressions to a UGen graph, so a composed
    envelope is as snappy as a lone one. Since 2026-08-26 every modulator is an honest Sig: a
    control assigned ONE whole modulator runs natively (sample-accurate), anything composed -
    env().mul(lfo()), an env() under .when(), env().add("0 0.1") - is polled at 30 ms and ramped
    engine-side (poptart_ramp bus). Right resolution for a slow product, wrong for a 1 ms pitch blip.
    The fix is a general mechanism, not a special case: (1) pattern-core records an `expr` tree
    beside every combinator's sample() closure (named ops add/sub/mul/div/min/max/pow, the unops,
    range/clamp/when/seg; leaves = the existing lfoIR/envIR/ccIR, constants, and a JS leaf for
    anything else - mini strings, irand, an arbitrary mapValue); sample() stays the source of truth.
    (2) A JS leaf compiles to a Ramp.kr control input the scheduler polls - the ramp bus already IS
    a JS-driven control input - so nothing is uncompilable: env().mul("0.5 1") runs the envelope at
    audio rate and only the step pattern at 30 ms. (3) One sclang handler setParamExpr(track, slot,
    name, tree) walks the JSON into UGens (the poptart_lfo_* bodies refactored into a function;
    IEnvGen for drawn shapes; EnvGen on \gate for env; In.kr of the cc bus; Select.kr for .when();
    Latch/Impulse for .seg()), leaf tunables as named control args so a same-shape re-eval is a .set
    (phase/gate preserved), a changed shape recompiles async and swaps on the same bus with the
    shape-swap glide; def name = hash of the tree; one unified track[\mods] dict absorbs
    lfos/envs/ccs/ramps and the noteOn hooks gate every entry. (4) Scheduler: one entry per control
    holding the tree, polls JS-leaf inputs + dynamic args, anchors per free-LFO leaf (t_trigN);
    forward the new method through MappedEngine. Then delete setParamLFO/ShapeLFO/Env/CC. Risks:
    JS-vs-UGen numeric agreement per op (pin both in tests, as the shapes already are), compile
    latency on structure change (ms, async - same as a shape edit). About a focused week. Not urgent
    until the 30 ms composed case actually bites in practice.

[ ] Stepped plugin parameters - the ramp bus glides every polled control over 30 ms, which passes a
    selector-type parameter (filter type, wavetable index, an on/off normalized to 0..1) through
    every intermediate value: `.param("Mode", "0 1")` momentarily selects a wrong mode, possibly with
    a click. Channel selectors (out/cue/mdeck) are already set outright (steppedChannelControls in
    poptart.scd); plugin parameters need a `stepped` flag per parameter in mappings/*.json (preferred
    - it's a property of the parameter, not of one pattern) so setParam bypasses the ramp for them.


[ ] Harmony & melody tools - phased plan settled 2026-08-30. Everything operates on the ROLL'S OWN
    NOTES (prState.sel or hovered note -> pure notes->notes function -> writePianorollCall +
    drawPianoroll, exactly the prToggleMute/prDuplicate shape) so results stay hand-editable;
    undo/overlap/serialize come free. Theory lives in pattern-core/src/harmony.mjs (dependency-free
    beyond notes.mjs, served under /pattern-core/ like notes.mjs, unit-tested; the roll already has
    prScaleInfo + the global scale for "in key"). UI surface: right-click over the NOTE GRID is
    unbound (the contextmenu handler only opens the lane menu below laneTop) - one transform menu
    there (Harmony / Melody / Rhythm submenus, reusing prMenu/openCtxMenu), hotkeys later as
    accelerators into its top items; in-roll plain letters are mostly free (b = tool, 0 = mute).
    Non-negotiable UX: hover a menu entry auditions the result through the track's synth
    (prPreview machinery), commit on click, Escape reverts. Phases 1-4 (theory module, chord/
    voicing menu, rollops.mjs transforms + chance ops behind parameter popovers, generators) are in; delete each remaining phase as
    it lands:

[ ] Cascara for RHYTHM_FIGURES (pattern-core/src/rollops.mjs): the timbale-shell pattern is the
    most-heard groove missing from rhythmize, skipped 2026-08-30 because no source commits to one
    canonical form: the only explicit grid found (Soundbrenner) is a 7-stroke X--X--X-|-XX-X--X,
    drum pedagogy (Malabe/Weiner lineage; Dicciani's Afro-Cuban PDF engravings) teaches a
    10-stroke shell pattern and presents SEVEN variants per clave direction, and 2-3 vs 3-2 is a
    half-cycle rotation sources disagree on as the default. To ship: either the 7-stroke under the
    hedged name "palito" (it's 3-2 son clave + two pickups), or transcribe the 10-stroke from the
    Dicciani engraving by eye (accents carry the risk). Aria's call which.

[ ] Harmony phase 5 - next-chord suggestions: functional-harmony transition table (T->S->D->T,
    circle-of-fifths pull, secondary dominants + modal interchange as a "borrowed" section),
    deterministic ranking + seeded tiebreak, repeated invoke cycles alternatives; add a
    voice-leading pass (minimal total movement picks the suggested chord's inversion) which also
    improves the phase-2 voicing menu's ordering. Build last - most design-heavy.
