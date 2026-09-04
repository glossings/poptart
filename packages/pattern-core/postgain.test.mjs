// The gain split: `.gain()` is the level going INTO the track's fx chain and `.postgain()` the
// level coming out of it, so a level move can be a drive move or a fader move and the pattern
// says which. They are two independent channel controls (pseudo-slot -1) that compose the same
// way; the ctrl+g mixer's fader owns postgain. The audible half of the split lives in the track
// SynthDef, which is pinned at the bottom of this file by reading the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { note, sine, CHANNEL_DEFAULTS } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { readTrim, trimEdit, TRIM_DEFAULTS } from './src/mixctl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Same stand-in engine the other scheduler tests use: every method records its call, getTime is 0.
function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, calls, callsTo };
}

/** The values one poll sent for a channel control (pseudo-slot -1), in order. */
function channelSends(callsTo, name) {
  return callsTo('setParam').filter((c) => c.args[1] === -1 && c.args[2] === name).map((c) => c.args[3]);
}

// ---------------------------------------------------------------------------------------------
// The pattern side
// ---------------------------------------------------------------------------------------------

test('gain and postgain are separate channel controls, both unity by default', () => {
  assert.equal(CHANNEL_DEFAULTS.gain, 1);
  assert.equal(CHANNEL_DEFAULTS.postgain, 1);
  const sig = note('c2').synth('Serum 2').gain(0.5).postgain(0.25);
  assert.equal(sig.channel.gain.sample(0, 1, 0), 0.5);
  assert.equal(sig.channel.postgain.sample(0, 1, 0), 0.25);
});

test('setting one leaves the other unset - a fader move is not a drive move', () => {
  const drive = note('c2').synth('Serum 2').gain(2);
  assert.equal(drive.channel.postgain, undefined);
  const fader = note('c2').synth('Serum 2').postgain(0.3);
  assert.equal(fader.channel.gain, undefined);
});

test('postgain chains multiply, like gain - and the two chains stay apart', () => {
  const sig = note('c2').synth('Serum 2').postgain(0.5).postgain(0.5).gain(2);
  assert.equal(sig.channel.postgain.sample(0, 1, 0), 0.25);
  assert.equal(sig.channel.gain.sample(0, 1, 0), 2);
});

test('a number folded onto a postgain modulator keeps the native path, as it does for gain', () => {
  const sig = note('c2').synth('Serum 2').postgain(sine(1)).postgain(0.5);
  assert.ok(sig.channel.postgain.lfoIR, 'still a symbolic modulator, not a polled product');
  assert.equal(sig.channel.postgain.lfoIR.max, 0.5, 'the scalar scaled its bounds');
});

// ---------------------------------------------------------------------------------------------
// The scheduler side: both ride the channel-control path, and both snap back when dropped
// ---------------------------------------------------------------------------------------------

test('both are polled as slot -1 channel controls', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(2).postgain(0.4));
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'gain'), [2]);
  assert.deepEqual(channelSends(callsTo, 'postgain'), [0.4]);
});

test('dropping .postgain() from the code resets it to unity, leaving gain alone', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').gain(2).postgain(0.4));
  sch.setPattern(note('c2*4').synth('Serum 2').gain(2));
  assert.deepEqual(channelSends(callsTo, 'postgain'), [1], 'the dropped control snapped back');
  assert.deepEqual(channelSends(callsTo, 'gain'), [], 'the one still in the code was not reset');
});

test('the mixer can hold postgain under a finger', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'bass' });
  sch.setPattern(note('c2*4').synth('Serum 2').postgain(0.5));
  assert.equal(sch.holdChannel('postgain', 0.8), null);
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'postgain'), [0.8]);
});

// ---------------------------------------------------------------------------------------------
// The mixer's code edits: the fader owns postgain, and never reads a .gain() as its own
// ---------------------------------------------------------------------------------------------

test('postgain is a mixer trim, defaulting to unity', () => {
  assert.equal(TRIM_DEFAULTS.postgain, 1);
  const code = 'bass: note("c2*4").synth("Serum 2")';
  assert.deepEqual(readTrim(code, 'bass', 'postgain'), { value: 1, patterned: false });
  assert.deepEqual(trimEdit(code, 'bass', 'postgain', 0.7), { from: code.length, to: code.length, text: '.postgain(0.7)' });
});

test('a .gain() literal is not the fader\'s trim, and a .postgain() is not the drive', () => {
  const code = 'bass: note("c2*4").synth("Serum 2").gain(2).postgain(0.3)';
  assert.deepEqual(readTrim(code, 'bass', 'postgain'), { value: 0.3, patterned: false });
  assert.deepEqual(readTrim(code, 'bass', 'gain'), { value: 2, patterned: false });
});

test('the fader rewrites the postgain literal in place, leaving the gain literal alone', () => {
  const code = 'bass: note("c2*4").synth("Serum 2").gain(2).postgain(0.3)';
  const edit = trimEdit(code, 'bass', 'postgain', 0.6);
  const after = code.slice(0, edit.from) + edit.text + code.slice(edit.to);
  assert.equal(after, 'bass: note("c2*4").synth("Serum 2").gain(2).postgain(0.6)');
});

// ---------------------------------------------------------------------------------------------
// The engine side: where each one sits in the track SynthDef
// ---------------------------------------------------------------------------------------------

test('the track SynthDef takes gain into the chain and postgain at the strip', () => {
  const scd = fs.readFileSync(path.join(HERE, '../osc-engine/sc/poptart.scd'), 'utf8');
  const def = scd.match(/buildTrackDef = \{[\s\S]*?\n\};/);
  assert.ok(def, 'could not find buildTrackDef in sc/poptart.scd');
  const src = def[0];

  const inGain = src.indexOf('sig = sig * gain.lag');
  const firstFx = src.indexOf('VSTPlugin.ar(Ref(');
  const strip = src.indexOf('Balance2.ar');
  assert.ok(inGain > 0, 'gain is applied to the chain input');
  assert.ok(inGain < firstFx, 'gain lands before the first fx slot');
  assert.ok(firstFx < strip, 'and the strip is after the whole chain');
  assert.match(src.slice(strip, strip + 200), /postgain\.lag/, 'the strip fader is postgain');
  assert.equal(src.slice(strip).includes('gain.lag(0.02).clip(0, 4))'), true);
  assert.ok(!/\bBalance2\.ar\([^)]*[^t]gain\.lag/.test(src), 'the plain gain is not the strip fader');
});
