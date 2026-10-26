// Class side of the PoptartDevice UGen (native/devices/PoptartDevice.cpp) - poptart's own
// synths and effects, the ones the browser build plays as compiled modules, running in scsynth.
// The engine copies this file and the built .scx into the user's SuperCollider Extensions folder
// before sclang starts (see extensions.js), so both halves find them.
//
//   PoptartDevice.ar(input, numChannels, bend, sidechain, id)
//     input        the chain signal, an array of channels ([] for an instrument, which has none)
//     numChannels  how many channels come out (2 everywhere in poptart)
//     bend         the track's pitch bend in semitones, for an instrument (a control or a signal)
//     sidechain    another signal, for a device that cross-modulates (see PdDeviceInfo.sidechain)
//     id           a symbol naming this slot, exactly as VSTPlugin's `id` does
//
// WHY THIS LOOKS LIKE VSTPlugin. A track is one SynthDef with a fixed chain of slots, and which
// device sits in a slot is decided long after that def was built - so the UGen has to be generic
// and load its DSP at runtime, which is the problem VSTPlugin already solved. Following it down
// to the controller's method names is what lets sc/poptart.scd drive a native device through the
// code that drives plugins: one setParam, one resolveParamIndex, one ramp, one LFO, one MIDI
// control. The duck is the point.
PoptartDevice : MultiOutUGen {
    var <>id, <>desc;

    *ar { |input, numChannels = 2, bend = 0, sidechain, id|
        var ins = input.asArray;
        var scs = sidechain.asArray;
        ins.do { |item, i|
            (item.rate != \audio).if {
                MethodError("PoptartDevice input % (%) is not audio rate".format(i, item), this).throw;
            };
        };
        scs.do { |item, i|
            (item.rate != \audio).if {
                MethodError("PoptartDevice sidechain % (%) is not audio rate".format(i, item), this).throw;
            };
        };
        ^this.multiNewList([\audio, id, numChannels, bend, ins.size] ++ ins ++ [scs.size] ++ scs)
    }

    *kr { ^this.shouldNotImplement(thisMethod) }

    init { |argId, numChannels, bend, numIn ... rest|
        id = argId !? { argId.asSymbol };
        // The order the UGen reads them in: bend, the main signal count, the main signals, the
        // sidechain count, the sidechain signals. The counts are there because a UGen's inputs
        // are a flat list and it has to know where one group ends.
        inputs = [bend, numIn] ++ rest;
        ^this.initOutputs(numChannels, rate)
    }

    // Called once while the SynthDef is being built. A controller finds its slot by asking the
    // def which index carries which id, the same way VSTPluginController does.
    optimizeGraph {
        var metadata;
        this.synthDef.metadata ?? { this.synthDef.metadata = () };
        metadata = this.synthDef.metadata[\poptartDevices];
        metadata ?? {
            metadata = ();
            this.synthDef.metadata[\poptartDevices] = metadata;
        };
        id ?? {
            Error("SynthDef '%' has a PoptartDevice without an id - every slot needs one"
                .format(this.synthDef.name)).throw;
        };
        metadata.at(id).notNil.if {
            Error("SynthDef '%' has two PoptartDevices with the id '%'"
                .format(this.synthDef.name, id)).throw;
        };
        desc = ();
        metadata.put(id, desc);
    }

    synthIndex_ { |index|
        super.synthIndex_(index);
        desc.notNil.if { desc.index = index };
    }
}

