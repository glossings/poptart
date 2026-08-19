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
// Scaffold limitation: each track's plugin chain has a fixed max length (maxSlots below) baked
// into one SynthDef per track, because VSTPlugin instances live inside a SynthDef's UGen graph
// and can't be added to a running Synth. Swapping which plugin occupies a slot is fine;
// growing a chain past maxSlots would need a def rebuild (not handled yet).

(
var nodePort = "POPTART_NODE_PORT".getenv.asInteger;
var sampleRate = ("POPTART_SAMPLE_RATE".getenv ? "48000").asInteger;
var blockSize = ("POPTART_BLOCK_SIZE".getenv ? "256").asInteger;
// Audio output device (empty/unset = system default) and its channel count, chosen in the
// editor's settings tab and passed through by OscEngine. The channel count sizes
// numOutputBusChannels so the device's channels are all addressable.
var outDevice = "POPTART_OUT_DEVICE".getenv;
var outChannels = ("POPTART_OUT_CHANNELS".getenv ? "2").asInteger;
// How many of those channels actually reach a speaker - what .o(n)'s stereo-pair wraparound folds
// onto. Same as outChannels for a plain device; smaller for poptart's aggregate, whose trailing
// channels belong to the input devices combined in behind the playback device and go nowhere
// audible. Node works it out (audio-selection.js's playbackChannels) since it knows the membership.
var playChannels = ("POPTART_PLAY_CHANNELS".getenv ? outChannels.asString).asInteger;
// The chosen device's input channel count (0 for output-only devices). Currently poptart plays
// out only, so this is 0 in practice, but it's the device's real input count so live-input
// features can use it later without a boot-config change. It also has to match the device: when
// inDevice == outDevice (set below) scsynth opens one device and will fail to boot if it's told
// to open more input channels than the device has.
var inChannels = ("POPTART_IN_CHANNELS".getenv ? "0").asInteger;
// Plugin directories to scan. Priority: POPTART_VST_DIRS (colon-separated) if set, else
// ~/.poptart/plugins if it exists (a folder of symlinks to just the plugins being played),
// else VSTPlugin's standard locations. The curated folder stays the default because it keeps
// first-scan time down and sidesteps plugins that won't probe headlessly; it is no longer load-
// bearing for stability, though - the full-scan crash it was working around was VSTPlugin's
// parallel probing, now off by default (see parallelScan below).
var searchDirs = "POPTART_VST_DIRS".getenv !? { |p| p.split($:) }
    ?? { var d = "~/.poptart/plugins".standardizePath; if (File.exists(d)) { [d] } };
// Plugins skipped explicitly during scans (VSTPlugin's exclude option, which prunes these
// paths from the directory traversal so they're never probed). Set POPTART_VST_EXCLUDE
// (colon-separated absolute paths) to skip plugins that crash or spam errors on your machine
// during a scan, e.g. copy-protection or analysis plugins that fail to probe headlessly.
var excludePaths = ("POPTART_VST_EXCLUDE".getenv !? { |p| p.split($:) } ? []);
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
var maxSlots = 8; // slot 0 = instrument, 1..7 = effects
var maxBusSends = 4; // a track can send to this many named buses at once (Sig#bus); must match the
                     // busOut1..N / busSend1..N controls hardcoded in the track SynthDef below
// scsynth's own port, overridable so a second poptart stack (tests, parallel session) doesn't
// collide with a running one on the default 57110.
var scsynthPort = ("POPTART_SCSYNTH_PORT".getenv ? "57110").asInteger;
var server = Server(\poptart, NetAddr("127.0.0.1", scsynthPort), Server.default.options);
var nodeAddr = NetAddr("127.0.0.1", nodePort);
// trackId (Symbol) -> (def:, group:, synth:, controllers:, loaded:, lfos:, envs:, held:).
// Symbol keys, NOT Strings: IdentityDictionary lookups are by identity, and two equal Strings
// are distinct objects (incoming OSC string args arrive as Symbols anyway).
var tracks = IdentityDictionary.new;
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
// The longest a note will ever wait for a program, and the furthest past a load's start a note is
// considered to be "in" it. A swap on a plugin that is already open takes tens of milliseconds, so
// this is slack, not a budget - what it bounds is the bad case: a restore sent while its plugin is
// still opening (a cold start) would otherwise hold every note for as long as the open took and
// then play them all at once, which is far worse than the one eaten note it was avoiding.
var stateWaitMax = 0.3;
var samplePacks = IdentityDictionary.new; // pack (Symbol) -> Array of Buffers, filename order
var confWant = IdentityDictionary.new; // trackId -> latest requested conf state (see setConfMode)
// Host tempo (bpm) mirrored into every open VST as emulated DAW transport, so plugin-internal
// synced LFOs/delays/arps follow setbpm instead of assuming their own default. Updated by
// '/poptart/setTempo' and applied to plugins as they open (see loadInstrument/loadEffect).
var currentTempo = 120;
var jsonEscape, toJson, replyOk, replyErr, pluginList, trackDefName, buildTrackDef, channelDefault;
var awaitTrack, awaitLoaded, resolvePlugin, resolveParamIndex, watchPluginEdits;
var slotKey, waitForLoad, flushNotes, clearPending;
var midiInitialized = false, midiWarned = IdentitySet.new;
var midiEnable, midiNameForUid, midiSourceFor, midiWarnMissing;
// Audio sidechain routing (Sig#sidechain / '/poptart/setSidechain'). silentBus is the read-only
// default for every fx slot's aux input (never written -> silence); trashBus is the write-only
// default for a track's sidechain send when it feeds nothing (parked, never read). scArgsFor
// builds the per-track defaults. The two dicts track live routes both ways for teardown.
var silentBus, trashBus, scArgsFor, scKey, wireAudio, unwireAudio;
var sidechainByTarget, sidechainBySource;
// Named audio buses (Sig#bus / '/poptart/setBusOut'): a track can divert its output to a bus,
// where any number of tracks sum, and another track reads the sum via the audio("name") head
// source. busGroup sits at the head of the node tree so bus-writer tracks execute before the
// readers that In.ar the bus (scsynth zeroes buses each block, so a reader ordered before its
// writers would only see silence). acquire/releaseBus refcount the buses so they live exactly as
// long as some writer or reader references them.
var namedBuses, busGroup, acquireBus, releaseBus;
// Per-track recording ('/poptart/tapTrack' + '/poptart/recordTrack'). A tapped track copies its
// post-fader output to a private bus; a meter synth on that bus streams peaks back to Node so the
// editor's record panel can show the signal, and a DiskOut synth writes the bounce itself. recGroup
// sits at the TAIL of the node tree, so both read a bus the track synth has already written this
// block. recTaps holds one entry per tapped track: (bus:, meter:, disk:, buf:, path:).
var recGroup, recTaps, startTap, stopTap;

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

trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };

