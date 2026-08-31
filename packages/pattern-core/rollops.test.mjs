// rollops.mjs - the roll's note-geometry transforms. Pure notes -> notes, nothing booted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCENT_SHAPES, accentuate, accentWeight, arpeggiate, augment, conformToScale, degrade,
  divideFigure, euclid, euclidFigure, humanize, invertPitch, legato, melodize, retrograde,
  rhythmize, rhythmizeAll, RHYTHM_FIGURES, rotateFigure, seededRandom, spreadPitch, strum,
  swingFigure, variation,
} from './src/rollops.mjs';
import { midiToDegree, quantizeToScale } from './src/notes.mjs';

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
  const noAxes = variation(bar, { len: 16, temperature: 1, seed: 11, drop: 0, time: 0, pitch: 0, vel: 0, add: 0 });
  assert.deepEqual(noAxes.notes.slice(8).map((n) => [n.midi, n.start]), bar.map((n) => [n.midi, n.start + 16]), 'no axis is a plain duplicate too');
});

test('variation: the axes are what "varied" means - each one alone changes only its own thing', () => {
  const bar = Array.from({ length: 8 }, (_, i) => N(60 + (i % 4) * 2, i * 2, 1));
  const opts = { len: 16, temperature: 1, seed: 7, scale: 'c major', drop: 0, time: 0, pitch: 0, vel: 0, add: 0 };
  const copyOf = (r) => r.notes.slice(8);

  const mel = copyOf(variation(bar, { ...opts, pitch: 1 }));
  assert.deepEqual(mel.map((n) => n.start), bar.map((n) => n.start + 16), 'pitch alone: the rhythm is untouched');
  assert.deepEqual(mel.map((n) => n.vel), bar.map((n) => n.vel), 'pitch alone: the dynamics are untouched');
  assert.ok(mel.some((n, i) => n.midi !== bar[i].midi), 'pitch alone: the pitches moved');
  for (const nt of mel) assert.ok([0, 2, 4, 5, 7, 9, 11].includes(nt.midi % 12), 'in key');

  const thin = copyOf(variation(bar, { ...opts, drop: 1 }));
  assert.ok(thin.length < bar.length, 'drop alone: notes went');
  assert.deepEqual(thin.map((n) => [n.midi, n.start]), thin.map((n) => [n.midi, n.start]).filter(([m, st]) =>
    bar.some((b) => b.midi === m && b.start + 16 === st)), 'drop alone: the survivors are verbatim');

  const moved = copyOf(variation(bar, { ...opts, time: 1 }));
  assert.equal(moved.length, bar.length, 'time alone: every note survives');
  assert.deepEqual([...moved].sort((a, b) => a.midi - b.midi).map((n) => n.midi), [...bar].sort((a, b) => a.midi - b.midi).map((n) => n.midi), 'time alone: the pitches are the set they were');
  assert.ok(moved.some((n, i) => n.start !== bar[i].start + 16), 'time alone: notes moved');

  const filled = copyOf(variation(bar, { ...opts, add: 1 }));
  assert.ok(filled.length > bar.length, 'add alone: notes arrived');
  assert.deepEqual(filled.slice(0, 8).map((n) => [n.midi, n.start]), bar.map((n) => [n.midi, n.start + 16]), 'add alone: the originals are verbatim');
});

