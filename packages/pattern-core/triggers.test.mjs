// A signal or a button as a rhythm: .struct() and .advance() reading rising edges onto a grid, a
// live button's presses placed on the first step a scheduler has not sent, a recorded button take
// played back as its presses, and a key struck on a sampler track.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './src/index.mjs';

const {
  note, n, square, mini, Sig, injectLocations, beginWidgets, takeWidgets, setWidgetValue, setMotionClock,
  withPressWindow, takeMotionTakes, sampledEdges, shapeEdges, shapePulses, edgeSteps, triggerStep, createTriggerCounter,
  rowWithPress, rowEdges, rowCells, shapeAsRow, parseCells, parseShapePoints, keyStrike, Scheduler, Transport, _shape, clearRolls,
} = core;

const steps = (sig, cycle) => sig.stepsForCycle(cycle).map((st) => [st.start, st.value]);

// Evaluates a buffer the way the hosts do (see widgets.test.mjs): transpiled, every builder in
// scope, one value per line.
function evalLines(code, deck = 'a') {
  const out = injectLocations(code, 0);
  const names = Object.keys(core);
  const values = names.map((k) => core[k]);
  beginWidgets(deck);
  const lines = out.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  const sigs = lines.map((l) => new Function(...names, `return ${l.replace(/^\s*[\w$]+:\s*/, '')}`)(...values));
  return { sigs, widgets: takeWidgets() };
}

// The host's clock, by hand: one cycle a second, so a time in seconds is a cycle position.
let now = 0;
setMotionClock({ now: () => now, cycleAt: (_deck, sec) => sec });
function press(deck, at, on, off) {
  now = on;
  setWidgetValue(deck, at, 1);
  now = off;
  setWidgetValue(deck, at, 0);
}
// A scheduler's read of the window [from, to): what places a live press.
const scheduled = (from, to, fn, deck = 'a') => withPressWindow({ deck, from, to, posAt: (c) => c }, fn);

// A 0/1 signal from a list of [on, off) spans in cycles, looped every `period`.
function pulses(spans, period = 1) {
  return new Sig((t, cps, pos) => {
    const p = ((pos % period) + period) % period;
    return spans.some(([a, b]) => p >= a && p < b) ? 1 : 0;
  });
}

// ------------------------------------------------------------------------------- edges and steps

test('an edge triggers on the next step, one exactly on a step on that step', () => {
  assert.equal(triggerStep(0.25, 16), 4, 'on a step');
  assert.equal(triggerStep(0.26, 16), 5, 'just after one: the next');
  assert.equal(triggerStep(0.25003, 16), 4, 'a rounding after a step is still that step');
  assert.equal(triggerStep(0.95, 16), 16, 'late in a cycle: the first step of the next');
});

test('a 0/1 signal is a rhythm: each rise through 0.5, on the next sixteenth', () => {
  assert.deepEqual(steps(note('c3').struct(square()), 0), [[0, 60]], 'square rises once a cycle, at 0');
  const sig = pulses([[0.1, 0.3], [0.5, 0.52]]);
  assert.deepEqual(steps(note('c3').struct(sig), 0), [[0.125, 60], [0.5, 60]]);
  assert.deepEqual(steps(note('c3').struct(sig), 7), [[0.125, 60], [0.5, 60]], 'the same every cycle: seekable');
  const st = note('c3').struct(sig).stepsForCycle(0);
  assert.equal(st[0].end - st[0].start, 1 / 16, 'a trigger lasts its step');
});

test('the grid is the second argument', () => {
  const sig = pulses([[0.1, 0.3]]);
  assert.deepEqual(steps(note('c3').struct(sig, 4), 0), [[0.25, 60]]);
  assert.deepEqual(steps(note('c3').struct(sig, 8), 0), [[0.125, 60]]);
  assert.throws(() => note('c3').struct(sig, 0), /trigger grid/);
});

test('a press shorter than a step still triggers, and two in one step are one trigger', () => {
  const short = pulses([[0.3, 0.301]]);
  assert.deepEqual(steps(note('c3').struct(short), 0), [[0.3125, 60]]);
  const two = pulses([[0.26, 0.27], [0.28, 0.29]]);
  assert.deepEqual(steps(note('c3').struct(two), 0), [[0.3125, 60]]);
});

