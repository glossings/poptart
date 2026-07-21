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
// Plugin directories to scan. Priority: POPTART_VST_DIRS (colon-separated) if set, else
// ~/.poptart/plugins if it exists (a folder of symlinks to just the plugins being played),
// else VSTPlugin's standard locations. The curated folder is the default on purpose: a full
// default-location scan reproducibly kills scsynth on the dev machine (exit 0, pre-probe -
// looks like a VSTPlugin scan bug worth reporting upstream, not one bad plugin: the usual
// crashers probe fine individually), and relying on an env var meant any launch without it
// silently fell back to the scsynth-killing full scan.
var searchDirs = "POPTART_VST_DIRS".getenv !? { |p| p.split($:) }
    ?? { var d = "~/.poptart/plugins".standardizePath; if (File.exists(d)) { [d] } };
// Plugins skipped explicitly during scans (VSTPlugin's exclude option, which prunes these
// paths from the directory traversal so they're never probed). Defaults are the known-bad
// ones on the dev machine: Mellotron V and Jun-6 V segfault their probe subprocess; Melodyne ("couldn't
// get plugin factory") and CloudSeed ("operation not permitted") fail every scan and just
// spam the log; SpaceBlender and both MORPH 3 PRO variants are unwanted in the plugin list.
// POPTART_VST_EXCLUDE (colon-separated paths) appends more without editing this.
var excludePaths = [
    "/Library/Audio/Plug-Ins/VST3/Mellotron V.vst3",
    "/Library/Audio/Plug-Ins/VST3/Jun-6 V.vst3",
    "/Library/Audio/Plug-Ins/VST3/Melodyne.vst3",
    "/Library/Audio/Plug-Ins/VST3/CloudSeed.vst3",
    "/Library/Audio/Plug-Ins/VST3/Soundtoys/SpaceBlender.vst3",
    "/Library/Audio/Plug-Ins/VST3/MORPH 3 PRO VST3.vst3",
    "/Library/Audio/Plug-Ins/VST3/MORPH 3 PRO DualMonoIn VST3.vst3"
] ++ ("POPTART_VST_EXCLUDE".getenv !? { |p| p.split($:) } ? []);
var maxSlots = 8; // slot 0 = instrument, 1..7 = effects
// scsynth's own port, overridable so a second poptart stack (tests, parallel session) doesn't
// collide with a running one on the default 57110.
var scsynthPort = ("POPTART_SCSYNTH_PORT".getenv ? "57110").asInteger;
var server = Server(\poptart, NetAddr("127.0.0.1", scsynthPort), Server.default.options);
var nodeAddr = NetAddr("127.0.0.1", nodePort);
// trackId (Symbol) -> (def:, group:, synth:, controllers:, loaded:, lfos:, envs:, held:).
// Symbol keys, NOT Strings: IdentityDictionary lookups are by identity, and two equal Strings
// are distinct objects (incoming OSC string args arrive as Symbols anyway).
var tracks = IdentityDictionary.new;
var samplePacks = IdentityDictionary.new; // pack (Symbol) -> Array of Buffers, filename order
var jsonEscape, toJson, replyOk, replyErr, pluginList, trackDefName, buildTrackDef;
var awaitTrack, awaitLoaded, resolvePlugin;
var midiInitialized = false, midiWarned = IdentitySet.new;
var midiEnable, midiNameForUid, midiSourceFor, midiWarnMissing;

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
    SynthDef(trackDefName.(key), { |inBus, gain = 1, pan = 0|
        var sig = Silent.ar(2);
        maxSlots.do { |i|
            if (i == 0) {
                // The instrument slot's output, plus whatever the track's sample synths wrote
                // to the private input bus this block (sample synths sit at the group's head,
                // this synth at its tail, so In.ar sees them) - samples run through the same
                // fx chain a VST instrument would.
                sig = VSTPlugin.ar(nil, 2, id: \slot0) + In.ar(inBus, 2);
            } {
                // An empty VSTPlugin slot outputs silence, not pass-through - so each fx slot
                // gets a bypass switch, flipped on only once a plugin actually loads into it.
                var wet = VSTPlugin.ar(sig, 2, id: ("slot" ++ i).asSymbol);
                sig = Select.ar(("active" ++ i).asSymbol.kr(0), [sig, wet]);
            };
        };
        // Channel strip (post-chain): gain + equal-power pan, addressed from Node as pseudo-slot
        // -1 (Sig#gain/#pan; setParam sets these controls, setParam[Shape]LFO/Env map busses to
        // them). Lag smooths the ~30ms Tier-1 polling steps; clip keeps a runaway signal sane.
        sig = Balance2.ar(sig[0], sig[1], pan.lag(0.02).clip(-1, 1), gain.lag(0.02).clip(0, 4));
        Out.ar(0, sig);
    });
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

