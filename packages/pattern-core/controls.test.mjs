// Sampler controls as top-level builders - Strudel's "control patterns". `speed("-1")` names the
// speed CHANNEL rather than a value stream, so a combinator handed a whole pattern can still aim at
// one channel of it: x.mul(speed("-1")). Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, s, note, rand, speed, flip, begin, fit, i, sine } from './src/signal.mjs';

// What the scheduler would read off a sampler channel at a given cycle position.
const cfgAt = (sig, key, cyclePos) => sig.sampler[key].sample(cyclePos, 1, cyclePos);

// ---------------------------------------------------------------------------------------------
// The builders, and arithmetic aimed through them
// ---------------------------------------------------------------------------------------------

test('a control operand lands on its channel, not on the pattern values', () => {
  const track = s('breaks:19').fit().mul(speed('-1'));
  assert.equal(cfgAt(track, 'speed', 0), -1, 'unset speed reads as 1, so 1 * -1 = -1');
  assert.equal(track.sampler.fit, 'auto', 'the rest of the sampler config is untouched');
  // The pack name still sounds - the arithmetic never touched the value stream.
  assert.deepEqual(track.stepsForCycle(0).map((x) => x.value), ['breaks:19']);
});

test('a control combines with the channel already set, rather than replacing it', () => {
  assert.equal(cfgAt(s('bd').speed(2).mul(speed(-1)), 'speed', 0), -2);
  assert.equal(cfgAt(s('bd').begin(0.25).add(begin(0.5)), 'begin', 0), 0.75);
  // Unset defaults are the engine's own: speed/stretch 1, begin 0, end 1.
  assert.equal(cfgAt(s('bd').add(begin(0.5)), 'begin', 0), 0.5);
  assert.equal(cfgAt(s('bd').add(i(3)), 'index', 0), 3, 'an unset index is 0, so 0 + 3 = 3');
});

test('an unset channel takes the structure of the operand, as the method form would', () => {
  const track = s('bd').mul(speed('1 -1'));
  assert.deepEqual(track.stepsForCycle(0).map((x) => x.start), [0, 0.5], 'the control subdivides');
  assert.equal(cfgAt(track, 'speed', 0.25), 1);
  assert.equal(cfgAt(track, 'speed', 0.75), -1);
});

test('controls take whatever a signal takes - numbers, mini strings, LFOs', () => {
  assert.equal(cfgAt(s('bd').mul(speed(2)), 'speed', 0), 2);
  assert.equal(cfgAt(s('bd').mul(speed('2')), 'speed', 0), 2);
  const swept = s('bd').mul(speed(sine(0.25).range(1, 3)));
  assert.ok(cfgAt(swept, 'speed', 0) >= 1 && cfgAt(swept, 'speed', 0) <= 3);
});

test('flip is a channel like any other - bare, patterned, or as an operand', () => {
  assert.equal(cfgAt(s('sd').flip(), 'flip', 0), 1, 'bare .flip() means on');
  const alternating = s('sd').flip('<1 0>');
  assert.equal(cfgAt(alternating, 'flip', 0), 1);
  assert.equal(cfgAt(alternating, 'flip', 1), 0);
  // Unset is 0 (off), so an operand can switch it on from outside the chain.
  assert.equal(cfgAt(s('sd').add(flip(1)), 'flip', 0), 1);
});

test('fit() with no argument sets the auto mode rather than doing arithmetic', () => {
  assert.equal(s('breaks').mul(fit()).sampler.fit, 'auto');
  assert.equal(cfgAt(s('breaks').mul(fit(2)), 'fit', 0), 2);
});

test('a control aimed at a non-sampler pattern says so', () => {
  assert.throws(() => note('c3').mul(speed(-1)), /only applies to a sampler pattern/);
});

// ---------------------------------------------------------------------------------------------
// Bare arithmetic on a sampler = the repitch note (the values are pack NAMES)
// ---------------------------------------------------------------------------------------------

test('arithmetic on a sampler pattern repitches instead of mangling the pack name', () => {
  const up = s('rave').add(7);
  assert.equal(cfgAt(up, 'note', 0), 31, 'unset note is 24 ("c2", as recorded), so +7 = 31');
  assert.deepEqual(up.stepsForCycle(0).map((x) => x.value), ['rave'], 'the pack name survives');
  // The same thing said with a note() operand, Strudel's combinator idiom.
  assert.equal(cfgAt(s('rave').add(note(7)), 'note', 0), 31);
  // An existing repitch is the left operand.
  assert.equal(cfgAt(s('rave').note(36).add(12), 'note', 0), 48);
});

test('the repitch channel keeps its note/degree kind through the arithmetic', () => {
  assert.equal(s('rave').add(7).sampler.note.pitchKind, 'note');
  assert.equal(s('rave').n('0 2').add(1).sampler.note.pitchKind, 'degree');
});

test('a patterned operand gives the sampler pattern its structure', () => {
  const track = s('rave').add(note('0 7'));
  assert.deepEqual(track.stepsForCycle(0).map((x) => x.start), [0, 0.5]);
  assert.equal(cfgAt(track, 'note', 0.25), 24);
  assert.equal(cfgAt(track, 'note', 0.75), 31);
});