test('variation: pitch depth bounds the step, and an addition takes its neighbour\'s length', () => {
  const bar = Array.from({ length: 8 }, (_, i) => N(60 + (i % 4) * 2, i * 2, 2));
  const opts = { len: 16, temperature: 1, seed: 3, scale: 'c major', drop: 0, time: 0, pitch: 0, vel: 0, add: 0 };
  const near = variation(bar, { ...opts, pitch: 1, depth: 1 }).notes.slice(8);
  const far = variation(bar, { ...opts, pitch: 1, depth: 5 }).notes.slice(8);
  const steps = (out) => out.map((n, i) => Math.abs(midiToDegree(n.midi, 'c major') - midiToDegree(bar[i].midi, 'c major')));
  assert.ok(steps(near).every((d) => d === 1), 'depth 1 is a single scale step');
  assert.ok(steps(far).every((d) => d >= 1 && d <= 5) && steps(far).some((d) => d > 1), 'depth 5 reaches further');
  const onsets = new Set(bar.map((n) => n.start + 16));
  const added = variation(bar, { ...opts, add: 1 }).notes.slice(8).filter((n) => !onsets.has(n.start));
  assert.ok(added.length, 'something was added');
  assert.ok(added.every((n) => n.len === 2 && n.full === 2), 'an addition is as long as the note it was modelled on');
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

test('accentWeight: metric hierarchy, presets, waves', () => {
  // downbeats on a 16-cell bar: bar start > beats > eighth-offs > sixteenth-offs
  const down = (t) => accentWeight(t, 'downbeats');
  assert.equal(down(0), 1);
  assert.equal(down(4 / 16), 0.4);
  assert.equal(down(8 / 16), 0.7);
  assert.equal(down(2 / 16), 0);
  assert.equal(down(1 / 16), -0.6);
  assert.equal(accentWeight(1 / 16, 'offbeats'), 0.6, 'offbeats is the mirror');
  assert.equal(down(1 / 12), -0.8, 'a triplet position sits below the binary grid');
  assert.equal(down(3 / 12), 0.4, 'the second beat of a triplet grid is still a beat');
  // 3+3+2 peaks on the tresillo eighths; clave on 3-2 son
  for (const t of [0, 3 / 8, 6 / 8]) assert.equal(accentWeight(t, '3+3+2'), 1);
  assert.equal(accentWeight(2 / 8, '3+3+2'), -0.5);
  for (const t of [0, 3 / 16, 6 / 16, 10 / 16, 12 / 16]) assert.equal(accentWeight(t, 'clave'), 1);
  assert.equal(accentWeight(4 / 16, 'clave'), -0.5);
  // ramps and waves
  assert.equal(accentWeight(0, 'ramp up'), -1);
  assert.equal(accentWeight(1, 'ramp up'), 1);
  assert.equal(accentWeight(0, 'ramp down'), 1);
  const q = { quarter: 1 };
  assert.ok(Math.abs(accentWeight(4 / 16, 'waves', { waves: q }) - 1) < 1e-9, 'quarter wave peaks on the beats');
  assert.ok(Math.abs(accentWeight(2 / 16, 'waves', { waves: q }) + 1) < 1e-9, 'and troughs between them');
  assert.equal(accentWeight(0.3, 'waves', { waves: {} }), 0, 'no waves, no shape');
  assert.ok(Math.abs(accentWeight(3 / 16, 'waves', { waves: { dotted: 1 } }) - 1) < 1e-9, 'the dotted wave peaks at 3 sixteenths');
  assert.equal(ACCENT_SHAPES.length, 8);
});

test('accentuate: velocity shaped by bar position, existing dynamics scale through', () => {
  const notes = Array.from({ length: 16 }, (_, i) => N(60, i, 1, { vel: 0.5 }));
  const out = accentuate(notes, { grid: 16, shape: 'downbeats', vel: 1 });
  assert.ok(Math.abs(out[0].vel - 0.875) < 1e-9, 'bar start boosted');
  assert.ok(Math.abs(out[4].vel - 0.65) < 1e-9, 'beats lifted less');
  assert.equal(out[2].vel, 0.5, 'eighth-offs untouched');
  assert.ok(Math.abs(out[1].vel - 0.275) < 1e-9, 'sixteenth-offs cut');
  const inverted = accentuate(notes, { grid: 16, shape: 'downbeats', vel: -1 });
  assert.ok(inverted[0].vel < 0.5 && inverted[1].vel > 0.5, 'negative depth accents the weak pulses');
  assert.deepEqual(accentuate(notes, { grid: 16, vel: 0 }).map((n) => n.vel), notes.map((n) => n.vel), 'zero depth leaves velocity alone');
});

test('accentuate: timing lays weak notes back, length clips them, chords stay chords on random', () => {
  const notes = [N(60, 0, 2), N(60, 1, 2), N(60, 4, 2)];
  const out = accentuate(notes, { grid: 16, shape: 'downbeats', vel: 0, time: 0.2 });
  assert.equal(out[0].nudge, 0, 'the bar start stays dead on');
  assert.ok(Math.abs(out[1].nudge - 0.16) < 1e-9, 'a weak note is laid back');
  const clipped = accentuate(notes, { grid: 16, shape: 'downbeats', vel: 0, length: 1 });
  assert.equal(clipped[0].len, 2);
  assert.equal(clipped[1].len, 1);
  assert.equal(clipped[1].full, 1);
  const chord = [N(60, 3, 1, { vel: 0.5 }), N(64, 3, 1, { vel: 0.5 }), N(67, 3, 1, { vel: 0.5 })];
  const r = accentuate(chord, { grid: 16, shape: 'random', vel: 1, seed: 9 });
  assert.ok(r[0].vel === r[1].vel && r[1].vel === r[2].vel, 'one weight per bar position');
  assert.deepEqual(r, accentuate(chord, { grid: 16, shape: 'random', vel: 1, seed: 9 }), 'seeded');
  const line = Array.from({ length: 8 }, (_, i) => N(60, i * 2, 1, { vel: 0.5 }));
  assert.notDeepEqual(
    accentuate(line, { grid: 16, shape: 'random', vel: 1, seed: 9 }).map((n) => n.vel),
    accentuate(line, { grid: 16, shape: 'random', vel: 1, seed: 10 }).map((n) => n.vel),
    'a new seed is a new roll of the dice');
});

test('arpeggiate: up cycles the chord over its span at the rate', () => {
  const chord = [N(60, 0, 4), N(64, 0, 4), N(67, 0, 4)];
  const out = arpeggiate(chord, { rate: 1 });
  assert.deepEqual(pick(out, 'midi', 'start', 'len'), [
    { midi: 60, start: 0, len: 1 }, { midi: 64, start: 1, len: 1 }, { midi: 67, start: 2, len: 1 }, { midi: 60, start: 3, len: 1 },
  ]);
  assert.equal(chord[0].len, 4, 'input untouched');
});

test('arpeggiate: every direction orders the run its own way', () => {
  const chord = [N(64, 0, 4), N(60, 0, 4), N(67, 0, 4)]; // drawn 64, 60, 67
  const seq = (direction) => arpeggiate(chord, { rate: 1, direction }).map((nt) => nt.midi);
  assert.deepEqual(seq('down'), [67, 64, 60, 67]);
  assert.deepEqual(seq('up-down'), [60, 64, 67, 64]);
  assert.deepEqual(seq('converge'), [60, 67, 64, 60]);
  assert.deepEqual(seq('as drawn'), [64, 60, 67, 64]);
});

test('arpeggiate: fractional rates land in nudges; doubled pitches and overruns are dropped', () => {
  const out = arpeggiate([N(60, 2, 2), N(64, 2, 2)], { rate: 0.5 });
  assert.deepEqual(pick(out, 'midi', 'start', 'nudge', 'len'), [
    { midi: 60, start: 2, nudge: 0, len: 1 }, { midi: 64, start: 2, nudge: 0.5, len: 1 },
    { midi: 60, start: 3, nudge: 0, len: 1 }, { midi: 64, start: 3, nudge: 0.5, len: 1 },
  ]);
  // rate 0.25 over one cell: the third hit doubles 60 in cell 0, the fourth rounds past the end.
  const tight = arpeggiate([N(60, 0, 1), N(64, 0, 1)], { rate: 0.25 });
  assert.deepEqual(pick(tight, 'midi', 'start', 'nudge'), [
    { midi: 60, start: 0, nudge: 0 }, { midi: 64, start: 0, nudge: 0.25 },
  ]);
});

test('arpeggiate: lone notes pass; random is seeded and never repeats back to back', () => {
  const notes = [N(55, 0, 2), N(60, 4, 4), N(64, 4, 4), N(67, 4, 4)];
  const out = arpeggiate(notes, { rate: 1, direction: 'random', seed: 5 });
  assert.deepEqual(pick([out[0]], 'midi', 'start', 'len'), [{ midi: 55, start: 0, len: 2 }]);
  const run = out.slice(1);
  assert.equal(run.length, 4);
  for (const nt of run) assert.ok([60, 64, 67].includes(nt.midi));
  for (let i = 1; i < run.length; i++) assert.notEqual(run[i].midi, run[i - 1].midi);
  assert.deepEqual(out, arpeggiate(notes, { rate: 1, direction: 'random', seed: 5 }));
});

test('melodize: same rhythm, in key, in register; seeded; amount 0 is identity', () => {
  const line = [N(60, 0, 2, { vel: 0.7, nudge: 0.1 }), N(64, 2), N(67, 4), N(72, 6), N(65, 8), N(60, 10)];
  const out = melodize(line, { scale: 'c major', seed: 11, grid: 16 });
  assert.deepEqual(pick(out, 'start', 'len', 'vel', 'nudge'), pick(line, 'start', 'len', 'vel', 'nudge'));
  for (const nt of out) {
    assert.equal(quantizeToScale(nt.midi, 'c major'), nt.midi, 'in key');
    assert.ok(nt.midi >= 60 && nt.midi <= 72, 'stays in the register');
  }
  assert.deepEqual(out, melodize(line, { scale: 'c major', seed: 11, grid: 16 }));
  assert.notDeepEqual(out.map((nt) => nt.midi), melodize(line, { scale: 'c major', seed: 12, grid: 16 }).map((nt) => nt.midi));
  assert.deepEqual(melodize(line, { scale: 'c major', seed: 11, keep: 1 }), line.map((nt) => ({ ...nt })));
});

test('melodize: strong beats land on tonic-triad tones', () => {
  const line = Array.from({ length: 16 }, (_, i) => N(60 + (i % 8), i));
  const out = melodize(line, { scale: 'c major', seed: 3, grid: 16 });
  for (const nt of out.filter((x) => x.start % 4 === 0)) {
    const deg = ((midiToDegree(nt.midi, 'c major') % 7) + 7) % 7;
    assert.ok([0, 2, 4].includes(deg), `cell ${nt.start} on a chord tone (degree ${deg})`);
  }
});

test('melodize: follow keeps the original contour sign for sign', () => {
  const line = [N(60, 0), N(64, 1), N(62, 2), N(62, 3), N(67, 4), N(65, 5)];
  const origDeg = line.map((nt) => midiToDegree(nt.midi, 'c major'));
  const out = melodize(line, { scale: 'c major', seed: 9, shape: 1, grid: 16 });
  const newDeg = out.map((nt) => midiToDegree(nt.midi, 'c major'));
  for (let i = 1; i < line.length; i++) {
    const want = Math.sign(origDeg[i] - origDeg[i - 1]);
    const got = Math.sign(newDeg[i] - newDeg[i - 1]);
    if (want === 0) assert.equal(got, 0, 'a repeated note stays repeated');
    else assert.ok(got === want || got === 0, 'never moves against the original');
  }
});

test('melodize: same-onset notes stay distinct; amount is a keep-mask', () => {
  const chord = [N(60, 0, 4), N(64, 0, 4), N(67, 0, 4)];
  const out = melodize(chord, { scale: 'c major', seed: 21 });
  assert.equal(new Set(out.map((nt) => nt.midi)).size, 3);
  const line = Array.from({ length: 12 }, (_, i) => N(60 + ((i * 2) % 8), i));
  const some = melodize(line, { scale: 'c major', seed: 4, keep: 0.6 });
  const kept = some.filter((nt, i) => nt.midi === line[i].midi).length;
  assert.ok(kept > 0 && kept < 12, `keep-mask keeps some, changes some (kept ${kept})`);
});

test('melodize: one repeated pitch still yields a melody (an octave to walk in)', () => {
  const line = Array.from({ length: 8 }, (_, i) => N(60, i));
  const out = melodize(line, { scale: 'c major', seed: 6, grid: 8 });
  assert.ok(new Set(out.map((nt) => nt.midi)).size > 1, 'pitches actually move');
  for (const nt of out) {
    assert.equal(quantizeToScale(nt.midi, 'c major'), nt.midi, 'in key');
    assert.ok(Math.abs(nt.midi - 60) <= 12, 'stays around the original note');
  }
});

test('melodize: range and offset move the walk window', () => {
  const line = [0, 4, 7, 2, 5, 9, 4, 0].map((iv, i) => N(60 + iv, i));
  const up = melodize(line, { scale: 'c major', seed: 5, grid: 8, offset: 7 });
  for (const nt of up) assert.ok(nt.midi >= 72 && nt.midi <= 84, `an octave up (got ${nt.midi})`);
  const tight = melodize(line, { scale: 'c major', seed: 5, grid: 8, range: 2 });
  for (const nt of tight) assert.ok(nt.midi >= 64 && nt.midi <= 67, `squeezed to the middle (got ${nt.midi})`);
});

test('melodize: a wider range audibly spreads the walk', () => {
  const line = Array.from({ length: 16 }, (_, i) => N(62 + (i % 5), i));
  const span = (ns) => Math.max(...ns.map((nt) => nt.midi)) - Math.min(...ns.map((nt) => nt.midi));
  let widest = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const out = melodize(line, { scale: 'c major', seed, grid: 16, range: 21 });
    widest = Math.max(widest, span(out));
    for (const nt of out) assert.ok(nt.midi >= 43 && nt.midi <= 84, 'stays inside the window');
  }
  assert.ok(widest > 14, `leaps scale with the window (widest span ${widest})`);
});

test('melodize: shape 1 with a wide range magnifies the drawn contour', () => {
  const arp = [55, 57, 60, 62, 67, 69].map((m, i) => N(m, i)); // an upward arpeggio
  for (const seed of [2, 7]) {
    const out = melodize(arp, { scale: 'c major', seed, shape: 1, range: 21, grid: 8 });
    for (let i = 1; i < out.length; i++) assert.ok(out[i].midi > out[i - 1].midi, 'still strictly rising');
    const span = out[out.length - 1].midi - out[0].midi;
    assert.ok(span >= 24, `stretched across the window (span ${span})`);
  }
});
