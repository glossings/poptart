export { Sig, Signal, n, note, mini, s, se, sr, sp, synth, sine, saw, tri, square, ramp, rand, perlin, lfo, env, midicc, midikeys, macro, choose, cat, seq, irand, resetRandomSeeds, midi, audio, input, pianoroll, _roll, liveRoll, _shape, _preset, _pack } from './signal.mjs';
// Controls as top-level builders (Strudel's control patterns) - the method form of each still lives
// on Sig; these are what let a combinator aim at one channel, x.mul(speed("-1")) / x.mul(clip(2)).
export { i, begin, end, loop, loopwrap, loopdir, speed, flip, stretch, fit, slice, attack, decay, sustain, release, vel, clip, nudge, swing, swinggrid, SAMPLER_CONTROL_NAMES } from './signal.mjs';
export { channelAt, soundingEnd, timeShift, endEdgeStep, withSoundingSpan } from './signal.mjs';
export { setPatternWarn, lfoShapes, lfoPoints } from './signal.mjs';
export { feedMidiCC, midiInUse } from './midi.mjs';
export { setAudioInputLayout, audioInputLayout, audioInputChannelCount, resolveInputChannels } from './audio-inputs.mjs';
export { setMacro, macroValue, MACRO_COUNT } from './macros.mjs';
export { Scheduler, Transport, setEventLogger } from './scheduler.mjs';
export { parseScaleName, degreeToMidi, midiToDegree, noteToMidi } from './notes.mjs';
export { setGlobalScale, globalScale, scaleAtOctave, scaleParts, DEFAULT_SCALE, DEFAULT_SCALE_OCTAVE } from './notes.mjs';
export { recordingToMini, UNQUANTIZED_GRID, recordingToRoll, captureWindow, recordStartCycle, UNQUANTIZED_ROLL_GRID } from './record.mjs';
export { parseMidiFile, midiFileToLanes, midiLanesToPianoroll, pickGrid, detectKey, GRID_CANDIDATES, BEATS_PER_CYCLE } from './midifile.mjs';
export { parseMini, getStepsForCycle, stepLocs } from './mini.mjs';
export { splitLabeledBlocks, isBareCallBlock } from './labels.mjs';
export { injectLocations, isPatternPosition } from './locations.mjs';
export { parseShapePoints, serializeShapePoints, sampleShape, curveInterp, SHAPE_PRESETS } from './shape.mjs';
export { parsePianoRoll, serializePianoRoll, normalizePianoRollSteps, normalizePianoRollMode, pianoRollEventAt, noteIndex, noteNudge, noteNudgeChannel, looksLikeNoteString, PIANOROLL_DEFAULT_STEPS, PIANOROLL_MODES, PIANOROLL_DEFAULT_NOTE, PIANOROLL_DEFAULT_INDEX, PIANOROLL_MAX_NUDGE, pianoRollSwingCells, commitPianoRollSwing, pianoRollNoteGrid } from './pianoroll.mjs';
export { clearRolls, restoreRolls, setRollLayer, setDefOwner, lookupRoll, rollIds, lookupShape, shapeIds, lookupPreset, presetIds, lookupPack, packIds } from './rolls.mjs';
