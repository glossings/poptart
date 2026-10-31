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
  const { out: probed, said: silent } = quiet(() => at(sig, 1));
  assert.equal(probed, 0.3);
  assert.deepEqual(silent, [], 'a build-time probe is not a poll: the shape may be defined further down');
  const { out: v, said: more } = quiet(() => poll(sig, 1));
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

// ------------------------------------------------------------------------------- capture

const { captureMotion, clearCaptureHistory } = core;

// Polls `sig` from `from` to `to` every 0.05 cycles, setting the control at `at` to `move(pos)`
// first wherever that says a value.
function play(sig, at, from, to, move = () => undefined, deck = 'a') {
  for (let p = from; p < to - 1e-9; p += 0.05) {
    const pos = Math.round(p * 1000) / 1000;
    const v = move(pos);
    if (v !== undefined) setWidgetValue(deck, at, v);
    poll(sig, pos);
  }
}

test('capture: a knob without .record() keeps its movement, and capture makes it a take', () => {
  clearCaptureHistory();
  beginWidgets('a');
  const sig = _input([1000, -1], 'knob', 300, 100, 500);
  takeWidgets();
  // Held at 300, swept to 500 through cycle 9, then left there for a phrase.
  play(sig, 1000, 8, 14, (p) => (p >= 9 && p < 9.5 ? 300 + (p - 9) * 400 : p >= 9.5 ? 500 : undefined));
  const takes = captureMotion();
  assert.equal(takes.length, 1);
  const [t] = takes;
  assert.equal(t.deck, 'a');
  assert.equal(t.at, 1000);
  assert.equal(t.kind, 'knob');
  assert.deepEqual(t.axes, ['']);
  assert.equal(t.cycles, 1, 'the movement fits a cycle');
  // In the shape's 0..1 against the knob's 100..500: 300 is 0.5, 500 is 1.
  close(shapeAt(t.shapes[0], 9.0, 1), 0.5, 0.02);
  close(shapeAt(t.shapes[0], 9.25, 1), 0.75, 0.05);
  close(shapeAt(t.shapes[0], 9.9, 1), 1, 0.02);
});

test('capture: everything moved in the latest phrase shares one window; an older phrase is not in it', () => {
  clearCaptureHistory();
  beginWidgets('a');
  const old = _input([1100, -1], 'knob', 0.5);
  const a = _input([1120, -1], 'slider', 0.5);
  const b = _input([1140, -1], 'toggle', 0);
  takeWidgets();
  const all = { sample: (t, cps, pos) => [old, a, b].map((s) => s.sample(t, cps, pos)) };
  // The knob moves at cycle 2; then ten still cycles; then the slider at 12.2 and the toggle at 14.6.
  play(all, null, 0, 20, (p) => {
    if (Math.abs(p - 2.2) < 1e-6) setWidgetValue('a', 1100, 0.1);
    if (Math.abs(p - 12.2) < 1e-6) setWidgetValue('a', 1120, 0.9);
    if (Math.abs(p - 14.6) < 1e-6) setWidgetValue('a', 1140, 1);
  });
  const takes = captureMotion();
  assert.deepEqual(takes.map((t) => t.at).sort(), [1120, 1140], 'the knob moved a phrase of stillness before');
  assert.deepEqual(new Set(takes.map((t) => t.cycles)), new Set([3]), 'one length for the phrase: 12.2 to 14.6 is cycles 12-15');
});

test('capture: a control that records itself, or has left the code, is not captured', () => {
  clearCaptureHistory();
  takeMotionTakes();
  beginWidgets('a');
  const rec = _input([1200, -1], 'knob', 0.2)._record(1220, { cycles: 1 });
  const gone = _input([1240, -1], 'knob', 0.2);
  takeWidgets();
  play({ sample: (t, c, p) => [rec.sample(t, c, p), gone.sample(t, c, p)] }, 1200, 3, 6, (p) => (p >= 3.5 && p < 3.6 ? 0.9 : undefined));
  setWidgetValue('a', 1240, 0.7);
  play(gone, 1240, 6, 7);
  takeMotionTakes();
  beginWidgets('a');
  const kept = _input([1200, -1], 'knob', 0.2)._record(1220, { cycles: 1 });
  takeWidgets(); // 1240 is gone from the code
  assert.ok(kept);
  assert.deepEqual(captureMotion(), []);
});

