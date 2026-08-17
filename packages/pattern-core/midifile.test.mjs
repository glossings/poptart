// Dragging a .mid into the editor: reading the file, splitting it into lanes, choosing the grid
// its rhythm actually sits on, and guessing its key. The tests build MIDI files byte by byte
// rather than shipping binary fixtures, so what each case is claiming about the format is
// readable here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMidiFile,
  midiFileToLanes,
  midiLanesToPianoroll,
  pickGrid,
  detectKey,
  GRID_CANDIDATES,
} from './src/midifile.mjs';
import { recordingToMini, UNQUANTIZED_GRID } from './src/record.mjs';
import { pianoroll } from './src/signal.mjs';
import { parsePianoRoll } from './src/pianoroll.mjs';

// --- building test files -----------------------------------------------------------------------

const PPQ = 96;

function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}

function be(n, bytes) {
  const out = [];
  for (let i = bytes - 1; i >= 0; i--) out.push((n >> (i * 8)) & 0xff);
  return out;
}

function chunk(id, body) {
  return [...[...id].map((c) => c.charCodeAt(0)), ...be(body.length, 4), ...body];
}

/** `events` are {tick, bytes} - absolute ticks, turned into the file's delta times here. */
function track(events) {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const body = [];
  let prev = 0;
  for (const ev of sorted) {
    body.push(...vlq(ev.tick - prev), ...ev.bytes);
    prev = ev.tick;
  }
  body.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  return chunk('MTrk', body);
}

