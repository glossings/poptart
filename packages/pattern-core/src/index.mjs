export { trackColorOf } from './signal.mjs';
export { Sig, Signal, n, note, mini, s, se, sr, sp, say, synth, sine, saw, isaw, tri, square, rand, perlin, lfo, env, dur, midicc, midikeys, osc, macro, fxknob, choose, cat, seq, irand, resetRandomSeeds, midi, audio, input, group, copy, pcopy, setCopyResolver, clips, setClipsOwner, setClipsResolver, clipsOwnerNow, pianoroll, _roll, liveRoll, _shape, _preset, _pack, _slices, liveSlices, _auto, liveAuto, auto, _groove, liveGroove, grooveText, setGlobalGroove, globalGroove, restoreGlobalGroove } from './signal.mjs';
export { normalizeSlicePositions, parseSlicePositions, serializeSlicePositions, normalizeSliceSet, normalizeSliceEntry, normalizeSliceFit, sliceSetIsEmpty, slicePositionsFor, sliceEntryFor, sliceSetKeys, parseSliceSet, serializeSliceSet, SLICE_DECIMALS } from './slices.mjs';
// Controls as top-level builders (control patterns) - the method form of each still lives
// on Sig; these are what let a combinator aim at one channel, x.mul(speed("-1")) / x.mul(clip(2)).
export { i, begin, end, loop, loopwrap, loopdir, speed, flip, stretch, fit, fitmode, slice, splice, splicemode, attack, decay, sustain, release, envscale, grain, vel, clip, nudge, swing, swinggrid, swingvel, SAMPLER_CONTROL_NAMES } from './signal.mjs';
// The binops as top-level builders - a layer piece's own verb: .set(note(30), add(note(12))).
export { add, sub, mul, div, mod, set } from './signal.mjs';
export { struct, hold, seg, segment, chord } from './signal.mjs';
export { channelAt, soundingEnd, timeShift, grooveAt, grooveVelScale, endEdgeStep, withSoundingSpan, MAX_FX_SLOTS, monitorSig, channelDefault } from './signal.mjs';
export { steadyValue } from './signal.mjs';
export { setPatternWarn, lfoShapes, lfoPoints, withNoteGate, withEventSpan, noteGateFromGrid, sampleEnvIR, NOTE_GATE_LOOKBACK_CYCLES } from './signal.mjs';
export { feedMidiCC, midiInUse } from './midi.mjs';
export { feedOsc, oscInUse, latestOsc, normalizeOscAddress } from './osc.mjs';
export { setAudioInputLayout, audioInputLayout, audioInputChannelCount, resolveInputChannels } from './audio-inputs.mjs';
export { setMacro, macroValue, MACRO_COUNT } from './macros.mjs';
export { setFxKnob, fxKnobValue, FX_KNOB_COUNT } from './fxknobs.mjs';
export { Scheduler, Transport, DeckClock, setEventLogger } from './scheduler.mjs';
export { parseScaleName, degreeToMidi, midiToDegree, noteToMidi, registerTuning, registeredTunings, parseScala, scaleSize, tuningNames, modeNames } from './notes.mjs';
export { setGlobalScale, globalScale, scaleAtOctave, scaleParts, DEFAULT_SCALE, DEFAULT_SCALE_OCTAVE } from './notes.mjs';
export { recordingToMini, UNQUANTIZED_GRID, recordingToRoll, captureWindow, recordStartCycle, UNQUANTIZED_ROLL_GRID } from './record.mjs';
export { parseMidiFile, midiFileToLanes, midiLanesToPianoroll, pickGrid, detectKey, GRID_CANDIDATES, BEATS_PER_CYCLE } from './midifile.mjs';
export { parseMini, getStepsForCycle, stepLocs } from './mini.mjs';
export { splitLabeledBlocks, isBareCallBlock, isBusBlock, isBodylessGroup, isRowlessBlock } from './labels.mjs';
export { isGroupSig, routeGroups, treeOfBlocks, normalizeGroupTree, parentsOf, ancestorsOf, descendantsOf, markerResolver, trackNames, monitorPicker, MONITOR_SUFFIX, groupOrder, GROUP_ROOT } from './groups.mjs';
export { injectLocations, injectLocationsMapped, isPatternPosition, miniOffRanges } from './locations.mjs';
export { blockSource, noteBlockFailure, describeEvalError, warningWhere, withPosition, withDeepStacks, nearestName, plainText, locateStack, lineCol, bracketProblem, resetBlockSources } from './eval-errors.mjs';
export { looksLikeShapeData, parseShapePoints, serializeShapePoints, sampleShape, curveInterp, SHAPE_PRESETS, parseAutoPoints, serializeAutoPoints, sampleAutoPoints, parseBendPoints, serializeBendPoints, sampleBendPoints, bendIsFlat } from './shape.mjs';
export { extractGroove, fitGrooveGrid, grooveHitsOnGrid, grooveHitsInCycles, grooveHitsFromFile } from './groove-extract.mjs';
export { looksLikeGrooveData, grooveNameLike, parseGroove, serializeGroove, grooveIsFlat, grooveHasVel, grooveSlot, grooveTimeAt, grooveVelAt, grooveRef, resolveGroove, grooveByName, GROOVE_PRESETS, GROOVE_NAMES } from './groove.mjs';
export { parsePianoRoll, serializePianoRoll, normalizePianoRollSteps, normalizePianoRollMode, pianoRollEventAt, noteIndex, noteSlice, noteNudge, noteNudgeChannel, pianoRollNotePos, placePianoRollNote, looksLikeNoteString, sliceNotesFor, PIANOROLL_DEFAULT_STEPS, PIANOROLL_MODES, PIANOROLL_DEFAULT_NOTE, PIANOROLL_DEFAULT_INDEX, PIANOROLL_DEFAULT_SLICE, PIANOROLL_MAX_NUDGE, PIANOROLL_MIN_LEN, pianoRollSwingCells, commitPianoRollSwing, pianoRollNoteGrid } from './pianoroll.mjs';
export { registerDeviceParams, deviceParamSpec, parseUnitValue } from './units.mjs';
export { clearRolls, restoreRolls, setRollLayer, setDefOwner, adoptDefs, defScope, defScopeOf, withDefDeck, lookupRoll, rollIds, lookupShape, shapeIds, lookupPreset, presetIds, lookupPack, packIds, lookupSlices, sliceSetIds, lookupAuto, autoIds, lookupGroove, grooveIds } from './rolls.mjs';
export { parseArrangement, serializeArrangement, looksLikeArrangeString, normalizeArrangeOpts, arrangementEnd, arrangementLoops, isWholeSongLoop, arrangementSpans, arrangementLabels, clipsOfLabel, reconcileArrangement, inSpans, ArrangeClock, ClipClock, songSteps, withClipShift, clipShiftNow, stepsUnderShift, _arrange, ARRANGE_DEFAULT_SNAP, ARRANGE_DEFAULT_LEN, ARRANGE_SONG_LOOP, ARRANGE_HOLD } from './arrange.mjs';
export { sampleSourcesOf, fittedCycles } from './sample-source.mjs';
export { routePlan, planRefs, routeLatencies, routeSlots, isRouteControl, routeControlDefault, CROSSOVER_DEVICE, CROSSOVER_MIN_HZ, CROSSOVER_MAX_HZ } from './route.mjs';
// The editor's inline widgets: controls drawn in the code (slider(), steps(), ...) and displays
// drawn under it (.scope(), .punchcard(), ...) - see widgets.mjs and widget-calls.mjs.
export { _input, _display, slider, knob, toggle, button, xy, steps, sliders, matrix, scope, spectrum, waveform, imager, meter, punchcard, chroma, BACKGROUND_DISPLAYS, beginWidgets, takeWidgets, abandonWidgets, setWidgetValue, widgetValue, displayWindow, displayNow, PLOT_POINTS_PER_CYCLE } from './widgets.mjs';
export { findWidgetCalls, widgetCallEdits, callArgs, parseCells, toggleCell, setCellValue, randomRow, randomValues, formatNumber, matrixRows, maskCode, optionsIndex, positionalArgs, optionNumber, optionEdit, optionDrop, widgetSize, widgetBox, sizeKeys, WIDGET_BOXES, rowSource, foldable, cellCount, restRow, middleRow, DEFAULT_CELL_COUNT, INPUT_SIZES, DISPLAY_SIZES, FOLDED_WIDGETS, INPUT_WIDGETS, DISPLAY_WIDGETS, AUDIO_DISPLAYS, RAW_TEXT_WIDGETS, findColorCalls, findColorCallAt, colorCallEdit, findRecordCalls, recordCallEdits, recordTakeName, recordTakeEdit } from './widget-calls.mjs';
export { createWidgetHost, WIDGET_WINDOW, WIDGET_TAP_IDLE_MS } from './widget-host.mjs';
// .record() on a live control: its movement, recorded and looped (see motion.mjs).
export { recordMotion, createMotionRecorder, motionWindow, takePoints, takeMotionTakes, releaseWidget, withLiveReads, motionSourceOf, MOTION_DEFAULT_CYCLES, MOTION_IDLE_CYCLES } from './motion.mjs';
