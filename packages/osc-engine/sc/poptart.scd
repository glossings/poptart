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
// Colon-separated list of plugin directories to scan instead of the standard locations.
// Escape hatch for collections where a full default-location scan is problematic - on the dev
// machine, scanning everything reproducibly killed scsynth (exit 0, pre-probe - looks like a
// VSTPlugin scan bug worth reporting upstream, not one bad plugin: the usual crashers probe
// fine individually). Point this at a folder of just the plugins you're actually playing.
var searchDirs = "POPTART_VST_DIRS".getenv !? { |p| p.split($:) };
var maxSlots = 8; // slot 0 = instrument, 1..7 = effects
var server = Server.default;
var nodeAddr = NetAddr("127.0.0.1", nodePort);
// trackId (Symbol) -> (def:, group:, synth:, controllers:, loaded:, lfos:, envs:, held:).
// Symbol keys, NOT Strings: IdentityDictionary lookups are by identity, and two equal Strings
// are distinct objects (incoming OSC string args arrive as Symbols anyway).
var tracks = IdentityDictionary.new;
var jsonEscape, toJson, replyOk, replyErr, pluginList, trackDefName, buildTrackDef;
var awaitTrack, awaitLoaded, resolvePlugin;

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
            isInstrument: desc.isSynth,
            numInputChannels: desc.numInputs,
            numOutputChannels: desc.numOutputs,
            numParameters: desc.numParameters
        )
    };
};

trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };

