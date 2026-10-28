// poptart control script - runs under `sclang -u <port>`, spawned by OscEngine#start() (see
// ../index.js, which passes the port and env vars).
//
// Boots scsynth and hosts VST3/AU plugins via Christof Ressi's VSTPlugin extension (the
// `VSTPlugin`/`VSTPluginController` classes + VSTPlugin.scx server plugin). VSTPlugin is a
// binary server extension, NOT a Quark - install by unzipping the release from
// https://git.iem.at/pd/vstplugin/-/releases into your SuperCollider Extensions directory.
// This file is the one place that talks to VSTPlugin directly - packages/pattern-core and
// packages/web-app never see SuperCollider at all, only OscEngine's JS-shaped interface.
//
// API notes (verified against the installed VSTPlugin v0.6.2 class sources):
//  - VSTPluginController(synth, id, synthDef:) needs the def's \vstplugins metadata; we pass
//    the SynthDef object explicitly rather than relying on the global SynthDescLib.
//  - ctl.set accepts parameter *names* as well as indices (the UGen resolves names);
//    ctl.map needs an index, resolved via ctl.info.findParamIndex(name).
//  - VST parameter values are normalized 0..1. Real-world ranges (e.g. 200..5000 Hz) need the
//    per-plugin calibration layer that isn't built yet - out-of-range LFO bounds are warned
//    about and will just pin the parameter.
//  - VSTPlugin.search probes plugins out-of-process and takes options: (timeout: seconds), so
//    one crashing or dialog-popping plugin can neither take down scsynth nor hang the scan -
//    the two failure modes that killed this project's previous in-house JUCE scanner.
//
// A track is a row of synths, one per device, in a group of its own (see sharedTrackDef): a chain
// is as long as the code makes it, and a change of its structure moves and rewires the nodes it
// has rather than rebuilding them, so a plugin keeps its state through it.

(
var nodePort = "POPTART_NODE_PORT".getenv.asInteger;
// Where outside OSC senders reach osc() signals - its own port, apart from the command port Node
// talks to (-u), opened lazily by oscEnable.
var oscInPort = ("POPTART_OSC_IN_PORT".getenv ? "57160").asInteger;
var sampleRate = ("POPTART_SAMPLE_RATE".getenv ? "48000").asInteger;
var blockSize = ("POPTART_BLOCK_SIZE".getenv ? "256").asInteger;
// Audio output device (empty/unset = system default) and its channel count, chosen in the
// editor's settings tab and passed through by OscEngine. The channel count sizes
// numOutputBusChannels so the device's channels are all addressable.
var outDevice = "POPTART_OUT_DEVICE".getenv;
var outChannels = ("POPTART_OUT_CHANNELS".getenv ? "2").asInteger;
// How many channels .o(n)'s stereo-pair wraparound folds onto - the editor's "output channels"
// setting, which is 2 unless raised, and never more than the device can be heard on (poptart's
// aggregate pads its count with the combined input devices' own outputs, which go nowhere
// audible). Node works both halves out - audio-selection.js's playbackChannels.
var playChannels = ("POPTART_PLAY_CHANNELS".getenv ? outChannels.asString).asInteger;
// The chosen device's input channel count (0 for output-only devices). Currently poptart plays
// out only, so this is 0 in practice, but it's the device's real input count so live-input
// features can use it later without a boot-config change. It also has to match the device: when
// inDevice == outDevice (set below) scsynth opens one device and will fail to boot if it's told
// to open more input channels than the device has.
var inChannels = ("POPTART_IN_CHANNELS".getenv ? "0").asInteger;
// Headphone cue (the performance mixer, phase 7): the first output channel of the cue pair
// inside the opened (combined) device, or nil for no cue. Set only when web-app booted the
// engine on an aggregate that really contains the chosen cue device; the track SynthDefs
// compile their cue send only when it is here.
var cueOffset = "POPTART_CUE_OFFSET".getenv !? { |v| v.asInteger };
// Plugin directories to scan. Priority: POPTART_VST_DIRS if set, else ~/.poptart/plugins if it
// exists (a folder of symlinks to just the plugins being played), else VSTPlugin's standard
// locations. The curated folder stays the default because it keeps first-scan time down and
// sidesteps plugins that won't probe headlessly; it is no longer load-bearing for stability,
// though - the full-scan crash it was working around was VSTPlugin's parallel probing, now off
// by default (see parallelScan below).
// Normally this arrives already resolved from Node (see plugin-scan.js), which makes the same
// three-way choice and has walked the folders looking for entries that would crash the scan -
// one resolution, so the list that gets scanned and the list that got checked cannot differ. The
// fallback below is for an sclang run by hand.
// Split on the platform's path delimiter - ';' on Windows, where ':' cannot separate paths
// because every absolute path contains one.
var searchDirs = "POPTART_VST_DIRS".getenv !? { |p| p.split(Platform.pathDelimiter).reject(_.isEmpty) }
    ?? { var d = ("POPTART_HOME".getenv ?? { "~/.poptart".standardizePath }) +/+ "plugins"; if (File.exists(d)) { [d] } };
// Plugins skipped explicitly during scans (VSTPlugin's exclude option, which prunes these
// paths from the directory traversal so they're never probed). Set POPTART_VST_EXCLUDE
// (absolute paths, same separator as above) to skip plugins that crash or spam errors on your
// machine during a scan, e.g. copy-protection or analysis plugins that fail to probe headlessly.
// Node adds to this: any file with a plugin extension that isn't a binary this machine could
// load (probing one segfaults scsynth), plus whatever a previous scan died on.
var excludePaths = ("POPTART_VST_EXCLUDE".getenv !? { |p| p.split(Platform.pathDelimiter).reject(_.isEmpty) } ? []);
// Probe one plugin at a time. VSTPlugin's default is parallel probing (one worker per core), and
// on this machine a parallel scan of a full plugin folder reliably segfaults scsynth partway
// through - always the same null deref inside VSTPlugin.scx, reached from SC_AudioDriver::RunThread
// (i.e. in VSTPlugin's own poll/result handling, not in any plugin), which reads like a race in the
// shared search state rather than one bad plugin. Serial probing costs first-scan wall time only:
// probes are cached, and a re-scan re-verifies cached entries without re-probing. Set
// POPTART_VST_PARALLEL=1 to opt back into the fast path.
var parallelScan = ("POPTART_VST_PARALLEL".getenv ? "0") == "1";
// Shared by the boot scan and the /poptart/scanPlugins rescan, so the two can't drift.
var searchOptions = (timeout: 20, exclude: excludePaths, parallel: parallelScan);
// True while a search is running. A plugin name that misses during one usually isn't a typo -
// it just hasn't been probed yet - and the message says so (see loadInstrument/loadEffect).
var scanning = false;
// The bus number a node's input or output is parked on: past the last audio and control bus there
// is, so an Out to it is skipped and an In from it reads silence (scsynth checks the range).
// A negative number would not do - it is taken as bus 0, the speakers.
var routeNowhere = 1000000;
// scsynth's own port, overridable so a second poptart stack (tests, parallel session) doesn't
// collide with a running one on the default 57110.
var scsynthPort = ("POPTART_SCSYNTH_PORT".getenv ? "57110").asInteger;
// Where scsynth looks for UGen plugins, set only when poptart is running its own private
// SuperCollider (see private-sc.js): the copy's own plugins folder plus poptart's private
// Extensions, split on the platform's path delimiter - ':' on macOS/Linux, ';' on Windows,
// which is why this can't use $: like the VST dirs above (a Windows path is full of colons).
// Unset - the normal system-install case - leaves scsynth's default search alone.
var ugenPlugins = "POPTART_UGEN_PLUGINS".getenv !? { |p| p.split(Platform.pathDelimiter) };
var server = Server(\poptart, NetAddr("127.0.0.1", scsynthPort), Server.default.options);
var nodeAddr = NetAddr("127.0.0.1", nodePort);
// trackId (Symbol) -> (def:, group:, synth:, controllers:, loaded:, lfos:, envs:, held:).
// Symbol keys, NOT Strings: IdentityDictionary lookups are by identity, and two equal Strings
// are distinct objects (incoming OSC string args arrive as Symbols anyway).
var tracks = IdentityDictionary.new;
// key -> generation of the build allowed to commit that key (see poptartCreateTrack). Bumped by
// every build and by every reclaim, so a build that comes back after its reservation was taken
// away can tell that the key is no longer its to fill.
var trackGen = IdentityDictionary.new;
// '<track>_<slot>' -> the newest plugin-state restore seen for that slot. A restore carrying a
// timestamp waits here for its onset (see poptartSetPluginState), so anything sent afterwards has
// to be able to cancel it - otherwise an older program lands on top of a newer one, which is what
// a preset swap already in flight would do to the editor taking a hold on that slot.
var stateSeqs = IdentityDictionary.new;
// '<track>_<slot>' -> (seq:, at:) for a program load that is coming or already running on that
// slot, and the note events waiting for it. Loading a program suspends the plugin and resets its
// voices, so a note that lands inside one is either swallowed or wiped a moment later by the reset
// - the note written at the swap simply does not play. See waitForLoad.
var statePending = IdentityDictionary.new;
var noteQueues = IdentityDictionary.new;
// The longest a note will ever wait for a program on a plugin that is already OPEN (a warm
// preset swap takes tens of milliseconds, so this is slack, not a budget) - and, on release,
// how late a held note may fire. A COLD restore - the state arriving while its plugin is still
// opening, i.e. a new song coming up - is different on both counts: the hold lasts the whole
// open+load (marked `cold` on the pending entry; openWaitMax + coldWaitMax is only the
// stuck-open/stuck-load failsafe), and the release DROPS the notes whose onset has passed
// instead of bursting them out late. The track stays silent until its program is confirmed in,
// then joins on the next on-time note - the alternative was every synth playing its init preset
// for the length of the load.
//
// Opens are serialized engine-wide (see openQueued), so how long a slot's plugin takes to open
// depends on how many are queued ahead of it - a song's worth, on a load. A restore that waits
// for its plugin on a fixed clock therefore fails for the slots at the back of the queue, and
// fails SILENTLY as far as the scheduler knows: it marked the state applied when it sent it, so
// nothing re-sends, the plugin comes up on its init program, and the first capture out of it
// files that init program over the real preset in the code (the fill track of PIPEWIRE,
// 2026-09-13). So awaitLoaded follows the open itself - waiting for as long as one is in flight
// for the slot (see `wanted`) - and openWaitMax is only the guard against an open that never
// reports back at all: openQueued gives each one 30s before moving on, so this covers a queue
// with one wedged plugin in it, not a budget any real load is expected to approach.
var stateWaitMax = 0.3;
var coldWaitMax = 20;
var openWaitMax = 60;
// '<track>_<slot>' -> the time until which an edit reported by that slot's plugin is OUR doing
// rather than the user's. Loading a program makes plugins fire the very callbacks auto-pin
// watches - /vst_update above all, since a plugin that redraws when its program changes cannot
// tell a host load from a click in its own preset browser - so every push of a captured state
// came straight back as "the user just edited this slot".
//
// On a slot whose preset only IT plays that was merely wasteful: the program came back as the
// code already described it and the editor stopped there. Two slots sharing one preset made it a
// LOOP. A capture from `pluck` is filed in `_preset("pluckSC", ...)`, which the next evaluation
// pushes into `pluck2`'s own copy of the plugin - it must, they name one preset and one sound -
// whose update captured ITS program; and a plugin that does not serialize byte-for-byte
// identically after a round trip then wrote a DIFFERENT state into that same definition, which
// was pushed back to `pluck`, forever (Kickstart 2 on two tracks, reported 2026-08-27).
//
// Same reasoning as not listening to '/vst_param' (see watchPluginEdits): what we did to a plugin
// is not something to capture out of it. The window is bounded by coldWaitMax so a load that
// never reports back cannot deafen a slot for good.
var selfLoads = IdentityDictionary.new;
// How long after a load reports in its plugin may still be redrawing because of it. Long enough
// for a callback the load itself caused, short enough that the next knob you turn is heard - and
// hand-editing a plugin freezes this slot's pushes anyway (see holdPluginState), so a gesture is
// only ever this near a load we made if the window was opened behind poptart's back.
var selfLoadTail = 0.5;
var samplePacks = IdentityDictionary.new; // pack (Symbol) -> Array of Buffers, filename order
// Song decks (see server.js's song section): one full-length audio file per DJ deck track,
// played by a poptart_song_* synth into the track's input bus. trackId -> (buf:, synth:).
var songs = IdentityDictionary.new;
var confWant = IdentityDictionary.new; // trackId -> latest requested conf state (see setConfMode)
// Host tempo (bpm) mirrored into every open VST as emulated DAW transport, so plugin-internal
// synced LFOs/delays/arps follow setbpm instead of assuming their own default. Updated by
// '/poptart/setTempo' and applied to plugins as they open (see loadInstrument/loadEffect).
var currentTempo = 120;
// ...and the tempo of each track whose deck is on a clock of its own (trackId -> bpm), which is
// what a plugin opening on such a track starts at. Empty while every deck rides the host clock.
var trackTempo = IdentityDictionary.new;
// ...and where that clock was last put (trackId -> [beats, the SystemClock moment they are true
// at, playing]), so a device opening on such a track starts at its deck's position rather than
// the host clock's (see trackBeats).
var trackPlace = IdentityDictionary.new, trackBeats;
var jsonEscape, toJson, replyOk, replyErr, pluginList, runScan, trackDefName, buildTrackDef, channelDefault;
var djIsolator; // the DJ stage's 3-band EQ (see its definition above buildTrackDef)
var buildHeadDef, buildFxDef, buildXoverDef, buildDjDef, buildTapDef, buildBassMonoDef; // the defs a track is made of (see sharedTrackDef)
var djNode, stripTap, stripPost, bassMonoNode, trackPairs; // a track's optional stages (see djNode)
var loopEdges = Set.new, routeCloses, busWriters, trackSerial = 0; // the edges that close a loop (see trackLevels)
var routeApply, routeFree, slotNode, ensureFxNode, channelTarget, setScBus, routeKrNode, unityGainBus; // a track's chain (see routeApply)
var sharedTrackDef, trackDef, trackDefState; // the one track SynthDef this engine builds (see sharedTrackDef)
var awaitTrack, awaitLoaded, reclaimStuckTrack, resolvePlugin, resolveParamIndex, watchPluginEdits;
var pluginOpenLock, openQueued, slotKindGuard;
var destroyTrack, buildTrack;
var slotKey, slotLive, waitForLoad, flushNotes, clearPending;
var hushTrack, clearMidiRoute, markSounding, noteKey;
var beginSelfLoad, endSelfLoad, selfLoading;
var midiInitialized = false, midiWarned = IdentitySet.new;
var midiEnable, midiNameForUid, midiSourceFor, midiWarnMissing, midiRefreshSources, midiConnected;
var oscInitialized = false, oscEnable;
// The host transport's mirror (see hostClockSync) and what hangs off it: MIDI clock out.
var hostClock, hostClockSync, clockOut, clockOutName, clockOutLatency = 0.05, clockRunning = false, clockLocate = false;
// The desk's talk-back port ('/poptart/midiFeedback'): one destination the host writes short
// messages to, for a control surface that SHOWS state - level meters, lit pads. Separate from
// the clock's destination because they are different jobs and may be different ports, and
// latency 0 rather than the clock's lead: a meter is about now, and a scheduled one would show
// the level it had a moment ago.
var feedbackOut, feedbackOutName, midiFeedbackSet;
var clockTicker, clockTickerStart, clockTickerStop, clockNextTick, midiClockSet, midiDestName;
// Cross-track audio routing (the audio() head source and the .audio(...) sidechain injector).
// silentBus is the read-only default for every fx slot's aux input (never written -> silence);
// trashBus is the write-only default for a track's send when it feeds nothing (parked, never
// read). scArgsFor builds the per-track defaults. sidechainByTarget/BySource track live routes
// both ways for teardown, and sourceFeeds holds the per-source bus that lets ONE source feed
// several sinks (see acquireSourceFeed).
var silentBus, trashBus, scArgsFor, scKey, wireAudio, unwireAudio, tellKeyPatched;
var sidechainByTarget, sidechainBySource, sourceFeeds, acquireSourceFeed, releaseSourceFeed;
// Audio routed from another track's output or a named bus onto something that reads it every
// sample - in practice an expression's source input (`.param("Cutoff", audio("lfo"))` is an
// expression with one source; see installExpr). paramRoutes holds one entry per (track, slot,
// name); the routes are part of the node order (trackLevels) exactly as a sidechain is, because
// the reader reads the bus in the block its source wrote it.
var paramRoutes, paramRouteKey, wireParamRoute, unwireParamRoute, applyParamRoute, reassertParamRoute;
// Param expressions (see '/poptart/setParamExpr'), and the one object every handler maps a
// control through (paramTarget) - a channel control, a plugin or device parameter, or an
// expression's input.
var exprLeaf, busIndexOf, paramTarget, reassertAudioDrivers, awaitTarget;
var exprDefUse = Dictionary.new, exprDefSerial = 0, exprDefDone, freeDefsLater; // see exprDefDone
var exprDefs, exprKey, exprsOf, exprFeedsOf, exprFeed, exprFeedArgs, exprShape, exprConsts, exprInputs;
var exprSynthDef, installExpr, clearExpr, exprQueue, reassertExprs, exprRun;
// A drawn lfo() shape's SynthDef (see setParamShapeLFO).
var lfoDefName = { |shape, audio| ("poptart_lfo_" ++ shape ++ if (audio) { "_ar" } { "" }).asSymbol };
// Named audio buses (Sig#bus / '/poptart/setBusOut'): a track can divert its output to a bus,
// where any number of tracks sum, and another track reads the sum via the audio("name") head
// source. acquire/releaseBus refcount the buses so they live exactly as long as some writer or
// reader references them.
var namedBuses, acquireBus, releaseBus;
// Node order between tracks that read each other. scsynth zeroes its buses every block, so a
// reader ordered before its writers sees silence (not last block's signal - silence), and a
// track's place in the tree has to follow from EVERYTHING routed into it: the tracks whose output
// it reads (audio("kick"), a sidechain), the writers of every bus it reads (audio("bus:mix"), a
// group's variations), and their sources in turn. trackLevels works that out as a depth - 0 for
// a track that reads no other, one past the deepest thing it reads otherwise - and reorderTracks
// keeps one Group per depth, in order, every track's group inside the one for its depth. Re-run
// after any change to the routes, so the order is always the whole picture and never the last
// pairwise nudge to win (a track that both reads a bus and sends to one used to be placed by
// whichever of the two handlers ran last).
var levelGroups, trackLevels, reorderTracks;
// Per-track recording ('/poptart/tapTrack' + '/poptart/recordTrack'). A tapped track copies its
// post-fader output to a private bus; a meter synth on that bus streams peaks back to Node so the
// editor's record panel can show the signal, and a DiskOut synth writes the bounce itself. recGroup
// sits at the TAIL of the node tree, so both read a bus the track synth has already written this
// block. recTaps holds one entry per tapped track: (bus:, meter:, disk:, buf:, path:).
var recGroup, recTaps, startTap, stopTap;
// Global mixer monitoring ('/poptart/mixMeters'): while the editor's mixer is open, each PLAYING
// track's post-fader output is copied to a private bus (the mixOut/mixSend args, parked exactly
// like the recorder's) and an analysis synth on it streams peak/RMS levels plus a log-spaced band
// analyzer (per-band L/R amplitude - one feed serving both the spectrum and the stereo-field
// display) back to Node. A second analysis synth on hardware bus 0 reads the summed master,
// forwarded under the reserved key "*" (never a track label - labels are identifiers). The
// analyzer's band centers come FROM Node with the on message, so the frequencies the client draws
// are by construction the ones being measured; the SynthDef is built lazily from them.
//
// Node also says WHICH tracks to tap (mixWanted - the ones with a scheduler; an idle track kept
// warm for its label's return would burn an analyzer on silence). The analyzer is one
// PoptartSpectrum unit per tap - a ring buffer, and four transforms a frame - so there is no
// budget on how many tracks get one. mixReconcile brings the taps to that description - on each
// message, and from createTrack for a wanted track born later.
var mixTaps, mixOn = false, mixBandFreqs, mixMaster, buildMixDef, mixBank, mixForwards;
var mixWanted, mixReconcile, mixReconciling = false, mixDirty = false;
var startMixTap, stopMixTap, stopMixMaster;
// The editor's inline audio displays ('/poptart/viewTaps'): everything they need, in one event -
// see the view-tap section.
var viewTap;
// DJ deck meters ('/poptart/deckMeters'): two stereo meter buses (A at .index, B at .index + 2)
// that every track synth sums its PRE-FADER signal into (the mdeck birth arg says which, -1 for
// neither), and one SendPeakRMS reader synth per deck while the strip is open. Pre-fader (post
// trim/EQ/filter, the cue tap's point) on purpose: the meter answers "what is this deck making?"
// for gain staging with trim, like a hardware desk's channel meter, not "what is the crossfader
// letting through".
var deckMeterBus, deckMeterSynths;
// The master meter: one synth after everything else, for as long as the engine is up, that
// reports the peak of all the hardware outputs summed together ('/poptart/masterLevel'). See
// \poptart_master.
var masterSynth;
// The headphones: one synth after the master on an engine with a cue pair, and the level and
// cue/main mix it plays at (see \poptart_headphones and '/poptart/headphones'). Unity and cue
// only until Node says otherwise - what the cue pair always played before there were knobs.
var headphoneSynth, headphoneLevel = 1, headphoneMix = 0;
// makeBundle with a timestamp only when there is real lead - see the definition by the events
// section.
var bundleNow;
// The ids the direct path needs, told to Node as they are made (see tellTrack and osc-engine/direct.js).
var tellTrack, tellSlot, tellMods, tellRamp, tellTap, heldBy, shapesHandled = IdentityDictionary.new;
// Deferred teardown for a dropped Tier-2 modulator's synth+bus - see the definition next to
// clearParamLFO.
var modFreeDelay = 0.3, freeModulatorLater;
// The ramp behind every polled control - see poptartSetParam.
var rampTo, dropRamp, dropSlotRamps;
// ...and what happens when the server says that ramp's node is not there - see nodeGone.
var nodeGone, nodeGoneSaid, nodeFailId, nodeMissing, nodeOwners, nodeOwns, deadNodes;
var outOfRoom, outOfRoomSaid, outOfRoomPhrases;
// The sampler's voice ceiling and the server's pressure gauge - see their definitions.
var maxVoices = 1024, liveVoices, voiceBorn, voiceDone, voiceCapSaidAt = 0;
var statusWatch, statusNodesHigh = false;
// Set outright, never ramped. The first three and mon are selectors, not levels. The grain controls are
// levels, but their reader is a grain, which takes one value as it starts and keeps it: a ramp has
// nothing to smooth there, and it would turn a polled rand() - a fresh draw per poll - into a
// line wandering between draws, which is drift and not scatter.
var steppedChannelControls = #[\out, \cue, \mdeck, \mon, \grainpos, \grainsize, \grainrate, \grainpan];
// The granular voice (see the poptart_sample_grain_ defs). GrainBuf reads ONE channel, so a stereo
// file is granulated from a one-channel copy of each side, read the first time it is asked for:
// bufnum -> [left, right], or \loading while the reads are out. Windows are keyed by the very
// breakpoint string the event carries: String -> Buffer, or \loading.
var grainSides = IdentityDictionary.new, grainWindows = Dictionary.new;
var grainWindowFrames = 1024, grainMaxOverlap = 128;
var grainSidesFor, grainWindowFor, freeGrainSides;
// Pitch bend (Sig#bend). The track synth republishes its bend control on a bus of the track's own
// (see buildTrackDef): sample voices map it, and this rate is how often the synth posts the value
// back to sclang to be sent on as a MIDI pitch-bend message. 100 Hz is a compromise with a reason
// at each end - Node's own control poll is 30ms, which reproduces a fast wobble as a staircase,
// while a rate much past this buys resolution the 14-bit message cannot carry anyway.
// bendTracks maps the posting synth's node id back to its track, since that is all SendReply says.
var bendPollHz = 100, bendTracks = IdentityDictionary.new;
// Bundle time for a message aimed at a song-deck player - clamped so it can never land before
// the player's (possibly future, cycle-quantized) spawn. See the song decks section.
var songLat;

// Boot-progress checkpoint ("poptart: booting scsynth" below is the other one):
// diagnoseSclangOutput in ../index.js matches these exact strings to localize a boot that
// goes silent - no line at all means sclang never ran this script (a hanging user startup.scd
// runs first); this line but not the next means the stall is in this file; the next line but
// no scsynth output means scsynth itself never started. Keep the text in sync with index.js.
"poptart: engine script running".postln;

// --- tiny JSON writer (the class library has String.parseJSON but no serializer) ---
jsonEscape = { |str|
    str.asString
        .replace("\\", "\\\\").replace("\"", "\\\"")
        .replace(Char.nl.asString, "\\n").replace(Char.tab.asString, "\\t");
};
toJson = { |obj|
    case
    { obj.isNil } { "null" }
    { obj == true } { "true" }
    { obj == false } { "false" }
    { obj.isNumber } { if (obj.asFloat.isNaN) { "null" } { obj.asString } }
    { obj.isKindOf(Symbol) or: { obj.isKindOf(String) } } { "\"" ++ jsonEscape.(obj) ++ "\"" }
    { obj.isKindOf(Dictionary) } {
        var parts = List.new;
        obj.keysValuesDo { |k, v| parts.add("\"" ++ jsonEscape.(k) ++ "\":" ++ toJson.(v)) };
        "{" ++ parts.join(",") ++ "}";
    }
    { obj.isKindOf(SequenceableCollection) } {
        "[" ++ obj.collect({ |x| toJson.(x) }).join(",") ++ "]";
    }
    { "\"" ++ jsonEscape.(obj.asString) ++ "\"" };
};

// Reply payloads travel via temp file, not inline: a UDP datagram tops out around 64KB and
// real payloads blow through that (Serum 2's parameter list alone is ~2600 entries). The OSC
// reply carries only the file path; Node reads and deletes the file.
replyOk = { |address, requestId, payloadJson|
    var path = PathName.tmp +/+ ("poptart-reply-" ++ requestId ++ ".json");
    File.use(path, "w", { |f| f.write(payloadJson) });
    nodeAddr.sendMsg(address ++ ".reply", requestId, path);
};
replyErr = { |address, requestId, message|
    nodeAddr.sendMsg(address ++ ".error.reply", requestId, message.asString);
};

// Known plugins as plain data for the browser UI. Falls back to VSTPlugin's on-disk cache
// (readPlugins) before the first in-session search, so a previously-scanned machine shows its
// plugin list immediately on boot.
pluginList = {
    var dict = VSTPlugin.plugins(server);
    if (dict.isNil or: { dict.size == 0 }) { dict = VSTPlugin.readPlugins };
    dict.values.collect { |desc|
        (
            id: desc.key.asString,
            name: desc.name,
            manufacturer: desc.vendor,
            category: desc.category,
            format: desc.sdkVersion,
            isInstrument: desc.synth,
            numInputChannels: desc.inputs[0] !? _.channels ?? 0,
            numOutputChannels: desc.outputs[0] !? _.channels ?? 0,
            numParameters: desc.numParameters
        )
    };
};

// The plugin scan, shared by the boot scan and the /poptart/scanPlugins rescan.
//
// One search per directory rather than one search for all of them. VSTPlugin writes its plugin
// cache when a search FINISHES, and hands its results back at the same moment - so a single
// search over every folder is all-or-nothing: minutes of probing, and a server that dies partway
// (a crash-inducing plugin, a quit) leaves nothing behind at all and the next launch starts over.
// Split per folder, each finished folder saves its own work and its plugins become playable
// while the rest is still being probed.
//
// The brackets around it are the only way anything outside sclang can know a scan is running:
// VSTPlugin says nothing until a search returns, and /poptart/ready is deliberately sent BEFORE
// the scan starts (a fresh machine would otherwise wait minutes for an editor that needs no
// plugins at all). Node counts the individual probes off the log; this says when to start and
// stop counting.
runScan = { |onDone|
    var dirs = searchDirs ?? [nil]; // nil = VSTPlugin's own default locations
    scanning = true;
    nodeAddr.sendMsg("/poptart/scanState", "started", dirs.size);
    fork {
        dirs.do { |dir, i|
            var done = Condition.new;
            VSTPlugin.search(server, dir: dir, options: searchOptions, verbose: true, action: {
                done.test = true;
                done.signal;
            });
            done.wait;
            // This folder's plugins are in the dict (and the cache) as of now - say so, so the
            // plugin list can refill folder by folder instead of all at the end.
            nodeAddr.sendMsg("/poptart/scanState", "folder", i + 1);
        };
        scanning = false;
        nodeAddr.sendMsg("/poptart/scanState", "finished", VSTPlugin.plugins(server).size);
        onDone.value;
    };
};

trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };

// A track is not one synth but a row of them, in a group of its own, joined by private buses:
//
//   head    the instrument (a plugin or one of poptart's own devices) and the track's sample
//           voices, at the input gain - plus the track's bend and grain controls, which the head's
//           own instrument and the voices read
//   fx      one per effect the code writes, made when a chain first names its slot and kept for
//           as long as it does: a plugin and one of poptart's own devices, exactly one loaded
//   xover   one per .bands() crossover, the engine's own and never the user's (see routeApply)
//   term    a level, a pan or both on the way into a sum, made only where a .split()/.bands()
//           needs one
//   strip   the channel strip and everything after it: width, postgain, pan, the sends, the taps,
//           the DJ stage and the outputs
//
// Each reads the bus of what comes before it with In.ar and writes its own, and they run in that
// order inside the track's chain group, so the whole track is one pass through a block with no
// delay anywhere. A change of structure is buses and order (see routeApply) - an effect's node,
// and so its plugin and its program, is never rebuilt for one.
//
// Every track runs the SAME defs - nothing in them depends on the key - so they are built and sent
// once, by the first track, and every later track reuses them. Building costs sclang time and
// sclang is single-threaded with every NOTE passing through it: a 12-track song loading onto the
// other deck once spent ~300 ms building identical copies, during which the playing deck's notes
// queued up and then landed all at once (2026-10-06). Call from a routine - a track that asks
// while the first one is still sending waits for it.
sharedTrackDef = {
    case
    { trackDefState == \ready } { trackDef }
    { trackDefState == \adding } {
        while { trackDefState != \ready } { 0.01.wait };
        trackDef
    }
    {
        trackDefState = \adding;
        trackDef = (
            head: buildHeadDef.(),
            fx: buildFxDef.(),
            xover: buildXoverDef.(),
            strip: buildTrackDef.(\shared),
            dj: buildDjDef.(),
            tap: buildTapDef.(),
            bassmono: buildBassMonoDef.()
        );
        trackDef.do(_.add); // sends to server + global SynthDescLib
        server.sync;
        trackDefState = \ready;
        trackDef
    };
};

// The DJ stage's 3-band isolator EQ (see the DJ stage in the track def): `in` split into
// low / mid / high by a Linkwitz-Riley crossover tree at 250 Hz and 2.5 kHz, each band scaled by
// its gain (0 = a kill, 1 = unity, 2 = +6 dB), summed back.
//
// A TREE of LR4 crossovers, not a subtraction. The earlier isolator pulled the low and high
// bands out with filters and took the mid as `in - low - high`, which sums back exactly at
// neutral but nowhere else: the filters shift phase, so what the subtraction leaves is not the
// band it names. With the low at 0, 50 Hz came out only -5 dB, 80 Hz -1 dB, and 150-300 Hz
// BOOSTED by up to +4.3 dB - turning the bass all the way down kept the kick and added boom.
// Cutting the highs boosted 2-5 kHz by +4 dB the same way.
//
// An LR4 low/high pair (two cascaded 2-pole Butterworths each) sums to an all-pass, so the
// bands rebuild the input at flat magnitude and a band at 0 is gone. The low band also runs
// through the 2.5 kHz crossover's all-pass (its LR4 pair, summed), so the three bands carry the
// same phase and sum flat. At 0: 50 Hz -56 dB, 80 Hz -40 dB; nothing boosts anywhere.
//
// Flat, but phase-shifted, so at exact neutral the EQ is crossfaded OUT and an untouched track
// is bit-exact. The 50ms crossfade dips around the crossovers for its duration, on the first
// touch and on a reset.
djIsolator = { |in, lo, mid, hi|
    var xo = { |sig, f| [LPF.ar(LPF.ar(sig, f), f), HPF.ar(HPF.ar(sig, f), f)] };
    var split = xo.(in, 250);
    var upper = xo.(split[1], 2500);
    var low = xo.(split[0], 2500).sum; // the 2.5 kHz all-pass, to keep the low in phase
    var wet = (low * lo) + (upper[0] * mid) + (upper[1] * hi);
    var on = ((lo - 1).abs + (mid - 1).abs + (hi - 1).abs) > 0.001;
    LinXFade2.ar(in, wet, (on * 2 - 1).lag(0.05));
};

// The head of a track (see sharedTrackDef): its instrument, its sample voices and its input gain,
// written to the track's chain bus for the first effect, or the strip, to read.
buildHeadDef = {
    SynthDef(\poptart_head, { |inBus, out, gain = 1, bend = 0, bendrange = 2, bendOut,
        grainpos = 0, grainsize = 0.08, grainrate = 20, grainpan = 0, grainOut|
        var hasNativeDevices = \PoptartDevice.asClass.notNil; // see buildFxDef
        var sig, bendV, bendOn;
        // Pitch bend (Sig#bend), in semitones - a channel control like gain/pan, reaching this
        // synth by whichever route the control is driven from (a ramp for a polled signal, a
        // native LFO's bus, a plain set). Three things read it:
        //
        //   - the native instrument below, as a SIGNAL into its bend input;
        //   - the track's SAMPLE VOICES, which map \bend off the bus it is published on and fold
        //     it into their playback rate (see the poptart_sample_ defs). They sit at the head of
        //     the group, before this synth, so they read the value a block late - 1.5ms, inaudible;
        //   - the PLUGIN in slot 0, over MIDI, via the SendReply below.
        //
        // ReplaceOut rather than Out: a control bus is not cleared between blocks, so Out would
        // accumulate the value forever. There is exactly one writer per track.
        bendV = bend.lag(0.01).clip(-48, 48);
        ReplaceOut.kr(bendOut, bendV);
        // A VST takes pitch bend as a MIDI message, so something has to turn the bus back into
        // messages - sclang, at bendPollHz (see the bendOut OSCFunc). Sent only while the track is
        // actually bending, plus a tail after it centres so the centring message is never the one
        // that gets dropped: a track that never calls .bend() posts nothing at all. bendrange rides
        // along because the 14-bit encoding depends on it and it is a control like any other.
        bendOn = (bendV.abs > 1e-4);
        SendReply.kr(
            Impulse.kr(bendPollHz) * (bendOn + Trig1.kr(1 - bendOn, 0.1)).min(1),
            '/poptart/bendOut', [bendV, bendrange]);
        // The granular voice's live controls (Sig#grainsize and friends, and a streamed .begin()
        // as grainpos): channel controls for the same reason bend is one, and republished the
        // same way, four wide, for the track's granular voices to map. Unlagged on purpose: a
        // grain reads them once, as it starts, so there is no zipper to smooth, and a lag would
        // smear a per-grain rand() back into a drift (see steppedChannelControls).
        ReplaceOut.kr(grainOut, [grainpos, grainsize, grainrate, grainpan]);
        // The instrument's output, plus whatever the track's sample synths wrote to the private
        // input bus this block (they sit at the group's head, so In.ar sees them) - samples run
        // through the same chain a VST instrument would. Two kinds of instrument sit here and
        // exactly one of them is ever loaded: a plugin (VSTPlugin) and one of poptart's own
        // (PoptartDevice). Neither has an input, so the empty one is silent and summing them is
        // how the slot carries both. The native device takes the track's bend as a signal.
        sig = VSTPlugin.ar(nil, 2, id: \slot0)
            + if (hasNativeDevices) { \PoptartDevice.asClass.ar([], 2, bendV, nil, \nslot0) } { Silent.ar(2) }
            + In.ar(inBus, 2);
        // Input gain (Sig#gain, pseudo-slot -1 like the strip's controls): the level going INTO
        // the fx chain, which is where a channel strip's gain knob sits - turn a track down and
        // it drives its own compressor, saturator and reverb less hard. The level on the way OUT
        // of the chain is postgain, at the strip.
        Out.ar(out, sig * gain.lag(0.02).clip(0, 4));
    })
};

// One effect of a track: what it reads (`in`, and its sidechain on `scBus`), and what it writes
// (`out`), all buses, set by routeApply and by the sidechain wiring.
buildFxDef = {
    SynthDef(\poptart_fx, { |in, out, scBus, active = 0, native = 0, wet = 1|
        // Whether poptart's own devices are available (the PoptartDevice extension -
        // native/devices/, installed into the user's SC Extensions folder by extensions.js
        // before sclang starts). False on a platform nobody has built it for: the node then
        // carries a plugin only, and `fx("Filter")` warns instead of sounding. Asked HERE, inside
        // the def, so the def is a thing that can be lifted out and built on its own.
        var hasNativeDevices = \PoptartDevice.asClass.notNil;
        var jin = In.ar(in, 2);
        // The sidechain: silence unless a .sidechain() feeds it; a plugin with no aux input
        // simply ignores the extra bus (VSTPlugin tolerates a surplus bus). The `Ref([...])`
        // wrapping is how VSTPlugin.ar takes multi-bus input.
        var scIn = In.ar(scBus, 2);
        // The plugin and the native device in this slot, one of which is loaded (see the head).
        // A native device reads the sidechain as a second signal rather than a second bus, and
        // only the ones that cross-modulate read it at all.
        var plugin = VSTPlugin.ar(Ref([[jin[0], jin[1]], [scIn[0], scIn[1]]]), 2, id: \slot);
        var device = if (hasNativeDevices) {
            \PoptartDevice.asClass.ar([jin[0], jin[1]], 2, 0, [scIn[0], scIn[1]], \nslot)
        } { Silent.ar(2) };
        // Which of the two is this slot's output: 1 while a native device is in it, set by the
        // load that put it there (see loadDevice and loadEffect). NOT a sum, as the head is: an
        // empty VSTPlugin passes its input through (measured, VSTPlugin 0.6.2, NRT), so summing
        // would play the dry signal under every native effect. Not lagged: it only ever changes in
        // the message that also flips `active`, whose own lag is the fade.
        var pick = (plugin * (1 - native)) + (device * native);
        // How much of this slot reaches the rest of the chain. Two things multiplied: `active`,
        // the bypass flipped on only once a plugin actually loads (so an unloaded slot reads as
        // fully dry), and `wet`, the user's own mix control (Sig#wet, the channel control wetN).
        //
        // Linear rather than equal-power: a wet knob's endpoints have to be EXACTLY the dry
        // signal and EXACTLY the plugin's, which is what makes wet 0 a true bypass. Lagged like
        // the other streamed controls (the Tier-1 poll steps at ~30ms), which also turns a plugin
        // load/close into a short fade.
        var mix = (active * wet).lag(0.02).clip(0, 1);
        Out.ar(out, (jin * (1 - mix)) + (pick * mix));
    })
};

// A .bands() crossover: the Crossover device (native/devices/own/crossover.cc), its main input the
// signal it splits and its key the bands summed below it. It writes the band below its frequency
// (`out`), the rest above it (`rest`) and its key through its all-pass (`ap`). Its frequency is a
// control bus (the track's xo<k>, see routeApply) mapped onto the device's one control.
buildXoverDef = {
    SynthDef(\poptart_xover, { |in, out, key, rest, ap|
        var device = if (\PoptartDevice.asClass.notNil) {
            var k = In.ar(key, 2);
            var x = In.ar(in, 2);
            \PoptartDevice.asClass.ar([x[0], x[1]], 6, 0, [k[0], k[1]], \nslot)
        } { Silent.ar(6) };
        Out.ar(out, device[0..1]);
        Out.ar(rest, device[2..3]);
        Out.ar(ap, device[4..5]);
    })
};

// The strip of a track (see sharedTrackDef): everything after its chain.
buildTrackDef = { |key|
    // `in` is the bus the chain ends on (see routeApply); `post` is where the strip's own output
    // goes for whatever listens after it - the DJ stage, a send, a tap (see stripPost) - nowhere
    // until one does; `ctl` the control bus it publishes its fader, monitor, deck, dry, pair and
    // pair count on, for those to read the same values (see buildDjDef and buildTapDef).
    //
    // `pairs` is how many output pairs are in use: .o(n)'s wraparound folds pair indices past the
    // last pair IN USE back onto real outputs. In use, not merely allocated - wrapping at
    // numOutputBusChannels sent .o(2) into the silent tail of poptart's aggregate, and wrapping at
    // the interface's full width sends it to a back-panel jack nobody is monitoring. An argument,
    // so a change of output pairs reaches a running track (see trackPairs).
    SynthDef(trackDefName.(key), { |in, post, ctl, postgain = 1, pan = 0, width = 1, out = 1, pairs = 1, dry = 1,
        fader = 1, deck = 1, mon = 0, direct = 1|
        // The channel's DJ fader: it applies to the named-bus SENDS as well as to the direct
        // output - a post-fader send, the way a desk's are. A stem gated out of a mix has to go
        // quiet including whatever it was feeding, and a track written inside a group() has NO
        // direct output (it plays dry(0) and leaves through the group's bus), so this is what
        // gives the desk a working fader on a stem inside a group. Trim, the EQ, the filter and
        // the crossfader's `deck` gain stay on the direct path: `deck` has to be applied exactly
        // once per audible path.
        var faderAmt = fader.lag(0.08).clip(0, 1);
        // Monitor (a label's `M` marker - see monitorSig in pattern-core): the track goes to the
        // headphone cue pair in full (see the DJ stage, which a monitor brings in) and to nothing
        // the room hears. The taps keep reading it: they are listening, not playing.
        var mainAmt = 1 - mon.lag(0.05).clip(0, 1);
        var deckAmt = deck.lag(0.08).clip(0, 1);
        var dryAmt = dry.lag(0.02);
        var sig = In.ar(in, 2);
        // Width is mid/side: the sum is left alone and the difference is scaled, so 0 is mono, 1
        // is untouched, and 4 quadruples the stereo difference. It sits BEFORE the pan because the
        // two compose in that order and not the other. (Bass mono, which keeps the low end of the
        // difference out, is a node of its own before this one, made the first time it is asked
        // for - see bassMonoNode.)
        var mid = (sig[0] + sig[1]) * 0.5;
        var side = (sig[0] - sig[1]) * 0.5 * width.lag(0.02).clip(0, 4);
        // Postgain + equal-power pan (Sig#postgain/#pan), referenced to the center: Balance2's
        // sides at x sqrt(2), so a centered track is untouched and one panned all the way out is
        // +3 dB on its side - the web engine's law too.
        sig = Balance2.ar(mid + side, mid - side, pan.lag(0.02).clip(-1, 1), postgain.lag(0.02).clip(0, 4)) * 2.sqrt;
        ReplaceOut.kr(ctl, [faderAmt, mainAmt, deckAmt, dryAmt, out, pairs]);
        Out.ar(post, sig);
        // The direct output, unless the DJ stage has taken it over (`direct` 0, see djNode).
        Out.ar((out.round - 1).mod(pairs.max(1)) * 2, sig * (faderAmt * deckAmt * mainAmt * dryAmt * direct));
    });
};

// The DJ stage of a track: trim, the 3-band isolator, the filter, the cue and deck-meter taps, the
// DJ FX unit's send and the direct output after them - made the first time any of it is touched
// (see djNode), and from then on the track's direct output instead of the strip's.
//
// The filter: one knob (djf), negative a lowpass closing toward 20 Hz, positive a highpass opening
// toward 18 kHz, centered off - crossfaded in only away from center so an untouched knob is
// bit-exact. Resonance is its own control (djres). The DJ FX unit's insert is a send taken here,
// after trim/EQ/filter and pre-fader, with the direct path turned down by the same amount - the
// whole channel through the unit at 1, untouched at 0.
buildDjDef = {
    SynthDef(\poptart_dj, { |in, ctl, trim = 1, eqlo = 1, eqmid = 1, eqhi = 1, djf = 0, djres = 0,
        cue = 0, cueBus, mdeck = -1, meterBus, fxOut, fxSend = 0|
        var c = In.kr(ctl, 6);
        var faderAmt = c[0], mainAmt = c[1], deckAmt = c[2], dryAmt = c[3], out = c[4], pairs = c[5];
        var live = djIsolator.(In.ar(in, 2) * trim.lag(0.08).clip(0, 4),
            eqlo.lag(0.08).clip(0, 2), eqmid.lag(0.08).clip(0, 2), eqhi.lag(0.08).clip(0, 2));
        var djv = djf.lag(0.15).clip(-1, 1);
        var djLpf = (18000 * (900 ** djv.min(0))).clip(20, 18000); // -1 -> 20 Hz, 0 -> open
        var djHpf = (20 * (900 ** djv.max(0))).clip(20, 18000); // 0 -> open, 1 -> 18 kHz
        var djq = 1 - (0.62 * djres.lag(0.08).clip(0, 1));
        var djWet = RHPF.ar(RLPF.ar(live, djLpf, djq), djHpf, djq);
        var fxAmt = fxSend.lag(0.08).clip(0, 1);
        live = LinXFade2.ar(live, djWet, ((djv.abs > 0.005) * 2 - 1).lag(0.05));
        // The cue: on the cue switch, and in full while the track is monitored.
        Out.ar(cueBus, live * cue.max(1 - mainAmt).lag(0.05).clip(0, 1));
        Out.ar(meterBus + (mdeck.max(0) * 2), live * (mdeck > -0.5));
        Out.ar(fxOut, live * fxAmt * faderAmt * mainAmt);
        Out.ar((out.round - 1).mod(pairs.max(1)) * 2, live * ((1 - fxAmt) * faderAmt * deckAmt * mainAmt * dryAmt));
    })
};

// A copy of the strip's output to somewhere: a named bus (Sig#bus, post-fader), the track's
// sidechain send, the recorder or the mixer's analysis. One node per tap, made while something is
// listening and freed when nothing is (see stripTap).
buildTapDef = {
    SynthDef(\poptart_tap, { |in, out, ctl, amp = 1, post = 0|
        var c = In.kr(ctl, 2);
        Out.ar(out, In.ar(in, 2) * (amp.lag(0.02) * Select.kr(post, [1, c[0] * c[1]])));
    })
};

// Bass mono (Sig#bassmono): the stereo difference below the frequency taken out, between the chain
// and the strip - made the first time it is asked for (see bassMonoNode).
buildBassMonoDef = {
    SynthDef(\poptart_bassmono, { |in, out, bassmono = 0|
        var sig = In.ar(in, 2);
        var mid = (sig[0] + sig[1]) * 0.5;
        var side = (sig[0] - sig[1]) * 0.5;
        side = LinXFade2.ar(side, HPF.ar(side, bassmono.lag(0.05).clip(20, 2000)), ((bassmono > 0) * 2 - 1).lag(0.05));
        Out.ar(out, [mid + side, mid - side]);
    })
};

// Neutral value a channel control (pseudo-slot -1) snaps back to when its modulator is cleared:
// unity gain in and out, center pan, first output pair - and for the DJ stage, unity
// trim/bands/fader/deck (djf's neutral is 0, the filter's center detent; djres's is 0, no resonance).
channelDefault = { |name|
    // bendrange is the one control whose neutral is neither 0 nor 1: it is how many semitones a
    // full MIDI pitch bend is worth, so clearing a modulator off it has to leave the 2 nearly every
    // synth powers up on (DEFAULT_BEND_RANGE in signal.mjs). Zero would be worse than wrong - the
    // bend encoding divides by it, so every bend would saturate at once. `bend` itself falls
    // through to 0 below, which is centre, exactly as pan's does.
    // wet1..wet7 (Sig#wet, the per-fx-slot dry/wet) belong with the unity controls: neutral for a
    // wet control is the plugin's own output, and a modulator cleared off one must leave the
    // effect sounding rather than silently bypassing it.
    // grainsize and grainrate likewise: a granular voice left reading 0 seconds at 0 grains a
    // second plays nothing. The same numbers as CHANNEL_DEFAULTS in signal.mjs.
    case
    { name == "bendrange" } { 2 }
    { name == "grainsize" } { 0.08 }
    { name == "grainrate" } { 20 }
    // A branch's level is unity until something sets it (a branch pan falls through to 0,
    // center, below), and a crossover rests at 1 kHz, as a position on its control (route.mjs).
    { name.asString.findRegexp("^rl[0-9]+$").notEmpty } { 1 }
    { name.asString.findRegexp("^xo[0-9]+$").notEmpty } { (1000 - 20) / (20000 - 20) }
    {
        if ((name == "gain") or: { name == "postgain" } or: { name == "out" } or: { name == "dry" } or: { name == "width" }
            or: { name == "trim" } or: { name == "fader" } or: { name == "deck" }
            or: { name == "eqlo" } or: { name == "eqmid" } or: { name == "eqhi" }
            or: { name.asString.beginsWith("wet") }) { 1 } { 0 };
    };
};

// Parked sidechain args for a freshly created track synth: every fx-slot aux input reads the
// silent bus (so plugins see silence until routed), and the track's own send is parked to the
// trash bus. setSidechain repoints the relevant args when a route is set up.
scArgsFor = { [] }; // nothing is parked on the strip any more: its taps and sends are nodes made when wanted

// --- a track's optional stages ---------------------------------------------------------------
//
// Nothing after the strip runs until the code asks for it: the DJ stage, each tap and each send is
// a node of its own, made the first time it is wanted (see sharedTrackDef).

// How many output pairs are in use (see the strip's `pairs`).
trackPairs = { max(1, min(playChannels, server.options.numOutputBusChannels) div: 2) };

// The bus the strip writes for what listens after it, made the first time anything does.
stripPost = { |track|
    track[\post] ?? {
        var bus = Bus.audio(server, 2);
        track[\post] = bus;
        track[\synth].set(\post, bus.index);
        bus
    };
};

// The DJ stage, made the first time one of its controls is touched (or the track is monitored,
// whose cue it plays). From then on it plays the track's direct output and the strip does not -
// switched in one bundle, so no block plays both or neither.
djNode = { |track|
    track[\dj] ?? {
        var post = stripPost.(track);
        var node;
        server.makeBundle(nil, {
            node = Synth(trackDef[\dj].name, [\in, post.index, \ctl, track[\ctlBus].index,
                \cueBus, cueOffset ? routeNowhere, \meterBus, deckMeterBus.index, \fxOut, routeNowhere],
                target: track[\postGroup], addAction: \addToHead);
            track[\synth].set(\direct, 0);
        });
        nodeOwns.(node.nodeID, "a track's DJ stage");
        track[\dj] = node;
        node
    };
};

// A copy of the strip's output to `out` at `amp` (post: after the fader and the monitor), as tap
// `name` - made, moved or (with a nil `out`) freed.
stripTap = { |track, name, out, amp = 1, post = 0|
    var taps = track[\taps];
    var held = taps[name];
    if (out.isNil) {
        held !? { held.free; taps.removeAt(name); tellTap.(track, name, nil) };
    } {
        if (held.isNil) {
            var node = Synth(trackDef[\tap].name, [\in, stripPost.(track).index, \out, out, \ctl, track[\ctlBus].index,
                \amp, amp, \post, post], target: track[\postGroup], addAction: \addToTail);
            nodeOwns.(node.nodeID, "a track's " ++ name ++ " tap");
            taps[name] = node;
            tellTap.(track, name, node);
        } {
            held.set(\out, out, \amp, amp, \post, post);
        };
    };
};

// Bass mono, made the first time it is asked for: between the chain and the strip.
bassMonoNode = { |track|
    track[\bassmono] ?? {
        var bus = Bus.audio(server, 2);
        var node;
        server.makeBundle(nil, {
            node = Synth(trackDef[\bassmono].name, [\in, track[\chainOut] ? track[\chainIn].index, \out, bus.index],
                target: track[\synth], addAction: \addBefore);
            track[\synth].set(\in, bus.index);
        });
        nodeOwns.(node.nodeID, "a track's bass mono");
        track[\bassmono] = node;
        track[\bassmonoBus] = bus;
        node
    };
};

// The node a track's slot is: the head for the instrument (0), an effect's own node for 1..n, or nil.
slotNode = { |track, slot| if (slot == 0) { track[\head] } { track[\nodes][slot] } };

// The node for effect slot `slot`, made if the track has none yet - parked (reading and writing
// nowhere) just before the strip, until routeApply wires it. It is kept from then on, whatever the
// chain's structure does, so its plugin is never reloaded for a change of wiring.
ensureFxNode = { |key, track, slot|
    track[\nodes][slot] ?? {
        var node = Synth(trackDef[\fx].name, [\in, routeNowhere, \out, routeNowhere,
            \scBus, track[\scBus][slot] ? silentBus.index] ++ (track[\wet][slot] !? { |w| [\wet, w] } ? []),
            target: track[\synth], addAction: \addBefore);
        nodeOwns.(node.nodeID, key ++ "'s effect " ++ slot);
        track[\nodes][slot] = node;
        node
    };
};

// A slot's sidechain bus, kept for a node made later as well as set on the one there is.
setScBus = { |track, slot, index|
    track[\scBus][slot] = index;
    track[\nodes][slot] !? { |n| n.set(\scBus, index) };
};

// The control-rate publisher of one route control: a branch level and pan pair (rl<k>/rp<k>) or a
// crossover frequency (xo<k>), made when first wanted and kept for the track's life, in the chain
// group's head so everything after it reads this block's value. `kind` is \gain or \xo.
routeKrNode = { |track, kind, k|
    var all = track[if (kind == \gain) { \gains } { \xos }];
    all[k] ?? {
        var bus = Bus.control(server, if (kind == \gain) { 2 } { 1 });
        var node = if (kind == \gain) {
            bus.setn([1, 0]);
            Synth(\poptart_gainkr, [\out, bus.index], target: track[\krGroup], addAction: \addToTail)
        } {
            bus.set(channelDefault.("xo1"));
            Synth(\poptart_xokr, [\out, bus.index, \value, channelDefault.("xo1")], target: track[\krGroup], addAction: \addToTail)
        };
        all[k] = (node: node, bus: bus);
        all[k]
    };
};

// Where a channel control (slot -1) of a track lives, as [node, control]. Most are the strip's;
// the input gain, the bend and the grain controls are the head's; wetN is effect N's own mix; and
// a route control is its publisher's (see routeKrNode). nil for a wetN with no effect N yet - its
// value is kept for the node that will be made.
channelTarget = { |track, name|
    var str = name.asString;
    var m = str.findRegexp("^(rl|rp|xo|wet)([0-9]+)$");
    if (m.size >= 3) {
        var which = m[1][1], k = m[2][1].asInteger;
        case
        { which == "wet" } { track[\nodes][k] !? { |n| [n, \wet] } }
        { which == "xo" } { [routeKrNode.(track, \xo, k)[\node], \value] }
        { [routeKrNode.(track, \gain, k)[\node], if (which == "rl") { \level } { \pan }] }
    } {
        var sym = str.asSymbol;
        case
        { #[\gain, \bend, \bendrange, \grainpos, \grainsize, \grainrate, \grainpan].includes(sym) } { [track[\head], sym] }
        { #[\trim, \eqlo, \eqmid, \eqhi, \djf, \djres, \cue, \mdeck].includes(sym) } { [djNode.(track), sym] }
        { sym == \bassmono } { [bassMonoNode.(track), sym] }
        {
            // A monitored track plays to the cue pair, which the DJ stage does.
            if ((sym == \mon) and: { cueOffset.notNil }) { djNode.(track) };
            [track[\synth], sym]
        }
    };
};

// Dict key for a sidechain route, identifying the aux input by (target track, fx slot).
scKey = { |targetKey, slot| (targetKey.asString ++ "#" ++ slot).asSymbol };

// Get-or-create a named audio bus, bumping its refcount; returns the Bus. Every writer (Sig#bus)
// and reader (audio("name")) holds one ref, so the bus outlives whichever end is set up first.
acquireBus = { |name|
    var key = name.asSymbol;
    var entry = namedBuses[key];
    if (entry.isNil) { entry = (bus: Bus.audio(server, 2), refs: 0); namedBuses[key] = entry };
    entry[\refs] = entry[\refs] + 1;
    entry[\bus];
};
// Drop one ref on a named bus; free it (and forget the name) once nothing references it.
releaseBus = { |name|
    var key = name.asSymbol;
    namedBuses[key] !? { |entry|
        entry[\refs] = entry[\refs] - 1;
        if (entry[\refs] <= 0) { entry[\bus].free; namedBuses[key] = nil };
    };
};

// The bus a source track's output is offered on, so that any number of routes can read it.
//
// A track synth has exactly ONE send (\scSend, see buildTrackDef), so pointing it straight at a
// sink limited each source to a single sink - and silently, because wiring the second route just
// moved the send off the first. `audio("kick").fx("ValhallaRoom").fx("Kickstart 2").audio("kick")`
// is the ordinary case that hits it: the kick feeds this track's chain input AND slot 2's
// sidechain, and the sidechain route stole the head input, so the chain went quiet. The send now
// writes here instead and each route runs its own \poptart_busread reader off it.
//
// Refcounted like a named bus, so the send parks itself again once the last route goes.
acquireSourceFeed = { |nameKey, source|
    var entry = sourceFeeds[nameKey];
    if (entry.isNil) {
        entry = (bus: Bus.audio(server, 2), refs: 0);
        sourceFeeds[nameKey] = entry;
        // Unity at the source: each reader scales its own copy, so two sinks can ask for
        // different amounts of the same track.
        stripTap.(source, \sidechain, entry[\bus].index, 1, 0);
    };
    entry[\refs] = entry[\refs] + 1;
    entry[\bus];
};
releaseSourceFeed = { |nameKey|
    sourceFeeds[nameKey] !? { |entry|
        entry[\refs] = entry[\refs] - 1;
        if (entry[\refs] <= 0) {
            tracks[nameKey] !? { |s| if (s.isKindOf(Event)) { stripTap.(s, \sidechain, nil) } };
            entry[\bus].free;
            sourceFeeds[nameKey] = nil;
        };
    };
};

// Wire an audio route into a sink on `targetKey`: slot >= 1 is an fx aux (sidechain) input, slot
// 0 is the chain input (a head audio() source). `rawName` is a source track ("label"/"track:label")
// or a hardware input ("dev:..."). A track source offers its output on a shared feed bus that this
// route reads a copy of, and is ordered ahead of the target (see acquireSourceFeed - that shared
// bus is what lets one source feed several sinks); a device source runs a SoundIn feeder at the
// head writing the sink bus directly. The fx aux gets a freshly allocated bus (pointed at via
// \scBusN); the chain input reuses the track's own inBus. Idempotent: an existing route on the
// same sink is torn down first.
// `inA`/`inB` are the hardware channels a device source reads, absolute and 0-indexed (inB -1 =
// mono, duplicated to both sides); ignored for a track/bus source. pattern-core resolves them from
// input()'s 1-indexed, optionally device-relative form before they get here.
// "a key is (not) patched into this slot", for one of poptart's own devices in it.
//
// The compressor listens to itself with nothing routed in and to the key with something, and the
// ducker dips on the clock with nothing and on the key's transients with something - and the aux
// bus is there either way (it reads silentBus until a route is wired), so silence on it says
// nothing at all. A plugin needs no telling: its aux input is a bus like any other.
//
// Called with no third argument it looks the answer up, which is what a device opening into a
// slot that was already wired needs.
tellKeyPatched = { |target, slot, patched, targetKey|
    var ctl = if (target.isKindOf(Event)) { target[\controllers] !? { |all| all[slot] } };
    if (ctl.notNil and: { ctl.respondsTo(\sidechain) }) {
        var on = patched ?? {
            targetKey.notNil and: { sidechainByTarget[scKey.(targetKey, slot)].notNil }
        };
        ctl.sidechain(on);
    };
};

wireAudio = { |targetKey, slot, rawName, gain, inA = 0, inB = 1|
    fork {
        var target = awaitTrack.(targetKey);
        var str = rawName.asString;
        var isDev = str.copyRange(0, 3) == "dev:";
        var isBusPrefix = str.copyRange(0, 3) == "bus:";
        var name = case
            { isDev } { str.drop(4) }
            { isBusPrefix } { str.drop(4) }
            { str.copyRange(0, 5) == "track:" } { str.drop(6) }
            { str };
        var key = scKey.(targetKey, slot);
        case
        { target.isNil } { ("poptart: audio route: no track " ++ targetKey).warn }
        { slot < 0 } { ("poptart: audio route: bad slot " ++ slot).warn }
        { true } {
            var destBus, ownsBus, nameKey = name.asSymbol;
            unwireAudio.(targetKey, slot); // retire any existing route on this sink first
            if (slot >= 1) {
                destBus = Bus.audio(server, 2);
                ownsBus = true;
                setScBus.(target, slot, destBus.index);
                tellKeyPatched.(target, slot, true);
            } {
                destBus = target[\inBus]; // chain input: the track already mixes inBus into slot 0
                ownsBus = false;
            };
            case
            { isDev } {
                var feeder, mono = inB < 0, inChans = server.options.numInputBusChannels;
                var last = max(0, inChans - 1);
                var wanted = if (mono) { [inA] } { [inA, inB] };
                // Clamp here rather than in the SynthDef: the channel count is a plain integer in
                // sclang, so the feeder gets a bus index and no Clip UGen on In.ar's index input.
                var readA = inA.clip(0, last), readB = inB.clip(0, last);
                if (inChans < 1) {
                    ("poptart: input(): the audio device exposes no input channels - nothing to read "
                        ++ "(pick an input-capable device in settings)").warn;
                };
                // Out-of-range reads the last real channel, so this warning is the only way the
                // user learns they asked for a channel the device hasn't got.
                if ((inChans > 0) and: { wanted.any { |c| c >= inChans } }) {
                    ("poptart: input(): channel " ++ (wanted.collect { |c| c + 1 }.join("/"))
                        ++ " is past the device's " ++ inChans ++ " input channels - reading the last one").warn;
                };
                feeder = if (mono) {
                    Synth(\poptart_soundin_mono, [\out, destBus.index, \inA, readA, \gain, gain],
                        target: server.defaultGroup, addAction: \addToHead);
                } {
                    Synth(\poptart_soundin, [\out, destBus.index, \inA, readA, \inB, readB, \gain, gain],
                        target: server.defaultGroup, addAction: \addToHead);
                };
                sidechainByTarget[key] = (bus: destBus, target: target, targetKey: targetKey, slot: slot, source: nil, feeder: feeder, busName: nil, owns: ownsBus);
                ("poptart: audio input: ch " ++ (wanted.collect { |c| c + 1 }.join("+"))
                    ++ if (name.isEmpty) { "" } { " of '" ++ name ++ "'" }
                    ++ " -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
            }
            { true } {
                // Resolve a bare / "track:" / "bus:" name. Both a source track and a bus writer may
                // be created in the same eval as this reader, so wait briefly for either to appear;
                // otherwise track-first with a bus of that name as fallback. A track reading its OWN
                // name (drums: audio("drums")) means the bus, not itself - self-routing would feed
                // the track's output back into its own input - so a self match doesn't count as a
                // track here, and we wait for the bus instead. "bus:" forces a bus and waits for
                // nothing: there is nothing to tell apart, and a bus nobody writes yet is simply
                // silence until someone does (a group() evaluated ahead of its variations).
                var tries = 0, max = (5 / 0.05).asInteger, source, useBus;
                while {
                    isBusPrefix.not
                    and: { ((nameKey != targetKey and: { tracks[nameKey].isKindOf(Event) })
                        or: { namedBuses[nameKey].notNil }).not }
                    and: { tries < max }
                } { 0.05.wait; tries = tries + 1 };
                source = if (isBusPrefix or: { nameKey == targetKey }) { nil } { tracks[nameKey] };
                useBus = isBusPrefix or: { source.isKindOf(Event).not and: { namedBuses[nameKey].notNil } };
                case
                { source.isKindOf(Event) } {
                    // A track source offers its output on a shared feed bus (acquireSourceFeed)
                    // and this route reads a copy of it into the sink - so the same source can
                    // feed a chain input and a sidechain, or two tracks' duckers, at once. The
                    // reader sits at the head of the sink's group and the sink's group is ordered
                    // after the source's (reorderTracks), so the copy lands the same block.
                    var feedBus = acquireSourceFeed.(nameKey, source);
                    var feeder = Synth(\poptart_busread, [\out, destBus.index, \in, feedBus.index, \gain, gain],
                        target: target[\group], addAction: \addToHead);
                    sidechainByTarget[key] = (bus: destBus, target: target, targetKey: targetKey, slot: slot, source: nameKey, feeder: feeder, busName: nil, owns: ownsBus);
                    sidechainBySource[nameKey] = (sidechainBySource[nameKey] ?? { [] }).add((targetKey: targetKey, slot: slot));
                    reorderTracks.();
                    ("poptart: audio route: " ++ name ++ " -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
                }
                { useBus } {
                    // A named bus (Sig#bus): a reader feeder copies the bus into the sink's input,
                    // at the head of the sink's group so it lands before the track synth reads it,
                    // and the sink's group is ordered after the bus's writers (reorderTracks) so it
                    // sees their sum this block, not silence. The reader holds a bus ref while it's
                    // routed.
                    var busObj = acquireBus.(name);
                    var feeder = Synth(\poptart_busread, [\out, destBus.index, \in, busObj.index, \gain, gain],
                        target: target[\group], addAction: \addToHead);
                    sidechainByTarget[key] = (bus: destBus, target: target, targetKey: targetKey, slot: slot, source: nil, feeder: feeder, busName: name, owns: ownsBus);
                    reorderTracks.();
                    ("poptart: audio route: bus '" ++ name ++ "' -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
                }
                { true } { ("poptart: audio route: '" ++ name ++ "' is neither a track nor a bus").warn };
            };
        };
    };
};

// Undo a route on (targetKey, slot): park an fx aux back to silence, park a track source's send
// (or free a device feeder), and free the bus if we allocated it. No-op if not routed.
unwireAudio = { |targetKey, slot|
    var key = scKey.(targetKey, slot);
    var entry = sidechainByTarget[key];
    entry !? {
        var target = tracks[targetKey];
        if ((slot >= 1) and: { target.isKindOf(Event) }) {
            setScBus.(target, slot, silentBus.index);
            tellKeyPatched.(target, slot, false);
        };
        entry[\source] !? { |src|
            // One route off a source that may still feed others: drop this sink from its list and
            // let the refcount decide whether the source's send goes back to the trash bus.
            var left = (sidechainBySource[src] ?? { [] }).reject { |e|
                (e[\targetKey] == targetKey) and: { e[\slot] == slot }
            };
            sidechainBySource[src] = if (left.isEmpty) { nil } { left };
            releaseSourceFeed.(src);
        };
        entry[\busName] !? { |bn| releaseBus.(bn) }; // a bus reader held a ref - drop it
        entry[\feeder] !? { |f| f.free };
        if (entry[\owns]) { entry[\bus].free };
        sidechainByTarget[key] = nil;
        reorderTracks.(); // the sink may sit shallower now
    };
};

paramRouteKey = { |targetKey, slot, name| (targetKey.asString ++ "#" ++ slot ++ "#" ++ name).asSymbol };

// Puts a route onto the device in its slot, if that device can take one. Called when the route
// is wired and again whenever a device opens into the slot (loadDevice), because a device that
// takes the slot starts with every control on its own default (PoptartDevice.cpp's install).
applyParamRoute = { |track, entry|
    var slot = entry[\slot];
    var target = paramTarget.(track, slot, entry[\name]);
    case
    // A control of a slot whose plugin is not open yet: the open applies it.
    { target.isNil } { nil }
    { target[\mapAudio].isNil } {
        if (entry[\warned] != track[\loaded][slot]) {
            entry[\warned] = track[\loaded][slot];
            ("poptart: audio patched onto '" ++ entry[\name] ++ "' reaches poptart's own devices only - "
                ++ track[\loaded][slot] ++ " is a plugin, so nothing is connected").warn;
        };
    }
    {
        // A polled value the route replaced leaves a ramp behind; it goes now.
        dropRamp.(entry[\targetKey], track, ("slot" ++ slot ++ "_" ++ entry[\name]).asSymbol);
        entry[\index] = target[\index];
        target[\mapAudio].(entry[\fbBus] ? entry[\bus], entry[\gain], entry[\offset]);
    };
};

// After something else took a control off its audio bus (an audio-rate env() being cleared), the
// route that is still wanted there goes back on.
reassertParamRoute = { |key, track, slot, name|
    paramRoutes[paramRouteKey.(key, slot, name)] !? { |entry| applyParamRoute.(track, entry) };
};

// Wire a track's output or a named bus onto a parameter. `rawName` resolves as a sidechain's
// does (see wireAudio): a track first, a bus by that name otherwise, "bus:" to force a bus; a
// track naming itself means the bus. Gain and offset ride on the route and are applied by the
// UGen. Idempotent: a route already on the parameter is retired first.
wireParamRoute = { |targetKey, slot, name, rawName, gain, offset|
    var k = paramRouteKey.(targetKey, slot, name);
    var token = Object.new;
    unwireParamRoute.(targetKey, slot, name);
    paramRoutes[k] = (pending: token, targetKey: targetKey, slot: slot, name: name);
    fork {
        var target = awaitTrack.(targetKey);
        var str = rawName.asString;
        var isBusPrefix = str.copyRange(0, 3) == "bus:";
        var srcName = case
            { isBusPrefix } { str.drop(4) }
            { str.copyRange(0, 5) == "track:" } { str.drop(6) }
            { str };
        var nameKey = srcName.asSymbol;
        var tries = 0, max = (5 / 0.05).asInteger, source, useBus, entry;
        // Still the route this wiring was started for, and not one wired or dropped since.
        var current = { (paramRoutes[k] ? ()).at(\pending) === token };
        case
        { target.isNil } {
            ("poptart: audio source: no track " ++ targetKey).warn;
            if (current.()) { paramRoutes.removeAt(k) };
        }
        { str.copyRange(0, 3) == "dev:" } {
            ("poptart: audio source: a hardware input cannot be patched onto a parameter - route it "
                ++ "to a track first").warn;
            if (current.()) { paramRoutes.removeAt(k) };
        }
        {
            while {
                isBusPrefix.not
                and: { ((nameKey != targetKey and: { tracks[nameKey].isKindOf(Event) })
                    or: { namedBuses[nameKey].notNil }).not }
                and: { tries < max }
            } { 0.05.wait; tries = tries + 1 };
            // Superseded or dropped while it waited for its source.
            if (current.()) {
                source = if (isBusPrefix or: { nameKey == targetKey }) { nil } { tracks[nameKey] };
                useBus = isBusPrefix or: { source.isKindOf(Event).not and: { namedBuses[nameKey].notNil } };
                entry = (targetKey: targetKey, slot: slot, name: name, gain: gain, offset: offset, source: nil, busName: nil);
                case
                { source.isKindOf(Event) } {
                    entry[\bus] = acquireSourceFeed.(nameKey, source);
                    entry[\source] = nameKey;
                }
                { useBus } {
                    entry[\bus] = acquireBus.(srcName);
                    entry[\busName] = srcName;
                }
                { true } { entry = nil };
                if (entry.isNil) {
                    paramRoutes.removeAt(k);
                    ("poptart: audio source: '" ++ srcName ++ "' is neither a track nor a bus").warn;
                } {
                    paramRoutes[k] = entry;
                    reorderTracks.();
                    applyParamRoute.(target, entry);
                    ("poptart: patched " ++ srcName ++ " onto '" ++ name ++ "' of " ++ targetKey
                        ++ " (slot " ++ slot ++ ")").postln;
                };
            };
        };
    };
};

// Undo one: the control goes back to the last value set on it (or to a native env() mapped while
// it was patched), and the source's feed or the bus is released. No-op when nothing is patched.
unwireParamRoute = { |targetKey, slot, name|
    var k = paramRouteKey.(targetKey, slot, name);
    var entry = paramRoutes.removeAt(k);
    var track = tracks[targetKey];
    if (entry.notNil and: { entry[\pending].isNil }) {
        if (track.isKindOf(Event) and: { entry[\index].notNil }) {
            paramTarget.(track, slot, name, entry[\index]) !? { |target|
                target[\unmapAudio] !? { |off| off.() };
            };
        };
        entry[\source] !? { |src| releaseSourceFeed.(src) };
        entry[\busName] !? { |bn| releaseBus.(bn) };
        // A closing edge's copy of the block before (see reorderTracks).
        entry[\fbFeeder] !? { |f| f.free };
        entry[\fbBus] !? { |b| b.free };
        reorderTracks.();
    };
};

// --- what a param call is aimed at ----------------------------------------------------------
//
// Every handler that drives a control through a bus (a ramp, an LFO, an envelope, a cc, an osc
// address, an audio route, an expression's output) maps it through ONE object instead of deciding
// for itself between the track synth, a plugin and a device. Three kinds:
//   \channel  slot -1: the track synth's own control (gain, pan, ...)
//   \control  a parameter of the plugin or device in the slot, by index
//   \leaf     input i of the expression on `name`, addressed as "~i~name" (see setParamExpr):
//             whatever would drive a control drives that input instead
// Each has map (a control bus), unmap, and - where the reader takes one per sample - mapAudio /
// unmapAudio (an audio bus). nil for a control that cannot be resolved (no plugin open yet, or no
// such parameter). `index` short-circuits the lookup, for a teardown that only has what it stored.
exprLeaf = { |name|
    var m = name.asString.findRegexp("^~([0-9]+)~(.*)$");
    if (m.size >= 3) { [m[1][1].asInteger, m[2][1]] };
};
busIndexOf = { |bus| if (bus.isKindOf(Bus)) { bus.index } { bus } };
paramTarget = { |track, slot, paramName, index|
    var leaf = exprLeaf.(paramName);
    case
    { leaf.notNil } {
        var i = leaf[0], realName = leaf[1];
        (kind: \leaf, index: paramName.asSymbol, audio: true,
            map: { |bus| exprFeed.(track, slot, realName, i, \kr, busIndexOf.(bus)) },
            unmap: { exprFeed.(track, slot, realName, i, \kr, -1) },
            mapAudio: { |bus| exprFeed.(track, slot, realName, i, \ar, busIndexOf.(bus)) },
            unmapAudio: { exprFeed.(track, slot, realName, i, \ar, -1) })
    }
    { slot == -1 } {
        var at = channelTarget.(track, paramName);
        var wetSlot = paramName.asString.findRegexp("^wet([0-9]+)$");
        (kind: \channel, index: paramName.asSymbol, audio: false,
            map: { |bus| at !? { at[0].map(at[1], bus) } },
            // Unmapping leaves a control at whatever the bus last wrote, so it goes back to neutral.
            unmap: { at !? { at[0].map(at[1], -1); at[0].set(at[1], channelDefault.(paramName)) } },
            // A plain value, kept for an effect node made later where it has none yet.
            set: { |value|
                if (wetSlot.size >= 2) { track[\wet][wetSlot[1][1].asInteger] = value };
                at !? { at[0].set(at[1], value) };
            })
    }
    {
        var ctl = track[\controllers][slot];
        var at = index ?? { if (ctl.notNil and: { ctl.info.notNil }) { resolveParamIndex.(ctl.info, paramName) } };
        if (ctl.notNil and: { at.notNil }) {
            var native = ctl.respondsTo(\mapAudio);
            (kind: \control, index: at, audio: native,
                map: { |bus| ctl.map(at, bus) },
                unmap: { ctl.unmap(at) },
                mapAudio: if (native) { { |bus, gain = 1, offset = 0| ctl.mapAudio(at, bus, gain, offset) } },
                unmapAudio: if (native) { {
                    ctl.unmapAudio(at);
                    // Back on the value last set - and onto whichever audio-rate driver is still
                    // wanted there (the caller has already dropped its own).
                    ctl.get(at, { |v| ctl.set(at, v) });
                    reassertAudioDrivers.(track, slot, paramName);
                } })
        };
    };
};

// After an audio driver comes off a device's control, the one still meant to be there goes back
// on: an audio-rate env(), or an expression's output.
reassertAudioDrivers = { |track, slot, paramName|
    var k = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var ctl = track[\controllers][slot];
    var index = ctl !? { ctl.info !? { |info| resolveParamIndex.(info, paramName) } };
    if (index.notNil and: { ctl.respondsTo(\mapAudio) }) {
        case
        { track[\envs][k].notNil and: { track[\envs][k][\audio] == true } } { ctl.mapAudio(index, track[\envs][k][\bus], 1, 0) }
        { (track[\exprs] ? ()).at(k).notNil and: { track[\exprs][k][\outKind] == \device } } {
            ctl.mapAudio(index, track[\exprs][k][\out], 1, 0)
        };
    };
};

// Waits (in a fork) for what a modulator is to be mapped onto, saying why when there is nothing:
// a channel control and an expression input never wait for a plugin, a parameter does.
awaitTarget = { |track, slot, paramName, who|
    if (exprLeaf.(paramName).isNil and: { slot != -1 } and: { awaitLoaded.(track, slot).not }) {
        ("poptart: " ++ who ++ ": no plugin loaded in slot " ++ slot).warn;
        nil;
    } {
        paramTarget.(track, slot, paramName) ?? {
            ("poptart: " ++ who ++ ": plugin has no parameter named '" ++ paramName
                ++ "' (see getParams / the params panel for real names)").warn;
            nil;
        };
    };
};

// --- param expressions ('/poptart/setParamExpr') ----------------------------------------------
//
// A `.param()` value that combines signals - audio from another track, modulators, polled values,
// constants - in a way no single modulator covers is sent as a tree and evaluated here per sample,
// by one synth per (track, slot, name). Its inputs are buses like every other driver's: each `in`
// leaf is fed by an ordinary param call on the leaf name "~i~name" (so an LFO, an envelope, a cc,
// a polled value all reach it through the code that already runs them), or, for a `source` leaf,
// by an audio route from that track or bus (the routes above, which also keep node order). The
// output drives the real control as an audio-rate envelope does: mapAudio onto a device, a control
// bus onto a plugin parameter or a channel control.
//
// One SynthDef per tree SHAPE and output kind. Constants are named controls (c0, c1, ... in
// walk order), so a tree that differs only in its numbers - a knob dragged in the device window,
// a re-eval that changed a depth - is a .set on the running synth, never a rebuild.
//
// Tree nodes (parsed JSON, string keys): {k:const, v}, {k:in, i, rate, source?}, {k:op, op, a},
// {k:fn, op, a}, {k:map, min, max, curve, a}. Walk order is pre-order, a map's min and max first.

exprKey = { |slot, name| ("slot" ++ slot ++ "_" ++ name).asSymbol };
exprsOf = { |track| track[\exprs] ?? { var d = IdentityDictionary.new; track[\exprs] = d; d } };
exprFeedsOf = { |track| track[\exprFeeds] ?? { var d = Dictionary.new; track[\exprFeeds] = d; d } };

// What drives input i of the expression on (slot, name): a control bus and an audio bus, -1 for
// none - recorded whether or not the expression exists yet, since the leaf's modulator may land
// first, and handed to the synth when it is there. An input reads the sum of the two (only one is
// ever set), so a leaf can change from a polled value to an envelope without a rebuild.
exprFeed = { |track, slot, name, i, rate, bus|
    var feeds = exprFeedsOf.(track);
    var fk = slot.asString ++ "|" ++ name ++ "|" ++ i;
    var f = feeds[fk] ?? { (kr: -1, ar: -1) };
    f[rate] = bus;
    feeds[fk] = f;
    exprsOf.(track)[exprKey.(slot, name)] !? { |e|
        var now = if (f[\ar] >= 0) { \ar } { \kr };
        // Only an audio driver onto an input read at control rate needs the rebuild: one read at
        // audio rate reads a control driver as well, through its own input.
        if ((now == \ar) and: { (e[\rates] ? [])[i] != \ar }) {
            // The input is driven at the other rate now: the expression is rebuilt to read it.
            tracks.findKeyForValue(track) !? { |key|
                exprRun.(key, slot, name, {
                    exprsOf.(track)[exprKey.(slot, name)] !? { |cur| installExpr.(key, track, slot, name, cur[\json]) };
                });
            };
        } {
            e[\synth] !? { |s| s.set(("k" ++ i).asSymbol, f[\kr], ("a" ++ i).asSymbol, f[\ar]) };
        };
    };
};
exprFeedArgs = { |track, slot, name, inputs|
    var feeds = exprFeedsOf.(track);
    inputs.collect { |in|
        var f = feeds[slot.asString ++ "|" ++ name ++ "|" ++ in[\i]] ?? { (kr: -1, ar: -1) };
        [("k" ++ in[\i]).asSymbol, f[\kr], ("a" ++ in[\i]).asSymbol, f[\ar]];
    }.flatten;
};

// The tree's shape (what decides the SynthDef), its constants in walk order, and its inputs.
exprShape = { |node|
    var k = node["k"].asString;
    switch(k,
        "const", { "c" },
        "in", { "i" ++ node["i"].asInteger },
        "map", { "map:" ++ node["curve"].asString ++ "(" ++ exprShape.(node["a"][0]) ++ ")" },
        { node["op"].asString ++ "(" ++ node["a"].collect { |a| exprShape.(a) }.join(",") ++ ")" }
    );
};
exprConsts = { |node, into|
    var k = node["k"].asString;
    into = into ?? { List.new };
    switch(k,
        "const", { into.add(node["v"].asFloat) },
        "in", { },
        "map", { into.add(node["min"].asFloat); into.add(node["max"].asFloat); exprConsts.(node["a"][0], into) },
        { node["a"].do { |a| exprConsts.(a, into) } }
    );
    into;
};
exprInputs = { |node, into|
    var k = node["k"].asString;
    into = into ?? { List.new };
    switch(k,
        "const", { },
        "in", {
            var i = node["i"].asInteger;
            if (into.detect { |e| e[\i] == i }.isNil) {
                into.add((i: i, source: node["source"] !? { |s| s.asString }, rate: node["rate"] !? { |r| r.asSymbol }));
            };
        },
        { node["a"].do { |a| exprInputs.(a, into) } }
    );
    into;
};

// The SynthDef for a tree. outKind: \device (audio bus, both sides of a pair - what a device reads
// per sample), \plugin (control bus, clipped to 0..1 like any plugin set), \channel (control bus,
// unclipped - the track synth bounds its own controls).
// `rates` is what drives each input, \ar or \kr, and an expression is computed at the rate its
// inputs need: at control rate when none of them is audio, which is most of them.
// `rates` is the rate each input is read at, by index; left out, it is what the tree says.
exprSynthDef = { |defName, tree, outKind, rates|
    rates = rates ?? {
        var said = [], look;
        look = { |node|
            if (node["k"].asString == "in") {
                var i = node["i"].asInteger;
                if (i >= 0) {
                    while { said.size <= i } { said = said.add(\kr) };
                    if (node["rate"].asString == "ar") { said[i] = \ar };
                };
            };
            (node["a"] ? []).do(look);
        };
        look.(tree);
        said;
    };
    SynthDef(defName, { |out|
        var c = 0, walk, v;
        var audio = rates.includes(\ar);
        walk = { |node|
            var k = node["k"].asString;
            switch(k,
                "const", { var ctl = ("c" ++ c).asSymbol.kr(0); c = c + 1; ctl },
                "in", {
                    var i = node["i"].asInteger;
                    // -1 is "nothing drives it yet": the input reads 0. An input driven at audio
                    // rate reads both of its buses (only one is ever set); one driven at control
                    // rate reads just that, and an audio driver arriving on it rebuilds the
                    // expression (see exprFeed).
                    if ((rates ? [])[i] == \ar) {
                        var kb = ("k" ++ i).asSymbol.kr(-1), ab = ("a" ++ i).asSymbol.kr(-1);
                        K2A.ar(Select.kr(kb >= 0, [0, In.kr(kb.max(0))]))
                            + Select.ar(ab >= 0, [DC.ar(0), In.ar(ab.max(0), 2).sum * 0.5]);
                    } {
                        var kb = ("k" ++ i).asSymbol.kr(-1);
                        var kv = Select.kr(kb >= 0, [0, In.kr(kb.max(0))]);
                        if (audio) { K2A.ar(kv) } { kv };
                    };
                },
                "map", {
                    var lo = ("c" ++ c).asSymbol.kr(0), hi = ("c" ++ (c + 1)).asSymbol.kr(1), x;
                    c = c + 2;
                    x = walk.(node["a"][0]);
                    if (node["curve"].asString == "log") {
                        ((x.max(1e-30) / lo.max(1e-30)).log / (hi.max(1e-30) / lo.max(1e-30)).log).clip(0, 1);
                    } {
                        ((x - lo) / (hi - lo)).clip(0, 1);
                    };
                },
                "fn", {
                    var x = walk.(node["a"][0]);
                    switch(node["op"].asString,
                        "abs", { x.abs }, "neg", { x.neg }, "round", { x.round(1) },
                        "floor", { x.floor }, "ceil", { x.ceil },
                        { ("poptart: setParamExpr: unknown function '" ++ node["op"] ++ "' - read as its input").warn; x }
                    );
                },
                {
                    var a = walk.(node["a"][0]), b = walk.(node["a"][1]);
                    // Division and modulo by zero give 0, as pattern-core's do.
                    var nz = b.abs > 0, safe = b + (b.abs <= 0);
                    switch(node["op"].asString,
                        "add", { a + b }, "sub", { a - b }, "mul", { a * b },
                        "div", { nz * (a / safe) },
                        "mod", { nz * (((a % safe) + safe) % safe) },
                        "min", { a.min(b) }, "max", { a.max(b) }, "pow", { a.pow(b) },
                        "gt", { a > b }, "gte", { a >= b }, "lt", { a < b }, "lte", { a <= b },
                        "eq", { BinaryOpUGen('==', a, b) }, "neq", { BinaryOpUGen('!=', a, b) },
                        { ("poptart: setParamExpr: unknown operation '" ++ node["op"] ++ "' - read as 0").warn; if (audio) { DC.ar(0) } { DC.kr(0) } }
                    );
                }
            );
        };
        v = walk.(tree);
        // A tree of constants alone is a number, not a signal.
        if (v.isNumber) { v = DC.perform(if (audio) { \ar } { \kr }, v) };
        if (audio) {
            switch(outKind,
                \device, { Out.ar(out, [v, v]) },
                \plugin, { Out.kr(out, A2K.kr(v).clip(0, 1)) },
                { Out.kr(out, A2K.kr(v)) }
            );
        } {
            switch(outKind,
                \device, { Out.ar(out, K2A.ar(v) ! 2) },
                \plugin, { Out.kr(out, v.clip(0, 1)) },
                { Out.kr(out, v) }
            );
        };
    });
};

// Installs (or updates) an expression. Runs in a fork - it may wait for the track, the slot's
// plugin, and a SynthDef - and is also what a re-opened plugin calls to get its expression back.
installExpr = { |key, track, slot, name, json|
    var tree = json.parseJSON;
    var target = if (slot == -1) { paramTarget.(track, slot, name) } { awaitTarget.(track, slot, name, "setParamExpr") };
    target !? {
        var exprs = exprsOf.(track);
        var k = exprKey.(slot, name);
        var outKind = case { target[\kind] == \channel } { \channel } { target[\audio] } { \device } { \plugin };
        var feeds = exprFeedsOf.(track);
        // What drives each input, which decides the rate it is read at: audio where the tree says so
        // or where an audio driver is already on it.
        var declared = exprInputs.(tree).asArray;
        var rates = Array.fill((declared.collect { |in| in[\i] }.maxItem ? -1) + 1, { |i|
            var f = feeds[slot.asString ++ "|" ++ name ++ "|" ++ i];
            var said = declared.detect { |in| in[\i] == i } !? { |in| in[\rate] };
            if ((said == \ar) or: { f.notNil and: { f[\ar] >= 0 } }) { \ar } { \kr };
        });
        var shape = exprShape.(tree) ++ "|" ++ outKind ++ "|" ++ rates.join(",");
        var consts = exprConsts.(tree).asArray;
        var inputs = exprInputs.(tree).asArray;
        var constArgs = consts.collect { |v, j| [("c" ++ j).asSymbol, v] }.flatten;
        var existing = exprs[k];
        var defName, out, synth, entry, resting;
        if (existing.notNil and: { existing[\shape] == shape }) {
            // Only numbers (or nothing) changed: in place, no rebuild.
            existing[\synth].set(*constArgs);
            existing[\json] = json;
            entry = existing;
        } {
            defName = exprDefs[shape] ?? {
                var made = ("poptart_expr_" ++ (exprDefSerial = exprDefSerial + 1)).asSymbol;
                exprSynthDef.(made, tree, outKind, rates).add;
                exprDefs[shape] = made;
                server.sync; // the def has to be on the server before the synth is made of it
                made;
            };
            // The track may have gone (or the expression been cleared) while the def was built.
            if (tracks[key] === track) {
                out = if (outKind == \device) { Bus.audio(server, 2) } { Bus.control(server, 1) };
                // Before the chain: after every modulator feeding it (they go at the head of the
                // group) and before the device that reads it.
                synth = Synth(defName, [\out, out] ++ constArgs ++ exprFeedArgs.(track, slot, name, inputs),
                    target: track[\chain], addAction: \addBefore);
                nodeOwns.(synth.nodeID, "the expression on '" ++ name ++ "'");
                // The control it drives was polled until now: that ramp goes.
                dropRamp.(key, track, k);
                // A plugin parameter goes back where it was when the expression comes off. Asked
                // BEFORE the map below, so the server answers with the value it had until now.
                if (outKind == \plugin and: { existing.isNil }) {
                    resting = ();
                    track[\controllers][slot].get(target[\index], { |v| resting[\value] = v });
                } {
                    resting = existing !? { existing[\resting] };
                };
                if (outKind == \device) { target[\mapAudio].(out, 1, 0) } { target[\map].(out) };
                if (existing.notNil) {
                    freeModulatorLater.(key, track[\group], existing[\synth], existing[\out]);
                    exprDefDone.(existing[\def]);
                };
                exprDefUse[defName] = (exprDefUse[defName] ? 0) + 1;
                entry = (synth: synth, out: out, shape: shape, outKind: outKind, json: json, slot: slot, name: name,
                    def: defName, rates: rates,
                    index: target[\index], sources: existing !? { existing[\sources] } ?? { IdentityDictionary.new },
                    resting: resting);
                exprs[k] = entry;
            };
        };
        entry !? {
            var wanted = IdentityDictionary.new;
            // Even an unchanged entry re-maps: a re-opened plugin has lost its mappings.
            if (entry === existing) {
                if (outKind == \device) { target[\mapAudio].(entry[\out], 1, 0) } { target[\map].(entry[\out]) };
            };
            // Source inputs are audio routes onto the leaf; one whose source changed is re-wired.
            inputs.do { |in| in[\source] !? { |src| wanted[in[\i]] = src } };
            entry[\sources].keys.copy.do { |i|
                if (wanted[i] != entry[\sources][i]) {
                    unwireParamRoute.(key, slot, "~" ++ i ++ "~" ++ name);
                    entry[\sources].removeAt(i);
                };
            };
            wanted.keysValuesDo { |i, src|
                if (entry[\sources][i].isNil) {
                    entry[\sources][i] = src;
                    wireParamRoute.(key, slot, "~" ++ i ++ "~" ++ name, src, 1, 0);
                };
            };
        };
    };
};

clearExpr = { |key, track, slot, name|
    var exprs = exprsOf.(track);
    var k = exprKey.(slot, name);
    var e = exprs.removeAt(k);
    e !? {
        var target = paramTarget.(track, slot, name, if (slot >= 0) { e[\index] });
        e[\sources].keys.do { |i| unwireParamRoute.(key, slot, "~" ++ i ++ "~" ++ name) };
        target !? {
            if (e[\outKind] == \device) { target[\unmapAudio] !? { |off| off.() } } {
                target[\unmap].();
                (e[\resting] ? ()).at(\value) !? { |v| track[\controllers][slot] !? { |ctl| ctl.set(e[\index], v) } };
            };
        };
        exprFeedsOf.(track).keys.select { |fk| fk.beginsWith(slot.asString ++ "|" ++ name ++ "|") }
            .do { |fk| exprFeedsOf.(track).removeAt(fk) };
        freeModulatorLater.(key, track[\group], e[\synth], e[\out]);
        exprDefDone.(e[\def]);
    };
};

// One expression less on a def; with none left, the def is freed on the server (after the synth
// that used it has had time to go - see freeModulatorLater) and forgotten here, so a long set
// that tries a hundred expressions does not keep a hundred defs.
exprDefDone = { |defName|
    defName !? {
        var n = (exprDefUse[defName] ? 1) - 1;
        if (n > 0) { exprDefUse[defName] = n } {
            exprDefUse.removeAt(defName);
            exprDefs.keys.copy.do { |shape| if (exprDefs[shape] == defName) { exprDefs.removeAt(shape) } };
            freeDefsLater.([defName]);
        };
    };
};

// Defs made for one use (an expression's, a drawn LFO's), freed on the server once nothing runs them.
freeDefsLater = { |names|
    SystemClock.sched(2, { names.do { |n| server.sendMsg(\d_free, n) }; nil });
};

// A plugin or device opened into a slot starts with its mappings cleared and its controls at
// their defaults: each expression aimed at the slot goes back on (rebuilt if the slot changed
// between a plugin and a device, which changes how it is read).
reassertExprs = { |key, track, slot|
    exprsOf.(track).values.select { |e| e[\slot] == slot }.do { |e|
        exprRun.(key, slot, e[\name], {
            // Still the same expression: it may have been cleared or replaced while queued.
            exprsOf.(track)[exprKey.(slot, e[\name])] !? { |now| installExpr.(key, track, slot, e[\name], now[\json]) };
        });
    };
};

// Installs and clears for one control run one at a time, in arrival order: an install can wait
// on a SynthDef build, and a constants-only update or a clear sent meanwhile has to land after it,
// not race it. Each job runs in a Routine; a failure is said and does not stall the ones behind.
exprRun = { |key, slot, name, job|
    var qk = (key ++ "|" ++ slot ++ "|" ++ name).asSymbol;
    var go = {
        fork {
            job.try { |err| ("poptart: param expression on '" ++ name ++ "': " ++ err.errorString).warn };
            exprQueue[qk] = exprQueue[qk].drop(1);
            if (exprQueue[qk].isEmpty) { exprQueue.removeAt(qk) } { exprQueue[qk].first.() };
        };
    };
    exprQueue[qk] = (exprQueue[qk] ?? { [] }).add(go);
    if (exprQueue[qk].size == 1) { go.() };
};

// How deep each track sits (key -> depth): 0 for one that reads no other track, else one past the
// deepest thing routed into it - a source track, or the writers of a bus it reads. A feedback loop
// (a: audio("b"), b: audio("a")) has no order that works; the edge that closes it is dropped and
// that read is a block late, which is the most any order could give it. A track still being built
// (\pending) has no group to place and no routes yet; it is skipped and placed by its own routes.
trackLevels = {
    var writers = IdentityDictionary.new; // bus name -> the keys sending to it
    var upstream = IdentityDictionary.new; // key -> the keys it must run after
    var levels = IdentityDictionary.new;
    var levelOf;
    tracks.keysValuesDo { |k, t|
        if (t.isKindOf(Event)) {
            t[\busSends] !? { |names| names.do { |n| var b = n.asSymbol; writers[b] = (writers[b] ?? { [] }).add(k) } };
            // The DJ FX unit's send counts as a write too (see setFxSend): the unit's return
            // track READS that bus, so without this the return sits at the same depth as the
            // decks feeding it and reads the previous block - a block of delay on the insert,
            // and an order that depends on which track happened to be built first.
            t[\fxBus] !? { |n| var b = n.asSymbol; writers[b] = (writers[b] ?? { [] }).add(k) };
        };
    };
    // A sidechain and a parameter patch order the same way: whatever they read runs first.
    [sidechainByTarget, paramRoutes].do { |routes|
        routes.do { |e|
            var deps = case
                { e[\source].notNil } { [e[\source]] }
                { e[\busName].notNil } { writers[e[\busName].asSymbol] ?? { [] } }
                { [] };
            upstream[e[\targetKey]] = (upstream[e[\targetKey]] ?? { [] }).addAll(deps);
        };
    };
    // A loop - two tracks reading each other, or a track reading a bus it writes - has no order
    // that runs every reader after its writer, so one edge of it reads the block before: the one
    // that closes the loop, walking upstream from each track in the order the tracks were made
    // (the browser engine walks them the same way, so both pick the same edge). Every other edge
    // is in the same block. The closing edges are recorded as "reader|writer" in loopEdges.
    loopEdges = Set.new;
    levelOf = { |k, stack|
        levels[k] ?? {
            var deps = (upstream[k] ?? { [] }).select { |d| tracks[d].isKindOf(Event) };
            var open = deps.reject { |d|
                var closes = (d == k) or: { stack.includes(d) };
                if (closes) { loopEdges.add(k.asString ++ "|" ++ d.asString) };
                closes
            };
            var lvl = if (open.isEmpty) { 0 } { open.collect { |d| levelOf.(d, stack ++ [k]) }.maxItem + 1 };
            levels[k] = lvl;
            lvl;
        };
    };
    tracks.keys.asArray.select { |k| tracks[k].isKindOf(Event) }
        .sort { |a, b| (tracks[a][\born] ? 0) <= (tracks[b][\born] ? 0) }
        .do { |k| levelOf.(k, []) };
    levels;
};

// Whether a route into `targetKey` closes a loop (see trackLevels): its source track, or any of
// the tracks writing the bus it reads, is one of the target's closing edges.
routeCloses = { |targetKey, e|
    var deps = case
        { e[\source].notNil } { [e[\source]] }
        { e[\busName].notNil } { busWriters.(e[\busName].asSymbol) }
        { [] };
    deps.any { |d| loopEdges.includes(targetKey.asString ++ "|" ++ d.asString) };
};

// The tracks writing a named bus, by their sends and the DJ FX unit's.
busWriters = { |name|
    var out = List.new;
    tracks.keysValuesDo { |k, t|
        if (t.isKindOf(Event) and: {
            ((t[\busSends] ? []).any { |n| n.asSymbol == name }) or: { t[\fxBus] !? { |n| n.asSymbol == name } ? false }
        }) { out.add(k) };
    };
    out.asArray;
};

// Put every track's group in the Group for its depth - one per depth, made as needed, each before
// recGroup (whose taps must still read what the tracks wrote this block). Within a depth the order
// is free: nothing at one depth reads anything else at it.
reorderTracks = {
    var levels = trackLevels.();
    var deepest = levels.values.maxItem ?? 0;
    while { levelGroups.size <= deepest } { levelGroups = levelGroups.add(Group.before(recGroup)) };
    levels.keysValuesDo { |k, lvl| tracks[k][\group].moveToHead(levelGroups[lvl]) };
    // The edge that closes a loop reads the block before (InFeedback); every other one, this block.
    sidechainByTarget.do { |e|
        e[\feeder] !? { |f| f.set(\fb, if (routeCloses.(e[\targetKey], e)) { 1 } { 0 }) };
    };
    paramRoutes.do { |e|
        if (e[\pending].isNil and: { e[\bus].notNil }) {
            var closes = routeCloses.(e[\targetKey], e);
            var target = tracks[e[\targetKey]];
            case
            { closes and: { e[\fbBus].isNil } and: { target.isKindOf(Event) } } {
                // A device reads its patch in the block itself, so a closing edge into one goes
                // through a copy of the block before.
                e[\fbBus] = Bus.audio(server, 2);
                e[\fbFeeder] = Synth(\poptart_busread, [\out, e[\fbBus].index, \in, busIndexOf.(e[\bus]), \fb, 1],
                    target: target[\group], addAction: \addToHead);
                applyParamRoute.(target, e);
            }
            { closes.not and: { e[\fbBus].notNil } } {
                e[\fbFeeder].free; e[\fbBus].free;
                e[\fbFeeder] = nil; e[\fbBus] = nil;
                target !? { if (target.isKindOf(Event)) { applyParamRoute.(target, e) } };
            };
        };
    };
};

// Both helpers must be called from within a Routine (all handlers that use them fork first).
// createTrack reserves the key with \pending before its async setup, so these distinguish
// "being built, wait" from "never created".
awaitTrack = { |key, timeoutSec = 5|
    var tries = 0, max = (timeoutSec / 0.05).asInteger, t = tracks[key];
    while { t.isKindOf(Event).not and: { tries < max } } {
        0.05.wait; tries = tries + 1; t = tracks[key];
    };
    // Waited the whole build out and the key is STILL reserved: that build is not coming back,
    // and without this the reservation would outlive the session (see reclaimStuckTrack).
    if (t.isKindOf(Event)) { t } { reclaimStuckTrack.(key); nil };
};
// Gives up on a build that never committed, so the key can be built again.
//
// createTrack reserves a key with \pending and only writes the real track at the very end of an
// async build. A build that never gets there - it threw, or its routine was dropped when the
// scheduler queue overflowed and a `.wait` or a /sync reply never came back - used to leave
// \pending in place for the rest of the session: createTrack guards on isNil and so no-oped on
// every evaluation after, destroyTrack's whole body sits inside a `track !? {}` and so skipped
// it too, and meanwhile every note, param and route aimed at that key was dropped without a
// sound (a track that is silent forever, which is how this was found). Clearing the reservation
// is enough to recover: Node re-sends createTrack for every active track on every evaluation.
//
// Bumping the generation is what makes this safe against a build that is merely slow rather than
// lost - it cannot tell the two apart, and must not have to. A reclaimed build finds its
// generation stale when it finally wakes and frees what it made instead of committing over the
// rebuild; its group and buses are leaked until then, which is the price of a track that comes
// back at all.
reclaimStuckTrack = { |key|
    if (tracks[key] == \pending) {
        trackGen[key] = (trackGen[key] ? 0) + 1;
        tracks[key] = nil;
        ("poptart: track " ++ key ++ " never finished being built - cleared it, and the next "
            ++ "evaluation will build it again").warn;
    };
};
// Waits for the plugin in a slot to be open, for as long as an open is actually in flight for it
// (`wanted` is set by loadInstrument/loadEffect before the open is queued and cleared when the
// open fails or the slot is unloaded). `graceSec` is for message ordering only: the load message
// that marks the slot is handled before the one that waits on it, but both fork and wait for the
// track first, so the mark can land a beat after the wait begins. Past the grace, an unmarked
// slot is an empty one and this returns at once; a marked one is waited for up to openWaitMax
// (see there - a stuck-open guard, not a budget). Returns whether the plugin is open.
awaitLoaded = { |track, slot, graceSec = 1|
    var tries = 0, grace = (graceSec / 0.05).asInteger, max = (openWaitMax / 0.05).asInteger;
    while {
        track[\loaded][slot].isNil
        and: { tries < max }
        and: { track[\wanted][slot].notNil or: { tries < grace } }
    } { 0.05.wait; tries = tries + 1 };
    track[\loaded][slot].notNil;
};

slotKey = { |key, slot| (key ++ "_" ++ slot).asSymbol };

// Whether a slot has a plugin to send MIDI to: one that is OPEN. Not one whose open is still in
// flight - the UGen has no plugin until the open lands, and answers every unit command sent to
// it meanwhile with "VSTPlugin: no plugin loaded!": a line per note, per slot, for as long as the
// opens take, which for a full song coming up is a hundred lines saying nothing (and `wanted`
// is never cleared by a successful open, so it added nothing once the plugin was in). Same for
// a slot whose open FAILED (a plugin this machine does not have): it keeps its controller but
// has no plugin, the failed load has already said what is wrong, once, and the notes are
// dropped quietly. Asked at send time, not at arrival: a note queued behind a load (see
// waitForLoad) is judged by how the load turned out.
// ...and not on a synth the server has told us it does not have (see deadNodes). A plugin lives
// INSIDE the track synth, so a write to it is a /u_cmd at that synth's node - and when the node is
// gone, every event still in flight for it fails on arrival, one printed line each. The first
// failure is the only one worth having: from there this drops the rest instead of sending them.
slotLive = { |track, slot|
    track[\loaded][slot].notNil and: { slotNode.(track, slot) !? { |n| deadNodes.includes(n.nodeID).not } ? false };
};

// A note due at or after the start of a program load WAITS for that load instead of being bundled
// through it. Loading suspends the plugin and resets its voices, so a note timestamped inside that
// window is either swallowed or wiped by the reset a moment later: the note written at a
// `.preset("<a b>")` boundary - the first of the cycle, usually - simply never sounds.
//
// The decision has to happen HERE, when the note MESSAGE arrives, not at its onset: a note goes to
// scsynth as a timestamped bundle up to a lookahead early, and once it is there nothing in the
// language can hold it back. Which is also why the scheduler now sends the swap for an onset before
// the notes at it (see Scheduler#_tick) - so that by the time this is asked, the load is known to be
// coming. Comparing TIMES rather than just "is one pending" is what keeps the notes before the swap
// playing on time: only a note the load reaches waits for it.
waitForLoad = { |key, slot, at, fire|
    var seqKey = slotKey.(key, slot);
    var pending = statePending[seqKey];
    // A warm swap only claims notes near its onset; a cold load claims everything until it
    // clears - notes keep arriving for as long as the open takes, and every one of them would
    // otherwise sound the init preset.
    var window = if (pending.notNil and: { pending[\cold] == true }) { inf } { stateWaitMax };
    if (pending.notNil and: { pending[\at] <= at } and: { at <= (pending[\at] + window) }) {
        noteQueues[seqKey] = (noteQueues[seqKey] ? []).add((at: at, fire: fire));
        true
    } { false };
};

// Everything waiting on one slot, in arrival order - a note-off must never overtake the note-on it
// belongs to. Each keeps its ORIGINAL onset: a load that finished before it (the swap is applied a
// little ahead of its onset for exactly this reason) leaves the note playing dead on time, and only
// one that ran past the onset makes it late. The 2ms floor keeps the bundle just ahead of scsynth
// rather than arriving stamped for a moment that has already gone.
// `dropBefore` (a time, or nil) is the cold-load release: entries whose onset is older are
// history - a note that missed its moment during a plugin load must not play late in a burst -
// while future-stamped ones (the scheduler runs a lookahead ahead) still land dead on time. An
// on whose off survives it leaves an orphan note-off, which a plugin ignores.
flushNotes = { |seqKey, dropBefore = nil|
    var waiting = noteQueues[seqKey];
    noteQueues[seqKey] = nil;
    waiting !? {
        var now = Main.elapsedTime;
        waiting.do { |e|
            if (dropBefore.isNil or: { e[\at] >= dropBefore }) {
                e[\fire].value((e[\at] - now).max(0.002));
            };
        };
    };
};

// Ends the wait for one load - finished, failed, superseded or cancelled, the notes must go either
// way. Only for the load it names: a newer one may have taken the slot over in the meantime, and
// its notes are still waiting for IT. A cold load's release drops the already-due notes rather
// than bursting them (see flushNotes); a warm swap's flushes them all, slightly late at worst.
clearPending = { |seqKey, seq|
    var pending = statePending[seqKey];
    if (pending.notNil and: { pending[\seq] == seq }) {
        statePending[seqKey] = nil;
        seqKey.asString.findBackwards("_") !? { |at|
            nodeAddr.sendMsg("/poptart/ids/loadDone", seqKey.asString.copyRange(0, at - 1),
                seqKey.asString.copyToEnd(at + 1).asInteger, seq);
        };
        flushNotes.(seqKey, if (pending[\cold] == true) { Main.elapsedTime - 0.02 } { nil });
    };
};

// The three ends of the self-load window (see selfLoads). `running` is what lets the tail be the
// real end of it: the deadline taken at the start is only the failsafe for a load that never
// reports, and a second load arriving on the slot before the first one lands must not have the
// first one's completion open the slot's ears mid-program.
beginSelfLoad = { |seqKey|
    var e = selfLoads[seqKey] ?? { (running: 0, until: 0) };
    e[\running] = e[\running] + 1;
    e[\until] = max(e[\until], Main.elapsedTime + coldWaitMax);
    selfLoads[seqKey] = e;
};

endSelfLoad = { |seqKey|
    selfLoads[seqKey] !? { |e|
        e[\running] = (e[\running] - 1).max(0);
        if (e[\running] == 0) { e[\until] = Main.elapsedTime + selfLoadTail };
    };
};

// Whether what this slot's plugin is reporting is a program we handed it.
selfLoading = { |key, slot|
    ((selfLoads[slotKey.(key, slot)] !? { |e| e[\until] }) ? 0) > Main.elapsedTime;
};

// `.synth("Serum 2")` uses the display name, but VSTPlugin's dict keys carry the file extension
// ('Serum 2.vst3') - accept exact key, display name, or a literal file path.
resolvePlugin = { |pluginId|
    var dict = VSTPlugin.plugins(server);
    var hit = dict[pluginId.asSymbol];
    // An exact key wins - EXCEPT when that key IS a bare display name. VSTPlugin keys a VST2 by
    // its plain name and a VST3 by "Name.vst3", so for a plugin installed in both formats the
    // VST2 owns the bare name: `.fx("Kickstart 2")` hit it here and the prefer-VST3 rule below
    // never ran. That silently loaded the VST2, which folds its sidechain into extra channels on
    // a single input bus instead of exposing the second bus buildTrackDef feeds - so `.audio(...)`
    // wired a route the plugin had no input for, and the plugin sat there reporting no sidechain
    // audio while the engine logged a successful route. A key carrying an extension or a path is
    // unambiguous and still wins outright; a shadowed VST2 stays reachable by its full file path.
    var desc = if (hit.notNil and: { hit.name.asString != pluginId.asString }) { hit } {
        // Display-name lookup. A name can exist as both VST2 and VST3 ("Mangle" + "Mangle.vst3");
        // prefer the VST3 so resolution is deterministic instead of dict-order luck, matching the
        // browser/autocomplete (which hide shadowed VST2s when the prefer-VST3 setting is on).
        var matches = dict.values.select { |d| d.name == pluginId };
        matches.detect { |d| d.key.asString.endsWith(".vst3") } ?? { hit ?? { matches.first } };
    };
    desc !? { desc.key } ? pluginId;
};

// Resolve a parameter name to its index. A plain name matches the first parameter with that
// name (VSTPlugin's own lookup). A "Name#N" suffix - written by conf / the params panel to
// disentangle plugins that reuse a name across sections (e.g. Diva's three "Frequency") -
// addresses parameter index N directly. A real name is tried first, so a parameter whose actual
// name contains '#' still resolves. Returns nil if nothing matches.
resolveParamIndex = { |info, name|
    var idx = if (info.notNil) { info.findParamIndex(name.asSymbol) };
    if (idx.isNil and: { info.notNil }) {
        var rev = name.reverse.indexOf($#);
        if (rev.notNil) {
            var suffix = name.copyRange(name.size - rev, name.size - 1); // chars after '#'
            if ((suffix.size > 0) and: { suffix.every({ |c| c.isDecDigit }) }) {
                var n = suffix.asInteger;
                if ((n >= 0) and: { n < info.parameters.size }) { idx = n };
            };
        };
    };
    idx;
};

// --- live MIDI input (midicc()/midikeys() - see /poptart/setParamCC and /poptart/midiRoute) ---

// Lazy and idempotent: most sessions never touch MIDI, so CoreMIDI is only initialized when a
// pattern first asks (any MIDI-flavored command, or Node's explicit /poptart/midiInit). Once
// on, every incoming CC is also forwarded to Node as /poptart/midiIn - that live-value feed is
// what a cc signal demoted to Tier-1 (arithmetic, .hold(), signal bounds) samples JS-side.
midiEnable = {
    if (midiInitialized.not) {
        midiInitialized = true;
        MIDIClient.init;
        MIDIIn.connectAll;
        midiConnected = IdentitySet.newFrom(MIDIClient.sources.collect { |s| s.uid });
        MIDIdef.cc(\poptart_cc_forward, { |val, num, chan, src|
            nodeAddr.sendMsg("/poptart/midiIn", midiNameForUid.(src), chan + 1, num, val / 127.0, "cc");
        });
        // NOTES are forwarded too, and the trailing word is which kind of message this is - a
        // cc 7 and a note 7 are different controls and must never bind to each other. Node uses
        // the note feed for the DJ desk's learned BUTTONS only (a cc signal samples cc): control
        // surfaces send their knobs and platters as cc and almost all of their buttons as notes,
        // so without this half a controller simply can't be learned, and a learn armed on a pad
        // instead binds whatever cc drifted past while the pad was silent (2026-09-09).
        //
        // Both edges go out, and a release is 0.0 whichever way it is spelled: hardware that
        // sends a note-on of velocity 0 for its release lands on 0.0 too, whichever of these two
        // handlers catches it. That is exactly what the desk's press/release edges read, so
        // there is no special case anywhere downstream.
        // Per-track midikeys() routes have their own srcID-filtered defs (see /poptart/midiRoute)
        // and are untouched by these: MIDIdefs are keyed, and many can watch the same message.
        MIDIdef.noteOn(\poptart_note_forward, { |veloc, num, chan, src|
            nodeAddr.sendMsg("/poptart/midiIn", midiNameForUid.(src), chan + 1, num, veloc / 127.0, "note");
        });
        MIDIdef.noteOff(\poptart_noteoff_forward, { |veloc, num, chan, src|
            nodeAddr.sendMsg("/poptart/midiIn", midiNameForUid.(src), chan + 1, num, 0.0, "note");
        });
        ("poptart: MIDI input enabled (" ++ MIDIClient.sources.size ++ " source(s))").postln;
    } {
        // Already on: this is a second ask, so re-read the sources. CoreMIDI's list here is a
        // SNAPSHOT - MIDIIn.connectAll above connected what was plugged in at the time and
        // nothing since - so a controller plugged in mid-session sent its messages to a client
        // that was not listening to it, and the desk's learn heard silence from it (reported
        // 2026-10-05, a controller plugged in after launch). Every ask for MIDI is now also a rescan;
        // connecting is per NEW source only, so asking twice cannot double anyone's events.
        midiRefreshSources.();
    };
};
// The source list is a snapshot taken when MIDI was enabled, so a controller switched on or
// plugged in after that is not in it - and a pattern naming it would go on saying "no such
// device" until a restart. Re-reading the list is cheap and safe while the client is up (it is
// what MIDIClient.init itself does); connecting is done per NEW source only, since connecting
// one twice could deliver its events twice. Called when a name fails to match, so the lookup
// that follows sees whatever is plugged in now.
midiRefreshSources = {
    MIDIClient.list;
    MIDIClient.sources.do { |s|
        if (midiConnected.includes(s.uid).not) {
            MIDIIn.connect(0, s);
            midiConnected.add(s.uid);
            ("poptart: MIDI source connected: " ++ s.device ++ " " ++ s.name).postln;
        };
    };
};
midiNameForUid = { |uid|
    var s = MIDIClient.sources.detect { |e| e.uid == uid };
    if (s.isNil) { midiRefreshSources.(); s = MIDIClient.sources.detect { |e| e.uid == uid } };
    if (s.notNil) { s.device.asString ++ " " ++ s.name.asString } { "unknown" };
};
// Same matching rule as pattern-core's midi.mjs: case-insensitive substring of "device name",
// so both the native paths here and Node's Tier-1 store agree on which controller a name means.
midiSourceFor = { |pattern|
    var p = pattern.asString.toLower;
    var find = { MIDIClient.sources.detect { |s| (s.device.asString ++ " " ++ s.name.asString).toLower.contains(p) } };
    var src = find.value;
    if (src.isNil) { midiRefreshSources.(); src = find.value };
    src;
};
midiWarnMissing = { |context, device|
    if (midiWarned.includes(device.asSymbol).not) {
        midiWarned.add(device.asSymbol);
        ("poptart: " ++ context ++ ": no MIDI source matching '" ++ device ++ "' - connected: "
            ++ MIDIClient.sources.collect({ |s| s.device.asString ++ " " ++ s.name.asString }).join(", ")
            ++ ". Plug it in and re-evaluate.").warn;
    };
};

// --- live OSC input (osc() - see /poptart/setParamOSC) ---

// Lazy and idempotent like midiEnable: the input port opens when a pattern first asks (a
// setParamOSC, or Node's explicit /poptart/oscInit for Tier-1-only use). It is a SECOND port,
// apart from the command port Node talks to (-u), so a controller's message can never be read
// as an engine command, and the number is one to type into a controller's settings. Once open,
// every message that arrives on it is forwarded to Node as /poptart/oscIn [address, args...] -
// the live-value feed an osc() signal demoted to Tier-1 samples JS-side. Per-parameter native
// bindings are OSCdefs filtered to this port (see setParamOSC); like the MIDI forwarders, many
// can watch the same message. Non-numeric arguments (strings, blobs) are dropped on the way to
// Node: the store keeps values, and nothing reads a string.
oscEnable = {
    if (oscInitialized.not) {
        oscInitialized = true;
        if (thisProcess.openUDPPort(oscInPort)) {
            thisProcess.addOSCRecvFunc({ |msg, time, addr, recvPort|
                if (recvPort == oscInPort) {
                    nodeAddr.sendMsg("/poptart/oscIn", msg[0], *(msg[1..].select { |a| a.isNumber }));
                };
            });
            ("poptart: OSC input open on port " ++ oscInPort).postln;
            // Node announces the open port over Bonjour on this (see bonjour.js).
            nodeAddr.sendMsg("/poptart/oscOpen", oscInPort);
        } {
            ("poptart: could not open OSC input port " ++ oscInPort
                ++ " (in use? set POPTART_OSC_IN_PORT) - osc() signals will receive nothing").warn;
        };
    };
};

// --- boot ---

// Our server must be the default: SynthDef.add sends defs to Server.default's desc lib.
Server.default = server;
server.options.sampleRate = sampleRate;
server.options.blockSize = blockSize;
server.options.numInputBusChannels = inChannels;
if (outDevice.notNil and: { outDevice.isEmpty.not }) {
    // Pin input and output to the SAME device. Setting only outDevice leaves inDevice nil, and
    // on macOS SC then emits `-H "" "<out>"` (default input + chosen output). CoreAudio can't run
    // two independent-clock devices directly, so it silently builds an *aggregate* of the default
    // mic (often 44.1kHz) and the chosen output (e.g. BlackHole 64ch at 48kHz); when the rates
    // don't reconcile scsynth's DriverStart fails and the server exits code 0 right after printing
    // the device info - the "switched to BlackHole 64ch and SC died" crash. One device, no
    // aggregate. inChannels is that same device's input count, so this can't over-request inputs
    // (asking a single device for more inputs than it has is itself a boot failure).
    server.options.inDevice = outDevice;
    server.options.outDevice = outDevice;
};
// At least stereo; more when the selected device has it, so input-side channel numbering and the
// device's own outputs both line up. What .o(n) wraps at is playChannels, not this.
server.options.numOutputBusChannels = max(2, outChannels);
// Tests run with the output stream off: the same channels, nothing reaches the speakers.
if (("POPTART_SILENT".getenv == "1") or: { "NODE_TEST_CONTEXT".getenv.notNil }) { server.options.outputStreamsEnabled = "0" };
// One buffer per file in a sample pack, and packs stay loaded for the session - scsynth's default
// table of 1024 is exhausted by a single big drum library ("No more buffer numbers" on the first
// s("...")). The table itself is only a few hundred bytes per slot (the audio lives in separate
// allocations made at read time), so size it for a whole library rather than one pack.
server.options.numBuffers = 16384;
// Real-time memory, in kilobytes. scsynth's default is 8192 - EIGHT MEGABYTES - which is sized
// for a handful of SinOscs, and poptart is not that: every VSTPlugin instance takes a share, every
// per-event sampler voice allocates an OffsetOut buffer (see the voice defs), and the DJ stage adds
// filters and a three-band split per deck on top. Run out and scsynth stops being able to create
// ANYTHING: `/s_new out of real time memory`, notes silently stop playing, and - worse - the node
// ids those failed creations consumed are handed back to poptart, which then writes to nodes that
// never existed for the rest of the session (one such node took 8576 failed writes before anyone
// noticed; see the /fail listener). Found on a real set 2026-10-05, with `OffsetOut_Ctor: alloc
// failed` beside it. 256MB is not generous for a plugin host, it is the floor at which a long set
// does not fall over; it is virtual until touched, so an idle engine does not pay for it.
server.options.memSize = 262144;
// ...and the node table, whose default 1024 is the same kind of number. A track is several nodes
// before it plays a sound (its groups, its head and strip, a node per effect and per term of its
// chain, a ramp per polled control, a synth per modulator) and every sampler event is one more while it sounds. Precautionary rather
// than observed: the symptom would be `/s_new too many nodes`, which has not been seen - but it is
// the same silent class as the memory above, and the table costs a few hundred KB.
server.options.maxNodes = 32768;
// ...and the wire buffers, scsynth's -w, whose default 64 is the third number of this kind. A
// wire buffer is what one UGen hands its signal to the next through, and they are counted when a
// SynthDef is RECEIVED: ask for more than exist and scsynth throws `exception in GraphDef_Recv:
// exceeded number of interconnect buffers` and does NOT install the def. Nothing else says so -
// the def is simply missing afterwards, and the first real sign is a Synth of it failing to be
// created, which is the same silent class as the two numbers above. One of poptart's own library
// defs has been losing that race at EVERY boot (found 2026-10-05, one line above "server booted,
// ready" in engine.log), and the per-track defs grow with whatever chain the track is carrying,
// so this is sized for the big end of both rather than for the def that happens to fail today.
server.options.numWireBufs = 1024;
// ...and the private buses and the def table. Every connection in a track's chain is a private
// audio bus (see routeApply) and every route control a control bus, so the defaults - 1024 audio
// channels, 16384 control, 1024 defs - are the same silent class again: a full allocator is a
// chain that goes quiet. Generous, since an unused bus channel is a few hundred bytes of block
// memory; POPTART_AUDIO_BUSES overrides the audio count. The defs grow with the expressions and the
// drawn LFO shapes a set makes (each freed again when nothing uses it - see freeDefLater).
server.options.numAudioBusChannels = ("POPTART_AUDIO_BUSES".getenv ? "32768").asInteger;
server.options.numControlBusChannels = 65536;
server.options.maxSynthDefs = 8192;
// Private SuperCollider only. This becomes scsynth's -U, which REPLACES the default plugin
// search rather than adding to it, so the list has to carry the SC build's own plugins folder
// as well as poptart's Extensions - without the former there would be no SinOsc, let alone
// VSTPlugin.
if (ugenPlugins.notNil and: { ugenPlugins.isEmpty.not }) {
    server.options.ugenPluginsPath = ugenPlugins;
    "poptart: private UGen plugin path: %".format(ugenPlugins.join(", ")).postln;
};

// Second boot-progress checkpoint (see "engine script running" above) - also puts the exact
// boot config into the log, so a failure report carries it and the README's IDE-replay
// procedure can copy the values straight out.
// audible: what .o(n) wraps at, which is the whole device unless it's the aggregate (see playChannels).
// The allocations are in here too, and deliberately: an engine that has quietly come up on the
// stock 8MB of real-time memory is one that will stop making sound partway through a set (see
// memSize above), and this line is the only place that can be checked before it matters.
"poptart: booting scsynth (device: %, sr: %, block: %, out: %ch, audible: %ch, in: %ch, rt mem: %MB, max nodes: %, wire bufs: %, audio buses: %)".format(
    if (outDevice.notNil and: { outDevice.isEmpty.not }) { outDevice } { "system default" },
    sampleRate, blockSize, server.options.numOutputBusChannels,
    max(2, min(playChannels, server.options.numOutputBusChannels)), inChannels,
    (server.options.memSize / 1024).round, server.options.maxNodes, server.options.numWireBufs,
    server.options.numAudioBusChannels
).postln;

server.waitForBoot {
    // rand = uniform random, unsmoothed: a fresh independent value `freq` times a second, held in
    // between (phase ignored). It matches what pattern-core's rand() is - an independent draw per
    // read - as closely as a continuous control stream can; freq always arrives as 1 Hz, since
    // rand() has no rate to ask for pattern-side. The smoothed one is perlin, fractal
    // (fBm) value noise layered over a few octaves for organic drift. Like rand, the native and JS
    // samplings differ (both random, only the rate/range contract is shared - see signal.mjs).
    // saw rises 0->1 each period; isaw falls 1->0.
    //
    // Each shape at both rates: `poptart_lfo_<shape>` writes a control bus, for a plugin's or a
    // channel's control (read once a block whatever drives it); `poptart_lfo_<shape>_ar` writes
    // both sides of a stereo audio bus at the sample rate, for a control of one of poptart's own
    // devices, which reads it per sample (PoptartDevice's /mapa, as poptart_env_ar).
    [\sine, \tri, \saw, \isaw, \square, \rand, \perlin].do { |shape|
        [\kr, \ar].do { |at|
            SynthDef(lfoDefName.(shape, at == \ar), { |out, freq = 1, phase = 0, lo = 0, hi = 1, t_trig = 0|
                // Phase comes from one resettable Sweep, not each oscillator UGen's own internal
                // accumulator, so the scheduler can re-pin it to the shared transport clock with
                // set(\t_trig, 1, \phase, p) in a timestamped bundle ('/poptart/anchorParamLFO') -
                // otherwise the audio clock's ppm-level skew against the note grid accumulates into
                // audible drift. The unipolar waveforms match pattern-core sampleLfoIR's exactly
                // (same shapes, same phase origin), so JS and native samplings of a signal agree.
                var ph = (Sweep.perform(at, t_trig, freq) + phase).wrap(0, 1);
                var uni = switch(shape,
                    \sine, { (ph * 2pi).sin * 0.5 + 0.5 },
                    \tri, { 1 - ((ph * 2) - 1).abs },
                    \saw, { ph },
                    \isaw, { 1 - ph },
                    \square, { ph < 0.5 },
                    \rand, { LFDNoise0.perform(at, freq) * 0.5 + 0.5 }, // stepped, not interpolated; no phase - never anchored
                    \perlin, { // fBm: octaves of smoothed noise, each 2x rate and 1/2 amplitude
                        ((LFDNoise3.perform(at, freq) * 0.5)
                            + (LFDNoise3.perform(at, freq * 2) * 0.25)
                            + (LFDNoise3.perform(at, freq * 4) * 0.125)
                            + (LFDNoise3.perform(at, freq * 8) * 0.0625)) * (1 / 0.9375) * 0.5 + 0.5
                    }
                );
                var v = lo + (uni * (hi - lo));
                if (at == \ar) { Out.ar(out, [v, v]) } { Out.kr(out, v) };
            }).add;
        };
    };
    // A drawn lfo() shape, at both rates as above: the shape is a table in a Buffer (see
    // setParamShapeLFO), read at a phase from a resettable Sweep. `envelope` 1 plays one pass and
    // holds the end (the envelope mode); 0 loops (free and retrigger, which differ only in what
    // triggers t_trig). One def for every shape: a new shape is a new buffer, never a new def.
    [\kr, \ar].do { |at|
        SynthDef(if (at == \ar) { \poptart_shape_lfo_ar } { \poptart_shape_lfo },
            { |out, buf, rate = 1, phase = 0, lo = 0, hi = 1, t_trig = 0, envelope = 0, glideSec = 0, glideOn = 0|
            var born = Impulse.perform(at, 0);
            var run = Sweep.perform(at, t_trig, rate) + (phase * (1 - envelope));
            var idx = Select.perform(at, envelope, [run % 1, run.min(1)]);
            var frames = BufFrames.kr(buf);
            var shaped = lo + (BufRd.perform(at, 1, buf, idx * (frames - 1).max(0), 0, 2) * (hi - lo));
            // Swap glide. A shape change restarts the new shape from its beginning, which in
            // general is nowhere near where the outgoing one had got to - a step in a filter
            // cutoff, audible as a click. So the difference is measured once, at birth, and decays
            // away over glideSec: out = newShape(t) + (oldValue - newShape(0)) * decay(t). The
            // outgoing synth's last value is what the bus held: a control bus still holds it as
            // this one starts, and an audio bus's is the block before (InFeedback). glideOn is 0
            // for the first synth on a bus, which has no predecessor.
            var before = if (at == \ar) { InFeedback.ar(out, 1) } { In.kr(out) };
            var offset = (Latch.perform(at, before, born) - Latch.perform(at, shaped, born)) * glideOn;
            var v = shaped + (offset * EnvGen.perform(at, Env([1, 0], [max(glideSec, 0.001)], -4)));
            if (at == \ar) { Out.ar(out, [v, v]) } { Out.kr(out, v) };
        }).add;
    };
    // ADSR modulator, gated by the track's note on/offs (see the noteOn/noteOff OSCdefs) -
    // the parameter-modulation equivalent of a synth's filter envelope. Retriggers from the
    // envelope's current level on each new gate, so overlapping notes don't click. `curve`
    // shapes every segment (negative = scoop, 0 = linear, positive = bulge) and is a plain
    // control input into the Env, so a livecoding re-eval updates it in place.
    //
    // `retrig` (env({ retrigger: true })) restarts the attack on EVERY note rather than only on
    // the first of a run that overlaps: each note-on sends t_retrig, and while the gate is
    // already open that closes it for one block and opens it again - EnvGen then climbs from the
    // level it had reached. Only while it is already open, so the first note of a run is not held
    // back the block.
    SynthDef(\poptart_env, { |out, atk = 0.01, dec = 0.1, sus = 0.7, rel = 0.2, curve = -4, gate = 0, lo = 0, hi = 1, retrig = 0, t_retrig = 0|
        var again = t_retrig * retrig * (Delay1.kr(gate) > 0);
        var envSig = EnvGen.kr(Env.adsr(atk, dec, sus, rel, 1.0, curve), gate - again);
        Out.kr(out, lo + (envSig * (hi - lo)));
    }).add;
    // The same envelope at the sample rate, for a control on one of poptart's own devices: the
    // device reads an audio bus mapped onto a control every sample (PoptartDevice's /mapa), so a
    // two-millisecond attack is a two-millisecond ramp rather than one or two steps of a block.
    // A retrigger drops the gate for one SAMPLE. Written to both sides of a stereo bus, which is
    // the shape every audio patch onto a control has (the device sums the pair to mono).
    SynthDef(\poptart_env_ar, { |out, atk = 0.01, dec = 0.1, sus = 0.7, rel = 0.2, curve = -4, gate = 0, lo = 0, hi = 1, retrig = 0, t_retrig = 0|
        var again = Trig1.ar(t_retrig * retrig * (Delay1.kr(gate) > 0), SampleDur.ir);
        var envSig = EnvGen.ar(Env.adsr(atk, dec, sus, rel, 1.0, curve), gate - again);
        var v = lo + (envSig * (hi - lo));
        Out.ar(out, [v, v]);
    }).add;
    // The writer behind every POLLED control (see rampTo / poptartSetParam). Node re-sends a
    // polled value every poll interval, and this glides the bus linearly from one value to the
    // next over that interval, so a parameter driven from JS moves as a line rather than a
    // staircase - no zipper on a filter sweep, no step in a fade. Its bus is mapped onto the
    // parameter exactly as a native modulator's is: to the plugin the two are the same thing,
    // and a control can pass between them without the mapping ever being torn down.
    SynthDef(\poptart_ramp, { |out, target = 0, time = 0.03|
        Out.kr(out, Ramp.kr(target, time));
    }).add;
    // Sampler voices, one per (loop?, timestretch?, buffer channels) combination - the
    // combination is fixed per event, so picking a def beats building Select spaghetti with
    // conflicting doneActions. All write to the track's private input bus (see buildTrackDef).
    // begin/end are normalized 0..1 positions; rate is signed (negative = reversed); dur is the
    // precomputed natural length in seconds (Node does that math - it knows file duration, fit
    // and stretch). Plain defs repitch via BufRd index speed; warp defs (stretch != 1) keep
    // pitch and time independent via Warp1 granulation - at the same level as the plain ones,
    // which takes an explicit correction: Warp1 sums `overlaps` Hann-windowed copies, and Hann
    // overlap-added at hop = window/overlaps adds up to overlaps/2, so at 8 overlaps a warp def
    // ran 4x (+12 dB) hotter than the plain def beside it (fixed 2026-08-26 - patterns that had
    // a .gain() on a .stretch() to tame it will want it taken back off). `2 / overlaps` is that
    // factor exactly back off. These keep windowRandRatio at 0.1, unlike the keylock player
    // below: their grains are pitch-shifted (freqScale is the rate), so they do not line up the
    // way a transparent keylock's do, and a little scatter is what keeps a stretch from combing. atk/dec/rel are the amplitude ADSR times
    // in seconds, already scaled by .envscale() on the Node side; sus is a 0..1 level. All default to
    // 0/0/1/0, which floors down to the old tiny declick fade - the defs' own defaults, that is:
    // Node sends every event's envelope, and an unset release arrives as its 50ms default.
    [1, 2].do { |nc|
        var toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
        // Every voice below writes through OffsetOut, not Out. A synth spawned by a timestamped
        // bundle starts computing at the START of the block its time falls in, and Out would put
        // its first sample there - up to a block EARLY (256 samples at the engine's block size:
        // 5.3ms at 48k), by however far into the block the onset fell. A grid step is almost never
        // a whole number of blocks, so that phase walked a little further through the block each
        // event: hits crept earlier one by one, then jumped forward a block when it wrapped
        // (heard 2026-09-22 on a 16th-note hat line at 144 BPM). OffsetOut delays the whole
        // output by the bundle's sub-block offset, which lands the first sample on the scheduled
        // sample exactly (sample-onset-sclang.test.js). Plugin notes never had this: VSTPlugin
        // applies the same offset to its MIDI events itself.
        //
        // The delay holds each block's last `offset` samples back for the next one, and doneAction
        // frees the node the moment the envelope ends - but OffsetOut writes what it still holds
        // out as the node goes (its destructor does), so the release is not cut short by it.
        SynthDef(("poptart_sample_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, bend = 0|
            var frames = BufFrames.ir(buf);
            // Pitch bend (Sig#bend), in semitones, read live off the track's bend bus - every voice
            // on the track is mapped to it at spawn (see the playSample OSCdef). A repitching voice
            // bends the way a record does: the read speeds up, so a bend also shortens what of the
            // file gets played in the event's time. That is the honest behavior for this player and
            // not a shortcoming of it - the warp voices below, which already hold pitch and time
            // apart, bend pitch alone.
            var bendRatio = bend.midiratio;
            var startF = begin * frames, endF = max(begin * frames, (end * frames) - 1);
            var from = Select.kr(rate < 0, [startF, endF]);
            // PlayBuf, not BufRd walked by a Line - and the reason is precision, not convenience.
            // A phase handed to BufRd travels down an audio-rate wire, which is float32: above
            // 2^23 frames (~190s at 44.1k, and already lossy from ~47s) its resolution is a whole
            // frame, so the interpolation has nothing to interpolate and the read degrades into a
            // nearest-neighbour hold that repeats frames at irregular intervals - gritty aliasing
            // on the back half of any long file, and the whole of one played from a late .begin()
            // or .slice() (reported 2026-08-29 on a 4-minute acapella). PlayBuf keeps its phase in
            // a double INSIDE the UGen, so nothing is ever quantized to a bus. Its rate is frames
            // per output sample, so the span/dur the Line ran over becomes the step, sign and all -
            // the read is the same read, just measured accurately.
            //
            // The span is the window's length as Node measured it for `dur` - (end - begin) of the
            // whole frame count - and NOT endF - startF, which is a frame short (endF is the last
            // frame that can be read, not the window's far edge). A frame short made a file at
            // speed 1 step by (n-1)/n: no audible pitch, but every frame after the first was read
            // at a fractional position, through the interpolator, where a step of exactly 1 reads
            // the file's own samples (measured 2026-09-20: -55 dB of difference from the file).
            var step = ((((end - begin) * frames).max(1)) / max(dur, 1e-6) / SampleRate.ir) * Select.kr(rate < 0, [1, -1]) * bendRatio;
            // PlayBuf stops at the BUFFER's edge, not at `end`, so past the region it reads on
            // instead of holding the last frame. Only the release tail is ever out there (the env
            // below closes the gate at `dur`), and a few ms of the next slice under a fade beats a
            // few ms of held DC.
            var sig = PlayBuf.ar(nc, buf, step, 1, from, loop: 0);
            // atk/dec/rel are seconds, so an attack longer than the note never reaches 1 before it
            // ends. A gate held open for exactly dur runs attack->decay->sustain across playback,
            // then releases when the region ends; a cut event (gate->0 early) releases sooner. Tiny
            // floors keep the fade-in/out declicked.
            //
            // The envelope runs at AUDIO rate, and the attack floor is half a millisecond - and
            // nothing at all for a read that starts at the file's own edge. Both are about the
            // transient. A control-rate EnvGen holds its start level for its whole first block and
            // only then begins to ramp, block by block, so under the 3ms control-rate floor this
            // used to have a voice was SILENT for its first 64 samples and did not reach full
            // level for ~4ms (measured 2026-09-20: -inf to 1.35ms, -7.5 dB at 2ms) - which is the
            // click of a kick drum, removed. A declick fade only has a job where the read starts
            // mid-waveform (a .begin(), a .slice()); a file played from its first frame starts
            // wherever the file does, and has to come out as recorded.
            //
            // The release floor is 15ms rather than the attack's because Env.adsr's default
            // curve (-4) front-loads a fall: two thirds of the drop lands in the first quarter of
            // the segment, so an 8ms floor was ~2ms of real fade and thumped on bass-heavy material
            // cut short by a pianoroll note. Every sampler def below uses the same floors.
            var atEdge = ((from < 1) + (from > (frames - 2))).min(1);
            var atkS = max((1 - atEdge) * 0.0005, atk), decS = max(0, dec), relS = max(0.015, rel);
            var noteGate = gate * (Line.kr(0, 1, dur) < 1);
            var env = EnvGen.ar(Env.adsr(atkS, decS, sus, relS), noteGate, doneAction: 2);
            OffsetOut.ar(out, toStereo.(sig) * env * amp);
        }).add;
        // Looping voice. Node decides WHERE the loop runs (loopLo..loopHi - the whole file or just
        // the begin..end window, see .loop()'s wrap option) and where it enters (entry); this only
        // has to walk it. pingpong swaps the wrap-around for a bounce off each edge.
        //
        // The walk is split across two accumulators, for the same float32-wire precision reason as
        // the one-shot def above - but a loop cannot simply BE a PlayBuf, because PlayBuf only
        // wraps at the buffer's own edges and only runs one way. So:
        //  - the TRAJECTORY (where the playhead ought to be) is the old phasor pair, kept at frame
        //    accuracy on its float32 wires - good enough to time a corner and to name a position,
        //    useless to read audio through on a long file;
        //  - the AUDIO is a PlayBuf free-running at the walk's own step, integrating in a double
        //    inside the UGen, re-anchored onto the trajectory at every corner (a wrap or a bounce)
        //    by a trigger with the mirror's own position as startPos. Between corners it tracks
        //    the mirror exactly (same step), so the anchor's frame-rounding is a once-per-pass
        //    nudge, never per-sample jitter;
        //  - PlayBuf reads its trigger at each block's first sample, so after a mid-block corner
        //    it flies past the edge for the rest of that block. Those samples are patched with a
        //    BufRd of the mirror itself: on a short file that read is still exact (identical to
        //    what this def always was), on a long one it is frame-quantized for at most one block
        //    once per pass - a 1.3ms brush with the old bug in exchange for losing it everywhere
        //    else. A loop shorter than a block degenerates to the patch path, which IS the old
        //    graph.
        SynthDef(("poptart_sample_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, loopLo = 0, loopHi = 1, entry = 0, pingpong = 0, bend = 0|
            var frames = BufFrames.ir(buf);
            var startF = loopLo * frames, endF = max((loopLo * frames) + 1, (loopHi * frames) - 1);
            var span = endF - startF;
            var from = (entry * frames).clip(startF, endF);
            // Bend rides on the step, so the whole walk - the audio, the trajectory and the corners
            // it turns at - speeds up together and the loop stays one loop (see the one-shot above).
            var step = rate * BufRateScale.ir(buf) * bend.midiratio;
            // Phasor's resetPos is ONLY applied on a trigger - its initial value is `start`, so a
            // never-triggered phasor cannot be made to begin anywhere else. Every phasor here
            // therefore runs from zero and the entry point is added in and wrapped.
            var walk = (Phasor.ar(0, step, 0, span, 0) + (from - startF)) % span;
            // Ping-pong is a phasor over TWICE the span, folded back on itself: 0 -> span -> 0 is
            // one period, so each edge turns the playhead round instead of jumping it. Direction
            // is which half of that period it enters, which is why the rate here is unsigned.
            var bounceFrom = Select.kr(rate < 0, [from - startF, (2 * span) - (from - startF)]);
            var bouncePh = (Phasor.ar(0, step.abs, 0, 2 * span, 0) + bounceFrom) % (2 * span);
            var bounced = span - absdif(bouncePh, span);
            var mirror = Select.ar(pingpong, [walk, bounced]);
            var pos = startF + mirror;
            // Which way the playhead travels right now: the loop's own sign, except a ping-pong
            // reverses through each half of its doubled period.
            var dirPing = ((bouncePh < span) * 2) - 1;
            var dir = (pingpong * dirPing) + ((1 - pingpong) * step.sign);
            // A corner - a wrap (the walk jumps by a span) or a bounce (the direction flips) - is
            // where the trajectory bends and the PlayBuf has to be re-aimed.
            var corner = ((1 - pingpong) * (absdif(walk, Delay1.ar(walk)) > (span * 0.5)))
                + (pingpong * (absdif(dirPing, Delay1.ar(dirPing)) > 0.5));
            var hold = Trig1.ar(corner, ControlDur.ir);
            // PlayBuf reads its trigger every sample but startPos only at each block's first
            // sample (measured 2026-08-29: a mid-block trigger reset onto the value from before
            // the corner, exactly one block-offset stale). So the re-aim fires exactly ON the
            // next block boundary - hold spans one block, so a boundary always falls inside it -
            // where the startPos PlayBuf reads is the post-corner mirror. The patch below is the
            // output until then either way.
            var reAim = hold * Impulse.ar(ControlRate.ir);
            var play = PlayBuf.ar(nc, buf, step.abs * dir, reAim, pos, loop: 1);
            var patch = BufRd.ar(nc, buf, pos, loop: 1, interpolation: 4);
            var sig = (play * (1 - hold)) + (patch * hold);
            // atk/dec/rel are seconds; sustain is held until the loop's gate-off, then released.
            // Audio rate, with the one-shot's floors: no attack fade where the loop is entered at
            // the file's own edge, half a millisecond of declick anywhere else.
            var atEdge = ((from < 1) + (from > (frames - 2))).min(1);
            var atkS = max((1 - atEdge) * 0.0005, atk), decS = max(0, dec), relS = max(0.015, rel);
            var env = EnvGen.ar(Env.adsr(atkS, decS, sus, relS), gate, doneAction: 2);
            OffsetOut.ar(out, toStereo.(sig) * env * amp);
        }).add;
        SynthDef(("poptart_sample_warp_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, bend = 0|
            var overlaps = 8;
            var from = Select.kr(rate < 0, [begin, end]);
            var to = Select.kr(rate < 0, [end, begin]);
            // Here bend goes on the freqScale and NOT on the pointer, which is the whole point of a
            // warp voice: the grains are resampled while the playhead keeps its own pace, so a
            // stretched sample bends in pitch alone and still ends where the event ends.
            var sig = Warp1.ar(nc, buf, Line.kr(from, to, dur), rate.abs * bend.midiratio, 0.1, -1, overlaps, 0.1, 2)
                * (2 / overlaps);
            // atk/dec/rel are seconds, so an attack longer than the note never reaches 1 before it
            // ends. A gate held open for exactly dur runs attack->decay->sustain across playback,
            // then releases when the region ends; a cut event (gate->0 early) releases sooner. Tiny
            // floors keep the fade-in/out declicked. Audio rate like the one-shot's, but with no
            // edge case: every grain here fades in under its own window wherever it is cut from,
            // so the floor is the same half millisecond everywhere.
            var atkS = max(0.0005, atk), decS = max(0, dec), relS = max(0.015, rel);
            var noteGate = gate * (Line.kr(0, 1, dur) < 1);
            var env = EnvGen.ar(Env.adsr(atkS, decS, sus, relS), noteGate, doneAction: 2);
            OffsetOut.ar(out, toStereo.(sig) * env * amp);
        }).add;
        // Timestretched loop - same loopLo/loopHi/entry/pingpong contract as the plain loop above,
        // on Warp1's normalized 0..1 pointer. The warp defs are exempt from the float32 precision
        // treatment: a normalized pointer's resolution is ~a frame on even a 10M-frame file, and it
        // only places grain STARTS - 46ms Hann grains with deliberate random scatter, whose own
        // read phase Warp1 keeps internally - so a frame of pointer round-off never reaches the ear. The step comes from the begin..end window and its
        // play time, which cancel down to "normalized units per second" - independent of where the
        // loop bounds are, so a file-wrapping loop still moves at the rate .speed()/.fit() asked for.
        SynthDef(("poptart_sample_warp_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, loopLo = 0, loopHi = 1, entry = 0, pingpong = 0, bend = 0|
            var overlaps = 8;
            var span = max(0.001, end - begin);
            var step = (span / max(0.001, dur)) * rate.sign / ControlRate.ir;
            var lo = loopLo, hi = max(loopLo + 0.001, loopHi);
            var loopSpan = hi - lo;
            var from = entry.clip(lo, hi);
            // Same as the plain loop: resetPos never fires, so entry is added in and wrapped.
            var walk = (Phasor.kr(0, step, 0, loopSpan, 0) + (from - lo)) % loopSpan;
            var bounceFrom = Select.kr(rate < 0, [from - lo, (2 * loopSpan) - (from - lo)]);
            var bouncePh = (Phasor.kr(0, step.abs, 0, 2 * loopSpan, 0) + bounceFrom) % (2 * loopSpan);
            var bounced = lo + loopSpan - absdif(bouncePh, loopSpan);
            var ptr = Select.kr(pingpong, [lo + walk, bounced]);
            // freqScale again, not the pointer: the loop keeps its length and bends in pitch.
            var sig = Warp1.ar(nc, buf, ptr, rate.abs * bend.midiratio, 0.1, -1, overlaps, 0.1, 2) * (2 / overlaps);
            // atk/dec/rel are seconds; sustain is held until the loop's gate-off, then released.
            // Audio rate, and the windowed voices' half-millisecond floor (see the warp def above).
            var atkS = max(0.0005, atk), decS = max(0, dec), relS = max(0.015, rel);
            var env = EnvGen.ar(Env.adsr(atkS, decS, sus, relS), gate, doneAction: 2);
            OffsetOut.ar(out, toStereo.(sig) * env * amp);
        }).add;
        // Granular voice (Sig#grain): the file read as a stream of short overlapping grains cut
        // from around a position, instead of one pass from it. One synth per event like the defs
        // above, so the ADSR here is the envelope of the whole cloud and the gate is the event's -
        // the voice has no length of its own and sounds until it is told to stop.
        //
        // GrainBuf, for the reason the one-shot def uses PlayBuf: each grain's read phase lives in
        // a double inside the UGen, so a grain cut from minute four of a long file is as clean as
        // one from its first second. What it costs is that GrainBuf reads ONE channel - so the
        // voice takes a buffer per side (bufL/bufR, the same mono buffer twice for a mono file;
        // see grainSidesFor) and a stereo file is two GrainBufs off one trigger. Every input is
        // read as a grain starts and both read the same wires on the same sample, so the two
        // sides of a grain are always the same cut of the file, a matched pair.
        //
        // size, rate, pan and (when posLive says so) position are MAPPED to the track's grain bus
        // at spawn (see the playSample OSCdef), like bend: they are live controls, and a grain
        // reading one as it starts is what lets a signal place, size or pan every grain
        // separately. The trigger is audio rate, so grains start on their sample and a steady rate
        // is steady - no block-sized jitter to turn a pitched grain rate into noise.
        //
        // Pan is equal-power. A mono grain at center would sit 3 dB under the plain def's copy of
        // the same file on both sides, so it gets that back; a stereo pair is panned as a balance -
        // at 0 the left side is hard left and the right hard right, which is the file as recorded,
        // and either way out both sides travel together until they meet at the edge.
        //
        // Overlapping grains add up. They are copies of nearby audio at unrelated phases, so it is
        // their POWER that adds, and the sum grows as the square root of the overlap - half the
        // nominal count, since a bell window is half empty. Divided back out, so opening up
        // .grainsize() or .grainrate() thickens the cloud without also turning it up.
        SynthDef(("poptart_sample_grain_" ++ nc).asSymbol, { |out, bufL, bufR, begin = 0, rate = 1, gate = 1, amp = 1,
            atk = 0, dec = 0, sus = 1, rel = 0, bend = 0,
            grainpos = 0, grainsize = 0.08, grainrate = 20, grainpan = 0, posLive = 0, win = -1|
            var size = grainsize.clip(0.002, 4);
            var density = grainrate.clip(0.1, 1000);
            var trig = Impulse.ar(density);
            var pos = Select.kr(posLive, [begin, grainpos]).clip(0, 1);
            // GrainBuf already plays a buffer at its own sample rate (rate 1 is the file's pitch
            // on any server), so no BufRateScale here: with it, a 44.1 kHz file on a 48 kHz
            // server played its grains 2.9 semitones flat.
            var pitch = rate * bend.midiratio;
            var pan = grainpan.clip(-1, 1);
            var sig = if (nc == 1) {
                GrainBuf.ar(2, trig, size, bufL, pitch, pos, 4, pan, win, grainMaxOverlap) * 2.sqrt
            } {
                GrainBuf.ar(2, trig, size, bufL, pitch, pos, 4, ((2 * pan) - 1).clip(-1, 1), win, grainMaxOverlap)
                + GrainBuf.ar(2, trig, size, bufR, pitch, pos, 4, ((2 * pan) + 1).clip(-1, 1), win, grainMaxOverlap)
            };
            var level = (size * density * 0.5).max(1).sqrt.reciprocal.lag(0.05);
            // The windowed voices' envelope and floors (see the warp def above); the gate is the
            // event's alone.
            var atkS = max(0.0005, atk), decS = max(0, dec), relS = max(0.015, rel);
            var env = EnvGen.ar(Env.adsr(atkS, decS, sus, relS), gate, doneAction: 2);
            OffsetOut.ar(out, sig * level * env * amp);
        }).add;
        // Song-deck player (see the songLoad/songStart OSCdefs): one long file, played straight
        // through at `rate` into the track's input bus, so the whole DJ stage (EQ, filter,
        // crossfader, cue, meters) applies to a real song exactly as to a pattern track. One
        // persistent synth per deck rather than per-event voices: it pauses (run), seeks
        // (t_seek/seekFrame - a reset position applies only on a trigger, so spawning mid-song
        // passes t_seek: 1 with the entry frame), and dies on gate for a declicked stop. `run`
        // is lagged, so pause/resume is a tiny turntable-style slew instead of a click. PlayBuf
        // with loop 0 falls silent at EOF - Node schedules a pause at the song's end before that
        // (see server.js's song end timer; a self-gate is a deferred oddment).
        //
        // The read is PlayBuf and the position is a Phasor, which looks like two accumulators for
        // one job and is: see the precision note in the def. They are fed the same `step` and both
        // integrate it in a double, so they stay locked - and where they can differ at all (a rate
        // change lands across a block slightly differently) the difference telescopes rather than
        // accumulating, bounded at a few frames over any session.
        SynthDef(("poptart_song_" ++ nc).asSymbol, { |out, buf, rate = 1, run = 1, amp = 1, gate = 1, t_seek = 0, seekFrame = 0|
            var step = rate.lag(0.05) * BufRateScale.ir(buf) * run.lag(0.02);
            // PlayBuf rather than BufRd walked by the Phasor, for precision: a phase handed to
            // BufRd travels an audio wire, which is float32, and past 2^23 frames (~190s at 44.1k)
            // its resolution is a whole frame - so the last minutes of a long track read as a
            // nearest-neighbour hold with irregularly repeated frames instead of an interpolated
            // one. A 44.1k file on a 48k server steps 0.91875 frames per sample, and there is no
            // such number out there. PlayBuf keeps its phase in a double inside the UGen, so the
            // step stays exact wherever in the file it is. (The one-shot sampler def above was the
            // same bug, found first - 2026-08-29.)
            var sig = PlayBuf.ar(nc, buf, step, t_seek, seekFrame, loop: 0);
            // ...and the Phasor stays, but only to REPORT the playhead below. Nothing reads audio
            // through it, so its float32 output costs at most a frame of accuracy (23us) on a
            // number the drift servo compares against Node's own model with a deadband.
            var idx = Phasor.ar(t_seek, step, 0, BufFrames.ir(buf), seekFrame);
            var env = EnvGen.kr(Env.asr(0.005, 1, 0.05), gate, doneAction: 2);
            // Position report for the drift servo (songs phase 4): the actual playhead in song
            // seconds, on the sample clock. sclang tags it with the track key and forwards it
            // to Node (see the songStart OSCdef), which compares against its own model and
            // trims `rate` ppm-gently - Node's clock and this one drift apart over minutes.
            SendReply.kr(Impulse.kr(2), '/poptart/songPos', A2K.kr(idx) / BufSampleRate.ir(buf));
            Out.ar(out, toStereo.(sig) * env * amp.lag(0.02));
        }).add;
        // Keylock variant (songs phase 4): same controls and reports as the repitch player, so
        // the two are interchangeable and toggling keylock is a declicked player swap via
        // songStart. Two implementations, chosen at boot:
        //
        //  - PoptartPitchShift (native/rubberband/, installed into the user's SC Extensions by
        //    extensions.js): the repitched read goes through a Rubber Band Live Shifter at
        //    1/rate, putting the pitch back - phase-vocoder quality, the way commercial "master
        //    tempo" keylocks work. The shifter has a fixed pipeline delay (`delay`, in samples;
        //    sclang measures it once at boot with a probe synth and passes it in), and the deck
        //    hides it: the pointer runs `delay` samples AHEAD of what is heard - applied at seeks
        //    only, so a rate change never jumps it - and songStart spawns this player `delay`
        //    early with its pointer set back by as much, so the first real sample lands on time.
        //    `run` follows the same pipeline: pausing mutes once the last real audio is out,
        //    resuming unmutes once the first is - no lost tail, no held-sample DC.
        //  - the in-graph SOLA player below, for an engine without the extension. A time-domain
        //    stretcher, audibly rougher on dense mixes, but it needs nothing installed.
        if (\PoptartPitchShift.asClass.notNil) {
            SynthDef(("poptart_songwarp_" ++ nc).asSymbol, { |out, buf, rate = 1, run = 1, amp = 1, gate = 1, t_seek = 0, seekFrame = 0, delay = 0, window = 0|
                var brs = BufRateScale.ir(buf), frames = BufFrames.ir(buf), bufSr = BufSampleRate.ir(buf);
                var rateL = rate.lag(0.05), runL = run.lag(0.02);
                var step = rateL * brs * runL;
                var start = seekFrame + (delay * rate * brs);
                // PlayBuf for the read and a Phasor for the position, exactly as the repitch player
                // above does it, and for the same reason - a BufRd phase is float32 and cannot hold
                // a fractional frame past ~190s into a 44.1k file.
                var dry = PlayBuf.ar(nc, buf, step, t_seek, start, loop: 0);
                var idx = Phasor.ar(t_seek, step, 0, frames, start);
                var sh = \PoptartPitchShift.asClass.ar(dry, 1 / rateL.max(0.01), window);
                var sig = sh.keep(nc);
                var heard = idx - (delay * rateL * brs);
                var runOut = DelayN.kr(run, 0.5, delay / SampleRate.ir).lag(0.02);
                var env = EnvGen.kr(Env.asr(0.005, 1, 0.05), gate, doneAction: 2);
                SendReply.kr(Impulse.kr(2), '/poptart/songPos', A2K.kr(heard) / bufSr);
                Out.ar(out, toStereo.(sig) * env * amp.lag(0.02) * runOut);
            }).add;
        } {
            // Keylock variant (songs phase 4): same controls and reports as the repitch player, so
            // the two are interchangeable and toggling keylock is a declicked player swap via
            // songStart - but the read is a SOLA time-stretch (synchronized overlap-add), not a
            // granulator.
            //
            // What a keylock has to be is TRANSPARENT: a deck at its native rate must sound the same
            // with the button in or out, and a few percent either way must still sound like the
            // record. The Warp1 player this replaces (2026-08-28) was exactly transparent at rate 1
            // and a comb filter everywhere else: an evenly spaced overlap-add launches native-pitch
            // grains from positions that drift by (rate-1)*hop each, so a component at f only sums
            // coherently while f*(rate-1)*window is small - modelled at 5% it sat at -32 dB at
            // 500 Hz and -76 dB at 1 kHz, and the bass it kept was merely repitched (60 -> 63 Hz).
            // Randomizing the grains (windowRandRatio) swaps that comb for a -7 dB incoherent wash.
            // The fix is the standard one: align every new grain to what is already playing.
            //
            // Mechanics - everything here is sample-accurate and block-aligned, because Convolution2
            // reads its trigger once per block and transforms in frames counted from the synth's start:
            //  - a sample counter of period hop (2048; 46 ms at 44.1k) drives it all. Two readers
            //    alternate; each plays win = 2*hop at native speed under a Hann window, so the
            //    overlap-add sums to exactly 1 and an unbroken read reconstructs the source bit-exact
            //    - which is what rate 1 is.
            //  - the output's last kLen samples (low-passed at 1.5 kHz so bass and mids steer the
            //    lock, not hats) are kept time-reversed in a ring. At the wrap the ring is snapshotted
            //    as a Convolution2 kernel, which turns the convolution of a native-speed read of the
            //    source into a running cross-correlation with the output tail. Convolution2 is an
            //    overlap-add of kLen-sample frames: its output runs one frame late, and the frame
            //    after a kernel swap still carries the previous frame's tail under the OLD kernel, so
            //    the scan reads its outputs over the third and fourth frames after the wrap (count
            //    2*kLen .. 4*kLen), where both halves of the sum are under the new kernel. That read
            //    sweeps scan = 2*half source samples around where the pointer will be at the next
            //    wrap; the normalized correlation, minus a small centring penalty (silence falls
            //    back to the pointer, not an edge), is tracked by RunningMax and the winning source
            //    position latched.
            //  - at the next wrap the idle reader starts there, advanced by the hop+1 samples between
            //    the tail the kernel captured and now. While the drift is within +-half the best match
            //    is the running grain's own continuation, so the read stays continuous; past that the
            //    new grain lands a whole period (of whatever dominates the low band) away, where the
            //    join is inaudible. Content is only ever dropped or repeated in those period-sized
            //    jumps - the SOLA compromise.
            //  - at the first wrap both readers start from the pointer, one already at the top of its
            //    window, so a start or a keylock swap opens at full level instead of fading in.
            //  - run pauses the pointer AND mutes. A paused pointer would otherwise be a granular
            //    freeze; the repitch player's turntable slew has no equivalent here.
            //  - a seek takes effect at the next wrap (up to 46 ms) under the Hann crossfade; the
            //    correlation then aligns the new region to whatever periodicity it can find.
            // The numbers were chosen on a per-sample model of this graph: the search must exceed
            // half a bass period (half = 512 samples = 11.6 ms covers 43 Hz) or the bass loses its
            // lock, kLen is bounded by Convolution2's frame, and hop = 4*kLen is the pipeline's
            // length - a snapshot, two frames of settling, two frames of scan.
            //
            // Precision (the float32-wire story on the repitch player): every read here is
            // "seek to a computed position, then run linearly at native speed" - which is exactly
            // PlayBuf's trigger + startPos contract - so all three readers are PlayBufs. The
            // computed positions still ride float32 wires, but a position only has to be right at
            // its trigger, and every wrap sits on a block boundary (hop is a multiple of the
            // block), so PlayBuf's block-read trigger fires exactly on time. Past ~190s of file
            // this removes the per-sample read quantization (measured as hop-harmonic sidebands:
            // -20 dB before, -33 after, at 3 kHz) but NOT the anchors' rounding to whole frames -
            // a random half-frame per hop that ripples the crossfades into ~-18 dB of broadband
            // noise at 3 kHz (proportionally less at lower frequencies), and which the old graph
            // had identically underneath its aliasing. That floor is what stock UGens can reach:
            // sub-frame anchors mean either a custom reader UGen or carrying every position as a
            // latched coarse frame plus a small precise remainder applied as a fractional delay -
            // a real refinement, deliberately not taken for the no-extension fallback path.
            SynthDef(("poptart_songwarp_" ++ nc).asSymbol, { |out, buf, rate = 1, run = 1, amp = 1, gate = 1, t_seek = 0, seekFrame = 0|
                var kLen = 512, half = 512, scan = 2 * half, hop = 4 * kLen, win = 2 * hop;
                var brs = BufRateScale.ir(buf), frames = BufFrames.ir(buf), bufSr = BufSampleRate.ir(buf);
                var sr = SampleRate.ir, winSec = win / sr;
                var mono = { |sig| if (nc == 1) { sig } { sig.sum * 0.5 } };
                var lpCoef = exp(-2pi * 1500 / sr);
                var runL = run.lag(0.02), rateL = rate.lag(0.05);
                var step = rateL * brs * runL;
                var idx = Phasor.ar(t_seek, step, 0, frames, seekFrame);
                // The counter. Triggers are exact-integer comparisons on it, so they can never drift
                // off the block boundary the way an Impulse.ar with a fractional period would.
                var count = Phasor.ar(0, 1, 0, hop, 0);
                var at = { |n| (count - n).abs < 0.5 };
                var wrap = at.(0);
                var inScan = count >= (2 * kLen);
                var ring = LocalBuf(hop).clear;
                // Scan reader: a native-speed read positioned so that the scan's midpoint (allowing
                // for Convolution2's lag) maps onto the pointer at the next wrap.
                // Convolution2's output resumes inside the block that completes a frame, so its lag
                // is a frame less a block.
                var lag = kLen - BlockSize.ir;
                // Latched whole at the wrap (not just the pointer half): rateL keeps slewing
                // mid-scan, and the PlayBuf below freezes its start at the trigger - the position
                // the score is attached to has to agree with the read it is scoring.
                var r0 = Latch.ar(Latch.ar(idx, wrap) + (brs * ((hop * (rateL - 1)) - (2 * kLen) - 1 - BlockSize.ir)), wrap);
                var rPos = r0 + (brs * Sweep.ar(wrap, sr));
                var s = OnePole.ar(mono.(PlayBuf.ar(nc, buf, brs, wrap, r0, loop: 1)), lpCoef);
                var corr = Convolution2.ar(s, ring, wrap, kLen);
                // The correlation at n covers the read `lag` samples earlier; normalize over that window.
                var sNorm = DelayN.ar(RunningSum.ar(s * s, kLen), lag / sr, lag / sr).sqrt + 1e-6;
                // The output tail's energy comes back through LocalIn (a wire would be a cycle); one
                // block late is nothing to a normalization that only has to hold within a scan.
                var fb = LocalIn.ar(1);
                var kNorm = Latch.ar(RunningSum.ar(fb * fb, kLen), wrap).sqrt + 1e-6;
                var scanT = count - (2 * kLen);
                var score = (corr / (sNorm * kNorm)) - (0.1 * (scanT - half).abs / half);
                var isNew = (score >= RunningMax.ar(score, at.(2 * kLen))) * inScan;
                // Gate, not Latch: a new maximum is a LEVEL that holds for runs of samples, and Latch
                // would only take the first of each run.
                var bestR = Gate.ar(rPos - (brs * lag), isNew);
                // A grain is placed against the tail captured a wrap earlier - the peak of the grain
                // started TWO wraps back - so the two readers form interleaved chains, each continuing
                // itself. They only agree if they are seeded as one continuous read: the first wrap
                // sits on the pointer (there is no tail yet), the second continues it at native
                // speed (its own scan ran against an empty ring), and from the third on the scans
                // carry it. The chains then drift identically and jump by the same period.
                var nth = PulseCount.ar(wrap);
                var seed = Select.ar(nth > 1, [idx, Delay1.ar(Latch.ar(idx, wrap)) + (brs * hop)]);
                var startPos = Latch.ar(Select.ar(nth > 2, [seed, bestR + (brs * (hop + 1))]), wrap);
                // Two alternating Hann-windowed native-speed readers. At the first wrap BOTH start
                // from the pointer: B rising as usual, A pulled a hop back and aged a hop forward so
                // it is the falling half - their windows sum to 1 from the first sample. B then rises
                // again at every odd wrap, A at every even one.
                var first = nth <= 1;
                var sel = ToggleFF.ar(wrap);
                var reader = { |trig, isA|
                    var early = Latch.ar(first * isA, trig);
                    var age = Sweep.ar(trig, 1) + (early * (hop / sr));
                    var w = (age < winSec) * (0.5 - (0.5 * cos(2pi * age / winSec))) * (PulseCount.ar(trig) > 0);
                    // PlayBuf latches startPos at the trigger itself and integrates in a double.
                    // The old `early` pull-back on the start cancelled exactly against the aged
                    // read offset (early*hop*brs both ways), so only the window keeps the head
                    // start and the read starts from startPos as-is.
                    PlayBuf.ar(nc, buf, brs, trig, startPos, loop: 1) * w
                };
                var sig = reader.(wrap * ((1 - sel) + first), 1) + reader.(wrap * sel, 0);
                var lpOut = OnePole.ar(mono.(sig), lpCoef);
                var env = EnvGen.kr(Env.asr(0.005, 1, 0.05), gate, doneAction: 2);
                BufWr.ar(lpOut, ring, hop - 1 - count, 1);
                LocalOut.ar(lpOut);
                SendReply.kr(Impulse.kr(2), '/poptart/songPos', A2K.kr(idx) / bufSr);
                Out.ar(out, toStereo.(sig) * env * amp.lag(0.02) * runL);
            }).add;
        };
    };
    // Feeder for a hardware audio input as a sidechain/chain source (input(...) / audio("dev:...")):
    // reads two channels off the booted device's inputs (SoundIn, 0-indexed) and writes them to a
    // bus. The two are read independently, so a pair need not be adjacent - input(1, 5) is as valid
    // as input(1, 2). Two separate SoundIn.ar calls rather than SoundIn.ar([inA, inB]): the array
    // form tests its elements for consecutiveness with ==, which is meaningless on controls (it
    // compares UGen identity, so it silently takes the multichannel-expand branch). Reading each
    // channel explicitly says what we mean and doesn't rest on that. Channel numbers arrive already
    // resolved to absolute and clamped to the device (wireAudio), so these are plain bus indices.
    SynthDef(\poptart_soundin, { |out, inA = 0, inB = 1, gain = 1|
        Out.ar(out, [SoundIn.ar(inA), SoundIn.ar(inB)] * gain);
    }).add;
    // Mono form (input(3) - one channel): the same source lands on BOTH sides, so a mic sits
    // centred rather than hard left.
    SynthDef(\poptart_soundin_mono, { |out, inA = 0, gain = 1|
        Out.ar(out, SoundIn.ar(inA).dup * gain);
    }).add;
    // Feeder for a named audio bus read as a chain source (audio("busName")): copies the summed
    // bus into the sink's input bus. Runs at the sink group's head, and the sink's group is ordered
    // after the bus's writer tracks (see reorderTracks), so the sum is already present this block.
    SynthDef(\poptart_busread, { |out, in, gain = 1, fb = 0|
        // `fb` 1 on the edge that closes a loop (see trackLevels): the block before, from a bus
        // that is written after this reads it. Otherwise this block's, written before.
        Out.ar(out, Select.ar(fb, [In.ar(in, 2), InFeedback.ar(in, 2)]) * gain);
    }).add;
    // Recorder meter: streams the tapped track's peak level to Node while the record panel is
    // open, which is what the panel draws. Peak-hold over the reply interval rather than an
    // instantaneous read, so a transient between two replies can't go unseen - the panel would
    // otherwise show a kick drum as silence about half the time. Runs whether or not a bounce is
    // in progress; it is the only cost of an open panel.
    // SendPeakRMS is the built-in meter feed: it replies 20x/sec with [peak, rms] per channel,
    // the peak being a held maximum over the interval rather than an instantaneous read - so a
    // transient between two replies can't go unseen (the panel would otherwise show a kick drum
    // as silence about half the time).
    SynthDef(\poptart_rec_meter, { |bus|
        SendPeakRMS.kr(In.ar(bus, 2), 20, 3, '/poptart/recLevel');
    }).add;
    // DJ deck meter reader (see the deck meter section below): same feed shape as the mixer's
    // per-track meter, one per deck while the strip is open, id 0 = deck A / 1 = deck B.
    //
    // Plus the three band energies that COLOR the deck's waveform strip. A song deck's waveform
    // is colored from an offline pass over the file (osc-engine/wav.js's envelope: the same 200Hz
    // and 2kHz split, one-pole, energy per band, normalized); a livecoded deck has no file, so
    // its strip is drawn from this feed and had no spectrum to color by at all. OnePole with
    // exp(-2pi f / sr) is that same one-pole filter, so the two agree about what "low" means,
    // and the bands nest exactly as they do there: each one is the difference between two of the
    // lowpasses. The energies are mean-square (the squared band, smoothed well under the reply
    // rate) rather than peaks, because a share of the ENERGY is what the color mixes.
    SynthDef(\poptart_deck_meter, { |bus, id|
        var frame = Impulse.kr(20);
        var sig = In.ar(bus, 2);
        var mono = (sig[0] + sig[1]) * 0.5;
        var lp = [200, 2000].collect { |f| OnePole.ar(mono, exp(-2pi * f / SampleRate.ir)) };
        var bands = [lp[0], lp[1] - lp[0], mono - lp[1]];
        var energy = bands.collect { |b| A2K.kr(LPF.ar(b.squared, 10)) };
        SendPeakRMS.kr(sig, 20, 3, '/poptart/deckLevel', id);
        SendReply.kr(frame, '/poptart/deckBands', energy, id);
    }).add;
    // The master meter: every hardware output summed to ONE stereo pair (the left of each pair
    // into the left, the right into the right), and the peak of that. Tracks can go out of
    // separate pairs (.o(n)), but the question this answers is about the song as a whole: all of
    // it together, as it will be when it is one stereo mix on a deck, is it over full scale? It
    // only listens - nothing here touches the sound. The headphone cue pair is left out: it is
    // a second copy of the mix, not more of it.
    SynthDef(\poptart_master, {
        var chans = (0 .. server.options.numOutputBusChannels - 1).reject { |c|
            cueOffset.notNil and: { (c == cueOffset) or: { c == (cueOffset + 1) } }
        };
        var sum = [chans.select(_.even), chans.select(_.odd)].collect { |side|
            if (side.isEmpty) { DC.ar(0) } { Mix(side.collect { |c| In.ar(c, 1) }) }
        };
        SendPeakRMS.kr(sum, 20, 3, '/poptart/masterLevel');
    }).add;
    // The headphones: what the cue pair finally plays. Every track with its cue (or monitor) on
    // has already summed itself into the cue pair this block (see the track def's cue tap); this
    // is the last node there is, so it reads that sum back, blends in the main mix and sets the
    // level, and REPLACES the pair with the result. The two knobs of a hardware desk's headphone
    // section:
    //
    //   mix    0 = the cued decks only, 1 = the main mix only. Both are at full through the
    //          middle, as on a hardware cue mix, so centered is the cue laid over the room.
    //   level  the headphone volume, 0..1 on a squared law (the knob's travel reads as loudness),
    //          1 = unity - nothing here can push the pair past what the tracks sent it.
    //
    // The main mix is every output but the cue pair, summed to one stereo pair the way the master
    // meter sums it. Built only on an engine booted with a cue pair.
    cueOffset !? {
        SynthDef(\poptart_headphones, { |level = 1, mix = 0|
            var chans = (0 .. server.options.numOutputBusChannels - 1).reject { |c|
                (c == cueOffset) or: { c == (cueOffset + 1) }
            };
            var main = [chans.select(_.even), chans.select(_.odd)].collect { |side|
                if (side.isEmpty) { DC.ar(0) } { Mix(side.collect { |c| In.ar(c, 1) }) }
            };
            var m = mix.lag(0.05).clip(0, 1);
            var cueAmt = ((1 - m) * 2).min(1), mainAmt = (m * 2).min(1);
            var amp = level.lag(0.05).clip(0, 1).squared;
            ReplaceOut.ar(cueOffset, ((In.ar(cueOffset, 2) * cueAmt) + (main * mainAmt)) * amp);
        }).add;
    };
    // The bounce itself. Nothing but a DiskOut: everything about WHEN it runs is decided by the
    // timestamped bundles that start and free it (see the recordTrack OSCdef), so the file's
    // length is sample-accurate rather than however long the messages took to arrive.
    SynthDef(\poptart_rec_disk, { |bus, buf|
        DiskOut.ar(buf, In.ar(bus, 2));
    }).add;
    // A term of a track's chain (see routeApply): `in` at the route gain whose level and pan are
    // on the control bus `gain` (unityGainBus for none), added into `out`. Balance2 is the strip's
    // law, referenced to the center by the sqrt(2).
    SynthDef(\poptart_term, { |in, out, gain|
        var sig = In.ar(in, 2);
        var g = In.kr(gain, 2);
        Out.ar(out, Balance2.ar(sig[0], sig[1], g[1], g[0] * 2.sqrt));
    }).add;
    // The publishers of a track's route controls (see routeKrNode): a level and pan pair, and a
    // crossover's frequency as a position on its control.
    SynthDef(\poptart_gainkr, { |out, level = 1, pan = 0| ReplaceOut.kr(out, [level, pan]) }).add;
    SynthDef(\poptart_xokr, { |out, value = 0| ReplaceOut.kr(out, value) }).add;
    // Unity, center: a term at no gain reads this. Nothing writes it.
    unityGainBus = Bus.control(server, 2);
    unityGainBus.setn([1, 0]);
    // Parked buses + route bookkeeping for audio sidechains (see Sig#sidechain). Allocated once,
    // here, so every track synth's sc* args have a valid default (silence in, send to nowhere).
    silentBus = Bus.audio(server, 2);
    trashBus = Bus.audio(server, 2);
    // The DJ deck meter buses (see the var declaration): one 4-channel block so A and B are
    // guaranteed adjacent and the track def can address B as `.index + 2`.
    deckMeterBus = Bus.audio(server, 4);
    sidechainByTarget = IdentityDictionary.new; // scKey -> (bus:, target:, slot:, source:, feeder:)
    sidechainBySource = IdentityDictionary.new; // sourceKey (Symbol) -> [(targetKey:, slot:)] it feeds
    sourceFeeds = IdentityDictionary.new; // sourceKey (Symbol) -> (bus: Bus, refs: Int)
    namedBuses = IdentityDictionary.new; // busName (Symbol) -> (bus: Bus, refs: Int)
    exprQueue = IdentityDictionary.new; // "track|slot|name" -> installs/clears waiting their turn
    exprDefs = Dictionary.new; // tree shape ++ "|" ++ output kind -> SynthDef name (see installExpr)
    paramRoutes = IdentityDictionary.new; // paramRouteKey -> (targetKey:, slot:, name:, source:, busName:, bus:, gain:, offset:, index:)
    // Recorder taps read what the track synths wrote this block, so their group goes at the tail.
    recTaps = IdentityDictionary.new; // trackId (Symbol) -> (bus:, meter:, disk:, buf:, path:)
    // Mixer analysis synths share the tail group for the same read-after-write reason.
    mixTaps = IdentityDictionary.new; // trackId (Symbol) -> (bus:, synth:, funcs:, full:)
    mixWanted = IdentitySet.new; // trackIds Node wants tapped - see the mix var declarations
    recGroup = Group.new(server, \addToTail);
    // Depth 0 - every track starts here; deeper groups are made before recGroup as routes need them.
    levelGroups = [Group.new(server, \addToHead)];
    server.sync;
    // After recGroup, so it is the last node there is and reads what everything else wrote.
    masterSynth = Synth(\poptart_master, target: recGroup, addAction: \addAfter);
    // ...and after that the headphones, which must hear every cue send and the finished mix.
    cueOffset !? {
        headphoneSynth = Synth(\poptart_headphones, [\level, headphoneLevel, \mix, headphoneMix],
            target: masterSynth, addAction: \addAfter);
    };
    // --- the server's pressure gauge ----------------------------------------------------------
    //
    // scsynth will say what it is holding if asked (/status), and nothing ever asked. So the only
    // sign of a server filling up was it failing - at which point it is already too late, because
    // nothing hands real-time memory back (see outOfRoom). Asked every few seconds now, and said
    // when it crosses the line, so there is warning while there is still time to stop a track.
    //
    // The node table is the readable proxy: real-time memory is not reported at all, but the
    // things that consume it are nodes, and the two ceilings sit at comparable heights. Hysteresis
    // so a figure resting on the threshold does not repeat, and the line carries the voice count
    // and the CPU because they are the two numbers that say WHY.
    OSCdef(\poptartStatusReply, { |msg|
        var numSynths = msg[3].asInteger, numGroups = msg[4].asInteger;
        var peakCPU = msg[7].asFloat;
        var nodes = numSynths + numGroups;
        var limit = server.options.maxNodes;
        // ...and up to Node on every reading, whether it is high or not: the console is no use to
        // somebody on stage, and the only place this can be ACTED on is the app's own status.
        nodeAddr.sendMsg("/poptart/serverLoad", nodes, limit, liveVoices.size, peakCPU);
        if (nodes > (limit * 0.6)) {
            if (statusNodesHigh.not) {
                statusNodesHigh = true;
                ("poptart: the audio server is getting full - " ++ nodes ++ " of " ++ limit
                    ++ " nodes in use (" ++ liveVoices.size ++ " sample voices sounding, peak CPU "
                    ++ peakCPU.round(0.1) ++ "%). Past this it stops being able to create anything, "
                    ++ "and it cannot recover without an engine restart - stop a track if you can").warn;
            };
        } {
            if (nodes < (limit * 0.4)) { statusNodesHigh = false }; // room again: re-arm the warning
        };
    }, '/status.reply', server.addr);
    statusWatch = Routine({ loop { server.sendMsg("/status"); 3.wait } }).play(SystemClock);

    // sclang stall watchdog - the engine's twin of Node's. Every note reaches scsynth through this
    // single-threaded process, which stamps it "latency from now" as it handles it, so anything
    // that holds sclang shifts every playing track later and then lands the backlog at once:
    // heard as the music stopping and a pileup, with no `late` from scsynth and nothing from Node
    // to say why. A 20 ms tick on the system clock; a gap past 80 ms is reported with how much
    // arrived meanwhile and the last few addresses, which is the culprit or what queued behind it.
    {
        var recent = Array.newClear(6), at = 0, count = 0, seen = 0, last = Main.elapsedTime;
        thisProcess.addOSCRecvFunc({ |msg|
            recent[at] = msg[0];
            at = (at + 1) % recent.size;
            count = count + 1;
        });
        SystemClock.sched(0.02, {
            var now = Main.elapsedTime, gap = now - last - 0.02;
            if (gap > 0.08) {
                ("poptart: sclang stalled ~" ++ (gap * 1000).round ++ "ms - " ++ (count - seen)
                    ++ " message(s) arrived meanwhile; latest: "
                    ++ (recent.rotate(at.neg).select(_.notNil).collect(_.asString).join(", "))).warn;
            };
            last = now;
            seen = count;
            0.02
        });
    }.value;

    "poptart: server booted, ready".postln;
    // scsynth's pid rides along with the ready: node spawned US, not scsynth, so this is its only
    // handle on the process that actually holds the audio device and scsynth's UDP port. It uses
    // it to clean up after a stack that didn't shut down properly - see osc-engine/orphans.js.
    // The keylock pitch shifter's pipeline delay (samples), measured once here: it is fixed for
    // a sample rate but only the plugin knows it, so a throwaway synth reports it and every
    // keylocked songStart passes it to the player. 0 without the extension (SOLA fallback).
    ~rbDelay = 0;
    if (\PoptartPitchShift.asClass.notNil) {
        var probe = SynthDef(\poptart_rbprobe, {
            var sh = \PoptartPitchShift.asClass.ar(Silent.ar(2), 1, 0);
            SendReply.kr(Impulse.kr(0), '/poptart/rbDelay', A2K.kr(sh[2]));
            Line.kr(0, 1, 0.05, doneAction: 2);
        });
        OSCFunc({ |m|
            ~rbDelay = m[3].asFloat;
            nodeAddr.sendMsg("/poptart/ids/rbDelay", ~rbDelay);
            ("poptart: keylock pitch shifter delay " ++ ~rbDelay.asInteger ++ " samples").postln;
        }, '/poptart/rbDelay', server.addr).oneShot;
        probe.add(completionMsg: Synth.basicNew(\poptart_rbprobe, server).newMsg);
    };
    // Node creates per-note voices itself (the direct path), from a block of node ids this
    // client's allocator never reaches: NodeIDAllocator keeps client N inside (N << 26) + 0..0x03FFFFFF.
    {
        var block = if (server.clientID == 31) { 30 } { 31 };
        var lo = (block << 26) + 1000;
        nodeAddr.sendMsg("/poptart/ids/server", scsynthPort, lo, (block << 26) + 0x03FFFFFF,
            server.sampleRate ? sampleRate, ~rbDelay ? 0, openWaitMax + coldWaitMax);
    }.value;
    nodeAddr.sendMsg("/poptart/ready", server.pid ? -1);
    // Populate the plugin dict in the background so .synth("Name") can resolve names. Cached
    // plugins re-verify instantly; only new/changed ones get probed (out-of-process, with a
    // per-plugin timeout so a hang skips that plugin instead of stalling the scan).
    runScan.({
        "poptart: initial plugin search done (% plugins)".format(VSTPlugin.plugins(server).size).postln;
    });
};

// --- track / chain management ---

// Builds the track for a key nobody holds: reserves it with \pending, and commits the real track
// at the end of the async build below. `birth` is the list of channel-control name/value pairs
// the track synth is born with (see poptartCreateTrack).
buildTrack = { |key, birth|
    // This build's claim on the key. Only the holder of the current generation may commit, and a
    // reclaim bumps it - see reclaimStuckTrack for why a build has to be able to find out that
    // the key stopped being its to fill.
    var gen = (trackGen[key] ? 0) + 1;
    trackGen[key] = gen;
    tracks[key] = \pending;
    fork {
        var group = Group.new(levelGroups[0]); // depth 0 until a route says otherwise (see reorderTracks)
        // Sample voices spawn into a group of their own at the head of the track's, so one
        // gate-off releases every one of them at once (see hushTrack); the modulators, the
        // ramps and the chain sit outside it, in the track group as before.
        var voices = Group.new(group, \addToHead);
        var inBus = Bus.audio(server, 2); // sample synths write here, the track synth mixes it in
        // The track's pitch-bend value, republished by the track synth for its sample voices to
        // map and for the MIDI sender to read (see buildTrackDef). One per track for the track's
        // life, so a voice spawned at any moment has somewhere to read from; it sits at 0 -
        // no bend - until something writes it.
        var bendBus = Bus.control(server, 1);
        // ...and the four grain controls, likewise (pos, size, rate, pan - in that order).
        var grainBus = Bus.control(server, 4);
        // What the head writes and the first effect (or the strip) reads.
        var chainIn = Bus.audio(server, 2);
        // What the strip publishes for its DJ stage and taps (see buildTrackDef).
        var ctlBus = Bus.control(server, 6);
        var synth, head, chain, krGroup, postGroup;
        var def = sharedTrackDef.();
        // The channel values the track is born with, split between the two nodes that own them.
        var headNames = #[\gain, \bend, \bendrange, \grainpos, \grainsize, \grainrate, \grainpan];
        var birthPairs = birth.clump(2);
        var headBirth = birthPairs.select { |p| headNames.includes(p[0]) }.flatten;
        var stripBirth = birthPairs.reject { |p| headNames.includes(p[0]) }.flatten;
        // Control buses keep whatever the last owner left in them - the server never clears
        // one, on free or on allocation - so a recycled index could hand a new track somebody
        // else's bend for the block before its track synth first writes. Zeroed explicitly,
        // ahead of the sync, so the bus is at centre before anything can read it.
        bendBus.set(0);
        grainBus.setn([0, 0.08, 20, 0]);
        server.sync; // load-bearing: orders the buses and the def ahead of the synth (see TODO-verbose.md)
        // The chain: its route-control publishers first, then the head, the effects as routeApply
        // places them, and the strip last - in signal order, so one block runs it all.
        chain = Group.new(group, \addToTail);
        krGroup = Group.new(chain, \addToHead);
        head = Synth(def[\head].name, [\inBus, inBus.index, \out, chainIn.index, \bendOut, bendBus.index, \grainOut, grainBus.index] ++ headBirth,
            target: chain, addAction: \addToTail);
        synth = Synth(def[\strip].name, [\in, chainIn.index, \post, routeNowhere, \ctl, ctlBus.index, \pairs, trackPairs.()]
            ++ stripBirth, target: chain, addAction: \addToTail);
        // The DJ stage, the taps and the sends, when there are any: after the strip.
        postGroup = Group.new(chain, \addAfter);
        // Somebody gave up on this build while it was in flight and the key has been built
        // again since (see reclaimStuckTrack). Committing now would overwrite a live track
        // with a synth nothing else can reach, so this one is taken back down instead -
        // freeing the group takes the voices group and the track synth with it.
        if (trackGen[key] != gen) {
            group.free; inBus.free; bendBus.free; grainBus.free; chainIn.free; ctlBus.free;
            ("poptart: track " ++ key ++ " finished building after it was given up on - "
                ++ "discarded it and kept the track that replaced it").warn;
        } {
            // SendReply names its sender by node id and nothing else, so the bend messages
            // coming back from this synth need a way home (see the bendOut OSCFunc).
            bendTracks[head.nodeID] = key;
            // Who these two belong to, for the failure reports (see nodeOwns). The GROUP matters
            // most: a synth created into a freed group fails naming the GROUP, and by then this
            // track may be gone - which is exactly when you want to know whose it was.
            nodeOwns.(group.nodeID, key ++ "'s group");
            nodeOwns.(head.nodeID, key ++ "'s instrument");
            nodeOwns.(synth.nodeID, key ++ "'s channel strip");
            tracks[key] = (
                group: group,
                voices: voices,
                inBus: inBus,
                bendBus: bendBus,
                grainBus: grainBus,
                synth: synth,                     // the strip (see sharedTrackDef)
                born: (trackSerial = trackSerial + 1), // the order tracks were made in (see trackLevels)
                head: head,                       // the instrument, slot 0
                chain: chain,                     // the group the chain runs in, in signal order
                krGroup: krGroup,                 // the route controls' publishers, at its head
                chainIn: chainIn,                 // what the head writes
                ctlBus: ctlBus,                   // what the strip publishes (see buildTrackDef)
                postGroup: postGroup,             // the DJ stage, taps and sends (see djNode)
                taps: IdentityDictionary.new,     // name -> tap node (see stripTap)
                nodes: IdentityDictionary.new,    // slot -> its effect node (see ensureFxNode)
                xovers: IdentityDictionary.new,   // crossover id -> (node:, ctl:) (see routeApply)
                terms: List.new,                  // the level/sum nodes of the current wiring
                gains: IdentityDictionary.new,    // k -> (node:, bus:) for rl<k>/rp<k>
                xos: IdentityDictionary.new,      // k -> (node:, bus:) for xo<k>
                scBus: IdentityDictionary.new,    // slot -> its sidechain bus (see setScBus)
                wet: IdentityDictionary.new,      // slot -> a wetN set before its node was made
                controllers: IdentityDictionary.new,
                loaded: IdentityDictionary.new, // slot -> pluginId once open() succeeds
                wanted: IdentityDictionary.new, // slot -> pluginId an in-flight open() should commit
                lfos: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, shape:, index:)
                envs: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, index:)
                ccs: IdentityDictionary.new,      // \slotN_param -> (bus:, index:, lo:, hi:, last:, binding:, defKey:)
                oscs: IdentityDictionary.new,     // \slotN_param -> same shape as ccs, bound to an OSC address (see setParamOSC)
                ramps: IdentityDictionary.new,    // \slotN_param -> (synth:, bus:, index:, slot:) - polled controls (see rampTo)
                resting: IdentityDictionary.new,  // \slotN_param -> what the parameter was before the pattern took it (see \poptartHoldParam)
                editWatch: IdentityDictionary.new, // slot -> [OSCFunc] watching for plugin edits
                key: key,                         // what Node calls it (see tellTrack)
                held: 0,                          // active-note count, drives env gates
                // slot -> (note -> when its off lands), see markSounding; made on first use
                sounding: IdentityDictionary.new
            );
            tellTrack.(tracks[key]);
            // A track born while the mixer is open joins its meters right away (an eval that
            // adds a block mid-session), instead of staying dark until the mixer is reopened
            // - if Node has asked for it; the ask may have arrived while this was pending.
            if (mixOn) { mixReconcile.() };
            // ...and a display of it already on screen starts drawing it.
            if (viewTap[\on]) { viewTap[\reconcile].() };
            // A DJ stage born touched (a desk's trim or EQ carried over) is made now.
            birthPairs.select { |p| #[\trim, \eqlo, \eqmid, \eqhi, \djf, \djres, \cue, \mdeck].includes(p[0]) } !? { |dj|
                if (dj.notEmpty) { djNode.(tracks[key]).set(*dj.flatten) };
            };
        };
    };
};

OSCdef(\poptartCreateTrack, { |msg|
    var key = msg[1].asSymbol;
    // Optional birth values (name/value pairs after the key): channel controls baked into the
    // Synth's own args, so a track created into a live mix comes up ALREADY wearing the desk's
    // state (deck gain 0 = born silent). They have to ride the creation itself: a setParam sent
    // while the track is still \pending is dropped (see poptartSetParam), which is the race
    // that had freshly evaled stems flash in at full volume before the desk caught them.
    var birth = if (msg.size > 2) {
        msg.copyRange(2, msg.size - 1).clump(2).collect { |p| [p[0].asSymbol, p[1].asFloat] }.flatten;
    } { [] };
    if (tracks[key].isNil) {
        buildTrack.(key, birth);
    } {
        // Asked to build a key that is still being built. Nearly always that is the same
        // evaluation asking twice (the eval loop pre-claims every track, and the scheduler's
        // setPattern asks again a moment later), and there is nothing to do. But this is also
        // the ONLY message a plain track - no plugins, no routes, nothing that waits on it - ever
        // sends about the key, so if that build was lost (see reclaimStuckTrack) this is where
        // it has to be found out: wait the build out, and if the key comes back empty, build it
        // again now rather than leaving that to an evaluation that may never come.
        if (tracks[key] == \pending) {
            fork {
                if (awaitTrack.(key).isNil and: { tracks[key].isNil }) { buildTrack.(key, birth) };
            };
        };
    };
}, '/poptart/createTrack');

// Destroy a track outright - the performance mixer's complete-mix drops the outgoing song's
// tracks so a set doesn't accumulate a silent song of idle plugins per transition. (There was
// deliberately no destroy before this: an eval that drops a label keeps its track warm for the
// label's return.) Everything the track owns goes: its mix tap, edit watchers, every modulator
// synth and bus, sidechain routes in AND out, bus-send refs, the group (track synth, sample
// synths, feeders) and the input bus. Freeing the synth is what closes the VSTPlugin instances
// (and any open editor windows). The def stays in the SynthDescLib - a later track under the
// same key rebuilds and re-adds it anyway.
destroyTrack = { |key|
    fork {
        var track = awaitTrack.(key); // \pending: let the birth finish, then take it down
        track !? {
            stopMixTap.(key);
            ([0] ++ track[\nodes].keys.asArray ++ track[\scBus].keys.asArray).asSet.do { |slot|
                unwireAudio.(key, slot); // routes INTO this track
                track[\editWatch][slot] !? { |funcs| funcs.do { |f| f.free }; track[\editWatch][slot] = nil };
            };
            // ...and every route OUT of it - one source may feed several sinks. Over a copy:
            // unwireAudio rewrites this very list as it goes.
            sidechainBySource[key] !? { |routes| routes.copy.do { |e| unwireAudio.(e[\targetKey], e[\slot]) } };
            // Parameter patches the same way, into this track and out of it.
            paramRoutes.values.select { |e| (e[\targetKey] == key) or: { e[\source] == key } }
                .do { |e| unwireParamRoute.(e[\targetKey], e[\slot], e[\name]) };
            [track[\lfos], track[\envs], track[\ramps]].do { |dict|
                dict.do { |e| e[\synth] !? { |s| s.free }; e[\bus] !? { |b| b.free };
                    e[\bufs] !? { |list| list.do(_.free) } };
            };
            track[\ccs].do { |e| MIDIdef.all[e[\defKey]] !? { |d| d.free }; e[\bus] !? { |b| b.free } };
            // Expression synths go with the group; their output buses are ours to hand back.
            exprsOf.(track).do { |e| e[\out] !? { |b| b.free }; exprDefDone.(e[\def]) };
            track[\oscs].do { |e| OSCdef.all[e[\defKey]] !? { |d| d.free }; e[\bus] !? { |b| b.free } };
            track[\busSends] !? { |names| names.do { |bn| releaseBus.(bn) } };
            track[\fxBus] !? { |bn| releaseBus.(bn) }; // the DJ FX send's ref (see setFxSend)
            // A song deck's player synth dies with the group below; its buffer (the whole file,
            // real RAM) must not outlive the track.
            songs[key] !? { |e| e[\posFunc] !? { |f| f.free }; e[\buf] !? { |b| b.free }; songs[key] = nil };
            bendTracks.removeAt(track[\head].nodeID);
            viewTap[\stop].(key); // a display's tap of it, buffers and all (a rebuilt track is tapped anew)
            track[\group].free;
            track[\inBus].free;
            track[\bendBus] !? { |b| b.free };
            track[\grainBus] !? { |b| b.free };
            // The chain's buses are ours to hand back (its nodes went with the group).
            [track[\chainIn], track[\ctlBus], track[\post], track[\bassmonoBus]].do { |b| b !? { b.free } };
            [track[\gains], track[\xos]].do { |all| all.do { |e| e[\bus].free } };
            track[\route] !? { |r| r[\buses].do(_.free) };
            tracks[key] = nil;
            nodeAddr.sendMsg("/poptart/ids/trackGone", key);
            reorderTracks.(); // whatever read this track sits shallower now
            ("poptart: destroyed track " ++ key).postln;
        };
    };
};

OSCdef(\poptartDestroyTrack, { |msg|
    destroyTrack.(msg[1].asSymbol);
}, '/poptart/destroyTrack');

// --- a track's chain ('/poptart/setRouting') -------------------------------------------------
//
// The chain as osc-engine/route-desktop.js lays it out: `steps`, in the order the audio runs - an
// effect's node, a .bands() crossover or a term (a signal into a sum, or into a reader, at one of
// the track's route gains) - each with the buses it reads and writes; `out`, the bus the strip
// reads; and `buses`, every private bus they name ("chain" is the one the head writes).
//
// Nothing that holds a device is rebuilt here. An effect's node is made the first time a chain
// names its slot (see ensureFxNode) and from then on only moves and is pointed at other buses, so
// its plugin keeps playing and keeps its program; a crossover's likewise, by its id. Terms hold
// nothing, so they are made afresh. It all lands in one bundle - every node in its new place, on
// its new buses, in the same block - and the old buses go back a moment later, once nothing reads
// them. An effect the chain no longer runs through is parked (reading and writing nowhere) until
// its unload frees it.
routeApply = { |key, track, spec|
    var made = (buses: List.new, index: Dictionary.new);
    var old = track[\route];
    var steps = (spec !? { spec["steps"] }) ? [];
    var busOf = { |v|
        case
        { v == "chain" } { track[\chainIn].index }
        { v.isNil or: { v == "none" } } { routeNowhere }
        { made[\index][v] ? routeNowhere }
    };
    var params = (spec !? { spec["crossover"] } ? []).clump(3).collect { |c|
        (id: c[0].asString, name: c[1].asString, default: c[2] !? { |d| d.asFloat })
    };
    var order = List.new, terms = List.new, wired = Set.new, crossovers = Set.new, opening = List.new;
    (spec !? { spec["buses"] } ? Dictionary.new).keysValuesDo { |id, channels|
        var b = Bus.audio(server, channels.asInteger);
        if (b.isNil) {
            ("poptart: the server has no private audio bus left for track " ++ key ++ "'s chain - part of it "
                ++ "is silent. Raise POPTART_AUDIO_BUSES (now " ++ server.options.numAudioBusChannels ++ ")").warn;
        } {
            made[\buses].add(b);
            made[\index][id] = b.index;
        };
    };
    server.makeBundle(nil, {
        steps.do { |st|
            var kind = st["k"];
            case
            { kind == "fx" } {
                var slot = st["slot"].asInteger;
                var node = ensureFxNode.(key, track, slot);
                wired.add(slot);
                node.set(\in, busOf.(st["in"]), \out, busOf.(st["out"]));
                order.add(node);
            }
            { kind == "xover" } {
                var id = st["id"].asSymbol;
                var x = track[\xovers][id] ?? {
                    var node = Synth(trackDef[\xover].name, [], target: track[\synth], addAction: \addBefore);
                    var entry = (node: node, k: st["xo"].asInteger);
                    track[\xovers][id] = entry;
                    opening.add(entry);
                    entry
                };
                crossovers.add(id);
                x[\node].set(\in, busOf.(st["in"]), \key, busOf.(st["key"]), \out, busOf.(st["out"]),
                    \rest, busOf.(st["rest"]), \ap, busOf.(st["ap"]));
                order.add(x[\node]);
            }
            { kind == "term" } {
                var g = st["g"].asInteger;
                var gain = if (g == 0) { unityGainBus.index } { routeKrNode.(track, \gain, g)[\bus].index };
                var node = Synth(\poptart_term, [\in, busOf.(st["in"]), \out, busOf.(st["out"]), \gain, gain],
                    target: track[\synth], addAction: \addBefore);
                terms.add(node);
                order.add(node);
            };
        };
        // In the order the audio runs, each just before the strip (or the bass mono before it).
        order.do { |node| node.moveBefore(track[\bassmono] ? track[\synth]) };
        track[\chainOut] = busOf.((spec !? { spec["out"] }) ? "chain");
        (track[\bassmono] ? track[\synth]).set(\in, track[\chainOut]);
        track[\nodes].keysValuesDo { |slot, node|
            if (wired.includes(slot).not) { node.set(\in, routeNowhere, \out, routeNowhere) };
        };
        track[\xovers].keys.copy.do { |id|
            if (crossovers.includes(id).not) { track[\xovers].removeAt(id)[\node].free };
        };
        track[\terms].do(_.free);
    });
    track[\terms] = terms;
    track[\wired] = wired;
    track[\route] = made;
    // The crossovers new to this wiring: the engine's own Crossover device, its one control on
    // the track's xo<k> - so whatever drives that control (a pattern, a modulator, an expression)
    // drives the split.
    opening.do { |x|
        var ctl = \PoptartDeviceController.asClass.new(x[\node], \nslot, trackDef[\xover]);
        x[\ctl] = ctl;
        ctl.open("Crossover", params, { |self, ok|
            if (ok) { self.map(0, routeKrNode.(track, \xo, x[\k])[\bus]) } {
                ("poptart: track " ++ key ++ ": the Crossover device would not open, so its bands are silent").warn;
            };
        });
    };
    old !? { SystemClock.sched(0.2, { routeFree.(old); nil }) };
};
routeFree = { |made|
    made[\buses].do(_.free);
};

OSCdef(\poptartSetRouting, { |msg|
    var key = msg[1].asSymbol, json = msg[2].asString;
    var spec = if (json == "null") { nil } { json.parseJSON };
    fork {
        var track = awaitTrack.(key);
        if (track.isKindOf(Event)) { routeApply.(key, track, spec) };
    };
}, '/poptart/setRouting');

// Auto-pin + "conf" capture: everything we watch on a freshly opened plugin. Called once per
// successful open, for both instrument and effect slots.
//
// The auto-pin half tells Node "this slot's plugin no longer matches the code" so it can
// re-capture the state and write it back into synth("…", { state }). It takes THREE signals
// because no single one covers every plugin:
//   - parameterAutomated: a control moved in the plugin's own GUI (the common case).
//   - /vst_program_index: a program switch, for plugins that expose presets as VST programs.
//   - /vst_update: the VST "updateDisplay" host callback - what a plugin with its own preset
//     browser (Serum) fires when loading a preset changes every parameter at once without
//     touching a single VST program. Without this, picking a preset would go unnoticed.
// Node debounces, so a preset load reporting all three costs one capture. Deliberately NOT
// listening to /vst_param: that also fires for parameters *we* modulate, which would have a
// running lfo() re-capturing the state forever.
watchPluginEdits = { |track, key, slot, ctl|
    // ...and a fourth signal, the one this must NOT hear: a program we loaded into the slot
    // ourselves fires all three (see selfLoads), and capturing that back is a feedback loop.
    var ours = { selfLoading.(key, slot) };
    var notify = { if (ours.value.not) { nodeAddr.sendMsg("/poptart/pluginEdited", key, slot) } };
    ctl.parameterAutomated = { |index, value|
        // Conf mode is deaf to our own loads for the same reason: a plugin that re-announces every
        // parameter when its program changes would drop its whole panel into the code as
        // .param(...) calls, none of which anyone touched.
        if (track[\confMode] == true and: { ours.value.not }) {
            ctl.info.parameters[index] !? { |p|
                nodeAddr.sendMsg("/poptart/paramAutomated", key, slot, p.name.asString, index, value.asFloat);
            };
        };
        notify.value;
    };
    // A re-open into the same controller must not stack a second set of watchers.
    track[\editWatch][slot] !? { |funcs| funcs.do { |f| f.free } };
    track[\editWatch][slot] = ['/vst_update', '/vst_program_index'].collect { |path|
        OSCFunc(notify, path, ctl.synth.server.addr,
            argTemplate: [ctl.synth.nodeID, ctl.synthIndex]);
    };
};

// Plugin opens are SERIALIZED, engine-wide: evaluating a whole song fires its every open at
// once, and a burst of simultaneous heavyweight instantiations (each with an editor) starves
// the audio callback - with the two-deck mixer, the PLAYING deck audibly stuttered while the
// queued one loaded (2026-08-24). One instantiation in flight at a time, with a breather after
// each, spreads the same work over a couple of seconds nothing hears. The failsafe matters: a
// plugin whose open never reports back must not wedge every later load of the set.
pluginOpenLock = Semaphore(1);
openQueued = { |ctl, desc, action|
    fork {
        var done = Condition.new;
        pluginOpenLock.wait;
        try {
            ctl.open(desc, editor: true, action: { |self, ok|
                action.(self, ok);
                if (done.test.not) { done.test = true; done.signal };
            });
        } { |err|
            ("poptart: plugin open threw: " ++ err.errorString).warn;
            if (done.test.not) { done.test = true; done.signal };
        };
        fork { 30.wait; if (done.test.not) { done.test = true; done.signal } }; // stuck-open failsafe
        done.wait;
        0.05.wait; // let the audio thread breathe between instantiations
        pluginOpenLock.signal;
    };
};

OSCdef(\poptartLoadInstrument, { |msg|
    var key = msg[1].asSymbol;
    var pluginId = msg[2].asString;
    fork {
        var track = awaitTrack.(key);
        if (track.isNil) { ("poptart: loadInstrument: no track " ++ key).warn } {
            // Livecoding re-eval sends the same chain again - don't reload an already-open plugin,
            // nor one whose open is still queued (see `wanted` in loadEffect).
            slotKindGuard.(key, track, 0, true);
            if ((track[\loaded][0] != pluginId) and: { track[\wanted][0] != pluginId }) {
                var ctl = track[\controllers][0] ?? {
                    VSTPluginController(track[\head], id: \slot0, synthDef: trackDef[\head])
                };
                track[\controllers][0] = ctl;
                track[\loaded][0] = nil;
                // Marks the open in flight - what a restore waiting on this slot follows (see
                // awaitLoaded) - and, as for an effect, what the open checks before it commits.
                track[\wanted][0] = pluginId;
                tellSlot.(track, 0);
                openQueued.(ctl, resolvePlugin.(pluginId), { |self, ok|
                    if (ok) {
                        if (track[\wanted][0] == pluginId) {
                            track[\loaded][0] = pluginId;
                            tellSlot.(track, 0);
                            // Emulated DAW transport from the first sample on: a rolling transport
                            // at the current tempo (position re-syncs via '/poptart/setTempo').
                            self.setPlaying(true);
                            self.setTempo(trackTempo[key] ? currentTempo);
                            dropSlotRamps.(key, track, 0); // the open cleared their mappings (see dropRamp)
                            reassertExprs.(key, track, 0); // and so did an expression's output
                            watchPluginEdits.(track, key, 0, self);
                            ("poptart: loaded instrument " ++ pluginId).postln;
                        };
                    } {
                        track[\wanted][0] = nil;
                        ("poptart: FAILED to load instrument '" ++ pluginId ++ "' "
                            ++ if (scanning) {
                                "- the plugin scan is still running, so it may simply not have been "
                                ++ "probed yet; try again when the scan finishes"
                            } {
                                "(name must match a scanned plugin - see the plugin browser)"
                            }).warn;
                    };
                });
            };
        };
    };
}, '/poptart/loadInstrument');

OSCdef(\poptartLoadEffect, { |msg|
    var key = msg[1].asSymbol;
    var pluginId = msg[2].asString;
    var position = msg[3].asInteger; // -1 = next free slot
    fork {
        var track = awaitTrack.(key);
        if (track.isNil) { ("poptart: loadEffect: no track " ++ key).warn } {
            // -1 is the slot after the last the track has.
            var slot = if (position >= 1) { position } { (track[\nodes].keys.maxItem ? 0) + 1 };
            case
            { slot < 1 } { ("poptart: loadEffect: bad slot " ++ position).warn }
            { true } {
                // A slot that is changing kind - a plugin where one of poptart's own devices
                // was - has to be emptied before the plugin goes in (see slotKindGuard).
                slotKindGuard.(key, track, slot, true);
                if ((track[\loaded][slot] != pluginId) and: { track[\wanted][slot] != pluginId }) {
                    var ctl = track[\controllers][slot] ?? {
                        VSTPluginController(ensureFxNode.(key, track, slot), id: \slot, synthDef: trackDef[\fx])
                    };
                    track[\controllers][slot] = ctl;
                    track[\loaded][slot] = nil;
                    // `wanted` marks the open in flight: the action only commits (and un-bypasses)
                    // if the slot still wants this plugin when the open completes - an unloadEffect
                    // or a different loadEffect racing the async open must win. A failed open
                    // clears it so the next eval retries.
                    track[\wanted][slot] = pluginId;
                    tellSlot.(track, slot);
                    openQueued.(ctl, resolvePlugin.(pluginId), { |self, ok|
                        if (ok) {
                            if (track[\wanted][slot] == pluginId) {
                                track[\loaded][slot] = pluginId;
                                tellSlot.(track, slot);
                                self.setPlaying(true); // see loadInstrument
                                self.setTempo(trackTempo[key] ? currentTempo);
                                // Un-bypass the slot, on its plugin half (see the slot's `native`).
                                track[\nodes][slot] !? { |n| n.set(\active, 1, \native, 0) };
                                dropSlotRamps.(key, track, slot); // the open cleared their mappings (see dropRamp)
                                reassertExprs.(key, track, slot); // and so did an expression's output
                                watchPluginEdits.(track, key, slot, self);
                                ("poptart: loaded effect " ++ pluginId ++ " in slot " ++ slot).postln;
                            };
                        } {
                            track[\wanted][slot] = nil;
                            ("poptart: FAILED to load effect '" ++ pluginId ++ "'"
                                ++ if (scanning) {
                                    " - the plugin scan is still running, so it may simply not have "
                                    ++ "been probed yet; try again when the scan finishes"
                                } { "" }).warn;
                        };
                    });
                };
            };
        };
    };
}, '/poptart/loadEffect');

// --- poptart's own devices (native/devices/, and the same ones the browser build plays) ---
//
// A slot carries two kinds of device and exactly one of them at a time (see buildTrackDef). When
// a pattern changes `synth("Serum 2")` to `synth("Plaits")` the slot changes kind, and whatever
// was there has to go - both because two loaded devices in one slot would both sound, and
// because a controller is only good for the kind of UGen it was made against. Answers "is this
// slot already the kind we want", and empties it when it is not.
slotKindGuard = { |key, track, slot, wantPlugin|
    var ctl = track[\controllers][slot];
    if (ctl.notNil and: { ctl.isKindOf(VSTPluginController) != wantPlugin }) {
        if (slot >= 1) { track[\nodes][slot] !? { |n| n.set(\active, 0) } }; // bypass before the close
        ctl.close;
        track[\controllers][slot] = nil;
        track[\loaded][slot] = nil;
        track[\wanted][slot] = nil;
        tellSlot.(track, slot);
        dropSlotRamps.(key, track, slot);
        track[\editWatch][slot] !? { |funcs| funcs.do { |f| f.free } };
        track[\editWatch][slot] = nil;
    };
};

// Load one of poptart's own devices into a slot. Node resolves the name - it holds the catalog
// (native/devices/devices.json, generated beside the extension) and knows a device name from a
// plugin name - and sends the device's controls along with it, as id/name pairs: that list is
// everything sclang needs to turn `.param("LPG Color", 0.3)` into a parameter index, and it is
// the same two spellings the browser resolves (see PoptartDeviceDesc).
//
// `position` is 0 for the instrument slot and 1.. for an effect, or -1 for the next free one -
// the same argument loadEffect takes. Unlike a plugin open this is not serialized: the heavy
// part happens on the server's own helper thread, one allocation, with no editor to build and
// no out-of-process probe (which is what openQueued's lock exists for).
OSCdef(\poptartLoadDevice, { |msg|
    var key = msg[1].asSymbol;
    var position = msg[2].asInteger;
    var name = msg[3].asString;
    // id, name and default position per control (native-devices.js's deviceParamArgs).
    var params = msg[4..].clump(3).collect { |c| (id: c[0].asString, name: c[1].asString, default: c[2] !? { |d| d.asFloat }) };
    fork {
        var track = awaitTrack.(key);
        var slot, ctl;
        case
        { track.isNil } { ("poptart: loadDevice: no track " ++ key).warn }
        { \PoptartDevice.asClass.isNil } {
            ("poptart: '" ++ name ++ "' is one of poptart's own devices, and this engine has no "
                ++ "PoptartDevice extension installed - nothing will sound in that slot. The "
                ++ "extension ships prebuilt for macOS; on another platform it has to be built "
                ++ "there (packages/web-engine/build/devices/native.mjs)").warn;
        }
        {
            slot = if (position >= 0) { position } { (track[\nodes].keys.maxItem ? 0) + 1 };
            if (slot < 0) {
                ("poptart: loadDevice: bad slot " ++ position).warn;
            } {
                slotKindGuard.(key, track, slot, false);
                // Re-eval sends the same chain again: an already-open device stays open, and so
                // does one whose open is still in flight.
                if ((track[\loaded][slot] != name) and: { track[\wanted][slot] != name }) {
                    ctl = track[\controllers][slot] ?? {
                        if (slot == 0) {
                            \PoptartDeviceController.asClass.new(track[\head], \nslot0, trackDef[\head])
                        } {
                            \PoptartDeviceController.asClass.new(ensureFxNode.(key, track, slot), \nslot, trackDef[\fx])
                        }
                    };
                    track[\controllers][slot] = ctl;
                    track[\loaded][slot] = nil;
                    track[\wanted][slot] = name;
                    tellSlot.(track, slot);
                    ctl.open(name, params, { |self, ok|
                        if (ok and: { track[\wanted][slot] == name }) {
                            track[\loaded][slot] = name;
                            tellSlot.(track, slot);
                            // Un-bypassed on its device half, in one message so no block hears
                            // the plugin half's pass-through (see the slot's `native`).
                            if (slot >= 1) { track[\nodes][slot] !? { |n| n.set(\active, 1, \native, 1) } };
                            dropSlotRamps.(key, track, slot);
                            reassertExprs.(key, track, slot); // and so did an expression's output
                            watchPluginEdits.(track, key, slot, self);
                            // What the device has to be told rather than hear for itself: the
                            // tempo and where the transport is (a synced delay needs both before
                            // its first block), and whether anything is routed into its key
                            // input. The route may have been wired before the device opened, so
                            // this asks rather than waiting to be told.
                            self.setTempo(trackTempo[key] ? currentTempo);
                            self.setTransportPos(trackBeats.(key));
                            tellKeyPatched.(track, slot, nil, key);
                            // And anything patched onto its controls: the device starts with
                            // every control on its own default, and a route outlives the device.
                            paramRoutes.do { |e|
                                if ((e[\targetKey] == key) and: { e[\slot] == slot } and: { e[\pending].isNil }) {
                                    applyParamRoute.(track, e);
                                };
                            };
                            ("poptart: loaded device " ++ name ++ " in slot " ++ slot).postln;
                        } {
                            if (ok.not) {
                                track[\wanted][slot] = nil;
                                ("poptart: FAILED to load device '" ++ name ++ "' - the engine's "
                                    ++ "PoptartDevice extension does not have it (it is built from "
                                    ++ "the same list the browser build ships)").warn;
                            };
                        };
                    });
                };
            };
        };
    };
}, '/poptart/loadDevice');

// Commenting a .fx(...) out of a chain must actually silence it: re-bypass the slot, then
// close the plugin (close is what frees the plugin instance and its memory). The controller
// object is kept for reuse - a later loadEffect re-opens into it. No-op when the slot is
// already empty, so the scheduler can blanket-clear all trailing slots on every eval.
//
// Decided HERE, synchronously, whether there is anything to do - and there almost never is. The
// scheduler clears every slot past its chain's end on every evaluation, twenty messages a track,
// and nearly all of them land on an empty slot of a live track, or on a track still being built
// (which has no plugin anywhere: its own chain's loads are still queued behind its birth, and
// they are all INSIDE the chain). Forking a routine to find that out cost a clock-queue entry
// each, several hundred at once per evaluation of a full song, against a queue of ~680 - and a
// routine the queue refuses never runs, which is how a track's birth got lost (see
// reclaimStuckTrack). So no routine unless a slot really has something in it.
OSCdef(\poptartUnloadEffect, { |msg|
    var key = msg[1].asSymbol;
    var slot = msg[2].asInteger;
    var track = tracks[key];
    if (slot < 1) {
        ("poptart: unloadEffect: bad slot " ++ slot).warn;
    } {
        if (track.isKindOf(Event).not) {
            if (track.isNil) { ("poptart: unloadEffect: no track " ++ key).warn }; // \pending: empty, nothing to do
        } {
            // ...or a node the chain no longer runs through, which goes.
            if (track[\loaded][slot].notNil or: { track[\controllers][slot].notNil } or: { track[\wanted][slot].notNil }
                or: { track[\nodes][slot].notNil and: { (track[\wired] ? #[]).includes(slot).not } }) {
                fork {
                    var ctl = track[\controllers][slot];
                    track[\wanted][slot] = nil; // an in-flight open() must no longer commit
                    if (track[\loaded][slot].notNil or: { ctl.notNil }) {
                        track[\nodes][slot] !? { |n| n.set(\active, 0) }; // bypass before the close
                        ctl !? { ctl.close };
                        dropSlotRamps.(key, track, slot); // nothing left to drive
                        // A closed plugin can't be edited - drop its auto-pin watchers (see
                        // watchPluginEdits) so they don't outlive it or fire on a reused node id.
                        track[\editWatch][slot] !? { |funcs| funcs.do { |f| f.free } };
                        track[\editWatch][slot] = nil;
                        track[\loaded][slot] !? { |id|
                            ("poptart: unloaded effect " ++ id ++ " from slot " ++ slot).postln;
                        };
                        track[\loaded][slot] = nil;
                    };
                    // A slot the chain no longer has: its node goes too, and its controller with
                    // it (one made against a freed node would answer nothing). A slot the chain
                    // still runs through keeps its node, bypassed, so its wiring holds.
                    if ((track[\wired] ? #[]).includes(slot).not) {
                        track[\nodes].removeAt(slot) !? { |n| n.free };
                        track[\controllers].removeAt(slot);
                    };
                    tellSlot.(track, slot);
                };
            };
        };
    };
}, '/poptart/unloadEffect');

// Host-transport mirror: stores the tempo for plugins that open later and pushes tempo + song
// position (in beats, 4 per cycle) to every open plugin in one timestamped bundle. Sent by
// the host on every setbpm change and as a periodic re-sync - between syncs plugins advance
// their own transport on the audio clock, so each position correction is only a few seconds'
// worth of ppm-level clock skew (microseconds, inaudible), and position-anchored synced LFOs
// stay locked to the pattern grid indefinitely.
// --- the host clock's mirror: MIDI clock out ---
//
// Node's Transport is the one clock every scheduler reads; it reaches sclang as
// '/poptart/setTempo' (bpm, beat position at a target moment, the lead to that moment, whether
// it is running, and what just happened to it) - on every tempo change, every start/stop/phase
// move, and every 4s regardless. hostClock is that clock's sclang mirror: a TempoClock
// re-anchored by each message (a few microseconds between real changes, so a routine scheduled
// on it never drifts against the pattern grid). The plugins' emulated DAW transport was the
// first thing to hang off the message; MIDI clock out is the second.
hostClock = TempoClock(currentTempo / 60).permanent_(true);

// Re-anchor the mirror. `beats` is the transport's beat position at now + `latency` (the same
// lead note events carry), while a TempoClock's beats are its position NOW: hence the pull-back
// by tempo * latency. Only re-anchored while the transport runs - paused, Node's position is
// frozen at 0, and pulling the mirror back there every 4s would make a ticking MIDI clock
// stutter; the tempo still follows, so a stopped drum machine already shows the right bpm.
// The event is what MIDI clock's realtime messages are about: 'start' and 'rebase' make the
// tick train relocate at its next sixteenth (see clockTickerStart), 'stop' sends the stop. A
// plain tempo change or the periodic re-sync is 'sync' and needs nothing beyond the anchor.
// Where a track's transport is now, in beats: its deck's own clock, run forward from where it
// was last put (frozen while that deck is paused), or the host clock's mirror for a track that
// rides the host clock.
trackBeats = { |key|
    trackPlace[key] !? { |p|
        if (p[2]) { p[0] + ((SystemClock.seconds - p[1]) * (trackTempo[key] ? currentTempo) / 60) } { p[0] }
    } ?? { (hostClock !? { |c| c.beats }) ? 0 }
};

hostClockSync = { |bpm, beats, latency, playing, event|
    var tempo = bpm / 60;
    if ((hostClock.tempo - tempo).abs > 1e-9) { hostClock.tempo_(tempo) };
    if (playing) { hostClock.beats_(beats - (tempo * latency)) };
    clockRunning = playing;
    switch (event.asSymbol,
        \start, { clockLocate = true; clockTickerStart.() },
        \rebase, { clockLocate = true; clockTickerStart.() },
        \stop, { clockOut !? { |out| out.stop } }
    );
};

// The index (24 per beat) of the first tick whose sounding moment is after now + lead: the
// earliest one a send timestamped `lead` beats ahead can still hit. The epsilon keeps a routine
// waking exactly at its own send moment (beats + lead == k/24, bar float noise) off the tick it
// just sent.
clockNextTick = { |beats, lead|
    (((beats + lead) * 24) + 1e-6).floor.asInteger + 1
};

clockTickerStop = {
    clockTicker !? { |r| r.stop };
    clockTicker = nil;
};

// One routine on the mirror clock sends the ticks. Each is timestamped clockOutLatency ahead
// (MIDIOut's latency: CoreMIDI delivers it on its own clock, so the jitter is the driver's, not
// sclang's), which is why the routine wakes that much before each tick's beat. A pending locate
// lands on the next sixteenth (every 6th tick): stop, song position, continue, tick - back to
// back, so a sequencer relocates with no gap, and the first tick after the continue is the
// sixteenth itself, as the spec has it. From the very top (tick 0) a plain start says the same
// thing to gear that ignores song position. Ticks flow whether or not the transport runs: a
// stopped sequencer still wants the tempo, and a start then is a locate, not a restart.
clockTickerStart = {
    clockTickerStop.();
    if (clockOut.notNil) {
        clockTicker = Routine {
            loop {
                var lead = clockOutLatency * hostClock.tempo;
                var k = clockNextTick.(hostClock.beats, lead);
                ((k / 24) - lead - hostClock.beats).max(0).wait;
                if (clockLocate and: { clockRunning } and: { k >= 0 } and: { (k % 6) == 0 }) {
                    clockLocate = false;
                    clockOut.stop;
                    if (k == 0) { clockOut.start } { clockOut.songPtr((k div: 6) % 16384); clockOut.continue };
                };
                clockOut.midiClock;
            };
        }.play(hostClock);
    };
};

midiDestName = { |d| d.device.asString ++ " " ++ d.name.asString };

// Point MIDI clock out at a destination ("" = off): the same case-insensitive substring match as
// midicc()'s sources, against CoreMIDI's "<device> <port>" names. Answers the matched name (nil
// when nothing matched, or off). A running transport relocates the sequencer at the next
// sixteenth, so a destination picked mid-performance comes in on the bar.
midiClockSet = { |name|
    var p = name.asString.toLower, dest;
    var find = { MIDIClient.destinations.detect { |d| midiDestName.(d).toLower.contains(p) } };
    clockTickerStop.();
    clockOut = nil;
    clockOutName = nil;
    if (p.size > 0) {
        midiEnable.();
        dest = find.value;
        if (dest.isNil) { MIDIClient.list; dest = find.value }; // plugged in since the client came up
        dest !? {
            clockOut = MIDIOut(0, dest.uid).latency_(clockOutLatency);
            clockOutName = midiDestName.(dest);
            clockLocate = true;
            clockTickerStart.();
            ("poptart: MIDI clock out to " ++ clockOutName).postln;
        };
    } {
        "poptart: MIDI clock out off".postln;
    };
    clockOutName;
};

OSCdef(\poptartMidiClockOut, { |msg|
    var requestId = msg[1], name = msg[2].asString;
    var active = midiClockSet.(name);
    if (name.size > 0 and: { active.isNil }) {
        replyErr.("/poptart/midiClockOut", requestId, "no MIDI destination matching '" ++ name ++ "' - connected: "
            ++ MIDIClient.destinations.collect({ |d| midiDestName.(d) }).join(", "));
    } {
        replyOk.("/poptart/midiClockOut", requestId, toJson.((active: active)));
    };
}, '/poptart/midiClockOut');

// --- the desk's talk-back port (see the feedbackOut declaration) ---
//
// Point it at a destination ("" = off), by the same case-insensitive substring match the clock's
// uses. Answers the matched name, or nil when nothing matched.
midiFeedbackSet = { |name|
    var p = name.asString.toLower, dest;
    var find = { MIDIClient.destinations.detect { |d| midiDestName.(d).toLower.contains(p) } };
    feedbackOut = nil;
    feedbackOutName = nil;
    if (p.size > 0) {
        midiEnable.();
        dest = find.value;
        if (dest.isNil) { MIDIClient.list; dest = find.value }; // plugged in since the client came up
        dest !? {
            feedbackOut = MIDIOut(0, dest.uid).latency_(0);
            feedbackOutName = midiDestName.(dest);
            ("poptart: MIDI feedback to " ++ feedbackOutName).postln;
        };
    } {
        "poptart: MIDI feedback off".postln;
    };
    feedbackOutName;
};

OSCdef(\poptartMidiFeedback, { |msg|
    var requestId = msg[1], name = msg[2].asString;
    var active = midiFeedbackSet.(name);
    if (name.size > 0 and: { active.isNil }) {
        replyErr.("/poptart/midiFeedback", requestId, "no MIDI destination matching '" ++ name ++ "' - connected: "
            ++ MIDIClient.destinations.collect({ |d| midiDestName.(d) }).join(", "));
    } {
        replyOk.("/poptart/midiFeedback", requestId, toJson.((active: active)));
    };
}, '/poptart/midiFeedback');

// Short messages to that port, as flat quadruples [kind, channel, num, value, ...]: kind 0 is a
// control change, 1 a note. Batched because the things that send them send several at once (two
// decks' meters off one reading), and silently nothing with no port chosen - the desk calls this
// on every frame whether or not anybody is listening.
OSCdef(\poptartMidiOut, { |msg|
    feedbackOut !? { |out|
        (1, 5 .. msg.size - 4).do { |i|
            var kind = msg[i].asInteger, chan = msg[i + 1].asInteger;
            var num = msg[i + 2].asInteger.clip(0, 127), val = msg[i + 3].asInteger.clip(0, 127);
            if (kind == 1) { out.noteOn(chan, num, val) } { out.control(chan, num, val) };
        };
    };
}, '/poptart/midiOut');

OSCdef(\poptartGetMidiDestinations, { |msg|
    var requestId = msg[1];
    midiEnable.();
    MIDIClient.list; // re-read, so gear plugged in since the first init is offered too
    replyOk.("/poptart/getMidiDestinations", requestId,
        toJson.(MIDIClient.destinations.collect { |d| midiDestName.(d) }));
}, '/poptart/getMidiDestinations');

OSCdef(\poptartSetTempo, { |msg|
    var bpm = msg[1].asFloat, beats = msg[2].asFloat, latency = msg[3].asFloat;
    var playing = if (msg.size > 4) { msg[4].asInteger > 0 } { true };
    var event = if (msg.size > 5) { msg[5].asSymbol } { \sync };
    // A deck on a clock of its own: \except is the host clock with the listed tracks left out,
    // \only another clock's tempo and place for the listed tracks alone - which is not the host
    // clock, so the mirror MIDI clock ticks from is not touched by it. Symbols, since that is
    // what the tracks are keyed by and includes() tests identity.
    var scope = if (msg.size > 6) { msg[6].asSymbol } { \all };
    var listed = if (msg.size > 7) { msg.copyToEnd(7).collect(_.asSymbol) } { [] };
    if (scope == \only) {
        listed.do { |key|
            trackTempo[key] = bpm;
            trackPlace[key] = [beats, SystemClock.seconds + latency, playing];
        };
    } {
        currentTempo = bpm;
        trackTempo.keys.do { |key|
            if (listed.includes(key).not) { trackTempo.removeAt(key); trackPlace.removeAt(key) };
        };
        hostClockSync.(bpm, beats, latency, playing, event);
    };
    bundleNow.(latency, {
        tracks.keysValuesDo { |key, track|
            if (track.isKindOf(Event) and: { (scope == \all) or: { listed.includes(key) == (scope == \only) } }) {
                track[\loaded].keysValuesDo { |i, id|
                    if (id.notNil) {
                        track[\controllers][i] !? { |ctl|
                            ctl.setTempo(bpm);
                            ctl.setTransportPos(beats);
                        };
                    };
                };
            };
        };
    });
}, '/poptart/setTempo');

// --- events (latency = seconds from now, computed by OscEngine against its own clock; ---
// --- makeBundle turns it into a timestamped OSC bundle scsynth executes sample-accurately) ---

// makeBundle, but timestamped only when there is real lead. A latency of ~0 means "now", and a
// bundle stamped "now" is already in the past by transit + a hardware block by the time the
// audio thread compares clocks - scsynth applies it immediately either way, but prints a
// `late 0.01x` line for every one. The desk streams latency-0 setParams at 20+/sec while
// mixing, so that was a console full of them. nil skips the stamp: same immediate application,
// nothing to complain about; anything with real lead keeps its sample-accurate timestamp.
bundleNow = { |latency, func|
    server.makeBundle(if (latency.notNil and: { latency > 0.001 }) { latency } { nil }, func);
};

// --- the ids Node's direct path plays with (osc-engine/direct.js) -----------------------------
//
// Node sends notes, sample voices and polled values straight to scsynth, so it needs the ids
// this side makes. They are told here as they change; Node never guesses one, and sends anything
// it has no id for through the handlers below as before.
// One closure, evaluated here: the top-level function is at sclang's selector-table limit.
{
tellTrack = { |track|
    nodeAddr.sendMsg("/poptart/ids/track", track[\key], track[\group].nodeID, (track[\voices] ? track[\group]).nodeID,
        track[\inBus].index, track[\bendBus].index, track[\head].nodeID);
    tellSlot.(track, 0);
    tellMods.(track);
};
tellSlot = { |track, slot|
    var ctl = track[\controllers][slot];
    var node = (ctl !? { ctl.synth }) ? slotNode.(track, slot);
    track[\key] !? { |key|
        nodeAddr.sendMsg("/poptart/ids/slot", key, slot, if (ctl.notNil) { 1 } { 0 },
            if (track[\loaded][slot].notNil) { 1 } { 0 }, node !? { node.nodeID } ? -1,
            (ctl !? { ctl.synthIndex }) ? -1,
            if (ctl.notNil and: { ctl.midi.class.name == \PoptartDeviceMIDIProxy }) { 1 } { 0 });
    };
};
// Every env and every lfo, between a begin and an end so Node swaps the whole set at once, and
// then whether a drawn shape's swap waits on the next note (which Node leaves to noteOn here).
tellMods = { |track|
    track[\key] !? { |key|
        nodeAddr.sendMsg("/poptart/ids/modsBegin", key);
        track[\envs].keysValuesDo { |k, e| e[\synth] !? { |sy| nodeAddr.sendMsg("/poptart/ids/mod", key, k, sy.nodeID, 0) } };
        track[\lfos].keysValuesDo { |k, e|
            var kind = case
                { e[\shape] != \custom } { 1 }
                { e[\mode] == \retrigger } { 3 }
                { e[\mode] == \envelope } { 4 }
                { 2 };
            e[\synth] !? { |sy| nodeAddr.sendMsg("/poptart/ids/mod", key, k, sy.nodeID, kind) };
        };
        nodeAddr.sendMsg("/poptart/ids/modsEnd", key);
        nodeAddr.sendMsg("/poptart/ids/swap", key, shapesHandled[key] ? 0,
            if (track[\lfos].any { |e| e[\pending].notNil }) { 1 } { 0 });
    };
};
// A channel control coming to rest is the one value Node must not send itself: the ramp's drop is
// scheduled on it (see poptartSetParam), and has to see whatever comes after. nil synth = gone.
tellRamp = { |track, rampKey, slot, synth, value|
    track[\key] !? { |key|
        if (synth.isNil) {
            nodeAddr.sendMsg("/poptart/ids/ramp", key, rampKey, 0, 0, 0);
        } {
            var rest = if (slot == -1) {
                channelDefault.(rampKey.asString.copyToEnd(("slot" ++ slot ++ "_").size))
            };
            var direct = if (rest.isNumber and: { value == rest }) { 0 } { 1 };
            nodeAddr.sendMsg("/poptart/ids/ramp", key, rampKey, synth.nodeID, slot, direct, *(if (rest.isNumber) { [rest] } { [] }));
        };
    };
};
tellTap = { |track, name, node|
    track[\key] !? { |key| nodeAddr.sendMsg("/poptart/ids/tap", key, name, node !? { node.nodeID } ? 0) };
};
// A held-count change this side made itself (a note through its own handlers, a MIDI keyboard):
// Node's count follows. Node's own changes arrive as /poptart/direct/* and are not told back.
heldBy = { |track, delta|
    var before = track[\held];
    track[\held] = max(0, before + delta);
    if (track[\held] != before) { track[\key] !? { |key| nodeAddr.sendMsg("/poptart/ids/held", key, track[\held] - before) } };
};

// What Node played itself, for the books this side still keeps: the held count (modulators born
// later read it), what a hush must release (markSounding) and the voice ceiling (voiceBorn).
// None of these carry timing - the sound has already gone to the server.
OSCdef(\poptartDirectNote, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, note = msg[3].asFloat, offLat = msg[4].asFloat;
    var track = tracks[key];
    if (track.isKindOf(Event)) {
        if (offLat < 0) {
            if (slot == 0) { track[\held] = track[\held] + 1 };
            markSounding.(track, slot, note, inf);
        } {
            if (slot == 0) { track[\held] = max(0, track[\held] - 1) };
            markSounding.(track, slot, note, Main.elapsedTime + offLat);
        };
    };
}, '/poptart/direct/note');

OSCdef(\poptartDirectVoice, { |msg|
    var key = msg[1].asSymbol, id = msg[2].asInteger, def = msg[3].asSymbol, doneLat = msg[4].asFloat;
    var track = tracks[key];
    var synth = Synth.basicNew(def, server, id);
    voiceBorn.(synth); // ...which releases the oldest past the ceiling, as for a voice made here
    if (track.isKindOf(Event)) { track[\held] = track[\held] + 1 };
    SystemClock.sched(doneLat, { voiceDone.(synth); nil });
}, '/poptart/direct/voice');

OSCdef(\poptartDirectHeld, { |msg|
    var track = tracks[msg[1].asSymbol];
    if (track.isKindOf(Event)) { track[\held] = max(0, track[\held] + msg[2].asInteger) };
}, '/poptart/direct/held');

// A deck player Node spawned: this side keeps it for songLoad/songFree and forwards its position.
OSCdef(\poptartDirectSong, { |msg|
    var key = msg[1].asSymbol, id = msg[2].asInteger, def = msg[3].asSymbol, spawnLat = msg[4].asFloat;
    songs[key] !? { |song|
        song[\posFunc] !? { |f| f.free };
        song[\synth] = Synth.basicNew(def, server, id);
        song[\spawnUntil] = Main.elapsedTime + spawnLat;
        song[\posFunc] = OSCFunc({ |m|
            nodeAddr.sendMsg('/poptart/songPos', key, m[3].asFloat);
        }, '/poptart/songPos', server.addr, argTemplate: [id]);
    };
}, '/poptart/direct/song');

OSCdef(\poptartDirectSongStop, { |msg|
    var key = msg[1].asSymbol, id = msg[2].asInteger;
    songs[key] !? { |song|
        if (song[\synth].notNil and: { song[\synth].nodeID == id }) {
            song[\synth] = nil;
            song[\posFunc] !? { |f| f.free };
            song[\posFunc] = nil;
        };
    };
}, '/poptart/direct/songStop');

// scsynth answers a failed command to whoever sent it; Node passes on the ones it sent, so the
// repair below (poptartServerFail) hears them as if this side had sent them.
OSCdef(\poptartServerFailRelay, { |msg|
    OSCdef.all[\poptartServerFail] !? { |d| d.func.value(msg) };
}, '/poptart/fail');
}.value;

// Which notes a slot's plugin has sounding, as note -> the time its note-off lands (inf until one
// is known). Times, not a set that an off empties: the scheduler sends a note's on and its off
// together, a lookahead before either happens, so at any moment the messages HANDLED say nothing
// about what is ringing - only when each note ends does. This is what a hush releases by name
// (see hushTrack); entries whose end has passed are dropped as new ones arrive.
markSounding = { |track, slot, note, offAt|
    track[\sounding] !? { |slots|
        // Made and filed first: an assignment answers the dictionary it was made in, not the
        // value, so `slots[slot] = x` cannot stand in for x here.
        if (slots[slot].isNil) { slots[slot] = IdentityDictionary.new };
        slots[slot] !? { |notes|
            var now = Main.elapsedTime;
            notes.keys.do { |n| if (notes[n] < now) { notes.removeAt(n) } };
            notes[note] = offAt;
        };
    };
};

// The note an instrument slot is handed. Notes arrive as written - 62.4 is a quarter-tone and a
// bit above d3 - and poptart's own devices play them exactly; a plugin takes MIDI, so it gets the
// nearest key. Every note-on, note-off and hush below goes through this, so an off always names
// the same key its on did.
noteKey = { |ctl, note|
    if (ctl.midi.class.name == \PoptartDeviceMIDIProxy) { note.asFloat } { note.round.asInteger }
};

// Note events also gate any env modulators on the track (in the same timestamped bundle, so
// envelope attacks line up sample-accurately with their notes). The gate follows a held-note
// count: opens on the first held note, closes (release phase) when the last one ends. The
// count is updated at message-receive time while the gate change executes at the bundled
// target time - correct as long as events arrive in onset order (they do: the scheduler walks
// steps in order), with one known imperfection: for *overlapping different-length* notes the
// release can start at the first note's end. Fine for the arps/chords this is built for.
OSCdef(\poptartNoteOn, { |msg|
    var key = msg[1].asSymbol, note = msg[2].asFloat;
    var veloc = msg[3].asFloat, latency = msg[4].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    var fire;
    if (ctl.notNil) {
        fire = { |lat|
            bundleNow.(lat, {
                if (slotLive.(track, 0)) { ctl.midi.noteOn(0, noteKey.(ctl, note), (veloc * 127).round.asInteger) };
                track[\envs].do { |e| e[\synth].set(\gate, 1, \t_retrig, 1) };
                // note-synced lfo() shapes: reset/replay on every note onset - and this is where a
                // patterned shape's swap actually happens in those modes, just before the trigger, so
                // the note gets the new shape from its beginning rather than halfway through the old.
                track[\lfos].do { |e|
                    e[\pending] !? { |f| e[\pending] = nil; f.value };
                    if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
                };
            });
        };
        heldBy.(track, 1);
        markSounding.(track, 0, note, inf);
        // A swap due at or before this note's onset means the plugin will be mid-load when it would
        // have sounded, so it waits for the program instead (see waitForLoad) - the note at a
        // `.preset("<a b>")` boundary is the one that used to be eaten.
        if (waitForLoad.(key, 0, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOn');

OSCdef(\poptartNoteOff, { |msg|
    var key = msg[1].asSymbol, note = msg[2].asFloat, latency = msg[3].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    var fire;
    if (ctl.notNil) {
        fire = { |lat|
            bundleNow.(lat, {
                if (slotLive.(track, 0)) { ctl.midi.noteOff(0, noteKey.(ctl, note), 0) };
                if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
            });
        };
        heldBy.(track, -1);
        markSounding.(track, 0, note, Main.elapsedTime + latency);
        // Queued behind its own note-on when one is waiting, or the note would never be released.
        if (waitForLoad.(key, 0, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOff');

// --- hush: release everything a track is sounding, now ---
// Sent by the host when a stopped track is played again. The stop itself lets everything ring
// out - the scheduler sends nothing more, but every event already sent carries its own gate-off
// and plays on to it, and that is a feature: long notes and top loops running on after the stop,
// a show's last notes. What must not happen is the restart playing the top of the bar over the
// old copy's middle (a quick stop/start's doubled, out-of-time drums), so the play hushes first.
// The sample voices sit in a group of their own (see createTrack), so one gate-off releases them
// all at their own release floor; each plugin has the notes it still has sounding released by
// name (see markSounding), with MIDI all-notes-off behind that as a net for a VST2 plugin only -
// VST3 has no such message (see clearMidiRoute), so there it released nothing and logged a
// warning; the env modulators' gate closes as it does when the last note ends. Notes still
// waiting on a program load (see waitForLoad) are dropped - they were due before the stop, and a
// note-off dropped there is one of the notes released here. `again` repeats the release that many
// seconds on, for a caller hushing while events are still in flight (sent a lookahead early, they
// are already the server's and spawn AFTER the first release) - on the same track object only,
// since by then the key may belong to a track built afresh (a label removed and re-added).
hushTrack = { |key, again|
    var track = tracks[key];
    var release = { |t, notes|
        bundleNow.(nil, {
            t[\voices] !? { |g| g.set(\gate, 0) };
            t[\controllers].keysValuesDo { |slot, ctl|
                // Only a slot with a plugin in it: a controller kept for reuse after its plugin
                // closed, or one whose open failed, would answer each of these with a warning.
                if (ctl.notNil and: { slotLive.(t, slot) }) {
                    notes[slot].do { |note| ctl.midi.noteOff(0, noteKey.(ctl, note), 0) };
                    if (ctl.info.notNil and: { ctl.info.sdkVersion.asString.find("VST 3").isNil }) {
                        ctl.midi.allNotesOff(0);
                    };
                };
            };
            t[\envs].do { |e| e[\synth].set(\gate, 0) };
        });
        t[\held] = 0;
        // Every slot's queue the track has, whichever slots those are.
        noteQueues.keys.copy.do { |k|
            var str = k.asString, head = key.asString ++ "_", rest = str.copyToEnd(head.size);
            if (str.beginsWith(head) and: { rest.notEmpty } and: { rest.every(_.isDecDigit) }) { noteQueues[k] = nil };
        };
    };
    if (track.isKindOf(Event)) {
        // Everything whose end is still to come: ringing now, or sent a lookahead early and not
        // begun. Read once - the repeat releases the same notes, which by then have all begun.
        var now = Main.elapsedTime;
        var notes = IdentityDictionary.new;
        (track[\sounding] ? ()).keysValuesDo { |slot, slotNotes|
            notes[slot] = slotNotes.select { |offAt| offAt > now }.keys.asArray;
            slotNotes.clear;
        };
        release.(track, notes);
        if (again > 0) {
            SystemClock.sched(again, { if (tracks[key] === track) { release.(track, notes) }; nil });
        };
    };
};

OSCdef(\poptartHush, { |msg|
    hushTrack.(msg[1].asSymbol, (msg[2] ? 0).asFloat);
}, '/poptart/hush');

// MIDI to a specific plugin in the chain (Sig#trig / '/poptart/noteOnSlot'): a side channel to
// one slot's plugin, so - unlike the instrument noteOn above - it does NOT touch the track's
// held-note count or gate its env()/lfo() modulators (those follow the track's own voice, which
// this stream isn't). Slot 0 is the instrument, 1..n the effects. A note-off matches the same
// slot + pitch, so a ducker sees a gate exactly as long as the triggering step.
OSCdef(\poptartNoteOnSlot, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, note = msg[3].asFloat;
    var veloc = msg[4].asFloat, latency = msg[5].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) {
        var fire = { |lat| bundleNow.(lat, { if (slotLive.(track, slot)) { ctl.midi.noteOn(0, noteKey.(ctl, note), (veloc * 127).round.asInteger.clip(1, 127)) } }) };
        markSounding.(track, slot, note, inf);
        if (waitForLoad.(key, slot, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOnSlot');

OSCdef(\poptartNoteOffSlot, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, note = msg[3].asFloat, latency = msg[4].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) {
        var fire = { |lat| bundleNow.(lat, { if (slotLive.(track, slot)) { ctl.midi.noteOff(0, noteKey.(ctl, note), 0) } }) };
        markSounding.(track, slot, note, Main.elapsedTime + latency);
        if (waitForLoad.(key, slot, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOffSlot');

// A polled control writes through a ramp synth on a control bus of its own, mapped onto the
// parameter (or the track synth's control input, or an expression's input) as a native
// modulator's bus is - see the poptart_ramp SynthDef. The first value creates the ramp, born AT
// that value so nothing glides in from zero; every later one just moves its target. `target` is
// a paramTarget.
rampTo = { |track, rampKey, slot, target, value|
    var r = track[\ramps][rampKey];
    if (r.isNil) {
        var bus = Bus.control(server, 1);
        var syn = Synth(\poptart_ramp, [\out, bus, \target, value], target: track[\group], addAction: \addToHead);
        nodeOwns.(syn.nodeID, "a polled control (" ++ rampKey ++ ")");
        target[\map].(bus);
        track[\ramps][rampKey] = (synth: syn, bus: bus, index: target[\index], slot: slot, target: value);
        tellRamp.(track, rampKey, slot, syn, value);
    } {
        r[\target] = value;
        // The plugin in this slot may have been swapped for one where the name is a different
        // index: follow it. (An open also clears the UGen's mappings - see dropSlotRamps.)
        if (target[\index] != r[\index]) { r[\index] = target[\index]; target[\map].(r[\bus]) };
        r[\synth].set(\target, value);
        tellRamp.(track, rampKey, slot, r[\synth], value);
    };
};

// A ramp's control passing to a native modulator (whose map replaces the ramp's, leaving it
// writing a bus nothing reads), or its plugin re-opening under it (the open cleared the UGen's
// mappings, and the new instance may not even have the parameter): the ramp goes, deferred like
// any dropped modulator since the values already sent to it are timestamped ahead, and the poll
// makes a fresh one if the control is still polled.
dropRamp = { |key, track, rampKey|
    track[\ramps][rampKey] !? { |r|
        track[\ramps].removeAt(rampKey);
        tellRamp.(track, rampKey, nil, nil, nil);
        freeModulatorLater.(key, track[\group], r[\synth], r[\bus]);
    };
};
dropSlotRamps = { |key, track, slot|
    track[\ramps].keys.copy.do { |k| if (track[\ramps][k][\slot] == slot) { dropRamp.(key, track, k) } };
};

// --- a node the server does not have ----------------------------------------------------------
//
// scsynth ANSWERS a command it could not carry out, with /fail - the same message it prints as
// "FAILURE IN SERVER". Nothing listened, and for most commands that is fine: a note aimed at a
// track that has just gone is a one-off, and the message is the diagnosis.
//
// One of them repeats forever. A polled control re-sends its value every poll interval and
// `rampTo` moves the SAME ramp synth each time (creating one only when it has none), so a ramp
// node that is not on the server turns into ~33 failed writes a second, for as long as the track
// lives, with the parameter frozen wherever the bus was left - and in silence. One session had
// 8576 of them on one node across 4.4 minutes, ending with the failed /n_free at teardown that
// is the only sign anything was ever wrong (found 2026-10-05, from the desktop log).
//
// So the server is taken at its word. The entry that pointed at that node is dropped, which is
// all the repair needed: the next poll finds the key empty and builds a fresh ramp and bus, and
// re-maps the parameter onto it (see rampTo). One control bus is orphaned per incident - the
// parameter is still mapped to it until the new map lands, so freeing it here could hand its
// index to somebody else mid-write, and a leaked bus is the cheaper of the two.
nodeGoneSaid = IdentitySet.new;

// What poptart made a node FOR, by node id - so a failure can say which track it belonged to even
// after that track is gone, which is the case that matters: the interesting failures happen around
// a teardown, and by the time one is reported the entry that would explain it has been removed.
// Without this a failure is a bare number that appears nowhere else in the log (`Node 7961` did
// not, across 747KB), and there is nothing to go on at all.
// --- the sampler's voice ceiling --------------------------------------------------------------
//
// Every sample event is a NEW synth (see poptartPlaySample), and nothing bounded how many could be
// alive at once. That makes it the one thing in poptart that allocates without limit, and what it
// spends is the server's real-time memory - which, run out, stops scsynth creating ANYTHING at all
// for the rest of the session (see memSize, and the out-of-room report below). A dense enough
// moment could therefore take the engine down and keep it down.
//
// So there is a ceiling, and past it the OLDEST voice is released early to make room - which is
// what a hardware sampler does when you run it out of polyphony. The failure becomes "a moment
// that was too dense lost its tail" instead of "the drums stopped for the rest of the night".
//
// Set far above any musical number on purpose. At a few KB of real-time memory apiece this is
// single-digit megabytes of the 256 the server is given, so it is a guard on the server and never
// the thing that shapes a pattern: a set that hits it is one that was going to fall over.
liveVoices = List.new;
voiceBorn = { |synth|
    if (liveVoices.size >= maxVoices) {
        liveVoices.removeAt(0) !? { |oldest| oldest.set(\gate, 0) };
        // Worth saying - it means a pattern is denser than the engine can hold - but not once per
        // voice: at the ceiling this happens as often as notes do.
        if (Main.elapsedTime - voiceCapSaidAt > 10) {
            voiceCapSaidAt = Main.elapsedTime;
            ("poptart: " ++ maxVoices ++ " sample voices are already sounding - releasing the oldest "
                ++ "to make room. The pattern is denser than the engine can hold; this protects the "
                ++ "server, which cannot recover if it runs out of room").warn;
        };
    };
    liveVoices.add(synth);
};
// A voice that ended on its own. Its node outlives this by its release tail, so the count runs a
// little low - which is the safe direction for a ceiling.
voiceDone = { |synth| liveVoices.remove(synth) };

nodeOwners = IdentityDictionary.new; // nodeID -> what it was made for
nodeOwns = { |nodeID, what|
    if (nodeOwners.size > 4000) { nodeOwners = IdentityDictionary.new }; // bounded over a long set
    nodeOwners[nodeID] = what;
};
// Node ids the server has said it does not have. Read by slotLive, so the SECOND doomed write to
// a dead plugin is never sent.
deadNodes = IdentitySet.new;

/**
 * A command that failed on a node, for the commands that do NOT repeat - a plugin write (/u_cmd,
 * which is a UGen command and in poptart always VSTPlugin) and a synth created into a group that
 * had already gone (/s_new). Neither can be repaired: the event it carried is already late, and
 * the group it wanted no longer exists.
 *
 * What they CAN do is say whose they were, once. A bounded burst of these is expected and
 * documented - the scheduler sends up to a lookahead ahead in timestamped bundles, so a track or
 * a slot going away leaves everything already queued for it to arrive and fail - but expected or
 * not, N bare node numbers is noise, and noise is what let 8576 real failures pass unnoticed.
 */
/**
 * A command that failed because the SERVER RAN OUT OF SOMETHING, rather than because one node was
 * missing. This is the only failure in this family that stops poptart making sound at all, and it
 * is the one that was hardest to see: the reason carries no node number, so everything above this
 * ignored it.
 *
 * Out of real-time memory, every /s_new fails - so no note plays, no plugin opens, no voice
 * sounds - and it does not recover, because nothing gives the memory back. Worse, each failed
 * creation still CONSUMED a node id, and poptart goes on writing to those ids for the life of
 * whatever holds them. That is where 8576 failed writes to one node came from.
 *
 * So it is said once per reason and said plainly, because the only answer is a restart.
 */
outOfRoomPhrases = ["out of real time memory", "too many nodes", "exceeded number of interconnect buffers",
    "alloc failed", "too many buffers"];
outOfRoomSaid = IdentitySet.new;
outOfRoom = { |cmd, reason|
    var key = reason.asSymbol;
    if (outOfRoomSaid.includes(key).not) {
        outOfRoomSaid.add(key);
        ("poptart: THE AUDIO SERVER IS OUT OF ROOM - " ++ reason ++ " (" ++ cmd ++ " failed). "
            ++ "Nothing new can be created from here: notes stop playing and plugins stop opening, "
            ++ "and it does not recover on its own. Restart the engine. If this happens again, the "
            ++ "server's allocation needs raising (see server.options.memSize / maxNodes).").warn;
    };
};

nodeMissing = { |cmd, nodeID|
    if (nodeID.notNil and: { nodeGoneSaid.includes(nodeID).not }) {
        nodeGoneSaid.add(nodeID);
        deadNodes.add(nodeID);
        nodeAddr.sendMsg("/poptart/ids/dead", nodeID);
        if (deadNodes.size > 4000) { deadNodes = IdentitySet.new };
        ("poptart: the server has no node " ++ nodeID ++ " ("
            ++ (nodeOwners[nodeID] ? "nothing poptart has a record of") ++ ") - "
            ++ cmd ++ " could not be delivered; anything else already in flight for it is dropped").warn;
    };
};

nodeGone = { |nodeID|
    var fixed = false;
    if (nodeID.notNil) {
        tracks.keysValuesDo { |key, track|
            if (track.isKindOf(Event)) {
                track[\ramps].keys.copy.do { |k|
                    var r = track[\ramps][k];
                    if (r.notNil and: { r[\synth].notNil } and: { r[\synth].nodeID == nodeID }) {
                        track[\ramps].removeAt(k);
                        tellRamp.(track, k, nil, nil, nil);
                        fixed = true;
                        ("poptart: " ++ key ++ "'s polled control " ++ k ++ " was writing to node "
                            ++ nodeID ++ ", which the server does not have - rebuilding it").warn;
                    };
                };
            };
        };
        // Anything else: said ONCE per node, because the point is that this stopped being
        // invisible, and a storm of identical lines is its own kind of invisible.
        if (fixed.not and: { nodeGoneSaid.includes(nodeID).not }) {
            nodeGoneSaid.add(nodeID);
            ("poptart: the server has no node " ++ nodeID ++ " - something is writing to a node "
                ++ "that is gone (this is said once per node)").warn;
        };
    };
};

// The node id out of a `/fail <command> <reason> [...]` reply, or nil. It is in the reason text
// ("Node 7961 not found") on every scsynth that reports one, and may also arrive as an argument
// of its own - both are read, so this does not depend on which.
nodeFailId = { |msg|
    var id = nil;
    msg.copyRange(2, msg.size - 1).do { |a|
        if (id.isNil) {
            if (a.isNumber) { id = a.asInteger } {
                a.asString.findRegexp("[0-9]+").do { |found|
                    if (id.isNil) { id = found[1].asInteger };
                };
            };
        };
    };
    id;
};

// The /n_set family REPEATS - a polled control's writer is back in 30ms - so those are REPAIRED.
// A plugin write (/u_cmd) and a synth creation (/s_new) happen once and cannot be: the event is
// already late and the group it wanted is already gone. Those are ATTRIBUTED instead, and the node
// is remembered so nothing else still in flight for it is sent. A failed /n_free needs neither -
// it is the teardown saying the node had gone already, which is the whole message.
OSCdef(\poptartServerFail, { |msg|
    // SYMBOLS, not Strings, and that is not cosmetic. A /fail reply arrives as all symbols
    // ('/fail', '/n_set', 'Node 2422 not found'), and Collection:includes compares by IDENTITY -
    // so `#["/n_set"].includes("/n_set")` is FALSE, two equal Strings being two different
    // objects. Spelled with Strings, the dispatch below matched nothing and the entire repair did
    // nothing, in silence, through 14,222 failures on one set - the storm it was written to stop
    // (found 2026-10-05, by lifting this OSCdef into a real server: see
    // server-fail-reply-sclang.test.js, which now holds it to working). Symbols are interned, so
    // identity IS the right comparison for them; `includesEqual` would be the other way out.
    var cmd = msg[1].asSymbol;
    var reason = msg[2].asString;
    // Running out of room is checked FIRST and on every command: it is the one failure that is
    // about the server rather than about a node, it carries no node number to go looking for, and
    // it makes every other failure in the log a consequence rather than a cause.
    var room = outOfRoomPhrases.detect { |phrase| reason.containsi(phrase) };
    if (room.notNil) {
        outOfRoom.(cmd, reason);
    } {
        if (#['/n_set', '/n_setn', '/n_map', '/n_mapn'].includes(cmd)) {
            nodeGone.(nodeFailId.(msg));
        } {
            if (#['/u_cmd', '/s_new'].includes(cmd)) { nodeMissing.(cmd, nodeFailId.(msg)) };
        };
    };
}, '/fail', server.addr);

OSCdef(\poptartSetParam, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger;
    var paramName = msg[3].asString, value = msg[4].asFloat, latency = msg[5].asFloat;
    var track = tracks[key];
    var rampKey;
    if (track.isKindOf(Event)) {
        rampKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
        case
        { exprLeaf.(paramName).notNil } {
            // An expression's input takes any number - it is a term in the sum, not a position.
            bundleNow.(latency, { rampTo.(track, rampKey, slot, paramTarget.(track, slot, paramName), value) });
        }
        { slot == -1 } {
            // Channel controls (gain/pan) live on the track synth itself, not a plugin. Not
            // clipped to 0..1 - gain may exceed unity, pan is -1..1 (the SynthDef clips sanely).
            // The selectors among them (which stereo pair, the cue switch) are set outright: a
            // ramp passing through 1.5 is neither pair.
            if (steppedChannelControls.includes(paramName.asSymbol)) {
                bundleNow.(latency, { paramTarget.(track, -1, paramName)[\set].(value) });
            } {
                bundleNow.(latency, { rampTo.(track, rampKey, -1, paramTarget.(track, -1, paramName), value) });
                // Back at rest - the pattern let go of the control, or set it there: once the glide
                // is over, the ramp goes and the control is simply set, so a control polled once
                // in a set does not hold a synth and a bus for the rest of it.
                if (value == channelDefault.(paramName)) {
                    SystemClock.sched(latency + 0.25, {
                        track[\ramps][rampKey] !? { |r|
                            if ((r[\target] == value) and: { tracks[key] === track }) {
                                var target = paramTarget.(track, -1, paramName);
                                dropRamp.(key, track, rampKey);
                                target[\unmap].();
                            };
                        };
                        nil
                    });
                };
            };
        }
        {
            if (track[\controllers][slot].notNil) {
                // Resolve by name (or a "Name#N" index suffix - see resolveParamIndex) and drive
                // that specific parameter; values are normalized 0..1.
                bundleNow.(latency, {
                    paramTarget.(track, slot, paramName) !? { |target| rampTo.(track, rampKey, slot, target, value.clip(0, 1)) };
                });
            };
        };
    };
}, '/poptart/setParam');

// The pattern is about to drive a plugin parameter by poll: read what it is now and keep it, so
// that a release can put it back. The read is asynchronous (the server answers /get with the
// value); the first set is bundled a latency ahead, so the answer is what the parameter was before
// the pattern reached it. A parameter already held keeps its first reading - a second hold is a
// fresh Scheduler on the same track (an unmute), not a new starting point.
OSCdef(\poptartHoldParam, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var ctl, rampKey, index;
    if (track.isKindOf(Event) and: { slot >= 0 }) {
        ctl = track[\controllers][slot];
        rampKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
        if (ctl.notNil and: { ctl.info.notNil } and: { track[\resting][rampKey].isNil }) {
            index = resolveParamIndex.(ctl.info, paramName);
            if (index.notNil) {
                // Marked before the answer lands, so a second hold in the meantime does not ask again.
                track[\resting][rampKey] = \pending;
                ctl.get(index, { |v| if (track[\resting][rampKey] == \pending) { track[\resting][rampKey] = v } });
            };
        };
    };
}, '/poptart/holdParam');

// ...and is done with it. The ramp behind the poll goes (deferred, like any dropped modulator),
// the parameter is unmapped from its bus, and set back to what the hold read. An answer that never
// came (the plugin was not open to ask) leaves the parameter where the ramp left it.
OSCdef(\poptartReleaseParam, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger;
    var paramName = msg[3].asString, latency = msg[4].asFloat;
    var track = tracks[key];
    var ctl, rampKey, resting;
    if (track.isKindOf(Event) and: { slot >= 0 }) {
        ctl = track[\controllers][slot];
        rampKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
        resting = track[\resting].removeAt(rampKey);
        if (exprLeaf.(paramName).notNil or: { ctl.notNil and: { ctl.info.notNil } }) {
            bundleNow.(latency, {
                var target = paramTarget.(track, slot, paramName);
                dropRamp.(key, track, rampKey);
                target !? {
                    target[\unmap].();
                    if (resting.isNumber and: { target[\kind] == \control }) { ctl.set(target[\index], resting) };
                };
            });
        };
    };
}, '/poptart/releaseParam');

// Pitch bend on its way out to a plugin (Sig#bend). The track synth posts its bend control at
// bendPollHz while the track is bending (see buildTrackDef's SendReply); here that value becomes
// a MIDI pitch-bend message on the instrument in slot 0.
//
// MIDI pitch bend is a 14-bit number with no unit: 8192 is centre and the ends mean whatever the
// plugin's own bend-range setting says they mean - two semitones on almost everything. `.bend()`
// is written in SEMITONES instead, because a musical distance is the thing a person means and it
// has to mean the same to a sampler (which repitches, and has no such setting). `bendrange` is the
// bridge: how many semitones this plugin's full throw is worth, so the division below is the only
// place the two spellings ever meet. Past the range there is nothing left to send - the message
// saturates, the bend flattens off, and Node says so once per eval rather than per message.
//
// Sent unbundled, at "now". The value already carries its musical timing: Node scheduled it onto
// the bus at the right moment through the ordinary control path, so this is a report of what the
// bus reached, and delaying it further would only put the bend behind the notes it belongs to.
OSCFunc({ |msg|
    var key = bendTracks[msg[1].asInteger];
    var semis = msg[3].asFloat, range = max(msg[4].asFloat, 1e-6);
    var track = key !? { tracks[key] };
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    if (ctl.notNil and: { slotLive.(track, 0) }) { ctl.midi.bend(0, (8192 + (semis / range * 8192)).round.clip(0, 16383)) };
}, '/poptart/bendOut', server.addr);

// Native modulators: map a control bus to the VST parameter once, drive the bus with a UGen
// oscillator running in scsynth's audio callback - zero further OSC traffic, genuinely
// continuous. (A polled control is the same bus with a ramp synth writing it - see rampTo.)
// Re-eval with the same shape updates the running LFO's args in place, so its phase carries
// across livecoding edits with no glitch/reset (same behavior the old native LFO.h had).
// (Node also re-sends this at poll rate when .range() has signal-valued bounds - same in-place
// update path, so the LFO stays native while its range wanders.)
// slot -1 = the track's own channel controls (gain/pan): the bus maps onto the track synth's
// control input instead of a VST parameter, and no plugin needs to be loaded.
OSCdef(\poptartSetParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var shape = msg[4].asSymbol, rateHz = msg[5].asFloat, phaseCycles = msg[6].asFloat;
    var lo = msg[7].asFloat, hi = msg[8].asFloat;
    // A patterned rate's changes arrive timestamped with its phase anchors (see anchorParamLFO), so
    // a re-send must not move a running modulator's rate: it lands now, the change is due later.
    var rateFromAnchors = (msg[9] ? 0).asInteger == 1;
    fork {
        var track = awaitTrack.(key);
        var target, isChannel, ctl, index, lfoKey, existing, atAudio;
        if (track.isNil) { ("poptart: setParamLFO: no track " ++ key).warn } {
            target = awaitTarget.(track, slot, paramName, "setParamLFO");
            if (target.notNil) {
                // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
                isChannel = target[\kind] != \control;
                index = target[\index];
                ctl = track[\controllers][slot];

                    lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\lfos][lfoKey];
                    atAudio = target[\mapAudio].notNil;
                    if (existing.notNil and: { (existing[\audio] ? false) != atAudio }) {
                        // The slot changed kind under it (a plugin swapped for a native device or
                        // back): the bus is the wrong kind for what reads it now, so it starts over.
                        existing[\synth].free;
                        existing[\bus].free;
                        track[\lfos].removeAt(lfoKey);
                        existing = nil;
                    };
                    // Warn on creation only: signal-valued bounds re-send continuously and may
                    // legitimately swing wide momentarily. Channel controls have their own ranges.
                    if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: LFO range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    // An entry outlives the plugin it was mapped onto (see setParamCC): re-map the bus
                    // on every send so a swapped plugin, whose open cleared the UGen's mappings, still
                    // hears it - on the same bus and index this is a no-op.
                    if (existing.notNil) {
                        existing[\index] = index;
                        if (atAudio) { target[\mapAudio].(existing[\bus], 1, 0) } { target[\map].(existing[\bus]) };
                    };
                    case
                    { existing.notNil and: { existing[\shape] == shape } } {
                        if (rateFromAnchors) { existing[\synth].set(\lo, lo, \hi, hi) } {
                            existing[\synth].set(\freq, rateHz, \lo, lo, \hi, hi); // phase preserved
                        };
                    }
                    { existing.notNil } { // shape changed: new oscillator, same bus + mapping
                        // Freed immediately, unlike a DROPPED modulator (see freeModulatorLater):
                        // the replacement writes to this same bus, and two live synths summing
                        // into it would be a worse parameter than one stale-node warning.
                        existing[\synth].free;
                        existing[\synth] = Synth(lfoDefName.(shape, atAudio),
                            [\out, existing[\bus], \freq, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi],
                            target: track[\group], addAction: \addToHead);
                        existing[\shape] = shape;
                    }
                    {
                        var bus = if (atAudio) { Bus.audio(server, 2) } { Bus.control(server, 1) };
                        var lfoSynth = Synth(lfoDefName.(shape, atAudio),
                            [\out, bus, \freq, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi],
                            target: track[\group], addAction: \addToHead);
                        dropRamp.(key, track, lfoKey);
                        if (atAudio) { target[\mapAudio].(bus, 1, 0) } { target[\map].(bus) };
                        track[\lfos][lfoKey] = (synth: lfoSynth, bus: bus, shape: shape, index: index, audio: atAudio);
                    };
                };
        };
        if (track.isKindOf(Event)) { tellMods.(track) };
    };
}, '/poptart/setParamLFO');

// Phase re-anchor for a free-running LFO (basic shapes and free-mode lfo() shapes): resets the
// modulator's Sweep to `phase` at the bundled target time. The scheduler sends one shortly
// after creating an LFO and every few seconds thereafter, pinning the modulator to its clock
// so audio-clock skew can't accumulate into drift against the note grid; each correction is
// only the skew of a few seconds (microseconds), inaudible. One arriving while the LFO is
// still being set up (the setParamLFO fork awaiting the plugin) finds no entry and is dropped -
// the next periodic anchor locks it.
//
// A patterned rate also sends the rate the modulator runs at from that moment (msg[6]): its changes
// come this way, so the new rate and the phase the scheduler's integral has reached land together,
// on the step. A drawn shape's synth calls its rate \rate, and a swap starts the next shape at it.
OSCdef(\poptartAnchorParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var phase = msg[4].asFloat, latency = msg[5].asFloat, rate = msg[6];
    var track = tracks[key];
    var entry = if (track.isKindOf(Event)) { track[\lfos][("slot" ++ slot ++ "_" ++ paramName).asSymbol] };
    if (entry.notNil) {
        if (rate.isNil) {
            bundleNow.(latency, { entry[\synth].set(\t_trig, 1, \phase, phase) });
        } {
            var custom = entry[\shape] == \custom;
            rate = rate.asFloat;
            if (custom) { entry[\rate] = rate };
            bundleNow.(latency, { entry[\synth].set(\t_trig, 1, \phase, phase, if (custom) { \rate } { \freq }, rate) });
        };
    };
}, '/poptart/anchorParamLFO');

// lfo() drawn shapes: each shape a table in a Buffer, played by the one shape modulator def
// (poptart_shape_lfo, at the sample rate on a control of poptart's own devices) on the same
// bus+map mechanism as setParamLFO. Modes:
//   free      - loops on its own clock, ignores notes
//   retrigger - loops, but phase resets on each noteOn (Sweep reset trigger)
//   envelope  - one pass per noteOn over 1/rate seconds, then holds the final level
// Node sends the tables as files (msg[10], a JSON list of paths, read here and deleted) under a
// key naming the shapes (msg[9]); a re-send of the same shapes sends the key and no files. A
// re-send with the same key and mode only updates rate/range in place (phase preserved,
// livecoding-friendly). New shapes in the same mode - a shape being dragged in the editor, sent
// about once a frame - are new tables under the running synth: it goes on at the phase it had
// reached, playing the new shape from there. A changed mode or shape count swaps the synth on the
// same bus, keeping the parameter mapping.
OSCdef(\poptartSetParamShapeLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var mode = msg[4].asSymbol, rateHz = msg[5].asFloat, phaseCycles = msg[6].asFloat;
    var lo = msg[7].asFloat, hi = msg[8].asFloat, shapeKey = msg[9].asString;
    var paths = ((msg[10] ? "[]").asString.parseJSON ? []).collect(_.asString);
    // How long a swap between a patterned lfo("<pluck swell>")'s shapes glides, as a fraction of
    // one period.
    var glide = (msg[11] ? 0).asFloat;
    var rateFromAnchors = (msg[12] ? 0).asInteger == 1; // as setParamLFO's
    fork {
        var track = awaitTrack.(key);
        var target, isChannel, index, lfoKey, existing, spec, bufs, bus, shapeSynth, atAudio, defName;
        var envelope = if (mode == \envelope) { 1 } { 0 };
        // The tables, read off their files (which then go): nil when Node sent none.
        var readTables = {
            if (paths.isEmpty) { nil } {
                var read = paths.collect { |p| Buffer.read(server, p) };
                server.sync;
                paths.do { |p| File.delete(p) };
                paths = [];
                read;
            };
        };
        var freeTablesLater = { |list| list !? { SystemClock.sched(modFreeDelay, { list.do(_.free); nil }) } };
        if (track.isNil) { ("poptart: setParamShapeLFO: no track " ++ key).warn; paths.do { |p| File.delete(p) } } {
            target = awaitTarget.(track, slot, paramName, "setParamShapeLFO");
            if (target.isNil) { paths.do { |p| File.delete(p) } } {
                // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
                isChannel = target[\kind] != \control;
                index = target[\index];
                atAudio = target[\mapAudio].notNil;
                defName = if (atAudio) { \poptart_shape_lfo_ar } { \poptart_shape_lfo };
                lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                existing = track[\lfos][lfoKey];
                if (isChannel.not and: { existing.isNil } and: { (lo < 0) or: { hi > 1 } }) {
                    ("poptart: shape range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                        ++ "' is outside the normalized 0..1 VST parameter range and will pin").warn;
                };
                if (existing.notNil and: { (existing[\audio] ? false) != atAudio }) {
                    // The slot changed kind under it: the bus is the wrong kind for what reads it
                    // now. The tables are kept; the synth and bus start over.
                    existing[\synth].free;
                    existing[\bus].free;
                    track[\lfos].removeAt(lfoKey);
                    bufs = existing[\bufs];
                    existing = nil;
                };
                // An entry outlives the plugin it was mapped onto (see setParamLFO): re-map the
                // bus on every send. On the same bus and index it is a no-op.
                if (existing.notNil) {
                    existing[\index] = index;
                    if (atAudio) { target[\mapAudio].(existing[\bus], 1, 0) } { target[\map].(existing[\bus]) };
                };
                spec = mode.asString ++ "|" ++ glide.asString ++ "|" ++ shapeKey;
                case
                { existing.notNil and: { existing[\shape] == \custom } and: { existing[\spec] == spec } } {
                    paths.do { |p| File.delete(p) };
                    if (rateFromAnchors) { existing[\synth].set(\lo, lo, \hi, hi) } {
                        existing[\synth].set(\rate, rateHz, \lo, lo, \hi, hi);
                        existing[\rate] = rateHz;
                    };
                    // A swap has to start the next shape at this one's rate and range.
                    existing[\lo] = lo; existing[\hi] = hi;
                }
                { existing.notNil and: { existing[\shape] == \custom } and: { existing[\mode] == mode }
                    and: { existing[\glide] == glide } and: { paths.size == (existing[\bufs] ? []).size } } {
                    // New shapes, same everything else: new tables under the running synth.
                    var old = existing[\bufs];
                    bufs = readTables.();
                    // A modulator the deferred free of a dropped one may already have taken.
                    if (tracks[key] === track and: { track[\lfos][lfoKey] === existing }) {
                        existing[\synth].set(\buf, bufs[existing[\current] ? 0], \lo, lo, \hi, hi,
                            *(if (rateFromAnchors) { [] } { [\rate, rateHz] }));
                        existing[\bufs] = bufs;
                        existing[\spec] = spec;
                        if (rateFromAnchors.not) { existing[\rate] = rateHz };
                        existing[\lo] = lo; existing[\hi] = hi;
                        freeTablesLater.(old);
                    } { freeTablesLater.(bufs) };
                }
                {
                    var old = existing !? { |e| e[\bufs] };
                    bufs = readTables.() ?? { bufs } ?? { old };
                    if (bufs.isNil) {
                        ("poptart: setParamShapeLFO: '" ++ paramName ++ "' has no shape to play - evaluate it again").warn;
                    } {
                        if (bufs !== old) { freeTablesLater.(old) };
                        if (existing.notNil) {
                            // Immediate, for the reason setParamLFO's shape swap gives: the new
                            // synth takes over this very bus (a basic LFO's, if it was one).
                            existing[\synth].free;
                            bus = existing[\bus];
                        } {
                            bus = if (atAudio) { Bus.audio(server, 2) } { Bus.control(server, 1) };
                        };
                        shapeSynth = Synth(defName,
                            [\out, bus, \buf, bufs[0], \rate, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi,
                             \envelope, envelope,
                             \t_trig, if ((mode != \free) and: { track[\held] > 0 }) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        if (existing.isNil) {
                            dropRamp.(key, track, lfoKey);
                            if (atAudio) { target[\mapAudio].(bus, 1, 0) } { target[\map].(bus) };
                            track[\lfos][lfoKey] = (synth: shapeSynth, bus: bus, shape: \custom,
                                index: index, mode: mode, spec: spec, bufs: bufs, def: defName,
                                current: 0, glide: glide, rate: rateHz, lo: lo, hi: hi,
                                group: track[\group], audio: atAudio);
                        } {
                            existing[\synth] = shapeSynth;
                            existing[\shape] = \custom;
                            existing[\mode] = mode;
                            existing[\spec] = spec;
                            existing[\bufs] = bufs;
                            existing[\def] = defName;
                            existing[\current] = 0;
                            existing[\glide] = glide;
                            existing[\rate] = rateHz; existing[\lo] = lo; existing[\hi] = hi;
                            existing[\pending] = nil; // a queued swap into shapes that are gone
                        };
                    };
                };
            };
        };
        if (track.isKindOf(Event)) { tellMods.(track) };
    };
}, '/poptart/setParamShapeLFO');

// Which shape a patterned lfo("<pluck swell>") is playing from now on. Every shape is already
// compiled (see setParamShapeLFO), so the swap is a timestamped exchange of one running synth for
// another on the same bus: the mapping onto the plugin parameter is never touched, so the
// parameter never sees a gap. The new shape starts from its beginning - a shape that carried on at
// the outgoing one's phase would be neither shape - and the step that creates is glided away
// inside the SynthDef.
//
// In the note-gated modes the swap WAITS for the next note instead. retrigger/envelope shapes are
// played per note; cutting one off halfway to start a different one is not what "the next shape"
// means, and the pattern's step boundary has no particular relationship to the note anyway.
OSCdef(\poptartSetParamShape, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var index = msg[4].asInteger, latency = msg[5].asFloat;
    // A patterned rate names the rate the new shape starts at; otherwise it keeps the running one.
    var swapRate = msg[6] !? { |r| r.asFloat };
    var track = tracks[key];
    var lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\lfos][lfoKey] };
    var swap;
    if (existing.notNil and: { existing[\bufs].notNil }
        and: { index >= 0 } and: { index < existing[\bufs].size }
        and: { index != existing[\current] }) {
        swap = {
            var old = existing[\synth];
            var rate = swapRate ?? { existing[\rate] ? 1 };
            // glide is a fraction of one LFO PERIOD, so what it is worth in seconds follows the
            // rate: a slow modulator glides slowly, which is what makes it read as one gesture.
            var glideSec = (existing[\glide] ? 0) / max(rate.abs, 0.001);
            var next = Synth(existing[\def], [\out, existing[\bus], \buf, existing[\bufs][index],
                 \rate, rate, \phase, 0, \lo, existing[\lo] ? 0, \hi, existing[\hi] ? 1,
                 \envelope, if (existing[\mode] == \envelope) { 1 } { 0 },
                 \t_trig, if (existing[\mode] == \free) { 0 } { 1 },
                 \glideSec, glideSec, \glideOn, if (glideSec > 0) { 1 } { 0 }],
                target: existing[\group], addAction: \addToHead);
            existing[\synth] = next;
            existing[\current] = index;
            existing[\rate] = rate;
            old.free; // after the new one is made, so its In.kr still sees this one's last value
            tellMods.(track);
        };
        if (existing[\mode] == \free) {
            bundleNow.(latency, swap);
        } {
            existing[\pending] = swap;
        };
    };
    // Counted whatever happened, so Node knows when it may play this track's notes itself again.
    shapesHandled[key] = (shapesHandled[key] ? 0) + 1;
    if (track.isKindOf(Event)) { tellMods.(track) } { nodeAddr.sendMsg("/poptart/ids/swap", key, shapesHandled[key], 0) };
}, '/poptart/setParamShape');

// Tier 2, envelope flavor: same bus+map mechanism as setParamLFO, but the modulator is an
// EnvGen gated by the track's note events (see noteOn/noteOff above). Re-eval updates the
// running synth's args in place - a mid-note livecoding edit doesn't cut the envelope off.
//
// On a control of one of poptart's own devices the envelope runs at the SAMPLE rate, on an audio
// bus the device reads per sample (poptart_env_ar, PoptartDeviceController's mapAudio): a plugin
// or a channel control is read once a block whatever drives it, so for those it stays a control
// bus. An entry whose slot changed kind under it is rebuilt as the other kind.
OSCdef(\poptartSetParamEnv, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var atk = msg[4].asFloat, dec = msg[5].asFloat, sus = msg[6].asFloat, rel = msg[7].asFloat;
    var curve = msg[8].asFloat, lo = msg[9].asFloat, hi = msg[10].asFloat;
    var retrig = (msg[11] ? 0).asInteger;
    fork {
        var track = awaitTrack.(key);
        var target, isChannel, ctl, index, envKey, existing, atAudio;
        if (track.isNil) { ("poptart: setParamEnv: no track " ++ key).warn } {
            target = awaitTarget.(track, slot, paramName, "setParamEnv");
            if (target.notNil) {
                // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
                isChannel = target[\kind] != \control;
                index = target[\index];
                ctl = track[\controllers][slot];

                    envKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\envs][envKey];
                    atAudio = target[\mapAudio].notNil;
                    if (existing.notNil and: { (existing[\audio] ? false) != atAudio }) {
                        // A plugin swapped for a native device or back: the bus is the wrong kind
                        // for what reads it now, so this envelope starts over on the right one.
                        existing[\synth].free;
                        existing[\bus].free;
                        track[\envs].removeAt(envKey);
                        existing = nil;
                    };
                    // An entry outlives the plugin it was mapped onto (see setParamLFO): re-map the
                    // bus on every send, so a slot whose plugin was swapped - an open clears the
                    // UGen's mappings - still reaches it. On the same bus and index it is a no-op.
                    if (existing.notNil) {
                        existing[\index] = index;
                        if (atAudio) { target[\mapAudio].(existing[\bus], 1, 0) } { target[\map].(existing[\bus]) };
                    };
                    if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: env range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    if (existing.notNil) {
                        existing[\synth].set(\atk, atk, \dec, dec, \sus, sus, \rel, rel, \curve, curve, \lo, lo, \hi, hi, \retrig, retrig);
                    } {
                        var bus = if (atAudio) { Bus.audio(server, 2) } { Bus.control(server, 1) };
                        var envSynth = Synth(if (atAudio) { \poptart_env_ar } { \poptart_env },
                            [\out, bus, \atk, atk, \dec, dec, \sus, sus, \rel, rel, \curve, curve, \lo, lo, \hi, hi,
                             \retrig, retrig, \gate, if (track[\held] > 0) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        dropRamp.(key, track, envKey);
                        if (atAudio) { target[\mapAudio].(bus, 1, 0) } { target[\map].(bus) };
                        track[\envs][envKey] = (synth: envSynth, bus: bus, index: index, audio: atAudio);
                    };
                };
        };
        if (track.isKindOf(Event)) { tellMods.(track) };
    };
}, '/poptart/setParamEnv');

// Unmapping a channel control (slot -1) also resets it to its neutral value - map(ctl, -1)
// removes the bus mapping but leaves the control at whatever the modulator last wrote.
OSCdef(\poptartClearParamEnv, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var envKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\envs][envKey] };
    if (existing.notNil) {
        // Dropped first, so the control's other audio drivers going back on (see paramTarget's
        // unmapAudio) do not include this one.
        track[\envs].removeAt(envKey);
        paramTarget.(track, slot, paramName, existing[\index]) !? { |target|
            if (existing[\audio] == true) { target[\unmapAudio] !? { |off| off.() } } { target[\unmap].() };
        };
        freeModulatorLater.(key, track[\group], existing[\synth], existing[\bus]);
    };
    if (track.isKindOf(Event)) { tellMods.(track) };
}, '/poptart/clearParamEnv');

// Takes a dropped modulator's synth and bus down a beat AFTER it was unmapped, rather than the
// instant the pattern let go of it. Note events are sent up to a lookahead ahead of time and gate
// these synths from inside a TIMESTAMPED bundle (see poptartNoteOn: `set(\gate, 1)` for env(),
// `set(\t_trig, 1)` for the note-gated lfo() modes) - so freeing the node right away pulls it out
// from under every note already in flight, and scsynth prints "FAILURE IN SERVER /n_set Node not
// found" once per note in that window. Dropping a note-gated modulator off a playing track hit
// that every time (found 2026-08-26, via `.param(name, lfo(mode: 'envelope').mul(lfo(...)))`,
// where the second modulator demotes the parameter to a polled value and so clears the first).
//
// The UNMAP still happens immediately - the parameter has to stop being driven the moment the
// pattern says so; only the node waits. Its bus waits with it, since a bus freed while its synth
// is still writing can be handed straight to the next allocation.
// Only for a DROPPED modulator, whose bus goes with it. A rebuild (a changed shape) hands the same
// bus to its replacement, so waiting there would leave two synths summing into it - those free the
// old node immediately and wear the occasional stale-node warning instead.
freeModulatorLater = { |key, group, synth, bus|
    // Expected, and already explained above: notes in flight were gated from a timestamped
    // bundle and will write to this node after it goes. nodeGone would otherwise report each one
    // as a node nothing holds, which is true and is not news - so it is accounted for here, where
    // the reason is known, and the report is kept for the failures nobody expected.
    // Bounded: a long set drops a lot of modulators, and this is bookkeeping rather than state.
    // Clearing it can cost one extra warning line for a node already accounted for, which is a
    // better trade than a set that grows all night.
    if (nodeGoneSaid.size > 2000) { nodeGoneSaid.clear };
    synth !? { |sy| nodeGoneSaid.add(sy.nodeID) };
    SystemClock.sched(modFreeDelay, {
        // A track destroyed (or rebuilt) inside the window already took the node down with its
        // group, so there is nothing left to free there - but the bus is a client-side allocation
        // that destroyTrack can no longer see, and always has to be handed back here.
        if (tracks[key].isKindOf(Event) and: { tracks[key][\group] === group }) { synth.free };
        bus !? { |b| b.free };
        nil;
    });
};

OSCdef(\poptartClearParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\lfos][lfoKey] };
    if (existing.notNil) {
        track[\lfos].removeAt(lfoKey);
        paramTarget.(track, slot, paramName, existing[\index]) !? { |target|
            if (existing[\audio] == true) { target[\unmapAudio] !? { |off| off.() } } { target[\unmap].() };
        };
        freeModulatorLater.(key, track[\group], existing[\synth], existing[\bus]);
        // A drawn shape's tables go with it, on the same deferral (nothing reads them after).
        existing[\bufs] !? { |list| SystemClock.sched(modFreeDelay, { list.do(_.free); nil }) };
    };
    if (track.isKindOf(Event)) { tellMods.(track) };
}, '/poptart/clearParamLFO');

// --- live MIDI input ---

// Node asks for MIDI explicitly when a pattern's only MIDI use is Tier-1 (the native handlers
// below all enable it themselves).
OSCdef(\poptartMidiInit, { midiEnable.() }, '/poptart/midiInit');

// Connected sources as the "device name" strings midicc()/midikeys() match against, for the
// editor's device autocomplete. Enables MIDI input as a side effect: the only caller is someone
// typing a MIDI builder, so it's about to be on anyway (and midiEnable is idempotent) - and
// because enabling an already-enabled client rescans, this list is what is plugged in NOW rather
// than what was there at the first init. The destinations list has always worked this way.
OSCdef(\poptartGetMidiDevices, { |msg|
    var requestId = msg[1];
    midiEnable.();
    replyOk.("/poptart/getMidiDevices", requestId,
        toJson.(MIDIClient.sources.collect { |s| s.device.asString ++ " " ++ s.name.asString }));
}, '/poptart/getMidiDevices');

// midicc() -> parameter: the CC sibling of setParamLFO's bus+map mechanism. One MIDIdef writes
// each incoming value (scaled into lo..hi) straight to a control bus mapped onto the VST
// parameter - no Node round-trip, no polling, latency is the MIDI driver's. channel 0 = all
// channels (last event on any wins). A re-send with the same device/cc/channel binding just
// updates lo/hi in place (the knob's last position is rescaled onto the new range - livecoding
// a .range() edit doesn't jump the parameter); a changed binding re-registers the MIDIdef on
// the same bus. slot -1 = the track's own channel controls (gain/pan), as everywhere else.
OSCdef(\poptartSetParamCC, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var device = msg[4].asString, cc = msg[5].asInteger, channel = msg[6].asInteger;
    var lo = msg[7].asFloat, hi = msg[8].asFloat;
    fork {
        var track = awaitTrack.(key);
        var target, isChannel, ctl, index, ccKey, existing, src, binding, defKey, registerDef;
        if (track.isNil) { ("poptart: setParamCC: no track " ++ key).warn } {
            midiEnable.();
            target = awaitTarget.(track, slot, paramName, "setParamCC");
            if (target.notNil) {
                // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
                isChannel = target[\kind] != \control;
                index = target[\index];
                ctl = track[\controllers][slot];

                    src = midiSourceFor.(device);
                    if (src.isNil) {
                        midiWarnMissing.("midicc", device);
                    } {
                        binding = device ++ "|" ++ cc ++ "|" ++ channel;
                        ccKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                        defKey = ("poptart_cc_" ++ key ++ "_" ++ ccKey).asSymbol;
                        existing = track[\ccs][ccKey];
                        registerDef = { |e|
                            // Free any previous def first: MIDIdef re-init keeps old filters
                            // where the new one is nil (chan = argchan ? chan), so rebinding
                            // "channel 2" -> "all channels" must go through a fresh create.
                            MIDIdef.all[defKey] !? { |d| d.free };
                            MIDIdef.cc(defKey, { |val, num, chan|
                                e[\last] = val / 127;
                                e[\bus].set(e[\lo] + (e[\last] * (e[\hi] - e[\lo])));
                            }, cc, if (channel > 0) { channel - 1 }, srcID: src.uid);
                            e[\srcUid] = src.uid;
                            // The one line that says a knob IS wired - the thing to look for when
                            // a cc does nothing: no line here means the binding never happened.
                            ("poptart: cc " ++ cc ++ " on " ++ device ++ " -> " ++ key ++ " slot " ++ slot
                                ++ " '" ++ paramName ++ "' (" ++ lo ++ ".." ++ hi ++ ")").postln;
                        };
                        if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                            ("poptart: CC range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                                ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                                + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                        };
                        if (existing.notNil) {
                            existing[\lo] = lo;
                            existing[\hi] = hi;
                            // The entry outlives the plugin it was mapped onto: swap the slot's
                            // plugin (a changed .synth()/.fx() name) and opening the new one clears
                            // the UGen's parameter mappings, so the bus this knob writes to reads to
                            // nothing - and the parameter may sit at a different index now. Map it
                            // again on every send (onto the same bus it is a no-op), so a re-eval
                            // always leaves the knob connected to what is in the slot today.
                            existing[\index] = index;
                            target[\map].(existing[\bus]);
                            // And the def: the device may have come back under another uid, or the
                            // def been freed out from under the entry - either way nothing would
                            // fire. A binding that still matches but whose def is gone or re-sourced
                            // is registered afresh (same defKey - replaces the old MIDIdef).
                            if ((existing[\binding] != binding) or: { existing[\srcUid] != src.uid } or: { MIDIdef.all[defKey].isNil }) {
                                existing[\binding] = binding;
                                registerDef.(existing);
                            };
                            existing[\bus].set(lo + (existing[\last] * (hi - lo)));
                        } {
                            var bus = Bus.control(server, 1);
                            var entry = (bus: bus, index: index, lo: lo, hi: hi, last: 0,
                                binding: binding, defKey: defKey);
                            bus.set(lo); // hardware position unknown until the knob moves - start at the floor
                            registerDef.(entry);
                            dropRamp.(key, track, ccKey);
                            target[\map].(bus);
                            track[\ccs][ccKey] = entry;
                        };
                    };
                };
        };
    };
}, '/poptart/setParamCC');

OSCdef(\poptartClearParamCC, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var ccKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\ccs][ccKey] };
    if (existing.notNil) {
        MIDIdef.all[existing[\defKey]] !? { |d| d.free };
        paramTarget.(track, slot, paramName, existing[\index]) !? { |target| target[\unmap].() };
        existing[\bus].free;
        track[\ccs].removeAt(ccKey);
    };
}, '/poptart/clearParamCC');

// osc() -> parameter: setParamCC with an OSC address in place of a device/cc/channel binding.
// One OSCdef per bound parameter, filtered to the input port, writes the message's argument
// `argIndex` (scaled into lo..hi) straight to a control bus mapped onto the parameter - no Node
// round-trip, no polling. Everything else is setParamCC's contract: a re-send with the same
// binding updates lo/hi in place (the fader's last position rescaled onto the new range), a
// changed binding re-registers the def on the same bus, the parameter is re-mapped on every send
// (the entry outlives a swapped plugin), and slot -1 is the track's own channel controls.
OSCdef(\poptartSetParamOSC, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var address = msg[4].asSymbol, argIndex = msg[5].asInteger;
    var lo = msg[6].asFloat, hi = msg[7].asFloat;
    fork {
        var track = awaitTrack.(key);
        var target, isChannel, ctl, index, oscKey, existing, binding, defKey, registerDef;
        if (track.isNil) { ("poptart: setParamOSC: no track " ++ key).warn } {
            oscEnable.();
            target = awaitTarget.(track, slot, paramName, "setParamOSC");
            if (target.notNil) {
                // Range warnings are for a plugin's 0..1 controls, not a channel or an expression input.
                isChannel = target[\kind] != \control;
                index = target[\index];
                ctl = track[\controllers][slot];

                    binding = address ++ "|" ++ argIndex;
                    oscKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    defKey = ("poptart_osc_" ++ key ++ "_" ++ oscKey).asSymbol;
                    existing = track[\oscs][oscKey];
                    registerDef = { |e|
                        OSCdef.all[defKey] !? { |d| d.free };
                        OSCdef(defKey, { |m|
                            var v = m[argIndex + 1];
                            if (v.isNumber) {
                                e[\last] = v.asFloat;
                                e[\bus].set(e[\lo] + (e[\last] * (e[\hi] - e[\lo])));
                            };
                        }, address, recvPort: oscInPort);
                        // The one line that says an address IS wired - the thing to look for
                        // when a fader does nothing: no line here means the binding never happened.
                        ("poptart: osc " ++ address ++ "[" ++ argIndex ++ "] -> " ++ key ++ " slot " ++ slot
                            ++ " '" ++ paramName ++ "' (" ++ lo ++ ".." ++ hi ++ ")").postln;
                    };
                    if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: OSC range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    if (existing.notNil) {
                        existing[\lo] = lo;
                        existing[\hi] = hi;
                        existing[\index] = index;
                        target[\map].(existing[\bus]);
                        if ((existing[\binding] != binding) or: { OSCdef.all[defKey].isNil }) {
                            existing[\binding] = binding;
                            registerDef.(existing);
                        };
                        existing[\bus].set(lo + (existing[\last] * (hi - lo)));
                    } {
                        var bus = Bus.control(server, 1);
                        var entry = (bus: bus, index: index, lo: lo, hi: hi, last: 0,
                            binding: binding, defKey: defKey);
                        bus.set(lo); // the fader's position is unknown until it moves - start at the floor
                        registerDef.(entry);
                        dropRamp.(key, track, oscKey);
                        target[\map].(bus);
                        track[\oscs][oscKey] = entry;
                    };
                };
        };
    };
}, '/poptart/setParamOSC');

OSCdef(\poptartClearParamOSC, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var oscKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\oscs][oscKey] };
    if (existing.notNil) {
        OSCdef.all[existing[\defKey]] !? { |d| d.free };
        paramTarget.(track, slot, paramName, existing[\index]) !? { |target| target[\unmap].() };
        existing[\bus].free;
        track[\oscs].removeAt(oscKey);
    };
}, '/poptart/clearParamOSC');

OSCdef(\poptartOscInit, { oscEnable.() }, '/poptart/oscInit');

// midikeys(): route a device's live performance stream to the track's instrument. Handlers
// forward straight to the slot-0 controller's MIDI input - deliberately NOT through the
// timestamped-bundle path the scheduler uses, since live playing wants "now", not a lookahead
// deadline. Note on/offs mirror the /poptart/noteOn handlers' held-count bookkeeping, so env()
// modulators gate and note-synced lfo() shapes retrigger from live keys exactly like from
// pattern notes. Raw CCs (mod wheel, sustain), pitch bend, and both aftertouch kinds pass
// through so the plugin sees the whole performance. channel 0 = all channels. Re-sends are
// idempotent (MIDIdefs replace by key); a changed device/channel just re-registers.
OSCdef(\poptartMidiRoute, { |msg|
    var key = msg[1].asSymbol, device = msg[2].asString, channel = msg[3].asInteger;
    var scaleStr = if (msg.size > 4) { msg[4].asString } { "" };
    // Folded pitch statics from the chain on the midi()/midikeys() source (see foldPitchOps in
    // pattern-core): a semitone shift applied before the scale quantize, so the scale still
    // decides what actually sounds.
    var transpose = if (msg.size > 5) { msg[5].asInteger } { 0 };
    // DEFER mode (a dynamic pitch-op chain): forward each raw note edge to Node and play nothing
    // here - Node runs the chain and answers with /poptart/noteOn|noteOff (which land in the
    // handlers above, gating envs and held-counts exactly as a scheduled note does). Bend, touch
    // and CC still pass straight through to the instrument; polytouch follows the raw pitch,
    // which a remapped note won't match - acceptable for how rare pressure-per-key is.
    var defer = if (msg.size > 6) { msg[6].asInteger > 0 } { false };
    fork {
        var track = awaitTrack.(key);
        var src, uid, chanArg, kOn, kOff, kBend, kTouch, kPoly, kCc, scalePcs, quantize, sounding;
        // .scale() on a midikeys() chain: snap each incoming note to the nearest of the scale's
        // pitch classes (ties resolve downward). noteOff/polytouch quantize identically, so
        // releases always match their onsets. Two adjacent keys can land on the same note - the
        // synth just sees a retrigger, and the track's held-count still gates envs correctly.
        scalePcs = if (scaleStr.isEmpty) { nil } { scaleStr.split($,).collect(_.asInteger) };
        quantize = { |note|
            var q = note + transpose;
            if (scalePcs.notNil) {
                block { |break|
                    var n = q;
                    (0..11).do { |d|
                        if (scalePcs.includes((n - d) % 12)) { q = n - d; break.() };
                        if (scalePcs.includes((n + d) % 12)) { q = n + d; break.() };
                    };
                };
            };
            q.clip(0, 127);
        };
        if (track.isNil) { ("poptart: midiRoute: no track " ++ key).warn } {
            midiEnable.();
            src = midiSourceFor.(device);
            if (src.isNil) { midiWarnMissing.("midikeys", device) } {
                uid = src.uid;
                chanArg = if (channel > 0) { channel - 1 };
                kOn = ("poptart_mk_on_" ++ key).asSymbol;
                kOff = ("poptart_mk_off_" ++ key).asSymbol;
                kBend = ("poptart_mk_bend_" ++ key).asSymbol;
                kTouch = ("poptart_mk_touch_" ++ key).asSymbol;
                kPoly = ("poptart_mk_poly_" ++ key).asSymbol;
                kCc = ("poptart_mk_cc_" ++ key).asSymbol;
                // Free previous defs before re-registering: MIDIdef re-init keeps old filters
                // where the new one is nil, so a channel -> all-channels edit needs a fresh create.
                [kOn, kOff, kBend, kTouch, kPoly, kCc].do { |k| MIDIdef.all[k] !? { |d| d.free } };
                // What the route has sounding: incoming (channel, key) -> the pitch its note-on
                // actually played. A note-off releases THAT pitch, never a fresh mapping - a key
                // held across an edit to the chain's transpose or scale would otherwise be
                // released at a pitch that was never played, and drone - and a teardown releases
                // exactly these by name (see clearMidiRoute). Kept across a re-registration for
                // the same reason. Empty in defer mode, where Node holds the same table.
                sounding = (track[\midiRoute] !? { |r| r[\sounding] }) ?? { IdentityDictionary.new };
                MIDIdef.noteOn(kOn, { |veloc, note, chan|
                    var ctl, rawKey = (chan * 128) + note;
                    if (defer) {
                        // Raw edge to Node; Node's answer comes back as /poptart/noteOn and does
                        // the playing (and the midiNoteIn record feed, with the mapped pitch).
                        nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note,
                            veloc / 127.0, if (veloc > 0) { 1 } { 0 });
                    } {
                        ctl = track[\controllers][0];
                        note = quantize.(note);
                        // Every note edge also goes to Node (the note as it sounds, post-quantize) -
                        // that's the feed web-app's MIDI record collects. Sent before the ctl check
                        // so recording works even while the instrument is still opening.
                        nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note,
                            veloc / 127.0, if (veloc > 0) { 1 } { 0 });
                        if (ctl.notNil) {
                            if (veloc > 0) {
                                heldBy.(track, 1);
                                sounding[rawKey] = note;
                                ctl.midi.noteOn(chan, note, veloc);
                                track[\envs].do { |e| e[\synth].set(\gate, 1, \t_retrig, 1) };
                                track[\lfos].do { |e|
                                    if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
                                };
                            } {
                                // running-status note-on with velocity 0 = note-off
                                heldBy.(track, -1);
                                ctl.midi.noteOff(chan, sounding.removeAt(rawKey) ? note, 0);
                                if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
                            };
                        };
                    };
                }, chan: chanArg, srcID: uid);
                MIDIdef.noteOff(kOff, { |veloc, note, chan|
                    var ctl, rawKey = (chan * 128) + note;
                    if (defer) {
                        nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note, veloc / 127.0, 0);
                    } {
                        ctl = track[\controllers][0];
                        note = quantize.(note);
                        nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note, veloc / 127.0, 0);
                        if (ctl.notNil) {
                            heldBy.(track, -1);
                            ctl.midi.noteOff(chan, sounding.removeAt(rawKey) ? note, veloc);
                            if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
                        };
                    };
                }, chan: chanArg, srcID: uid);
                MIDIdef.bend(kBend, { |val, chan|
                    track[\controllers][0] !? { |c| c.midi.bend(chan, val) };
                }, chan: chanArg, srcID: uid);
                MIDIdef.touch(kTouch, { |val, chan|
                    track[\controllers][0] !? { |c| c.midi.touch(chan, val) };
                }, chan: chanArg, srcID: uid);
                MIDIdef.polytouch(kPoly, { |val, note, chan|
                    track[\controllers][0] !? { |c| c.midi.polyTouch(chan, quantize.(note), val) };
                }, chan: chanArg, srcID: uid);
                MIDIdef.cc(kCc, { |val, num, chan|
                    track[\controllers][0] !? { |c| c.midi.control(chan, num, val) };
                }, chan: chanArg, srcID: uid);
                track[\midiRoute] = (keys: [kOn, kOff, kBend, kTouch, kPoly, kCc], sounding: sounding);
                ("poptart: track " ++ key ++ " playing live from " ++ src.device ++ " " ++ src.name
                    ++ (if (channel > 0) { " (channel " ++ channel ++ ")" } { " (all channels)" })
                    ++ (if (defer) { " (pitch ops in Node)" } { "" })).postln;
            };
        };
    };
}, '/poptart/midiRoute');

// Tearing a route down also silences anything still sounding, so a key held across a mute/stop
// doesn't drone: gates close, and every note the route still has sounding is released by name
// (see \sounding in midiRoute). CC 123 (all notes off) follows on every channel as a net for a
// VST2 plugin only. VST3 has no such message - a controller reaches a VST3 plugin only where the
// plugin maps it to a parameter, almost none map 123, and for the rest VSTPlugin drops it with a
// warning per channel: sixteen log lines a teardown, for nothing.
clearMidiRoute = { |key|
    var track = tracks[key];
    if (track.isKindOf(Event) and: { track[\midiRoute].notNil }) {
        var sounding = track[\midiRoute][\sounding];
        track[\midiRoute][\keys].do { |k| MIDIdef.all[k] !? { |d| d.free } };
        track[\midiRoute] = nil;
        track[\held] = 0;
        track[\envs].do { |e| e[\synth].set(\gate, 0) };
        track[\controllers][0] !? { |ctl|
            // A plugin has to be there to release anything (see slotLive) - past a close or a
            // failed open, each of these would only draw a warning from the empty slot.
            if (slotLive.(track, 0)) {
                sounding !? { sounding.keysValuesDo { |rawKey, note| ctl.midi.noteOff(rawKey div: 128, note, 0) } };
                if (ctl.info.notNil and: { ctl.info.sdkVersion.asString.find("VST 3").isNil }) {
                    16.do { |c| ctl.midi.control(c, 123, 0) };
                };
            };
        };
    };
};

OSCdef(\poptartClearMidiRoute, { |msg|
    clearMidiRoute.(msg[1].asSymbol);
}, '/poptart/clearMidiRoute');

// --- audio + MIDI routing (the midi()/audio() source builders and injector methods) ---

// Audio into an fx aux (Sig#audio injector): wireAudio handles both a track source (cross-track
// bus + send + ordering) and a device source (SoundIn feeder). See wireAudio for the mechanics.
OSCdef(\poptartInjectAudio, { |msg|
    wireAudio.(msg[1].asSymbol, msg[2].asInteger, msg[3].asString, msg[4].asFloat,
        (msg[5] ? 0).asInteger, (msg[6] ? 1).asInteger);
}, '/poptart/injectAudio');

OSCdef(\poptartClearAudioInject, { |msg|
    unwireAudio.(msg[1].asSymbol, msg[2].asInteger);
}, '/poptart/clearAudioInject');

// A param expression (see installExpr): [trackId, slot, name, treeJson].
OSCdef(\poptartSetParamExpr, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, name = msg[3].asString, json = msg[4].asString;
    exprRun.(key, slot, name, {
        var track = awaitTrack.(key);
        if (track.isNil) { ("poptart: setParamExpr: no track " ++ key).warn } {
            installExpr.(key, track, slot, name, json);
        };
    });
}, '/poptart/setParamExpr');

// [trackId, slot, name]: the expression comes off, and the control goes back to its own value.
OSCdef(\poptartClearParamExpr, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, name = msg[3].asString;
    exprRun.(key, slot, name, {
        var track = tracks[key];
        if (track.isKindOf(Event)) { clearExpr.(key, track, slot, name) };
    });
}, '/poptart/clearParamExpr');

// Audio into a track's chain input (the audio() head source): same wiring, sink slot 0 (the
// track's inBus, already mixed into its instrument slot).
OSCdef(\poptartSetAudioInput, { |msg|
    wireAudio.(msg[1].asSymbol, 0, msg[2].asString, 1.0,
        (msg[3] ? 0).asInteger, (msg[4] ? 1).asInteger);
}, '/poptart/setAudioInput');

OSCdef(\poptartClearAudioInput, { |msg|
    unwireAudio.(msg[1].asSymbol, 0);
}, '/poptart/clearAudioInput');

// Output-to-bus sends (Sig#bus). msg = [trackId, name1, amount1, name2, amount2, ...]: replace the
// track's whole set of bus sends. Each name acquires a ref on its bus; the previous set is released
// afterwards (acquire-before-release, so a bus kept across the change never briefly hits zero refs
// and gets freed). The tree is reordered so the writer executes before any reader of the bus (see
// reorderTracks). Each send is a tap of its own (see stripTap), as many as the code writes.
OSCdef(\poptartSetBusSends, { |msg|
    var key = msg[1].asSymbol;
    var pairs = msg.drop(2);
    fork {
        var track = awaitTrack.(key);
        track !? {
            // One post-fader tap per named bus (Sig#bus), as many as the code writes.
            var requested = pairs.size div: 2;
            var newNames = [];
            requested.do { |i|
                var name = pairs[i * 2].asString;
                var amt = pairs[(i * 2) + 1].asFloat;
                stripTap.(track, ("bus" ++ i).asSymbol, acquireBus.(name).index, amt, 1);
                newNames = newNames.add(name);
            };
            (track[\busSends] ? []).size.do { |i| if (i >= requested) { stripTap.(track, ("bus" ++ i).asSymbol, nil) } };
            track[\busSends] !? { |prev| prev.do { |bn| releaseBus.(bn) } };
            track[\busSends] = newNames;
            reorderTracks.();
        };
    };
}, '/poptart/setBusSends');

// One routed send's level moving (a signal-valued .bus() amount, polled by the scheduler).
// msg = [trackId, index, amount, latency]. Just the level: the routing (which bus, and the node
// order behind it) is setBusSends' business and is untouched here, so a swept send costs nothing
// but a .set on a control the SynthDef already lags. An index past the set currently routed is
// ignored - the send it named has gone.
OSCdef(\poptartSetBusSendAmount, { |msg|
    var key = msg[1].asSymbol, i = msg[2].asInteger, amt = msg[3].asFloat, latency = msg[4].asFloat;
    var track = tracks[key];
    if (track.isKindOf(Event) and: { i >= 0 } and: { i < (track[\busSends] ?? []).size }) {
        bundleNow.(latency, { track[\taps][("bus" ++ i).asSymbol] !? { |n| n.set(\amp, amt) } });
    };
}, '/poptart/setBusSendAmount');

OSCdef(\poptartClearBusSends, { |msg|
    var key = msg[1].asSymbol;
    var track = tracks[key];
    if (track.isKindOf(Event)) {
        (track[\busSends] ? []).size.do { |i| stripTap.(track, ("bus" ++ i).asSymbol, nil) };
        track[\busSends] !? { |prev| prev.do { |bn| releaseBus.(bn) }; track[\busSends] = nil };
        reorderTracks.(); // whatever read those buses may sit shallower now
    };
}, '/poptart/clearBusSends');

// The DJ FX send (the desk's performance-FX unit; see the fxOut/fxSend tap in the track def).
// msg = [trackId, busName, amount]. Routes the track's dedicated FX send to the named bus at
// `amount`; an empty name parks it back at trashBus. Deliberately its OWN send rather than one
// of the four .bus() slots: those are the song code's, replaced wholesale on every eval, and the
// desk's routing must survive an eval it had no part in. Acquire-before-release like
// setBusSends, so re-pointing at the same bus never briefly frees it.
OSCdef(\poptartSetFxSend, { |msg|
    var key = msg[1].asSymbol;
    var name = msg[2].asString;
    var amt = (msg[3] ? 0).asFloat;
    fork {
        var track = awaitTrack.(key);
        track !? {
            if (name.isEmpty) {
                track[\dj] !? { |n| n.set(\fxOut, routeNowhere, \fxSend, 0) };
                track[\fxBus] !? { |prev| releaseBus.(prev); track[\fxBus] = nil };
            } {
                if (track[\fxBus] != name) {
                    djNode.(track).set(\fxOut, acquireBus.(name).index, \fxSend, amt);
                    track[\fxBus] !? { |prev| releaseBus.(prev) };
                    track[\fxBus] = name;
                    reorderTracks.();
                } {
                    djNode.(track).set(\fxSend, amt); // same bus: only the level moved
                };
            };
        };
    };
}, '/poptart/setFxSend');

// MIDI from a hardware device into the plugin at `slot` (Sig#midi injector, "dev:..." source).
// Mirrors midiRoute but targets one slot's plugin and doesn't touch the track's held/env state -
// it's a side channel, like noteOnSlot. Track sources are fanned out Node-side instead (see the
// osc-engine), so only devices reach here.
OSCdef(\poptartInjectMidiDevice, { |msg|
    var targetKey = msg[1].asSymbol, slot = msg[2].asInteger, device = msg[3].asString;
    fork {
        var track = awaitTrack.(targetKey);
        if (track.notNil) {
            midiEnable.();
            (midiSourceFor.(device)) !? { |src|
                var kOn = ("poptart_mi_on_" ++ targetKey ++ "_" ++ slot).asSymbol;
                var kOff = ("poptart_mi_off_" ++ targetKey ++ "_" ++ slot).asSymbol;
                [kOn, kOff].do { |k| MIDIdef.all[k] !? { |d| d.free } };
                MIDIdef.noteOn(kOn, { |veloc, n| track[\controllers][slot] !? { |c| c.midi.noteOn(0, n, veloc) } }, srcID: src.uid);
                MIDIdef.noteOff(kOff, { |veloc, n| track[\controllers][slot] !? { |c| c.midi.noteOff(0, n, veloc) } }, srcID: src.uid);
                track[\midiInjectDefs] = track[\midiInjectDefs] ? IdentityDictionary.new;
                track[\midiInjectDefs][slot] = [kOn, kOff];
                ("poptart: midi inject: dev '" ++ device ++ "' -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
            } ?? { midiWarnMissing.("midi inject", device) };
        };
    };
}, '/poptart/injectMidiDevice');

// "a track's notes are (no longer) routed into this slot", for one of poptart's own devices.
// Only the ducker reads it (its dip fires on those notes rather than on the clock), and only
// Node knows when a route is taken away - see _tellNoteRoute in the osc-engine.
OSCdef(\poptartDeviceNoteRoute, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, routed = msg[3].asInteger > 0;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil and: { ctl.respondsTo(\noteRoute) }) { ctl.noteRoute(routed) };
}, '/poptart/deviceNoteRoute');

// "play this file on that control", for one of poptart's own devices: a granulator's sample, a
// convolver's impulse response.
//
// The buffer is one a sample pack already holds (see loadSamplePack), so nothing is read from
// disk here and nothing has to be freed - which is the whole reason the message carries a pack
// and an index rather than a path. The UGen copies the frames out of it on the non-realtime
// thread (PoptartDevice.cpp's sample stages), queued behind the pack's own read, and what the
// device plays from then on is its own copy.
//
// The last argument is the wavetable frame length the file declares, which Node reads from the
// file's header because a buffer does not keep it (0 is "the file said nothing").
OSCdef(\poptartDeviceSample, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, param = msg[3].asInteger;
    var index = msg[4].asInteger, pack = msg[5].asSymbol, file = msg[6].asInteger;
    var frameLength = (msg[7] ? 0).asInteger;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers] !? { |all| all[slot] } };
    var buf = (samplePacks[pack] ? [])[file];
    case
    { ctl.isNil or: { ctl.respondsTo(\loadSample).not } } {
        ("poptart: there is no device in slot " ++ slot ++ " of '" ++ key ++ "' to give a sample to").warn;
    }
    { buf.isNil } {
        ("poptart: '" ++ pack ++ "' has no file " ++ file ++ " to play on " ++ key ++ " slot " ++ slot).warn;
    }
    { ctl.loadSample(param, index, buf, frameLength) };
}, '/poptart/deviceSample');

// "draw this curve on that control", for one of poptart's own devices: Distort's transfer curve,
// a grain window. [key, slot, param, optionSlot, point...] - the points are the curve already
// sampled by Node (the browser engine's SHAPE_POINTS), passed straight through to the UGen.
OSCdef(\poptartDeviceShape, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, param = msg[3].asInteger;
    var index = msg[4].asInteger, points = msg.copyToEnd(5);
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers] !? { |all| all[slot] } };
    if (ctl.isNil or: { ctl.respondsTo(\loadShape).not }) {
        ("poptart: there is no device in slot " ++ slot ++ " of '" ++ key ++ "' to draw a curve on").warn;
    } {
        ctl.loadShape(param, index, points);
    };
}, '/poptart/deviceShape');

// "where is everything on that device right now": [requestId, key, slot]. Asked of the UGen
// itself (PoptartDeviceController's report), and answered INLINE rather than through replyOk's
// temp file, because a device window polls this every frame while it is open:
//   /poptart/deviceLive.data requestId count position... reportCount report...
// A count of -1 means there is no device in that slot to ask, or it did not answer.
OSCdef(\poptartDeviceLive, { |msg|
    var requestId = msg[1], key = msg[2].asSymbol, slot = msg[3].asInteger;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers] !? { |all| all[slot] } };
    if (ctl.isNil or: { ctl.respondsTo(\report).not }) {
        nodeAddr.sendMsg("/poptart/deviceLive.data", requestId, -1);
    } {
        ctl.report({ |positions, report|
            if (positions.isNil) {
                nodeAddr.sendMsg("/poptart/deviceLive.data", requestId, -1);
            } {
                nodeAddr.sendMsg("/poptart/deviceLive.data", requestId, positions.size, *(positions
                    ++ [report.size] ++ report));
            };
        });
    };
}, '/poptart/deviceLive');

OSCdef(\poptartClearMidiInject, { |msg|
    var targetKey = msg[1].asSymbol, slot = msg[2].asInteger;
    var track = tracks[targetKey];
    if (track.isKindOf(Event) and: { track[\midiInjectDefs].notNil }) {
        track[\midiInjectDefs][slot] !? { |keys|
            keys.do { |k| MIDIdef.all[k] !? { |d| d.free } };
            track[\midiInjectDefs][slot] = nil;
        };
    };
}, '/poptart/clearMidiInject');

// --- sampler ---

// The buffer a granular voice reads each side of a file from (see the poptart_sample_grain_
// defs): a mono file is both of its own sides, and a stereo one gets a one-channel copy of each,
// read from disk the first time an event asks. nil means "not yet" - the reads are asynchronous -
// and the playSample handler waits out what lead the event has rather than playing the wrong voice.
grainSidesFor = { |buf|
    var have = grainSides[buf.bufnum];
    case
    { buf.numChannels == 1 } { [buf, buf] }
    { have.isKindOf(Array) } { have }
    { have.notNil } { nil } // \loading, or \failed - which stays failed until the pack is reloaded
    {
        var done = 0, pair;
        grainSides[buf.bufnum] = \loading;
        // Buffer.read* THROWS once the allocator is empty (see loadSamplePack).
        try {
            pair = [0, 1].collect { |ch|
                Buffer.readChannel(server, buf.path, channels: [ch], action: {
                    done = done + 1;
                    if (done == 2) {
                        // The pack may have been reloaded under the reads, and taken the entry with it.
                        if (grainSides[buf.bufnum] == \loading) { grainSides[buf.bufnum] = pair } { pair.do { |b| b.free } };
                    };
                });
            };
        } {
            grainSides[buf.bufnum] = \failed;
            ("poptart: .grain(): the audio server is out of buffers - " ++ buf.path ++ " plays nothing granular until the engine restarts").warn;
        };
        nil
    };
};
freeGrainSides = { |buf|
    var have = grainSides.removeAt(buf.bufnum);
    if (have.isKindOf(Array)) { have.do { |b| b.free } };
};

// The buffer holding a grain window (Sig#grainshape), by the breakpoint JSON the event carried -
// the same x/y/c points a drawn LFO shape arrives as, turned into the same Env, and rendered here
// instead of played. -1 is GrainBuf's built-in bell: what an event with no window asks for, and
// what one whose window is still being sent gets for the few milliseconds that takes.
//
// Every edit in the shape editor is a new string and so a new buffer, and buffers are the one
// thing this server can run out of - so past a few dozen, the ones nothing has asked for lately
// go. "Lately" has to outlast the longest grain a voice could still be reading one with.
grainWindowFor = { |json|
    var have, now = Main.elapsedTime;
    if (json.size == 0) { -1 } {
        have = grainWindows[json];
        if (have.notNil) {
            have[\used] = now;
            have[\buf] !? { |b| b.bufnum } ? -1
        } {
            var points = json.parseJSON; // string values throughout - converted explicitly
            var xs = points.collect { |p| p["x"].asFloat };
            var ys = points.collect { |p| p["y"].asFloat };
            var cs = points.collect { |p| (p["c"] ? "0").asFloat };
            var times = (1..xs.size - 1).collect { |k| max(0, xs[k] - xs[k - 1]) };
            var entry = (used: now, buf: nil);
            grainWindows[json] = entry;
            Buffer.sendCollection(server, Env(ys, times, cs.copyRange(0, cs.size - 2)).asSignal(grainWindowFrames), 1,
                action: { |b| entry[\buf] = b });
            if (grainWindows.size > 48) {
                grainWindows.keys.copy.do { |k|
                    var e = grainWindows[k];
                    if ((now - e[\used]) > 30) { e[\buf] !? { |b| b.free }; grainWindows.removeAt(k) };
                };
            };
            -1
        };
    };
};

// Reads a pack's files (enumerated Node-side, filename order) into buffers and replies with
// per-file metadata - Node needs frames/sampleRate for the fit/one-shot-duration math it does
// per event. A file scsynth can't read still occupies its index (frames 0), so pack indices
// stay aligned with the sorted file list; Node skips zero-duration entries.
// The paths list arrives as a temp-file path, not inline JSON - same datagram-size reasoning
// as replyOk above, in the other direction (a big pack's path list is ~70KB).
OSCdef(\poptartLoadSamplePack, { |msg|
    var requestId = msg[1], pack = msg[2].asSymbol, pathsFile = msg[3].asString;
    fork {
        var paths = File.use(pathsFile, "r", { |f| f.readAllString }).parseJSON;
        var done = 0, tries = 0, bufs = [], starved = false;
        File.delete(pathsFile);
        samplePacks[pack] !? { |old| old.do { |b| freeGrainSides.(b); b.free } };
        // Buffer.read THROWS once the buffer allocator is empty, which would kill this routine and
        // leave Node waiting out its whole 2-minute timeout for a reply that never comes. Catch it,
        // and turn a library too big for numBuffers above into an immediate, explicable failure.
        paths.do { |p|
            if (starved.not) {
                try {
                    bufs = bufs.add(Buffer.read(server, p.asString, action: { done = done + 1 }));
                } { starved = true };
            };
        };
        // Cap just under Node's PACK_LOAD_TIMEOUT_MS so a partial read still replies in time.
        while { (done < bufs.size) and: { tries < 2200 } } { 0.05.wait; tries = tries + 1 };
        if (starved) {
            // Waited for the in-flight reads above first, so freeing here can't race their /done.
            bufs.do { |b| freeGrainSides.(b); b.free };
            samplePacks[pack] = nil;
            replyErr.("/poptart/loadSamplePack", requestId,
                "the audio server ran out of buffers loading " ++ paths.size ++ " file(s) ("
                ++ bufs.size ++ " read before it gave out) - other packs already loaded this "
                ++ "session hold the rest. Restart the engine, or raise numBuffers in poptart.scd.");
        } {
            samplePacks[pack] = bufs;
            ("poptart: sample pack '" ++ pack ++ "': " ++ done ++ "/" ++ bufs.size ++ " file(s) read").postln;
            replyOk.("/poptart/loadSamplePack", requestId, toJson.(bufs.collect { |b|
                (frames: b.numFrames ? 0, sampleRate: b.sampleRate ? 0, channels: b.numChannels ? 0, bufnum: b.bufnum)
            }));
        };
    };
}, '/poptart/loadSamplePack');

// One sample event. Node already resolved slices/fit down to begin/end/rate/dur; this picks the
// right voice def for (loop, stretch, channels), spawns it into the track group writing to the
// track's input bus, and mirrors the note handlers' env-gate/lfo-retrigger behavior so param
// modulators treat sample onsets like notes. Loops - and gate-mode one-shots (cut == 1, from a
// .vel()/.note() pattern) - get a sample-accurate gate-off bundle at the event's end; other
// one-shots free themselves after dur. amp scales the voice linearly (velocity).
OSCdef(\poptartPlaySample, { |msg|
    var key = msg[1].asSymbol, pack = msg[2].asSymbol, idx = msg[3].asInteger;
    var begin = msg[4].asFloat, end = msg[5].asFloat, loop = msg[6].asInteger;
    var rate = msg[7].asFloat, stretch = msg[8].asFloat, dur = msg[9].asFloat;
    var latency = msg[10].asFloat, stopLatency = msg[11].asFloat;
    var amp = (msg[12] ? 1).asFloat, cut = (msg[13] ? 0).asInteger;
    // ADSR envelope: atk/dec/rel are seconds (Node applies .envscale()), sus is a 0..1 level.
    // Defaults of 0/0/1/0 floor down to the old declick env inside the synthdef (Node sends an
    // unset release as 50ms, so the 0 here is only ever a message without one).
    var atk = (msg[14] ? 0).asFloat, dec = (msg[15] ? 0).asFloat;
    var sus = (msg[16] ? 1).asFloat, rel = (msg[17] ? 0).asFloat;
    // Loop shape (only read by the loop defs): the region it runs round, where it enters, and
    // whether it bounces off the edges instead of wrapping. See .loop()'s wrap/dir options.
    var loopLo = (msg[18] ? 0).asFloat, loopHi = (msg[19] ? 1).asFloat;
    var entry = (msg[20] ? 0).asFloat, pingpong = (msg[21] ? 0).asInteger;
    // The granular voice (Sig#grain): size/rate/pan are this onset's values of controls the voice
    // reads live, posLive says its position is one of them too, and the window is breakpoint JSON.
    var grain = (msg[22] ? 0).asInteger;
    var grainSize = (msg[23] ? 0.08).asFloat, grainRate = (msg[24] ? 20).asFloat, grainPan = (msg[25] ? 0).asFloat;
    var posLive = (msg[26] ? 0).asInteger, windowJson = (msg[27] ? "").asString;
    var arrived = Main.elapsedTime;
    var args, spawn;
    var track = tracks[key];
    var bufs = samplePacks[pack];
    var buf = bufs !? { bufs.wrapAt(idx) };
    var warp = (stretch - 1).abs > 1e-4;
    var gated = (loop == 1) or: { cut == 1 };
    var defName, synth;
    if (track.isKindOf(Event) and: { buf.notNil } and: { (buf.numFrames ? 0) > 0 }) {
      // `sides` is the granular voice's buffer pair (see grainSidesFor), nil for every other voice.
      spawn = { |latency, stopLatency, sides|
        defName = if (sides.notNil) {
            ("poptart_sample_grain_" ++ if (buf.numChannels == 1) { 1 } { 2 }).asSymbol
        } {
            ("poptart_sample_" ++ (if (warp) { "warp_" } { "" })
                ++ (if (loop == 1) { "loop_" } { "" }) ++ buf.numChannels).asSymbol
        };
        heldBy.(track, 1);
        args = if (sides.notNil) {
            var bus = track[\grainBus].index;
            [\out, track[\inBus].index, \bufL, sides[0], \bufR, sides[1], \begin, begin,
             \rate, rate, \gate, 1, \amp, amp, \atk, atk, \dec, dec, \sus, sus, \rel, rel,
             \bend, track[\bendBus].asMap, \posLive, posLive, \win, grainWindowFor.(windowJson),
             // Mapped, like bend, and in the bus's own order (see buildTrackDef's ReplaceOut).
             \grainpos, ("c" ++ bus).asSymbol, \grainsize, ("c" ++ (bus + 1)).asSymbol,
             \grainrate, ("c" ++ (bus + 2)).asSymbol, \grainpan, ("c" ++ (bus + 3)).asSymbol]
        } {
          [\out, track[\inBus].index, \buf, buf, \begin, begin, \end, end,
                \rate, rate, \dur, dur, \gate, 1, \amp, amp,
                \atk, atk, \dec, dec, \sus, sus, \rel, rel,
                // Pitch bend (Sig#bend) as a MAP rather than a value: the voice reads the track's
                // bend bus for as long as it sounds, so a curve drawn across a bar bends a hit that
                // started before it. Mapped in the creation message itself (Bus#asMap is the "c7"
                // spelling the server reads as "follow this bus"), which is what keeps a voice from
                // ever sounding one block unbent.
                \bend, track[\bendBus].asMap]
        };
        // Only the loop defs have these controls - appended just for them rather than sent to a
        // one-shot def that would ignore them (and log a "control not found" for each).
        if (loop == 1 and: { sides.isNil }) {
            args = args ++ [\loopLo, loopLo, \loopHi, loopHi, \entry, entry, \pingpong, pingpong];
        };
        bundleNow.(latency, {
            if (sides.notNil) {
                // The voice's first grain fires with it, a block before the track synth next
                // republishes these - so the bus is seeded with this onset's own values, ahead of
                // the voice in the same bundle, and the track synth told the same so the value
                // holds. On a control a modulator is mapped onto, the set is simply never read.
                track[\grainBus].setn([if (posLive == 1) { begin } { 0 }, grainSize, grainRate, grainPan]);
                track[\head].set(\grainsize, grainSize, \grainrate, grainRate, \grainpan, grainPan);
                if (posLive == 1) { track[\head].set(\grainpos, begin) };
            };
            synth = Synth(defName, args, target: track[\voices] ? track[\group], addAction: \addToHead);
            voiceBorn.(synth); // ...and the oldest one goes if the engine is already full
            track[\envs].do { |e| e[\synth].set(\gate, 1, \t_retrig, 1) };
            track[\lfos].do { |e|
                if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
            };
        });
        if (gated) {
            bundleNow.(stopLatency, { synth.set(\gate, 0) });
        };
        SystemClock.sched(if (gated) { stopLatency } { latency + dur }, {
            voiceDone.(synth);
            heldBy.(track, -1);
            if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
            nil
        });
      };
      if (grain == 1) {
        var sides = grainSidesFor.(buf);
        if (sides.notNil) { spawn.(latency, stopLatency, sides) } {
            // A stereo file's first granular event: its sides are being read. Events arrive a
            // lookahead early and a read is a few milliseconds, so wait out the lead it has - and
            // play nothing if that isn't enough, since the plain voice is a different sound
            // entirely, not a quieter version of this one.
            fork {
                var spent = 0;
                while { sides.isNil and: { spent < (latency - 0.02) } } {
                    0.01.wait;
                    sides = grainSidesFor.(buf);
                    spent = Main.elapsedTime - arrived;
                };
                if (sides.notNil) { spawn.(latency - spent, stopLatency - spent, sides) };
            };
        };
      } { spawn.(latency, stopLatency, nil) };
    };
}, '/poptart/playSample');

// --- song decks ---
// A full-length audio file on a DJ deck track (server.js's song section drives these). The
// file loads into ONE buffer per track; a persistent poptart_song_* synth walks it into the
// track's input bus. Node owns all the musical bookkeeping (position, quantized starts, the
// end-of-file pause) - these handlers only hold the buffer and the synth.

// A quantized start spawns its player in a FUTURE-timestamped bundle - until that moment the
// node does not exist on scsynth, and any message aimed at it earlier fails ("Node not found")
// while the spawn then lands anyway: an unpaused, unreleased orphan layered under the next
// player (reported 2026-08-25 - re-cueing before the boundary stacked copies of the song).
// So every message at a player goes through this clamp: no earlier than just after the spawn
// time songStart recorded (0.02 covers the clock jitter between recording and comparing).
songLat = { |song, latency|
    max(latency ? 0, (song[\spawnUntil] ? 0) - Main.elapsedTime + 0.02);
};

// Load (or replace) a track's song: [requestId, key, path]. Replies with the buffer's shape so
// Node can compute duration and schedule ends. Any playing synth for the old file is freed
// first - a load IS a stop.
OSCdef(\poptartSongLoad, { |msg|
    var requestId = msg[1], key = msg[2].asSymbol, path = msg[3].asString;
    fork {
        var old = songs[key], buf, done = false, tries = 0;
        old !? {
            var lat = songLat.(old, 0);
            // Released (declicked) rather than hard-freed, at the clamped time - the old player
            // may be a pending quantized start. Its buffer outlives the release fade.
            old[\synth] !? { |s| bundleNow.(lat, { s.set(\gate, 0) }) };
            old[\posFunc] !? { |f| f.free };
            songs[key] = nil;
            old[\buf] !? { |b| fork { (lat + 0.2).wait; b.free } };
        };
        try {
            buf = Buffer.read(server, path, action: { done = true });
        } { |err|
            replyErr.("/poptart/songLoad", requestId, "couldn't read " ++ path ++ ": " ++ err.errorString);
            buf = nil;
        };
        buf !? {
            // Same cap style as loadSamplePack: reply inside Node's timeout even on a failure.
            while { done.not and: { tries < 1100 } } { 0.05.wait; tries = tries + 1 };
            if (done.not or: { (buf.numFrames ? 0) <= 0 }) {
                buf.free;
                replyErr.("/poptart/songLoad", requestId, "couldn't read " ++ path ++ " (not an audio file scsynth can decode?)");
            } {
                songs[key] = (buf: buf, synth: nil);
                ("poptart: song loaded on " ++ key ++ ": " ++ path).postln;
                replyOk.("/poptart/songLoad", requestId, toJson.((
                    frames: buf.numFrames ? 0, sampleRate: buf.sampleRate ? 0, channels: buf.numChannels ? 0, bufnum: buf.bufnum
                )));
            };
        };
    };
}, '/poptart/songLoad');

// Start (or restart) playback: [key, posSec, rate, latency]. Spawns the player at the track
// group's head (the track synth at the tail mixes the input bus) in a timestamped bundle, so a
// cycle-quantized start lands sample-accurately. An already-running player is replaced - a
// start is also how a hard seek-while-playing could be done, but songSeek below is the
// click-free path for that.
OSCdef(\poptartSongStart, { |msg|
    var key = msg[1].asSymbol, posSec = msg[2].asFloat;
    var rate = msg[3].asFloat, latency = max(msg[4].asFloat, 0);
    var warp = (msg[5] ? 0).asInteger; // 1 = keylock player, 0 = repitch (BufRd)
    var track = tracks[key], song = songs[key];
    if (track.isKindOf(Event) and: { song.notNil }) {
        var buf = song[\buf];
        var defName = ((if (warp > 0) { "poptart_songwarp_" } { "poptart_song_" }) ++ buf.numChannels).asSymbol;
        // The keylock player has a pipeline delay (~rbDelay, see the boot probe): it is spawned
        // that much EARLY with its pointer set back by as much, so its first real sample lands
        // at the start. When the start is closer than that (a keylock toggle is "now"), it
        // spawns now and the old player instead holds on for the difference - the handover
        // then happens on time, a pipeline later. The repitch player has no delay: spawnAt is
        // the start and the handover is immediate, as before.
        var rbLat = if (warp > 0) { (~rbDelay ? 0) / server.sampleRate } { 0 };
        var spawnAt = max(0, latency - rbLat);
        var seekSec = posSec - ((latency - spawnAt) * rate);
        var handover = max(latency, spawnAt + rbLat);
        var frame = (seekSec * (buf.sampleRate ? server.sampleRate)).clip(0, max(0, (buf.numFrames ? 1) - 1));
        // The old player releases AT THE HANDOVER (clamped past its own spawn - it may itself
        // still be a pending quantized start): released, not freed, so it fades under the new one.
        song[\synth] !? { |s| bundleNow.(songLat.(song, handover), { s.set(\gate, 0) }) };
        song[\posFunc] !? { |f| f.free };
        song[\spawnUntil] = Main.elapsedTime + spawnAt;
        bundleNow.(spawnAt, {
            song[\synth] = Synth(defName,
                [\out, track[\inBus].index, \buf, buf, \rate, rate, \run, 1,
                 \t_seek, 1, \seekFrame, frame, \delay, if (warp > 0) { ~rbDelay ? 0 } { 0 }],
                target: track[\group], addAction: \addToHead);
        });
        // The player's position reports answer to sclang; forward them to Node tagged with the
        // track (the message itself carries only the node id) - the drift servo's actual-side.
        song[\posFunc] = OSCFunc({ |m|
            nodeAddr.sendMsg('/poptart/songPos', key, m[3].asFloat);
        }, '/poptart/songPos', server.addr, argTemplate: [song[\synth].nodeID]);
    };
}, '/poptart/songStart');

// Set one control on the running player: [key, name, value, latency]. `run` 0/1 is
// pause/resume; `rate` is the tempo-sync/nudge handle.
OSCdef(\poptartSongSet, { |msg|
    var key = msg[1].asSymbol, name = msg[2].asSymbol;
    var value = msg[3].asFloat, latency = msg[4].asFloat;
    songs[key] !? { |song|
        song[\synth] !? { |s| bundleNow.(songLat.(song, latency), { s.set(name, value) }) };
    };
}, '/poptart/songSet');

// Seek the running player: [key, posSec, latency]. One set so the frame and its trigger can't
// arrive apart (Phasor applies resetPos only on the t_seek trigger).
OSCdef(\poptartSongSeek, { |msg|
    var key = msg[1].asSymbol, posSec = msg[2].asFloat, latency = msg[3].asFloat;
    songs[key] !? { |song|
        var buf = song[\buf];
        var frame = (posSec * (buf.sampleRate ? server.sampleRate)).clip(0, max(0, (buf.numFrames ? 1) - 1));
        song[\synth] !? { |s| bundleNow.(songLat.(song, latency), { s.set(\seekFrame, frame, \t_seek, 1) }) };
    };
}, '/poptart/songSeek');

// Stop playback (declicked via the player's gate); the buffer stays for the next start:
// [key, latency].
OSCdef(\poptartSongStop, { |msg|
    var key = msg[1].asSymbol, latency = msg[2].asFloat;
    songs[key] !? { |song|
        song[\synth] !? { |s| bundleNow.(songLat.(song, latency), { s.set(\gate, 0) }) };
        song[\synth] = nil;
        song[\posFunc] !? { |f| f.free };
        song[\posFunc] = nil;
    };
}, '/poptart/songStop');

// Unload the song entirely: player released, buffer freed. The track itself stays (it's
// destroyTrack's to take down): [key].
OSCdef(\poptartSongFree, { |msg|
    var key = msg[1].asSymbol;
    songs[key] !? { |song|
        var lat = songLat.(song, 0);
        song[\synth] !? { |s| bundleNow.(lat, { s.set(\gate, 0) }) };
        song[\posFunc] !? { |f| f.free };
        songs[key] = nil;
        // The buffer waits out the clamped release fade - freeing it under a player still
        // fading (or still pending its spawn) would leave that player reading a dead buffer.
        song[\buf] !? { |b| fork { (lat + 0.2).wait; b.free } };
    };
}, '/poptart/songFree');

// --- introspection ---

OSCdef(\poptartGetParams, { |msg|
    var requestId = msg[1], key = msg[2].asSymbol, slot = msg[3].asInteger;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.isNil or: { ctl.info.isNil }) {
        replyErr.("/poptart/getParams", requestId, "no plugin loaded in that slot");
    } {
        var params = ctl.info.parameters.collect { |p, i|
            (name: p.name, label: p.label ? "", index: i)
        };
        replyOk.("/poptart/getParams", requestId, toJson.(params));
    };
}, '/poptart/getParams');

OSCdef(\poptartShowPluginEditor, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) { ctl.editor };
}, '/poptart/showPluginEditor');

// "stop changing this slot's program." A scheduled restore sits on the clock until its onset (see
// \poptartSetPluginState), so a slot taken over by hand has to be able to drop the swap that was
// already on its way. Raising the sequence is all it takes - the waiting restore checks it before
// applying and deletes its file instead. Nothing is loaded in its place, on purpose: the plugin
// goes on sounding exactly as whoever is turning its knobs left it.
OSCdef(\poptartCancelPluginState, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, seq = msg[3].asInteger;
    var seqKey = (key ++ "_" ++ slot).asSymbol;
    if (seq > (stateSeqs[seqKey] ? 0)) {
        stateSeqs[seqKey] = seq;
        // The load is off, so anything waiting for it is waiting for nothing - play it now.
        statePending[seqKey] !? { |p| clearPending.(seqKey, p[\seq]) };
    };
}, '/poptart/cancelPluginState');

// "conf" (configure) capture on/off for a track. When on, each open plugin's parameterAutomated
// hook (set in loadInstrument/loadEffect) forwards GUI knob moves to Node; off, they stay quiet.
// The track may not exist yet (conf clicked after a restart but before the first eval), so wait
// for it rather than dropping the flag. confWant holds the latest requested state per track:
// every waiting fork applies that instead of its own captured arg, so an on->off flip while the
// track is still being built resolves to the last click no matter which fork wakes first.
OSCdef(\poptartSetConfMode, { |msg|
    var key = msg[1].asSymbol, on = msg[2].asInteger;
    confWant[key] = (on == 1);
    fork {
        var track = awaitTrack.(key, 30);
        if (track.notNil) {
            track[\confMode] = confWant[key];
            ("poptart: conf capture " ++ if (confWant[key]) { "ON" } { "OFF" }
                ++ " for track " ++ key).postln;
        } {
            ("poptart: conf: track '" ++ key ++ "' never appeared - conf not armed"
                ++ " (evaluate the pattern, then toggle conf again)").warn;
        };
    };
}, '/poptart/setConfMode');

// --- plugin state (synth("Serum 2", { state }) round-trip - see OscEngine's gz64 framing) ---

// Capture: write the slot's full program (VSTPlugin's own file format) to a temp file and
// reply with its path; Node reads/deletes/compresses it.
OSCdef(\poptartGetPluginState, { |msg|
    var requestId = msg[1], key = msg[2].asSymbol, slot = msg[3].asInteger;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.isNil or: { ctl.info.isNil }) {
        replyErr.("/poptart/getPluginState", requestId, "no plugin loaded in that slot");
    } {
        var path = PathName.tmp +/+ ("poptart-state-" ++ requestId ++ ".fxp");
        ctl.writeProgram(path, action: { |self, ok|
            if (ok) {
                replyOk.("/poptart/getPluginState", requestId, toJson.((path: path)));
            } {
                replyErr.("/poptart/getPluginState", requestId, "writeProgram failed");
            };
        });
    };
}, '/poptart/getPluginState');

// Restore: the state arrives as a program file path (Node already unpacked it). The slot's
// plugin load is fire-and-forget and possibly still in flight, so wait for it before applying -
// this is what makes `synth("Serum 2", { state })` deterministic on a cold start.
//
// msg[4] is an optional latency in seconds: a patterned .preset("<a b>") schedules its swaps a
// lookahead early (like every other event), so the program has to be held until its onset. Not a
// server bundle - readProgram is a call on the plugin, not a message to scsynth - so the wait is
// a clock wait here, ahead of the load. Absent or 0 means now, which is what a `{ state }`
// restore wants.
OSCdef(\poptartSetPluginState, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, path = msg[3].asString;
    var latency = if (msg.size > 4) { msg[4].asFloat } { 0 };
    var seq = if (msg.size > 5) { msg[5].asInteger } { 0 };
    var seqKey = (key ++ "_" ++ slot).asSymbol;
    var apply = {
        // Superseded while it waited: a newer restore for this slot has been sent, so this program
        // is no longer what the slot should be holding. Its file still has to go.
        if (stateSeqs[seqKey] != seq) { File.delete(path) } {
        fork {
            var track = awaitTrack.(key);
            var ctl;
            if (track.notNil and: { awaitLoaded.(track, slot) }) {
                ctl = track[\controllers][slot];
                // From here until a little after it lands, whatever this plugin says about itself
                // is this program arriving, not a pair of hands (see selfLoads).
                beginSelfLoad.(seqKey);
                ctl.readProgram(path, action: { |self, ok|
                    if (ok) {
                        ("poptart: restored plugin state for " ++ key ++ " slot " ++ slot).postln;
                    } {
                        ("poptart: FAILED to restore plugin state for " ++ key ++ " slot " ++ slot).warn;
                    };
                    endSelfLoad.(seqKey);
                    clearPending.(seqKey, seq);
                    File.delete(path);
                    // Node marks a program as sent the moment it sends it; this is what lets it
                    // know the program is IN, which nothing else reports (see OscEngine#setPluginState).
                    nodeAddr.sendMsg("/poptart/stateLanded", key, slot, seq, ok.binaryValue);
                });
            } {
                nodeAddr.sendMsg("/poptart/stateLanded", key, slot, seq, 0);
                ("poptart: setPluginState: no loaded plugin in " ++ key ++ " slot " ++ slot).warn;
                clearPending.(seqKey, seq); // nothing to load into: don't hold its notes back
                File.delete(path);
            };
        }};
    };
    // Recorded at RECEIPT, not at apply time: that is what lets a message sent later cancel one
    // still waiting. A restore that is already stale on arrival (out of order) never runs at all.
    // Cold = the slot's plugin is not open yet (a new song coming up): the hold covers the whole
    // open+load and its release DROPS the missed notes - silence, then a clean join - where a
    // warm swap holds briefly and flushes (see stateWaitMax/clearPending).
    var cold = tracks[key].isKindOf(Event).not or: { tracks[key][\loaded][slot].isNil };
    if (seq >= (stateSeqs[seqKey] ? 0)) {
        stateSeqs[seqKey] = seq;
        // Same reason, for the notes: a swap and the notes at its onset are sent together, a
        // lookahead early, and a note is a timestamped bundle the moment it is handled - so "a load
        // is coming at this time" has to be true HERE, not when the load starts (see waitForLoad).
        statePending[seqKey] = (seq: seq, at: Main.elapsedTime + latency, cold: cold);
        // The notes waiting on this load are released the moment the program is in - or by this,
        // whatever the plugin does or fails to do (for a cold load, a pure stuck-open/stuck-load
        // failsafe covering the whole open+load; the apply below clears the pending itself on
        // every path).
        SystemClock.sched(latency + if (cold) { openWaitMax + coldWaitMax } { stateWaitMax }, { clearPending.(seqKey, seq); nil });
        if (latency > 0) { SystemClock.sched(latency, { apply.value; nil }) } { apply.value };
    } {
        File.delete(path);
    };
}, '/poptart/setPluginState');

// The swap's shadow, sent synchronously the moment Node's setPluginState is CALLED - the program
// itself follows on '/poptart/setPluginState' only after Node has resolved, inflated and written
// it, which is async, while the notes at the swap's onset are sent on the very stack that emitted
// the swap. Without this, those notes always arrive first, find nothing pending, and are bundled
// straight through the load that then wipes them. Carries no program: it just makes "a load is
// coming at this time" true before the notes ask (see waitForLoad), under the same seq so a
// cancel or a newer restore supersedes both halves together. If the program never follows (a
// failed inflate, superseded mid-write), the timeout below releases the notes - late is a bug,
// stuck is a disaster.
OSCdef(\poptartStatePending, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger;
    var latency = msg[3].asFloat, seq = msg[4].asInteger;
    var seqKey = (key ++ "_" ++ slot).asSymbol;
    var cold = tracks[key].isKindOf(Event).not or: { tracks[key][\loaded][slot].isNil }; // see setPluginState
    if (seq >= (stateSeqs[seqKey] ? 0)) {
        stateSeqs[seqKey] = seq;
        statePending[seqKey] = (seq: seq, at: Main.elapsedTime + latency, cold: cold);
        SystemClock.sched(latency + if (cold) { openWaitMax + coldWaitMax } { stateWaitMax }, { clearPending.(seqKey, seq); nil });
    };
}, '/poptart/statePending');

OSCdef(\poptartScanPlugins, { |msg|
    var requestId = msg[1];
    // extraPaths (msg[2], JSON array) not wired through yet; POPTART_VST_DIRS covers the
    // custom-directory need for now.
    runScan.({
        replyOk.("/poptart/scanPlugins", requestId, toJson.((plugins: pluginList.(), crashed: [])));
    });
}, '/poptart/scanPlugins');

// --- per-track recording (see wav.js and web-app's track-record section) ---

// Tap a track's post-fader output: a private bus, the track synth's rec send pointed at it, and a
// meter synth streaming peaks to Node for the editor's record panel. Idempotent - opening the
// panel, arming, and recording all call it, and only the first does anything.
startTap = { |key|
    var track = tracks[key];
    var entry = recTaps[key];
    if (entry.isNil and: { track.isKindOf(Event) }) {
        var bus = Bus.audio(server, 2);
        entry = (bus: bus, meter: nil, disk: nil, buf: nil, path: nil, meterFunc: nil);
        recTaps[key] = entry;
        stripTap.(track, \rec, bus.index, 1, 0);
        entry[\meter] = Synth(\poptart_rec_meter, [\bus, bus.index],
            target: recGroup, addAction: \addToTail);
        // The reply answers to sclang, not to Node - forward it on, tagged with the track it came
        // from (the message itself only carries the node id). SendPeakRMS lays its values out as
        // [nodeID, replyID, peakL, rmsL, peakR, rmsR]. Both peak AND rms go on: their ratio is the
        // crest factor, which is what lets the editor colour a transient differently from a pad.
        entry[\meterFunc] = OSCFunc({ |m|
            nodeAddr.sendMsg('/poptart/recLevel', key,
                max(m[3].asFloat, m[5].asFloat), max(m[4].asFloat, m[6].asFloat));
        }, '/poptart/recLevel', server.addr, argTemplate: [entry[\meter].nodeID]);
    };
    entry;
};

// Undo startTap. Frees an in-flight bounce too: a cancelled recording's file is closed (so it
// isn't left open on disk) and simply never trimmed.
stopTap = { |key|
    recTaps[key] !? { |entry|
        var track = tracks[key];
        if (track.isKindOf(Event)) { stripTap.(track, \rec, nil) };
        entry[\meterFunc] !? { |f| f.free };
        entry[\meter] !? { |m| m.free };
        entry[\disk] !? { |d| d.free };
        // Same close-then-free ordering as the record path (see there for why it can't be nested).
        // No sync here: a cancelled capture's file is never read, so the two just go out in order.
        entry[\buf] !? { |b| b.close; b.free };
        entry[\bus].free;
        recTaps[key] = nil;
    };
};

OSCdef(\poptartTapTrack, { |msg|
    var key = msg[1].asSymbol, on = msg[2].asInteger;
    fork {
        if (on == 1) { awaitTrack.(key); startTap.(key) } { stopTap.(key) };
    };
}, '/poptart/tapTrack');

// --- global mixer monitoring (the editor's mixer modal - see web-app's mixer section) ---

// The analysis SynthDef, built lazily from the band centers Node sends with the on message so
// the frequencies the client draws are by construction the ones being measured. One instance per
// tapped track plus one on hardware bus 0 (the master sum). Two feeds per instance:
//   - SendPeakRMS at 20/sec, the recorder meter's own UGen, kept per-channel here
//     ([peakL, rmsL, peakR, rmsR]) so the strips can meter L and R separately;
//   - a band analyzer at 20/sec, laid out [l, r, mid, side] per band (MIX_SPEC_VALUES_PER_BAND in
//     ../index.js): PoptartSpectrum (native/devices/PoptartSpectrum.cpp), the browser's own
//     measurement - a 4096-point transform each of left, right, mid and side, every band the mean
//     bin magnitude between its neighbors - so the two builds draw the same strip. Four transforms
//     twenty times a second is a small fraction of what the bandpass bank it replaced cost (96
//     filter pairs and 384 followers, ~1.6% of a core a track), so every playing track gets one.
//     Without the device extension the bank is still built, as before.
buildMixDef = { |freqs|
    mixBandFreqs = freqs;
    SynthDef(\poptart_mix_analysis, {
        // The frame clock is the FIRST UGen on purpose, and the bus a body control rather than
        // an argument. sclang's graph sort is a stack seeded with the antecedent-free UGens in
        // reverse creation order: created anywhere later, the Impulse sinks under In and the
        // 192 filters get scheduled before it, every follower has to wait for it, and all 384
        // filtered signals are live at once - past scsynth's default 64 wire buffers, so the
        // def silently fails to load ("exceeded number of interconnect buffers"). Created first
        // it is popped first, and the sort interleaves filter and follower as before (6 live).
        var frame = Impulse.kr(20);
        var sig = In.ar(\bus.kr, 2);
        if (\PoptartSpectrum.asClass.notNil) {
            \PoptartSpectrum.asClass.ar(sig, 20, freqs);
        } {
            mixBank.(sig, frame, freqs);
        };
        SendPeakRMS.kr(sig, 20, 3, '/poptart/mixLevel');
    }).add;
    SynthDef(\poptart_mix_meter, { |bus|
        SendPeakRMS.kr(In.ar(bus, 2), 20, 3, '/poptart/mixLevel');
    }).add;
};

// The bandpass bank the analyzer was before PoptartSpectrum, for an engine without the device
// extension: one constant-Q bandpass pair per center, a per-frame peak of each.
mixBank = { |sig, frame, freqs|
    var amps = freqs.collect { |f|
        var band = BPF.ar(sig, f, 0.1);
        var l = band[0], r = band[1];
        [l, r, (l + r) * 0.5, (l - r) * 0.5].collect { |x| Peak.kr(x, frame) };
    };
    SendReply.kr(frame, '/poptart/mixSpec', amps.flat);
};

// Both replies answer to sclang and carry only a node id - forward them to Node tagged with the
// key they meter ("*" for the master; a track label can't collide with it, labels are
// identifiers). Layouts as the rec meter documents: [nodeID, replyID, values...], values from
// m[3] with m[0] the address. A meter-only synth has no band frames to forward.
mixForwards = { |key, synth, full = true|
    var funcs = [
        OSCFunc({ |m|
            nodeAddr.sendMsg('/poptart/mixLevel', key, m[3], m[4], m[5], m[6]);
        }, '/poptart/mixLevel', server.addr, argTemplate: [synth.nodeID])
    ];
    if (full) {
        funcs = funcs.add(OSCFunc({ |m|
            nodeAddr.performList(\sendMsg, ['/poptart/mixSpec', key] ++ m.copyRange(3, m.size - 1));
        }, '/poptart/mixSpec', server.addr, argTemplate: [synth.nodeID]));
    };
    funcs
};

// Tap one track for the mixer: private bus, the track's mix send pointed at it, an analysis
// synth reading it (the full analyzer, or the meter-only def when `full` is false). Idempotent,
// and independent of the recorder's tap (separate send args), so an open record panel and the
// mixer never fight over one bus.
startMixTap = { |key, full = true|
    var track = tracks[key];
    if (mixTaps[key].isNil and: { track.isKindOf(Event) }) {
        var bus = Bus.audio(server, 2);
        var synth = Synth(if (full) { \poptart_mix_analysis } { \poptart_mix_meter }, [\bus, bus.index],
            target: recGroup, addAction: \addToTail);
        stripTap.(track, \mix, bus.index, 1, 0);
        mixTaps[key] = (bus: bus, synth: synth, funcs: mixForwards.(key, synth, full), full: full);
    };
};

stopMixTap = { |key|
    mixTaps[key] !? { |entry|
        var track = tracks[key];
        if (track.isKindOf(Event)) { stripTap.(track, \mix, nil) };
        entry[\funcs].do { |f| f.free };
        entry[\synth].free;
        entry[\bus].free;
        mixTaps[key] = nil;
    };
};

stopMixMaster = {
    mixMaster !? { |m|
        m[\funcs].do { |f| f.free };
        m[\synth].free;
        mixMaster = nil;
    };
};

// Bring the taps to what Node last asked for: every wanted track that exists gets a tap of the
// current kind (a tap of the other kind is replaced), everything else is taken down, and the
// master analyzer runs while on. Synths are started a beat apart rather than in one message:
// each analyzer is close to a thousand UGens, and scsynth builds a graph on the audio thread, so
// ten of them landing in one block was itself a dropout before the first frame was measured.
// One reconcile runs at a time; a request arriving mid-run (a track born during the stagger)
// marks it dirty and the loop goes round again against the newest description.
mixReconcile = {
    if (mixReconciling) { mixDirty = true } {
        fork {
            mixReconciling = true;
            mixDirty = true;
            while { mixDirty } {
                mixDirty = false;
                mixTaps.keys.do { |key|
                    if (mixWanted.includes(key).not) {
                        stopMixTap.(key);
                    };
                };
                if (mixOn.not) { stopMixMaster.() };
                mixWanted.do { |key|
                    if (mixOn and: { mixTaps[key].isNil } and: { tracks[key].isKindOf(Event) }) {
                        startMixTap.(key);
                        0.02.wait;
                    };
                };
                if (mixOn and: { mixMaster.isNil }) {
                    var synth = Synth(\poptart_mix_analysis, [\bus, 0],
                        target: recGroup, addAction: \addToTail);
                    mixMaster = (synth: synth, funcs: mixForwards.("*", synth));
                };
            };
            mixReconciling = false;
        };
    };
};

// Mixer on/off. On: [1, bandCentersJSON, trackIdsJSON] - (re)build the analyzer if the
// band list changed, tearing down any running analysis synths first (they were built against the
// old def), then reconcile to the track list. Node re-sends whenever the playing set changes.
// Off: tear it all down and re-park the sends. Idempotent both ways.
OSCdef(\poptartMixMeters, { |msg|
    var on = msg[1].asInteger;
    fork {
        if (on == 1) {
            var freqs = msg[2] !? { |j| j.asString.parseJSON };
            var wanted = msg[3] !? { |j| j.asString.parseJSON };
            // parseJSON hands numbers back as strings (and nil on garbage) - normalize to floats,
            // and never build an analyzer with no bands.
            freqs = (freqs ? []).collect(_.asFloat);
            if (freqs.isEmpty) { freqs = [200.0, 2000.0, 8000.0] };
            if (mixBandFreqs != freqs) {
                mixTaps.keys.do { |key| stopMixTap.(key) };
                stopMixMaster.();
                buildMixDef.(freqs);
                server.sync;
            };
            mixOn = true;
            mixWanted = IdentitySet.newFrom((wanted ? []).collect(_.asSymbol));
        } {
            mixOn = false;
            mixWanted = IdentitySet.new;
        };
        mixReconcile.();
    };
}, '/poptart/mixMeters');

// --- the editor's inline audio displays ('/poptart/viewTaps' - .scope(), .spectrum() and the
// rest; see osc-engine/view-taps.js) -------------------------------------------------------------
//
// Per tapped track, or the master (key '*'): a copy of the strip's output onto a private bus (a
// strip tap of its own, \view - see stripTap), a stereo ring of that bus's latest samples with the
// newest frame's index on a control bus, and an FFT buffer when a spectrum is drawn of it. Node
// reads the buffers straight from scsynth with /b_getn; this side only builds and frees them, so
// no frame ever passes through here. All of it is one event and one statement: `wanted` is what
// Node last asked for (key -> whether it wants the FFT), `taps` what exists.
{
viewTap = (
    taps: IdentityDictionary.new, wanted: IdentityDictionary.new, on: false,
    busy: false, dirty: false, defs: false,
    ringFrames: 1024, decim: 2, fftFrames: 2048
);
// The ring writer: one frame kept per `decim` samples, and the index of the newest on a control
// bus - the phasor at the block's first sample plus the rest of the block's advance, so the reader
// knows where the ring's seam is. The FFT sibling leaves a Hann-windowed frame of the mono sum
// every half frame. Both only write. Built the first time a display asks (makeDefs, from a Routine).
viewTap[\buildDefs] = {
    SynthDef(\poptart_view_tap, {
        var sig = In.ar(\bus.kr(0), 2);
        var decim = \decim.ir(2);
        var phase = Phasor.ar(0, decim.reciprocal, 0, \frames.ir(1024));
        BufWr.ar(sig, \ring.kr(0), phase, 1);
        Out.kr(\head.kr(0), A2K.kr(phase) + ((BlockSize.ir - 1) / decim));
    }).add;
    SynthDef(\poptart_view_fft, {
        var sig = In.ar(\bus.kr(0), 2);
        FFT(\buf.kr(0), (sig[0] + sig[1]) * 0.5, 0.5, 1);
    }).add;
};
viewTap[\makeDefs] = {
    if (viewTap[\defs].not) {
        viewTap[\buildDefs].();
        viewTap[\defs] = true;
        server.sync;
    };
};
// Tap one track (or the master): the buffers, then - once the server has them - the synths that
// write them in the tail group, then the strip's \view tap pointed at the bus, and last Node is
// told where everything is. A track that does not exist yet is skipped; its birth reconciles.
viewTap[\start] = { |key, fft|
    var master = key == '*';
    if (viewTap[\taps][key].isNil and: { master or: { tracks[key].isKindOf(Event) } }) {
        var bus = if (master) { nil } { Bus.audio(server, 2) };
        var ring = Buffer.alloc(server, viewTap[\ringFrames], 2);
        var head = Bus.control(server, 1);
        var fftBuf = if (fft) { Buffer.alloc(server, viewTap[\fftFrames], 1) };
        var reads = if (master) { 0 } { bus.index };
        var entry = (bus: bus, ring: ring, head: head, fftBuf: fftBuf, fft: fft);
        server.sync;
        entry[\tap] = Synth(\poptart_view_tap, [\bus, reads, \ring, ring.bufnum, \head, head.index,
            \frames, viewTap[\ringFrames], \decim, viewTap[\decim]], target: recGroup, addAction: \addToTail);
        fftBuf !? { |b|
            entry[\fftSynth] = Synth(\poptart_view_fft, [\bus, reads, \buf, b.bufnum], target: recGroup, addAction: \addToTail);
        };
        viewTap[\taps][key] = entry;
        if (master.not and: { tracks[key].isKindOf(Event) }) { stripTap.(tracks[key], \view, bus.index, 1, 0) };
        nodeAddr.sendMsg('/poptart/viewTap', key, ring.bufnum, head.index, if (fftBuf.notNil) { fftBuf.bufnum } { -1 },
            viewTap[\ringFrames], viewTap[\decim], server.sampleRate, scsynthPort);
    };
};
viewTap[\stop] = { |key|
    viewTap[\taps][key] !? { |entry|
        var track = tracks[key];
        if (entry[\bus].notNil and: { track.isKindOf(Event) }) { stripTap.(track, \view, nil) };
        entry[\tap].free;
        entry[\fftSynth] !? { |n| n.free };
        entry[\ring].free;
        entry[\fftBuf] !? { |b| b.free };
        entry[\head].free;
        entry[\bus] !? { |b| b.free };
        viewTap[\taps].removeAt(key);
        nodeAddr.sendMsg('/poptart/viewTapGone', key);
    };
};
// Bring the taps to what Node last asked for, a beat apart like the mixer's (see mixReconcile): a
// tap of the wrong kind - a spectrum added or dropped - is rebuilt, a tap nobody wants goes. One
// run at a time; an ask arriving mid-run goes round the loop again.
viewTap[\reconcile] = {
    if (viewTap[\busy]) { viewTap[\dirty] = true } {
        fork {
            viewTap[\busy] = true;
            viewTap[\dirty] = true;
            viewTap[\makeDefs].();
            while { viewTap[\dirty] } {
                viewTap[\dirty] = false;
                viewTap[\taps].keys.asArray.do { |key|
                    var want = viewTap[\wanted][key];
                    if (want.isNil or: { want != viewTap[\taps][key][\fft] }) { viewTap[\stop].(key) };
                };
                viewTap[\wanted].keys.asArray.do { |key|
                    if (viewTap[\taps][key].isNil and: { viewTap[\wanted][key].notNil }) {
                        viewTap[\start].(key, viewTap[\wanted][key]);
                        0.02.wait;
                    };
                };
            };
            viewTap[\busy] = false;
        };
    };
};
// [key, fft, key, fft, ...]: the whole set of taps Node wants, '*' being the master. Empty for none.
OSCdef(\poptartViewTaps, { |msg|
    var wanted = IdentityDictionary.new;
    msg.copyRange(1, msg.size - 1).clump(2).do { |p|
        if (p.size == 2) { wanted[p[0].asSymbol] = p[1].asInteger == 1 };
    };
    viewTap[\wanted] = wanted;
    viewTap[\on] = wanted.size > 0;
    viewTap[\reconcile].();
}, '/poptart/viewTaps');
}.value;

// --- the headphone section: level and cue/main mix (see \poptart_headphones) ---
//
// [level, mix], both 0..1. Held as well as set, so a value that arrives before the synth exists
// is what it starts with. Nothing to do on an engine with no cue pair.
OSCdef(\poptartHeadphones, { |msg|
    headphoneLevel = msg[1].asFloat;
    headphoneMix = msg[2].asFloat;
    headphoneSynth !? { |syn| syn.set(\level, headphoneLevel, \mix, headphoneMix) };
}, '/poptart/headphones');

// --- DJ deck meters (the strip's channel meters; see the deckMeterBus var declaration) ---
//
// On: one \poptart_deck_meter per deck reading its meter bus in the tail group (the track
// synths wrote the buses earlier this block). Off: free them. The track-side sends are birth
// args (mdeck), not touched here - an unread bus write costs nothing worth switching for.
// Idempotent both ways; web-app ties this to the strip's SSE clients (first in / last out).
OSCdef(\poptartDeckMeters, { |msg|
    if (msg[1].asInteger == 1) {
        if (deckMeterSynths.isNil) {
            deckMeterSynths = [0, 1].collect { |i|
                Synth(\poptart_deck_meter, [\bus, deckMeterBus.index + (i * 2), \id, i],
                    target: recGroup, addAction: \addToTail);
            };
        };
    } {
        deckMeterSynths !? { |synths| synths.do(_.free) };
        deckMeterSynths = nil;
    };
}, '/poptart/deckMeters');

// Both readers answer here ([nodeID, replyID, peakL, rmsL, peakR, rmsR] from m[1]); forward to
// Node keyed by deck id. Registered once - it only ever fires while reader synths exist.
OSCFunc({ |m|
    nodeAddr.sendMsg('/poptart/deckLevel', m[2].asInteger, m[3], m[4], m[5], m[6]);
}, '/poptart/deckLevel', server.addr);

// The master meter's feed ([nodeID, replyID, then a peak and an rms for each side of the summed
// pair]), folded to the louder side.
OSCFunc({ |m|
    var pairs = m.copyToEnd(3).clump(2);
    nodeAddr.sendMsg('/poptart/masterLevel', pairs.collect(_[0]).maxItem, pairs.collect(_[1]).maxItem);
}, '/poptart/masterLevel', server.addr);

// ...and their band energies, the same way ([nodeID, deck, low, mid, high]): what colors the
// livecoded decks' waveform strips. A reply of its own because SendPeakRMS writes its own
// message; the two leave the same synth on the same trigger, so they arrive together.
OSCFunc({ |m|
    nodeAddr.sendMsg('/poptart/deckBands', m[2].asInteger, m[3], m[4], m[5]);
}, '/poptart/deckBands', server.addr);

// Bounce one track to a WAV. The window's edges are timestamped bundles, so the file is
// sample-accurate rather than however long the messages took to arrive - but DiskOut drops
// whatever is still in its realtime buffer when the synth is freed, so what gets written is
// [pre-roll][window][post-roll] and Node cuts the exact window out of it afterwards (wav.js).
// The post-roll Node asks for is what covers that unflushed buffer, and doubles as the release
// tail. `startLatency`/`stopLatency` are seconds from now, like every other timed message here.
OSCdef(\poptartRecordTrack, { |msg|
    var requestId = msg[1], key = msg[2].asSymbol, path = msg[3].asString;
    var startLatency = msg[4].asFloat, stopLatency = msg[5].asFloat;
    // `stage` is a breadcrumb: every step updates it, and the watchdog below reports whichever one
    // we died on. An exception inside a Routine only posts and kills the thread - without this,
    // any failure in here reaches Node as an unexplained request timeout (and `try` is no help:
    // yielding inside a protected frame is not reliable in sclang).
    var stage = "starting", replied = false;
    var finish = { |ok, detail|
        if (replied.not) {
            replied = true;
            if (ok) { replyOk.("/poptart/recordTrack", requestId, detail) }
                   { replyErr.("/poptart/recordTrack", requestId, detail) };
        };
    };
    // Fires only if the normal path never got there. Generous: the recording itself is as long as
    // the caller asked for, and this is the backstop, not the schedule.
    SystemClock.sched(stopLatency + 10, {
        if (replied.not) {
            ("poptart: record " ++ key ++ " never finished (stuck at: " ++ stage ++ ")").warn;
            finish.(false, "the engine stalled while recording (last step: " ++ stage ++ ")");
        };
        nil
    });
    fork {
        var entry, t0 = Main.elapsedTime, setupSec;
        awaitTrack.(key);
        stage = "tapping the track";
        entry = startTap.(key);
        if (entry.isNil) {
            finish.(false, "no track " ++ key);
        } {
            var buf, sf, frames = 0;
            stage = "allocating the record buffer";
            buf = Buffer.alloc(server, 65536, 2);
            server.sync;
            stage = "opening " ++ path;
            buf.write(path, "wav", "int24", 0, 0, true); // leaveOpen: DiskOut streams into it
            server.sync;
            entry[\buf] = buf;
            entry[\path] = path;
            // Both latencies were measured by Node against the moment it SENT this message, but
            // makeBundle schedules from the moment it is CALLED - and allocating the buffer and
            // opening the file above took a couple of server round trips to get here. Subtract
            // that, or the whole window lands late by however long the setup took while Node trims
            // assuming an exact pre-roll.
            setupSec = Main.elapsedTime - t0;
            stage = "scheduling the window";
            bundleNow.(max(0, startLatency - setupSec), {
                entry[\disk] = Synth(\poptart_rec_disk, [\bus, entry[\bus].index, \buf, buf],
                    target: recGroup, addAction: \addToTail);
            });
            bundleNow.(max(0, stopLatency - setupSec), { entry[\disk].free });
            stage = "recording";
            // Closing the file is what flushes DiskOut's last block and writes the real data size
            // into the WAV header, so it waits until after the synth is actually gone. freeMsg -
            // not a function - is the completion MESSAGE: freeing the buffer before the close has
            // been processed truncates the file to a bare header.
            (stopLatency - setupSec + 0.5).max(0.5).wait;
            // Closing is what flushes DiskOut's last block and writes the real data size into the
            // WAV header, so it has to happen after the synth is gone and BEFORE Node reads the
            // file. Close, sync, then free - as three steps, because neither nesting works:
            // `close(freeMsg)` evaluates freeMsg first, and freeMsg deallocates the buffer as a
            // side effect rather than just describing one, so close then throws on a freed buffer;
            // passing a function instead frees it midway through building the close message, which
            // is what leaves a bare header on disk.
            stage = "closing the file";
            buf.close;
            server.sync; // the header is only correct once the close has been processed
            buf.free;
            entry[\buf] = nil;
            entry[\disk] = nil;
            // Report what actually reached the disk, so a silent or empty capture says so here
            // rather than as an unexplained "no readable audio" on the Node side.
            stage = "reading back " ++ path;
            sf = SoundFile.new;
            if (sf.openRead(path)) { frames = sf.numFrames; sf.close };
            if (frames == 0) {
                ("poptart: record " ++ key ++ " wrote an empty file - is the track's rec tap up?").warn;
            };
            stage = "done";
            finish.(true, toJson.((path: path, frames: frames)));
        };
    };
}, '/poptart/recordTrack');

// Record the master bus to a WAV file for `seconds` - bounce/export, and how automated tests
// verify actual audio comes out the other end.
OSCdef(\poptartRecord, { |msg|
    var requestId = msg[1], path = msg[2].asString, seconds = msg[3].asFloat;
    server.recHeaderFormat = "WAV";
    server.recSampleFormat = "int16";
    server.record(path, duration: seconds);
    fork {
        (seconds + 0.5).wait;
        replyOk.("/poptart/record", requestId, toJson.((path: path)));
    };
}, '/poptart/record');

OSCdef(\poptartGetKnownPlugins, { |msg|
    var requestId = msg[1];
    replyOk.("/poptart/getKnownPlugins", requestId, toJson.(pluginList.()));
}, '/poptart/getKnownPlugins');

// Quit scsynth before exiting: sclang dying alone orphans the server, which then keeps hold of
// the audio device and its UDP port - wedging the next engine start (an output-device change
// from the settings tab restarts the whole stack through this path).
OSCdef(\poptartQuit, { |msg|
    var pid = server.pid;
    fork {
        // Fallback if the server never answers the quit. Exiting on our own here is what used to
        // orphan it: a scsynth whose audio device was yanked out from under it sits wedged in
        // CoreAudio and never processes /quit, so the 3s timer fired, sclang left, and scsynth
        // stayed - holding the device and the UDP port until the next boot died on "failed to
        // open UDP socket: address in use". So take it with us. prOnServerProcessExit clears
        // server.pid, so a nil pid here means it did quit and there is nothing left to kill.
        3.wait;
        if (server.pid.notNil) {
            ("poptart: scsynth (pid " ++ pid ++ ") did not answer the quit - killing it").warn;
            thisProcess.platform.killProcessByID(pid);
            0.3.wait; // let the kill land before we stop being able to report on it
        };
        0.exit;
    };
    server.quit(onComplete: { 0.exit }, onFailure: { 0.exit }, watchShutDown: false);
}, '/poptart/quit');
)
