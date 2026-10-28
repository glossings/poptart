// .wet() - the per-fx-slot dry/wet mix. An effect turned down to 0 is a bypass, so a wet lane is
// how an effect comes and goes across a song without a plugin being spawned mid-set. The controls
// are channel controls (wet1..wet20, pseudo-slot -1), which is what gets them ramps, modulators and
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

test('a .wet() reaches any slot, however long the chain', () => {
  let sig = note('c2').synth('Serum 2');
  for (let i = 0; i <= MAX_FX_SLOTS; i++) sig = sig.fx('ValhallaRoom');
  const ok = capture(() => sig.wet(0.5));
  assert.equal(ok.lines.length, 0);
  assert.equal(ok.value.channel[`wet${MAX_FX_SLOTS + 1}`].sample(0, 1, 0), 0.5);
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

test('a chain has no slot limit: every .fx() loads, and a wet past the old twenty rests at 1', () => {
  let sig = note('c2*4').synth('Serum 2');
  const long = capture(() => {
    for (let i = 0; i < MAX_FX_SLOTS + 5; i++) sig = sig.fx('ValhallaRoom');
    return sig.wet(0.4);
  });
  assert.deepEqual(long.lines, []);
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 'pad' });
  sch.setPattern(long.value);
  const slots = callsTo('loadEffect').map((c) => c.args[2]);
  assert.equal(slots.length, MAX_FX_SLOTS + 5);
  sch._pollGenericParams(0);
  assert.deepEqual(channelSends(callsTo, `wet${MAX_FX_SLOTS + 5}`), [0.4]);
  // ...and dropping it snaps it back to fully wet, as the first twenty do.
  sch.setPattern(note('c2*4').synth('Serum 2'));
  assert.deepEqual(channelSends(callsTo, `wet${MAX_FX_SLOTS + 5}`), [0.4, 1]);
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
  const def = scd.match(/buildFxDef = \{[\s\S]*?\n\};/);
  assert.ok(def, 'could not find buildFxDef in sc/poptart.scd');
  const src = def[0];

  // The mix is `active` AND the user's wet: an unloaded slot outputs silence, not pass-through,
  // so it has to read as dry however the wet control is set.
  assert.match(src, /active = 0, native = 0, wet = 1\|/);
  assert.match(src, /var mix = \(active \* wet\)/);
  // Linear, so the endpoints are exactly the two signals - see Sig#wet. The dry side is what the
  // slot reads.
  assert.match(src, /Out\.ar\(out, \(jin \* \(1 - mix\)\) \+ \(pick \* mix\)\)/);
  assert.match(src, /var jin = In\.ar\(in, 2\);/);
});

test('the desktop has no slot ceiling to match: every effect is a node of its own', () => {
  const scd = fs.readFileSync(path.join(HERE, '../osc-engine/sc/poptart.scd'), 'utf8');
  assert.ok(!/var maxSlots = /.test(scd), 'no fixed row of slots in sc/poptart.scd');
  assert.match(scd, /^ensureFxNode = \{/m);
});
