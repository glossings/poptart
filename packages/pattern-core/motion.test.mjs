// .record() on a live control records its movement and loops it (see src/motion.mjs); on a track
// it is still the audio recording marker it always was.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from './src/index.mjs';

const {
  Sig, note, synth, midicc, macro, setMacro, feedMidiCC, _input, _shape, beginWidgets, takeWidgets, setWidgetValue,
  createMotionRecorder, motionWindow, takePoints, takeMotionTakes, releaseWidget, withLiveReads,
  parseShapePoints, sampleShape, lookupShape, clearRolls, injectLocations, findRecordCalls, recordCallEdits,
  recordTakeName, recordTakeEdit, setPatternWarn, Scheduler,
} = core;

const CPS = 0.5;
const at = (sig, pos) => sig.sample(pos / CPS, CPS, pos);
const poll = (sig, pos) => withLiveReads(() => at(sig, pos));
const shapeAt = (shape, pos, cycles) => sampleShape(parseShapePoints(shape), (((pos % cycles) + cycles) % cycles) / cycles);
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

function quiet(fn) {
  const said = [];
  setPatternWarn((m) => said.push(m));
  try {
    return { out: fn(), said };
  } finally {
    setPatternWarn(null);
  }
}

// ------------------------------------------------------------------------------- the window

test('a take lies on cycle boundaries: the cycle the movement starts in, or the end of a long one', () => {
  assert.deepEqual(motionWindow(5.4, 5.8, 2), { start: 5, end: 7 }, 'a short movement starts its own cycle');
  assert.deepEqual(motionWindow(5.4, 6.9, 2), { start: 5, end: 7 });
  assert.deepEqual(motionWindow(5.4, 7.1, 2), { start: 6, end: 8 }, 'a long one keeps its last cycles');
  assert.deepEqual(motionWindow(3.2, 3.6, 1), { start: 3, end: 4 });
  assert.deepEqual(motionWindow(3.3, 3.4, 0.5), { start: 3, end: 3.5 }, 'shorter than a cycle: on multiples of itself');
});

// ------------------------------------------------------------------------------- the recorder

// A knob held at 0.2, swept to 0.8 between 5.3 and 5.8, then left there - polled every 0.05.
function sweep(r, { from = 5, to = 8, release = null } = {}) {
  const takes = [];
  for (let p = from; p < to - 1e-9; p += 0.05) {
    const pos = Math.round(p * 1000) / 1000;
    const v = pos < 5.3 ? 0.2 : pos < 5.8 ? 0.2 + (pos - 5.3) * 1.2 : 0.8;
    if (release !== null && Math.abs(pos - release) < 1e-6) r.release();
    const t = r.observe(pos, [v]);
    if (t) takes.push({ pos, t });
  }
  return takes;
}

test('a movement becomes a take that loops in step with the cycles it was played on', () => {
  const r = createMotionRecorder({ cycles: 2 });
  const takes = sweep(r);
  assert.equal(takes.length, 1);
  close(takes[0].pos, 6.8, 1e-6); // a cycle without movement ends it
  const { shapes, start, cycles } = takes[0].t;
  assert.equal(start, 5);
  assert.equal(cycles, 2);
  const s = shapes[0];
  close(shapeAt(s, 5.1, 2), 0.2); // what it was before the hand arrived
  close(shapeAt(s, 5.55, 2), 0.5); // halfway through the sweep
  close(shapeAt(s, 6.5, 2), 0.8); // where it was left
  close(shapeAt(s, 7.1, 2), 0.2); // the next pass starts on the cycle boundary, from the top
  close(shapeAt(s, 9.55, 2), 0.5);
  assert.ok(s.split(' ').length < 10, `a held stretch is a line, not a poll's worth of points: ${s}`);
});

test('letting go ends the take at once', () => {
  const r = createMotionRecorder({ cycles: 2 });
  const takes = sweep(r, { release: 5.85 });
  assert.equal(takes.length, 1);
  close(takes[0].pos, 5.85, 1e-6);
  close(shapeAt(takes[0].t.shapes[0], 5.55, 2), 0.5);
  assert.equal(r.recording, false);
});

