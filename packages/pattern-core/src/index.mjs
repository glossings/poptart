export { Sig, Signal, n, note, mini, s, synth, sine, saw, tri, square, ramp, rand, perlin, lfo, env, midicc, midikeys, macro, choose, irand, resetRandomSeeds, keyboard, tap, midi, audio, pianoroll } from './signal.mjs';
// Sampler controls as top-level builders (Strudel's control patterns) - the method form of each
// still lives on Sig; these are what let a combinator aim at one channel, x.mul(speed("-1")).
export { i, begin, end, loop, speed, flip, stretch, fit, slice, attack, decay, sustain, release, SAMPLER_CONTROL_NAMES } from './signal.mjs';
export { feedMidiCC, midiInUse } from './midi.mjs';
export { setMacro, macroValue, MACRO_COUNT } from './macros.mjs';
export { Scheduler, Transport } from './scheduler.mjs';
export { parseScaleName, degreeToMidi, noteToMidi } from './notes.mjs';
export { recordingToMini, UNQUANTIZED_GRID } from './record.mjs';
export { parseMini, getStepsForCycle, stepLocs } from './mini.mjs';
export { splitLabeledBlocks } from './labels.mjs';
export { injectLocations, isPatternPosition } from './locations.mjs';
export { parseShapePoints, serializeShapePoints, sampleShape, curveInterp, SHAPE_PRESETS } from './shape.mjs';
export { parsePianoRoll, serializePianoRoll, normalizePianoRollSteps, PIANOROLL_DEFAULT_STEPS } from './pianoroll.mjs';
