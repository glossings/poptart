// poptart's MIDI device I/O helper where there is no CoreMIDI one (Windows, Linux), spawned by
// ../server/midi-worker.js (macOS uses ../native/bin/poptart-midi). It only talks to MIDI devices:
// it lists them, connects sources, forwards every incoming message to Node and sends what Node
// asks it to. Everything about what the messages mean lives in Node (../engine/midi.js).
//
// Node's port arrives as POPTART_MIDI_NODE_PORT. Protocol, Node -> here:
//   /midi/list                       re-read the device lists; answered by /midi/devices
//   /midi/connect uid                connect one source
//   /midi/connectAll                 connect every source
//   /midi/send uid latency status d1 d2
//   /midi/quit
//   /midi/ping                       Node is still there (the helper leaves after 15s without one)
// here -> Node:
//   /midi/hello langPort             once, when MIDI is up
//   /midi/devices nSrc (uid device name)... nDst (uid device name)...
//   /midi/in srcUid status d1 d2

(
var node = NetAddr("127.0.0.1", "POPTART_MIDI_NODE_PORT".getenv.asInteger);
var outs = IdentityDictionary.new;
var devices, forward, outFor, lastPing = Main.elapsedTime;

devices = {
    var msg = ["/midi/devices", MIDIClient.sources.size];
    MIDIClient.sources.do { |s| msg = msg ++ [s.uid, s.device.asString, s.name.asString] };
    msg = msg ++ [MIDIClient.destinations.size];
    MIDIClient.destinations.do { |d| msg = msg ++ [d.uid, d.device.asString, d.name.asString] };
    node.sendMsg(*msg);
};

forward = { |src, status, a, b| node.sendMsg("/midi/in", src, status, a, b) };

outFor = { |uid|
    outs[uid] ?? {
        var d = MIDIClient.destinations.detect { |e| e.uid == uid };
        d !? { outs[uid] = MIDIOut(0, uid) }
    };
};

MIDIClient.init;

// Every kind poptart reads, as raw status bytes (a note-on of velocity 0 stays a note-on).
MIDIdef.noteOn(\io_on, { |v, n, c, s| forward.(s, 0x90 + c, n, v) });
MIDIdef.noteOff(\io_off, { |v, n, c, s| forward.(s, 0x80 + c, n, v) });
MIDIdef.cc(\io_cc, { |v, n, c, s| forward.(s, 0xB0 + c, n, v) });
MIDIdef.bend(\io_bend, { |v, c, s| forward.(s, 0xE0 + c, v % 128, v div: 128) });
MIDIdef.touch(\io_touch, { |v, c, s| forward.(s, 0xD0 + c, v, 0) });
MIDIdef.polytouch(\io_poly, { |v, n, c, s| forward.(s, 0xA0 + c, n, v) });
MIDIdef.program(\io_prog, { |v, c, s| forward.(s, 0xC0 + c, v, 0) });

OSCdef(\io_list, { MIDIClient.list; devices.() }, '/midi/list');
OSCdef(\io_connect, { |msg|
    MIDIClient.sources.detect { |s| s.uid == msg[1].asInteger } !? { |s| MIDIIn.connect(0, s) };
}, '/midi/connect');
OSCdef(\io_connectAll, { MIDIIn.connectAll }, '/midi/connectAll');
OSCdef(\io_send, { |msg|
    var uid = msg[1].asInteger, latency = msg[2].asFloat;
    var st = msg[3].asInteger, a = msg[4].asInteger, b = msg[5].asInteger;
    var hi = st & 0xF0, c = st & 0x0F;
    outFor.(uid) !? { |out|
        out.latency = latency.max(0);
        case
        { st == 0xF8 } { out.midiClock }
        { st == 0xFA } { out.start }
        { st == 0xFB } { out.continue }
        { st == 0xFC } { out.stop }
        { st == 0xF2 } { out.songPtr(a + (b * 128)) }
        { hi == 0x90 } { out.noteOn(c, a, b) }
        { hi == 0x80 } { out.noteOff(c, a, b) }
        { hi == 0xB0 } { out.control(c, a, b) }
        { hi == 0xE0 } { out.bend(c, a + (b * 128)) }
        { hi == 0xC0 } { out.program(c, a) }
        { hi == 0xD0 } { out.touch(c, a) }
        { hi == 0xA0 } { out.polyTouch(c, a, b) };
    };
}, '/midi/send');
OSCdef(\io_quit, { 0.exit }, '/midi/quit');
OSCdef(\io_ping, { lastPing = Main.elapsedTime }, '/midi/ping');
// A helper whose Node went away without saying so does not linger.
SystemClock.sched(5, { if ((Main.elapsedTime - lastPing) > 15) { 0.exit }; 5 });

devices.();
node.sendMsg("/midi/hello", NetAddr.langPort);
)
