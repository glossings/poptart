# poptart — TODO, in detail

The long form of TODO.md: constraints, file pointers and open questions per entry. Delete an
entry here when its TODO.md line goes.

[ ] Gain staging. A pad, if one comes back, must not depend on DJ mode: padding only there makes
    toggling the desk jump a playing code deck, and neutralizeMix (deck:1) strips it from a
    promoted track. The cue tap sits before the `deck` gain, so a deck-gain pad never reaches the
    headphones. No master clip at 0 dBFS: scsynth already clips at about +2 dB on macOS
    (ServerOptions.safetyClipThreshold, 1.26), and the range above 0 survives wherever the output
    is not a converter at full volume. Remaining:

    1. setgain() - a song-level master gain beside setbpm (HOST_BUILDERS), applied once per
       audible path at the DJ-stage input: before the cue tap, so the headphones hear it, and
       never on sends, which would square it on bus paths (the rule the `deck` gain follows).
       Scalar 0..4, linear like postgain.

    2. setgain written into the saved songs (never wip/), idempotent, at the top below the
       leading comments, then each song set by ear against the clip light. Not by measured
       peak normalization: headless renders of plugin songs segfault on NI licensing, and
       matched peaks don't match loudness. Target about 1 dB under full scale, for inter-sample
       peaks.

    No whole-song master bus: tracks pick their own output pairs with .o(n), and the desk
    re-routes nothing. Per-song master processing is a top-level group(), which composes with
    setgain - members' direct paths are silent, so the gain still lands once.


[ ] Ship the plugin host fix for bundles with several plugins inside. A bundle's plugins are
    probed side by side, and two copies of one binary starting at once can knock one over; the
    cache then lists only the survivor, and the other name is unknown to the engine on every
    boot until that bundle's cache entry is dropped by hand. The fix (probe each failure once
    more, alone) is written in the fork's vst/PluginFactory.cpp, unbuilt and unreleased; it
    needs a build per platform, a release, and the new pin in osc-engine/setup.js.

[ ] Remember the small UI state across desktop launches: console open/closed, the settings
    pane's tab, and friends. localStorage is trustworthy now that the desktop port is fixed -
    sweep the toggles that still reset and give each a stored twin. (Quantize and sync already
    survive deck loads server-side, per deck, in-memory - deckSongPrefs.)

[ ] Calibrate platter bend by hand against a reference player. The model already has the
    standard shape - bend proportional to rim speed (bendStep: tick-rate x BEND_SENS toward a
    BEND_MAX cap, exponential release) and the hold-nudge is the classic +-4% (NUDGE_PCT) -
    but nobody publishes a curve, so the feel match is an A/B on hardware: same track both
    sides, nudge to align, adjust BEND_SENS/BEND_MAX until the hand can't tell. One-number
    tweaks, all named in song-sync.js.

