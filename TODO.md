# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] LUFS metering in the ctrl+g console — short-term and integrated, alongside the existing
    stereo/spectral views.

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
      asking users for a compiler - see the header comment in build.sh for why. The same job
      should build the poptart-link helper (see its own entry below), which needs the same
      per-platform machines.

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

[ ] Deck looping - song decks. The shape to build is the one every club deck has: an AUTO BEAT
    LOOP of N beats (1/8 up to 32) armed at the playhead and snapped to the beatgrid, MANUAL
    in/out, HALVE/DOUBLE anchored at the in point, EXIT (play on past the out, loop remembered)
    and RELOOP back into it, loop MOVE by the loop's own length, and the region drawn over the
    waveform with draggable ends. Give every one of those a MIDI target as it lands - those pads
    exist on hardware, and targets are cheap now that buttons are a kind the dispatch knows about
    (see the mix-strip MIDI section of server.js).

    Build the wrap INSIDE the player def. poptart_song_* / poptart_songwarp_* already carry a
    Phasor for the position report and a PlayBuf that takes t_seek + seekFrame: add loopStart /
    loopEnd / looping controls, fold the Phasor into the region, and fire t_seek at loopStart off
    that fold. Sample-accurate at any length, with Node setting two numbers and timing nothing.
    Keeps PlayBuf, so it does not reopen the float32 phase problem the precision note in that def
    is about. Take it alongside the def's self-gate at EOF (see the deferred oddments above):
    both are the same admission that the player should know where it may not read past, and one
    pass gets them both.

    The alternative - Node arming a timer and sending songSeek a little early - is not ruled out
    by loop LENGTH, as an earlier pass here claimed. The sclang handler applies the seek inside a
    future-timestamped bundle, so the wrap lands on the sample whatever the timer did, and a
    short loop just means queueing several wraps ahead. It loses on upkeep instead: every queued
    wrap is wrong the moment the rate moves, and the rate moves on every nudge, sync change and
    servo trim. The def version holds no such state.

    What either way still needs Node-side: beat lengths off the existing beatgrid (s.bpm +
    s.anchorSec + songGridBpm, with songSync.snapToGrid); the linear playhead model folding the
    wrap in, or the loop is invisible to the pane and to the end timer; the end-of-file timer not
    firing inside a loop; a re-arm on rate changes (one call site, songApplyRate); and a ruling
    per gesture on whether cue / seek / nudge / a platter scrub breaks out. Keylock needs nothing
    - the warp def folds the shifter's pipeline delay into seekFrame, so a wrap lands in time
    with key on. ~a day and a half all in.

    Ruling on the gestures: cue, seek, scrub, search and beat jump exit the loop and remember it
    (RELOOP brings it back); nudge and the tempo controls do not.

    The beat JUMP buttons should take their size from the loop-length selector, the way the newer
    players do - so the selector is built once and drives both.

