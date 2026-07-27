// Source-location tracking for playback highlighting: the injectLocations transpile (which tags
// pattern-position string literals with their document offset), parseMini's offset argument, the
// stepLocs highlight-span helper, and the end-to-end guarantee that an emitted step's locations
// track the WHOLE method chain (.fast reverse, .add union). Pure pattern math - no eval/engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { injectLocations, isPatternPosition } from './src/locations.mjs';
import { parseMini, getStepsForCycle, stepLocs } from './src/mini.mjs';
import { n, note, mini } from './src/signal.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} !~ ${b}`);
const onsets = (sig, cycle = 0) =>
  sig.stepsForCycle(cycle).filter((s) => s.value != null && !s.cont).sort((a, b) => a.start - b.start);

// ---------------------------------------------------------------------------------------------
// injectLocations - which literals get wrapped, and at what offset
// ---------------------------------------------------------------------------------------------

test('injectLocations wraps a builder argument at its content offset', () => {
  // 'n("0 1")': the opening quote is index 2, first content char index 3.
  assert.equal(injectLocations('n("0 1")'), 'n(mini("0 1", 3))');
});

test('injectLocations offsets by the block base (document-absolute spans)', () => {
  assert.equal(injectLocations('n("0 1")', 1000), 'n(mini("0 1", 1003))');
});

test('injectLocations wraps chain-method pattern args but not plugin/scale lookups', () => {
  const out = injectLocations('s("bd hh").speed("2 1").synth("Serum 2").scale("F minor")');
  assert.match(out, /s\(mini\("bd hh", 3\)\)/);
  assert.match(out, /\.speed\(mini\("2 1", \d+\)\)/);
  assert.ok(out.includes('.synth("Serum 2")'), 'plugin name stays a plain string');
  assert.ok(out.includes('.scale("F minor")'), 'scale name stays a plain string');
});

test('injectLocations wraps a second-position .param() value but not its name', () => {
  const out = injectLocations('x.param("Filter Freq", "0.2 0.8")');
  assert.ok(out.includes('.param("Filter Freq", mini("0.2 0.8"'), out);
});

test('injectLocations wraps a string that immediately chains a method', () => {
  assert.equal(injectLocations('"0 1 2".gte(1)'), 'mini("0 1 2", 1).gte(1)');
});

test('injectLocations leaves literals inside comments alone', () => {
  const out = injectLocations('// n("0 1")\nn("2 3")');
  assert.ok(out.startsWith('// n("0 1")\n'), 'commented literal untouched');
  assert.match(out, /\nn\(mini\("2 3", \d+\)\)/);
});

test('injectLocations does NOT wrap a literal that is part of a larger expression', () => {
  // Wrapping "0 1" here would turn a string concatenation into (Sig + x) and break the pattern.
  assert.equal(injectLocations('n("0 1" + x)'), 'n("0 1" + x)');
});

test('injectLocations does NOT reach into a .when() lambda body it cannot place', () => {
  // The condition literal is wrapped; the .fast(-1) inside the callback has no string to tag and
  // must not be applied globally (the old text-scanner bug).
  const out = injectLocations('keys.when("<0 1>", x => x.fast(-1))');
  assert.match(out, /\.when\(mini\("<0 1>", \d+\), x => x\.fast\(-1\)\)/);
});

test('isPatternPosition rejects an operator-followed literal but accepts a closed argument', () => {
  assert.equal(isPatternPosition('n(', ' + x)'), false);
  assert.equal(isPatternPosition('n(', ')'), true);
  assert.equal(isPatternPosition('.synth(', ')'), false); // not in the builder/method allow-list
});

// ---------------------------------------------------------------------------------------------
// parseMini offset + stepLocs
// ---------------------------------------------------------------------------------------------

test('parseMini(str, offset) shifts every atom span; seeds stay put', () => {
  const steps = getStepsForCycle(parseMini('0 1', 100), 0);
  assert.deepEqual(steps.map((s) => s.loc), [[100, 101], [102, 103]]);
  // Default offset keeps the bare-string-relative spans (existing callers unchanged).
  assert.deepEqual(getStepsForCycle(parseMini('0 1'), 0).map((s) => s.loc), [[0, 1], [2, 3]]);
});

