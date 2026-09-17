// The LAYER form of the binops: `.add(a, b)`, `.set(a, b)`, ... edit every event once per argument
// and play all the edits at once. A layer is a chain of pieces - its own values are the pitch, a
// setter adds a channel, a sound swaps the sample - and the binop is the verb every bare piece
// takes, unless the piece names its own with a binop chained inside the layer or a top-level
// wrapper (add()/set()/...). Pure pattern math - no server, no audio.

import test from 'node:test';
import assert from 'node:assert/strict';

import { note, n, s, mini, vel, clip, speed, add, sub, mul, set, setPatternWarn, midi, channelAt, Scheduler } from './src/index.mjs';
import { stepLocs } from './src/mini.mjs';

const steps = (sig, cycle = 0) => sig.stepsForCycle(cycle);
const values = (sig, cycle = 0) => steps(sig, cycle).map((x) => x.value);
const vels = (sig, cycle = 0) => steps(sig, cycle).map((x) => x.vel);
const clips = (sig, cycle = 0) => steps(sig, cycle).map((x) => x.clip);
const spans = (sig, cycle = 0) => steps(sig, cycle).map((x) => [x.start, x.end]);
const cfgs = (sig, cycle = 0) => steps(sig, cycle).map((x) => x.cfg);
// What the scheduler reads for velocity: the event's own value, else the channel at that onset.
const velsHeard = (sig, cycle = 0) => steps(sig, cycle).map((x) => channelAt('vel', x, sig.noteChannels, cycle + x.start, 1, cycle + x.start));
const near = (actual, expected) => actual.forEach((v, i) => (v == null ? assert.equal(v, expected[i]) : assert.ok(Math.abs(v - expected[i]) < 1e-9, `${v} vs ${expected[i]} at ${i}`)));

// Collects what the pattern would say on the editor console.
const warnings = () => {
  const out = [];
  setPatternWarn((m) => out.push(m));
  return out;
};
test.afterEach(() => setPatternWarn(null));

// ---------------------------------------------------------------------------------------------
// The verb record: top-level wrappers and pending channels
// ---------------------------------------------------------------------------------------------

test('a top-level wrapper marks its argument with a verb and leaves the argument alone', () => {
  const twelve = note(12);
  const layer = add(twelve);
  assert.deepEqual(layer.pending.map((e) => e.op), ['add']);
  assert.equal(twelve.pending, null, 'the caller\'s signal is not marked');
  assert.equal(add(vel(-0.3)).ctl, 'vel', 'a control keeps its channel tag through the wrapper');
  assert.deepEqual(values(add(note('0 7').fast(2))), [0, 7, 0, 7], 'the mark rides along a transform');
  assert.equal(add(note('0 7').fast(2)).pending[0].op, 'add');
});

test('an operation on a channel with nothing to compose against is remembered, and reads as before', () => {
  const pat = note('c3').add(vel(-0.3));
  assert.deepEqual(pat.noteChannels.vel.pending.map((e) => e.op), ['add']);
  assert.equal(pat.noteChannels.vel.sample(0, 1, 0), 0.7, 'the channel reads the operation applied to the resting default');
  near(velsHeard(pat), [0.7], 'so does the event');
  // A patterned operand merges onto the events, and each carries the operation itself.
  const gridded = note('c3').add(vel('-0.3 -0.5'));
  near(vels(gridded), [0.7, 0.5]);
  assert.deepEqual(steps(gridded).map((x) => x.pend.vel.map((e) => [e.op, e.v])), [[['add', -0.3]], [['add', -0.5]]]);
});

test('an operation on a channel that IS set composes on the spot and records nothing', () => {
  const pat = note('c3').vel(0.9).add(vel(-0.3));
  assert.equal(pat.noteChannels.vel.pending, null);
  near(velsHeard(pat), [0.6]);
  assert.equal(steps(pat)[0].pend, undefined);
});

test('chained operations on a pending channel extend the record', () => {
  const pat = note('c3').add(vel('-0.3')).mul(vel(2));
  near(velsHeard(pat), [1.4]);
  assert.deepEqual(steps(pat)[0].pend.vel.map((e) => e.op), ['add', 'mul']);
  assert.deepEqual(pat.noteChannels.vel.pending.map((e) => e.op), ['add', 'mul']);
});

test('the single-operand forms are untouched', () => {
  assert.deepEqual(values(note('c3').add(note('0,12'))), [60, 72]);
  assert.deepEqual(values(note('c3').add(2)), [62]);
  assert.deepEqual(values(note('c3 e3').mul(vel(2))), [60, 64], 'a bare control still aims at its channel');
  assert.deepEqual(velsHeard(note('c3 e3').mul(vel(2))), [2, 2]);
  assert.deepEqual(values(note('c3').set(add(2))), [62], 'a wrapped plain value is that verb');
});