test('an edge late in a cycle lands on the first step of the next', () => {
  const late = pulses([[0.97, 0.99]], 100); // once, in cycle 0
  assert.deepEqual(steps(note('c3').struct(late), 0), []);
  assert.deepEqual(steps(note('c3').struct(late), 1), [[0, 60]]);
});

test('a signal high across the cycle boundary has no edge there', () => {
  const across = pulses([[0, 0.2], [0.9, 1]]);
  assert.deepEqual(steps(note('c3').struct(across), 3), [[0.9375, 60]]);
});

test('sampledEdges and shapeEdges find the same rises', () => {
  const points = parseShapePoints('0,0 0.25,0 0.25,1 0.3,1 0.3,0 1,0');
  assert.deepEqual(shapePulses(points), [[0.25, 0.3]]);
  assert.deepEqual(shapeEdges(points, 2, 0, 4), [0.5, 2.5]);
  const read = (pos) => (((pos % 2) + 2) % 2 >= 0.5 && ((pos % 2) + 2) % 2 < 0.6 ? 1 : 0);
  assert.deepEqual(sampledEdges(read, 0, 4, 16), [0.5, 2.5]);
  assert.deepEqual(edgeSteps([0.49, 0.5, 0.51], 0, 16), [{ start: 0.5, end: 0.5625, value: 1 }, { start: 0.5625, end: 0.625, value: 1 }]);
});

test('a step pattern still structs as it always has', () => {
  assert.deepEqual(steps(note('c3 g3').struct('1 ~ 1 1'), 0), [[0, 60], [0.5, 67], [0.75, 67]]);
});

// ------------------------------------------------------------------------------- advance

test('advance plays the next value on each trigger, round and round', () => {
  const sig = n('0 4 7').advance('1 1');
  assert.deepEqual(steps(sig, 0), [[0, 0], [0.5, 4]]);
  assert.deepEqual(steps(sig, 1), [[0, 7], [0.5, 0]], 'the count carries on across cycles');
  assert.deepEqual(steps(sig, 2), [[0, 4], [0.5, 7]]);
});

test('advance counts from cycle 0, so any cycle can be asked first', () => {
  const sig = n('0 4 7').advance(mini('1 ~ 1 1'));
  assert.deepEqual(steps(sig, 1000), [[0, 0], [0.5, 4], [0.75, 7]], '3000 triggers before it: back to the first');
  assert.deepEqual(steps(n('0 4 7').advance(mini('1 1')), 1001), [[0, 4], [0.5, 7]], '2002 before it');
  assert.deepEqual(steps(n('0 4 7').advance(mini('1 1')), -1), [[0, 4], [0.5, 7]], 'before 0 it counts back');
});

test('advance with a trigger that changes cycle by cycle counts every cycle before', () => {
  const sig = n('0 4 7').advance(mini('<1 [1 1]>'));
  // cycles 0, 1, 2 hold 1 + 2 + 1 triggers, so cycle 3 starts on the fifth
  assert.deepEqual(steps(sig, 3), [[0, 4], [0.5, 7]]);
  const fresh = n('0 4 7').advance(mini('<1 [1 1]>'));
  assert.deepEqual(steps(fresh, 3), steps(sig, 3), 'the same answer asked straight away');
});

test('the counter: from one period when there is one, walked and remembered otherwise', () => {
  let asked = 0;
  const count = (c) => {
    asked++;
    return c % 2 === 0 ? 1 : 2;
  };
  const periodic = createTriggerCounter(count, 2);
  assert.equal(periodic(10), 15);
  assert.ok(asked <= 4, 'a period is counted, not every cycle');
  asked = 0;
  const walked = createTriggerCounter(count);
  assert.equal(walked(10), 15);
  assert.equal(asked, 10);
  assert.equal(walked(6), 9);
  assert.equal(asked, 10, 'remembered');
  assert.equal(walked(-2), -3);
});

test('advance takes its values from the cycle the trigger lands in', () => {
  const sig = n('<[0 1] [5 6 7]>').advance('1 1 1');
  assert.deepEqual(steps(sig, 0), [[0, 0], [1 / 3, 1], [2 / 3, 0]]);
  // cycle 1: three triggers before it, three values in it
  assert.deepEqual(steps(sig, 1), [[0, 5], [1 / 3, 6], [2 / 3, 7]]);
});

