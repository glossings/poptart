// s() / se() / sr() are one sampler with three ways of naming what it plays. The scheduler is
// where the choice becomes visible: it stamps a namespace onto the value before handing it to the
// engine, and only a pack takes the ":n" index suffix - for an exact file or a recording, a ":"
// belongs to the name. Everything else about the three has to stay identical, which is most of
// what these tests check.

import test from 'node:test';
import assert from 'node:assert/strict';

import { s, se, sr, sp, say, note, speed, mini } from './src/signal.mjs';
import { Scheduler } from './src/scheduler.mjs';

function mockEngine() {
  const calls = [];
  const engine = new Proxy(
    { getTime: () => 0 },
    { get: (t, p) => (p in t ? t[p] : (...args) => { calls.push({ method: p, args }); }) },
  );
  return { engine, callsTo: (method) => calls.filter((c) => c.method === method) };
}

// The lookahead walk over the first `cycles` cycles (cycle 0 alone by default).
function play(sig, cycles = 1) {
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  sch._scheduleNoteEdges(0, cycles);
  return callsTo('playSample');
}

const refs = (sig) => play(sig).map((c) => c.args[1]);
const cfgs = (sig) => play(sig).map((c) => c.args[2]);

test('s() sends a bare pack name, as it always has', () => {
  assert.deepEqual(refs(s('bd sn')), ['bd', 'sn']);
});

test('se() and sr() namespace the value', () => {
  assert.deepEqual(refs(se("'drums/kick.wav'")), ['file:drums/kick.wav']);
  assert.deepEqual(refs(sr('bass')), ['rec:bass']);
});

test('only a pack splits the ":n" index suffix off the value', () => {
  assert.deepEqual(refs(s('bd:4')), ['bd']);
  assert.equal(cfgs(s('bd:4'))[0].index, 4);
  // An exact file addresses one file - there is no index to pick, so a ":" is part of the name.
  assert.deepEqual(refs(se("'odd:name.wav'")), ['file:odd:name.wav']);
  assert.equal(cfgs(se("'odd:name.wav'"))[0].index, undefined);
  assert.deepEqual(refs(sr('take:2')), ['rec:take:2']);
});

test('an explicit .i() still wins over a pack suffix', () => {
  assert.equal(cfgs(s('bd:4').i(7))[0].index, 7);
});

test('sp() namespaces a named pack and takes the index suffix like s()', () => {
  assert.deepEqual(refs(sp('kit kit2')), ['sp:kit', 'sp:kit2']);
  assert.deepEqual(refs(sp('kit:3')), ['sp:kit']);
  assert.equal(cfgs(sp('kit:3'))[0].index, 3);
  assert.equal(cfgs(sp('kit:3').i(5))[0].index, 5);
  // The method form, like .s(): the notes own the grid, the name rides along - and a Sig argument
  // (what the editor's transpile hands over for any "<…>" string) is a pattern of names.
  assert.deepEqual(refs(note('c e g').sp('kit')), ['sp:kit', 'sp:kit', 'sp:kit']);
  assert.deepEqual(refs(note('c e').sp(mini('<kit kit2>'))), ['sp:kit', 'sp:kit']);
});

test('the sampler config works identically on all three', () => {
  for (const sig of [s('bd'), se("'a.wav'"), sr('bass')]) {
    const cfg = cfgs(sig.speed(2).begin(0.25))[0];
    assert.equal(cfg.speed, 2);
    assert.equal(cfg.begin, 0.25);
  }
});

test('se()/sr() patterns sequence and stack like s()', () => {
  assert.deepEqual(refs(se("'a.wav' 'b.wav'")), ['file:a.wav', 'file:b.wav']);
  assert.equal(refs(sr('bass*2')).length, 2);
});

test('.slow() gives a bounce one event spanning the whole loop', () => {
  // What the recorder writes into the buffer: sr("x").slow(8) must be ONE event per 8 cycles,
  // not eight retriggers - otherwise the bounce restarts every cycle.
  const sig = sr('bass').slow(8);
  const { engine, callsTo } = mockEngine();
  const sch = new Scheduler(engine, { trackId: 't', cps: 1 });
  sch.setPattern(sig);
  for (let cycle = 0; cycle < 8; cycle++) sch._scheduleNoteEdges(cycle, cycle + 1);
  const played = callsTo('playSample');
  assert.equal(played.length, 1, 'one onset across the eight cycles');
  const [, , , onsetSec, offsetSec] = played[0].args;
  assert.equal(onsetSec, 0);
  assert.equal(offsetSec, 8, 'the event is as long as the recording');
});

test('a bounce plays at its native rate - no fit unless asked for', () => {
  // fit is what would time-stretch the file; an unset fit must stay absent so a bounce recorded
  // at this tempo plays back exactly as recorded.
  assert.equal(cfgs(sr('bass').slow(8))[0].fit, undefined);
});

test('the source kind survives the transforms that rebuild a pattern', () => {
  // Every one of these builds a NEW Sig rather than mutating - the kind has to be carried through
  // each, or a transformed bounce would be looked up as a pack name and silently not play.
  assert.deepEqual(refs(sr('bass').fast(2)), ['rec:bass', 'rec:bass']);
  assert.deepEqual(refs(se("'a.wav'").speed(speed(2))), ['file:a.wav']);
  assert.equal(sr('bass').slow(2).samplerKind, 'rec');
  assert.equal(sr('bass').seg(4).samplerKind, 'rec');
  assert.equal(se("'a.wav'").when('1', (x) => x.speed(2)).samplerKind, 'file');
});