function midiFile(tracks, { format = 1, division = PPQ } = {}) {
  const header = chunk('MThd', [...be(format, 2), ...be(tracks.length, 2), ...be(division, 2)]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

const noteOn = (tick, midi, vel = 100, ch = 0) => ({ tick, bytes: [0x90 | ch, midi, vel] });
const noteOff = (tick, midi, ch = 0) => ({ tick, bytes: [0x80 | ch, midi, 0] });
const trackName = (name) => ({
  tick: 0,
  bytes: [0xff, 0x03, name.length, ...[...name].map((c) => c.charCodeAt(0))],
});
const tempo = (bpm) => ({ tick: 0, bytes: [0xff, 0x51, 0x03, ...be(Math.round(60e6 / bpm), 3)] });
const timeSig = (num, denPow) => ({ tick: 0, bytes: [0xff, 0x58, 0x04, num, denPow, 24, 8] });

/** One note per beat, c5 upward, over `beats` beats. */
function scaleTrack(beats, first = 60) {
  const evs = [];
  for (let i = 0; i < beats; i++) {
    evs.push(noteOn(i * PPQ, first + i), noteOff((i + 1) * PPQ - 1, first + i));
  }
  return evs;
}

// --- parsing -----------------------------------------------------------------------------------

test('parseMidiFile: header, tempo, time signature, and note times in beats', () => {
  const file = midiFile([track([tempo(140), timeSig(3, 2), ...scaleTrack(4)])]);
  const parsed = parseMidiFile(file);
  assert.equal(parsed.format, 1);
  assert.equal(Math.round(parsed.bpm), 140);
  assert.deepEqual(parsed.timeSig, { num: 3, den: 4 });
  assert.equal(parsed.tracks.length, 1);
  const notes = parsed.tracks[0].notes;
  assert.equal(notes.length, 4);
  assert.deepEqual(notes.map((n) => n.midi), [60, 61, 62, 63]);
  assert.deepEqual(notes.map((n) => n.start), [0, 1, 2, 3]);
  assert.ok(Math.abs(notes[0].end - 1) < 0.02); // note-off one tick before the beat
});

test('parseMidiFile: no tempo event means 120bpm and 4/4', () => {
  const parsed = parseMidiFile(midiFile([track(scaleTrack(2))]));
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.timeSig, { num: 4, den: 4 });
});

test('parseMidiFile: note-on with velocity 0 is a note-off, and velocity is scaled to 0..1', () => {
  const parsed = parseMidiFile(
    midiFile([track([noteOn(0, 60, 127), noteOn(PPQ, 60, 0), noteOn(PPQ, 64, 64)])]),
  );
  const [first, second] = parsed.tracks[0].notes;
  assert.equal(first.end, 1);
  assert.equal(first.vel, 1);
  assert.ok(Math.abs(second.vel - 64 / 127) < 1e-9);
});

test('parseMidiFile: running status carries the status byte across events', () => {
  // One 0x90 status, then bare data-byte pairs - how most files encode a run of notes.
  const body = [
    ...vlq(0), 0x90, 60, 100,
    ...vlq(PPQ), 62, 100,
    ...vlq(PPQ), 60, 0,
    ...vlq(0), 62, 0,
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  const parsed = parseMidiFile(midiFile([chunk('MTrk', body)]));
  assert.deepEqual(parsed.tracks[0].notes.map((n) => [n.midi, n.start, n.end]), [
    [60, 0, 2],
    [62, 1, 2],
  ]);
});

test('parseMidiFile: skips events it does not need, and reads a track name', () => {
  const parsed = parseMidiFile(
    midiFile([
      track([
        trackName('lead'),
        { tick: 0, bytes: [0xc0, 42] }, // program change (1 data byte)
        { tick: 0, bytes: [0xb0, 7, 100] }, // control change (2 data bytes)
        { tick: 0, bytes: [0xe0, 0, 64] }, // pitch bend
        { tick: 0, bytes: [0xf0, 0x02, 0x7e, 0xf7] }, // sysex
        noteOn(0, 60),
        noteOff(PPQ, 60),
      ]),
    ]),
  );
  assert.equal(parsed.tracks[0].name, 'lead');
  assert.equal(parsed.tracks[0].notes.length, 1);
});

test('parseMidiFile: repeats of one pitch keep their own lengths, and a hanging note ends with the track', () => {
  const parsed = parseMidiFile(
    midiFile([
      track([
        noteOn(0, 60),
        noteOn(PPQ / 2, 60), // retriggered before the first was released
        noteOff(PPQ, 60),
        noteOff(2 * PPQ, 60),
        noteOn(3 * PPQ, 72), // never released
      ]),
    ]),
  );
  const notes = parsed.tracks[0].notes;
  assert.deepEqual(notes.map((n) => [n.start, n.end]), [[0, 1], [0.5, 2], [3, 3]]);
});

test('parseMidiFile: rejects anything that is not a MIDI file', () => {
  assert.throws(() => parseMidiFile(new Uint8Array([1, 2, 3, 4])), /not a MIDI file/);
  assert.throws(() => parseMidiFile(midiFile([])), /no tracks/);
});

test('parseMidiFile: accepts an ArrayBuffer as well as a view', () => {
  const bytes = midiFile([track(scaleTrack(1))]);
  const copy = bytes.slice().buffer;
  assert.equal(parseMidiFile(copy).tracks[0].notes.length, 1);
});

// --- lanes -------------------------------------------------------------------------------------

test('midiFileToLanes: one lane per track, times in cycles, length rounded up to whole cycles', () => {
  const file = midiFile([
    track([tempo(120)]), // conductor track: tempo only, no notes
    track([trackName('bass'), ...scaleTrack(4, 36)]),
    track([trackName('lead'), noteOn(6 * PPQ, 72), noteOff(7 * PPQ, 72)]),
  ]);
  const { lanes, cycles, noteCount, bpm } = midiFileToLanes(file);
  assert.equal(bpm, 120);
  assert.equal(noteCount, 5);
  assert.equal(cycles, 2); // the lead's last note ends at beat 7 = cycle 1.75
  assert.deepEqual(lanes.map((l) => l.name), ['bass', 'lead']);
  assert.deepEqual(lanes[0].events.map((e) => e.start), [0, 0.25, 0.5, 0.75]);
  assert.equal(lanes[1].events[0].start, 1.5);
});

test('midiFileToLanes: a track playing several channels splits into a lane each', () => {
  const file = midiFile([
    track([
      trackName('song'),
      noteOn(0, 60, 100, 0), noteOff(PPQ, 60, 0),
      noteOn(0, 40, 100, 3), noteOff(PPQ, 40, 3),
    ]),
  ]);
  const { lanes } = midiFileToLanes(file);
  assert.deepEqual(lanes.map((l) => [l.name, l.channel]), [['song ch1', 0], ['song ch4', 3]]);
});

test('midiFileToLanes: channel 10 is flagged as drums and named when the file did not', () => {
  const file = midiFile([track([noteOn(0, 36, 100, 9), noteOff(PPQ, 36, 9)])]);
  const [lane] = midiFileToLanes(file).lanes;
  assert.equal(lane.drums, true);
  assert.equal(lane.name, 'drums');
});

test('midiFileToLanes: a track NAMED as a kit counts as drums wherever its channel is', () => {
  // Plenty of exports leave the kit on channel 1. Read as pitches its slot numbers are the most
  // played "notes" in the file, so this flag is what keeps them out of the key guess and out of
  // any conversion to scale degrees.
  const file = midiFile([
    track([trackName('Drums'), noteOn(0, 36, 100, 0), noteOff(PPQ, 36, 0)]),
    track([trackName('Lead Synth'), noteOn(0, 60, 100, 1), noteOff(PPQ, 60, 1)]),
  ]);
  assert.deepEqual(midiFileToLanes(file).lanes.map((l) => [l.name, l.drums]), [
    ['Drums', true],
    ['Lead Synth', false],
  ]);
});

test('midiFileToLanes: an unnamed melodic track has no name to offer', () => {
  const [lane] = midiFileToLanes(midiFile([track(scaleTrack(2))])).lanes;
  assert.equal(lane.name, null);
  assert.equal(lane.drums, false);
});

test('midiFileToLanes: a file with no notes is refused', () => {
  assert.throws(() => midiFileToLanes(midiFile([track([tempo(120)])])), /no notes/);
});

test('midiFileToLanes: the events feed a live recording as well as an import', () => {
  const file = midiFile([track([trackName('bass'), ...scaleTrack(4, 36)])]);
  const { lanes, cycles } = midiFileToLanes(file);
  const grid = pickGrid(lanes[0].events.map((e) => e.start));
  const { pattern } = recordingToMini(lanes[0].events, { cycles, grid });
  assert.equal(grid, 4);
  assert.match(pattern, /^<\n/);
  assert.match(pattern, />\*4$/);
  assert.match(pattern, /\b36\b/);
});

// --- grid --------------------------------------------------------------------------------------

test('pickGrid: the coarsest grid the onsets sit on wins', () => {
  assert.equal(pickGrid([0, 0.25, 0.5, 0.75]), 4);
  assert.equal(pickGrid([0, 0.125, 0.5, 0.875]), 8);
  assert.equal(pickGrid([0, 1 / 16, 0.5, 15 / 16]), 16);
  assert.equal(pickGrid([]), GRID_CANDIDATES[0]); // nothing to violate the coarsest grid
});

test('pickGrid: triplets do not pass as straight divisions, or the other way round', () => {
  assert.equal(pickGrid([0, 1 / 12, 2 / 12, 7 / 12]), 12);
  assert.equal(pickGrid([0, 1 / 16, 1 / 12]), 48); // both at once needs their common grid
});

test('pickGrid: a hand-played part that fits no grid returns 0 (unquantized)', () => {
  assert.equal(pickGrid([0, 0.2503, 0.31771, 0.6689]), 0);
});

test('pickGrid: small timing errors are absorbed rather than forced onto a finer grid', () => {
  const jitter = [0, 0.25 + 0.004, 0.5 - 0.003, 0.75 + 0.002];
  assert.equal(pickGrid(jitter), 4);
});

// --- lanes -> code -----------------------------------------------------------------------------

/** The pieces of an emitted `pianoroll("…", { grid: G, len: L })` call. */
function rollCall(code) {
  const m = /^pianoroll\("([^"]*)", \{ grid: (\d+), len: (\d+) \}\)$/.exec(code);
  assert.ok(m, `not a pianoroll call: ${code}`);
  return { notes: m[1], grid: Number(m[2]), len: Number(m[3]) };
}

/** What an emitted call plays on `cycle` - the roll built from the text, exactly as the buffer would. */
function playedSteps(code, cycle = 0) {
  const { notes, grid, len } = rollCall(code);
  return pianoroll(notes, { grid, len })
    .stepsForCycle(cycle)
    .sort((a, b) => a.start - b.start || a.value - b.value);
}

test('midiLanesToPianoroll: a lane becomes a drawn roll on the grid its rhythm sits on', () => {
  const parsed = midiFileToLanes(midiFile([track([trackName('bass'), ...scaleTrack(4, 36)])]));
  const { entries } = midiLanesToPianoroll(parsed);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { name: entries[0].name, drums: entries[0].drums, grid: entries[0].grid, len: entries[0].len },
    { name: 'bass', drums: false, grid: 4, len: 4 }, // four quarter notes, one cycle of them
  );
  // The string in the call is the note list, so the editor reopens exactly what was written.
  assert.deepEqual(parsePianoRoll(rollCall(entries[0].code).notes), entries[0].notes);
  assert.deepEqual(
    playedSteps(entries[0].code).map((st) => [st.value, st.start]),
    [[36, 0], [37, 0.25], [38, 0.5], [39, 0.75]],
  );
});