test('advance strikes a chord whole, and carries the event\'s channels', () => {
  const sig = note('[c3,e3] g3').vel('0.5 0.9').advance('1 1 1');
  const st = sig.stepsForCycle(0);
  assert.deepEqual(st.map((x) => [x.start, x.value]), [[0, 60], [0, 64], [1 / 3, 67], [2 / 3, 60], [2 / 3, 64]]);
  assert.equal(st[2].vel, 0.9);
  assert.equal(st[0].vel, 0.5);
});

test('advance takes a 0/1 signal as its trigger', () => {
  const sig = n('0 4 7').advance(pulses([[0.1, 0.2], [0.6, 0.7]]));
  assert.deepEqual(steps(sig, 0), [[0.125, 0], [0.625, 4]]);
  assert.deepEqual(steps(sig, 1), [[0.125, 7], [0.625, 0]]);
});

test('advance on a rest plays nothing, and needs a pattern of values', () => {
  assert.deepEqual(steps(n('~').advance('1 1'), 0), []);
  assert.throws(() => square().advance('1 1'), /advance\(\) steps through a pattern/);
});

// ------------------------------------------------------------------------------- a live button

test('a live press triggers on the first step the scheduler has not sent', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 0.30, 0.31);
  assert.deepEqual(steps(sigs[0], 0), [], 'nothing reads it as sent yet');
  // The window [0.40, 0.45) is being sent: the press lands on the next step from 0.40, not 0.3125
  // (already sent).
  scheduled(0.40, 0.45, () => assert.deepEqual(steps(sigs[0], 0), [[0.4375, 60]]));
  assert.deepEqual(steps(sigs[0], 0), [[0.4375, 60]], 'and stays there for every later read');
  scheduled(0.45, 0.50, () => assert.deepEqual(steps(sigs[0], 0), [[0.4375, 60]]));
});

test('a press before the window opens lands on its own next step', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 2.30, 2.31);
  scheduled(2.20, 2.25, () => assert.deepEqual(steps(sigs[0], 2), [[0.3125, 60]]));
});

test('a press exactly on a step is that step; a short tap between reads is kept', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 3.5, 3.5); // down and up at once: shorter than any poll
  scheduled(3.4, 3.45, () => assert.deepEqual(steps(sigs[0], 3), [[0.5, 60]]));
});

test('two presses inside one step are one trigger', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 4.26, 4.27);
  press('a', at, 4.28, 4.29);
  scheduled(4.2, 4.25, () => assert.deepEqual(steps(sigs[0], 4), [[0.3125, 60]]));
});

test('the press is stamped back by how long it waited on the way', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  now = 5.40;
  setWidgetValue('a', at, 1, undefined, 0.12); // happened at 5.28
  now = 5.41;
  setWidgetValue('a', at, 0);
  scheduled(5.2, 5.25, () => assert.deepEqual(steps(sigs[0], 5), [[0.3125, 60]]));
});

test('a press made while nothing read the button is not played later', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 6.3, 6.31);
  scheduled(9.0, 9.05, () => assert.deepEqual(steps(sigs[0], 9), []));
});

test('a press on the other deck\'s clock is not placed by this deck\'s scheduler', () => {
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())', 'b');
  const at = widgets.inputs[0].at;
  press('b', at, 7.3, 7.31);
  scheduled(7.2, 7.25, () => assert.deepEqual(steps(sigs[0], 7), []), 'a');
  scheduled(7.2, 7.25, () => assert.deepEqual(steps(sigs[0], 7), [[0.3125, 60]]), 'b');
});

test('advance on a live button counts its presses as they come', () => {
  const { sigs, widgets } = evalLines('a: n("0 4 7").advance(button())');
  const at = widgets.inputs[0].at;
  press('a', at, 10.1, 10.11);
  scheduled(10.0, 10.05, () => steps(sigs[0], 10));
  press('a', at, 10.6, 10.61);
  scheduled(10.5, 10.55, () => steps(sigs[0], 10));
  press('a', at, 11.1, 11.11);
  press('a', at, 11.3, 11.31);
  scheduled(11.0, 11.05, () => steps(sigs[0], 11));
  assert.deepEqual(steps(sigs[0], 10), [[0.125, 0], [0.625, 4]]);
  assert.deepEqual(steps(sigs[0], 11), [[0.125, 7], [0.3125, 0]]);
});