test('the method forms name their own source kind', () => {
  assert.deepEqual(refs(note('c5').se('hits/stab.wav')), ['file:hits/stab.wav']);
  assert.deepEqual(refs(note('c5').sr('stab')), ['rec:stab']);
  assert.deepEqual(refs(note('c5').s('rave')), ['rave']);
});

test('the method form takes a literal path - only the builder parses mini', () => {
  // .se("a/b.wav") is one name, not a pattern, so it needs no quoting; se("'a/b.wav'") is a mini
  // string, where an unquoted "/" would read as the slow operator. Mixing them up is easy, so the
  // method rejects the quotes rather than looking for a file called "'a/b.wav'".
  assert.deepEqual(refs(note('c5').se('a/b.wav')), ['file:a/b.wav']);
  assert.throws(() => note('c5').se("'a/b.wav'"), /takes a sample file path/);
  assert.throws(() => note('c5').sr("'stab'"), /takes a recording name/);
});

test('the builders take the same inputs s() does', () => {
  assert.throws(() => se({}), /takes a number, a mini-notation string, or a signal/);
  assert.throws(() => sr([]), /takes a number, a mini-notation string, or a signal/);
});

const US = '\u001f'; // between a spoken step's voice and its text

test('say() reads its text as speech: prose punctuation stays in the word, mini structure still works', () => {
  // "i", "r" and "p" are words, not mini's random functions (2026-10-22).
  assert.deepEqual(refs(say('hi i am glossing')), ['say:hi', 'say:i', 'say:am', 'say:glossing']);
  // Apostrophes, commas, a bare "?", a slash between words and a colon are all part of the word.
  assert.deepEqual(refs(say("hey, i'm r p ok? and/or 3:30")), ['say:hey,', "say:i'm", 'say:r', 'say:p', 'say:ok?', 'say:and/or', 'say:3:30']);
  assert.equal(cfgs(say('3:30'))[0].index, undefined, 'a colon is part of the text, never an index');
  // ...and so is anything mini has no character for.
  assert.deepEqual(refs(say('café (laughs) C++ & 007')), ['say:café', 'say:(laughs)', 'say:C++', 'say:&', 'say:007']);
  assert.throws(() => say('   '), /needs some text/);
  // "~" is a rest, not the word "tilde".
  assert.deepEqual(refs(say('hi ~ there')), ['say:hi', 'say:there']);
  // Operators with their operand glued on: weight, fast, replicate, a tie, a euclid.
  assert.deepEqual(play(say('hi@3 there')).map((c) => c.args[3]), [0, 0.75]);
  assert.deepEqual(refs(say('hi*2 yeah!2')), ['say:hi', 'say:hi', 'say:yeah', 'say:yeah']);
  assert.deepEqual(play(say('hi _ _ bye')).map((c) => c.args[3]), [0, 0.75]);
  assert.deepEqual(refs(say('hi.e(3,8)')), ['say:hi', 'say:hi', 'say:hi']);
  // A spaced comma stacks; a glued one is a comma.
  assert.deepEqual(refs(say('[hi , bye]')).sort(), ['say:bye', 'say:hi']);
  // A glued function call is still one: i(1,10) says a random number.
  assert.match(refs(say('i(1,10)'))[0], /^say:([1-9]|10)$/);
  // Alternation with held items says each word once, at its onset.
  assert.deepEqual(play(say('<hi@2 bye ~>'), 4).map((c) => [c.args[1], c.args[3]]), [['say:hi', 0], ['say:bye', 2]]);
  // ...and a pattern argument is still a pattern.
  assert.deepEqual(refs(say(mini('<hi bye>*2'))), ['say:hi', 'say:bye']);
});

test('say()\'s voice is a pattern read at each word', () => {
  assert.deepEqual(refs(say('one two', 'Whisper')), [`say:Whisper${US}one`, `say:Whisper${US}two`]);
  assert.deepEqual(refs(say('one two', mini('Whisper Zarvox'))), [`say:Whisper${US}one`, `say:Zarvox${US}two`]);
  // A voice pattern adds no steps of its own: two voices over one word still say it once.
  assert.deepEqual(refs(say('one', mini('Whisper Zarvox'))), [`say:Whisper${US}one`]);
  assert.deepEqual(refs(say('one', mini("'Bad News'"))), [`say:Bad News${US}one`]);
  // A colon in the text is not a voice.
  assert.deepEqual(refs(say('3:30', 'Whisper')), [`say:Whisper${US}3:30`]);
});

test('say() keeps its kind through transforms, and its method form repitches', () => {
  assert.deepEqual(refs(say('hi', 'Whisper').fast(2)), [`say:Whisper${US}hi`, `say:Whisper${US}hi`]);
  assert.equal(say('hi').slow(2).samplerKind, 'say');
  const played = play(note('c5 e5').say('hi', 'Whisper'));
  assert.deepEqual(played.map((c) => c.args[1]), [`say:Whisper${US}hi`, `say:Whisper${US}hi`]);
  assert.deepEqual(played.map((c) => c.args[2].note), [84, 88]);
  assert.deepEqual(refs(note('c5').say(mini('<hi bye>'))), ['say:hi']);
  // The method form says its whole literal phrase on every note, quotes and all.
  assert.deepEqual(refs(note('c5').say("hi, i'm dreamin'")), ["say:hi, i'm dreamin'"]);
});