buildTrackDef = { |key|
    SynthDef(trackDefName.(key), {
        var sig = Silent.ar(2);
        maxSlots.do { |i|
            if (i == 0) {
                sig = VSTPlugin.ar(nil, 2, id: \slot0);
            } {
                // An empty VSTPlugin slot outputs silence, not pass-through - so each fx slot
                // gets a bypass switch, flipped on only once a plugin actually loads into it.
                var wet = VSTPlugin.ar(sig, 2, id: ("slot" ++ i).asSymbol);
                sig = Select.ar(("active" ++ i).asSymbol.kr(0), [sig, wet]);
            };
        };
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

// `.s("Serum 2")` uses the display name, but VSTPlugin's dict keys carry the file extension
// ('Serum 2.vst3') - accept exact key, display name, or a literal file path.
resolvePlugin = { |pluginId|
    var dict = VSTPlugin.plugins(server);
    var desc = dict[pluginId.asSymbol] ?? { dict.values.detect { |d| d.name == pluginId } };
    desc !? { desc.key } ? pluginId;
};

// --- boot ---

server.options.sampleRate = sampleRate;
server.options.blockSize = blockSize;

server.waitForBoot {
    [\sine, \tri, \saw, \square].do { |shape|
        SynthDef(("poptart_lfo_" ++ shape).asSymbol, { |out, freq = 1, phase = 0, lo = 0, hi = 1|
            var osc = switch(shape,
                \sine, { SinOsc.kr(freq, phase * 2pi) },
                \tri, { LFTri.kr(freq, phase * 4) },
                \saw, { LFSaw.kr(freq, phase * 2) },
                \square, { LFPulse.kr(freq, phase) }
            );
            Out.kr(out, osc.range(lo, hi));
        }).add;
    };
    // ADSR modulator, gated by the track's note on/offs (see the noteOn/noteOff OSCdefs) -
    // the parameter-modulation equivalent of a synth's filter envelope. Retriggers from the
    // envelope's current level on each new gate, so overlapping notes don't click.
    SynthDef(\poptart_env, { |out, atk = 0.01, dec = 0.1, sus = 0.7, rel = 0.2, gate = 0, lo = 0, hi = 1|
        var envSig = EnvGen.kr(Env.adsr(atk, dec, sus, rel), gate);
        Out.kr(out, lo + (envSig * (hi - lo)));
    }).add;
    server.sync;
    "poptart: server booted, ready".postln;
    nodeAddr.sendMsg("/poptart/ready");
    // Populate the plugin dict in the background so .s("Name") can resolve names. Cached
    // plugins re-verify instantly; only new/changed ones get probed (out-of-process, with a
    // per-plugin timeout so a hang skips that plugin instead of stalling the scan).
    VSTPlugin.search(server, dir: searchDirs, options: (timeout: 20), verbose: true, action: {
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
            var def = buildTrackDef.(key);
            def.add; // sends to server + global SynthDescLib
            server.sync;
            tracks[key] = (
                def: def,
                group: group,
                synth: Synth(trackDefName.(key), target: group, addAction: \addToTail),
                controllers: Array.newClear(maxSlots),
                loaded: Array.newClear(maxSlots), // slot -> pluginId once open() succeeds
                lfos: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, shape:, index:)
                envs: IdentityDictionary.new,     // \slotN_param -> (synth:, bus:, index:)
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
    var ctl = if (track.isKindOf(Event)) { track[\controllers][slot] };
    if (ctl.notNil) {
        // ctl.set resolves parameter names in the UGen; values are normalized 0..1.
        server.makeBundle(latency, { ctl.set(paramName, value.clip(0, 1)) });
    };
}, '/poptart/setParam');

// Tier 2: map a control bus to the VST parameter once, drive the bus with a UGen oscillator
// running in scsynth's audio callback - zero further OSC traffic, genuinely continuous.
// Re-eval with the same shape updates the running LFO's args in place, so its phase carries
// across livecoding edits with no glitch/reset (same behavior the old native LFO.h had).
OSCdef(\poptartSetParamLFO, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var shape = msg[4].asSymbol, rateHz = msg[5].asFloat, phaseCycles = msg[6].asFloat;
    var lo = msg[7].asFloat, hi = msg[8].asFloat;
    fork {
        var track = awaitTrack.(key);
        var ctl, index, lfoKey, existing;
        if (track.isNil) { ("poptart: setParamLFO: no track " ++ key).warn } {
            if (awaitLoaded.(track, slot).not) {
                ("poptart: setParamLFO: no plugin loaded in slot " ++ slot).warn;
            } {
                ctl = track[\controllers][slot];
                index = ctl.info.findParamIndex(paramName.asSymbol);
                if (index.isNil) {
                    ("poptart: setParamLFO: plugin has no parameter named '" ++ paramName
                        ++ "' (see getParams / the plugin browser for real names)").warn;
                } {
                    if ((lo < 0) or: { hi > 1 }) {
                        ("poptart: LFO range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    lfoKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\lfos][lfoKey];
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
                        ctl.map(index, bus);
                        track[\lfos][lfoKey] = (synth: lfoSynth, bus: bus, shape: shape, index: index);
                    };
                };
            };
        };
    };
}, '/poptart/setParamLFO');

// Tier 2, envelope flavor: same bus+map mechanism as setParamLFO, but the modulator is an
// EnvGen gated by the track's note events (see noteOn/noteOff above). Re-eval updates the
// running synth's args in place - a mid-note livecoding edit doesn't cut the envelope off.
OSCdef(\poptartSetParamEnv, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var atk = msg[4].asFloat, dec = msg[5].asFloat, sus = msg[6].asFloat, rel = msg[7].asFloat;
    var lo = msg[8].asFloat, hi = msg[9].asFloat;
    fork {
        var track = awaitTrack.(key);
        var ctl, index, envKey, existing;
        if (track.isNil) { ("poptart: setParamEnv: no track " ++ key).warn } {
            if (awaitLoaded.(track, slot).not) {
                ("poptart: setParamEnv: no plugin loaded in slot " ++ slot).warn;
            } {
                ctl = track[\controllers][slot];
                index = ctl.info.findParamIndex(paramName.asSymbol);
                if (index.isNil) {
                    ("poptart: setParamEnv: plugin has no parameter named '" ++ paramName
                        ++ "' (see getParams / the params panel for real names)").warn;
                } {
                    if ((lo < 0) or: { hi > 1 }) {
                        ("poptart: env range " ++ lo ++ ".." ++ hi ++ " for '" ++ paramName
                            ++ "' is outside the normalized 0..1 VST parameter range and will pin -"
                            + "use .range(0.2, 0.9)-style values until per-plugin calibration exists").warn;
                    };
                    envKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
                    existing = track[\envs][envKey];
                    if (existing.notNil) {
                        existing[\synth].set(\atk, atk, \dec, dec, \sus, sus, \rel, rel, \lo, lo, \hi, hi);
                    } {
                        var bus = Bus.control(server, 1);
                        var envSynth = Synth(\poptart_env,
                            [\out, bus, \atk, atk, \dec, dec, \sus, sus, \rel, rel, \lo, lo, \hi, hi,
                             \gate, if (track[\held] > 0) { 1 } { 0 }],
                            target: track[\group], addAction: \addToHead);
                        ctl.map(index, bus);
                        track[\envs][envKey] = (synth: envSynth, bus: bus, index: index);
                    };
                };
            };
        };
    };
}, '/poptart/setParamEnv');

OSCdef(\poptartClearParamEnv, { |msg|
    var key = msg[1].asSymbol, slot = msg[2].asInteger, paramName = msg[3].asString;
    var track = tracks[key];
    var envKey = ("slot" ++ slot ++ "_" ++ paramName).asSymbol;
    var existing = if (track.isKindOf(Event)) { track[\envs][envKey] };
    if (existing.notNil) {
        track[\controllers][slot].unmap(existing[\index]);
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
        track[\controllers][slot].unmap(existing[\index]);
        existing[\synth].free;
        existing[\bus].free;
        track[\lfos].removeAt(lfoKey);
    };
}, '/poptart/clearParamLFO');

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

OSCdef(\poptartScanPlugins, { |msg|
    var requestId = msg[1];
    // extraPaths (msg[2], JSON array) not wired through yet; POPTART_VST_DIRS covers the
    // custom-directory need for now.
    VSTPlugin.search(server, dir: searchDirs, options: (timeout: 20), verbose: true, action: {
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