test('the scheduler places a live press as it sends the window', () => {
  const sent = [];
  const engine = {
    getTime: () => now,
    createTrack() {}, loadInstrument() {}, loadEffect() {}, unloadEffect() {}, setParam() {},
    noteOn: (_t, nn, _v, at) => sent.push([nn, Math.round(at * 1e6) / 1e6]),
    noteOff: () => {},
  };
  const { sigs, widgets } = evalLines('a: note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  const transport = new Transport(engine.getTime, { cps: 1, paused: true });
  transport.startAt(0, 0);
  const sig = sigs[0];
  sig.instrument = 'X';
  sig.fxChain = [];
  sig.channel = {};
  const sch = new Scheduler(engine, { transport, trackId: 't', deck: 'a' });
  sch.setPattern(sig);
  press('a', at, 12.30, 12.31);
  now = 12.32;
  sch._scheduleNoteEdges(12.4, 12.5, now); // 12.3125 went out with the window before
  assert.deepEqual(sent, [[60, 12.4375]]);
  sch._scheduleNoteEdges(12.5, 12.6, now);
  assert.equal(sent.length, 1, 'once');
  transport.dispose();
});

// ------------------------------------------------------------------------------- recording

test('a button take is a row of cells: each press switches on the cell it lands on', () => {
  // 2 cycles on sixteenths: 32 cells. A press lands on the next cell, as it plays on the next step.
  let row = rowWithPress(null, 4.5, { cycles: 2, cells: 32 });
  assert.equal(row, ['.', '.', '.', '.', '.', '.', '.', '.', 'x', ...Array(23).fill('.')].join(' '));
  row = rowWithPress(row, 5.01, { cycles: 2, cells: 32 }); // just past cell 16: the next, 17
  assert.equal(parseCells(row).map((c, i) => (c.on ? i : -1)).filter((i) => i >= 0).join(), '8,17');
  assert.equal(rowWithPress(row, 6.5, { cycles: 2, cells: 32 }), row, 'a press on a cell already on keeps the row');
  assert.equal(rowWithPress(row, 7.99, { cycles: 2, cells: 32 }).split(' ')[0], 'x', 'past the last cell: the first, next loop');
});

test('a row is read over the take\'s whole length, and an older shape take converts to one', () => {
  assert.deepEqual(rowEdges(rowCells('x . . . . . . . . . . . x . . .'), 2, 0, 4), [0, 1.5, 2, 3.5]);
  const points = parseShapePoints('0,0 0.25,0 0.25,1 0.3,1 0.3,0 1,0');
  assert.equal(shapeAsRow(points, 8), '. . x . . . . .');
});

test('a recorded button plays its presses back every loop, as .struct() and as .advance()', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a: button().record({ cycles: 2 })');
  const at = widgets.inputs[0].at;
  press('a', at, 20.25, 20.3); // phase 0.25 of the 2-cycle loop
  press('a', at, 21.5, 21.52); // phase 1.5
  const takes = takeMotionTakes();
  assert.equal(takes.length, 2, 'a take each press, for the editor to write');
  assert.equal(takes[1].cycles, 2);
  const take = sigs[0];
  for (const c of [20, 22, 100]) {
    assert.deepEqual(steps(note('c3').struct(take), c), [[0.25, 60]], `cycle ${c}`);
    assert.deepEqual(steps(note('c3').struct(take), c + 1), [[0.5, 60]], `cycle ${c + 1}`);
  }
  const adv = n('0 4 7').advance(take);
  // two triggers a loop: cycle 100 is loop 50, 100 triggers before it
  assert.deepEqual(steps(adv, 100), [[0.25, 4]]);
  assert.deepEqual(steps(adv, 101), [[0.5, 7]]);
  assert.deepEqual(steps(adv, 0), [[0.25, 0]]);
});