// ---------------------------------------------------------------------------------------------
// Layers: pitch and velocity in every combination of set and combine
// ---------------------------------------------------------------------------------------------

test('set pitch, set velocity', () => {
  const pat = note('c3 e3').set(note(60), note(72).vel(0.7));
  assert.deepEqual(values(pat), [60, 72, 60, 72]);
  assert.deepEqual(vels(pat), [undefined, 0.7, undefined, 0.7]);
  assert.deepEqual(spans(pat), [[0, 0.5], [0, 0.5], [0.5, 1], [0.5, 1]], 'the layers sound together, on the incoming grid');
});

test('add pitch, set velocity', () => {
  const pat = note('c3 e3').vel(0.2).add(note(0), note(12).set(vel(0.7)));
  assert.deepEqual(values(pat), [60, 72, 64, 76]);
  assert.deepEqual(vels(pat), [undefined, 0.7, undefined, 0.7], 'the root keeps the track velocity, the octave is pinned');
});

test('set pitch, add velocity', () => {
  const pat = note('c3 e3').vel(0.9).set(note(60), note(72).add(vel(-0.3)));
  assert.deepEqual(values(pat), [60, 72, 60, 72]);
  near(vels(pat), [undefined, 0.6, undefined, 0.6]);
});

test('add pitch, multiply velocity - against the velocity each event really has', () => {
  const pat = note('c3 e3').vel('0.9 0.5').add(note(0), note(12).mul(vel(0.5)));
  assert.deepEqual(values(pat), [60, 72, 64, 76]);
  near(vels(pat), [0.9, 0.45, 0.5, 0.25]);
});

test('the binop is the verb of every bare piece in the layer', () => {
  near(vels(note('c3').vel(0.2).add(note(12).vel(0.7))), [0.9], 'under .add() a bare .vel(0.7) is 0.7 louder');
  near(vels(note('c3').vel(0.2).set(note(12).vel(0.7))), [0.7], 'under .set() it is exactly 0.7');
  near(vels(note('c3').vel(0.2).add(note(12).set(vel(0.7)))), [0.7], 'a verb said inside the layer overrides the binop\'s');
  near(vels(note('c3').vel(0.2).set(note(12).add(vel(0.1)))), [0.3]);
  assert.deepEqual(values(note('c3 e3').set(note(30), add(note(2)))), [30, 62, 30, 66], 'a wrapper does the same for the layer\'s own values');
});

test('the worked example: pin one voice, shift and scale the other', () => {
  const pat = note('c3').s('bd').vel(0.5).add(note(0).set(vel(0.3).clip(0.5)), note(2).speed(0.05).mul(vel(1.3)));
  assert.deepEqual(values(pat), ['bd', 'bd']);
  assert.deepEqual(cfgs(pat).map((c) => c.note), [60, 62]);
  near(vels(pat), [0.3, 0.65]);
  assert.deepEqual(clips(pat), [0.5, undefined]);
  near(cfgs(pat).map((c) => c.speed), [undefined, 1.05]);
});

test('a bare control can take the time and length controls, so a pinned pair reads as one piece', () => {
  const piece = vel(0.3).clip(0.5);
  assert.equal(piece.ctl, 'vel');
  const pat = note('c3').set(piece);
  assert.deepEqual(vels(pat), [0.3]);
  assert.deepEqual(clips(pat), [0.5]);
});

// ---------------------------------------------------------------------------------------------
// Pieces read as operands do: grids cut, rests silence, stacks fan out, pairs stay paired
// ---------------------------------------------------------------------------------------------

test('a patterned piece cuts the event where it changes', () => {
  const pat = note('c3').set(add(note('0 7')).vel(0.5));
  assert.deepEqual(values(pat), [60, 67]);
  assert.deepEqual(vels(pat), [0.5, 0.5]);
  assert.deepEqual(spans(pat), [[0, 0.5], [0.5, 1]]);
});

test('a rest in a piece silences that span and keeps the grid', () => {
  const pat = note('c3').set(note('30 ~'));
  assert.deepEqual(values(pat), [30, null]);
  assert.deepEqual(spans(pat), [[0, 0.5], [0.5, 1]]);
});

test('a stack inside a piece sounds every layer, and a chord on the left cross-products', () => {
  assert.deepEqual(values(note('c3').set(note('30,37').vel(0.5))), [30, 37]);
  assert.deepEqual(vels(note('c3').set(note('30,37').vel(0.5))), [0.5, 0.5]);
  assert.deepEqual(values(note('c3,e3').set(add(note('0,12')))), [60, 72, 64, 76]);
});