test('a take that does not start on a multiple of its length wraps, and still plays in step', () => {
  const r = createMotionRecorder({ cycles: 2 });
  // Moves through cycle 6 only: the window is [6, 8), which phase 0 reads from 8 = 0 mod 2.
  let take = null;
  for (let p = 5.0; p < 9.5; p += 0.05) {
    const pos = Math.round(p * 1000) / 1000;
    const v = pos < 6.2 ? 0.1 : pos < 6.6 ? 0.1 + (pos - 6.2) * 2 : 0.9;
    take = r.observe(pos, [v]) ?? take;
  }
  assert.equal(take.start, 6);
  close(shapeAt(take.shapes[0], 6.1, 2), 0.1);
  close(shapeAt(take.shapes[0], 6.4, 2), 0.5);
  close(shapeAt(take.shapes[0], 7.5, 2), 0.9);
  close(shapeAt(take.shapes[0], 8.1, 2), 0.1, 0.02); // loops from the window's start at 8
  close(shapeAt(take.shapes[0], 10.4, 2), 0.5);
});

test('values are measured against the control\'s range, and the clock going back drops a take in progress', () => {
  const pts = takePoints([[0, 200], [0.5, 1100], [1, 2000]], 0, 1, [200, 2000]);
  close(sampleShape(pts, 0.5), 0.5);
  const r = createMotionRecorder({ cycles: 1 });
  r.observe(3, [0]);
  r.observe(3.1, [0.5]);
  assert.equal(r.recording, true);
  assert.equal(r.observe(1, [0.5]), null);
  assert.equal(r.recording, false);
});

// ------------------------------------------------------------------------------- on a control

function evalKnob(code = { at: 10, rec: 30 }, opts = { cycles: 2 }) {
  beginWidgets('a');
  const sig = _input([code.at, -1], 'knob', 0.2, 0, 1)._record(code.rec, opts);
  takeWidgets();
  return sig;
}

test('a knob records while it moves, hands the take to the editor, and plays it back', () => {
  takeMotionTakes();
  const sig = evalKnob();
  for (let p = 5; p < 5.3; p += 0.05) assert.equal(poll(sig, p), 0.2);
  // A drag, then the hand lets go.
  const steps = [[5.3, 0.3], [5.4, 0.5], [5.5, 0.7], [5.6, 0.8]];
  for (const [pos, v] of steps) {
    setWidgetValue('a', 10, v);
    assert.equal(poll(sig, pos), v, 'what moves is heard while it moves');
  }
  assert.equal(releaseWidget('a', 10), true);
  poll(sig, 5.65);
  const out = takeMotionTakes();
  assert.equal(out.length, 1);
  assert.equal(out[0].deck, 'a');
  assert.equal(out[0].at, 30, 'the take knows which .record( call made it');
  assert.equal(out[0].take, null);
  assert.deepEqual(out[0].axes, ['']);
  assert.equal(out[0].cycles, 2);
  close(at(sig, 7.1), 0.2, 0.02); // the loop, not the knob left at 0.8
  close(at(sig, 7.4), 0.5, 0.05);
});

test('only the scheduler\'s polls record: a display reading the control changes nothing', () => {
  takeMotionTakes();
  const sig = evalKnob({ at: 50, rec: 70 });
  at(sig, 1);
  setWidgetValue('a', 50, 0.9);
  at(sig, 1.1);
  at(sig, 3);
  assert.equal(takeMotionTakes().length, 0);
  assert.equal(at(sig, 3.5), 0.9);
});

test('touching the control again replaces the take', () => {
  takeMotionTakes();
  const sig = evalKnob({ at: 90, rec: 110 });
  poll(sig, 1);
  setWidgetValue('a', 90, 1);
  poll(sig, 1.2);
  releaseWidget('a', 90);
  poll(sig, 1.25);
  const [first] = takeMotionTakes();
  close(at(sig, 3.5), 1);
  setWidgetValue('a', 90, 0);
  assert.equal(poll(sig, 4.2), 0, 'a new movement is heard, not the old take');
  releaseWidget('a', 90);
  poll(sig, 4.25);
  const [second] = takeMotionTakes();
  assert.notEqual(second.shapes[0], first.shapes[0]);
  close(at(sig, 6.5), 0, 0.01);
  close(shapeAt(second.shapes[0], 6.5, 2), 0);
});

