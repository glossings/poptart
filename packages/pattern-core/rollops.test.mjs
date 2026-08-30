// rollops.mjs - the roll's note-geometry transforms. Pure notes -> notes, nothing booted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  augment, conformToScale, degrade, divideFigure, euclid, euclidFigure, humanize, invertPitch,
  legato, retrograde, rhythmize, rhythmizeAll, RHYTHM_FIGURES, rotateFigure, seededRandom,
  spreadPitch, strum, swingFigure, variation,
} from './src/rollops.mjs';

const N = (midi, start, len = 1, extra = {}) => ({ midi, start, len, vel: 1, prob: 1, nudge: 0, mute: false, ...extra });
const pick = (notes, ...keys) => notes.map((nt) => Object.fromEntries(keys.map((k) => [k, nt[k]])));

test('strum: a chord fans out lowest-first within half a cell, first note fixed', () => {
  const chord = [N(67, 0), N(60, 0), N(64, 0)];
  const out = strum(chord, { spread: 0.5 });
  assert.deepEqual(pick(out, 'midi', 'start', 'nudge'), [
    { midi: 67, start: 0, nudge: 0.5 }, { midi: 60, start: 0, nudge: 0 }, { midi: 64, start: 0, nudge: 0.25 },
  ]);
  assert.equal(chord[0].nudge, 0, 'input untouched');
});

test('strum: wider than a cell steps onto later cells; down reverses; velRamp fades the tail', () => {
  const out = strum([N(60, 4), N(64, 4), N(67, 4)], { spread: 2, direction: 'down', velRamp: 0.5 });
  const byMidi = Object.fromEntries(out.map((nt) => [nt.midi, nt]));
  assert.deepEqual(pick([byMidi[67], byMidi[64], byMidi[60]], 'start', 'nudge', 'vel'), [
    { start: 4, nudge: 0, vel: 1 }, { start: 5, nudge: 0, vel: 0.75 }, { start: 6, nudge: 0, vel: 0.5 },
  ]);
});

test('strum: notes on different onsets strum separately', () => {
  const out = strum([N(60, 0), N(64, 0), N(60, 4), N(64, 4)]);
  assert.deepEqual(pick(out, 'start', 'nudge'), [{ start: 0, nudge: 0 }, { start: 0, nudge: 0.5 }, { start: 4, nudge: 0 }, { start: 4, nudge: 0.5 }]);
});

test('retrograde: reverses within the span and flips nudges', () => {
  const out = retrograde([N(60, 0, 2), N(62, 2, 1, { nudge: 0.2 }), N(64, 3, 1)]);
  assert.deepEqual(pick(out, 'midi', 'start', 'len', 'nudge'), [
    { midi: 60, start: 2, len: 2, nudge: 0 }, { midi: 62, start: 1, len: 1, nudge: -0.2 }, { midi: 64, start: 0, len: 1, nudge: 0 },
  ]);
  assert.deepEqual(retrograde(out).map((n) => n.start), [0, 2, 3], 'an involution');
});

test('legato: reach to the next onset, the last keeps its length', () => {
  const line = [N(60, 0, 1), N(64, 0, 1), N(62, 3, 1), N(65, 4, 4)];
  assert.deepEqual(pick(legato(line), 'start', 'len', 'full'), [
    { start: 0, len: 3, full: 3 }, { start: 0, len: 3, full: 3 }, { start: 3, len: 1, full: 1 }, { start: 4, len: 4, full: 4 },
  ]);
});