[ ] Deck looping - livecode decks. Same buttons on the deck as the song half above, and the same
    mechanism one level along: a song deck loops by rewinding a read pointer into the file, and a
    livecode deck loops by rewinding a read pointer into a CAPTURE of what the deck just played.

    Capture, not retrigger. Re-running the patterns over the loop's bars chops every release tail
    and every fx tail at the wrap - the note still ringing is cut off and struck again - and it
    cannot do a sub-beat loop at all, because the material inside one is not a note grid. Audio is
    exact by construction: what repeats is what you heard.

    So: a rolling capture per deck. The deck's bus (see the DJ FX units entry below - the same bus
    serves both, so build it once) feeds a RecordBuf with loop 1 into a fixed ring, always
    running, a few seconds long. Arming a loop FREEZES the ring and plays [playhead - N beats,
    playhead) out of it; exiting resumes writing. Because the ring is already full when the button
    is pressed, a loop of any length up to the ring arms RETROACTIVELY and bites instantly, which
    is the half of this that makes stutters usable at all. The plumbing is nearly there: the track
    def already has a recOut/recSend tap into a bus and there is a DiskOut synth reading one (the
    bounce path in poptart.scd), and a ring is that with RecordBuf in place of DiskOut. Sixteen
    seconds of stereo at 48k is about 6 MB a deck, so the ring can be generous.

    The patterns keep running underneath, unheard, for as long as the loop sounds. That is what
    makes the exit seamless - the deck is still exactly where the transport is, so dropping out is
    just unmuting - and it is why this needs no Scheduler changes at all. It also means a loop
    longer than the ring is simply not offered.

    HALVE/DOUBLE, MOVE, EXIT and RELOOP are then all edits to the read window over one frozen
    ring, so they cost nothing extra. Loop MOVE off the ring's edge is the one case to rule on:
    clamp at the oldest sample the ring still holds.

    Beat JUMP and play-from-bar-N on a livecode deck are a different job (a per-deck cycle offset
    in the Scheduler) and should not be bundled into this one.

