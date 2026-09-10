// clips(): the track whose notes come from the arrangement's clips, each roll played from its own
// clip's start. The format's `r`/`o` fields, the clip-local time that makes a part dropped at bar
// 33 start from its beginning, and the two rules at a clip's edge.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _roll,
  clips,
  clipsOfLabel,
  parseArrangement,
  serializeArrangement,
  looksLikeArrangeString,
  setClipsOwner,
  setClipsResolver,
  ArrangeClock,
} from './src/index.mjs';

// The host's job, in four lines: a clips() head asks (deck, label) what is painted on its row.
const paint = (str, { posAt = null, arranged = true } = {}) => {
  const all = parseArrangement(str);
  setClipsResolver((deck, label) => ({ clips: clipsOfLabel(all, label), posAt, arranged }));
  return all;
};

const headFor = (label, deck = 'a') => {
  setClipsOwner(deck, label);
  const sig = clips();
  setClipsOwner('a', null);
  return sig;
};

/** The notes a cycle plays, as [start, note] pairs - what the scheduler would fire. */
const at = (sig, cycle) => sig.stepsForCycle(cycle)
  .filter((s) => s.value != null)
  .map((s) => [Math.round(s.start * 1e6) / 1e6, s.value]);

test('the clip format carries a roll and an offset into it, and nothing else', () => {
  const parsed = parseArrangement('kick,0,4,rverse kick,8,4,rverse,o4 kick,16,2,m,rfill hat,0,4');
  assert.deepEqual(parsed, [
    { label: 'kick', start: 0, len: 4, roll: 'verse' },
    { label: 'kick', start: 8, len: 4, roll: 'verse', off: 4 },
    { label: 'kick', start: 16, len: 2, mute: true, roll: 'fill' },
    { label: 'hat', start: 0, len: 4 },
  ]);
  assert.equal(serializeArrangement(parsed), 'hat,0,4 kick,0,4,rverse kick,8,4,rverse,o4 kick,16,2,m,rfill');
  assert.ok(looksLikeArrangeString('kick,8,4,rverse,o4 kick,16,2,m,rfill'), 'the editor still folds it as clip data');

  // The extras are TAGGED, so the retired lane column is still malformed rather than read as an
  // offset - and an unknown tag costs its own clip, never the whole arrangement.
  assert.deepEqual(parseArrangement('kick,0,8,4'), [], 'a bare number is not an extra');
  assert.deepEqual(parseArrangement('kick,0,8,x1'), [], 'nor is an unknown tag');
  assert.deepEqual(parseArrangement('kick,0,8,m,m'), [], 'nor the same one twice');
  assert.deepEqual(parseArrangement('kick,0,8,ra kick,0,8'), [
    { label: 'kick', start: 0, len: 8, roll: 'a' },
    { label: 'kick', start: 0, len: 8 },
  ], 'a clip with no extras is the same three-key object it always was');
  assert.deepEqual(parseArrangement('kick,0,8,ra,o0'), [{ label: 'kick', start: 0, len: 8, roll: 'a' }],
    'a zero offset is spelled by leaving it out');
  assert.equal(serializeArrangement([{ label: 'k', start: 0, len: 4, off: 2 }]), 'k,0,4',
    'an offset with no roll to be into is not written');
});

test('each clip plays its own roll, from where the clip starts', () => {
  _roll('verse', '60,0,1 62,2,1', { grid: 4 });
  _roll('chorus', '70,1,1', { grid: 4 });
  paint('kick,0,2,rverse kick,2,2,rchorus');
  const sig = headFor('kick');

  assert.deepEqual(at(sig, 0), [[0, 60], [0.5, 62]]);
  assert.deepEqual(at(sig, 1), [[0, 60], [0.5, 62]], 'a one-cycle roll repeats inside its clip');
  assert.deepEqual(at(sig, 2), [[0.25, 70]], 'the next clip is a different roll');
  assert.deepEqual(at(sig, 4), [], 'past the last clip the row is silent');
});

test('a multi-cycle roll starts at its clip, not wherever absolute time has got to', () => {
  // Two cycles long: 60 on its first bar, 62 on its second. Painted at bar 3 - an odd bar, so
  // absolute cycle time would land on the roll's SECOND bar and play 62 first.
  _roll('two', '60,0,1 62,4,1', { grid: 4, len: 8 });
  paint('lead,3,4,rtwo');
  const sig = headFor('lead');

  assert.deepEqual(at(sig, 3), [[0, 60]], 'the clip opens on the roll\'s first bar');
  assert.deepEqual(at(sig, 4), [[0, 62]]);
  assert.deepEqual(at(sig, 5), [[0, 60]], '...and round again');
  assert.deepEqual(at(sig, 6), [[0, 62]]);
  assert.deepEqual(at(sig, 7), [], 'the clip ends at bar 7');
});

