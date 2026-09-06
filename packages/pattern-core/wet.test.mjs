// .wet() - the per-fx-slot dry/wet mix. An effect turned down to 0 is a bypass, so a wet lane is
// how an effect comes and goes across a song without a plugin being spawned mid-set. The controls
// are channel controls (wet1..wet7, pseudo-slot -1), which is what gets them ramps, modulators and
// re-eval teardown for free; the crossfade itself lives in the track SynthDef, pinned at the
// bottom of this file by reading the source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { note, sine, _auto, auto, setPatternWarn, CHANNEL_DEFAULTS, MAX_FX_SLOTS } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';
import { clearRolls, setRollLayer } from './src/rolls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  const callsTo = (method) => calls.filter((c) => c.method === method);
  return { engine, calls, callsTo };
}

const channelSends = (callsTo, name) =>
  callsTo('setParam').filter((c) => c.args[1] === -1 && c.args[2] === name).map((c) => c.args[3]);

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

// ---------------------------------------------------------------------------------------------
// The pattern side
// ---------------------------------------------------------------------------------------------

test('.wet() aims at the effect before it, by chain slot', () => {
  const sig = note('c2').synth('Serum 2').fx('ValhallaRoom').wet(0.3).fx('Pro-C 2').wet(0.8);
  assert.equal(sig.channel.wet1.sample(0, 1, 0), 0.3);
  assert.equal(sig.channel.wet2.sample(0, 1, 0), 0.8);
});

test('every slot is fully wet by default, so an untouched chain is unchanged', () => {
  for (let i = 1; i <= MAX_FX_SLOTS; i++) assert.equal(CHANNEL_DEFAULTS[`wet${i}`], 1);
  const sig = note('c2').synth('Serum 2').fx('ValhallaRoom');
  assert.equal(sig.channel.wet1, undefined, 'no .wet() call sets no control at all');
});

test('.wet() with no effect to turn down is a mistake worth stopping for', () => {
  assert.throws(() => note('c2').synth('Serum 2').wet(0.5), /put it after an \.fx/);
});

test('past the engine\'s last fx slot it warns and leaves the pattern alone', () => {
  let sig = note('c2').synth('Serum 2');
  for (let i = 0; i < MAX_FX_SLOTS; i++) sig = sig.fx('ValhallaRoom');
  const ok = capture(() => sig.wet(0.5));
  assert.equal(ok.lines.length, 0);
  assert.equal(ok.value.channel[`wet${MAX_FX_SLOTS}`].sample(0, 1, 0), 0.5);

  const over = capture(() => sig.fx('Pro-C 2').wet(0.5));
  assert.equal(over.lines.length, 1);
  assert.match(over.lines[0], /only reaches the first 7 effects/);
  assert.equal(over.value.channel[`wet${MAX_FX_SLOTS + 1}`], undefined);
});

test('.wet() takes patterns and signals like any control', () => {
  const stepped = note('c2').synth('Serum 2').fx('ValhallaRoom').wet('<1 0>');
  assert.equal(stepped.channel.wet1.sample(0, 1, 0), 1);
  assert.equal(stepped.channel.wet1.sample(0, 1, 1), 0);
  const modulated = note('c2').synth('Serum 2').fx('ValhallaRoom').wet(sine(1));
  assert.ok(modulated.channel.wet1.lfoIR, 'a modulator stays symbolic - the native path still applies');
});

test('an automation lane drives it on absolute song time', () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
  _auto('intro', '0,1 16,1 20,0');
  const sig = note('c2').synth('Serum 2').fx('FilterFreak 1').wet(auto('intro'));
  assert.equal(sig.channel.wet1.sample(0, 1, 0), 1); // the effect is there through the intro
  assert.equal(sig.channel.wet1.sample(0, 1, 18), 0.5); // ...fading out across bars 16-20
  assert.equal(sig.channel.wet1.sample(0, 1, 40), 0); // ...and gone for the rest of the song
});

// ---------------------------------------------------------------------------------------------
// The scheduler side: an ordinary channel control, teardown included
// ---------------------------------------------------------------------------------------------

test('wet is polled as a slot -1 channel control', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2*4').synth('Serum 2').fx('ValhallaRoom').wet(0.3));
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, 'wet1'), [0.3]);
});

test('dropping the .wet() call snaps that slot back to fully wet', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2*4').synth('Serum 2').fx('ValhallaRoom').wet(0.3));
  sch.setPattern(note('c2*4').synth('Serum 2').fx('ValhallaRoom'));
  assert.deepEqual(channelSends(callsTo, 'wet1'), [1]);
});

test('dropping the .fx() too still resets its wet - the slot outlives the pattern', () => {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(note('c2*4').synth('Serum 2').fx('ValhallaRoom').wet(0.3));
  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.deepEqual(channelSends(callsTo, 'wet1'), [1]);
});

// ---------------------------------------------------------------------------------------------
// The engine side: the crossfade in the track SynthDef
// ---------------------------------------------------------------------------------------------

test('each fx slot crossfades between its input and the plugin, gated by the load switch', () => {
  const scd = fs.readFileSync(path.join(HERE, '../osc-engine/sc/poptart.scd'), 'utf8');
  const def = scd.match(/buildTrackDef = \{[\s\S]*?\n\};/);
  assert.ok(def, 'could not find buildTrackDef in sc/poptart.scd');
  const src = def[0];

  // The mix is `active` AND the user's wet: an unloaded slot outputs silence, not pass-through,
  // so it has to read as dry however the wet control is set.
  assert.match(src, /\("active" \+\+ i\)\.asSymbol\.kr\(0\) \* \("wet" \+\+ i\)\.asSymbol\.kr\(1\)/);
  // Linear, so the endpoints are exactly the two signals - see Sig#wet.
  assert.match(src, /sig = \(sig \* \(1 - mix\)\) \+ \(wet \* mix\)/);
  assert.ok(!src.includes('Select.ar(("active"'), 'the old hard bypass switch is gone');
  // The default keeps every existing patch sounding the same.
  assert.match(src, /"wet" \+\+ i\)\.asSymbol\.kr\(1\)/);
});

test('the JS slot ceiling matches the SynthDef scaffold', () => {
  const scd = fs.readFileSync(path.join(HERE, '../osc-engine/sc/poptart.scd'), 'utf8');
  const maxSlots = Number(/var maxSlots = (\d+)/.exec(scd)?.[1]);
  assert.ok(Number.isFinite(maxSlots), 'could not read maxSlots from sc/poptart.scd');
  assert.equal(MAX_FX_SLOTS, maxSlots - 1, 'slot 0 is the instrument, so fx slots are maxSlots - 1');
});