test('a button records into a steps() row, and the written row plays on every pass', () => {
  takeMotionTakes();
  const first = evalLines('a:            note("c3").struct(button().record({ cycles: 2 }))');
  const at = first.widgets.inputs[0].at;
  press('a', at, 30.25, 30.3);
  press('a', at, 31 + 3 / 16, 31.2);
  const takes = takeMotionTakes();
  assert.equal(takes.length, 2);
  const row = takes[1].row;
  assert.equal(row, '. . . . x . . . . . . . . . . . . . . x . . . . . . . . . . . .');
  // Played before the editor has written it in: from the recorder.
  assert.deepEqual(steps(first.sigs[0], 40), [[0.25, 60]]);
  assert.deepEqual(steps(first.sigs[0], 41), [[3 / 16, 60]]);
  // Written in, as the editor writes it, and evaluated: the row is the take.
  const code = `a:            note("c3").struct(button().record({ cycles: 2, take: steps(${JSON.stringify(row)}) }))`;
  const again = evalLines(code);
  for (const c of [40, 42, 1000]) {
    assert.deepEqual(steps(again.sigs[0], c), [[0.25, 60]], `cycle ${c}`);
    assert.deepEqual(steps(again.sigs[0], c + 1), [[3 / 16, 60]], `cycle ${c + 1}`);
  }
  // Its cells light: each trigger carries the span of the cell that made it.
  const lit = again.sigs[0].stepsForCycle(40)[0].locs ?? [];
  const cell = code.indexOf('steps("') + 'steps("'.length + 8; // the fifth cell, "x"
  assert.ok(lit.some(([a, b]) => a === cell && b === cell + 1), JSON.stringify(lit));
});

test('a press over a written row switches its cell on, and clicking a cell is what plays', () => {
  takeMotionTakes();
  const row = ['x', ...Array(15).fill('.')].join(' ');
  const { sigs, widgets } = evalLines(`a:             note("c3").struct(button().record({ cycles: 1, take: steps("${row}") }))`);
  const button = widgets.inputs.find((w) => w.kind === 'button').at;
  const cells = widgets.inputs.find((w) => w.kind === 'steps').at;
  press('a', button, 50.5, 50.52);
  const takes = takeMotionTakes();
  assert.equal(takes[0].row, ['x', ...Array(7).fill('.'), 'x', ...Array(7).fill('.')].join(' '), 'overdubbed into the row');
  assert.equal(core.widgetValue('a', cells), takes[0].row, 'and into the drawn row, so it plays now');
  assert.deepEqual(steps(sigs[0], 51), [[0, 60], [0.5, 60]]);
  // A click on a cell (the editor sets the row's text): that is what plays.
  setWidgetValue('a', cells, ['.', '.', '.', '.', 'x', ...Array(11).fill('.')].join(' '));
  assert.deepEqual(steps(sigs[0], 52), [[0.25, 60]]);
});

test('a take on an eighth grid is written in eighths', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a:              note("c3").struct(button().record({ cycles: 1 }), 8)');
  steps(sigs[0], 0); // read once, as a playing track is
  press('a', widgets.inputs[0].at, 60.3, 60.31);
  assert.equal(takeMotionTakes()[0].row, '. . . x . . . .');
});

test('an older take kept as a shape still plays, and its next press writes it out as a row', () => {
  takeMotionTakes();
  _shape('oldtake', '0,0 0.25,0 0.25,1 0.3,1 0.3,0 1,0');
  const { sigs, widgets } = evalLines('a:               note("c3").struct(button().record({ cycles: 1, take: "oldtake" }))');
  assert.deepEqual(steps(sigs[0], 3), [[0.25, 60]]);
  press('a', widgets.inputs[0].at, 70.75, 70.76);
  assert.equal(takeMotionTakes()[0].row, ['.', '.', '.', '.', 'x', ...Array(7).fill('.'), 'x', '.', '.', '.'].join(' '));
});

test('a recorded button still plays a live press not yet in the take, once', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a:       note("c3").struct(button().record({ cycles: 1 }))');
  const at = widgets.inputs[0].at;
  press('a', at, 50.25, 50.26);
  // The window being sent starts before the press's step: the take and the press agree on 0.25.
  scheduled(50.2, 50.24, () => assert.deepEqual(steps(sigs[0], 50), [[0.25, 60]]));
  takeMotionTakes();
});

// ------------------------------------------------------------------------------- a key on a sampler

test('a key on a sampler track strikes the roll\'s file, with its pitch and its index', () => {
  const sample = { ref: 'sp:kit', index: 2, begin: 0.1, end: 0.9, speed: 2 };
  assert.deepEqual(keyStrike(sample, { note: 60, index: 5, vel: 0.8 }), { ref: 'sp:kit', cfg: { index: 5, begin: 0.1, end: 0.9, vel: 0.8, note: 60, speed: 2 } });
  assert.deepEqual(keyStrike(sample, { note: 62, vel: 2 }).cfg, { index: 2, begin: 0.1, end: 0.9, vel: 1, note: 62, speed: 2 }, 'no index: the chain\'s');
  assert.equal(keyStrike({}, { note: 60 }), null);
  assert.equal(keyStrike(null, { note: 60 }), null);
});

