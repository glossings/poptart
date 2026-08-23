// Recording a live performance into a piano roll (record.mjs): where a recording window opens, how
// events land on cells - overdub wrap, count-in at negative cells, quantize vs nudge, re-meshing a
// coarse roll for a fine quantize - and how a capture picks its window after the fact.

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordingToRoll, captureWindow, recordStartCycle } from './src/record.mjs';
import { parsePianoRoll, serializePianoRoll } from './src/pianoroll.mjs';

const ev = (note, start, end, vel = 1, extra = {}) => ({ note, vel, start, end, ...extra });
const fresh = (grid, cycles) => ({ notes: [], grid, len: grid * cycles, start: 0 });
const live = (notes) => notes.filter((n) => !n.hidden);

// --- recordStartCycle ---

test('a recording opens on the next phrase boundary', () => {
  assert.equal(recordStartCycle(0.5, 4), 4);
  assert.equal(recordStartCycle(4, 4), 8);
  assert.equal(recordStartCycle(5.1, 1), 8);
  assert.equal(recordStartCycle(5.1, 2), 8);
});

test('power-of-two lengths past a phrase align to themselves, so a fresh roll starts at cell 0', () => {
  assert.equal(recordStartCycle(5.1, 8), 8);
  assert.equal(recordStartCycle(9, 8), 16);
  assert.equal(recordStartCycle(3, 16), 16);
});

test('odd lengths take the next phrase rather than a far-off multiple', () => {
  assert.equal(recordStartCycle(5.1, 3), 8);
  assert.equal(recordStartCycle(5.1, 12), 8);
  assert.equal(recordStartCycle(5.1, 32), 8);
});

// --- recordingToRoll: a fresh roll ---

test('a fresh roll recorded from an aligned start fills from cell 0, quantized to its grid', () => {
  const roll = fresh(16, 4);
  const events = [ev(60, 8.0, 8.25), ev(64, 8.26, 8.5, 0.5), ev(67, 11.75, 12.0)];
  const out = recordingToRoll(events, roll, { window: [8, 12], quantize: 16 });
  assert.equal(out.grid, 16);
  assert.equal(out.len, 64);
  assert.equal(serializePianoRoll(live(out.notes)), '60,0,4 64,4,4,0.5 67,60,4');
  assert.equal(out.added.length, 3);
  assert.equal(out.regridded, false);
});