buildTrackDef = { |key|
    // .o(n)'s wraparound: pair indices past the last AUDIBLE pair fold back onto real outputs.
    // Audible, not merely allocated - wrapping at numOutputBusChannels sent .o(2) into the silent
    // tail of poptart's aggregate whenever an extra input was combined in (see playChannels).
    var numPairs = max(1, min(playChannels, server.options.numOutputBusChannels) div: 2);
    // scBus1..7 are per-fx-slot auxiliary (sidechain) input buses; scSend/scSendGain are this
    // track's own sidechain send (see Sig#sidechain). Node fills the sc* args with parked buses
    // by default (silentBus for the aux inputs, trashBus for the send) and repoints them when a
    // route is set up - see scArgsFor and the setSidechain OSCdef.
    SynthDef(trackDefName.(key), { |inBus, gain = 1, pan = 0, out = 1, dry = 1, scSend, scSendGain = 1,
        busOut1, busOut2, busOut3, busOut4, busSend1 = 0, busSend2 = 0, busSend3 = 0, busSend4 = 0,
        recOut, recSend = 0,
        scBus1, scBus2, scBus3, scBus4, scBus5, scBus6, scBus7|
        var sig = Silent.ar(2);
        var scBuses = [scBus1, scBus2, scBus3, scBus4, scBus5, scBus6, scBus7];
        maxSlots.do { |i|
            if (i == 0) {
                // The instrument slot's output, plus whatever the track's sample synths wrote
                // to the private input bus this block (sample synths sit at the group's head,
                // this synth at its tail, so In.ar sees them) - samples run through the same
                // fx chain a VST instrument would.
                sig = VSTPlugin.ar(nil, 2, id: \slot0) + In.ar(inBus, 2);
            } {
                // Effect slots take TWO input buses: the chain signal (bus 0, main) and a
                // sidechain bus (bus 1, aux) read from this slot's scBus arg. The aux bus is
                // silent unless a .sidechain() feeds it; a plugin with no aux input simply
                // ignores the extra bus (VSTPlugin tolerates a surplus bus). The `Ref([...])`
                // wrapping is how VSTPlugin.ar takes multi-bus input.
                var scIn = In.ar(scBuses[i - 1], 2);
                var wet = VSTPlugin.ar(Ref([[sig[0], sig[1]], [scIn[0], scIn[1]]]), 2, id: ("slot" ++ i).asSymbol);
                // An empty VSTPlugin slot outputs silence, not pass-through - so each fx slot
                // gets a bypass switch, flipped on only once a plugin actually loads into it.
                sig = Select.ar(("active" ++ i).asSymbol.kr(0), [sig, wet]);
            };
        };
        // Channel strip (post-chain): gain + equal-power pan, addressed from Node as pseudo-slot
        // -1 (Sig#gain/#pan; setParam sets these controls, setParam[Shape]LFO/Env map busses to
        // them). Lag smooths the ~30ms Tier-1 polling steps; clip keeps a runaway signal sane.
        sig = Balance2.ar(sig[0], sig[1], pan.lag(0.02).clip(-1, 1), gain.lag(0.02).clip(0, 4));
        // Sidechain send: a copy of this track's post-fader output written to another track's
        // aux bus (scSend). Parked to trashBus when this track feeds nothing, so the graph stays
        // static; scSendGain scales the amount. Always-on Out keeps the UGen graph fixed.
        Out.ar(scSend, sig * scSendGain);
        // Named-bus sends (Sig#bus): up to maxBusSends independent aux sends, each a copy of the
        // post-fader output to busOutK scaled by busSendK. Unused slots park busOutK at trashBus
        // with busSendK = 0. Lagged so a routing change doesn't click. Any number of tracks sending
        // to the same bus sum into it; read the sum on another track with the audio("name") source.
        [busOut1, busOut2, busOut3, busOut4].do { |b, i|
            Out.ar(b, sig * [busSend1, busSend2, busSend3, busSend4][i].lag(0.02));
        };
        // Recorder tap (see the record section below): a copy of the post-fader output for the
        // meter and DiskOut synths, parked at trashBus with recSend 0 until a bounce taps it.
        // Taken BEFORE the `dry` scaling deliberately - bouncing a track means bouncing what the
        // track makes, and a .bsend() track with dry(0) still has to record something. NOT lagged:
        // the tap is switched between phrases, never mid-window, and a lag would ramp the first
        // 20ms of every recording up from silence.
        Out.ar(recOut, sig * recSend);
        // `out` is the channel strip's stereo-pair selector (Sig#o, pseudo-slot -1 like gain/pan):
        // pair 1 = buses 0/1, pair 2 = 2/3, ..., wrapping past the device's last pair. Scaled by
        // `dry` (Sig#dry, channel control, default 1) so .dry(0)/.bsend() can mute the dry path
        // while the bus sends carry the signal.
        Out.ar((out.round - 1).mod(numPairs) * 2, sig * dry.lag(0.02));
    });
};

// Neutral value a channel control (pseudo-slot -1) snaps back to when its modulator is cleared:
// unity gain, center pan, first output pair.
channelDefault = { |name|
    if ((name == "gain") or: { name == "out" } or: { name == "dry" }) { 1 } { 0 };
};