// ------------------------------------------------------------------------------- a recorded button, counted

// A press, and the read of a scheduler sending the window just before it - what places it.
function tap(sig, at, t) {
  press('a', at, t, t + 0.01);
  scheduled(t - 0.05, t, () => sig.stepsForCycle(Math.floor(t)));
}
const valuesIn = (sig, from, to) => {
  const out = [];
  for (let c = from; c < to; c++) for (const st of sig.stepsForCycle(c)) out.push([c + st.start, st.value]);
  return out;
};

test('advance on a recording button: each press plays the next value, before, while and after a take', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a:     n("0 3 5 7").advance(button().record({ cycles: 2 }))');
  const at = widgets.inputs[0].at;
  // No take yet: three presses play the first three values, one after another.
  press('a', at, 60.1, 60.11);
  scheduled(60.05, 60.1, () => assert.deepEqual(steps(sigs[0], 60), [[0.125, 0]]));
  press('a', at, 60.6, 60.61);
  scheduled(60.55, 60.6, () => assert.deepEqual(steps(sigs[0], 60), [[0.125, 0], [0.625, 3]]));
  press('a', at, 61.1, 61.11);
  scheduled(61.05, 61.1, () => assert.deepEqual(steps(sigs[0], 61), [[0.125, 5]]));
  // The take plays them back and carries on counting from the last press.
  assert.deepEqual(valuesIn(sigs[0], 62, 64), [[62.125, 7], [62.625, 0], [63.125, 3]]);
  // Pressing again while it plays: the press is the next value, and the take goes on after it.
  tap(sigs[0], at, 62.3);
  assert.deepEqual(valuesIn(sigs[0], 62, 64), [[62.125, 7], [62.3125, 0], [62.625, 3], [63.125, 5]]);
  assert.deepEqual(valuesIn(sigs[0], 64, 66), [[64.125, 7], [64.3125, 0], [64.625, 3], [65.125, 5]], 'four in the take now: the next loop');
  assert.equal(takeMotionTakes().length, 4, 'every press punched into the take');
});

test('a recording button keeps its count when the buffer is evaluated again', () => {
  takeMotionTakes();
  const first = evalLines('a:      n("0 3 5").advance(button().record({ cycles: 1 }))');
  const at = first.widgets.inputs[0].at;
  tap(first.sigs[0], at, 70.1);
  tap(first.sigs[0], at, 70.6);
  const before = valuesIn(first.sigs[0], 71, 73);
  // What the editor does with the take: the row written into the call, then a fresh evaluation.
  const takes = takeMotionTakes();
  const again = evalLines(`a:      n("0 3 5").advance(button().record({ cycles: 1, take: steps(${JSON.stringify(takes[takes.length - 1].row)}) }))`);
  assert.equal(again.widgets.inputs[0].at, at, 'the same button');
  assert.deepEqual(valuesIn(again.sigs[0], 71, 73), before);
  takeMotionTakes();
});

test('struct on a recording button plays every press, before, while and after a take', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a: note("c3").struct(button().record({ cycles: 1 }))');
  const at = widgets.inputs[0].at;
  press('a', at, 80.1, 80.11);
  scheduled(80.05, 80.1, () => assert.deepEqual(steps(sigs[0], 80), [[0.125, 60]]));
  press('a', at, 80.6, 80.61);
  scheduled(80.55, 80.6, () => assert.deepEqual(steps(sigs[0], 80), [[0.125, 60], [0.625, 60]]));
  assert.deepEqual(steps(sigs[0], 81), [[0.125, 60], [0.625, 60]], 'the take plays both');
  tap(sigs[0], at, 81.3);
  assert.deepEqual(steps(sigs[0], 81), [[0.125, 60], [0.3125, 60], [0.625, 60]], 'a press while it plays, once');
  assert.deepEqual(steps(sigs[0], 82), [[0.125, 60], [0.3125, 60], [0.625, 60]]);
  takeMotionTakes();
});