test('capture: an xy pad is one take of two shapes; each deck has its own', () => {
  clearCaptureHistory();
  beginWidgets('b');
  const pad = _input([1300, -1], 'xy', 0.5, 0.5);
  takeWidgets();
  play(pad.y, 1300, 2, 8, (p) => (Math.abs(p - 2.5) < 1e-6 ? [0.9, 0.1] : undefined), 'b');
  const [t, ...rest] = captureMotion();
  assert.equal(rest.length, 0);
  assert.equal(t.deck, 'b');
  assert.deepEqual(t.axes, ['-x', '-y']);
  close(shapeAt(t.shapes[0], 2.75, 1), 0.9);
  close(shapeAt(t.shapes[1], 2.75, 1), 0.1);
  close(shapeAt(t.shapes[0], 2.25, 1), 0.5);
});

test('capture: the clock going back forgets what was kept', () => {
  clearCaptureHistory();
  beginWidgets('a');
  const sig = _input([1400, -1], 'knob', 0.2);
  takeWidgets();
  play(sig, 1400, 5, 6, (p) => (Math.abs(p - 5.5) < 1e-6 ? 0.8 : undefined));
  poll(sig, 0);
  assert.deepEqual(captureMotion(), []);
});

// A host clock for the sources: `sec` is set by hand, and cycles are seconds on deck A's clock
// (0.5 cps, started at 0) and nowhere on deck B (stopped) unless said otherwise.
const { setMotionClock, feedOsc, _at, sourceCalls } = core;
let sec = 0;
const decks = { a: (s) => s * CPS, b: () => null };
const useClock = () => setMotionClock({ now: () => sec, cycleAt: (deck, s) => decks[deck](s) });

test('capture: a MIDI CC is kept as it arrives and lands on every place in the code that reads it', () => {
  clearCaptureHistory();
  useClock();
  beginWidgets('a');
  const cc = midicc('Twister');
  _at(2000, cc(12, 1)).range(100, 300);
  _at(2040, cc(12)); // any channel
  _at(2080, cc(13)); // another knob - not moved
  _at(2120, macro(2));
  takeWidgets();
  assert.deepEqual(sourceCalls('a').map((s) => s.at), [2000, 2040, 2080, 2120]);
  // At 0.5 cps: cycle 10 is 20 s. A sweep from 0 to 1 over cycle 10.0 - 10.5, then still.
  sec = 2; feedMidiCC('Midi Fighter Twister', 1, 12, 0);
  for (let i = 0; i <= 10; i++) { sec = 20 + i * 0.1; feedMidiCC('Midi Fighter Twister', 1, 12, i / 10); }
  sec = 30;
  const takes = captureMotion();
  assert.deepEqual(takes.map((t) => [t.deck, t.at, t.kind, t.source, t.cycles]), [['a', 2000, 'cc', true, 1], ['a', 2040, 'cc', true, 1]]);
  close(shapeAt(takes[0].shapes[0], 10.0, 1), 0, 0.02);
  close(shapeAt(takes[0].shapes[0], 10.25, 1), 0.5, 0.05);
  close(shapeAt(takes[0].shapes[0], 10.9, 1), 1, 0.02);
  assert.equal(takes[1].shapes[0], takes[0].shapes[0], 'the same movement, wherever it is read');
});