test('values paired on a token stay paired: an .as() layer is one event per token', () => {
  const roll = mini('[60:1,64:0.5]').as('note:vel');
  const pinned = note('c3').vel(0.5).set(roll);
  assert.deepEqual(values(pinned), [60, 64]);
  assert.deepEqual(vels(pinned), [1, 0.5]);
  const shifted = note('c3').vel(0.5).add(roll);
  assert.deepEqual(values(shifted), [120, 124], 'under .add() the pitches add');
  near(vels(shifted), [1.5, 1], 'and so do the velocities');
});

test('a merged event continues only where every side continues', () => {
  const pat = note('c3').set(add(note('[0 7],12')));
  assert.deepEqual(values(pat), [60, 72, 67, 72]);
  assert.deepEqual(steps(pat).map((x) => !!x.cont), [false, false, false, true], 'only the held 12 continues into the second half');
});

test('every fanned event lights both the incoming atom and the layer\'s', () => {
  const pat = note('c3').set(note('30'), note('32'));
  for (const x of steps(pat)) assert.ok(stepLocs(x).length >= 2, JSON.stringify(stepLocs(x)));
});

// ---------------------------------------------------------------------------------------------
// Scale degrees, samplers, head controls, live sources, kinds
// ---------------------------------------------------------------------------------------------

test('a layer of degrees steps in the scale, as .add(n(2)) does', () => {
  const inKey = note('c3 e3').scale('c major');
  assert.deepEqual(values(inKey.set(add(n(2)))), values(inKey.add(n(2))));
  assert.deepEqual(values(inKey.set(add(n(2)))), [64, 67]);
  assert.deepEqual(values(inKey.set(add(note(2)))), [62, 66], 'a layer of notes is semitones');
});

test('on a sampler the pitch lands on the repitch note and a sound piece swaps the sample', () => {
  const pat = s('bd').set(s('hh').speed(2), add(note(7)));
  assert.deepEqual(values(pat), ['hh', 'bd']);
  assert.deepEqual(cfgs(pat), [{ speed: 2 }, { note: 67 }], 'the hat plays as recorded at double speed; the kick is repitched a fifth up');
});

test('a sound piece on a synth pattern is skipped with a warning', () => {
  const said = warnings();
  const pat = note('c3').set(s('hh'));
  assert.deepEqual(values(pat), [60]);
  assert.match(said.join('\n'), /sound layer .* sampler/);
});

test('a control in head position keeps its channel and takes the layer on its trigger', () => {
  const pat = vel('1 0.5').set(add(note(2)));
  assert.deepEqual(values(pat), [62, 62]);
  assert.deepEqual(vels(pat), [1, 0.5]);
});

test('a live source warns and plays unchanged', () => {
  const said = warnings();
  const live = midi('keys');
  assert.equal(live.set(note(30).vel(1)), live);
  assert.match(said.join('\n'), /live source/);
});

test('the pitch kind follows what the layers set, else what came in', () => {
  assert.equal(n('0 1').set(note(60)).pitchKind, 'note');
  assert.equal(note('c3').set(n(2)).pitchKind, 'degree');
  assert.equal(note('c3').add(n(2).vel(1)).pitchKind, 'note', 'a combine keeps the incoming kind');
});

test('no layers is an error, and a layer needs events to edit', () => {
  assert.throws(() => note('c3').set(), /one or more/);
  assert.throws(() => vel(0.5).mul(2).set(note(30).vel(1)), /step pattern/);
});

test('sub/mul/div/mod are layer verbs too, as binops and as wrappers', () => {
  assert.deepEqual(values(note('c3').sub(note(12).vel(0.1))), [48]);
  near(vels(note('c3').vel(0.5).sub(note(12).vel(0.1))), [0.4]);
  near(clips(note('c3').set(note(60), mul(clip(2)))), [undefined, 2]);
  assert.deepEqual(values(note('c3').set(note(60).clip(2)).set(sub(note(12)))), [48]);
});

// ---------------------------------------------------------------------------------------------
// What the scheduler actually plays
// ---------------------------------------------------------------------------------------------

function play(sig) {
  const calls = [];
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : (...args) => calls.push({ method: p, args })) });
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, 1);
  return (method) => calls.filter((c) => c.method === method);
}

test('the scheduler fires every layer as its own note, at the velocity its layer said', () => {
  const ons = play(note('c3').vel(0.5).add(note(0).set(vel(0.3)), note(12).mul(vel(0.5))))('noteOn');
  assert.deepEqual(ons.map((c) => c.args[1]), [60, 72]);
  near(ons.map((c) => c.args[2]), [0.3, 0.25]);
});

test('the scheduler fires a layered sampler with each layer\'s own config', () => {
  const played = play(s('bd').set(s('hh').speed(2), add(note(7))))('playSample');
  assert.deepEqual(played.map((c) => c.args[2].speed), [2, undefined]);
  assert.deepEqual(played.map((c) => c.args[2].note), [undefined, 67]);
});
