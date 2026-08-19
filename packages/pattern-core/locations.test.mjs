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

test('injectLocations leaves method-form .se()/.sr() names plain but wraps the builders', () => {
  // The method forms take a literal path/recording name ("/" is a mini operator, so wrapping
  // .se("hits/stab.wav") would throw before .se() ever ran); the same-named builders take mini.
  assert.equal(injectLocations('x.se("hits/stab.wav")'), 'x.se("hits/stab.wav")');
  assert.equal(injectLocations('x.sr("stab")'), 'x.sr("stab")');
  assert.equal(injectLocations('note("c")\n  .se("hits/stab.wav")').includes('mini("hits'), false);
  assert.match(injectLocations('se("\'hits/stab.wav\'")'), /se\(mini\(/);
  assert.match(injectLocations('sr("stab*2")'), /sr\(mini\(/);
  // .s() is NOT name-form: a pack name is a valid one-atom pattern, and .s() samples the Sig.
  assert.match(injectLocations('x.s("bd")'), /\.s\(mini\("bd", \d+\)\)/);
});

test('injectLocations wraps a second-position .param() value but not its name', () => {
  const out = injectLocations('x.param("Filter Freq", "0.2 0.8")');
  assert.ok(out.includes('.param("Filter Freq", mini("0.2 0.8"'), out);
});

test('injectLocations wraps a string that immediately chains a method', () => {
  assert.equal(injectLocations('"0 1 2".gte(1)'), 'mini("0 1 2", 1).gte(1)');
});

test('injectLocations wraps every choose() option, first argument included', () => {
  const out = injectLocations('s("x").speed(choose("1", "-1"))');
  assert.match(out, /choose\(mini\("1", \d+\), mini\("-1", \d+\)\)/, out);
  // …including the option in a weighted [option, weight] pair
  const weighted = injectLocations('n(choose(["0", 3], ["3", 1]))');
  assert.match(weighted, /choose\(\[mini\("0", \d+\), 3\], \[mini\("3", \d+\), 1\]\)/, weighted);
});

test('a call with no entry in either list patterns its arguments by default', () => {
  // The point of denying from a closed list rather than allowing from an open one: a builder
  // nobody has told the transpile about still highlights. If this ever needs an entry to pass,
  // the predicate has been inverted back.
  assert.match(injectLocations('someNewCombinator("0 1 2")'), /someNewCombinator\(mini\("0 1 2", \d+\)\)/);
});

test('injectLocations leaves every name-lookup argument a plain string', () => {
  // These name things outside the pattern language; wrapping one changes what the code computes.
  const cases = [
    ['x.synth("Serum 2")', '.synth("Serum 2")'],
    ['x.fx("Pro-Q 3")', '.fx("Pro-Q 3")'],
    ['x.scale("F minor")', '.scale("F minor")'],
    ['setscale("F minor")', 'setscale("F minor")'],
    ['x.bus("reverb")', '.bus("reverb")'],
    ['x.bsend("delay")', '.bsend("delay")'],
    ['x.as("note:vel:clip")', '.as("note:vel:clip")'],
    ['midicc("dev:Keystep")', 'midicc("dev:Keystep")'],
    ['midikeys("dev:Keystep")', 'midikeys("dev:Keystep")'],
    ['midi("track")', 'midi("track")'],
    ['audio("track")', 'audio("track")'],
    // lfo() and pianoroll() are judged by CONTENT, not by the callee: drawn data stays plain,
    // while a pattern of names is tagged so the running one can be highlighted (see the test
    // below). "0 1 0" is neither a breakpoint list nor a note string, so it reads as names now.
    ['lfo("0,0 0.5,1 1,0")', 'lfo("0,0 0.5,1 1,0")'],
    ['pianoroll("60,0,4")', 'pianoroll("60,0,4")'],
    ['x.param("Filter Freq", 0.5)', '.param("Filter Freq", 0.5)'],
    // a name-only call's LATER arguments too - a captured plugin-state blob is not mini notation
    ['synth("Serum 2", "STATEBLOB")', 'synth("Serum 2", "STATEBLOB")'],
  ];
  for (const [code, expected] of cases) {
    assert.ok(injectLocations(code).includes(expected), `${code} -> ${injectLocations(code)}`);
  }
});

test('injectLocations still patterns a .param() VALUE while leaving its name alone', () => {
  const out = injectLocations('x.param("Filter Freq", "0.2 0.8")');
  assert.ok(out.includes('.param("Filter Freq", mini("0.2 0.8'), out);
});

test('injectLocations leaves a bare (non-argument) literal alone', () => {
  // Outside argument position there is no callee to check, and the string may well be a name
  // held in a variable for later - so the conservative default applies.
  assert.equal(injectLocations('const p = "Serum 2";'), 'const p = "Serum 2";');
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
// Operator arguments: one rule - a value derived from a pattern lights when its trigger fires, so
// a patterned euclid count/rotation or fast/slow rate highlights with every step it places, and
// nothing else does (the ".e" method spelling is not a value).
// ---------------------------------------------------------------------------------------------

// What each of `src`'s sounding steps lights up, as the text of its spans.
const lit = (src, cycle = 0) =>
  getStepsForCycle(parseMini(src), cycle)
    .filter((s) => s.value != null)
    .map((s) => stepLocs(s).map(([a, b]) => src.slice(a, b)).join('+'));

test('the euclid method spelling is never highlighted - only the value it places', () => {
  // The tokenizer swallows ".e" into the atom ("1.e"), so the span has to be trimmed back.
  assert.deepEqual(lit('1.e(3,8)'), ['1', '1', '1']);
  assert.deepEqual(lit('bd.e(3,8)'), ['bd', 'bd', 'bd']);
  // The value keeps its own dots and field suffix - only the trailing ".e" comes off.
  assert.deepEqual(lit('0.5.e(3,8)'), ['0.5', '0.5', '0.5']);
  assert.deepEqual(lit('bd:3.e(3,8)'), ['bd:3', 'bd:3', 'bd:3']);
  // A group/alternation value was already right, and stays so: the live pick, nothing more.
  assert.deepEqual(lit('<0.5 1>.e(3,8)'), ['0.5', '0.5', '0.5']);
  assert.deepEqual(lit('<0.5 1>.e(3,8)', 1), ['1', '1', '1']);
});

test('a patterned euclid argument lights with the hits it places', () => {
  assert.deepEqual(lit('1.e(7,16,<0 1>)').slice(0, 2), ['1+0', '1+0']);
  assert.deepEqual(lit('1.e(7,16,<0 1>)', 1).slice(0, 2), ['1+1', '1+1']);
  // The pulse count too, and it is the live alternation pick that lights, not the whole "<3 5>".
  assert.deepEqual(lit('1.e(<3 5>,8)'), ['1+3', '1+3', '1+3']);
  // Literal arguments have no pattern to follow, so they light nothing.
  assert.deepEqual(lit('1.e(3,8)'), ['1', '1', '1']);
});

test('a patterned fast/slow rate lights with the steps it placed', () => {
  assert.deepEqual(lit('a*<2 3>'), ['a+2', 'a+2']);
  assert.deepEqual(lit('a*<2 3>', 1), ['a+3', 'a+3', 'a+3']);
  // A rate that changes within the cycle lights whichever window each step landed in.
  assert.deepEqual(lit('a*[1 2]'), ['a+1', 'a+2']);
  assert.deepEqual(lit('a*2'), ['a', 'a']); // a literal rate: nothing extra
});

test('inside an expression, an operator argument is a sub-selection like an alternation pick', () => {
  // "(1.e(3,<8 4>) + <5 7>)": the value, the live step count, and the live right operand.
  assert.deepEqual(lit('(1.e(3,<8 4>) + <5 7>)'), ['1+8+5', '1+8+5', '1+8+5']);
  assert.deepEqual(lit('(a*<2 3> + 1)'), ['a+2', 'a+2']);
});

test('a euclid argument span is document-absolute under parseMini(str, offset)', () => {
  // Highlighting places these in the buffer, so an argument's span must move with the offset too.
  const src = '1.e(3,<8 4>)';
  const at = (offset) => stepLocs(getStepsForCycle(parseMini(src, offset), 0)[0]);
  assert.deepEqual(at(0), [[0, 1], [7, 8]]); // the "1", and the "8" inside "<8 4>"
  assert.deepEqual(at(100), [[100, 101], [107, 108]]);
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

test('.sc()\'s octave IS a pattern position - a patterned octave is a real feature', () => {
  // setscale names a scale (excluded above); .sc() takes an octave, which may be patterned:
  // `.sc("<3 4>")` alternates octaves per cycle, so its literal must still become a mini().
  assert.match(injectLocations('n("0 2").sc("<3 4>")'), /\.sc\(mini\("<3 4>", \d+\)\)/);
});

// ---------------------------------------------------------------------------------------------
// Prefix independence. isPatternPosition's `before` patterns are all anchored to its end, so it
// only ever looks at the code immediately around the literal - and tailWindow exploits that to
// avoid rescanning the whole buffer per literal (which cost ~75ms an eval on a patch carrying a
// captured plugin state, against the scheduler's 150ms lookahead). These pin the equivalence
// that shortcut depends on: whatever sits further left must not change the verdict.
// ---------------------------------------------------------------------------------------------

const BLOB = 'QUJD'.repeat(60 * 1024); // ~240kb, like a captured Serum state

test('a literal is judged the same however much code precedes it', () => {
  const cases = [
    ['n(', '")'],                              // first argument to a builder
    ['synth(', '")'],                          // ...to a name-only call
    ['.speed(', '")'],                         // chain method
    ['.param("Filter Freq", ', ')'],           // later argument that IS a pattern
    ['synth("Serum 2", ', ')'],                // later argument of a name-only call
    ['choose([', ', 3])'],                     // the option in an [option, weight] pair
    ['const p = ', ';'],                       // outside argument position
    ['n("0" + ', ')'],                         // part of a larger expression
    ['', '.fast(2)'],                          // a string that chains a method
    ['f(g(), ', ')'],                          // nearest paren going left is a close paren
  ];
  for (const [before, after] of cases) {
    const bare = isPatternPosition(before, after);
    for (const prefix of [`x = "${BLOB}"; `, `synth("S", { state: "${BLOB}" })\n`, '  \n\t']) {
      assert.equal(isPatternPosition(prefix + before, after), bare, `"${before}" ~ "${after}" after ${prefix.length}b`);
    }
  }
});

test('a state blob neither gets wrapped nor hides the literals after it', () => {
  const code = `n("0 3").synth("Serum 2", { state: "${BLOB}" }).param("Cutoff", "0.2 0.8").speed("1 2")`;
  const out = injectLocations(code, 0);
  assert.ok(!out.includes(`mini("${BLOB}"`), 'the blob is data, not a pattern');
  assert.match(out, /n\(mini\("0 3", \d+\)\)/);
  assert.ok(!/mini\("Serum 2"/.test(out) && !/mini\("Cutoff"/.test(out), 'names stay names');
  assert.match(out, /\.param\("Cutoff", mini\("0\.2 0\.8", \d+\)\)/);
  assert.match(out, /\.speed\(mini\("1 2", \d+\)\)/);
});

test('transpiling a buffer with a big blob stays off the scheduler\'s critical path', () => {
  const code = `n("0 3").synth("Serum 2", { state: "${BLOB}" }).param("Cutoff", "0.2 0.8").speed("1 2")`;
  injectLocations(code, 0); // warm
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) injectLocations(code, 0);
  const ms = (performance.now() - t0) / 5;
  // Was ~30ms for this size before tailWindow, and grew linearly with the blob. The bound is
  // deliberately loose - it's here to catch a return to scanning the buffer per literal.
  assert.ok(ms < 5, `injectLocations took ${ms.toFixed(1)}ms on a ${(code.length / 1024) | 0}kb buffer`);
});

// The editor WRITES definitions into the buffer by itself (a bare pianoroll()/lfo() gets a name and
// a definition), and hides them - so a transpile that rewrites one is a break in code the player
// cannot see to fix. Every definition builder's arguments are a name and drawn data, never a
// pattern; this is the guard that a new one gets registered in NAME_ARG_CALLS before it ships.
test('a definition the editor writes is never rewritten by the transpile', () => {
  for (const src of [
    '_roll("lead", "60,0,4 62,1,2")',
    '_roll(0, "60,0,4", { grid: 16 })',
    '_shape("swell", "0,0,2 0.7,1 1,0")',
    '_shape("swell", "0,0 0.5,1 1,0")',
    '_preset("growl", "Serum 2", "H4sIAAAAAAAA")',
    '_preset("growl", "", "")',
  ]) {
    assert.equal(injectLocations(src, 0), src, `${src} carries a name and data, not patterns`);
  }
});

test('a pattern of NAMES is tagged for highlighting; the drawn data beside it is not', () => {
  // pianoroll() and lfo() take either drawn data or a pattern of names in the same position, and
  // the names are what is worth lighting up: it is how you see which roll or shape is running.
  assert.equal(injectLocations('pianoroll("<lead pad>")', 0), 'pianoroll(mini("<lead pad>", 11))');
  assert.equal(injectLocations('lfo("<pluck swell>")', 0), 'lfo(mini("<pluck swell>", 5))');
  assert.equal(injectLocations('lfo("<a b>", { rate: 2 })', 0), 'lfo(mini("<a b>", 5), { rate: 2 })');
  // ...and the drawn data is left exactly alone, in either call.
  assert.equal(injectLocations('pianoroll("60,0,4 62,1,2")', 0), 'pianoroll("60,0,4 62,1,2")');
  assert.equal(injectLocations('lfo("0,0 0.5,1 1,0")', 0), 'lfo("0,0 0.5,1 1,0")');
  // .preset() has only the one form - its argument is always names - so it needs no entry in
  // NAME_ARG_CALLS at all, and the default (everything is a pattern) is already right.
  assert.equal(injectLocations('.preset("<init growl>")', 0), '.preset(mini("<init growl>", 9))');
});
