// _auto()/auto() - named automation lanes on absolute song time. Pure pattern math against the
// store; no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { _auto, liveAuto, auto, setPatternWarn } from './src/signal.mjs';
import { parseAutoPoints, serializeAutoPoints, sampleAutoPoints } from './src/shape.mjs';
import { clearRolls, setRollLayer, lookupAuto, autoIds } from './src/rolls.mjs';

// Each test owns the store: the buffer layer is rebuilt per evaluation in the real host too.
const fresh = () => {
  clearRolls('buffer');
  clearRolls('prebake');
  setRollLayer('buffer');
};

const capture = (fn) => {
  const lines = [];
  setPatternWarn((m) => lines.push(m));
  try {
    return { value: fn(), lines };
  } finally {
    setPatternWarn(null);
  }
};

// ------------------------------------------------------------------ parsing / sampling

test('parseAutoPoints reads bar,value[,curve] without clamping either axis', () => {
  const pts = parseAutoPoints('0,0 16,0 20,1,-2 32,0.3');
  assert.deepEqual(pts.map((p) => p.x), [0, 16, 20, 32]);
  assert.deepEqual(pts.map((p) => p.y), [0, 0, 1, 0.3]);
  assert.equal(pts[2].c, -2);
  // A value outside 0..1 is data, not an error - auto() feeds .add() and friends too.
  assert.equal(parseAutoPoints('0,12 4,-12')[1].y, -12);
});

test('parseAutoPoints rejects descending bars and malformed breakpoints', () => {
  assert.throws(() => parseAutoPoints('8,0 4,1'), /ascending/);
  assert.throws(() => parseAutoPoints('0,x'), /bad breakpoint/);
  assert.throws(() => parseAutoPoints(''), /at least 1/);
});

test('a half-typed breakpoint is refused, not read as a zero', () => {
  // Number("") is 0, so "16," would otherwise be a silent breakpoint pulling the lane to the
  // floor - on a wet lane, the effect disappearing while the value is still being typed.
  assert.throws(() => parseAutoPoints('0,0 16,'), /bad breakpoint/);
  assert.throws(() => parseAutoPoints('0,0 ,1'), /bad breakpoint/);
  assert.throws(() => parseAutoPoints('0,0 16,1,'), /bad breakpoint/);
  assert.throws(() => parseAutoPoints('0,0 16,1,2,3'), /bad breakpoint/);
});

test('a single breakpoint is a constant', () => {
  assert.equal(sampleAutoPoints(parseAutoPoints('4,0.7'), 0), 0.7);
  assert.equal(sampleAutoPoints(parseAutoPoints('4,0.7'), 100), 0.7);
});

test('sampleAutoPoints holds the nearest end outside the breakpoints', () => {
  const pts = parseAutoPoints('16,0 20,1');
  assert.equal(sampleAutoPoints(pts, 0), 0); // before the first point: its level
  assert.equal(sampleAutoPoints(pts, 16), 0);
  assert.equal(sampleAutoPoints(pts, 18), 0.5); // linear between
  assert.equal(sampleAutoPoints(pts, 20), 1);
  assert.equal(sampleAutoPoints(pts, 999), 1); // after the last: it stands for the rest of the song
});

test('curvature follows SC semantics - negative is fast-then-slow', () => {
  const linear = sampleAutoPoints(parseAutoPoints('0,0 8,1'), 4);
  const scooped = sampleAutoPoints(parseAutoPoints('0,0,-3 8,1'), 4);
  assert.equal(linear, 0.5);
  assert.ok(scooped > 0.5, `negative curve should be ahead of linear at the midpoint (got ${scooped})`);
});

test('duplicate-x points read as a vertical step', () => {
  const pts = parseAutoPoints('0,0 8,0 8,1 16,1');
  assert.equal(sampleAutoPoints(pts, 7.999), 0);
  assert.equal(sampleAutoPoints(pts, 8), 1);
});

test('serializeAutoPoints keeps 16th-bar positions exactly', () => {
  const str = '0,0 16.0625,1,-2 32,0.3';
  assert.equal(serializeAutoPoints(parseAutoPoints(str)), str);
});

// ------------------------------------------------------------------ the registry + signals

test('_auto files a lane and auto() reads it back at absolute bars', () => {
  fresh();
  _auto('intro', '0,0 16,0 20,1 32,0.3');
  const sig = auto('intro');
  assert.equal(sig.sample(0, 1, 0), 0);
  assert.equal(sig.sample(0, 1, 18), 0.5);
  assert.equal(sig.sample(0, 1, 20), 1);
  assert.equal(sig.sample(0, 1, 64), 0.3); // held past the last point
});

test('auto() falls back to t*cps when no cycle position is handed in', () => {
  fresh();
  _auto('fade', '0,0 10,1');
  assert.equal(auto('fade').sample(5, 1), 0.5); // 5 seconds at 1 cps = bar 5
});

test('resolution is lazy - a lane defined after the auto() call is still found', () => {
  fresh();
  const sig = auto('late');
  _auto('late', '0,0 4,1');
  assert.equal(sig.sample(0, 1, 4), 1);
});

test('an unknown lane warns once and reads as null', () => {
  fresh();
  const sig = auto('nothere');
  const { value, lines } = capture(() => [sig.sample(0, 1, 0), sig.sample(0, 1, 1)]);
  assert.deepEqual(value, [null, null]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no automation called "nothere"/);
});

test('liveAuto re-registers silently mid-drag; _auto warns on a real double definition', () => {
  fresh();
  const first = capture(() => _auto('lane', '0,0 4,1'));
  assert.equal(first.lines.length, 0);
  const sig = auto('lane');
  const drag = capture(() => liveAuto('lane', '0,0 4,0.5'));
  assert.equal(drag.lines.length, 0);
  assert.equal(sig.sample(0, 1, 4), 0.5); // the redraw is heard without a re-eval
  const dupe = capture(() => _auto('lane', '0,1 4,1'));
  assert.equal(dupe.lines.length, 1);
  assert.match(dupe.lines[0], /defined twice/);
});

test('definitions are marked as definitions, and ids must be one plain word', () => {
  fresh();
  const sig = _auto('drop', '0,0 4,1');
  assert.equal(sig.isDef, 'drop');
  assert.equal(sig.sample(0, 1, 4), 1); // ...but a definition is usable on its own
  assert.throws(() => _auto('two words', '0,0'), /one plain word/);
  assert.throws(() => _auto('a<b', '0,0'), /one plain word/);
});

test('the auto store clears with the buffer layer like every definition kind', () => {
  fresh();
  _auto('gone', '0,0 4,1');
  assert.ok(lookupAuto('gone'));
  assert.deepEqual(autoIds().map((e) => e.id), ['gone']);
  clearRolls('buffer');
  assert.equal(lookupAuto('gone'), null);
});

test('auto() is an ordinary signal - arithmetic rides along', () => {
  fresh();
  _auto('semis', '0,0 4,1');
  assert.equal(auto('semis').mul(12).sample(0, 1, 4), 12);
});