// `.synth("Serum 2")` uses the display name, but VSTPlugin's dict keys carry the file extension
// ('Serum 2.vst3') - accept exact key, display name, or a literal file path.
resolvePlugin = { |pluginId|
    var dict = VSTPlugin.plugins(server);
    var desc = dict[pluginId.asSymbol] ?? { dict.values.detect { |d| d.name == pluginId } };
    desc !? { desc.key } ? pluginId;
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

server.waitForBoot {
    // rand = continuous smoothed random (cubic-interpolated noise; a new target per period),
    // phase ignored. ramp is a rising saw, same shape as \saw here. Stepped random is done
    // pattern-side via rand().hold(...) - no native def needed.
    [\sine, \tri, \saw, \ramp, \square, \rand].do { |shape|
        SynthDef(("poptart_lfo_" ++ shape).asSymbol, { |out, freq = 1, phase = 0, lo = 0, hi = 1|
            var osc = switch(shape,
                \sine, { SinOsc.kr(freq, phase * 2pi) },
                \tri, { LFTri.kr(freq, phase * 4) },
                \saw, { LFSaw.kr(freq, phase * 2) },
                \ramp, { LFSaw.kr(freq, phase * 2) },
                \square, { LFPulse.kr(freq, phase) },
                \rand, { LFDNoise3.kr(freq) }
            );
            Out.kr(out, osc.range(lo, hi));
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
    // pitch and time independent via Warp1 granulation.
    [1, 2].do { |nc|
        var toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
        SynthDef(("poptart_sample_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1|
            var frames = BufFrames.ir(buf);
            var startF = begin * frames, endF = max(begin * frames, (end * frames) - 1);
            var from = Select.kr(rate < 0, [startF, endF]);
            var to = Select.kr(rate < 0, [endF, startF]);
            var sig = BufRd.ar(nc, buf, Line.ar(from, to, dur), loop: 0, interpolation: 4);
            var env = EnvGen.kr(Env.linen(0.003, max(0.001, dur - 0.011), 0.008), doneAction: 2);
            // Gate mode (playSample's `cut`): closing the gate early releases and frees the
            // voice before its natural end; whichever envelope finishes first wins.
            var gateEnv = EnvGen.kr(Env.asr(0, 1, 0.008), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * gateEnv * amp);
        }).add;
        SynthDef(("poptart_sample_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1|
            var frames = BufFrames.ir(buf);
            var startF = begin * frames, endF = max((begin * frames) + 1, (end * frames) - 1);
            var reset = Select.kr(rate < 0, [startF, endF]);
            var idx = Phasor.ar(0, rate * BufRateScale.ir(buf), startF, endF, reset);
            var sig = BufRd.ar(nc, buf, idx, loop: 1, interpolation: 4);
            var env = EnvGen.kr(Env.asr(0.003, 1, 0.01), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
        SynthDef(("poptart_sample_warp_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1|
            var from = Select.kr(rate < 0, [begin, end]);
            var to = Select.kr(rate < 0, [end, begin]);
            var sig = Warp1.ar(nc, buf, Line.kr(from, to, dur), rate.abs, 0.1, -1, 8, 0.1, 2);
            var env = EnvGen.kr(Env.linen(0.003, max(0.001, dur - 0.011), 0.008), doneAction: 2);
            var gateEnv = EnvGen.kr(Env.asr(0, 1, 0.008), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * gateEnv * amp);
        }).add;
        SynthDef(("poptart_sample_warp_loop_" ++ nc).asSymbol, { |out, buf, begin = 0, end = 1, rate = 1, dur = 1, gate = 1, amp = 1|
            var span = max(0.001, end - begin);
            var step = (span / max(0.001, dur)) * rate.sign / ControlRate.ir;
            var reset = Select.kr(rate < 0, [begin, end]);
            var ptr = Phasor.kr(0, step, begin, end, reset);
            var sig = Warp1.ar(nc, buf, ptr, rate.abs, 0.1, -1, 8, 0.1, 2);
            var env = EnvGen.kr(Env.asr(0.003, 1, 0.01), gate, doneAction: 2);
            Out.ar(out, toStereo.(sig) * env * amp);
        }).add;
    };
    server.sync;
    "poptart: server booted, ready".postln;
    nodeAddr.sendMsg("/poptart/ready");
    // Populate the plugin dict in the background so .synth("Name") can resolve names. Cached
    // plugins re-verify instantly; only new/changed ones get probed (out-of-process, with a
    // per-plugin timeout so a hang skips that plugin instead of stalling the scan).
    VSTPlugin.search(server, dir: searchDirs, options: (timeout: 20, exclude: excludePaths), verbose: true, action: {
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
                synth: Synth(trackDefName.(key), [\inBus, inBus.index], target: group, addAction: \addToTail),
                controllers: Array.newClear(maxSlots),
                loaded: Array.newClear(maxSlots), // slot -> pluginId once open() succeeds
                lfos: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, shape:, index:)
                envs: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, index:)
                ccs: IdentityDictionary.new,      // \slotN_param -> (bus:, index:, lo:, hi:, last:, binding:, defKey:)
                held: 0                           // active-note count, drives env gates
            );
        };
    };
}, '/poptart/createTrack');

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
            { track[\loaded][slot] != pluginId } {
                var ctl = track[\controllers][slot] ?? {
                    VSTPluginController(track[\synth], id: ("slot" ++ slot).asSymbol, synthDef: track[\def])
                };
                track[\controllers][slot] = ctl;
                track[\loaded][slot] = nil;
                ctl.open(resolvePlugin.(pluginId), editor: true, action: { |self, ok|
                    if (ok) {
                        track[\loaded][slot] = pluginId;
                        track[\synth].set(("active" ++ slot).asSymbol, 1); // un-bypass the slot
                        ("poptart: loaded effect " ++ pluginId ++ " in slot " ++ slot).postln;
                    } {
                        ("poptart: FAILED to load effect '" ++ pluginId ++ "'").warn;
                    };
                });
            };
        };
    };
}, '/poptart/loadEffect');

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
    if (ctl.notNil) {
        track[\held] = track[\held] + 1;
        server.makeBundle(latency, {
            ctl.midi.noteOn(0, note, (veloc * 127).round.asInteger);
            track[\envs].do { |e| e[\synth].set(\gate, 1) };
            // note-synced lfo() shapes: reset/replay on every note onset
            track[\lfos].do { |e|
                if ((e[\mode] == \retrigger) or: { e[\mode] == \envelope }) { e[\synth].set(\t_trig, 1) };
            };
        });
    };
}, '/poptart/noteOn');