// What a device says about itself, in the shape VSTPluginDesc says it.
//
// A plugin is asked at scan time what its parameters are called; a poptart device ships a
// descriptor instead (packages/web-engine/src/descriptor.mjs), and the engine hands the relevant
// part of it over when it opens the slot. Same two questions either way - what are the controls
// called, and which index is this name - so poptart.scd's resolveParamIndex works on both
// without knowing which it has.
PoptartDeviceDesc {
    var <name, <parameters, <indices;

    // `params` is an array of (id:, name:) events, in the device's own parameter order.
    *new { |name, params|
        ^super.new.prInit(name, params)
    }

    prInit { |argName, params|
        name = argName.asString;
        parameters = params.collect { |p, i| (name: (p[\name] ? p[\id]).asString, label: "", index: i) };
        // Both spellings resolve, as they do in the browser: `.param("LPG Color", ...)` and
        // `.param("lpgcolor", ...)` are the same control, and case never matters.
        indices = IdentityDictionary.new;
        params.do { |p, i|
            p[\id] !? { |x| indices.put(x.asString.toLower.asSymbol, i) };
            p[\name] !? { |x| indices.put(x.asString.toLower.asSymbol, i) };
        };
    }

    numParameters { ^parameters.size }

    /**
     * What a VSTPluginDesc calls the plugin API it found - nil here, since there is no plugin.
     *
     * Asked rather than guessed, by the paths that send a slot every note off it is holding and
     * then an all-notes-off for good measure: VST 3 answers an all-notes-off by doing nothing,
     * so it is only sent where it means something. A native device is not a VST 3, and nil says
     * so in the one way those lines read ("VST 3" is not in it), so it gets the message - which
     * its wrapper handles as the negative note that ends everything.
     */
    sdkVersion { ^nil }

    findParamIndex { |name| ^indices[name.asString.toLower.asSymbol] }
}

