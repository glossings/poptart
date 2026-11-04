// A note marked to slide (pattern-core's Sig#slide) on every synth with a Glide: it carries the voice
// that sounded last on - the pitch glides to the new note, the envelopes do not start again - with
// any number of voices, and a voice letting go is taken back up.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FMSYNTH, FmSynth } from './src/devices/fmsynth.mjs';
import { WAVETABLE, WavetableSynth } from './src/devices/wavetable.mjs';
import { FORMANT, FormantSynth } from './src/devices/formant.mjs';
import { ADDITIVE, AdditiveSynth } from './src/devices/additive.mjs';
import { ANALOG, AnalogSynth } from './src/devices/analog.mjs';
import { STAGE } from './src/dsp/adsr.mjs';
import { midiToHz } from './src/dsp/voice.mjs';

const SR = 48000;
const BLOCK = 128;

// Each synth, and how to read a voice's amp envelope and its pitch in Hz.
const SYNTHS = [
  { name: 'FM', desc: FMSYNTH, make: (sr) => new FmSynth(sr), env: (v) => v.envs[0], hz: (v) => v.currentHz },
  { name: 'Wavetable', desc: WAVETABLE, make: (sr) => new WavetableSynth(sr), env: (v) => v.ampEnv, hz: (v) => v.currentHz },
  { name: 'Formant', desc: FORMANT, make: (sr) => new FormantSynth(sr), env: (v) => v.env, hz: (v) => v.currentHz },
  { name: 'Additive', desc: ADDITIVE, make: (sr) => new AdditiveSynth(sr), env: (v) => v.env, hz: (v) => v.currentHz },
  { name: 'Analog', desc: ANALOG, make: (sr) => new AnalogSynth(sr), env: (v) => v.ampEnv, hz: (v) => midiToHz(v.pitch) },
];

function setup(s, settings = {}) {
  const synth = s.make(SR);
  const values = { ...Object.fromEntries(s.desc.params.map((p) => [p.id, p.default])), glide: 0.1, voices: 8, ...settings };
  synth.setParams(values);
  synth.setBend?.(0);
  const run = (blocks) => {
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let b = 0; b < blocks; b++) {
      synth.setParams(values);
      l.fill(0);
      r.fill(0);
      synth.process(l, r, BLOCK);
    }
  };
  const sounding = () => synth.voices.filter((v) => s.env(v).active);
  return { synth, run, sounding };
}

for (const s of SYNTHS) {
  test(`${s.name}: a sliding note carries the last voice on, gliding, with no new attack`, () => {
    const { synth, run, sounding } = setup(s);
    synth.queueNoteOn(48, 1, 0);
    run(40); // well past the attack
    const [v] = sounding();
    assert.notEqual(s.env(v).stage, STAGE.ATTACK);
    synth.queueNoteOn(55, 1, 0, true);
    run(1);
    assert.equal(sounding().length, 1, 'no second voice');
    assert.equal(v.note, 55);
    assert.notEqual(s.env(v).stage, STAGE.ATTACK, 'the envelope did not start again');
    const hz = s.hz(v);
    assert.ok(hz > midiToHz(48) && hz < midiToHz(55), `gliding (${hz})`);
    run(200);
    assert.ok(Math.abs(s.hz(v) - midiToHz(55)) < 0.5, 'and arrives');
  });

  test(`${s.name}: a plain note takes a voice of its own and starts its envelope`, () => {
    const { synth, run, sounding } = setup(s);
    synth.queueNoteOn(48, 1, 0);
    run(40);
    synth.queueNoteOn(55, 1, 0);
    run(1);
    assert.equal(sounding().length, 2);
  });

  test(`${s.name}: a slide into a voice letting go takes it back up, and its own off ends it`, () => {
    const { synth, run, sounding } = setup(s, { 'ampenv.release': 1, release: 1 });
    synth.queueNoteOn(48, 1, 0);
    run(40);
    synth.queueNoteOff(48, 0);
    run(2);
    const [v] = sounding();
    assert.equal(s.env(v).stage, STAGE.RELEASE);
    synth.queueNoteOn(55, 1, 0, true);
    run(1);
    assert.equal(sounding().length, 1);
    assert.notEqual(s.env(v).stage, STAGE.RELEASE, 'no longer letting go');
    assert.notEqual(s.env(v).stage, STAGE.ATTACK, 'and no new attack');
    synth.queueNoteOff(55, 0);
    run(1);
    assert.equal(s.env(v).stage, STAGE.RELEASE);
  });

  test(`${s.name}: a slide with nothing sounding is a plain note`, () => {
    const { synth, run, sounding } = setup(s);
    synth.queueNoteOn(55, 1, 0, true);
    run(1);
    assert.equal(sounding().length, 1);
    assert.equal(sounding()[0].note, 55);
  });
}
