// A bare cc() on a midicc() device is a learn (see src/midi-learn.mjs): it rests until the next
// knob turned on that device, which is handed to the editor to write into the call.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from './src/index.mjs';

const {
  note, midicc, feedMidiCC, _at, beginWidgets, takeWidgets, takeMidiLearns, midiLearnWaiting,
  MIDI_LEARN_SETTLE_MS, findSourceCalls, Scheduler,
} = core;

const DEVICE = 'Encoder Box Port 1';

/** An evaluation of `deck` that writes these bare (or bound) calls at these offsets. */
function evaluate(deck, calls) {
  beginWidgets(deck);
  for (const [at, sig] of calls) _at(at, sig);
  takeWidgets();
}

/** Lets the settle window pass with the hand still. */
const settle = (t) => t.mock.timers.tick(MIDI_LEARN_SETTLE_MS + 1);

function clean() {
  evaluate('a', []);
  evaluate('b', []);
  takeMidiLearns();
}

test('a bare cc() rests, and the transpile finds it like any other live source', () => {
  const cc = midicc('Encoder Box');
  const sig = cc();
  assert.equal(sig.sample(0, 0.5, 0), null, 'nothing to read until it is learned');
  assert.equal(sig.ccIR, null, 'not a native binding either');
  assert.deepEqual(sig.ccLearn, { device: 'Encoder Box' });
  const code = 'const cc = midicc("Encoder Box")\n$: note("c").param("Cutoff", cc())';
  const found = findSourceCalls(code);
  assert.equal(found.length, 1);
  assert.equal(code.slice(found[0].at, found[0].end), 'cc()');
  assert.throws(() => cc(undefined), /takes \(ccNumber, channel\?\)/, 'only the bare call learns');
});

test('the next knob on the device fills the waiting call once the hand is still', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  const cc = midicc('encoder box');
  evaluate('a', [[120, cc()]]);
  assert.equal(midiLearnWaiting(), 'encoder box');
  feedMidiCC(DEVICE, 1, 12, 0.2);
  feedMidiCC(DEVICE, 1, 12, 0.3);
  assert.deepEqual(takeMidiLearns(), [], 'not while the knob is still turning');
  settle(t);
  assert.deepEqual(takeMidiLearns(), [{ deck: 'a', at: 120, device: DEVICE, channel: 1, cc: 12 }]);
  assert.equal(midiLearnWaiting(), null, 'filled: nothing is waiting any more');
  feedMidiCC(DEVICE, 1, 13, 0.3);
  settle(t);
  assert.deepEqual(takeMidiLearns(), [], 'a filled call is not filled again');
});

test('several bare calls fill one at a time, top to bottom, on either deck', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  const cc = midicc('Encoder Box');
  // Registered out of order: the document's order is what counts.
  evaluate('a', [[300, cc()], [100, cc()], [200, cc(5, 1)]]);
  evaluate('b', [[50, cc()]]);
  for (const num of [12, 13, 14, 15]) {
    feedMidiCC(DEVICE, 2, num, 0.5);
    settle(t);
  }
  assert.deepEqual(takeMidiLearns().map((l) => [l.deck, l.at, l.cc, l.channel]), [
    ['a', 100, 12, 2],
    ['a', 300, 13, 2],
    ['b', 50, 14, 2],
  ]);
  assert.equal(midiLearnWaiting(), null);
});

test('a knob already bound elsewhere still fills the waiting call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  const cc = midicc('Encoder Box');
  evaluate('a', [[10, cc(12, 1)], [40, cc()]]);
  feedMidiCC(DEVICE, 1, 12, 0.9);
  settle(t);
  assert.deepEqual(takeMidiLearns().map((l) => [l.at, l.cc]), [[40, 12]]);
  assert.equal(cc(12, 1).sample(0, 0.5, 0), 0.9, 'and the bound call reads it as before');
});

test('only a device the call names fills it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  evaluate('a', [[10, midicc('Encoder Box')()], [60, midicc('Pad Grid')()]]);
  feedMidiCC('Pad Grid MIDI 1', 3, 40, 1);
  settle(t);
  assert.deepEqual(takeMidiLearns().map((l) => [l.at, l.cc, l.channel]), [[60, 40, 3]], 'the pad grid fills its own call, not the first');
  feedMidiCC('Keyboard 49', 1, 7, 0.5);
  settle(t);
  assert.deepEqual(takeMidiLearns(), [], 'a device no call names fills nothing');
  assert.equal(midiLearnWaiting(), 'Encoder Box');
});

test('the last control moved is learned: a modifier on the way to the knob is passed over', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  evaluate('a', [[10, midicc('Encoder Box')()]]);
  feedMidiCC(DEVICE, 4, 8, 1); // a shift held down
  t.mock.timers.tick(200);
  feedMidiCC(DEVICE, 5, 12, 0.4); // the knob, in the shifted bank
  settle(t);
  assert.deepEqual(takeMidiLearns().map((l) => [l.cc, l.channel]), [[12, 5]]);
});

test('the fine half of a high-resolution pair is never the control learned', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  evaluate('a', [[10, midicc('Encoder Box')()]]);
  feedMidiCC(DEVICE, 1, 7, 0.5);
  feedMidiCC(DEVICE, 1, 39, 0.1); // its fine half, right behind it
  settle(t);
  assert.deepEqual(takeMidiLearns().map((l) => l.cc), [7]);
  // cc 39 on its own - nobody's fine half - is an ordinary knob.
  evaluate('a', [[10, midicc('Encoder Box')()]]);
  t.mock.timers.tick(1000);
  feedMidiCC(DEVICE, 1, 39, 0.1);
  settle(t);
  assert.deepEqual(takeMidiLearns().map((l) => l.cc), [39]);
});

test('an evaluation that drops the waiting call drops the learn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  clean();
  evaluate('a', [[10, midicc('Encoder Box')()]]);
  feedMidiCC(DEVICE, 1, 12, 0.5);
  evaluate('a', []);
  settle(t);
  assert.deepEqual(takeMidiLearns(), []);
});

test('a waiting cc() on a control moves nothing: no binding and no value is sent for it', () => {
  clean();
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, { get: (o, p) => (p in o ? o[p] : (...args) => { calls.push({ method: p, args }); }) });
  const sch = new Scheduler(engine, { trackId: 't' });
  sch.setPattern(note('c2*4').synth('Wavetable').param('Cutoff', midicc('Encoder Box')().range(200, 5000)));
  sch.start(0);
  for (let i = 0; i < 8; i++) sch._tick?.();
  sch.stop();
  const touching = calls.filter((c) => /^(setParam|setParamCC)$/.test(c.method) && c.args.includes('Cutoff'));
  assert.deepEqual(touching, []);
});