// The handle on one open device, with the surface of a VSTPluginController.
//
// Everything poptart.scd does to a plugin it does through a controller: set a parameter, map a
// control bus onto one, play a note, ask what the parameters are called, capture and restore a
// program. A native device answers all of it - mostly by sending the UGen a unit command, and in
// two cases (a parameter's current value, a program) out of what it has been told, because it IS
// the authority on those: nothing else writes a native device's controls.
PoptartDeviceController {
    // How long to wait for the server to say a device is in before giving up on it. An open is
    // one allocation on the server's helper thread, so this is a failsafe and not a budget.
    classvar <>openTimeout = 10;

    var <synth, <id, <synthIndex, <info, <midi;
    var <>parameterAutomated;
    var positions;      // the last position written to each control, by index
    var <>deviceName;
    // The tempo and the beat the transport was last at, so either can be sent on its own.
    var tempo = 120, beatPos = 0;

    *new { |synth, id, synthDef|
        var def = synthDef ?? { SynthDescLib.global.at(synth.defName).def };
        var metadata = def.notNil.if { def.metadata !? { |m| m[\poptartDevices] } };
        var entry = metadata !? { |m| m[id.asSymbol] };
        entry ?? {
            MethodError("SynthDef '%' has no PoptartDevice with the id '%'"
                .format(synth.defName, id), this).throw;
        };
        ^super.new.prInit(synth, id.asSymbol, entry[\index]);
    }

    prInit { |argSynth, argId, index|
        synth = argSynth;
        id = argId;
        synthIndex = index;
        // One entry per control, with room for the widest device (the FM synth's 148) and the
        // UGen's own limit (kMaxParams in PoptartDevice.cpp) above that.
        positions = Array.fill(192, 0);
        midi = PoptartDeviceMIDIProxy(this);
    }

    /**
     * Opens a device by name - "Plaits", "Galactic" - with the controls it is described as having.
     *
     * The action fires when the device is actually IN, not when the message went out: the open
     * allocates (Cloud Seed's delay lines are tens of megabytes) and so happens off the audio
     * thread, and the UGen replies from the block that installs it. The engine holds a track's
     * notes until this says yes, which is what makes `synth("Plaits", { state })` land in order
     * on a cold start.
     */
    open { |name, params, action|
        var resp, answered = false;
        deviceName = name.asString;
        info = PoptartDeviceDesc(name, params ? []);
        // The UGen opens every control at the device's default (PoptartDevice.cpp's install), so
        // that is where this record starts: a control nobody has touched is AT its default, and
        // `get` - what .hold()/.release() put back - has to say so. Position 0 is the bottom of
        // a control's range, not its rest.
        positions = Array.fill(positions.size, 0);
        (params ? []).do { |p, i| if (i < positions.size) { positions[i] = p[\default] ? 0 } };
        resp = OSCFunc({ |msg|
            if (answered.not) {
                answered = true;
                action.value(this, msg[3] > 0);
            };
        }, '/poptart/deviceOpened', synth.server.addr,
            argTemplate: [synth.nodeID, synthIndex]).oneShot;
        // A device that never reports back must not leave a track's notes held for ever (see
        // waitForLoad in poptart.scd): one answer is given either way, and whichever comes first
        // is the one the caller hears.
        SystemClock.sched(openTimeout, {
            if (answered.not) {
                answered = true;
                resp.free;
                action.value(this, false);
            };
            nil
        });
        this.sendMsg('/open', deviceName);
    }

    close {
        info = nil;
        deviceName = nil;
        this.sendMsg('/close');
    }

    /** A control, by index, as a 0..1 position - what the descriptor turns into real units. */
    set { |... pairs|
        pairs.pairsDo { |index, value|
            (index.isNumber and: { index >= 0 } and: { index < positions.size }).if {
                positions[index] = value;
            };
        };
        // The index as an integer and the value as a float: the UGen reads them as what they
        // are, and a message that says what it means is one less thing to work out from a trace.
        this.sendMsg('/set', *pairs.collect { |v, i| if (i.even) { v.asInteger } { v.asFloat } });
    }

    /**
     * What a control is sitting at.
     *
     * Answered from here rather than from the server, and that is not a shortcut: a native
     * device's controls are only ever written through this object, so this IS the value, and
     * .hold()/.release() around a patterned parameter (poptart.scd's holdParam) needs it
     * synchronously to have something to put back.
     */
    get { |index, action|
        action.value(positions[index] ? 0);
    }

    /** A control bus onto a control: how every modulator in poptart reaches a parameter. */
    map { |index, bus|
        this.sendMsg('/map', index.asInteger, bus.asBus.index.asInteger);
    }

    /**
     * An AUDIO bus onto a control, read by the UGen every sample: what an audio-rate envelope
     * and a signal patched onto a parameter reach a native device through. The bus is a stereo
     * pair, summed to mono; the control's position is gain * signal + offset, clamped to 0..1.
     * A plugin has no such thing, which is how poptart.scd tells the two apart (respondsTo).
     */
    mapAudio { |index, bus, gain = 1, offset = 0|
        this.sendMsg('/mapa', index.asInteger, bus.asBus.index.asInteger, gain.asFloat, offset.asFloat);
    }

    /**
     * Takes a control off its audio bus. The only thing that does: `set`, `map` and `unmap` leave
     * an audio patch alone (see PoptartDevice.cpp's setParam), so the control goes back to the
     * last value set or the control bus mapped while it was patched.
     */
    unmapAudio { |index|
        this.sendMsg('/mapa', index.asInteger, -1, 1.0, 0.0);
    }

    unmap { |... indices|
        indices.isEmpty.if {
            this.sendMsg('/unmap', *(0..(info !? { |i| i.numParameters - 1 } ? 0)));
        } {
            this.sendMsg('/unmap', *indices.collect(_.asInteger));
        };
    }

    /**
     * The device's program, written where a plugin writes its own.
     *
     * A device has no state but its controls, so the positions ARE the program: this engine's
     * own form of it, positions by control, which is what readProgram takes. It is not the
     * preset a song carries. That is written and read by the engine's Node half
     * (native-devices.js's deviceStateText and readDeviceState) in the browser's format - real
     * units by control id, plus the files - so a preset made on either engine opens on the other.
     */
    writeProgram { |path, action|
        var ok = false;
        var file;
        try {
            file = File(path.standardizePath, "w");
            file.notNil.if {
                file.write(this.prProgramString);
                file.close;
                ok = true;
            };
        } { |err|
            ("poptart: could not write a device program to " ++ path ++ ": " ++ err.errorString).warn;
        };
        action.value(this, ok);
    }

    readProgram { |path, action|
        var ok = false;
        var text = try { File.readAllString(path.standardizePath) };
        var doc = text !? { try { text.parseJSON } };
        var values = doc !? { doc["params"] };
        (values.isKindOf(Dictionary) and: { info.notNil }).if {
            values.keysValuesDo { |key, value|
                var index = info.findParamIndex(key);
                index !? { this.set(index, value.asFloat) };
            };
            ok = true;
        };
        action.value(this, ok);
    }

    prProgramString {
        var parts = (info !? { info.parameters } ? []).collect { |p, i|
            "\"%\": %".format(p.name, positions[i] ? 0)
        };
        ^"{ \"device\": \"%\", \"params\": { % } }".format(deviceName ? "", parts.join(", "))
    }

    // The tempo and the transport, which the devices that are synced to a division of the beat
    // read - a delay, a chorus, the stutter, the ducker. Sent as one message because the device
    // is given the position in seconds and needs the tempo to work that out (see cmdTransport in
    // PoptartDevice.cpp), and remembered here so either call can be made on its own: poptart
    // sends a tempo on a setbpm() and a position when the transport relocates.
    //
    // `setPlaying` has nothing to mirror: a device has no host transport to start, and the only
    // thing that stops it sounding is the chain going quiet. It stays so the plugin paths can
    // call it without a kind check, as `editor` does.
    setPlaying { |playing| }

    setTempo { |bpm|
        tempo = bpm ? tempo;
        this.sendMsg('/transport', tempo.asFloat, beatPos.asFloat);
    }

    setTransportPos { |beats|
        beatPos = beats ? beatPos;
        this.sendMsg('/transport', tempo.asFloat, beatPos.asFloat);
    }

    /**
     * Whether anything is routed into this slot's key input, and whether a track's notes are.
     *
     * The compressor and the ducker behave differently with a key and without one, and the aux
     * bus is there whether a route is or not (it reads a silent bus until one is wired), so
     * silence on it says nothing - this is how the device is told. Called by whoever wires or
     * unwires the route; see wireAudioRoute and the MIDI injector in poptart.scd.
     */
    /**
     * A file for the control that plays one: a granulator's sample, a convolver's response.
     *
     * The buffer is handed over by NUMBER rather than by content - the UGen reads the frames out
     * of it itself, on the non-realtime thread - so this is one small message however long the
     * file is, and the buffer goes on belonging to whoever allocated it.
     */
    loadSample { |param, index, buffer|
        buffer.notNil.if {
            this.sendMsg('/sample', param.asInteger, index.asInteger, buffer.bufnum.asInteger);
        };
    }

    sidechain { |patched = false|
        this.sendMsg('/sidechain', if (patched) { 1 } { 0 });
    }

    noteRoute { |routed = false|
        this.sendMsg('/noteRoute', if (routed) { 1 } { 0 });
    }
    editor { "poptart: % has no plugin editor - its panel is poptart's own".format(deviceName ? "this device").postln }

    sendMsg { |cmd ... args|
        synth.server.sendMsg('/u_cmd', synth.nodeID, synthIndex, cmd, *args);
    }

    sendBundle { |time ... msgs|
        synth.server.sendBundle(time, *msgs);
    }

    /** The message form, for a caller that is building a bundle of its own. */
    msgFor { |cmd ... args|
        ^['/u_cmd', synth.nodeID, synthIndex, cmd] ++ args
    }
}

// Notes, in the shape a plugin takes them.
//
// The engine plays an instrument slot by sending MIDI (`ctl.midi.noteOn(chan, note, velocity)`),
// because until now every instrument slot was a plugin. A native device is played with its own
// unit commands, so this translates: the channel is dropped (a device is one instrument, not
// sixteen), and the velocity comes back off MIDI's 0..127 to the 0..1 a device reads.
PoptartDeviceMIDIProxy {
    var owner;

    *new { |owner| ^super.newCopyArgs(owner) }

    noteOn { |chan, note, veloc = 64|
        owner.sendMsg('/noteOn', note.asFloat, (veloc / 127).asFloat);
    }

    noteOff { |chan, note, veloc = 64|
        owner.sendMsg('/noteOff', note.asFloat);
    }

    allNotesOff { |chan|
        owner.sendMsg('/allNotesOff');
    }

    // The track's bend reaches a native device as a signal on the UGen's own bend input (see
    // buildTrackDef), not as a message - so these are deliberately quiet rather than missing:
    // the MIDI paths in poptart.scd call them without asking what kind of device they have.
    bend { |chan, value| }
    control { |chan, num, value| }
    polyTouch { |chan, note, value| }
    touch { |chan, value| }
    program { |chan, number| }
}