[ ] Reach the preset-state-only plugin settings by patching pinned preset blobs. Some of the most
    musically important plugin settings are not VST parameters at all but preset STATE - Serum 2's
    wavetable choice per oscillator, the mod matrix's source/dest routings (only Mod n Amount/Out
    enumerate), which effect sits in each internal FX slot - so no .param() can ever reach them,
    and a palette that needs "this patch, sixteen different tables" means sixteen manual trips
    through the plugin's own browser. But a pinned `_preset()` blob is decodable: b64 -> gzip ->
    VST3/XferJson wrapper -> zstd-compressed CBOR of named fields, which is exactly where those
    settings live. A tool that decodes a base patch, patches named fields and re-encodes could
    GENERATE pinned presets offline from a spec (table name, mod amounts, envelope times), and
    playback then patterns them with the `.preset("<a b>")` machinery that already exists - a
    per-phrase device, since a whole-state push resets sounding voices. First milestone, before
    building anything on it: a byte-faithful round trip of a known blob (decode, re-encode
    untouched, confirm the plugin loads it and nulls against the original), then patch exactly
    one field (oscillator A's table) and verify in the plugin's UI. zstd level, CBOR field order
    and the wrapper framing are the failure modes; if the round trip doesn't hold, the decode
    half is still useful for VERIFYING what a hand-built preset contains.

[ ] Resolve plugin names on demand instead of scanning everything first. A first run with 400
    plugins is 15-20 minutes of probing (serial, ~2-3s each) before a plugin name resolves, and
    that is the first thing a new user sees. The reason a full scan exists is that a plugin's
    NAME is only knowable by probing it - Serum2.vst3 holds both "Serum 2" and "Serum 2 FX", so
    a name cannot be mapped to a file from the file alone. But the file name is a strong hint:
    on `.synth("Serum 2")`, probe candidates ranked by file-name similarity and stop at the
    first whose reported name matches - seconds, not minutes. Probe results are already cached
    per plugin by VSTPlugin, so each one is paid for once ever. VSTPlugin already probes a single
    plugin on demand - VSTPluginController:open -> VSTPlugin:prQuery falls through to a
    /vst_query on one path when the name is not in its dict - so the piece to build is the
    name-to-candidate ranking, a persistent name->path map in poptart's data folder, and crash
    safety.

    The background scan STAYS, automatic, exactly as it is: it is what fills the plugin browser
    and autocomplete (`knownPlugins` in client.js, which is also the completion pool), and a
    plugin's name is not something anyone can guess - "Serum 2" is not Serum2.vst3, and a shell
    plugin's names have nothing to do with its file. Lazy resolution is for USE and the scan is
    for DISCOVERY; making the scan manual would trade twenty minutes of waiting for a permanent
    guessing game. Framed that way this is purely additive and can ship on its own.

    Crash safety is the risk, not the ranking: probing a bad file segfaults scsynth, and the
    scan's protections (non-Mach-O pre-exclusion, the crash journal, per-plugin timeouts) all
    have to cover the lazy path too, or one wrong guess takes the engine down mid-session.
    Also: prQueryLocal does a `server.sync`, so a lazy probe blocks behind a running scan (the
    entry below). Open questions: what to do when no candidate matches; how to present two
    plugins with the same name, or a shell plugin holding dozens.

[ ] Show plugin FILES in the browser before they are probed, so the panel is never an empty
    "scanning…". Node enumerates every plugin file in well under a second (preparePluginScan
    walks the dirs already); only the NAMES need probing. Listing the files immediately and
    filling in real names as they arrive turns a blank twenty minutes into something browsable
    at once, and clicking an unprobed file is a natural place to probe just that one. Autocomplete
    could offer confirmed names plus unconfirmed filename candidates, marked as such.

[ ] Pause the background plugin scan while the transport is playing. Probing is hundreds of
    short-lived processes, which is a dropout risk during a set, and there is no reason for it to
    compete with playback. True today, independent of everything above.

[ ] Finer-grained plugin scan progress. A scan is only saved per folder (VSTPlugin writes its
    cache when a search finishes, and a search takes a directory), so an engine restart in the
    middle loses the folder in progress - on a machine with hundreds of plugins in one VST3
    folder, nearly everything. poptart now asks before an audio setting throws that away, which
    is as far as this goes from the outside: search() iterates whatever directory it is handed
    and a bundle cannot be its own search dir, so per-plugin resumption needs a fork change.
    Moot if the entry above lands - there is no long scan left to lose.

[ ] No way to reach the diagnostic report off macOS unless something has already failed. The two
    items live in the Help menu, and there is no menu bar on Windows or Linux - alt is where
    poptart's own chords live there, so the default menu was removed deliberately (cd61d2a). The
    failure screen's links cover a boot that fails, but a Windows user whose poptart is running
    and misbehaving has nowhere to click. Options: a right-click item in the editor's context
    menu (the growth point for this sort of thing), or something in the settings tab beside the
    data-folder path. The report itself works everywhere; it is only unreachable.

[ ] Do NOT remove the `server.sync` after `def.add` in track creation without solving message
    ordering first. Tried and reverted (2026-09-21): sending the `/s_new` as `/d_recv`'s
    completion message does remove the wait, but that sync was doing a second job - `/d_recv` is
    asynchronous, so the node is created on the server's NRT thread while the plugin open's
    `/u_cmd` and the parameter `/n_set`s are handled immediately on the RT thread. They arrive
    before the node exists and are dropped: 58 `FAILURE IN SERVER /u_cmd Node 1087 not found`
    lines in one session, plugins that never opened, and "no plugin loaded in that slot" for
    every params request. A delay became a silent permanent failure, which is worse.

    If it is worth another attempt, the shape is to wait for OUR node instead of for the whole
    queue: an OSCFunc on `/n_go` with the node id, signalled through a Condition, in place of
    `server.sync`. That is strictly narrower and still correct. But it does not help the case
    that motivated the change - if a scan really is occupying the async queue then `/d_recv`
    waits behind it too - so it buys precision, not speed. The speed comes from the entry above.

    Note the same shape exists at poptart.scd:2707 (the glide/LFO def), ~4183 (the mixer's
    analysis defs) and ~4263 (recording's `Buffer.alloc; server.sync`). Those syncs are
    load-bearing for the same reason; leave them alone.

[ ] Report the non-plugin-file crash upstream. Fixed in the fork (v0.6.2-poptart.4: the file
    branch of getPluginCpuArchitectures throws on an empty architecture list, as the bundle branch
    always did, and the PluginFactory constructor no longer reads archs.front() on one), and
    poptart keeps such files away from VSTPlugin regardless (plugin-scan.js). Upstream still
    segfaults the host on any regular file with a plugin extension that is not a module - repro
    with no scsynth: `host probe notes.vst3 _ out.ini` on a text file exits by SIGSEGV. File it at
    git.iem.at/pd/vstplugin along with the other unfiled scan bugs.

[ ] Re-evaluating during playback produces a crunchy click (heard 2026-09-20). Not yet
    reproduced. Ruled out by reading what a no-edit re-eval sends: plugin state (skipped when
    the plugin holds it, and no "restored plugin state for #N" line appears at the click); a
    track SynthDef rebuild (there is no such path - the track synth is never swapped); the hush
    (only on play-from-stop, never mid-play); loadInstrument / loadEffect / the blanket
    unloadEffect (engine-side no-ops on an unchanged chain); env and LFO re-sends (updated in
    place, synth and phase kept); bus sends (same bus index re-set, groups moved within their
    own depth); a route teardown (only when the route is actually dropped). The open suspect is
    timing rather than teardown: every timestamped message carries a latency RELATIVE to Node's
    send time, and sclang adds it to its own clock when it handles the message (bundleNow), so
    anything queued behind an eval's burst (25+ messages a track, each forking) lands late by
    however long the queue took - layered hits flam against each other. The cure would be
    absolute target times (Node and sclang share the machine's wall clock). Measure before
    building it: have evaluate send its wall-clock send time as the last message of the burst
    and log how late sclang handles it. Repro to try first: one sustained note with no
    modulators, re-eval with no edits; then two tracks layering the same sample.

[ ] Unlock plugins one at a time during a scan. They now unlock a FOLDER at a time: the scan
    runs one VSTPlugin.search per search directory (runScan in poptart.scd) instead of one search
    over all of them, so each folder's plugins reach the dict AND the on-disk cache as that folder
    finishes - a scan that dies no longer throws away everything before it. Finer than that is not
    reachable from outside VSTPlugin, and the earlier plan here assumed it was: search() always
    ITERATES the directory it is handed (vst/Search.cpp), so passing it a single .vst3 bundle walks
    INTO the bundle and finds nothing. A bundle cannot be its own search dir, which also kills the
    "one search per top-level entry" fallback, since those entries are bundles.
    The two ways in, both with costs:
    - /vst_query (VSTPlugin.prQuery) probes one path and adds it to the server's dict. But it
      probes with timeout 0, so a plugin that puts up a dialog hangs with no way out; it never
      writes the cache, so nothing is persisted; and scsynth runs async plugin commands one at a
      time, so it would queue behind the search it is meant to be reporting on.
    - a fork change: have the search report each plugin as it is probed, rather than only when the
      whole search returns. The honest fix, and it belongs in the same fork release as the
      archs.front() crash above.
    Unverified and worth knowing either way: whether a long search blocks OTHER async commands
    (SynthDef sends, buffer loads) on scsynth's single NRT thread for its whole duration. If it
    does, a first scan is not merely "plugin names don't resolve yet" - new tracks and samples are
    queuing up behind it too, and both the docs and the scanning message should say so.

[ ] Nothing restarts scsynth when it dies mid-session. Poptart now notices and says so - index.js
    watches sclang's "Server ... exited" line, reports what a scan lost, and every restart poptart
    itself asks for logs its reason, so an exit with no such line is known to be external - but the
    UI still says "engine ready" afterwards and nothing brings the server back. Re-picking the
    output device is the only cure today (SETUP.md says so). Wants: the status to go red on that
    line, and an offer to restart (the restart path already exists - restartEngine(reason) in
    server.js - and already tears down every piece of state that died with the old server).

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

[ ] Swap Rubber Band out of the keylock UGen for Signalsmith Stretch. Rubber Band is GPL (or a
    paid license from Breakfast Quay), and it and Ableton Link are the only GPL code Poptart
    itself compiles - everything else the app links is MIT, and SuperCollider runs as its own
    process. Signalsmith Stretch is MIT, is already vendored and pinned for the browser build's
    Shift device, and is a single header, so this is a bounded port of PoptartPitchShift: same
    player, same delay probe (its latency differs, and the probe reports whatever it is), same
    keylock-sclang.test.js. Link has no permissive stand-in; that one is a license from Ableton
    or nothing.

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
    still reads (muted tracks keep clocking).

[ ] `count()` - onset counter for the track (or `count(read("x").trig)` for another's), defined as
    the onset integral from cycle 0 so it's pure, survives re-eval and can be cached with cumulative
    sums per cycle. `.mod(4)` gives "every nth hit"; `y.rot(count(read("x").note.gt(24)))` is the
    "when X does this, do that to Y" idiom.

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
    deterministic ranking + seeded tiebreak, repeated invoke cycles alternatives; the voice-leading
    pass is harmony.mjs leadVoices (what .lead() uses) - have it pick the suggested chord's
    inversion and order the phase-2 voicing menu. Build last - most design-heavy.

[ ] Roman-numeral chord builder, parked by decision: chord("<I vi IV V7 bVII>") read against
    setscale, a written quality overriding the key's. Wait until the .chord() method form has
    been played with.

[ ] Swing manager - what is still open after the phases. Swing is a per-slot TABLE now (groove.mjs):
    a time offset and a velocity scale per slot of a bar, with the `swing` channel as the depth on
    it. Grooves are drawn in the lanes under the roll, saved by name through the two-layer registry,
    switchable per bar (`.swing(1, "<clave16 push16>")`), settable for the whole document
    (`setgroove`), and readable off a recording (a file dropped on the lanes).

    - A table describes ONE cycle. A multi-cycle groove wants a `cycles` field on the table, and
      every reader to divide by it; deliberately not in the first pass.
    - The panel's depth is written into the code rather than pushed live, so a depth drag is heard
      on the debounce. A lane drag is instant (it re-files the definition through /api/liveGroove);
      the depth has no such channel because it lives on the CALL, not on the definition.
    - Committing a roll's groove folds its TIMING into per-note nudges but not its accents: a
      note's velocity is already its own field, so there is nothing to fold.
    - A roll's groove can't be RENAMED from the side column - that gesture lives in the floating
      editor's name head, reached by double-clicking a .swing() that names it.
    - Extraction reads a loop as starting on the bar, which is what a loop is. A file that does NOT
      (a break lifted out of a track with a gap at the front) extracts rotated, and there is no
      control for the offset yet; the fitted beat anchor is reported but deliberately unused, since
      it anchors on whichever beat carries the bass energy rather than the first.
    - Extraction is WAV only, Node-side, like every other analysis here. The browser build has the
      same detector (web-engine's sample-plan.mjs) but no route to run this through.

[ ] MIDI clock in - follow an external MIDI clock (24 ppqn ticks + start/stop/continue/song
    position) for hardware and apps without Link. Assessed 2026-09-12, 1-2 days, mostly tuning:
    sclang's sysrt MIDI responders receive the ticks; a smoothing filter (a PLL over the last N
    tick intervals - USB MIDI clock is famously jittery) estimates tempo and beat phase, then
    forwards to Node as a (tempo, beat at a moment) report and rebases the transport with
    Transport#setCps for tempo and a phase shift for beat - the same follower Link already
    has (server.js's applyLinkReport over link-sync.js; a MIDI clock report can feed it as a
    second source). poptart always follows here (the 150 ms lookahead is fine for that).

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
    mode (desktop-only by design - see ARCHITECTURE.md) and the sample map are out of scope for
    now, while plugin hosting, OSC input and Link cannot run in a page. A public, static site
    (no backend, no accounts); AGPL section 13 means a source link in the UI.

    SHIPPED (0.2.0): `npm run build:web` writes dist/web, vercel.json points a host at it.
    The editor, the pattern language, the arrangement, the pianoroll and the widgets all run
    against a host that lives in the page (packages/web-app/public/web - see ARCHITECTURE.md).
    Storage is IndexedDB under the same names the desktop uses on disk, with an export that
    carries the whole store. Devices: the catalog is the count (packages/web-engine/src/catalog.mjs),
    and build/devices/sources.json is the per-device record - upstream, license, built/retired and
    why. Ours are written here against the shared core in src/dsp/; the ported ones are C++ compiled
    to WebAssembly and committed as binaries, so nothing downstream of the port needs a toolchain.
    They are built by packages/web-engine/build/devices/build-devices.mjs, which needs emscripten
    and is run by hand when a device is added or a pin moves. Packs: `pt_kit` and `pt_keys` rendered
    from our own DSP and committed; the sourced ones are assembled by
    packages/web-engine/build/fetch-packs.mjs and published at the tag DEFAULT_PACK_BASE pins
    (src/packs/library.mjs), loaded the first time a pattern names one. A device has no window of
    its own, so a double-click on a synth("…")/fx("…") name opens one generated from its
    descriptor: turning a control is heard
    at once and written into the code as a .param() call when the gesture ends. A descriptor may
    also declare FIGURES - the pictures its window draws, computed in web-engine's figures.mjs from
    the DSP that plays them - and the Wavetable declares seven: a waveform and a unison spread per
    oscillator, the filter's response, and a curve per envelope in place of that envelope's four
    knobs. They drag like the knobs do. A ported module declares none and is fine as knobs.

    STILL TO DO, roughly in order:
    (1) What the page still does differently from the desktop, each deliberately:
        - An export with audio is one JSON file with the audio in base64, a third bigger than the
          audio itself and built in memory - fine for a set's worth of recordings, heavy for a
          wavetable folder of thousands. A zip, written as it goes, would carry more.
        - The warp (.stretch()) and grain voices schedule their grains from the main thread with a
          100 ms lookahead, so a page that stalls for longer than that drops grains. A worklet
          grain engine would not.
        - Web MIDI is Chrome, Edge and Firefox; setSinkId (choosing an output) is Chrome and Edge.
          Elsewhere the page says so and plays on the default.
    (2) The compiled devices: what is built and committed is in build/devices/sources.json
        (every one, its license, and any that were built and retired). What is left of that list
        is FAUST, and it is the entry to be careful with - the license differs per FUNCTION,
        several reverbs are GPL where the
        filters are not, and GPL is a one-way door for a build that might ever want to be offered
        under other terms. Check the function, not the repository.
        Still open on what IS built: Rings and Elements resonate their own exciter only, so
        resonating a track's audio is not exposed; Plaits and Rings are monophonic, as the modules are. Nine of Mutable's modules cannot be
        ported at all - five are analog hardware with no DSP published, three make control
        voltages rather than audio, and one was never published; sources.json says which.
    (3) Link, osc() input and plugins: see (6) to (8). Everything else the desktop's engine
        does, the page's now does too.
    (4) A vocoder. One was written and taken out before the first release: it sounded wrong
        (a bandpass bank with the carrier's bands copied from the modulator's, an emphasis tilt
        and a flat doubling of the wet sum - the intelligibility was never there), it had no
        picture, and a vocoder without a MIDI-played carrier is half of one. The engine now delivers
        `.midi("other")` into an effect that declares `notes` (the Ducker is the first), so that
        half is there. Bringing it back means a band-level picture (the
        modulator's envelope per band, live), a carrier played from .midi() as well as taken
        from .audio(), and a tuning pass against a voice.
    (5) Move the host behind a message boundary so it can go in a worker or an opaque-origin
        frame. The seam is already there - the editor calls one function and the host is a route
        table - so this is a postMessage shim on each side rather than a redesign. Note the audio
        context cannot follow it: Web Audio is main-thread only, so the engine stays where it is
        and only the storage and the language would move.
    (6) Plugins (VST/AU). A page cannot load one: a plugin is native code that expects the
        operating system's windows, files and audio threads, and a page runs only sandboxed
        WebAssembly. Two ways in, not exclusive:
        - A local engine mode: the web editor drives a poptart engine running on the same machine
          (the desktop's scsynth + VSTPlugin) over a local WebSocket, in place of the in-page host.
          The route table is already the seam, so (5) is the first step. Plugin windows open
          natively on that machine. A session runs on ONE engine - the page's audio and the
          helper's run on separate clocks, and streaming audio between them adds tens of
          milliseconds with jitter - so in-page devices and hosted plugins do not mix on one track
          or bus. Chrome asks permission before a public site reaches localhost (one prompt). The
          helper has to be installed, which for most people is installing the desktop app.
        - Web Audio Modules (WAM 2): the open standard for plugins built for the browser, hosted
          in the page on the page's clock with no helper. Only plugins their makers ported; not a
          bought VST.
    (7) A Link bridge. A page cannot join Link (UDP multicast), so a small local helper joins the
        session and relays tempo, beat and phase over a WebSocket. Check the existing ones before
        writing one: Carabiner (Deep Symmetry) already exposes Link over a local TCP socket and
        would need only a WebSocket shim in front of it. The local engine mode in (6) gets Link
        for free, since the desktop already runs it.
    (8) An OSC bridge. A page cannot listen on a UDP port, so a local relay forwards OSC to the
        page over a WebSocket, where the engine's feedOsc is waiting. osc.js ships a UDP-to-
        WebSocket relay that may do this as it is. Again free under the local engine mode in (6).
    The nine-oh-nine and the rest: there is NO redistributable recording of any classic drum
    machine except the eight-oh-eight, checked exhaustively 09-22. The sets that circulate are
    either unlicensed (the widely used ones have open, unanswered requests for a license file
    going back years) or carry a dedication from somebody who was not the person who recorded
    them. The answer is to synthesize our own, the way pt_kit already is: build/render-packs.mjs
    has the kick/snare/clap/hat generators, and a second kit in that style is a contained piece of
    DSP work with no provenance to defend. Ship it under a name of its own, not the machine's.

    Public-site constraints: shared code never auto-evaluates, and everything the host touches
    goes through the route table so it can later move behind a message boundary.

    Open: delay time in seconds (consistent with the physical units elsewhere, and what it does
    now) or in cycles (more natural in a pattern language). Whether the sourced packs should be
    mirrored into our own repository at all, or referenced upstream through a CDN - mirroring is
    what the build does now, and it costs a repository to maintain in exchange for a pin nobody
    else can move.

[ ] The web engine's devices on the desktop - what is left of it. The WHOLE catalog now runs in
    scsynth, through one generic `PoptartDevice` UGen that loads a device at runtime the way
    `VSTPlugin` loads a plugin: the ported C++ modules (Plaits, Rings, Elements, Braids, Clouds,
    Galactic, CloudSeed, Shift) and poptart's own (Wavetable, FM, Granular, Filter, EQ, Distort,
    Crush, Overdrive, Compressor, Multiband, Limiter, Ducker, Delay, GrainEcho, Stutter, Chorus,
    Flanger, Phaser, Reverb, Convolver). Same names, same control names, same 0..1 positions on
    both engines; the names are in the plugin browser and in `synth("`/`fx("` completion,
    `.param("` completes from the catalog as soon as a name is typed, and double-clicking a
    device's name opens a window generated from its descriptor by the same web-engine module the
    browser build generates one with.

    The ported modules are one source compiled twice, so they cannot drift. poptart's own devices
    ARE written twice - their DSP was written in JavaScript for an AudioWorklet, which a server
    cannot run - and what holds the two together is osc-engine's native-device-parity.test.mjs:
    the browser's processor and the compiled device are played the same input with the same
    controls and compared sample for sample, every device, at its defaults and at four settings
    across its range. A change to one side that is not a change to the other fails there.

    The Convolver is the exception to both halves of that: in the browser it is a ConvolverNode,
    so there is no JavaScript to port and none to compare against. What it is held to instead is
    CHROMIUM - Blink's reverb.cc, reverb_convolver.cc and biquad.cc, cited where each is used -
    and the test checks the parts that can be checked against a definition rather than against a
    second opinion: the convolution against a direct sum over its taps (which is what catches a
    partitioned stage a sample out of alignment), the gain a normalized response is given against
    the closed form of Blink's own formula, and the five synthesized spaces against the browser's
    own synthesizeImpulse, which is poptart's JavaScript and runs here as it is.

    (1) What a device can be handed, and what it still cannot.

        A FILE now reaches a device: `.param("sample", "break:2")` resolves the name against the
        sample packs sclang has already read for the sampler, hands the device the buffer by
        number, and the UGen copies the frames out of it on the non-realtime thread and swaps the
        pointer in on the audio thread (`/sample` in PoptartDevice.cpp, `loadSample` on the
        controller, `_loadDeviceSample` in osc-engine). The slot a file lands in is the browser's
        own rule, so `.param("sample", 1)` means the same file on both engines.

        What it does NOT carry - a wavetable cut from a file, a drawn curve or window, a stereo
        impulse response - and the one thing a device cannot ask for at all, which is work off
        the audio thread, are the entry at the top of this file.

    (2) What hangs off the device window, now that there is one. Double-clicking a device's
        name opens the panel generated from its descriptor (web-engine's panel.mjs, which the
        browser build uses too - web-app's server stages that package for its sources alone), and
        a finished gesture in one is filed the way a gesture in a plugin's window is: a
        `.param()` while conf is armed for the track, and otherwise a capture of the whole device
        into `{ state }`, which works because a device's program IS its control positions
        (PoptartDevice.sc's writeProgram). What is missing:
          - a modulated control is drawn where the modulator was POINTED rather than where it has
            got to. The browser follows one from the processor's own reports; scsynth has nothing
            to report with - a modulator is a control bus mapped onto the UGen's input, read by
            nobody - so `/api/deviceLive` answers with nothing rather than a guess. This is the
            cheapest thing on this list and needs no C++ at all: the controller already keeps a
            `positions` array of everything that was `/set`, and a MAPPED control's value is a
            control bus sclang can `Bus.get`, so one OSCdef, one Node method and a real answer
            from that endpoint would do it. The better version is a `/report` unit command
            answering through `SendNodeReply` - the path `/poptart/deviceOpened` already uses -
            because that reports what the DEVICE saw rather than what sclang sent, and it is the
            channel the grains below need anyway.
          - the live figures that go with it, which are two different jobs. An equalizer's curve
            drawn over what an analyzer hears rides machinery that already exists (the mixer runs
            analyzers, capped at eight and on playing tracks only), so it is wiring plus a
            decision about that budget. A granulator's grains moving through the file are the
            device reporting its own internal state, which is new ABI - a `pd_report` hook beside
            the others in pd-device.h - plus the reply channel from the point above, so that one
            comes first.
          - `.preset()` on a device is probably already working and has simply never been
            tested: sclang's getPluginState asks for `ctl.info` and `ctl.writeProgram`, both of
            which the device controller implements, and Node gzips whatever bytes the file holds
            without caring that they are JSON rather than a plugin's chunk. A capture-and-restore
            in the sclang render test is what would settle it.

    (3) Off macOS. The .scx is committed as a universal macOS build; Windows and Linux need it
        built there, as the pitch shifter does (the private SC build covers the Windows side).
        The x86_64 slice is compiled but has never been run - nothing here has an Intel Mac.

    (4) Notes land on a block boundary (5.3ms at the default block size), because a note is a
        unit command and those are performed between blocks. Plugin slots have always been the
        same, so this is parity rather than a regression, but the sampler is sample-accurate and
        these could be - and probably cheaply. `World` carries `mSampleOffset`, "offset in the
        buffer of current event time", which is what OffsetOut reads to start a voice mid-block;
        if it is populated while a unit command is performed (the first thing to test, and a
        twenty-line experiment), a note needs no protocol change at all: the command reads the
        offset itself, and the UGen splits its render at it exactly as it already splits for a
        moving bend. The devices would take an offset on their note calls, which the browser's
        already do (queueNoteOn's third argument). It is also why the ducker's note-triggered dip
        starts at a block edge where the browser's starts at the note's own onset.

    (5) Most controls are still read once per block. Audio patched onto a control
        (`.param(name, audio("x"))`, the UGen's /mapa) and an env() on a native device's control
        (poptart_env_ar on an audio bus) are read per sample now: while anything is patched the
        UGen renders an own device one sample at a time (kPatchPiece), which the parity test
        holds against the browser and audio-patch-sclang.test.js renders. A ported module reads a
        patch at the block start, as it does in the browser. What is still a control bus, and so
        a 5.3ms staircase: lfo(), midicc()/osc(), and polled values. The same route covers them -
        an `.ar` twin of each modulator def writing a stereo audio bus, mapped with mapAudio, as
        setParamEnv does - at the per-sample cost measured for kPatchPiece (about 1.5-2x for the
        synths, far more for Distort, whose oversampler pays per call).

    (6) Live verification. Everything above is unit-tested and rendered offline through a real
        scsynth (native-device-sclang.test.js renders Plaits, a control change, Galactic's tail,
        the Wavetable synth playing a note, the Filter's cutoff opening and shutting, the FM
        synth's last control, the granulator playing a file read into one of the server's own
        buffers, and the convolution reverb's tail), and none of it has been played through a
        running engine: a device opening on a live track, swapping kinds mid-set, surviving a
        re-eval, metering in the ctrl+G mixer, a synced delay following setbpm(), a ducker keyed
        off another track, a window opened on a device while the pattern is driving it.

    In value for effort, if this is picked up again: the note offset (4) is the only one anybody
    can HEAR and is probably a day; the modulated-knob follow (2) is half a day and immediately
    visible; the `.preset()` round trip may cost nothing but a test; then the rest of (5), then the live
    figures.

[ ] Cut sclang out of the desktop engine. sclang sits between Node and scsynth and is
    single-threaded, so a busy moment there delays every note ("late 0.0xx"); it also carries
    poptart.scd's ~6000 lines (78 OSC handlers, 26 SynthDefs, ~40 routines). Stages, each shippable
    with sclang keeping whatever has not moved:
    1. Notes and param changes go straight from Node to scsynth as timestamped bundles (biggest
       timing win; done 2026-10-27, glossing/direct-scsynth).
    2. Node boots scsynth and owns node/bus/buffer bookkeeping, handler by handler.
    3. SynthDefs: fixed ones compiled at build time and shipped as .scsyndef; runtime ones
       (expression trees) written by a Node encoder of the documented binary format.
    4. VST control: re-implement VSTPluginController's /u_cmd protocol in Node (open, params,
       state get/set, editor, MIDI). Hardest part; test against real plugins.
    Stage 3 is done (Node builds every SynthDef, byte-identical to sclang). Stages 2 and 4 ship
    behind a switch (POPTART_ENGINE=node); the sclang path stays the default until the Node engine
    has been played on for a while, then it becomes the default and sclang is removed.