test('midiLanesToPianoroll: what it writes plays back the notes, velocities and lengths of the file', () => {
  const parsed = midiFileToLanes(
    midiFile([
      track([
        noteOn(0, 60, 127), noteOff(PPQ, 60), // a whole beat, full velocity
        noteOn(2 * PPQ, 67, 64), noteOff(4 * PPQ, 67), // two beats, half velocity
      ]),
    ]),
  );
  const [entry] = midiLanesToPianoroll(parsed).entries;
  assert.equal(rollCall(entry.code).notes, '60,0,1 67,2,2,0.5'); // full velocity is left implicit
  const steps = playedSteps(entry.code);
  assert.deepEqual(steps.map((st) => [st.value, st.start, st.end]), [[60, 0, 0.25], [67, 0.5, 1]]);
  assert.deepEqual(steps.map((st) => st.vel), [1, 0.5]);
});

test('midiLanesToPianoroll: percussion is a lane like any other, on its GM slot numbers', () => {
  const file = midiFile([
    track([trackName('keys'), noteOn(0, 60), noteOff(PPQ, 60)]),
    track([noteOn(0, 36, 100, 9), noteOff(PPQ, 36, 9)]),
  ]);
  const { entries } = midiLanesToPianoroll(midiFileToLanes(file));
  assert.deepEqual(entries.map((e) => e.drums), [false, true]);
  assert.equal(playedSteps(entries[1].code)[0].value, 36); // the kick's slot, drawn as a note
});

