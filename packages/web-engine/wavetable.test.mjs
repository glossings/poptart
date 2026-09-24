// The Wavetable synth: its descriptor's promises, its voice allocation, and the sample-accurate
// note timing that keeps a part played on it from walking against the grid.

import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, findParam, signalDestinations } from './src/descriptor.mjs';
import { PARAM_FIELDS, TABLE_NAMES, WAVETABLE, WavetableSynth, MAX_VOICES } from './src/devices/wavetable.mjs';
import { VoiceParams, midiToHz } from './src/dsp/voice.mjs';
import { WARP_MODES } from './src/dsp/warp.mjs';
import { Adsr, STAGE, curveShape } from './src/dsp/adsr.mjs';
import { GRANULAR, GranularSynth, drawnWindow, grainWindow } from './src/devices/granular.mjs';

const SR = 48000;

function render(synth, count, block = 128) {
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  for (let at = 0; at < count; at += block) {
    const n = Math.min(block, count - at);
    synth.process(left.subarray(at, at + n), right.subarray(at, at + n), n);
  }
  return { left, right };
}

const peak = (buf) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (buf) => Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / Math.max(1, buf.length));

test('every parameter the descriptor promises has somewhere to go', () => {
  // A renamed parameter should fail here rather than becoming a control that does nothing.
  const struct = new VoiceParams();
  for (const [id, field] of Object.entries(PARAM_FIELDS)) {
    assert.ok(findParam(WAVETABLE, id), `the descriptor has no parameter "${id}"`);
    assert.ok(field in struct, `VoiceParams has no field "${field}" for "${id}"`);
  }
  // And every parameter is either mapped or handled by name.
  const handledByName = new Set(['voices']);
  for (const p of WAVETABLE.params) {
    assert.ok(p.id in PARAM_FIELDS || handledByName.has(p.id), `parameter "${p.id}" is not wired to anything`);
  }
});

test('the mode lists in the descriptor are the ones the code actually switches on', () => {
  assert.deepEqual([...findParam(WAVETABLE, 'osc1.warpmode').options], [...WARP_MODES]);
  assert.deepEqual([...findParam(WAVETABLE, 'osc1.table').options], [...TABLE_NAMES]);
  assert.equal(findParam(WAVETABLE, 'osc1.table').capacity, 64, 'with room past the shipped tables for loaded ones');
});

test('parameters resolve by their display names, which is what userland types', () => {
  assert.equal(findParam(WAVETABLE, 'Osc 1 Position')?.id, 'osc1.position');
  assert.equal(findParam(WAVETABLE, 'Amp Attack')?.id, 'ampenv.attack');
  assert.equal(findParam(WAVETABLE, 'osc 2 warp mode')?.id, 'osc2.warpmode');
});

test('the envelope times are in seconds and the tuning in musical units, for the readouts', () => {
  assert.equal(findParam(WAVETABLE, 'ampenv.attack').unit, 's');
  assert.equal(findParam(WAVETABLE, 'osc1.cents').unit, 'ct');
  assert.equal(findParam(WAVETABLE, 'osc1.semi').unit, 'st');
  assert.equal(findParam(WAVETABLE, 'osc1.semi').ui, 'number', 'a transposition is typed, not turned');
  assert.equal(findParam(WAVETABLE, 'osc1.phase').unit, 'cyc');
});

test('the modes and counts are the only k-rate controls; everything continuous can be driven', () => {
  const kRate = WAVETABLE.params.filter((p) => p.rate === 'k').map((p) => p.id).sort();
  assert.deepEqual(kRate, [
    'env.acurve', 'env.dcurve', 'env.rcurve', 'env.scale',
    'osc1.octave', 'osc1.phaserand', 'osc1.table', 'osc1.unison', 'osc1.warpmode',
    'osc2.octave', 'osc2.phaserand', 'osc2.table', 'osc2.unison', 'osc2.warpmode',
    'sub.octave', 'sub.shape',
    'voices',
  ]);
});

test('phase and pitch are ordinary parameters a signal can drive: there are no separate inputs', () => {
  const ids = signalDestinations(WAVETABLE).map((d) => d.id);
  for (const id of ['osc1.phase', 'osc2.phase', 'osc1.semi', 'osc1.cents']) assert.ok(ids.includes(id), `${id} should be patchable`);
  assert.equal(findParam(WAVETABLE, 'Osc 1 Phase')?.id, 'osc1.phase');
  assert.equal(findParam(WAVETABLE, 'Osc 1 Phase').rate, 'a');
  assert.equal(findParam(WAVETABLE, 'Osc 1 Phase').max, 1, 'one full turn: a signal covers the whole cycle');
  assert.equal(findParam(WAVETABLE, 'Osc 1 Semi').rate, 'a');
});