OSCdef(\poptartNoteOff, { |msg|
    var key = msg[1].asSymbol, note = msg[2].asInteger, latency = msg[3].asFloat;
    var track = tracks[key];
    var ctl = if (track.isKindOf(Event)) { track[\controllers][0] };
    if (ctl.notNil) {
        track[\held] = max(0, track[\held] - 1);
        server.makeBundle(latency, {
            ctl.midi.noteOff(0, note, 0);
            if (track[\held] == 0) { track[\envs].do { |e| e[\synth].set(\gate, 0) } };
        });
    };
}, '/poptart/noteOff');

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
                // ctl.set resolves parameter names in the UGen; values are normalized 0..1.
                server.makeBundle(latency, { ctl.set(paramName, value.clip(0, 1)) });
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
                    index = ctl.info.findParamIndex(paramName.asSymbol);
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
    fork {
        var track = awaitTrack.(key);
        var isChannel, ctl, index, lfoKey, existing, spec;
        var points, xs, ys, cs, times, curves, defName, def, bus, shapeSynth;
        if (track.isNil) { ("poptart: setParamShapeLFO: no track " ++ key).warn } {
            isChannel = slot == -1;
            if (isChannel.not and: { awaitLoaded.(track, slot).not }) {
                ("poptart: setParamShapeLFO: no plugin loaded in slot " ++ slot).warn;
            } {
                if (isChannel.not) {
                    ctl = track[\controllers][slot];
                    index = ctl.info.findParamIndex(paramName.asSymbol);
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
                    points = pointsJson.parseJSON;
                    xs = points.collect { |p| p["x"].asFloat };
                    ys = points.collect { |p| p["y"].asFloat };
                    cs = points.collect { |p| (p["c"] ? "0").asFloat };
                    times = (1..xs.size - 1).collect { |i| max(0, xs[i] - xs[i - 1]) }; // normalized, sums to 1
                    curves = cs.copyRange(0, cs.size - 2);
                    spec = mode.asString ++ "|" ++ pointsJson;
                    lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\lfos][lfoKey];
                    if (existing.notNil and: { existing[\spec] == spec }) {
                        existing[\synth].set(\rate, rateHz, \lo, lo, \hi, hi);
                    } {
                        defName = ("poptart_shape_" ++ key ++ "_" ++ lfoKey).asSymbol;
                        def = SynthDef(defName, { |out, rate = 1, phase = 0, lo = 0, hi = 1, t_trig = 0|
                            var env = Env(ys, times, curves);
                            var idx = switch(mode,
                                \retrigger, { (Sweep.kr(t_trig, rate) + phase) % 1 },
                                \envelope, { Sweep.kr(t_trig, rate).min(1) },
                                { (Sweep.kr(0, rate) + phase) % 1 } // free (default)
                            );
                            Out.kr(out, lo + (IEnvGen.kr(env, idx) * (hi - lo)));
                        });
                        def.add;
                        server.sync;
                        if (existing.notNil) {
                            existing[\synth].free;
                            bus = existing[\bus];
                        } {
                            bus = Bus.control(server, 1);
                        };
                        shapeSynth = Synth(defName,
                            [\out, bus, \rate, rateHz, \phase, phaseCycles, \lo, lo, \hi, hi,
                             \t_trig, if ((mode != \free) and: { track[\held] > 0 }) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        if (existing.isNil) {
                            if (isChannel) { track[\synth].map(paramName.asSymbol, bus) } { ctl.map(index, bus) };
                            track[\lfos][lfoKey] = (synth: shapeSynth, bus: bus, shape: \custom,
                                index: index, mode: mode, spec: spec);
                        } {
                            existing[\synth] = shapeSynth;
                            existing[\shape] = \custom;
                            existing[\mode] = mode;
                            existing[\spec] = spec;
                        };
                    };
                };
            };
        };
    };
}, '/poptart/setParamShapeLFO');

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
                    index = ctl.info.findParamIndex(paramName.asSymbol);
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
            track[\synth].set(paramName.asSymbol, if (paramName == "gain") { 1 } { 0 });
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
            track[\synth].set(paramName.asSymbol, if (paramName == "gain") { 1 } { 0 });
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
                    index = ctl.info.findParamIndex(paramName.asSymbol);
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
            track[\synth].set(paramName.asSymbol, if (paramName == "gain") { 1 } { 0 });
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
    fork {
        var track = awaitTrack.(key);
        var src, uid, chanArg, kOn, kOff, kBend, kTouch, kPoly, kCc;
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
                    track[\controllers][0] !? { |c| c.midi.polyTouch(chan, note, val) };
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
        var done = 0, tries = 0, bufs;
        File.delete(pathsFile);
        samplePacks[pack] !? { |old| old.do { |b| b.free } };
        bufs = paths.collect { |p|
            Buffer.read(server, p.asString, action: { done = done + 1 })
        };
        // Cap just under Node's PACK_LOAD_TIMEOUT_MS so a partial read still replies in time.
        while { (done < bufs.size) and: { tries < 2200 } } { 0.05.wait; tries = tries + 1 };
        samplePacks[pack] = bufs;
        ("poptart: sample pack '" ++ pack ++ "': " ++ done ++ "/" ++ bufs.size ++ " file(s) read").postln;
        replyOk.("/poptart/loadSamplePack", requestId, toJson.(bufs.collect { |b|
            (frames: b.numFrames ? 0, sampleRate: b.sampleRate ? 0, channels: b.numChannels ? 0)
        }));
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
        server.makeBundle(latency, {
            synth = Synth(defName,
                [\out, track[\inBus].index, \buf, buf, \begin, begin, \end, end,
                 \rate, rate, \dur, dur, \gate, 1, \amp, amp],
                target: track[\group], addAction: \addToHead);
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
OSCdef(\poptartSetPluginState, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, path = msg[3].asString;
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
                File.delete(path);
            });
        } {
            ("poptart: setPluginState: no loaded plugin in " ++ key ++ " slot " ++ slot).warn;
            File.delete(path);
        };
    };
}, '/poptart/setPluginState');

OSCdef(\poptartScanPlugins, { |msg|
    var requestId = msg[1];
    // extraPaths (msg[2], JSON array) not wired through yet; POPTART_VST_DIRS covers the
    // custom-directory need for now.
    VSTPlugin.search(server, dir: searchDirs, options: (timeout: 20, exclude: excludePaths), verbose: true, action: {
        replyOk.("/poptart/scanPlugins", requestId, toJson.((plugins: pluginList.(), crashed: [])));
    });
}, '/poptart/scanPlugins');

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

OSCdef(\poptartQuit, { |msg| 0.exit }, '/poptart/quit');
)