test('capture: an OSC value and a macro knob too, in one window with a drawn control that moved', () => {
  clearCaptureHistory();
  useClock();
  beginWidgets('a');
  _at(2200, core.osc('/1/fader3'));
  _at(2240, core.osc('/xy', 1));
  _at(2280, macro(4));
  const knob = _input([2320, -1], 'knob', 0.5);
  takeWidgets();
  sec = 40; feedOsc('/1/fader3', [0.2]); feedOsc('/xy', [0.5, 0.5]); setMacro(4, 0.1);
  sec = 41; feedOsc('/1/fader3', [0.9]); // cycle 20.5
  sec = 43; feedOsc('/xy', [0.5, 0.8]); // cycle 21.5, the second value
  sec = 44.5; setMacro(4, 0.6); // cycle 22.25
  // The knob, from the scheduler's polls, at cycles 22.5 - 23.
  play(knob, 2320, 22, 24, (p) => (Math.abs(p - 22.5) < 1e-6 ? 0.9 : undefined));
  sec = 50;
  const takes = captureMotion();
  assert.deepEqual(takes.map((t) => [t.at, t.kind, t.source]).sort((x, y) => x[0] - y[0]), [[2200, 'osc', true], [2240, 'osc', true], [2280, 'macro', true], [2320, 'knob', false]]);
  assert.deepEqual(new Set(takes.map((t) => t.cycles)), new Set([3]), 'one window, cycles 20-23, for all of them');
  const of = (at) => takes.find((t) => t.at === at).shapes[0];
  // A source holds its value until its next message: still at 20.4, stepped by 20.6.
  close(shapeAt(of(2200), 20.4, 3), 0.2); close(shapeAt(of(2200), 20.6, 3), 0.9);
  close(shapeAt(of(2240), 21.4, 3), 0.5); close(shapeAt(of(2240), 21.6, 3), 0.8);
  close(shapeAt(of(2280), 22.2, 3), 0.1); close(shapeAt(of(2280), 22.3, 3), 0.6);
  close(shapeAt(of(2320), 22.9, 3), 0.9);
});

test('capture: a source read on a stopped deck, or read by nobody, makes no take', () => {
  clearCaptureHistory();
  useClock();
  beginWidgets('b');
  _at(2400, macro(5));
  takeWidgets();
  sec = 60; setMacro(5, 0.2);
  sec = 61; setMacro(5, 0.9);
  setMacro(6, 0.9); // read nowhere
  assert.deepEqual(captureMotion(), []);
  decks.b = (s) => s * CPS;
  const [take] = captureMotion();
  assert.equal(take.deck, 'b');
  assert.equal(take.at, 2400);
  decks.b = () => null;
  setMotionClock(null);
});

test('a knob on a curve records its position along it, and plays the take back through it', () => {
  takeMotionTakes();
  clearCaptureHistory();
  beginWidgets('a');
  const sig = _input([3000, -1], 'knob', 20, 20, 20000, { curve: 'exp' })._record(3020, { cycles: 1 });
  const plain = _input([3040, -1], 'knob', 20, 20, 20000, { curve: 'exp' });
  takeWidgets();
  poll(sig, 5); poll(plain, 5);
  poll(sig, 5.45); poll(plain, 5.45);
  setWidgetValue('a', 3000, 2000); // position 2/3
  setWidgetValue('a', 3040, 2000);
  poll(sig, 5.5); poll(plain, 5.5);
  releaseWidget('a', 3000);
  poll(sig, 5.55); poll(plain, 5.55);
  const [take] = takeMotionTakes();
  close(shapeAt(take.shapes[0], 5.9, 1), 2 / 3, 0.01);
  close(at(sig, 6.9), 2000, 20); // the loop plays back through the curve
  close(at(sig, 6.1), 20, 1);
  // The header's capture of the plain one: the same position space.
  poll(plain, 9.5);
  const [cap] = captureMotion();
  assert.equal(cap.at, 3040);
  close(shapeAt(cap.shapes[0], 5.9, 1), 2 / 3, 0.01);
});