test('a synth pattern is untouched - arithmetic there is still plain value math', () => {
  assert.deepEqual(n('0 1').add(12).stepsForCycle(0).map((x) => x.value), [12, 13]);
  assert.deepEqual(note('c3').add(note(3)).stepsForCycle(0).map((x) => x.value), [39]);
});

// ---------------------------------------------------------------------------------------------
// .when() switches per-onset controls with the condition
// ---------------------------------------------------------------------------------------------

test('.when() turns a control on only where the condition is truthy', () => {
  const track = s('bd*2').when('1 0', (x) => x.mul(speed('-1')));
  assert.equal(cfgAt(track, 'speed', 0.0), -1, 'first half: the speed the callback set');
  assert.equal(cfgAt(track, 'speed', 0.5), null, 'second half: unset, so the engine default');
});

test('.when() over a whole-cycle condition switches bar by bar', () => {
  const track = s('bd').when('<1 0>', (x) => x.mul(speed('-1')));
  assert.equal(cfgAt(track, 'speed', 0.5), -1);
  assert.equal(cfgAt(track, 'speed', 1.5), null);
});

test('.when() keeps a control that both sides share', () => {
  // .add(), not .mul(): begin's resting default is 0, so a multiply into an unset begin channel
  // is 0 (see _ctlBinop - a control combines with what's there, it doesn't replace it).
  const track = s('bd').speed(2).when('<1 0>', (x) => x.add(begin(0.5)));
  assert.equal(cfgAt(track, 'speed', 0.5), 2);
  assert.equal(cfgAt(track, 'speed', 1.5), 2, 'speed was never conditional');
  assert.equal(cfgAt(track, 'begin', 0.5), 0.5);
  assert.equal(cfgAt(track, 'begin', 1.5), null);
});

test('the incoming events read the condition - .seg(8) means eight reads a bar', () => {
  // The pattern arriving from outside the .when() owns the structure, so eight steps means eight
  // reads and the switch can flip several times within one cycle.
  const cond = sine(1).gte(0.5); // deterministic, and crosses the threshold mid-bar
  const track = s('breaks:19').fit().seg(8).when(cond, (x) => x.mul(speed('-1')));
  const speeds = Array.from({ length: 8 }, (_, k) => cfgAt(track, 'speed', (k + 0.5) / 8));
  assert.deepEqual(
    speeds,
    Array.from({ length: 8 }, (_, k) => (Number(cond.sample(k / 8, 1)) ? -1 : null)),
    'each eighth follows the condition read at its own onset',
  );
  assert.ok(speeds.includes(-1) && speeds.includes(null), 'and it switches within the bar');
  // The note grid agrees with the controls - eight events either way, none split by the switch.
  assert.equal(track.stepsForCycle(0).length, 8);
});

test('a condition with its own triggers adds none of them to the pattern', () => {
  // "1 0 1 0" would once have chopped a single hit into four. The condition is read, never
  // played: one incoming event, one read, one event out.
  const track = s('bd').when('1 0 1 0', (x) => x.mul(speed('-1')));
  assert.equal(track.stepsForCycle(0).length, 1, 'still one hit');
  assert.equal(cfgAt(track, 'speed', 0), -1, 'decided once, at the hit');
  // Same condition under eight incoming events: now it has eight instants to be read at.
  const eighths = s('bd*8').when('1 0 1 0', (x) => x.mul(speed('-1')));
  assert.deepEqual(
    Array.from({ length: 8 }, (_, k) => cfgAt(eighths, 'speed', k / 8)),
    [-1, -1, null, null, -1, -1, null, null],
  );
  assert.equal(eighths.stepsForCycle(0).length, 8);
});

test('a run of agreeing steps leaves the callback\'s own longer notes whole', () => {
  // The condition spans coalesce where their truthiness agrees, so a callback that lengthens
  // events (.slow(2) here) is not chopped back into one event per step of the source grid.
  const track = n('0 1 2 3').when(1, (x) => x.slow(2));
  assert.deepEqual(track.stepsForCycle(0).map((x) => [x.start, x.end]), [[0, 0.5], [0.5, 1]]);
});

test('the chain and streamed channel strip stay unconditional, as documented', () => {
  const track = s('bd').when('<1 0>', (x) => x.fx('Reverb').gain(0.5));
  assert.deepEqual(track.fxChain, ['Reverb']);
  assert.equal(track.channel.gain.sample(1.5, 1, 1.5), 0.5, 'gain is not switched');
});

// ---------------------------------------------------------------------------------------------
// The reported bug, end to end
// ---------------------------------------------------------------------------------------------

test('the reported pattern builds and reverses only the bars the condition picks', () => {
  const track = s('breaks:19')
    .fit()
    .when(rand().gte(0.7), (x) => x.mul(speed('-1')))
    .when(rand().gte(0.5), (x) => x.ply('4'));
  const speeds = [];
  for (let cycle = 0; cycle < 16; cycle++) speeds.push(cfgAt(track, 'speed', cycle + 0.1));
  assert.ok(speeds.some((v) => v === -1), 'some bars play backwards');
  assert.ok(speeds.some((v) => v === null), 'and some play forwards');
  // .ply("4") took its count from the pattern (a mini signal), not from a NaN coerced to 1.
  const counts = new Set(Array.from({ length: 16 }, (_, c) => track.stepsForCycle(c).length));
  assert.ok(counts.has(4), 'the plied bars have four events');
});