test('a fresh synth plays a note and stops when it is released', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams(defaultValues(WAVETABLE));
  synth.queueNoteOn(60, 1, 0);
  const sounding = render(synth, 4096);
  assert.ok(peak(sounding.left) > 0.01, 'a note should make a sound');

  synth.queueNoteOff(60, 0);
  render(synth, 16384);          // comfortably longer than the default 150 ms release
  assert.equal(synth.activeVoices, 0, 'the voice should have finished');
  const silent = render(synth, 512);
  assert.equal(peak(silent.left), 0);
});

test('a note starts at the sample it was queued for, not at the next block boundary', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), 'ampenv.attack': 0 });
  synth.queueNoteOn(72, 1, 100);
  const { left } = render(synth, 128, 128);
  for (let i = 0; i < 100; i++) assert.equal(left[i], 0, `sample ${i} should still be silent`);
  let heard = 0;
  for (let i = 100; i < 128; i++) if (Math.abs(left[i]) > 0) heard++;
  assert.ok(heard > 0, 'the note should have started inside the block');
});

test('an edge queued past the end of the block waits, shifted, for the next one', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), 'ampenv.attack': 0 });
  synth.queueNoteOn(60, 1, 200);          // two hundred samples into a 128-sample block
  const first = render(synth, 128, 128);
  assert.equal(peak(first.left), 0, 'nothing should sound in the first block');
  assert.equal(synth.events.length, 1);
  assert.equal(synth.events[0].at, 72, 'the edge should have moved back by one block');
  const second = render(synth, 128, 128);
  assert.ok(peak(second.left) > 0, 'the note should land in the second block');
});

test('the note is the voice identity: a second on for the same pitch takes the same voice', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams(defaultValues(WAVETABLE));
  synth.queueNoteOn(64, 1, 0);
  render(synth, 256);
  assert.equal(synth.activeVoices, 1);
  synth.queueNoteOn(64, 1, 0);
  render(synth, 256);
  assert.equal(synth.activeVoices, 1, 'the same pitch should not stack up voices');
  synth.queueNoteOff(64, 0);
  render(synth, 48000);
  assert.equal(synth.activeVoices, 0, 'one off should release it');
});

test('a chord plays every note at once, up to the voice count', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams(defaultValues(WAVETABLE));
  for (const n of [60, 64, 67, 71]) synth.queueNoteOn(n, 1, 0);
  render(synth, 512);
  assert.equal(synth.activeVoices, 4);
});

test('the voice count is a real limit, and the oldest voice is what gets taken', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 2 });
  synth.queueNoteOn(60, 1, 0); render(synth, 256);
  synth.queueNoteOn(62, 1, 0); render(synth, 256);
  synth.queueNoteOn(64, 1, 0); render(synth, 256);
  assert.equal(synth.activeVoices, 2, 'a third note must take a voice, not add one');
  const notes = synth.voices.slice(0, 2).filter((v) => v.active).map((v) => v.note).sort((a, b) => a - b);
  assert.deepEqual(notes, [62, 64], 'the oldest note should be the one taken');
});

test('a releasing voice is taken before a held one, so a chord survives a fast part over it', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 3, 'ampenv.release': 5 });
  synth.queueNoteOn(48, 1, 0); render(synth, 256);   // held
  synth.queueNoteOn(50, 1, 0); render(synth, 256);   // will be released
  synth.queueNoteOff(50, 0); render(synth, 256);
  synth.queueNoteOn(52, 1, 0); render(synth, 256);
  synth.queueNoteOn(53, 1, 0); render(synth, 256);   // must take the releasing voice, not 48
  const held = synth.voices.slice(0, 3).find((v) => v.active && v.note === 48);
  assert.ok(held, 'the held note should have survived');
});

test('the voice count cannot be driven past what the synth can run', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 999 });
  assert.equal(synth.voiceCount, MAX_VOICES);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 0 });
  assert.equal(synth.voiceCount, 1);
});