test('capture: a device control moved by hand comes back as a param take, with its range and curve', () => {
  clearCaptureHistory();
  useClock();
  const { feedParamMove } = core;
  const cutoff = { deck: 'a', trackId: 'pad', slot: 1, id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, curve: 'exp', curveExp: null, step: null, widget: 'knob' };
  sec = 80; feedParamMove({ ...cutoff, value: 200 }); // cycle 40, position 1/3
  sec = 81; feedParamMove({ ...cutoff, value: 2000 }); // cycle 40.5, position 2/3
  sec = 82; feedParamMove({ deck: 'b', trackId: 'b:lead', slot: 0, id: 'on', name: 'On', min: 0, max: 1, widget: 'toggle', value: 1 }); // deck B is stopped
  sec = 90;
  const takes = captureMotion();
  assert.equal(takes.length, 1);
  const [t] = takes;
  assert.equal(t.source, 'param');
  assert.equal(t.deck, 'a');
  assert.equal(t.trackId, 'pad');
  assert.equal(t.slot, 1);
  assert.equal(t.name, 'Cutoff');
  assert.deepEqual([t.min, t.max, t.curve, t.widget, t.value], [20, 20000, 'exp', 'knob', 2000]);
  close(shapeAt(t.shapes[0], 40.4, 1), 1 / 3, 0.01);
  close(shapeAt(t.shapes[0], 40.6, 1), 2 / 3, 0.01);
  setMotionClock(null);
});

test('a take named before its shape is built says nothing when probed, and plays it once it is there', () => {
  takeMotionTakes();
  const { out, said } = quiet(() => {
    beginWidgets('a');
    const sig = _input([3100, -1], 'knob', 0.2)._record(3120, { cycles: 1, take: 'later' });
    takeWidgets();
    at(sig, 0); // a build-time probe, as .param() makes to see whether a value is steady
    _shape('later', '0,1 1,1');
    return sig;
  });
  assert.deepEqual(said, []);
  close(poll(out, 2.5), 1, 0.01);
  const { said: polled } = quiet(() => poll(_input([3140, -1], 'knob', 0.2)._record(3160, { take: 'never' }), 1));
  assert.equal(polled.length, 1, 'a poll that finds no shape still says so');
});

test('a recording control reports what its take is playing, for the editor to draw it there', () => {
  takeMotionTakes();
  clearCaptureHistory();
  beginWidgets('a');
  const sig = _input([3200, -1], 'knob', 0.2)._record(3220, { cycles: 1 });
  const { recording } = takeWidgets();
  assert.deepEqual(recording, [3200], 'the report names the control, not the .record( call');
  assert.deepEqual(core.motionPlaying('a'), {}, 'nothing played yet');
  poll(sig, 5); poll(sig, 5.45);
  setWidgetValue('a', 3200, 0.8);
  poll(sig, 5.5);
  assert.deepEqual(core.motionPlaying('a'), {}, 'the hand is on it');
  releaseWidget('a', 3200);
  poll(sig, 5.55);
  poll(sig, 6.7);
  const played = core.motionPlaying('a');
  assert.deepEqual(Object.keys(played), ['3200']);
  close(played[3200][0], 0.8, 0.02);
  at(sig, 6.1); // a display's read changes nothing
  close(core.motionPlaying('a')[3200][0], 0.8, 0.02);
  assert.deepEqual(core.motionPlaying('b'), {});
});

test('a touch shorter than the loop punches in: the stretch touched is overwritten, the rest of the take kept', () => {
  const { punchPoints } = core;
  const existing = parseShapePoints('0,0 0.5,0 0.5,1 1,1'); // low for the first half, high for the second
  // The hand sets 0.5 from cycle 4.2 to 4.3, over a 1-cycle loop.
  const samples = [[4.15, 0], [4.2, 0.5], [4.25, 0.5], [4.3, 0.5]];
  const out = punchPoints(existing, samples, 4.15, 4.3, 1);
  const y = (x) => sampleShape(out, x);
  close(y(0.1), 0); close(y(0.2), 0.5); close(y(0.25), 0.5); close(y(0.3), 0.5); close(y(0.4), 0); close(y(0.75), 1);
  // Wrapping the loop's end: a touch from 4.9 to 5.1 lands on 0.9..1 and 0..0.1.
  const wrap = punchPoints(existing, [[4.9, 1], [4.95, 0.5], [5.05, 0.5], [5.1, 0.5]], 4.9, 5.1, 1);
  const w = (x) => sampleShape(wrap, x);
  close(w(0.95), 0.5); close(w(0.05), 0.5); close(w(0.3), 0); close(w(0.7), 1);
});