test('midiLanesToPianoroll: a file longer than a cycle is one roll that loops with the file', () => {
  const file = midiFile([
    track([
      noteOn(0, 60), noteOff(PPQ, 60),
      noteOn(4 * PPQ, 67), noteOff(5 * PPQ, 67), // the second cycle
    ]),
  ]);
  const [entry] = midiLanesToPianoroll(midiFileToLanes(file)).entries;
  assert.deepEqual([entry.grid, entry.len], [4, 8]); // two cycles of quarter-note cells
  assert.deepEqual(playedSteps(entry.code, 0).map((st) => [st.value, st.start]), [[60, 0]]);
  assert.deepEqual(playedSteps(entry.code, 1).map((st) => [st.value, st.start]), [[67, 0]]);
  assert.deepEqual(playedSteps(entry.code, 2).map((st) => [st.value, st.start]), [[60, 0]]); // and round again
});

test('midiLanesToPianoroll: a hand-played lane keeps its feel on the fine grid rather than a coarse one', () => {
  // 110 ticks sits far enough off every candidate grid that pickGrid gives up (see its own tests).
  const file = midiFile([track([noteOn(0, 60), noteOff(90, 60), noteOn(110, 62), noteOff(200, 62)])]);
  const [entry] = midiLanesToPianoroll(midiFileToLanes(file)).entries;
  assert.equal(entry.grid, UNQUANTIZED_GRID);
  assert.equal(entry.len, UNQUANTIZED_GRID); // one cycle of it
  const cellOf = (tick) => Math.round((tick / PPQ / 4) * UNQUANTIZED_GRID);
  assert.deepEqual(entry.notes.map((nt) => nt.start), [cellOf(0), cellOf(110)]);
});

test('midiLanesToPianoroll: a fixed grid overrides the per-lane detection', () => {
  const parsed = midiFileToLanes(midiFile([track(scaleTrack(4))]));
  assert.equal(midiLanesToPianoroll(parsed).entries[0].grid, 4);
  const forced = midiLanesToPianoroll(parsed, { grid: 16 }).entries[0];
  assert.deepEqual([forced.grid, forced.len], [16, 16]);
  assert.deepEqual(playedSteps(forced.code).map((st) => st.start), [0, 0.25, 0.5, 0.75]);
  // "off" is the fine grid, not no grid at all - a roll's cells are whole numbers.
  assert.equal(midiLanesToPianoroll(parsed, { grid: 0 }).entries[0].grid, UNQUANTIZED_GRID);
});