test('lowering the voice count lets the voices above it finish rather than leaving them stuck', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 4, 'ampenv.release': 0.05 });
  for (const n of [60, 64, 67, 71]) synth.queueNoteOn(n, 1, 0);
  render(synth, 256);
  assert.equal(synth.activeVoices, 4);
  synth.setParams({ ...defaultValues(WAVETABLE), voices: 1, 'ampenv.release': 0.05 });
  const still = render(synth, 256);
  assert.ok(peak(still.left) > 0, 'the notes above the new count keep sounding');
  for (const n of [60, 64, 67, 71]) synth.queueNoteOff(n, 0);
  render(synth, 48000);
  assert.equal(synth.activeVoices, 0, 'and every one of them can end');
});

test('velocity scales the note, and a released note fades rather than cutting', () => {
  const quiet = new WavetableSynth(SR);
  quiet.setParams(defaultValues(WAVETABLE));
  quiet.queueNoteOn(60, 0.25, 0);
  const soft = rms(render(quiet, 8192).left);

  const loud = new WavetableSynth(SR);
  loud.setParams(defaultValues(WAVETABLE));
  loud.queueNoteOn(60, 1, 0);
  const hard = rms(render(loud, 8192).left);
  assert.ok(hard > soft * 2.5, `velocity should scale the level: ${hard.toFixed(4)} against ${soft.toFixed(4)}`);
});

test('all-notes-off releases everything and drops what was queued', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams(defaultValues(WAVETABLE));
  for (const n of [60, 64, 67]) synth.queueNoteOn(n, 1, 0);
  render(synth, 256);
  synth.queueNoteOn(72, 1, 0);
  synth.allNotesOff();
  assert.equal(synth.events.length, 0);
  render(synth, 48000);
  assert.equal(synth.activeVoices, 0);
});

test('a note plays at the pitch it was given', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({ ...defaultValues(WAVETABLE), 'osc1.table': 0, 'osc1.position': 0 });
  synth.queueNoteOn(69, 1, 0);          // A4
  const { left } = render(synth, 8192);
  // Count zero crossings over a stretch well after the attack.
  let crossings = 0;
  for (let i = 4097; i < 8192; i++) if ((left[i - 1] < 0) !== (left[i] < 0)) crossings++;
  const hz = (crossings / 2) * (SR / 4095);
  assert.ok(Math.abs(hz - 440) < 12, `expected about 440 Hz, measured ${hz.toFixed(1)}`);
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
});

test('a signal on the phase is read per sample, so a signal patched in really is modulation', () => {
  // A single-frame sine table, a phase offset of half a cycle, and an amp envelope with no
  // attack: the modulated render must be the plain one inverted, sample for sample. Only a
  // per-sample read of the phase array gets that; a per-block read of its first element (zero)
  // would leave the two identical.
  const base = { ...defaultValues(WAVETABLE), 'ampenv.attack': 0, 'osc1.table': 0, 'osc1.position': 0 };
  const dry = new WavetableSynth(SR);
  dry.setParams(base);
  dry.queueNoteOn(60, 1, 0);
  const plain = render(dry, 512).left;

  const wet = new WavetableSynth(SR);
  const phase = new Float32Array(128).fill(0.5);
  phase[0] = 0;
  wet.setParams({ ...base, 'osc1.phase': phase });
  wet.queueNoteOn(60, 1, 0);
  const modulated = render(wet, 512).left;
  for (let i = 1; i < 128; i++) assert.ok(Math.abs(plain[i] + modulated[i]) < 1e-4, `sample ${i} should be inverted`);
});

test('an oscillator bent by the other is heard bent, and the modulator can be silent', () => {
  // Osc 1 frequency-modulated by osc 2 at zero level: the modulation has to be audible even
  // though the modulator is not, or "turn the modulator down" would turn the modulation off.
  const base = { ...defaultValues(WAVETABLE), 'ampenv.attack': 0, 'osc1.table': 0, 'osc1.position': 0, 'osc2.level': 0 };
  const plain = new WavetableSynth(SR);
  plain.setParams(base);
  plain.queueNoteOn(60, 1, 0);
  const dry = render(plain, 2048).left;

  for (const mode of ['fm osc', 'pm osc', 'fm sub', 'pm noise', 'ring osc']) {
    const bent = new WavetableSynth(SR);
    bent.setParams({ ...base, 'osc1.warpmode': WARP_MODES.indexOf(mode), 'osc1.warp': 0.6, 'osc2.semi': 7 });
    bent.queueNoteOn(60, 1, 0);
    const wet = render(bent, 2048).left;
    let diff = 0;
    for (let i = 256; i < 2048; i++) diff += Math.abs(wet[i] - dry[i]);
    assert.ok(diff / 1792 > 0.01, `${mode} should change the sound, mean difference ${diff / 1792}`);
    for (let i = 0; i < 2048; i++) assert.ok(Number.isFinite(wet[i]) && Math.abs(wet[i]) < 4, `${mode} sample ${i} was ${wet[i]}`);
  }
});