test('through .record(): a second touch keeps the loop and overwrites what it touched; a long one replaces it', () => {
  takeMotionTakes();
  clearRolls();
  _shape('held', '0,0 0.5,0 0.5,1 1,1');
  beginWidgets('a');
  const sig = _input([3300, -1], 'knob', 0)._record(3320, { cycles: 1, take: 'held' });
  takeWidgets();
  close(poll(sig, 6.75), 1);
  // A short touch in the low half.
  poll(sig, 7.15);
  setWidgetValue('a', 3300, 0.5);
  poll(sig, 7.2); poll(sig, 7.25);
  releaseWidget('a', 3300);
  poll(sig, 7.3);
  const [take] = takeMotionTakes();
  const y = (x) => shapeAt(take.shapes[0], x, 1);
  close(y(0.05), 0); close(y(0.22), 0.5); close(y(0.4), 0); close(y(0.8), 1, 0.01);
  close(at(sig, 8.8), 1, 0.01); // the loop still has its high half
  close(at(sig, 8.22), 0.5);
  // A touch longer than the loop replaces the whole take.
  for (let p = 9; p < 10.3; p += 0.05) { setWidgetValue('a', 3300, 0.9); poll(sig, Math.round(p * 100) / 100); }
  releaseWidget('a', 3300);
  poll(sig, 10.35);
  const [whole] = takeMotionTakes();
  close(shapeAt(whole.shapes[0], 0.8, 1), 0.9); close(shapeAt(whole.shapes[0], 0.2, 1), 0.9);
});

test('capture: the window is the whole cycles the movement covers - a move from 7.2 to 9.3 is three cycles from 7', () => {
  clearCaptureHistory();
  beginWidgets('a');
  const sig = _input([3400, -1], 'knob', 0.2);
  takeWidgets();
  // Moving from 7.2 to 9.3, then still for a phrase.
  play(sig, 3400, 6, 14, (p) => (p >= 7.2 && p < 9.3 ? 0.2 + (p - 7.2) * 0.3 : undefined));
  const [t] = captureMotion();
  assert.equal(t.cycles, 3, 'cycles 7, 8 and 9');
  // The take starts at cycle 7 and loops in step: what was played at 8.2 plays at 11.2, and the
  // movement fills the take rather than a sliver of it.
  close(shapeAt(t.shapes[0], 7.2, 3), 0.2, 0.02);
  close(shapeAt(t.shapes[0], 8.2, 3), 0.5, 0.03);
  close(shapeAt(t.shapes[0], 9.3, 3), 0.83, 0.03);
  close(shapeAt(t.shapes[0], 11.2, 3), 0.5, 0.03);
});

test('a take keeps its own length: a longer .record() pads it with its last value, a shorter one cuts it', () => {
  const { fitTake, _shape, lookupShape } = core;
  clearRolls();
  _shape('three', '0,0 1,1', { cycles: 3 }); // a ramp over three cycles
  const pts = lookupShape('three', null);
  assert.equal(pts.cycles, 3);
  const padded = fitTake(pts, 4);
  close(sampleShape(padded, 0.375), 0.5); // cycle 1.5 of 4: halfway up the ramp
  close(sampleShape(padded, 0.75), 1); // the ramp ends at cycle 3...
  close(sampleShape(padded, 0.9), 1); // ...and holds through the fourth
  const cut = fitTake(pts, 2);
  close(sampleShape(cut, 0.5), 1 / 3); // cycle 1 of 2 is a third of the way up
  close(sampleShape(cut, 1), 2 / 3); // the loop ends partway through the take
  assert.equal(fitTake(pts, 3), pts, 'the same length: untouched');
  assert.equal(fitTake(parseShapePoints('0,0 1,1'), 4).cycles, undefined, 'no length of its own: the loop\'s');
  // Through .record(): the three-cycle take in a four-cycle call.
  beginWidgets('a');
  const sig = _input([3500, -1], 'knob', 0)._record(3520, { cycles: 4, take: 'three' });
  takeWidgets();
  close(poll(sig, 1.5), 0.5); close(poll(sig, 3.5), 1); close(poll(sig, 5.5), 0.5);
});
