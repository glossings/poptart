// Sampler controls as top-level builders - Strudel's "control patterns". `speed("-1")` names the
// speed CHANNEL rather than a value stream, so a combinator handed a whole pattern can still aim at
// one channel of it: x.mul(speed("-1")). Pure pattern math - no scheduler/engine boot.

import test from 'node:test';
import assert from 'node:assert/strict';

import { n, s, note, rand, speed, flip, begin, fit, i, sine, vel, clip, env } from './src/signal.mjs';

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
  assert.equal(cfgAt(up, 'note', 0), 67, 'unset note is 60 ("c3", as recorded), so +7 = 67');
  assert.deepEqual(up.stepsForCycle(0).map((x) => x.value), ['rave'], 'the pack name survives');
  // The same thing said with a note() operand, Strudel's combinator idiom.
  assert.equal(cfgAt(s('rave').add(note(7)), 'note', 0), 67);
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
  assert.equal(cfgAt(track, 'note', 0.25), 60);
  assert.equal(cfgAt(track, 'note', 0.75), 67);
});

test('a synth pattern is untouched - arithmetic there is still plain value math', () => {
  assert.deepEqual(n('0 1').add(12).stepsForCycle(0).map((x) => x.value), [12, 13]);
  assert.deepEqual(note('c3').add(note(3)).stepsForCycle(0).map((x) => x.value), [63]);
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

test('the chain stays unconditional, but the channel strip switches with the condition', () => {
  const track = s('bd').when('<1 0>', (x) => x.fx('Reverb').gain(0.5));
  assert.deepEqual(track.fxChain, ['Reverb'], 'an .fx() the callback added applies to the track');
  assert.equal(track.channel.gain.sample(0.5, 1, 0.5), 0.5, 'the bar the condition picks');
  assert.equal(track.channel.gain.sample(1.5, 1, 1.5), 1, 'and gain 1 - the default - on the rest');
});

test('a strip control the callback changes falls back to the value it had, not to nothing', () => {
  // The reported bug: `.pan(-0.49).when(rand().gte(0.99), x => x.pan(0.49))` panned every hat
  // right, because the whole strip came off the transformed side unconditionally.
  const track = s('hh*16').pan(-0.49).when(rand().gte(0.99), (x) => x.pan(0.49));
  const pans = [];
  for (let cycle = 0; cycle < 40; cycle++) {
    for (let k = 0; k < 16; k++) {
      const pos = cycle + (k + 0.5) / 16;
      pans.push(track.channel.pan.sample(pos, 1, pos));
    }
  }
  assert.deepEqual([...new Set(pans)].sort(), [-0.49, 0.49], 'only the two panning positions');
  assert.ok(pans.filter((v) => v === 0.49).length / pans.length < 0.1, 'and the 1% one stays rare');
});

test('a strip control switches on the same onsets the notes read the condition on', () => {
  const track = s('hh*4').pan(-1).when('1 0 1 0', (x) => x.pan(1));
  assert.deepEqual(
    Array.from({ length: 4 }, (_, k) => track.channel.pan.sample((k + 0.5) / 4, 1, (k + 0.5) / 4)),
    [1, -1, 1, -1],
  );
});

test("a strip control a native modulator drives keeps the callback's version", () => {
  // An env() gain is programmed into the engine once, not polled, so it can't follow a condition -
  // wrapping it would demote it to a JS-sampled signal that env() can't even answer.
  const track = s('bd').gain(env()).when('<1 0>', (x) => x.gain(0.5));
  assert.ok(track.channel.gain.envIR, 'still the native env gain');
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

// ---------------------------------------------------------------------------------------------
// A control at the HEAD of the chain (vel("1!4").s("bd")) - a channel plus a trigger grid
// ---------------------------------------------------------------------------------------------

// The grid + channel shape a head-position control has to produce, read the way the scheduler
// reads it: one entry per event, with its velocity and its repitch note.
const eventsOf = (sig) =>
  sig.stepsForCycle(0).filter((x) => x.value != null).map((x) => ({ at: x.start, value: x.value, vel: x.vel, note: x.cfg?.note }));

test('a head-position vel triggers the pattern and keeps its velocities', () => {
  // The reported bug: the velocities were read as the pattern's own values, so each kick played at
  // MIDI note 1 (59 semitones below native speed) with the velocity dropped.
  const track = vel('1!4').s('bd');
  assert.deepEqual(eventsOf(track), eventsOf(note('c3').vel('1!4').s('bd')), 'exactly s("bd").vel("1!4")');
  assert.deepEqual(eventsOf(track), [
    { at: 0, value: 'bd', vel: 1, note: 60 },
    { at: 0.25, value: 'bd', vel: 1, note: 60 },
    { at: 0.5, value: 'bd', vel: 1, note: 60 },
    { at: 0.75, value: 'bd', vel: 1, note: 60 },
  ]);
  assert.equal(track.noteChannels.vel.sample(0, 1, 0), 1, 'and the channel is set, not just the steps');
});

test('a pitch after a head-position vel keeps both grids', () => {
  // The second reported bug: .note() replaced the trigger grid and the velocities went with it,
  // leaving one kick per bar instead of four.
  const track = vel('1!4').note('c3').s('bd');
  assert.deepEqual(eventsOf(track), eventsOf(note('c3').vel('1!4').s('bd')));
  assert.equal(track.stepsForCycle(0).length, 4, 'four kicks, not one');
  // An explicit pitch is the pitch that plays - the default only stands in when none is given.
  assert.deepEqual(eventsOf(vel('1!4').note('C4').s('bd')).map((e) => e.note), [72, 72, 72, 72]);
});

test('a head-position control with no pitch plays at native speed', () => {
  // 60 ("c3") is the note a sample plays back as recorded, the same default a note-less synth("X")
  // gets - so a drum hit with no note is a drum hit, not a pitched-down one.
  for (const track of [vel('1!4').s('bd'), vel(0.6).s('bd'), speed('2').s('bd'), clip('1 2').note('c3').s('bd')]) {
    assert.deepEqual(new Set(eventsOf(track).map((e) => e.note)), new Set([60]));
  }
});

test('a head-position sampler control lands on its channel, like the method form', () => {
  assert.equal(cfgAt(speed('2').s('bd'), 'speed', 0), 2);
  assert.equal(cfgAt(begin(0.5).s('bd'), 'begin', 0), 0.5);
  assert.equal(cfgAt(i('3').s('bd'), 'index', 0), 3);
  assert.equal(fit().s('breaks').sampler.fit, 'auto', 'bare fit() sets the auto mode, as .fit() does');
  // A patterned control gives structure the same way .speed("1 -1") does.
  const swept = speed('1 -1').s('bd');
  assert.deepEqual(swept.stepsForCycle(0).map((x) => x.start), [0, 0.5]);
  assert.equal(cfgAt(swept, 'speed', 0.75), -1);
});

test('a continuous head-position control gets one event per cycle', () => {
  // vel(0.6) has no grid to trigger from, so it takes the whole-cycle note a note-less synth("X")
  // takes and the channel is sampled at that onset.
  const track = vel(0.6).s('bd');
  assert.deepEqual(track.stepsForCycle(0).map((x) => [x.start, x.end]), [[0, 1]]);
  assert.equal(track.noteChannels.vel.sample(0, 1, 0), 0.6);
});

test('rests in a head-position control stay rests', () => {
  assert.deepEqual(eventsOf(vel('1 ~ 1 1').s('bd')).map((e) => e.at), [0, 0.5, 0.75]);
});

test('a head-position vel on a synth track plays the default note at those velocities', () => {
  const track = vel('1 0.5').synth('Serum 2');
  assert.equal(track.instrument, 'Serum 2');
  assert.deepEqual(track.stepsForCycle(0).map((x) => [x.value, x.vel]), [[60, 1], [60, 0.5]]);
});

test('a control is still an operand, not a head - both readings stay available', () => {
  // The tag means "this names a channel"; which channel it lands on is decided by where it appears.
  assert.equal(cfgAt(s('bd').mul(speed('-1')), 'speed', 0), -1, 'as an operand it reaches into the pattern');
  assert.equal(cfgAt(speed('-1').s('bd'), 'speed', 0), -1, 'at the head it sets its own');
});