test('a plain button still counts press by press', () => {
  const { sigs, widgets } = evalLines('a:        n("0 3 5").advance(button())');
  const at = widgets.inputs[0].at;
  for (const t of [90.1, 90.6, 91.1, 91.6]) tap(sigs[0], at, t);
  assert.deepEqual(valuesIn(sigs[0], 90, 93), [[90.125, 0], [90.625, 3], [91.125, 5], [91.625, 0]]);
});

test('presses placed late by the lookahead still count one by one on a recording button', () => {
  takeMotionTakes();
  const { sigs, widgets } = evalLines('a:         n("0 3 5 7").advance(button().record({ cycles: 2 }))');
  const at = widgets.inputs[0].at;
  // Each press is read by a window that opens a little after it, as a running scheduler's does:
  // it plays a step after the one it was pressed nearest, and is laid into the take where pressed.
  // What the window sends: the steps from where it opens.
  const late = (t) => {
    press('a', at, t, t + 0.01);
    return scheduled(t + 0.04, t + 0.09, () => valuesIn(sigs[0], Math.floor(t), Math.floor(t) + 1).filter(([p]) => p >= t + 0.04));
  };
  assert.deepEqual(late(100.1)[0], [100.1875, 0]);
  assert.deepEqual(late(100.6)[0], [100.6875, 3]);
  assert.deepEqual(late(101.1)[0], [101.1875, 5]);
  // The take has them where they were pressed, and carries on from the last.
  assert.deepEqual(valuesIn(sigs[0], 102, 104), [[102.125, 7], [102.625, 0], [103.125, 3]]);
  takeMotionTakes();
});

// ------------------------------------------------------------------------------- capture

test('capture after tapping a rhythm-only button writes the presses as a take', () => {
  core.clearCaptureHistory();
  const { sigs, widgets } = evalLines('a:          note("c3").struct(button())');
  const at = widgets.inputs[0].at;
  // Never polled - it is only a rhythm - and still kept.
  for (const t of [120.25, 120.75, 121.5]) press('a', at, t, t + 0.02);
  const takes = core.captureMotion().filter((t) => t.at === at);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].kind, 'button');
  assert.equal(takes[0].cycles, 2);
  // The same form a .record() writes: a row over the two cycles, sixteen cells each.
  assert.equal(takes[0].row, ['.', '.', '.', '.', 'x', ...Array(7).fill('.'), 'x', ...Array(11).fill('.'), 'x', ...Array(7).fill('.')].join(' '));
  const again = evalLines(`a:          note("c3").struct(button().record({ cycles: 2, take: steps(${JSON.stringify(takes[0].row)}) }))`);
  assert.deepEqual(steps(again.sigs[0], 200), [[0.25, 60], [0.75, 60]]);
  assert.deepEqual(steps(again.sigs[0], 201), [[0.5, 60]]);
  assert.ok(sigs[0]);
  core.clearCaptureHistory();
});

test('capture leaves a button that records itself alone', () => {
  core.clearCaptureHistory();
  const { widgets } = evalLines('a:           note("c3").struct(button().record({ cycles: 1 }))');
  const at = widgets.inputs[0].at;
  press('a', at, 130.25, 130.3);
  assert.equal(core.captureMotion().filter((t) => t.at === at).length, 0);
  takeMotionTakes();
  core.clearCaptureHistory();
});

test('the editor writes a button\'s row into its .record() call: added, renamed from a shape, or rewritten', () => {
  const apply = (code, row) => {
    const e = core.recordTakeRowEdit(code, code.indexOf('record(') + 6, row);
    return e ? code.slice(0, e.from) + e.text + code.slice(e.to) : null;
  };
  assert.equal(apply('button().record({ cycles: 2 })', 'x . . .'), 'button().record({ cycles: 2, take: steps("x . . .") })');
  assert.equal(apply('button().record()', 'x .'), 'button().record({ take: steps("x .") })');
  assert.equal(apply('button().record({ cycles: 1, take: "old" })', 'x .'), 'button().record({ cycles: 1, take: steps("x .") })');
  assert.equal(apply('button().record({ cycles: 1, take: steps("x . . .") })', 'x x . .'), 'button().record({ cycles: 1, take: steps("x x . .") })');
  assert.equal(apply('button().record({ take: mine })', 'x'), null, 'a take that is other code is left alone');
});