test('a take named in the call plays from its stored shape, scaled to the control', () => {
  clearRolls();
  const stored = '0,0 0.5,1 1,0';
  beginWidgets('a');
  _shape('lead-take', stored);
  const sig = _input([200, -1], 'knob', 300, 100, 500)._record(220, { cycles: 2, take: 'lead-take' });
  takeWidgets();
  assert.deepEqual(lookupShape('lead-take'), parseShapePoints(stored));
  close(at(sig, 0), 100);
  close(at(sig, 1), 500);
  close(at(sig, 3), 500);
  close(at(sig, 1.5), 300);
});

test('a take is stored as the text it plays: a round trip through a definition sounds the same', () => {
  clearRolls();
  takeMotionTakes();
  const sig = evalKnob({ at: 300, rec: 320 });
  poll(sig, 2);
  for (const [pos, v] of [[2.2, 0.4], [2.35, 0.9], [2.5, 0.6]]) {
    setWidgetValue('a', 300, v);
    poll(sig, pos);
  }
  releaseWidget('a', 300);
  poll(sig, 2.55);
  const [take] = takeMotionTakes();
  beginWidgets('a');
  _shape('again', take.shapes[0]);
  const reloaded = _input([300, -1], 'knob', 0.6, 0, 1)._record(320, { cycles: 2, take: 'again' });
  takeWidgets();
  for (let p = 2; p < 6; p += 0.125) close(at(reloaded, p), at(sig, p), 1e-9);
});

test('a take naming a shape nobody defines warns and plays the control', () => {
  clearRolls();
  const { out: sig, said } = quiet(() => {
    beginWidgets('a');
    const s = _input([400, -1], 'knob', 0.3)._record(420, { take: 'gone' });
    takeWidgets();
    return s;
  });
  const { out: v, said: more } = quiet(() => at(sig, 1));
  assert.equal(v, 0.3);
  assert.equal(said.length + more.length, 1);
  assert.match(more[0], /no shape called "gone"/);
});

test('an xy pad records both axes into one take of two shapes', () => {
  takeMotionTakes();
  beginWidgets('a');
  const pad = _input([500, -1], 'xy', 0.5, 0.5)._record(520, { cycles: 1 });
  takeWidgets();
  poll(pad, 3);
  setWidgetValue('a', 500, [0.9, 0.1]);
  poll(pad.y, 3.2);
  releaseWidget('a', 500);
  poll(pad, 3.25);
  const [take] = takeMotionTakes();
  assert.deepEqual(take.axes, ['-x', '-y']);
  assert.equal(take.shapes.length, 2);
  close(at(pad.x, 4.5), 0.9);
  close(at(pad.y, 4.5), 0.1);
  close(at(pad, 4.05), 0.5, 0.1);
});

test('midicc(), osc() and macro() record too; without a release a cycle of stillness ends the take', () => {
  takeMotionTakes();
  const cc = midicc('Twister')(12).range(100, 300).record({ cycles: 1 });
  feedMidiCC('Midi Fighter Twister', 1, 12, 0);
  poll(cc, 1);
  feedMidiCC('Midi Fighter Twister', 1, 12, 1);
  assert.equal(poll(cc, 1.4), 300);
  poll(cc, 2.3);
  assert.equal(takeMotionTakes().length, 0, 'still recording: less than a cycle without a move');
  poll(cc, 2.45);
  const [take] = takeMotionTakes();
  assert.equal(take.at, null, 'untranspiled: no call to write into, and it still plays');
  close(shapeAt(take.shapes[0], 1.0, 1), 0); // polled at 1 and 1.4: a straight line between
  close(shapeAt(take.shapes[0], 1.6, 1), 1);
  close(at(cc, 3.6), 300);

  setMacro(3, 0.25);
  const m = macro(3).record({ cycles: 1 });
  poll(m, 1);
  setMacro(3, 0.75);
  poll(m, 1.5);
  poll(m, 2.6);
  assert.equal(takeMotionTakes().length, 1);
  close(at(m, 7), 0.25);
  close(at(m, 7.7), 0.75);
  assert.ok(core.osc('/1/fader').record() instanceof Sig);
});