// Parked sidechain args for a freshly created track synth: every fx-slot aux input reads the
// silent bus (so plugins see silence until routed), and the track's own send is parked to the
// trash bus. setSidechain repoints the relevant args when a route is set up.
scArgsFor = {
    [\scSend, trashBus.index, \scSendGain, 1,
     \recOut, trashBus.index, \recSend, 0,
     \busOut1, trashBus.index, \busOut2, trashBus.index, \busOut3, trashBus.index, \busOut4, trashBus.index,
     \scBus1, silentBus.index, \scBus2, silentBus.index, \scBus3, silentBus.index,
     \scBus4, silentBus.index, \scBus5, silentBus.index, \scBus6, silentBus.index,
     \scBus7, silentBus.index];
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

// Wire an audio route into a sink on `targetKey`: slot >= 1 is an fx aux (sidechain) input, slot
// 0 is the chain input (a head audio() source). `rawName` is a source track ("label"/"track:label")
// or a hardware input ("dev:..."). A track source sends its output to the sink bus and is ordered
// ahead of the target; a device source runs a SoundIn feeder at the head writing that bus. The fx
// aux gets a freshly allocated bus (pointed at via \scBusN); the chain input reuses the track's
// own inBus. Idempotent: an existing route on the same sink is torn down first.
// `inA`/`inB` are the hardware channels a device source reads, absolute and 0-indexed (inB -1 =
// mono, duplicated to both sides); ignored for a track/bus source. pattern-core resolves them from
// input()'s 1-indexed, optionally device-relative form before they get here.
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
        { (slot < 0) or: { slot >= maxSlots } } { ("poptart: audio route: bad slot " ++ slot).warn }
        { true } {
            var destBus, ownsBus, nameKey = name.asSymbol;
            unwireAudio.(targetKey, slot); // retire any existing route on this sink first
            if (slot >= 1) {
                destBus = Bus.audio(server, 2);
                ownsBus = true;
                target[\synth].set(("scBus" ++ slot).asSymbol, destBus.index);
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
                sidechainByTarget[key] = (bus: destBus, target: target, slot: slot, source: nil, feeder: feeder, busName: nil, owns: ownsBus);
                ("poptart: audio input: ch " ++ (wanted.collect { |c| c + 1 }.join("+"))
                    ++ if (name.isEmpty) { "" } { " of '" ++ name ++ "'" }
                    ++ " -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
            }
            { true } {
                // Resolve a bare / "track:" / "bus:" name. Both a source track and a bus writer may
                // be created in the same eval as this reader, so wait briefly for either to appear;
                // "bus:" forces a bus, otherwise track-first with a bus of that name as fallback. A
                // track reading its OWN name (drums: audio("drums")) means the bus, not itself -
                // self-routing would feed the track's output back into its own input - so a self
                // match doesn't count as a track here, and we wait for the bus instead.
                var tries = 0, max = (5 / 0.05).asInteger, source, useBus;
                while {
                    ((isBusPrefix.not and: { nameKey != targetKey } and: { tracks[nameKey].isKindOf(Event) })
                        or: { namedBuses[nameKey].notNil }).not
                    and: { tries < max }
                } { 0.05.wait; tries = tries + 1 };
                source = if (isBusPrefix or: { nameKey == targetKey }) { nil } { tracks[nameKey] };
                useBus = source.isKindOf(Event).not and: { namedBuses[nameKey].notNil };
                case
                { source.isKindOf(Event) } {
                    // A track source pushes its output to the sink via its own \scSend (one per
                    // source): retire its previous sink if different, then order source ahead.
                    sidechainBySource[nameKey] !? { |p|
                        if ((p[\targetKey] != targetKey) or: { p[\slot] != slot }) { unwireAudio.(p[\targetKey], p[\slot]) };
                    };
                    source[\synth].set(\scSend, destBus.index, \scSendGain, gain);
                    if (nameKey != targetKey) { target[\group].moveAfter(source[\group]) };
                    sidechainByTarget[key] = (bus: destBus, target: target, slot: slot, source: nameKey, feeder: nil, busName: nil, owns: ownsBus);
                    sidechainBySource[nameKey] = (targetKey: targetKey, slot: slot);
                    ("poptart: audio route: " ++ name ++ " -> " ++ targetKey ++ " (slot " ++ slot ++ ")").postln;
                }
                { useBus } {
                    // A named bus (Sig#bus): a reader feeder copies the bus into the sink's input,
                    // at the head of the sink's group so it lands before the track synth reads it.
                    // The bus's writer tracks live in busGroup at the tree head; move this sink to
                    // the tail of the default group so it runs after them (and thus sees their sum
                    // this block, not a block late). The reader holds a bus ref while it's routed.
                    var busObj = acquireBus.(name);
                    var feeder = Synth(\poptart_busread, [\out, destBus.index, \in, busObj.index, \gain, gain],
                        target: target[\group], addAction: \addToHead);
                    target[\group].moveToTail(server.defaultGroup);
                    sidechainByTarget[key] = (bus: destBus, target: target, slot: slot, source: nil, feeder: feeder, busName: name, owns: ownsBus);
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
        if ((slot >= 1) and: { target.isKindOf(Event) }) { target[\synth].set(("scBus" ++ slot).asSymbol, silentBus.index) };
        entry[\source] !? { |src|
            tracks[src] !? { |s| if (s.isKindOf(Event)) { s[\synth].set(\scSend, trashBus.index) } };
            sidechainBySource[src] = nil;
        };
        entry[\busName] !? { |bn| releaseBus.(bn) }; // a bus reader held a ref - drop it
        entry[\feeder] !? { |f| f.free };
        if (entry[\owns]) { entry[\bus].free };
        sidechainByTarget[key] = nil;
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
    if (t.isKindOf(Event)) { t } { nil };
};
awaitLoaded = { |track, slot, timeoutSec = 10|
    var tries = 0, max = (timeoutSec / 0.05).asInteger;
    while { track[\loaded][slot].isNil and: { tries < max } } { 0.05.wait; tries = tries + 1 };
    track[\loaded][slot].notNil;
};

slotKey = { |key, slot| (key ++ "_" ++ slot).asSymbol };

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
    if (pending.notNil and: { pending[\at] <= at } and: { at <= (pending[\at] + stateWaitMax) }) {
        noteQueues[seqKey] = (noteQueues[seqKey] ? []).add((at: at, fire: fire));
        true
    } { false };
};

// Everything waiting on one slot, in arrival order - a note-off must never overtake the note-on it
// belongs to. Each keeps its ORIGINAL onset: a load that finished before it (the swap is applied a
// little ahead of its onset for exactly this reason) leaves the note playing dead on time, and only
// one that ran past the onset makes it late. The 2ms floor keeps the bundle just ahead of scsynth
// rather than arriving stamped for a moment that has already gone.
flushNotes = { |seqKey|
    var waiting = noteQueues[seqKey];
    noteQueues[seqKey] = nil;
    waiting !? {
        var now = Main.elapsedTime;
        waiting.do { |e| e[\fire].value((e[\at] - now).max(0.002)) };
    };
};

// Ends the wait for one load - finished, failed, superseded or cancelled, the notes must go either
// way. Only for the load it names: a newer one may have taken the slot over in the meantime, and
// its notes are still waiting for IT.
clearPending = { |seqKey, seq|
    if (statePending[seqKey].notNil and: { statePending[seqKey][\seq] == seq }) {
        statePending[seqKey] = nil;
        flushNotes.(seqKey);
    };
};

// `.synth("Serum 2")` uses the display name, but VSTPlugin's dict keys carry the file extension
// ('Serum 2.vst3') - accept exact key, display name, or a literal file path.
resolvePlugin = { |pluginId|
    var dict = VSTPlugin.plugins(server);
    var desc = dict[pluginId.asSymbol] ?? {
        // Display-name lookup. A name can exist as both VST2 and VST3 ("Mangle" + "Mangle.vst3");
        // prefer the VST3 so resolution is deterministic instead of dict-order luck, matching the
        // browser/autocomplete (which hide shadowed VST2s when the prefer-VST3 setting is on).
        // The VST2 build stays reachable by its exact dict key.
        var matches = dict.values.select { |d| d.name == pluginId };
        matches.detect { |d| d.key.asString.endsWith(".vst3") } ?? { matches.first };
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
        MIDIdef.cc(\poptart_cc_forward, { |val, num, chan, src|
            nodeAddr.sendMsg("/poptart/midiIn", midiNameForUid.(src), chan + 1, num, val / 127.0);
        });
        ("poptart: MIDI input enabled (" ++ MIDIClient.sources.size ++ " source(s))").postln;
    };
};
midiNameForUid = { |uid|
    var s = MIDIClient.sources.detect { |e| e.uid == uid };
    if (s.notNil) { s.device.asString ++ " " ++ s.name.asString } { "unknown" };
};
// Same matching rule as pattern-core's midi.mjs: case-insensitive substring of "device name",
// so both the native paths here and Node's Tier-1 store agree on which controller a name means.
midiSourceFor = { |pattern|
    var p = pattern.asString.toLower;
    MIDIClient.sources.detect { |s| (s.device.asString ++ " " ++ s.name.asString).toLower.contains(p) };
};
midiWarnMissing = { |context, device|
    if (midiWarned.includes(device.asSymbol).not) {
        midiWarned.add(device.asSymbol);
        ("poptart: " ++ context ++ ": no MIDI source matching '" ++ device ++ "' - connected: "
            ++ MIDIClient.sources.collect({ |s| s.device.asString ++ " " ++ s.name.asString }).join(", ")
            ++ ". Plug it in and re-evaluate.").warn;
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
// One buffer per file in a sample pack, and packs stay loaded for the session - scsynth's default
// table of 1024 is exhausted by a single big drum library ("No more buffer numbers" on the first
// s("...")). The table itself is only a few hundred bytes per slot (the audio lives in separate
// allocations made at read time), so size it for a whole library rather than one pack.
server.options.numBuffers = 16384;

// Second boot-progress checkpoint (see "engine script running" above) - also puts the exact
// boot config into the log, so a failure report carries it and the README's IDE-replay
// procedure can copy the values straight out.
// audible: what .o(n) wraps at, which is the whole device unless it's the aggregate (see playChannels).
"poptart: booting scsynth (device: %, sr: %, block: %, out: %ch, audible: %ch, in: %ch)".format(
    if (outDevice.notNil and: { outDevice.isEmpty.not }) { outDevice } { "system default" },
    sampleRate, blockSize, server.options.numOutputBusChannels,
    max(2, min(playChannels, server.options.numOutputBusChannels)), inChannels
).postln;

server.waitForBoot {
    // rand = uniform random, unsmoothed: a fresh independent value `freq` times a second, held in
    // between (phase ignored). It matches what pattern-core's rand() is - an independent draw per
    // read - as closely as a continuous control stream can; freq always arrives as 1 Hz, since
    // rand() has no rate to ask for pattern-side. The smoothed one is perlin, fractal
    // (fBm) value noise layered over a few octaves for organic drift. Like rand, the native and JS
    // samplings differ (both random, only the rate/range contract is shared - see signal.mjs).
    // ramp is a rising saw, same shape as \saw here.
    [\sine, \tri, \saw, \ramp, \square, \rand, \perlin].do { |shape|
        SynthDef(("poptart_lfo_" ++ shape).asSymbol, { |out, freq = 1, phase = 0, lo = 0, hi = 1, t_trig = 0|
            // Phase comes from one resettable Sweep, not each oscillator UGen's own internal
            // accumulator, so the scheduler can re-pin it to the shared transport clock with
            // set(\t_trig, 1, \phase, p) in a timestamped bundle ('/poptart/anchorParamLFO') -
            // otherwise the audio clock's ppm-level skew against the note grid accumulates into
            // audible drift. The unipolar waveforms match pattern-core sampleLfoIR's exactly
            // (same shapes, same phase origin), so JS and native samplings of a signal agree.
            var ph = (Sweep.kr(t_trig, freq) + phase).wrap(0, 1);
            var uni = switch(shape,
                \sine, { (ph * 2pi).sin * 0.5 + 0.5 },
                \tri, { 1 - ((ph * 2) - 1).abs },
                \saw, { ph },
                \ramp, { ph },
                \square, { ph < 0.5 },
                \rand, { LFDNoise0.kr(freq) * 0.5 + 0.5 }, // stepped, not interpolated; no phase - never anchored
                \perlin, { // fBm: octaves of smoothed noise, each 2x rate and 1/2 amplitude
                    ((LFDNoise3.kr(freq) * 0.5)
                        + (LFDNoise3.kr(freq * 2) * 0.25)
                        + (LFDNoise3.kr(freq * 4) * 0.125)
                        + (LFDNoise3.kr(freq * 8) * 0.0625)) * (1 / 0.9375) * 0.5 + 0.5
                }
            );
            Out.kr(out, lo + (uni * (hi - lo)));
        }).add;
    };
    // ADSR modulator, gated by the track's note on/offs (see the noteOn/noteOff OSCdefs) -
    // the parameter-modulation equivalent of a synth's filter envelope. Retriggers from the
    // envelope's current level on each new gate, so overlapping notes don't click. `curve`
    // shapes every segment (negative = scoop, 0 = linear, positive = bulge) and is a plain
    // control input into the Env, so a livecoding re-eval updates it in place.
    SynthDef(\poptart_env, { |out, atk = 0.01, dec = 0.1, sus = 0.7, rel = 0.2, curve = -4, gate = 0, lo = 0, hi = 1|
        var envSig = EnvGen.kr(Env.adsr(atk, dec, sus, rel, 1.0, curve), gate);
        Out.kr(out, lo + (envSig * (hi - lo)));
    }).add;
    // Sampler voices, one per (loop?, timestretch?, buffer channels) combination - the
    // combination is fixed per event, so picking a def beats building Select spaghetti with
    // conflicting doneActions. All write to the track's private input bus (see buildTrackDef).
    // begin/end are normalized 0..1 positions; rate is signed (negative = reversed); dur is the
    // precomputed natural length in seconds (Node does that math - it knows file duration, fit
    // and stretch). Plain defs repitch via BufRd index speed; warp defs (stretch != 1) keep
    // pitch and time independent via Warp1 granulation. atk/dec/rel are the amplitude ADSR times
    // scaled by dur (atk 2 = attack over 2*dur, so it never reaches full before the note ends);
    // sus is a 0..1 level. All default to 0/0/1/0, which floors down to the old tiny declick fade.
    [1, 2].do { |nc|
        var toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
        SynthDef(("poptart_sample_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0|
            var frames = BufFrames.ir(buf);
            var startF = begin * frames, endF = max(begin * frames, (end * frames) - 1);
            var from = Select.kr(rate < 0, [startF, endF]);
            var to = Select.kr(rate < 0, [endF, startF]);
            var sig = BufRd.ar(nc, buf, Line.ar(from, to, dur), loop: 0, interpolation: 4);
            // atk/dec/rel are the play duration (dur) times their input, so .attack(2) ramps over
            // 2*dur and never reaches 1 before the note ends. A gate held open for exactly dur runs
            // attack->decay->sustain across playback, then releases when the region ends; a cut
            // event (gate->0 early) releases sooner. Tiny floors keep the fade-in/out declicked.
            var atkS = max(0.003, atk * dur), decS = dec * dur, relS = max(0.008, rel * dur);
            var noteGate = gate * (Line.kr(0, 1, dur) < 1);
            var env = EnvGen.kr(Env.adsr(atkS, decS, sus, relS), noteGate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
        // Looping voice. Node decides WHERE the loop runs (loopLo..loopHi - the whole file or just
        // the begin..end window, see .loop()'s wrap option) and where it enters (entry); this only
        // has to walk it. pingpong swaps the wrap-around for a bounce off each edge.
        SynthDef(("poptart_sample_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, loopLo = 0, loopHi = 1, entry = 0, pingpong = 0|
            var frames = BufFrames.ir(buf);
            var startF = loopLo * frames, endF = max((loopLo * frames) + 1, (loopHi * frames) - 1);
            var span = endF - startF;
            var from = (entry * frames).clip(startF, endF);
            var step = rate * BufRateScale.ir(buf);
            // Phasor's resetPos is ONLY applied on a trigger - its initial value is `start`, so a
            // never-triggered phasor cannot be made to begin anywhere else. Every phasor here
            // therefore runs from zero and the entry point is added in and wrapped.
            var walk = (Phasor.ar(0, step, 0, span, 0) + (from - startF)) % span;
            // Ping-pong is a phasor over TWICE the span, folded back on itself: 0 -> span -> 0 is
            // one period, so each edge turns the playhead round instead of jumping it. Direction
            // is which half of that period it enters, which is why the rate here is unsigned.
            var bounceFrom = Select.kr(rate < 0, [from - startF, (2 * span) - (from - startF)]);
            var bouncePh = (Phasor.ar(0, step.abs, 0, 2 * span, 0) + bounceFrom) % (2 * span);
            var bounced = startF + span - absdif(bouncePh, span);
            var idx = Select.ar(pingpong, [startF + walk, bounced]);
            var sig = BufRd.ar(nc, buf, idx, loop: 1, interpolation: 4);
            // atk/dec/rel are fractions of dur (the natural region length); sustain is held until
            // the loop's gate-off, then released. Floors preserve the original declick fade.
            var atkS = max(0.003, atk * dur), decS = dec * dur, relS = max(0.008, rel * dur);
            var env = EnvGen.kr(Env.adsr(atkS, decS, sus, relS), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
        SynthDef(("poptart_sample_warp_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0|
            var from = Select.kr(rate < 0, [begin, end]);
            var to = Select.kr(rate < 0, [end, begin]);
            var sig = Warp1.ar(nc, buf, Line.kr(from, to, dur), rate.abs, 0.1, -1, 8, 0.1, 2);
            // atk/dec/rel are the play duration (dur) times their input, so .attack(2) ramps over
            // 2*dur and never reaches 1 before the note ends. A gate held open for exactly dur runs
            // attack->decay->sustain across playback, then releases when the region ends; a cut
            // event (gate->0 early) releases sooner. Tiny floors keep the fade-in/out declicked.
            var atkS = max(0.003, atk * dur), decS = dec * dur, relS = max(0.008, rel * dur);
            var noteGate = gate * (Line.kr(0, 1, dur) < 1);
            var env = EnvGen.kr(Env.adsr(atkS, decS, sus, relS), noteGate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
        // Timestretched loop - same loopLo/loopHi/entry/pingpong contract as the plain loop above,
        // on Warp1's normalized 0..1 pointer. The step comes from the begin..end window and its
        // play time, which cancel down to "normalized units per second" - independent of where the
        // loop bounds are, so a file-wrapping loop still moves at the rate .speed()/.fit() asked for.
        SynthDef(("poptart_sample_warp_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1, atk = 0, dec = 0, sus = 1, rel = 0, loopLo = 0, loopHi = 1, entry = 0, pingpong = 0|
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
            var sig = Warp1.ar(nc, buf, ptr, rate.abs, 0.1, -1, 8, 0.1, 2);
            // atk/dec/rel are fractions of dur (the natural region length); sustain is held until
            // the loop's gate-off, then released. Floors preserve the original declick fade.
            var atkS = max(0.003, atk * dur), decS = dec * dur, relS = max(0.008, rel * dur);
            var env = EnvGen.kr(Env.adsr(atkS, decS, sus, relS), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
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
    // bus into the sink's input bus. Runs at the sink group's head, after the bus's writer tracks
    // (which live in busGroup at the tree head), so the sum is already present this block.
    SynthDef(\poptart_busread, { |out, in, gain = 1|
        Out.ar(out, In.ar(in, 2) * gain);
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
    // The bounce itself. Nothing but a DiskOut: everything about WHEN it runs is decided by the
    // timestamped bundles that start and free it (see the recordTrack OSCdef), so the file's
    // length is sample-accurate rather than however long the messages took to arrive.
    SynthDef(\poptart_rec_disk, { |bus, buf|
        DiskOut.ar(buf, In.ar(bus, 2));
    }).add;
    // Parked buses + route bookkeeping for audio sidechains (see Sig#sidechain). Allocated once,
    // here, so every track synth's sc* args have a valid default (silence in, send to nowhere).
    silentBus = Bus.audio(server, 2);
    trashBus = Bus.audio(server, 2);
    sidechainByTarget = IdentityDictionary.new; // scKey -> (bus:, target:, slot:, source:)
    sidechainBySource = IdentityDictionary.new; // sourceKey (Symbol) -> scKey it currently feeds
    // Named-bus registry + the head group its writer tracks live in (see the var declaration).
    namedBuses = IdentityDictionary.new; // busName (Symbol) -> (bus: Bus, refs: Int)
    busGroup = Group.new(server, \addToHead);
    // Recorder taps read what the track synths wrote this block, so their group goes at the tail.
    recTaps = IdentityDictionary.new; // trackId (Symbol) -> (bus:, meter:, disk:, buf:, path:)
    recGroup = Group.new(server, \addToTail);
    server.sync;
    "poptart: server booted, ready".postln;
    // scsynth's pid rides along with the ready: node spawned US, not scsynth, so this is its only
    // handle on the process that actually holds the audio device and scsynth's UDP port. It uses
    // it to clean up after a stack that didn't shut down properly - see osc-engine/orphans.js.
    nodeAddr.sendMsg("/poptart/ready", server.pid ? -1);
    // Populate the plugin dict in the background so .synth("Name") can resolve names. Cached
    // plugins re-verify instantly; only new/changed ones get probed (out-of-process, with a
    // per-plugin timeout so a hang skips that plugin instead of stalling the scan).
    VSTPlugin.search(server, dir: searchDirs, options: searchOptions, verbose: true, action: {
        "poptart: initial plugin search done (% plugins)".format(VSTPlugin.plugins(server).size).postln;
    });
};

// --- track / chain management ---

OSCdef(\poptartCreateTrack, { |msg|
    var key = msg[1].asSymbol;
    if (tracks[key].isNil) {
        tracks[key] = \pending;
        fork {
            var group = Group.new(server);
            var inBus = Bus.audio(server, 2); // sample synths write here, the track synth mixes it in
            var def = buildTrackDef.(key);
            def.add; // sends to server + global SynthDescLib
            server.sync;
            tracks[key] = (
                def: def,
                group: group,
                inBus: inBus,
                synth: Synth(trackDefName.(key), [\inBus, inBus.index] ++ scArgsFor.(), target: group, addAction: \addToTail),
                controllers: Array.newClear(maxSlots),
                loaded: Array.newClear(maxSlots), // slot -> pluginId once open() succeeds
                wanted: Array.newClear(maxSlots), // slot -> pluginId an in-flight open() should commit
                lfos: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, shape:, index:)
                envs: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, index:)
                ccs: IdentityDictionary.new,      // \slotN_param -> (bus:, index:, lo:, hi:, last:, binding:, defKey:)
                editWatch: Array.newClear(maxSlots), // slot -> [OSCFunc] watching for plugin edits
                held: 0                           // active-note count, drives env gates
            );
        };
    };
}, '/poptart/createTrack');

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
    var notify = { nodeAddr.sendMsg("/poptart/pluginEdited", key, slot) };
    ctl.parameterAutomated = { |index, value|
        if (track[\confMode] == true) {
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

OSCdef(\poptartLoadInstrument, { |msg|
    var key = msg[1].asSymbol;
    var pluginId = msg[2].asString;
    fork {
        var track = awaitTrack.(key);
        if (track.isNil) { ("poptart: loadInstrument: no track " ++ key).warn } {
            // Livecoding re-eval sends the same chain again - don't reload an already-open plugin.
            if (track[\loaded][0] != pluginId) {
                var ctl = track[\controllers][0] ?? {
                    VSTPluginController(track[\synth], id: \slot0, synthDef: track[\def])
                };
                track[\controllers][0] = ctl;
                track[\loaded][0] = nil;
                ctl.open(resolvePlugin.(pluginId), editor: true, action: { |self, ok|
                    if (ok) {
                        track[\loaded][0] = pluginId;
                        // Emulated DAW transport from the first sample on: a rolling transport
                        // at the current tempo (position re-syncs via '/poptart/setTempo').
                        self.setPlaying(true);
                        self.setTempo(currentTempo);
                        watchPluginEdits.(track, key, 0, self);
                        ("poptart: loaded instrument " ++ pluginId).postln;
                    } {
                        ("poptart: FAILED to load instrument '" ++ pluginId
                            ++ "' (name must match a scanned plugin - see the plugin browser)").warn;
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
            var slot = if (position >= 1) { position } {
                (1..maxSlots - 1).detect { |i| track[\loaded][i].isNil } ? -1
            };
            case
            { (slot < 1) or: { slot >= maxSlots } } {
                ("poptart: no free effect slot on track " ++ key ++ " (max " ++ (maxSlots - 1) ++ ")").warn;
            }
            { (track[\loaded][slot] != pluginId) and: { track[\wanted][slot] != pluginId } } {
                var ctl = track[\controllers][slot] ?? {
                    VSTPluginController(track[\synth], id: ("slot" ++ slot).asSymbol, synthDef: track[\def])
                };
                track[\controllers][slot] = ctl;
                track[\loaded][slot] = nil;
                // `wanted` marks the open in flight: the action only commits (and un-bypasses)
                // if the slot still wants this plugin when the open completes - an unloadEffect
                // or a different loadEffect racing the async open must win. A failed open
                // clears it so the next eval retries.
                track[\wanted][slot] = pluginId;
                ctl.open(resolvePlugin.(pluginId), editor: true, action: { |self, ok|
                    if (ok) {
                        if (track[\wanted][slot] == pluginId) {
                            track[\loaded][slot] = pluginId;
                            self.setPlaying(true); // see loadInstrument
                            self.setTempo(currentTempo);
                            track[\synth].set(("active" ++ slot).asSymbol, 1); // un-bypass the slot
                            watchPluginEdits.(track, key, slot, self);
                            ("poptart: loaded effect " ++ pluginId ++ " in slot " ++ slot).postln;
                        };
                    } {
                        track[\wanted][slot] = nil;
                        ("poptart: FAILED to load effect '" ++ pluginId ++ "'").warn;
                    };
                });
            };
        };
    };
}, '/poptart/loadEffect');

// Commenting a .fx(...) out of a chain must actually silence it: re-bypass the slot, then
// close the plugin (close is what frees the plugin instance and its memory). The controller
// object is kept for reuse - a later loadEffect re-opens into it. No-op when the slot is
// already empty, so the scheduler can blanket-clear all trailing slots on every eval.
OSCdef(\poptartUnloadEffect, { |msg|
    var key = msg[1].asSymbol;
    var slot = msg[2].asInteger;
    fork {
        var track = awaitTrack.(key);
        if (track.isNil) { ("poptart: unloadEffect: no track " ++ key).warn } {
            if ((slot < 1) or: { slot >= maxSlots }) {
                ("poptart: unloadEffect: bad slot " ++ slot).warn;
            } {
                var ctl = track[\controllers][slot];
                track[\wanted][slot] = nil; // an in-flight open() must no longer commit
                if (track[\loaded][slot].notNil or: { ctl.notNil }) {
                    track[\synth].set(("active" ++ slot).asSymbol, 0); // bypass before the close
                    ctl !? { ctl.close };
                    // A closed plugin can't be edited - drop its auto-pin watchers (see
                    // watchPluginEdits) so they don't outlive it or fire on a reused node id.
                    track[\editWatch][slot] !? { |funcs| funcs.do { |f| f.free } };
                    track[\editWatch][slot] = nil;
                    track[\loaded][slot] !? { |id|
                        ("poptart: unloaded effect " ++ id ++ " from slot " ++ slot).postln;
                    };
                    track[\loaded][slot] = nil;
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
OSCdef(\poptartSetTempo, { |msg|
    var bpm = msg[1].asFloat, beats = msg[2].asFloat, latency = msg[3].asFloat;
    currentTempo = bpm;
    server.makeBundle(latency, {
        tracks.do { |track|
            if (track.isKindOf(Event)) {
                track[\loaded].do { |id, i|
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

// Note events also gate any env modulators on the track (in the same timestamped bundle, so
// envelope attacks line up sample-accurately with their notes). The gate follows a held-note
// count: opens on the first held note, closes (release phase) when the last one ends. The
// count is updated at message-receive time while the gate change executes at the bundled
// target time - correct as long as events arrive in onset order (they do: the scheduler walks
// steps in order), with one known imperfection: for *overlapping different-length* notes the
// release can start at the first note's end. Fine for the arps/chords this is built for.
OSCdef(\poptartNoteOn, { |msg|
    var key = msg[1].asSymbol, note = msg[2].asInteger;
    var veloc = msg[3].asFloat, latency = msg[4].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    var fire;
    if (ctl.notNil) {
        fire = { |lat|
            server.makeBundle(lat, {
                ctl.midi.noteOn(0, note, (veloc * 127).round.asInteger);
                track[\envs].do { |e| e[\synth].set(\gate, 1) };
                // note-synced lfo() shapes: reset/replay on every note onset - and this is where a
                // patterned shape's swap actually happens in those modes, just before the trigger, so
                // the note gets the new shape from its beginning rather than halfway through the old.
                track[\lfos].do { |e|
                    e[\pending] !? { |f| f.value; e[\pending] = nil };
                    if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
                };
            });
        };
        track[\held] = track[\held] + 1;
        // A swap due at or before this note's onset means the plugin will be mid-load when it would
        // have sounded, so it waits for the program instead (see waitForLoad) - the note at a
        // `.preset("<a b>")` boundary is the one that used to be eaten.
        if (waitForLoad.(key, 0, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOn');

OSCdef(\poptartNoteOff, { |msg|
    var key = msg[1].asSymbol, note = msg[2].asInteger, latency = msg[3].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    var fire;
    if (ctl.notNil) {
        fire = { |lat|
            server.makeBundle(lat, {
                ctl.midi.noteOff(0, note, 0);
                if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
            });
        };
        track[\held] = max(0, track[\held] - 1);
        // Queued behind its own note-on when one is waiting, or the note would never be released.
        if (waitForLoad.(key, 0, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOff');

// MIDI to a specific plugin in the chain (Sig#trig / '/poptart/noteOnSlot'): a side channel to
// one slot's plugin, so - unlike the instrument noteOn above - it does NOT touch the track's
// held-note count or gate its env()/lfo() modulators (those follow the track's own voice, which
// this stream isn't). Slot 0 is the instrument, 1..n the effects. A note-off matches the same
// slot + pitch, so a ducker sees a gate exactly as long as the triggering step.
OSCdef(\poptartNoteOnSlot, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, note = msg[3].asInteger;
    var veloc = msg[4].asFloat, latency = msg[5].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) {
        var fire = { |lat| server.makeBundle(lat, { ctl.midi.noteOn(0, note, (veloc * 127).round.asInteger.clip(1, 127)) }) };
        if (waitForLoad.(key, slot, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOnSlot');

OSCdef(\poptartNoteOffSlot, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, note = msg[3].asInteger, latency = msg[4].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) {
        var fire = { |lat| server.makeBundle(lat, { ctl.midi.noteOff(0, note, 0) }) };
        if (waitForLoad.(key, slot, Main.elapsedTime + latency, fire).not) { fire.(latency) };
    };
}, '/poptart/noteOffSlot');

OSCdef(\poptartSetParam, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger;
    var paramName = msg[3].asString, value = msg[4].asFloat, latency = msg[5].asFloat;
    var track = tracks[key];
    var ctl;
    if (track.isKindOf(Event)) {
        if (slot == -1) {
            // Channel controls (gain/pan) live on the track synth itself, not a plugin. Not
            // clipped to 0..1 - gain may exceed unity, pan is -1..1 (the SynthDef clips sanely).
            server.makeBundle(latency, { track[\synth].set(paramName.asSymbol, value) });
        } {
            ctl = track[\controllers][slot];
            if (ctl.notNil) {
                // Resolve by name (or a "Name#N" index suffix - see resolveParamIndex) and set
                // that specific parameter; values are normalized 0..1.
                server.makeBundle(latency, {
                    var index = resolveParamIndex.(ctl.info, paramName);
                    if (index.notNil) { ctl.set(index, value.clip(0, 1)) };
                });
            };
        };
    };
}, '/poptart/setParam');

// Tier 2: map a control bus to the VST parameter once, drive the bus with a UGen oscillator
// running in scsynth's audio callback - zero further OSC traffic, genuinely continuous.
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
    fork {
        var track = awaitTrack.(key);
        var isChannel, ctl, index, lfoKey, existing;
        if (track.isNil) { ("poptart: setParamLFO: no track " ++ key).warn } {
            isChannel = slot == -1;
            if (isChannel.not and: { awaitLoaded.(track, slot).not }) {
                ("poptart: setParamLFO: no plugin loaded in slot " ++ slot).warn;
            } {
                if (isChannel.not) {
                    ctl = track[\controllers][slot];
                    index = resolveParamIndex.(ctl.info, paramName);
                };
                if (isChannel.not and: { index.isNil }) {
                    ("poptart: setParamLFO: plugin has no parameter named '" ++ paramName
                        ++ "' (see getParams / the plugin browser for real names)").warn;
                } {
                    lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\lfos][lfoKey];
                    // Warn on creation only: signal-valued bounds re-send continuously and may
                    // legitimately swing wide momentarily. Channel controls have their own ranges.
                    if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: LFO range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    case
                    { existing.notNil and: { existing[\shape] == shape } } {
                        existing[\synth].set(\freq, rateHz, \lo, lo, \hi, hi); // phase preserved
                    }
                    { existing.notNil } { // shape changed: new oscillator, same bus + mapping
                        existing[\synth].free;
                        existing[\synth] = Synth(("poptart_lfo_" ++ shape).asSymbol,
                            [\out, existing[\bus], \freq, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi],
                            target: track[\group], addAction: \addToHead);
                        existing[\shape] = shape;
                    }
                    {
                        var bus = Bus.control(server, 1);
                        var lfoSynth = Synth(("poptart_lfo_" ++ shape).asSymbol,
                            [\out, bus, \freq, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi],
                            target: track[\group], addAction: \addToHead);
                        if (isChannel) { track[\synth].map(paramName.asSymbol, bus) } { ctl.map(index, bus) };
                        track[\lfos][lfoKey] = (synth: lfoSynth, bus: bus, shape: shape, index: index);
                    };
                };
            };
        };
    };
}, '/poptart/setParamLFO');

// Phase re-anchor for a free-running LFO (basic shapes and free-mode lfo() shapes): resets the
// modulator's Sweep to `phase` at the bundled target time. The scheduler sends one shortly
// after creating an LFO and every few seconds thereafter, pinning the modulator to its clock
// so audio-clock skew can't accumulate into drift against the note grid; each correction is
// only the skew of a few seconds (microseconds), inaudible. One arriving while the LFO is
// still being set up (the setParamLFO fork awaiting the plugin) finds no entry and is dropped -
// the next periodic anchor locks it.
OSCdef(\poptartAnchorParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var phase = msg[4].asFloat, latency = msg[5].asFloat;
    var track = tracks[key];
    var entry = if (track.isKindOf(Event)) { track[\lfos][("slot" ++ slot ++ "_" ++ paramName).asSymbol] };
    if (entry.notNil) {
        server.makeBundle(latency, { entry[\synth].set(\t_trig, 1, \phase, phase) });
    };
}, '/poptart/anchorParamLFO');

// lfo() drawn shapes: compile a tiny SynthDef from the breakpoints (an IEnvGen indexed by a
// Sweep-driven phase) and run it on the same bus+map mechanism as setParamLFO. Modes:
//   free      - loops on its own clock, ignores notes
//   retrigger - loops, but phase resets on each noteOn (Sweep reset trigger)
//   envelope  - one pass per noteOn over 1/rate seconds, then holds the final level
// A re-send with identical points+mode only updates rate/range in place (phase preserved,
// livecoding-friendly); changed points/mode recompile the def and swap the synth on the same
// bus, keeping the parameter mapping.
OSCdef(\poptartSetParamShapeLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var mode = msg[4].asSymbol, rateHz = msg[5].asFloat, phaseCycles = msg[6].asFloat;
    var lo = msg[7].asFloat, hi = msg[8].asFloat, pointsJson = msg[9].asString;
    // Every shape a patterned lfo("<pluck swell>") can reach, and how long a swap between them
    // glides, as a fraction of one period. Older senders pass neither: one shape, no glide.
    var shapesJson = (msg[10] ? pointsJson).asString;
    var glide = (msg[11] ? 0).asFloat;
    fork {
        var track = awaitTrack.(key);
        var isChannel, ctl, index, lfoKey, existing, spec;
        var shapes, defNames, bus, shapeSynth;
        if (track.isNil) { ("poptart: setParamShapeLFO: no track " ++ key).warn } {
            isChannel = slot == -1;
            if (isChannel.not and: { awaitLoaded.(track, slot).not }) {
                ("poptart: setParamShapeLFO: no plugin loaded in slot " ++ slot).warn;
            } {
                if (isChannel.not) {
                    ctl = track[\controllers][slot];
                    index = resolveParamIndex.(ctl.info, paramName);
                };
                if (isChannel.not and: { index.isNil }) {
                    ("poptart: setParamShapeLFO: plugin has no parameter named '" ++ paramName ++ "'").warn;
                } {
                    if (isChannel.not and: { track[\lfos][("slot" ++ slot ++ "_" ++ paramName).asSymbol].isNil }
                        and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: shape range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin").warn;
                    };
                    // parseJSON yields string values - convert everything explicitly.
                    shapes = shapesJson.parseJSON;
                    // Rate/range still update a running modulator in place (phase carries across a
                    // livecoding edit); anything that changes the SHAPES rebuilds. glide is in the
                    // spec because it is a def argument only - the swap reads it off the entry.
                    spec = mode.asString ++ "|" ++ glide.asString ++ "|" ++ shapesJson;
                    lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\lfos][lfoKey];
                    if (existing.notNil and: { existing[\spec] == spec }) {
                        existing[\synth].set(\rate, rateHz, \lo, lo, \hi, hi);
                        // A swap has to start the next shape at this one's rate and range.
                        existing[\rate] = rateHz; existing[\lo] = lo; existing[\hi] = hi;
                    } {
                        // One def per shape, all compiled now: a swap has to be a timestamped
                        // switch between ready synths. Building a def at swap time is async and
                        // would land whenever it landed, which is not what "on the beat" means.
                        defNames = shapes.collect { |points, i|
                            var xs = points.collect { |p| p["x"].asFloat };
                            var ys = points.collect { |p| p["y"].asFloat };
                            var cs = points.collect { |p| (p["c"] ? "0").asFloat };
                            var times = (1..xs.size - 1).collect { |k| max(0, xs[k] - xs[k - 1]) }; // sums to 1
                            var curves = cs.copyRange(0, cs.size - 2);
                            var defName = ("poptart_shape_" ++ key ++ "_" ++ lfoKey ++ "_" ++ i).asSymbol;
                            SynthDef(defName, { |out, rate = 1, phase = 0, lo = 0, hi = 1, t_trig = 0,
                                glideSec = 0, glideOn = 0|
                                var env = Env(ys, times, curves);
                                var idx = switch(mode,
                                    \retrigger, { (Sweep.kr(t_trig, rate) + phase) % 1 },
                                    \envelope, { Sweep.kr(t_trig, rate).min(1) },
                                    // free (default): t_trig is the anchor reset (only free mode
                                    // gets '/poptart/anchorParamLFO' corrections - in the gated
                                    // modes the trigger belongs to note onsets)
                                    { (Sweep.kr(t_trig, rate) + phase) % 1 }
                                );
                                var shaped = lo + (IEnvGen.kr(env, idx) * (hi - lo));
                                // Swap glide. A shape change restarts the new shape from its
                                // beginning, which in general is nowhere near where the outgoing
                                // one had got to - a step in a filter cutoff, audible as a click.
                                // So the difference is measured once, at birth, and decays away
                                // over glideSec: out = newShape(t) + (oldValue - newShape(0)) *
                                // decay(t). In.kr reads the bus this synth is about to write, so
                                // at its first block that is still the OUTGOING synth's last
                                // value - the swap frees the old one in the same bundle, after
                                // this one is made, so it never runs again to overwrite it.
                                // glideOn is 0 for the first synth on a bus, which has no
                                // predecessor and would otherwise glide up from whatever the bus
                                // happened to be holding.
                                var born = Impulse.kr(0);
                                var offset = (Latch.kr(In.kr(out), born) - Latch.kr(shaped, born)) * glideOn;
                                Out.kr(out, shaped + (offset * EnvGen.kr(Env([1, 0], [max(glideSec, 0.001)], -4))));
                            }).add;
                            defName;
                        };
                        server.sync;
                        if (existing.notNil) {
                            existing[\synth].free;
                            bus = existing[\bus];
                        } {
                            bus = Bus.control(server, 1);
                        };
                        shapeSynth = Synth(defNames[0],
                            [\out, bus, \rate, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi,
                             \t_trig, if ((mode != \free) and: { track[\held] > 0 }) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        if (existing.isNil) {
                            if (isChannel) { track[\synth].map(paramName.asSymbol, bus) } { ctl.map(index, bus) };
                            track[\lfos][lfoKey] = (synth: shapeSynth, bus: bus, shape: \custom,
                                index: index, mode: mode, spec: spec,
                                defs: defNames, current: 0, glide: glide,
                                rate: rateHz, lo: lo, hi: hi, group: track[\group]);
                        } {
                            existing[\synth] = shapeSynth;
                            existing[\shape] = \custom;
                            existing[\mode] = mode;
                            existing[\spec] = spec;
                            existing[\defs] = defNames;
                            existing[\current] = 0;
                            existing[\glide] = glide;
                            existing[\rate] = rateHz; existing[\lo] = lo; existing[\hi] = hi;
                            existing[\pending] = nil; // a queued swap into shapes that are gone
                        };
                    };
                };
            };
        };
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
    var track = tracks[key];
    var lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\lfos][lfoKey] };
    var swap;
    if (existing.notNil and: { existing[\defs].notNil }
        and: { index >= 0 } and: { index < existing[\defs].size }
        and: { index != existing[\current] }) {
        swap = {
            var old = existing[\synth];
            var rate = existing[\rate] ? 1;
            // glide is a fraction of one LFO PERIOD, so what it is worth in seconds follows the
            // rate: a slow modulator glides slowly, which is what makes it read as one gesture.
            var glideSec = (existing[\glide] ? 0) / max(rate.abs, 0.001);
            var next = Synth(existing[\defs][index],
                [\out, existing[\bus], \rate, rate, \phase, 0,
                 \lo, existing[\lo] ? 0, \hi, existing[\hi] ? 1,
                 \t_trig, if (existing[\mode] == \free) { 0 } { 1 },
                 \glideSec, glideSec, \glideOn, if (glideSec > 0) { 1 } { 0 }],
                target: existing[\group], addAction: \addToHead);
            existing[\synth] = next;
            existing[\current] = index;
            old.free; // after the new one is made, so its In.kr still sees this one's last value
        };
        if (existing[\mode] == \free) {
            server.makeBundle(latency, swap);
        } {
            existing[\pending] = swap;
        };
    };
}, '/poptart/setParamShape');

// Tier 2, envelope flavor: same bus+map mechanism as setParamLFO, but the modulator is an
// EnvGen gated by the track's note events (see noteOn/noteOff above). Re-eval updates the
// running synth's args in place - a mid-note livecoding edit doesn't cut the envelope off.
OSCdef(\poptartSetParamEnv, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var atk = msg[4].asFloat, dec = msg[5].asFloat, sus = msg[6].asFloat, rel = msg[7].asFloat;
    var curve = msg[8].asFloat, lo = msg[9].asFloat, hi = msg[10].asFloat;
    fork {
        var track = awaitTrack.(key);
        var isChannel, ctl, index, envKey, existing;
        if (track.isNil) { ("poptart: setParamEnv: no track " ++ key).warn } {
            isChannel = slot == -1;
            if (isChannel.not and: { awaitLoaded.(track, slot).not }) {
                ("poptart: setParamEnv: no plugin loaded in slot " ++ slot).warn;
            } {
                if (isChannel.not) {
                    ctl = track[\controllers][slot];
                    index = resolveParamIndex.(ctl.info, paramName);
                };
                if (isChannel.not and: { index.isNil }) {
                    ("poptart: setParamEnv: plugin has no parameter named '" ++ paramName
                        ++ "' (see getParams / the params panel for real names)").warn;
                } {
                    envKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\envs][envKey];
                    if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                        ("poptart: env range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    if (existing.notNil) {
                        existing[\synth].set(\atk, atk, \dec, dec, \sus, sus, \rel, rel, \curve, curve, \lo, lo, \hi, hi);
                    } {
                        var bus = Bus.control(server, 1);
                        var envSynth = Synth(\poptart_env,
                            [\out, bus, \atk, atk, \dec, dec, \sus, sus, \rel, rel, \curve, curve, \lo, lo, \hi, hi,
                             \gate, if (track[\held] > 0) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        if (isChannel) { track[\synth].map(paramName.asSymbol, bus) } { ctl.map(index, bus) };
                        track[\envs][envKey] = (synth: envSynth, bus: bus, index: index);
                    };
                };
            };
        };
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
        if (slot == -1) {
            track[\synth].map(paramName.asSymbol, -1);
            track[\synth].set(paramName.asSymbol, channelDefault.(paramName));
        } {
            track[\controllers][slot].unmap(existing[\index]);
        };
        existing[\synth].free;
        existing[\bus].free;
        track[\envs].removeAt(envKey);
    };
}, '/poptart/clearParamEnv');

OSCdef(\poptartClearParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\lfos][lfoKey] };
    if (existing.notNil) {
        if (slot == -1) {
            track[\synth].map(paramName.asSymbol, -1);
            track[\synth].set(paramName.asSymbol, channelDefault.(paramName));
        } {
            track[\controllers][slot].unmap(existing[\index]);
        };
        existing[\synth].free;
        existing[\bus].free;
        track[\lfos].removeAt(lfoKey);
    };
}, '/poptart/clearParamLFO');

// --- live MIDI input ---

// Node asks for MIDI explicitly when a pattern's only MIDI use is Tier-1 (the native handlers
// below all enable it themselves).
OSCdef(\poptartMidiInit, { midiEnable.() }, '/poptart/midiInit');

// Connected sources as the "device name" strings midicc()/midikeys() match against, for the
// editor's device autocomplete. Enables MIDI input as a side effect: the only caller is someone
// typing a MIDI builder, so it's about to be on anyway (and midiEnable is idempotent). Devices
// plugged in after this first init won't appear until a restart - CoreMIDI's source list here
// is a snapshot taken by MIDIClient.init.
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
        var isChannel, ctl, index, ccKey, existing, src, binding, defKey, registerDef;
        if (track.isNil) { ("poptart: setParamCC: no track " ++ key).warn } {
            midiEnable.();
            isChannel = slot == -1;
            if (isChannel.not and: { awaitLoaded.(track, slot).not }) {
                ("poptart: setParamCC: no plugin loaded in slot " ++ slot).warn;
            } {
                if (isChannel.not) {
                    ctl = track[\controllers][slot];
                    index = resolveParamIndex.(ctl.info, paramName);
                };
                if (isChannel.not and: { index.isNil }) {
                    ("poptart: setParamCC: plugin has no parameter named '" ++ paramName
                        ++ "' (see getParams / the params panel for real names)").warn;
                } {
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
                        };
                        if (existing.isNil and: { isChannel.not } and: { (lo < 0) or: { hi > 1 } }) {
                            ("poptart: CC range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                                ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                                + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                        };
                        if (existing.notNil) {
                            existing[\lo] = lo;
                            existing[\hi] = hi;
                            if (existing[\binding] != binding) {
                                existing[\binding] = binding;
                                registerDef.(existing); // same defKey - replaces the old MIDIdef
                            };
                            existing[\bus].set(lo + (existing[\last] * (hi - lo)));
                        } {
                            var bus = Bus.control(server, 1);
                            var entry = (bus: bus, index: index, lo: lo, hi: hi, last: 0,
                                binding: binding, defKey: defKey);
                            bus.set(lo); // hardware position unknown until the knob moves - start at the floor
                            registerDef.(entry);
                            if (isChannel) { track[\synth].map(paramName.asSymbol, bus) } { ctl.map(index, bus) };
                            track[\ccs][ccKey] = entry;
                        };
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
        if (slot == -1) {
            track[\synth].map(paramName.asSymbol, -1);
            track[\synth].set(paramName.asSymbol, channelDefault.(paramName));
        } {
            track[\controllers][slot].unmap(existing[\index]);
        };
        existing[\bus].free;
        track[\ccs].removeAt(ccKey);
    };
}, '/poptart/clearParamCC');

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
    fork {
        var track = awaitTrack.(key);
        var src, uid, chanArg, kOn, kOff, kBend, kTouch, kPoly, kCc, scalePcs, quantize;
        // .scale() on a midikeys() chain: snap each incoming note to the nearest of the scale's
        // pitch classes (ties resolve downward). noteOff/polytouch quantize identically, so
        // releases always match their onsets. Two adjacent keys can land on the same note - the
        // synth just sees a retrigger, and the track's held-count still gates envs correctly.
        scalePcs = if (scaleStr.isEmpty) { nil } { scaleStr.split($,).collect(_.asInteger) };
        quantize = { |note|
            var q = note;
            if (scalePcs.notNil) {
                block { |break|
                    (0..11).do { |d|
                        if (scalePcs.includes((note - d) % 12)) { q = note - d; break.() };
                        if (scalePcs.includes((note + d) % 12)) { q = note + d; break.() };
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
                MIDIdef.noteOn(kOn, { |veloc, note, chan|
                    var ctl = track[\controllers][0];
                    note = quantize.(note);
                    // Every note edge also goes to Node (the note as it sounds, post-quantize) -
                    // that's the feed web-app's MIDI record collects. Sent before the ctl check
                    // so recording works even while the instrument is still opening.
                    nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note,
                        veloc / 127.0, if (veloc > 0) { 1 } { 0 });
                    if (ctl.notNil) {
                        if (veloc > 0) {
                            track[\held] = track[\held] + 1;
                            ctl.midi.noteOn(chan, note, veloc);
                            track[\envs].do { |e| e[\synth].set(\gate, 1) };
                            track[\lfos].do { |e|
                                if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
                            };
                        } {
                            // running-status note-on with velocity 0 = note-off
                            track[\held] = max(0, track[\held] - 1);
                            ctl.midi.noteOff(chan, note, 0);
                            if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
                        };
                    };
                }, chan: chanArg, srcID: uid);
                MIDIdef.noteOff(kOff, { |veloc, note, chan|
                    var ctl = track[\controllers][0];
                    note = quantize.(note);
                    nodeAddr.sendMsg("/poptart/midiNoteIn", key.asString, note, veloc / 127.0, 0);
                    if (ctl.notNil) {
                        track[\held] = max(0, track[\held] - 1);
                        ctl.midi.noteOff(chan, note, veloc);
                        if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
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
                track[\midiRoute] = (keys: [kOn, kOff, kBend, kTouch, kPoly, kCc]);
                ("poptart: track " ++ key ++ " playing live from " ++ src.device ++ " " ++ src.name
                    ++ (if (channel > 0) { " (channel " ++ channel ++ ")" } { " (all channels)" })).postln;
            };
        };
    };
}, '/poptart/midiRoute');

// Tearing a route down also silences anything still sounding: gates close, and CC 123 (all
// notes off) goes out on every channel so a key held across a mute/stop doesn't drone.
OSCdef(\poptartClearMidiRoute, { |msg|
    var key = msg[1].asSymbol;
    var track = tracks[key];
    if (track.isKindOf(Event) and: { track[\midiRoute].notNil }) {
        track[\midiRoute][\keys].do { |k| MIDIdef.all[k] !? { |d| d.free } };
        track[\midiRoute] = nil;
        track[\held] = 0;
        track[\envs].do { |e| e[\synth].set(\gate, 0) };
        track[\controllers][0] !? { |ctl| 16.do { |c| ctl.midi.control(c, 123, 0) } };
    };
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
// and gets freed). The writer track is moved into busGroup at the tree head so it executes before
// any reader that In.ar's the bus. Sends past maxBusSends are dropped (with a warning).
OSCdef(\poptartSetBusSends, { |msg|
    var key = msg[1].asSymbol;
    var pairs = msg.drop(2);
    fork {
        var track = awaitTrack.(key);
        track !? {
            var requested = pairs.size div: 2;
            var n = min(maxBusSends, requested);
            var newNames = [];
            if (requested > maxBusSends) {
                ("poptart: .bus(): track " ++ key ++ " asked for " ++ requested ++ " sends; only "
                    ++ maxBusSends ++ " are supported - extra buses dropped").warn;
            };
            n.do { |i|
                var name = pairs[i * 2].asString;
                var amt = pairs[(i * 2) + 1].asFloat;
                track[\synth].set(("busOut" ++ (i + 1)).asSymbol, acquireBus.(name).index, ("busSend" ++ (i + 1)).asSymbol, amt);
                newNames = newNames.add(name);
            };
            for (n, maxBusSends - 1, { |i|
                track[\synth].set(("busOut" ++ (i + 1)).asSymbol, trashBus.index, ("busSend" ++ (i + 1)).asSymbol, 0);
            });
            track[\busSends] !? { |prev| prev.do { |bn| releaseBus.(bn) } };
            track[\busSends] = newNames;
            track[\group].moveToHead(busGroup);
            busGroup.moveToHead(server.defaultGroup);
        };
    };
}, '/poptart/setBusSends');

OSCdef(\poptartClearBusSends, { |msg|
    var key = msg[1].asSymbol;
    var track = tracks[key];
    if (track.isKindOf(Event)) {
        for (0, maxBusSends - 1, { |i|
            track[\synth].set(("busOut" ++ (i + 1)).asSymbol, trashBus.index, ("busSend" ++ (i + 1)).asSymbol, 0);
        });
        track[\busSends] !? { |prev| prev.do { |bn| releaseBus.(bn) }; track[\busSends] = nil };
        track[\group].moveToHead(server.defaultGroup); // back into the normal (reader) node order
    };
}, '/poptart/clearBusSends');

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
        samplePacks[pack] !? { |old| old.do { |b| b.free } };
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
            bufs.do { |b| b.free };
            samplePacks[pack] = nil;
            replyErr.("/poptart/loadSamplePack", requestId,
                "the audio server ran out of buffers loading " ++ paths.size ++ " file(s) ("
                ++ bufs.size ++ " read before it gave out) - other packs already loaded this "
                ++ "session hold the rest. Restart the engine, or raise numBuffers in poptart.scd.");
        } {
            samplePacks[pack] = bufs;
            ("poptart: sample pack '" ++ pack ++ "': " ++ done ++ "/" ++ bufs.size ++ " file(s) read").postln;
            replyOk.("/poptart/loadSamplePack", requestId, toJson.(bufs.collect { |b|
                (frames: b.numFrames ? 0, sampleRate: b.sampleRate ? 0, channels: b.numChannels ? 0)
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
    // ADSR envelope: atk/dec/rel are fractions of dur (SC scales them), sus is a 0..1 level.
    // Defaults of 0/0/1/0 floor down to the old declick env inside the synthdef.
    var atk = (msg[14] ? 0).asFloat, dec = (msg[15] ? 0).asFloat;
    var sus = (msg[16] ? 1).asFloat, rel = (msg[17] ? 0).asFloat;
    // Loop shape (only read by the loop defs): the region it runs round, where it enters, and
    // whether it bounces off the edges instead of wrapping. See .loop()'s wrap/dir options.
    var loopLo = (msg[18] ? 0).asFloat, loopHi = (msg[19] ? 1).asFloat;
    var entry = (msg[20] ? 0).asFloat, pingpong = (msg[21] ? 0).asInteger;
    var args;
    var track = tracks[key];
    var bufs = samplePacks[pack];
    var buf = bufs !? { bufs.wrapAt(idx) };
    var warp = (stretch - 1).abs > 1e-4;
    var gated = (loop == 1) or: { cut == 1 };
    var defName, synth;
    if (track.isKindOf(Event) and: { buf.notNil } and: { (buf.numFrames ? 0) > 0 }) {
        defName = ("poptart_sample_" ++ (if (warp) { "warp_" } { "" })
            ++ (if (loop == 1) { "loop_" } { "" }) ++ buf.numChannels).asSymbol;
        track[\held] = track[\held] + 1;
        args = [\out, track[\inBus].index, \buf, buf, \begin, begin, \end, end,
                \rate, rate, \dur, dur, \gate, 1, \amp, amp,
                \atk, atk, \dec, dec, \sus, sus, \rel, rel];
        // Only the loop defs have these controls - appended just for them rather than sent to a
        // one-shot def that would ignore them (and log a "control not found" for each).
        if (loop == 1) {
            args = args ++ [\loopLo, loopLo, \loopHi, loopHi, \entry, entry, \pingpong, pingpong];
        };
        server.makeBundle(latency, {
            synth = Synth(defName, args, target: track[\group], addAction: \addToHead);
            track[\envs].do { |e| e[\synth].set(\gate, 1) };
            track[\lfos].do { |e|
                if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
            };
        });
        if (gated) {
            server.makeBundle(stopLatency, { synth.set(\gate, 0) });
        };
        SystemClock.sched(if (gated) { stopLatency } { latency + dur }, {
            track[\held] = max(0, track[\held] - 1);
            if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
            nil
        });
    };
}, '/poptart/playSample');

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
                ctl.readProgram(path, action: { |self, ok|
                    if (ok) {
                        ("poptart: restored plugin state for " ++ key ++ " slot " ++ slot).postln;
                    } {
                        ("poptart: FAILED to restore plugin state for " ++ key ++ " slot " ++ slot).warn;
                    };
                    clearPending.(seqKey, seq);
                    File.delete(path);
                });
            } {
                ("poptart: setPluginState: no loaded plugin in " ++ key ++ " slot " ++ slot).warn;
                clearPending.(seqKey, seq); // nothing to load into: don't hold its notes back
                File.delete(path);
            };
        }};
    };
    // Recorded at RECEIPT, not at apply time: that is what lets a message sent later cancel one
    // still waiting. A restore that is already stale on arrival (out of order) never runs at all.
    if (seq >= (stateSeqs[seqKey] ? 0)) {
        stateSeqs[seqKey] = seq;
        // Same reason, for the notes: a swap and the notes at its onset are sent together, a
        // lookahead early, and a note is a timestamped bundle the moment it is handled - so "a load
        // is coming at this time" has to be true HERE, not when the load starts (see waitForLoad).
        statePending[seqKey] = (seq: seq, at: Main.elapsedTime + latency);
        // The notes waiting on this load are released the moment the program is in - or by this,
        // whatever the plugin does or fails to do. A late note is a bug; notes held for the length
        // of a cold plugin open, and then all played at once, is a disaster.
        SystemClock.sched(latency + stateWaitMax, { clearPending.(seqKey, seq); nil });
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
    if (seq >= (stateSeqs[seqKey] ? 0)) {
        stateSeqs[seqKey] = seq;
        statePending[seqKey] = (seq: seq, at: Main.elapsedTime + latency);
        SystemClock.sched(latency + stateWaitMax, { clearPending.(seqKey, seq); nil });
    };
}, '/poptart/statePending');

OSCdef(\poptartScanPlugins, { |msg|
    var requestId = msg[1];
    // extraPaths (msg[2], JSON array) not wired through yet; POPTART_VST_DIRS covers the
    // custom-directory need for now.
    VSTPlugin.search(server, dir: searchDirs, options: searchOptions, verbose: true, action: {
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
        track[\synth].set(\recOut, bus.index, \recSend, 1);
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
        if (track.isKindOf(Event)) { track[\synth].set(\recSend, 0, \recOut, trashBus.index) };
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
            server.makeBundle(max(0, startLatency - setupSec), {
                entry[\disk] = Synth(\poptart_rec_disk, [\bus, entry[\bus].index, \buf, buf],
                    target: recGroup, addAction: \addToTail);
            });
            server.makeBundle(max(0, stopLatency - setupSec), { entry[\disk].free });
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