test('count-in notes land at negative cells, before the loop, keeping their distance from beat one', () => {
  const roll = fresh(16, 1);
  const events = [ev(48, 7.5, 7.75), ev(60, 8.0, 8.5)];
  const out = recordingToRoll(events, roll, { window: [8, 9], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '48,-8,4 60,0,8');
  // ...and the string round-trips: negative starts survive the format
  assert.deepEqual(parsePianoRoll('48,-8,4').map((n) => n.start), [-8]);
});

test('countIn: false leaves the count-in out', () => {
  const roll = fresh(16, 1);
  const out = recordingToRoll([ev(48, 7.5, 7.75), ev(60, 8.0, 8.5)], roll, { window: [8, 9], quantize: 16, countIn: false });
  assert.equal(serializePianoRoll(live(out.notes)), '60,0,8');
});

// --- overdub ---

test('a take longer than the roll wraps: later cycles land on the cells that were playing', () => {
  const roll = { notes: parsePianoRoll('36,0,4'), grid: 16, len: 16, start: 0 };
  const events = [ev(60, 8.0, 8.25), ev(62, 9.5, 9.75), ev(64, 11.25, 11.5)];
  const out = recordingToRoll(events, roll, { window: [8, 12], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '36,0,4 60,0,4 64,4,4 62,8,4');
});

test('events go where the roll was playing, whatever the recording started at', () => {
  // an 8-cycle roll, a 4-cycle take that started half way through it: the take lands in the
  // second half, which is what was under the playhead
  const roll = fresh(16, 8);
  const out = recordingToRoll([ev(60, 4.0, 4.25)], roll, { window: [4, 8], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '60,64,4');
});

test('the window start cell follows the roll\'s own start offset', () => {
  const roll = { notes: [], grid: 16, len: 16, start: 16 };
  const out = recordingToRoll([ev(60, 8.0, 8.25), ev(48, 7.75, 8.0)], roll, { window: [8, 9], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '48,12,4 60,16,4');
});

test('the new notes are pushed last and win the overlap rule', () => {
  const roll = { notes: parsePianoRoll('60,0,16'), grid: 16, len: 16, start: 0 };
  const out = recordingToRoll([ev(60, 8.5, 8.75)], roll, { window: [8, 9], quantize: 16 });
  // the long note underneath is cut where the played one lands
  assert.equal(serializePianoRoll(live(out.notes)), '60,0,8 60,8,4');
});

// --- quantize / nudge ---

test('unquantized: the nearest cell, with the remainder as a nudge', () => {
  const roll = fresh(16, 1);
  const out = recordingToRoll([ev(60, 8 + 2.3 / 16, 8 + 3 / 16)], roll, { window: [8, 9], quantize: 0 });
  const [nt] = live(out.notes);
  assert.equal(nt.start, 2);
  assert.ok(Math.abs(nt.nudge - 0.3) < 1e-6);
  assert.equal(nt.len, 1);
});

test('a coarse quantize on a fine roll lands on the matching cells, no nudge', () => {
  const roll = fresh(16, 1);
  const out = recordingToRoll([ev(60, 8.2, 8.3)], roll, { window: [8, 9], quantize: 4 });
  assert.equal(serializePianoRoll(live(out.notes)), '60,4,2');
  assert.equal(out.grid, 16);
});

test('a quantize finer than the roll re-meshes it, keeping the drawn notes where they were', () => {
  const roll = { notes: parsePianoRoll('36,0,1 38,2,1'), grid: 4, len: 4, start: 0 };
  const out = recordingToRoll([ev(60, 8 + 3 / 16, 8 + 4 / 16)], roll, { window: [8, 9], quantize: 16 });
  assert.equal(out.regridded, true);
  assert.equal(out.grid, 16);
  assert.equal(out.len, 16);
  assert.equal(serializePianoRoll(live(out.notes)), '36,0,4 60,3,1 38,8,4');
});

test('a triplet roll quantized to sixteenths re-meshes to their common multiple', () => {
  const roll = fresh(12, 1);
  const out = recordingToRoll([ev(60, 8 + 1 / 16, 8 + 2 / 16)], roll, { window: [8, 9], quantize: 16 });
  assert.equal(out.grid, 48);
  assert.equal(serializePianoRoll(live(out.notes)), '60,3,3');
});

test('an index rides along with the pitch, and velocity is kept as played', () => {
  const roll = fresh(16, 1);
  const out = recordingToRoll([ev(24, 8.0, 8.1, 0.63, { index: 3 })], roll, { window: [8, 9], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '24:3,0,2,0.63');
});

test('lengths are never quantized', () => {
  const roll = fresh(16, 1);
  const out = recordingToRoll([ev(60, 8.0, 8 + 3 / 16)], roll, { window: [8, 9], quantize: 4 });
  assert.equal(live(out.notes)[0].len, 3);
});

// --- captureWindow ---

test('capture: nothing played, nothing to capture', () => {
  assert.equal(captureWindow([]), null);
});

test('capture into an empty roll: the run rounded up to a power of two, aligned to itself', () => {
  assert.deepEqual(captureWindow([ev(60, 0.1, 0.5), ev(62, 3.5, 3.9)]), { start: 0, end: 4, cycles: 4 });
  assert.deepEqual(captureWindow([ev(60, 4.1, 4.5), ev(62, 7.5, 7.9)]), { start: 4, end: 8, cycles: 4 });
  assert.deepEqual(captureWindow([ev(60, 6.0, 6.5), ev(62, 7.5, 7.9)]), { start: 6, end: 8, cycles: 2 });
  // three bars in bars 2-4 of a phrase: a four-bar loop, first bar empty
  assert.deepEqual(captureWindow([ev(60, 1.0, 1.5), ev(62, 3.5, 3.9)]), { start: 0, end: 4, cycles: 4 });
});

test('capture: a run that straddles its aligned window grows until it fits', () => {
  assert.deepEqual(captureWindow([ev(60, 2.3, 2.5), ev(62, 4.5, 4.8)]), { start: 0, end: 8, cycles: 8 });
});

test('capture: past the cap, the last aligned stretch', () => {
  const events = [];
  for (let c = 0; c < 40; c++) events.push(ev(60, c + 0.1, c + 0.5));
  assert.deepEqual(captureWindow(events), { start: 32, end: 48, cycles: 16 });
});

test('capture: only the trailing run after the last silence', () => {
  const events = [ev(60, 0.1, 0.5), ev(62, 0.6, 0.9), ev(64, 8.1, 8.5), ev(65, 8.6, 8.9)];
  assert.deepEqual(captureWindow(events), { start: 8, end: 9, cycles: 1 });
});

test('capture: a rest shorter than a phrase does not split the run; a longer one does', () => {
  const events = [ev(60, 8.1, 8.5), ev(62, 12.1, 12.4)];
  assert.deepEqual(captureWindow(events), { start: 8, end: 16, cycles: 8 });
  assert.deepEqual(captureWindow(events, { gap: 2 }), { start: 12, end: 13, cycles: 1 });
});

test('capture over a looping roll: the most recent full pass, ending at the loop boundary after the last note', () => {
  const events = [ev(60, 5.1, 5.3), ev(62, 9.5, 9.7), ev(64, 10.2, 10.4)];
  assert.deepEqual(captureWindow(events, { loopCycles: 4 }), { start: 8, end: 12, cycles: 4 });
  assert.deepEqual(captureWindow(events, { loopCycles: 1 }), { start: 10, end: 11, cycles: 1 });
  assert.deepEqual(captureWindow(events, { loopCycles: 0.5 }), { start: 10, end: 10.5, cycles: 0.5 });
});

test('capture: a note let go a hair late does not add a bar', () => {
  assert.deepEqual(captureWindow([ev(60, 0.1, 4.01)]), { start: 0, end: 4, cycles: 4 });
  assert.deepEqual(captureWindow([ev(60, 3.99, 4.5)]), { start: 4, end: 5, cycles: 1 });
});

test('recordingToRoll + captureWindow: a captured phrase fills a fresh roll the size it was given', () => {
  const events = [ev(60, 4.0, 4.5), ev(64, 5.0, 5.5), ev(67, 7.5, 8.0)];
  const win = captureWindow(events);
  const roll = fresh(16, win.cycles);
  const out = recordingToRoll(events, roll, { window: [win.start, win.end], quantize: 16 });
  assert.equal(serializePianoRoll(live(out.notes)), '60,0,8 64,16,8 67,56,8');
});