test('a file becomes a table: cut into frames of the length it declares, one cycle stretched to a frame', () => {
  const synth = new WavetableSynth(SR);
  const short = new Float32Array(600);
  for (let i = 0; i < 600; i++) short[i] = i / 300 - 1;
  assert.equal(synth.loadSample('osc1.table', 20, { name: 'cycle', channels: [short], frameLength: null }), true);
  assert.equal(synth.tables[20].frameCount, 1, 'a single cycle is one frame');
  assert.equal(synth.tables[20].length, 2048, 'stretched to the frame length');

  const stack = new Float32Array(2048 * 3);
  for (let i = 0; i < stack.length; i++) stack[i] = Math.sin(i * 0.02);
  assert.equal(synth.loadSample('osc1.table', 21, { name: 'stack', channels: [stack, stack], frameLength: null }), true);
  assert.equal(synth.tables[21].frameCount, 3);
  assert.equal(synth.loadSample('osc1.table', 22, { name: 'odd', channels: [stack], frameLength: 600 }), true);
  assert.equal(synth.tables[22].length, 1024, 'a declared length that is no power of two is rounded up to one');
  assert.equal(synth.loadSample('level', 1, { channels: [stack] }), false, 'only a table slot takes a table');

  synth.setParams({ ...defaultValues(WAVETABLE), 'osc1.table': 21 });
  synth.queueNoteOn(60, 1, 0);
  assert.ok(peak(render(synth, 2048).left) > 0.01, 'and the loaded table plays');
  assert.equal(synth.tableFor(40), synth.tables[0], 'an empty slot plays the first table');
});

test('nothing the synth renders is out of range or not a number', () => {
  const synth = new WavetableSynth(SR);
  synth.setParams({
    ...defaultValues(WAVETABLE),
    'osc1.level': 1, 'osc2.level': 1, 'sub.level': 1, 'noise.level': 1,
    'osc1.warp': 1, 'osc2.warp': 1, 'osc1.unison': 8, 'osc2.unison': 8,
    'level': 1,
  });
  for (const n of [36, 48, 60, 72, 84]) synth.queueNoteOn(n, 1, 0);
  const { left, right } = render(synth, 8192);
  for (let i = 0; i < left.length; i++) {
    assert.ok(Number.isFinite(left[i]) && Math.abs(left[i]) < 16, `left sample ${i} was ${left[i]}`);
    assert.ok(Number.isFinite(right[i]) && Math.abs(right[i]) < 16, `right sample ${i} was ${right[i]}`);
  }
});

test('the envelope curve is continuous through zero and hits both ends exactly', () => {
  for (const curve of [-8, -4, -0.0005, 0, 0.0005, 4, 8]) {
    assert.equal(curveShape(0, curve), 0);
    assert.equal(curveShape(1, curve), 1);
    for (let t = 0; t <= 1; t += 0.05) {
      const v = curveShape(t, curve);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `curve ${curve} at ${t} gave ${v}`);
    }
  }
  // Either side of the guard the shape must agree, or a curve swept through zero would click.
  assert.ok(Math.abs(curveShape(0.3, 0.0009) - curveShape(0.3, -0.0009)) < 0.01);
});

test('an envelope released during its attack fades from where it got to, not from the sustain', () => {
  const env = new Adsr(SR);
  env.set({ attack: 1, decay: 0.1, sustain: 0.2, release: 0.5, curve: 0 });
  env.gateOn();
  for (let i = 0; i < SR / 4; i++) env.next();     // a quarter of the way up
  const atRelease = env.value;
  assert.ok(atRelease > 0.2 && atRelease < 0.4, `expected to be partway up, was ${atRelease}`);
  env.gateOff();
  assert.equal(env.stage, STAGE.RELEASE);
  const first = env.next();
  assert.ok(first <= atRelease, 'the release must not jump up to the sustain level first');
});