[ ] DJ FX units. Every track already carries seven fx slots with a per-slot dry/wet (Sig#wet, the
    linear crossfade in the track def) and loadEffect/setParam are wired, so a performance
    effects unit is a UI over machinery that exists: pick a plugin, an ON pad, a WET knob, and one
    of the plugin's own parameters on a second knob. Every one of those gets a MIDI target as it
    lands, the ON pad in both flavors the hardware has - momentary while held, and latched. The
    unit is a mirrored pair like the rest of the desk.

    WHERE IT LIVES is the design. A song deck is ONE track, so a unit on it could ride that
    track's own chain. A livecode deck is many tracks with no submix, and loading the same reverb
    on each of them is both expensive and wrong (the tails sum). So: a per-deck BUS track that
    the deck's tracks route into, with the unit on the bus. The routing exists already - .bus()
    sends and an `audio("name")` head reads the sum - what is new is the server creating that bus
    per deck implicitly, pointing the deck's tracks at it, and hanging the unit off it. Master is
    the same mechanism once more, on the `main` group root (which ARCHITECTURE.md already names
    as where a mastering chain goes).

    Three things fall out of the bus, in rough order of how much is left to do after it: the DJ
    strip stage (trim, the EQ isolator, djf/djres, fader) can move from per-track to per-bus,
    which is what it has always modeled; a livecode loop-roll gets somewhere to capture from (see
    the looping entry above); and the deck meters have one place to read instead of eight.

    Tempo-synced effects need nothing - the plugins' host transport is already synced and jumps
    with the grid (syncVstTransport).

    The one hold: a plugin cannot be added to a running chain (the SynthDef scaffold note in
    poptart.scd), so the unit's slots are allocated up front. Three per deck is the number to
    start with; choosing a plugin into an empty slot costs a load, and the pad is live only once
    it is open.

    Parameter picking is solved. /api/params lists a slot's real VST names, the editor's params
    panel already renders that list, and real-world units come free through param-mapping.js
    wherever a mappings/*.json exists - so the unit's second knob is that list plus one learned
    cc.

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

[ ] `.warp()` - stretching, the half the waveform view can only show you the need for. What landed
    2026-09-18: a roll offers only the axes its chain is about, and a `wave` view draws each note's
    own audio inside it - laid against time, so a box too short cuts the waveform off at its edge
    and a box too long leaves the rest of itself empty, which is what each of those sounds like.
    prNatCells is where a file's length under a chain is worked out, and it already folds in fit,
    speed, stretch and the note's own repitch around MIDI 60. What none of it can do is change how
    long a sample LASTS without changing its pitch, so a stem written at another tempo still has to
    be `.fit()`-ed whole and a phrase that drifts cannot be pulled onto the grid at all.

    The command is `.warp()` on a sampler chain, no argument: play this chain's files keylocked at
    the song tempo, against their own beatgrid. The engine half is machinery that exists - the song
    deck already plays a long file at a tempo ratio through the PoptartPitchShift UGen, and
    song-detect.js's fitBeatGrid already gives a file its native tempo and downbeat. What is new is
    that the rate becomes a CURVE rather than one number: an envelope over the note, piecewise
    between the markers, so the audio between two of them is stretched by whatever it takes to get
    from one to the next. Warp1 stays for `.stretch()` on short hits - it is the better answer for a
    patterned factor, and it is already correct there. (`warp` is also an internal flag name on the
    song decks for exactly this player, so keep the two straight.)

    Markers live on the FILE. A stem placed in the intro and again in the drop wants the same warp
    both times, and there is already a per-file marker editor to hang them on: the slice panel's,
    whose markers are dragged on the waveform and filed in the pack sidecar. A warp marker is that
    object with a second coordinate - a position in the file AND a position on the grid - so the
    panel grows a marker kind rather than a second editor. It then wants a bpm field prefilled from
    the detector and a quantize button that snaps every detected transient to its nearest grid line
    and writes the pairs, which is the whole of "quantize this audio".

    The roll needs nothing new for it. Warping a chain changes what prNatCells should answer, which
    is one more factor in a function that already takes four - and the `wave` view then draws the
    stretched length, so the picture keeps agreeing with the sound for free.

    NOT per-note regions. Per-note begin/end were built and taken back out the same day (2026-09-18):
    they wanted a region editor to be edited in, which wanted the note format to carry fades too, and
    the format is positional - it was heading for ten fields where a note that sets one writes nine
    ahead of it. The chain's own `.begin()`/`.end()` cover what long material actually needs, and the
    waveform is the part that was worth having. Don't revive them without a reason the chain can't
    meet.

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
    Dicciani engraving by eye (accents carry the risk). Undecided which.

[ ] Harmony phase 5 - next-chord suggestions: functional-harmony transition table (T->S->D->T,
    circle-of-fifths pull, secondary dominants + modal interchange as a "borrowed" section),
    deterministic ranking + seeded tiebreak, repeated invoke cycles alternatives; add a
    voice-leading pass (minimal total movement picks the suggested chord's inversion) which also
    improves the phase-2 voicing menu's ordering. Build last - most design-heavy.

[ ] MIDI clock in - follow an external MIDI clock (24 ppqn ticks + start/stop/continue/song
    position) for hardware and apps without Link. Assessed 2026-09-12, 1-2 days, mostly tuning:
    sclang's sysrt MIDI responders receive the ticks; a smoothing filter (a PLL over the last N
    tick intervals - USB MIDI clock is famously jittery) estimates tempo and beat phase, then
    forwards to Node as a (tempo, beat at a moment) report and rebases the transport with
    Transport#setCps for tempo and a phase shift for beat - the same follower Link already
    has (server.js's applyLinkReport over link-sync.js; a MIDI clock report can feed it as a
    second source). poptart always follows here (the 150 ms lookahead is fine for that). Strudel
    can't do either (browser, no clock sender in its midi package), so Strudel -> poptart stays
    a live note feed.

[ ] Link on Linux/Windows: the session peer is the poptart-link helper
    (packages/osc-engine/native/link/) and only the macOS universal binary is built and
    committed; elsewhere helperAvailable() is false, the settings toggle is disabled and says so.
    Unlike the keylock UGen this is an ordinary executable, not an scsynth plugin, so it is
    plain C++ with no SC headers: a build.sh branch per platform (Link's own CMake handles
    Linux/Windows, or keep the one-line clang++/g++/cl invocation and swap
    -DLINK_PLATFORM_MACOSX for LINUX/WINDOWS and CoreFoundation for the platform's socket libs).
    Must be built on the platform it runs on, same as the keylock builds above - do them in one
    CI matrix job. link.test.js already skips when the helper is missing, so it verifies
    whichever path is installed.

[ ] Bonjour announcement of the OSC input port off macOS: bonjour.js announces "_osc._udp" via
    the system's `dns-sd -R` (so TouchOSC's Browse finds the machine) and is a logged no-op on
    Linux/Windows. Cross-platform means a pure-JS mDNS responder (e.g. the bonjour-service
    package) in place of the child process - same handle shape ({ pid: null, stop() }), no
    pidfile entry needed since nothing outlives Node. Do it alongside the keylock Linux/Windows
    builds above, which need the same test machines.

[ ] Web build - poptart in the browser: native Web Audio synths/effects behind the same
    synth()/fx()/param() DSL, the sampler, pianoroll, arrange and the other widgets kept; DJ
    mode, plugin hosting, OSC input, Link and the sample map stay desktop-only. Planned
    2026-09-18, nothing built, ~3-4 weeks to a v1. A public, static site (no backend, no
    accounts); AGPL section 13 means a source link in the UI.
    Shape: a second target in this repo, not a fork. The server's host role (routes table, eval,
    Scheduler, Transport, highlight grid) runs in a Worker; engine calls cross as timestamped
    postMessage, the same model as the OSC bundles; a WebAudioEngine implements the ~30 engine
    methods the scheduler calls (getTime = AudioContext.currentTime). client.js keeps its /api
    calls behind a thin transport. main must not be put at risk: no up-front server.js split -
    the web host starts with its own rough copy of the evaluate wiring and logic is extracted
    from server.js lazily, one pure-move function at a time. Grow the MappedEngine forwarding
    test into a conformance suite both engines run.
    Order: (1) spike, ~2 days - Worker host + AudioBufferSourceNode sampler, first sound from a
    static page, proves the clock model; (2) host port - storage adapter, sample packs by URL +
    drag-drop + (Chromium) a picked folder, widgets answering; (3) track graph - chains, bus
    sends, teardown on re-eval, modulators as AudioParam ramps (native LFOs later), devices,
    a generic device panel generated from the param descriptors (no plugin editor windows
    here); (4) wavetable synth, sampler warp (needs a stretcher - read what the SC warp def
    does first and match its character), recording, Web MIDI.
    Devices are web-only in v1 (mirroring them into SC is a later, optional job): built-in
    nodes for filter/delay/compressor/distortion, a hand-written AudioWorklet for an
    algorithmic reverb, and the wavetable synth as a plain JS AudioWorklet with internal voice
    allocation (2 oscs with table/position/level/detune/unison, sub, noise, filter, amp + filter
    ADSR in seconds, glide; loads the common 2048-sample-frame wavetable WAVs). The param
    descriptor (id, names, units, ranges) is the contract a later SC mirror would match, so
    the care goes into names and units; write the voice flat and allocation-free so it ports.
    A shipped device's sound is frozen - shared songs depend on it - so a better reverb is a new
    id or version, never a silent swap. On desktop an unknown web device warns and plays silent.
    Public-site constraints: shared code never auto-evaluates, and everything the host touches
    goes through messages so it can later move into an opaque-origin sandboxed iframe (a Worker
    alone is same-origin: saved songs and persisted folder grants are readable). Define one JSON
    song bundle (pattern text + rolls + macros + whatever else lives outside the text) first -
    it is the storage unit, the export file and the share payload. Storage is browser-local:
    IndexedDB (localStorage's ~5 MB cap is too small for wip history and rolls),
    navigator.storage.persist(), an export button. Default sounds: host our own copy of a
    cleanly licensed set (VCSL is CC0; the classic drum-machine and Dirt sets that Strudel
    serves from its CDN have murkier licensing - read the dough-samples README before relying
    on them, and never hotlink another project's CDN). No code is copied from superdough.
    Open: the v1 device list above is a first draft; delay time in seconds (consistent with
    the physical units elsewhere) or in cycles (more natural in a pattern language).