test('humanize: seeded, bounded, reproducible', () => {
  const line = [N(60, 0, 1, { vel: 0.5 }), N(62, 1), N(64, 2)];
  const a = humanize(line, { seed: 7 });
  const b = humanize(line, { seed: 7 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, humanize(line, { seed: 8 }));
  for (const nt of a) {
    assert.ok(Math.abs(nt.nudge) <= 0.08 && nt.vel >= 0 && nt.vel <= 1);
  }
  assert.ok(a.some((nt, i) => nt.nudge !== line[i].nudge), 'it moved something');
  const r = seededRandom(1);
  const x = r();
  assert.ok(x >= 0 && x < 1 && x !== r());
});

test('invertPitch: chromatic mirrors about the range midpoint, in key about the degree midpoint', () => {
  const line = [N(60, 0), N(64, 1), N(67, 2)]; // C E G
  assert.deepEqual(invertPitch(line).map((n) => n.midi), [67, 63, 60], 'C..G mirrored: E -> Eb');
  assert.deepEqual(invertPitch(line, { scale: 'c major' }).map((n) => n.midi), [67, 64, 60], 'in C major the third stays E');
  const up = [N(60, 0), N(62, 1), N(64, 2), N(65, 3)];
  assert.deepEqual(invertPitch(up, { scale: 'c major' }).map((n) => n.midi), [65, 64, 62, 60]);
});

test('spreadPitch: away from / toward the centre, in degrees or semitones, never crossing', () => {
  const triad = [N(60, 0), N(64, 0), N(67, 0)];
  assert.deepEqual(spreadPitch(triad, { scale: 'c major', steps: 1 }).map((n) => n.midi), [59, 64, 69], 'C E G -> B E A');
  assert.deepEqual(spreadPitch(triad, { steps: 1 }).map((n) => n.midi), [59, 65, 68], 'chromatic: a semitone away from the 63.5 centre - E is above it');
  assert.deepEqual(spreadPitch(triad, { scale: 'c major', steps: -1 }).map((n) => n.midi), [62, 64, 65], 'contract: D E F');
  const pair = [N(60, 0), N(62, 0)];
  assert.deepEqual(spreadPitch(pair, { scale: 'c major', steps: -3 }).map((n) => n.midi), [60, 62], 'a pair contracting stops at its own two sides');
  assert.deepEqual(spreadPitch(pair, { steps: -1 }).map((n) => n.midi), [61, 61], 'chromatic pair with an integer centre meets there');
});

test('conformToScale: everything in key', () => {
  assert.deepEqual(conformToScale([N(61, 0), N(66, 1), N(72, 2)], 'c major').map((n) => n.midi), [60, 65, 72]);
});

test('euclid: the Bjorklund necklaces, step 0 a hit', () => {
  assert.deepEqual(euclid(3, 8), [0, 3, 6]);
  assert.deepEqual(euclid(5, 8), [0, 2, 3, 5, 6]);
  assert.deepEqual(euclid(4, 16), [0, 4, 8, 12]);
  assert.deepEqual(euclid(2, 2), [0, 1]);
  assert.deepEqual(euclid(0, 8), []);
  assert.deepEqual(euclidFigure(3, 8), { steps: 8, hits: [0, 3, 6], accents: [1, 0.85, 0.85] });
});

test('rhythmize: a note becomes its figure over its own span, hits reach to the next', () => {
  const out = rhythmize(N(60, 4, 8), euclidFigure(3, 8));
  assert.deepEqual(pick(out, 'midi', 'start', 'len', 'nudge', 'vel'), [
    { midi: 60, start: 4, len: 3, nudge: 0, vel: 1 }, { midi: 60, start: 7, len: 3, nudge: 0, vel: 0.85 }, { midi: 60, start: 10, len: 2, nudge: 0, vel: 0.85 },
  ]);
  assert.equal(out.every((n) => n.full === n.len), true);
});

test('rhythmize: fractional landings go into nudges; same-cell hits collapse; too short is null', () => {
  const tres = rhythmize(N(60, 0, 4), RHYTHM_FIGURES.tresillo); // 0, 1.5, 3 over 4 cells
  assert.deepEqual(pick(tres, 'start', 'nudge', 'len'), [{ start: 0, nudge: 0, len: 1 }, { start: 1, nudge: 0.5, len: 2 }, { start: 3, nudge: 0, len: 1 }]);
  const swung = rhythmize(N(60, 0, 8), swingFigure(divideFigure(8), 1 / 3)); // swung eighths, a cell per hit
  assert.deepEqual(swung.map((n) => n.start), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (let i = 0; i < 8; i++) assert.ok(Math.abs(swung[i].nudge - (i % 2 ? 1 / 3 : 0)) < 0.01, 'offbeats a third of a cell late');
  assert.equal(rhythmize(N(60, 0, 1), RHYTHM_FIGURES['four on the floor']), null, 'one cell holds one hit');
  const four2 = rhythmize(N(60, 0, 2), RHYTHM_FIGURES['four on the floor']);
  assert.deepEqual(four2.map((n) => n.start), [0, 1], 'four hits over two cells: the two that fit');
});

test('rhythmizeAll: each note over its own span, null when nothing could split', () => {
  const out = rhythmizeAll([N(60, 0, 4), N(64, 4, 1)], RHYTHM_FIGURES['four on the floor']);
  assert.deepEqual(pick(out, 'midi', 'start'), [{ midi: 60, start: 0 }, { midi: 60, start: 1 }, { midi: 60, start: 2 }, { midi: 60, start: 3 }, { midi: 64, start: 4 }]);
  assert.equal(rhythmizeAll([N(60, 0, 1)], RHYTHM_FIGURES.tresillo), null);
});

test('degrade: seeded thinning that never empties the selection', () => {
  const line = Array.from({ length: 8 }, (_, i) => N(60 + i, i));
  const a = degrade(line, { amount: 0.5, seed: 3 });
  assert.deepEqual(a, degrade(line, { amount: 0.5, seed: 3 }));
  assert.ok(a.length > 0 && a.length < 8);
  assert.equal(degrade(line, { amount: 1, seed: 3 }).length, 1);
  assert.equal(degrade(line, { amount: 0, seed: 3 }).length, 8);
});

test('augment: fills a share of the empty cells, modelled on the nearest note, in key', () => {
  const line = [N(60, 0), N(67, 4, 1, { vel: 0.5 })];
  const out = augment(line, { amount: 1, seed: 5, scale: 'c major' });
  assert.deepEqual(out.slice(0, 2), line, 'originals first, unchanged');
  assert.deepEqual(out.slice(2).map((n) => n.start), [1, 2, 3], 'every empty cell of the span');
  for (const nt of out.slice(2)) {
    assert.ok([0, 2, 4, 5, 7, 9, 11].includes(nt.midi % 12), 'in key');
    assert.equal(nt.len, 1);
  }
  assert.equal(augment(line, { amount: 0, seed: 5 }).length, 2);
  assert.equal(augment(line, { amount: 1, seed: 5, span: [0, 8] }).length, 2 + 6, 'an explicit span');
});

test('variation: doubles the loop, the copy varied only inside the region', () => {
  const bar = Array.from({ length: 8 }, (_, i) => N(60 + (i % 4) * 2, i * 2, 1));
  const { notes, len } = variation(bar, { len: 16, temperature: 1, seed: 11, scale: 'c major', from: 0.5, to: 1 });
  assert.equal(len, 32);
  assert.deepEqual(notes.slice(0, 8), bar, 'the first bar is untouched');
  const copy = notes.slice(8);
  const firstHalf = copy.filter((n) => n.start < 24);
  assert.deepEqual(firstHalf.map((n) => [n.midi, n.start]), bar.slice(0, 4).map((n) => [n.midi, n.start + 16]), 'outside the region: verbatim');
  assert.ok(copy.every((n) => n.start >= 16 && n.start < 32), 'everything lands in the second bar');
  assert.notDeepEqual(copy.filter((n) => n.start >= 24).map((n) => [n.midi, n.start]), bar.slice(4).map((n) => [n.midi, n.start + 16]), 'inside: changed');
  const cold = variation(bar, { len: 16, temperature: 0, seed: 11 });
  assert.deepEqual(cold.notes.slice(8).map((n) => n.start), bar.map((n) => n.start + 16), 'temperature 0 is a plain duplicate');
});

test('rotateFigure: hits and accents turn together', () => {
  const r = rotateFigure(RHYTHM_FIGURES.tresillo, 2); // 0 3 6 -> 2 5 0
  assert.deepEqual(r, { steps: 8, hits: [0, 2, 5], accents: [0.9, 1, 0.85] });
  assert.deepEqual(rotateFigure(RHYTHM_FIGURES.tresillo, -8), RHYTHM_FIGURES.tresillo);
});

test('index mode: strum orders by index, augment/variation never repitch', () => {
  const drums = [N(60, 0, 1, { index: 3 }), N(60, 0, 1, { index: 1 }), N(60, 4, 1, { index: 1 })];
  const st = strum(drums, { key: 'index', spread: 0.5 });
  assert.deepEqual(st.map((n) => n.nudge), [0.5, 0, 0]);
  const aug = augment(drums, { amount: 1, seed: 2, repitch: false });
  assert.ok(aug.every((n) => n.midi === 60));
  const v = variation(drums, { len: 8, temperature: 1, seed: 2, repitch: false });
  assert.ok(v.notes.every((n) => n.midi === 60 && [1, 3].includes(n.index)));
});

test('divideFigure: even split, triplets land via nudges', () => {
  const tri = rhythmize(N(60, 0, 4), divideFigure(3)); // hits at 0, 4/3, 8/3 cells
  assert.deepEqual(tri.map((n) => n.start), [0, 1, 3], 'the last third rounds forward, nudged back');
  assert.ok(Math.abs(tri[1].nudge - 1 / 3) < 0.01 && Math.abs(tri[2].nudge + 1 / 3) < 0.01);
  assert.deepEqual(tri.map((n) => n.vel), [1, 0.85, 0.85]);
  assert.deepEqual(divideFigure(4).hits, [0, 1, 2, 3]);
});

test('swingFigure: odd steps delayed, straight untouched, applied after rotation', () => {
  assert.deepEqual(swingFigure(divideFigure(4), 0.5).hits, [0, 1.5, 2, 3.5]);
  assert.deepEqual(swingFigure(divideFigure(4), 0).hits, [0, 1, 2, 3], 'zero swing is straight');
  const rotatedThenSwung = swingFigure(rotateFigure(RHYTHM_FIGURES.tresillo, 1), 0.25); // [1,4,7]
  assert.deepEqual(rotatedThenSwung.hits, [1.25, 4, 7.25], 'the rotated onsets on odd steps swing');
});

test('the distinguished timelines all have five onsets over sixteen, starting on the downbeat', () => {
  for (const name of ['son clave', 'rumba clave', 'bossa nova', 'shiko', 'soukous', 'gahu']) {
    const f = RHYTHM_FIGURES[name];
    assert.equal(f.steps, 16, name);
    assert.equal(f.hits.length, 5, name);
    assert.equal(f.hits[0], 0, name);
    assert.equal(f.accents.length, 5, name);
  }
  for (const [name, f] of Object.entries(RHYTHM_FIGURES)) assert.equal(f.hits.length, f.accents.length, name);
});
