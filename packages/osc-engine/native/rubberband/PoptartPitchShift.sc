// Class side of the PoptartPitchShift UGen (native/rubberband/PoptartPitchShift.cpp) - a
// real-time pitch shifter on the Rubber Band Live Shifter. The engine copies this file and the
// built .scx into the user's SuperCollider Extensions folder before sclang starts (see
// extensions.js), so both sclang (this class) and scsynth (the plugin) find them.
//
//   PoptartPitchShift.ar(input, ratio, window)
//     input   one audio signal or an array of them (channels are shifted together)
//     ratio   pitch scale, target over source: 2 = up an octave, 0.5 = down one
//     window  0 = short window (lowest delay), 1 = medium (a little more quality, more delay)
//   returns  input.size shifted signals, then one more channel holding the pipeline delay in
//            samples (constant) - the caller aligns against it, see poptart_songwarp_*.
PoptartPitchShift : MultiOutUGen {
    *ar { |input, ratio = 1.0, window = 0|
        var ins = input.asArray;
        ^this.multiNewList(['audio', ins.size, ratio, window] ++ ins)
    }
    init { |argNumChannels ... theInputs|
        inputs = theInputs;
        ^this.initOutputs(argNumChannels + 1, rate)
    }
}