test('splitting a clip changes nothing you hear - that is what the offset is for', () => {
  _roll('two', '60,0,1 62,4,1', { grid: 4, len: 8 });
  paint('lead,3,4,rtwo');
  const whole = [3, 4, 5, 6].map((c) => at(headFor('lead'), c));

  // The same clip cut at bar 5: the second piece starts two bars into the same roll.
  paint('lead,3,2,rtwo lead,5,2,rtwo,o2');
  const split = [3, 4, 5, 6].map((c) => at(headFor('lead'), c));
  assert.deepEqual(split, whole);
});

test('two clips can share one roll - the same notes, heard in both places', () => {
  _roll('verse', '60,0,1', { grid: 4 });
  paint('lead,0,1,rverse lead,4,1,rverse');
  const sig = headFor('lead');
  assert.deepEqual(at(sig, 0), [[0, 60]]);
  assert.deepEqual(at(sig, 4), [[0, 60]]);
  assert.deepEqual(at(sig, 2), []);
});

test('a note is cut at its clip\'s end, and rings on through a split', () => {
  _roll('long', '60,0,8', { grid: 4 }); // one note, two cycles long
  paint('pad,0,1,rlong');
  assert.deepEqual(headFor('pad').stepsForCycle(0).map((s) => [s.start, s.end, s.value]), [[0, 1, 60]],
    'the clip ends at bar 1, so the note does');

  // Split at bar 1: the same phase either side, so the join sees one child following itself and
  // the note rings its full length - a cut in the painter is not a cut in the sound.
  paint('pad,0,1,rlong pad,1,1,rlong,o1');
  assert.deepEqual(headFor('pad').stepsForCycle(0).map((s) => [s.start, s.end, s.value]), [[0, 2, 60]]);

  // ...but a DIFFERENT roll taking over cuts it where it takes over.
  _roll('short', '72,0,1', { grid: 4 });
  paint('pad,0,1,rlong pad,1,1,rshort');
  assert.deepEqual(headFor('pad').stepsForCycle(0).map((s) => [s.start, s.end, s.value]), [[0, 1, 60]]);
});

test('a muted clip sounds nothing, and a clip with no roll drawn yet is silence', () => {
  _roll('verse', '60,0,1', { grid: 4 });
  paint('lead,0,1,m,rverse lead,1,1 lead,2,1,rverse');
  const sig = headFor('lead');
  assert.deepEqual(at(sig, 0), [], 'muted');
  assert.deepEqual(at(sig, 1), [], 'painted, but nothing drawn in it yet');
  assert.deepEqual(at(sig, 2), [[0, 60]]);
});

test('with no arrangement at all a clips() track is silent, and says so', () => {
  const said = [];
  const warn = console.warn;
  console.warn = (msg) => said.push(String(msg));
  try {
    paint('', { arranged: false });
    const sig = headFor('lead');
    assert.deepEqual(at(sig, 0), []);
    at(sig, 1);
  } finally {
    console.warn = warn;
  }
  assert.equal(said.filter((m) => m.includes('clips()')).length, 1, 'once, not once a cycle');
  assert.match(said.join(' '), /ctrl\+A/);
});

test('the song clock is what the clips are placed against, so a loop region replays them', () => {
  _roll('a', '60,0,1', { grid: 4 });
  _roll('b', '70,0,1', { grid: 4 });
  paint('lead,0,1,ra lead,1,1,rb');
  const clock = new ArrangeClock({ len: 4, regions: [{ name: 'intro', start: 0, end: 2 }] });
  paint('lead,0,1,ra lead,1,1,rb', { posAt: (c) => clock.posAt(c) });
  const sig = headFor('lead');

  // The region wraps every two bars, so the two clips alternate forever rather than falling silent.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((c) => at(sig, c)), [
    [[0, 60]], [[0, 70]], [[0, 60]], [[0, 70]], [[0, 60]], [[0, 70]],
  ]);
});

test('a clips() with no row of its own says so rather than being silently mute', () => {
  const said = [];
  const warn = console.warn;
  console.warn = (msg) => said.push(String(msg));
  try {
    paint('lead,0,1,ra');
    setClipsOwner('a', null); // outside a labeled block - prebake, say
    const sig = clips();
    setClipsOwner('a', null);
    assert.deepEqual(at(sig, 0), []);
  } finally {
    console.warn = warn;
  }
  assert.match(said.join(' '), /has to be a labeled block/);
});

test('an unknown roll costs its own clip, once', () => {
  const said = [];
  const warn = console.warn;
  console.warn = (msg) => said.push(String(msg));
  try {
    _roll('here', '60,0,1', { grid: 4 });
    paint('lead,0,1,rgone lead,1,1,rhere lead,2,1,rgone');
    const sig = headFor('lead');
    assert.deepEqual(at(sig, 0), []);
    assert.deepEqual(at(sig, 1), [[0, 60]], 'the clips around it play');
    assert.deepEqual(at(sig, 2), []);
  } finally {
    console.warn = warn;
  }
  assert.equal(said.filter((m) => m.includes('"gone"')).length, 1);
});
