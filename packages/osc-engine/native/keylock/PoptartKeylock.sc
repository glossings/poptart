// Class side of the PoptartKeylock UGen (native/keylock/PoptartKeylock.cpp) - the DJ decks'
// keylock: a song buffer read at any rate with its pitch held. The engine copies this file and
// the built .scx into the user's SuperCollider Extensions folder before sclang starts (see
// extensions.js), so both sclang (this class) and scsynth (the plugin) find them.
//
//   PoptartKeylock.ar(numChannels, bufnum, rate, trigger, startPos)
//     numChannels  the buffer's channel count (1 or 2)
//     rate         song seconds per second: 1 is the record's speed, negative plays backwards
//     trigger      moves the playhead to startPos, crossfading over 5 ms
//     startPos     in frames; also where the playhead starts
//   returns  numChannels signals, with no latency.
PoptartKeylock : MultiOutUGen {
    *ar { |numChannels = 2, bufnum = 0, rate = 1.0, trigger = 1.0, startPos = 0.0|
        ^this.multiNew('audio', numChannels, bufnum, rate, trigger, startPos)
    }
    init { |argNumChannels ... theInputs|
        inputs = theInputs;
        ^this.initOutputs(argNumChannels, rate)
    }
}

// A sampler voice's stretch (PoptartStretch in PoptartKeylock.cpp): the keylock's stretcher over a
// window of a buffer, for .stretchmode("clean").
//
//   PoptartStretch.ar(numChannels, bufnum, rate, pitch, startPos, loop, loopLo, loopHi, pingpong)
//     numChannels  the buffer's channel count (1 or 2)
//     rate         file seconds per second, read once: negative plays backwards
//     pitch        the transposition, as a ratio: 1 is the file's own pitch
//     startPos     in frames: where the playhead starts
//     loop         above 0.5, the playhead runs round loopLo..loopHi (frames), crossfading each
//                  corner over 5 ms; pingpong above 0.5 bounces off the edges instead of wrapping
//   returns  numChannels signals, with no latency.
PoptartStretch : MultiOutUGen {
    *ar { |numChannels = 2, bufnum = 0, rate = 1.0, pitch = 1.0, startPos = 0.0, loop = 0, loopLo = 0, loopHi = 0, pingpong = 0|
        ^this.multiNew('audio', numChannels, bufnum, rate, pitch, startPos, loop, loopLo, loopHi, pingpong)
    }
    init { |argNumChannels ... theInputs|
        inputs = theInputs;
        ^this.initOutputs(argNumChannels, rate)
    }
}