test('the scheduler\'s parameter poll is what records', () => {
  takeMotionTakes();
  const sig = evalKnob({ at: 600, rec: 620 }, { cycles: 1 });
  const engine = new Proxy({ getTime: () => 0 }, { get: (t, p) => (p in t ? t[p] : () => {}) });
  const sched = new Scheduler(engine, { trackId: 't' });
  sched.setPattern(synth('W').param('A', sig));
  sched._pollGenericParams(0);
  setWidgetValue('a', 600, 0.9);
  sched._pollGenericParams(0.1);
  releaseWidget('a', 600);
  sched._pollGenericParams(0.2);
  assert.equal(takeMotionTakes().length, 1);
});

// ------------------------------------------------------------------------------- the code

test('the transpile tags every .record( call with where it is, and leaves a track\'s alone otherwise', () => {
  const code = 'a: note("c").record({ cycles: 8 })\n  .param("x", knob(0.5).record())';
  assert.deepEqual(findRecordCalls(code).map((c) => c.at), [code.indexOf('record'), code.lastIndexOf('record')]);
  assert.deepEqual(findRecordCalls('record(1) // x.record(2)\n"y.record(3)" z.rerecord(4)'), []);
  const out = injectLocations(code, 100);
  assert.match(out, new RegExp(`\\._record\\(${100 + code.indexOf('record')}, \\{ cycles: 8 \\}\\)`));
  assert.match(out, new RegExp(`_input\\(\\[\\d+, -1\\], 'knob', 0\\.5\\)\\._record\\(${100 + code.lastIndexOf('record')}, \\)`));
  assert.equal(recordCallEdits(code).length, 2);
});

test('a take is written into its call: added, or renamed in place', () => {
  const edit = (src, name) => {
    const open = src.indexOf('(', src.indexOf('record'));
    const e = recordTakeEdit(src, open, name);
    return src.slice(0, e.from) + e.text + src.slice(e.to);
  };
  assert.equal(edit('k.record({ cycles: 2 })', 'lead-take'), 'k.record({ cycles: 2, take: "lead-take" })');
  assert.equal(edit('k.record({ cycles: 2, })', 'x'), 'k.record({ cycles: 2, take: "x" })');
  assert.equal(edit('k.record()', 'x'), 'k.record({ take: "x" })');
  assert.equal(edit('k.record(2)', 'x'), 'k.record({ cycles: 2, take: "x" })');
  assert.equal(edit("k.record({ take: 'old', cycles: 2 })", 'new'), "k.record({ take: 'new', cycles: 2 })");
  assert.equal(recordTakeName('k.record({ cycles: 2, take: "lead" })', 8), 'lead');
  assert.equal(recordTakeName('k.record({ cycles: 2 })', 8), null);
});

// ------------------------------------------------------------------------------- on a track

test('.record() on a track is the audio recording marker it always was', () => {
  const t = synth('W').record({ cycles: 8, name: 'bass' });
  assert.deepEqual(t.recordOpts, { cycles: 8, name: 'bass', wrapTail: false, normalize: true });
  assert.deepEqual(note('c').record(3).recordOpts, { cycles: 3, name: null, wrapTail: false, normalize: true });
  assert.deepEqual(note('c')._record(42, { cycles: 2, wrapTail: true }).recordOpts, { cycles: 2, name: null, wrapTail: true, normalize: true });
  assert.throws(() => note('c').record({ cycles: 0 }), /cycles must be a positive number/);
  assert.throws(() => note('c')._record(1, 'x'), /takes options/);
  const sig = note('c3 e3');
  assert.deepEqual(sig.record({ cycles: 4 }).stepsForCycle(0), sig.stepsForCycle(0), 'it changes nothing about the sound');
});