test('each stage bends by its own curve, and a single curve still sets all three', () => {
  // The case this exists for: a plucked sound is an instant attack and a hard exponential
  // decay, which is one curve on one stage and none on the other. A single control for all
  // three means picking which of the two to get right.
  const at = (env, seconds) => { for (let i = 0; i < SR * seconds; i++) env.next(); return env.value; };

  const straight = new Adsr(SR);
  straight.set({ attack: 1, decay: 1, sustain: 0, release: 1, attackCurve: 0, decayCurve: 0 });
  straight.gateOn();
  assert.ok(Math.abs(at(straight, 0.5) - 0.5) < 0.02, 'a straight attack is halfway up halfway through');

  // Negative means the same thing on a rising stage as on a falling one: fast, then levelling
  // off. It used to mean the opposite on the attack, which was one number with two readings.
  const bent = new Adsr(SR);
  bent.set({ attack: 1, decay: 1, sustain: 0, release: 1, attackCurve: -8, decayCurve: 0 });
  bent.gateOn();
  assert.ok(at(bent, 0.5) > 0.9, 'a hard attack curve is nearly all the way up by halfway');

  // And the decay is untouched by the attack's curve: the two are separate controls now.
  const decayOf = (decayCurve) => {
    const env = new Adsr(SR);
    env.set({ attack: 0, decay: 1, sustain: 0, release: 1, attackCurve: -8, decayCurve });
    env.gateOn();
    return at(env, 0.5);
  };
  assert.ok(Math.abs(decayOf(0) - 0.5) < 0.02, 'a straight decay is halfway down halfway through');
  assert.ok(decayOf(-8) < 0.1, 'a hard decay is nearly gone by halfway');

  // One `curve` still sets all three, which is what a device with a single knob passes.
  const shared = new Adsr(SR);
  shared.set({ curve: 3 });
  assert.deepEqual([shared.attackCurve, shared.decayCurve, shared.releaseCurve], [3, 3, 3]);
  shared.set({ decayCurve: -1 });
  assert.deepEqual([shared.attackCurve, shared.decayCurve, shared.releaseCurve], [3, -1, 3]);
});

test('a zero-length stage is instant rather than a ramp nobody can hear', () => {
  const env = new Adsr(SR);
  env.set({ attack: 0, decay: 0, sustain: 0.5, release: 0 });
  env.gateOn();
  env.next();
  assert.ok(env.value > 0, 'an instant attack should already be up');
  env.gateOff();
  env.next();
  assert.equal(env.value, 0);
  assert.equal(env.active, false);
});

// --- a window somebody drew --------------------------------------------------------------------

test('a drawn window is sampled once and read from the table, not recomputed per grain', () => {
  // The rule this pins: a curve drawn in the shape editor and a curve played by the synth have
  // to be the same curve. The engine samples it with pattern-core's own sampler and hands over
  // the table; the synth reads that table and nothing else.
  const ramp = Float32Array.from({ length: 256 }, (_, i) => i / 255);
  const syn = new GranularSynth(SR);
  assert.equal(syn.loadShape('window', 6, ramp), true);
  assert.equal(syn.loadShape('sample', 6, ramp), false, 'only the control that takes one');
  assert.equal(syn.loadShape('window', 6, null), false, 'and only with something in it');

  // Read between the points, with the tail fade that stops a window ending loud from clicking.
  assert.ok(Math.abs(drawnWindow(ramp, 0.25) - 0.25) < 0.01);
  assert.ok(Math.abs(drawnWindow(ramp, 0.5) - 0.5) < 0.01);
  assert.equal(drawnWindow(ramp, 1), 0, 'and it always ends at silence');
});

test('the window control takes a drawn curve and has room to keep several', () => {
  const window = GRANULAR.params.find((p) => p.id === 'window');
  assert.equal(window.takes, 'shape');
  assert.ok(window.capacity > window.options.length, 'spare slots for the drawn ones');
  // The shipped shapes keep their indexes: a song stores an enum by its label, but the list is
  // only ever appended to so that an index written by hand still means what it meant.
  assert.deepEqual(window.options.slice(0, 3), ['hann', 'triangle', 'gate']);
  for (const mode of window.options.keys()) {
    assert.ok(Math.abs(grainWindow(mode, 0)) < 1e-9, `${window.options[mode]} starts at silence`);
    assert.ok(Math.abs(grainWindow(mode, 1)) < 1e-6, `${window.options[mode]} ends at silence`);
  }
});