test('midiLanesToPianoroll: one pitch retriggered inside a cell merges instead of stacking onsets', () => {
  const file = midiFile([
    track([
      noteOn(0, 60, 60), noteOff(PPQ / 8, 60), // a short quiet hit...
      noteOn(PPQ / 8 + 1, 60, 100), noteOff(2 * PPQ, 60), // ...and a louder, longer one in the same cell
    ]),
  ]);
  const [entry] = midiLanesToPianoroll(midiFileToLanes(file), { grid: 4 }).entries;
  assert.deepEqual(entry.notes, [{ midi: 60, start: 0, len: 2, vel: 0.79, prob: 1, mute: false }]);
  assert.equal(playedSteps(entry.code).length, 1); // one onset, not two of the same note at once
});

// --- key ---------------------------------------------------------------------------------------

const keyOf = (midis, dur = 1) =>
  detectKey(midis.map((note, i) => ({ note, start: i * dur, end: (i + 1) * dur })));

test('detectKey: finds the key of a plain scale', () => {
  assert.equal(keyOf([60, 62, 64, 65, 67, 69, 71, 72]).scale, 'C major');
  assert.equal(keyOf([65, 67, 68, 70, 72, 73, 75, 77]).scale, 'F minor');
});

test('detectKey: weights by sounding time, so the tonic that is held wins', () => {
  const held = [
    { note: 62, start: 0, end: 2 }, // d, held
    { note: 65, start: 2, end: 2.25 },
    { note: 69, start: 2.25, end: 2.5 },
    { note: 62, start: 2.5, end: 4.5 },
    { note: 60, start: 4.5, end: 4.75 },
  ];
  assert.equal(detectKey(held).scale, 'D minor');
});

test('detectKey: ranks every major and minor key, best first', () => {
  const { ranked, scale, score } = keyOf([60, 62, 64, 65, 67, 69, 71]);
  assert.equal(ranked.length, 24);
  assert.equal(ranked[0].scale, scale);
  assert.equal(ranked[0].score, score);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  assert.ok(ranked.some((r) => r.scale === 'A minor')); // the relative minor is a near miss
});

test('detectKey: every name it returns is one setscale() accepts', async () => {
  const { parseScaleName } = await import('./src/notes.mjs');
  const { ranked } = keyOf([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
  for (const r of ranked) assert.doesNotThrow(() => parseScaleName(r.scale));
});

// A kit is usually the busiest part in a file, so if its slot numbers reach detectKey as pitches
// they must not be able to outvote the harmony on note count alone. Weighting by sounding time is
// what holds this: hi-hats are short however many of them there are.
test('detectKey: a busy percussion part cannot outvote the harmony it sits under', () => {
  const chords = [];
  [[65, 69, 72], [70, 74, 77], [72, 76, 79], [65, 69, 72]].forEach((chord, bar) => {
    for (const note of chord) chords.push({ note, start: bar, end: bar + 1 });
  });
  assert.equal(detectKey(chords).scale, 'F major');

  const withKit = [...chords];
  for (let i = 0; i < 32; i++) withKit.push({ note: 42, start: i / 8, end: i / 8 + 0.05 }); // hats
  for (let i = 0; i < 8; i++) withKit.push({ note: i % 2 ? 38 : 36, start: i / 2, end: i / 2 + 0.1 });
  assert.equal(detectKey(withKit).scale, 'F major'); // 40 kit hits against 12 chord tones
});

test('detectKey: a short note still counts, so a fast line is not ignored', () => {
  // A sixteenth-note run in D minor, every note far shorter than the MIN_NOTE_WEIGHT floor.
  const run = [62, 64, 65, 67, 69, 70, 72, 74].map((note, i) => ({
    note,
    start: i / 16,
    end: i / 16 + 0.001,
  }));
  assert.equal(detectKey(run).scale, 'D minor');
});

test('detectKey: nothing to judge', () => {
  assert.equal(detectKey([]), null);
  assert.equal(detectKey(null), null);
});