test('a degrade seed is unaffected by offset (a pattern degrades the same wherever it sits)', () => {
  const drop = (ast) => getStepsForCycle(ast, 0).filter((s) => s.value == null).length;
  // "4?0.5 4?0.5 4?0.5 4?0.5": the exact set of dropped onsets must not depend on the offset.
  const src = '4?0.5 4?0.5 4?0.5 4?0.5';
  assert.equal(drop(parseMini(src)), drop(parseMini(src, 5000)));
});

test('stepLocs prefers accumulated locs, then subLocs, then the single loc', () => {
  assert.deepEqual(stepLocs({ loc: [1, 2] }), [[1, 2]]);
  assert.deepEqual(stepLocs({ loc: [1, 2], subLocs: [[3, 4]] }), [[3, 4]]);
  assert.deepEqual(stepLocs({ loc: [1, 2], subLocs: [[3, 4]], locs: [[5, 6], [7, 8]] }), [[5, 6], [7, 8]]);
});

// ---------------------------------------------------------------------------------------------
// End-to-end: locations follow the whole chain
// ---------------------------------------------------------------------------------------------

test('locations survive a reversing .fast(-1) - the atom span walks backward with the note', () => {
  // mini offsets stand in for the transpile: "0 1 2 3" at document offset 10.
  const sig = n(mini('0 1 2 3', 10)).fast(-1);
  const steps = onsets(sig);
  assert.deepEqual(steps.map((s) => s.value), [3, 2, 1, 0]);
  // The first-sounding atom is "3", whose source span is offset 10 + 6 = [16,17].
  assert.deepEqual(stepLocs(steps[0]), [[16, 17]]);
});

test('.when("<0 1>") plays forward then reversed, spans tracking each note', () => {
  const sig = n(mini('0 1 2 3', 0)).when('<0 1>', (x) => x.fast(-1));
  assert.deepEqual(onsets(sig, 0).map((s) => s.value), [0, 1, 2, 3]);
  assert.deepEqual(onsets(sig, 1).map((s) => s.value), [3, 2, 1, 0]);
  // Cycle 1 first-sounding atom is "3" (span [6,7]) plus the active condition "1" (span [3,4] in
  // the bare, offset-0 "<0 1>") - both light up.
  assert.deepEqual(stepLocs(onsets(sig, 1)[0]), [[6, 7], [3, 4]]);
});

test('a .when() condition pick lights up alongside the note it gates', () => {
  // "<0 1>" at document offset 50: "0" -> [51,52], "1" -> [53,54].
  const sig = n(mini('0 1', 0)).when(mini('<0 1>', 50), (x) => x.add(12));
  // Cycle 0 picks "0" (falsy -> original note plays); the note still lights the active "0".
  const first0 = onsets(sig, 0)[0];
  assert.equal(first0.value, 0);
  assert.deepEqual(stepLocs(first0), [[0, 1], [51, 52]]);
  // Cycle 1 picks "1" (truthy -> +12); lights the note and the active "1".
  const first1 = onsets(sig, 1)[0];
  assert.equal(first1.value, 12);
  assert.deepEqual(stepLocs(first1), [[0, 1], [53, 54]]);
});

test('a patterned .fast("-1 1") lights the active rate atom with the notes it warps', () => {
  // "-1 1" at offset 100: "-1" -> [100,102], "1" -> [103,104].
  const sig = n(mini('0 1', 0)).fast(mini('-1 1', 100));
  const first = onsets(sig, 0)[0]; // first window [0,0.5) at rate -1
  assert.deepEqual(stepLocs(first), [[2, 3], [100, 102]]); // note "1" span + the "-1" rate span
  const last = onsets(sig, 0).at(-1); // second window [0.5,1) at rate 1
  assert.ok(stepLocs(last).some((l) => l[0] === 103 && l[1] === 104), 'the "1" rate atom lights');
});

test('.add() unions both operands\' spans onto the sounding note', () => {
  const sig = n(mini('0 1', 100)).add(mini('7 0', 200));
  const first = onsets(sig)[0];
  assert.equal(first.value, 7); // 0 + 7
  // Both the "0" (from the left literal at 100) and the "7" (right literal at 200) light up.
  assert.deepEqual(stepLocs(first), [[100, 101], [200, 201]]);
});
