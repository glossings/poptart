// Switching a filter's MODE while its cutoff sits still.
//
// Each mode reads the cutoff into a structure of its own - a comb into a delay length, the
// formant bank into five vowel peaks, the ladder into four poles - and the processor tunes only
// when a control it watches changes. So a mode picked from a panel, or from `.param("Mode", ...)`
// on a pattern, arrives with the cutoff unchanged and used to run at whatever its constructor
// had left in it: a comb at its default length whatever the knob said, an allpass with no
// notches at all. Nothing crashed and something came out, which is why it survived.
//
// What is pinned here: after a mode change the filter answers to the cutoff it was ALREADY set
// to, and a drive change over a still cutoff reaches the ladder.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FILTER, FilterProcessor } from './src/devices/filter.mjs';
import { FILTER_MODES } from './src/dsp/filters.mjs';
import { buildFigures } from './src/figures.mjs';

const SR = 48000;
const BLOCK = 128;

/** A still control, as an AudioParam with one value arrives. */
const still = (v) => [v];

function run(proc, { mode, cutoff, resonance = 0.2, drive = 1 }, hz, blocks = 40) {
  let phase = 0;
  let peak = 0;
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < BLOCK; i++) {
      const s = Math.sin(phase);
      phase += (2 * Math.PI * hz) / SR;
      inL[i] = s;
      inR[i] = s;
    }
    proc.process([inL, inR], [outL, outR], BLOCK, {
      mode: still(mode), cutoff: still(cutoff), resonance: still(resonance),
      drive: still(drive), mix: still(1), output: still(0),
    });
    // The first blocks are the filter settling; measure once it has.
    if (b >= blocks - 8) for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(outL[i]));
  }
  return peak;
}

const modeOf = (name) => FILTER_MODES.indexOf(name);

test('a mode switched over a still cutoff answers to that cutoff, not to its defaults', () => {
  // Measured at 700 Hz, which is the frequency that tells the two apart: the cutoff is set to
  // 300, so a lowpass cuts a 700 Hz tone hard, while the same filter left at the 1 kHz its
  // constructor starts on passes it almost untouched. A test at 4 kHz would call both of them
  // "cut" and notice nothing, which is how this survived being tested at all.
  for (const name of ['lowpass', 'lowpass 24', 'ladder']) {
    const direct = new FilterProcessor(SR);
    const cutDirect = run(direct, { mode: modeOf(name), cutoff: 300 }, 700);

    const switched = new FilterProcessor(SR);
    run(switched, { mode: modeOf('highpass'), cutoff: 300 }, 700, 8); // some other mode first
    const cutAfter = run(switched, { mode: modeOf(name), cutoff: 300 }, 700);

    assert.ok(cutDirect < 0.6, `${name}: a 700 Hz tone is well below full level at a 300 Hz corner`);
    assert.ok(
      Math.abs(cutAfter - cutDirect) < Math.max(0.02, cutDirect * 0.25),
      `${name}: after the switch it must filter at 300 Hz - passed ${cutAfter.toFixed(3)}, against ${cutDirect.toFixed(3)} set directly`,
    );
  }
});

test('every mode is tuned when it is switched to, whatever it is made of', () => {
  // The comb, the allpass cascade and the formant bank do not have a corner to measure, so what
  // is checked is that switching into one and setting the cutoff the other way round agree.
  for (const name of FILTER_MODES) {
    const direct = new FilterProcessor(SR);
    const straight = run(direct, { mode: modeOf(name), cutoff: 900, resonance: 0.6 }, 500);

    const switched = new FilterProcessor(SR);
    run(switched, { mode: modeOf('notch'), cutoff: 900, resonance: 0.6 }, 500, 8);
    const after = run(switched, { mode: modeOf(name), cutoff: 900, resonance: 0.6 }, 500);

    assert.ok(Number.isFinite(after), `${name}: finite`);
    assert.ok(
      Math.abs(after - straight) < 0.08,
      `${name}: switched into it reads ${after.toFixed(3)}, set directly ${straight.toFixed(3)}`,
    );
  }
});

test('a drive change over a still cutoff reaches the ladder', () => {
  // Drive is read at tuning time, so a stepped change with nothing else moving used to be
  // dropped - the one control on this device that did nothing when nothing else was moving.
  const quiet = run(new FilterProcessor(SR), { mode: modeOf('ladder'), cutoff: 2000, drive: 1 }, 400);

  const proc = new FilterProcessor(SR);
  run(proc, { mode: modeOf('ladder'), cutoff: 2000, drive: 1 }, 400, 8);
  const driven = run(proc, { mode: modeOf('ladder'), cutoff: 2000, drive: 8 }, 400);

  assert.ok(Math.abs(driven - quiet) > 0.02, `drive must change the sound: ${quiet.toFixed(3)} against ${driven.toFixed(3)}`);
});

// --- the picture the panel draws -------------------------------------------------------------
//
// The response curve had four shapes in it while the device grew to fourteen modes, so nine of
// them drew an identical lowpass: the panel said the filter was one thing while it played
// another. Nothing failed, because nothing compared one mode's curve to the next.

const curveFor = (name, values = {}) => {
  const [figure] = buildFigures(FILTER, {
    mode: modeOf(name), cutoff: 2000, resonance: 0.5, drive: 1, mix: 1, output: 0, ...values,
  }, { sampleRate: SR });
  return figure;
};

test('every filter mode draws a curve of its own', () => {
  const seen = new Map();
  for (const name of FILTER_MODES) {
    const curve = curveFor(name);
    assert.equal(curve.modeName, name, 'the figure names the mode it drew');
    assert.ok(curve.points.every((p) => Number.isFinite(p.db)), `${name}: every point is a number`);
    // Rounded, so two modes that differ only in the last decimal still count as the same picture.
    const shape = curve.points.map((p) => p.db.toFixed(1)).join(' ');
    const already = seen.get(shape);
    assert.equal(already, undefined, `${name} draws the same curve as ${already}`);
    seen.set(shape, name);
  }
});

test('a slope is drawn as the slope it is', () => {
  // An octave above the corner, each slope should be about twice the one below it in decibels.
  const at = (curve, hz) => {
    const point = curve.points.reduce((best, p) => (Math.abs(p.hz - hz) < Math.abs(best.hz - hz) ? p : best));
    return point.db;
  };
  const quiet = { resonance: 0 };
  const six = at(curveFor('lowpass 6', quiet), 8000);
  const twelve = at(curveFor('lowpass', quiet), 8000);
  const twentyFour = at(curveFor('lowpass 24', quiet), 8000);
  assert.ok(twelve < six - 6, `12 dB should fall further than 6: ${six.toFixed(1)} then ${twelve.toFixed(1)}`);
  assert.ok(twentyFour < twelve - 6, `24 dB further still: ${twelve.toFixed(1)} then ${twentyFour.toFixed(1)}`);
});

test('a highpass is drawn the other way up from a lowpass', () => {
  const low = curveFor('lowpass', { resonance: 0 });
  const high = curveFor('highpass', { resonance: 0 });
  const lowEnd = (c) => c.points[2].db;
  const highEnd = (c) => c.points[c.points.length - 3].db;
  assert.ok(lowEnd(low) > highEnd(low), 'the lowpass passes the bottom');
  assert.ok(highEnd(high) > lowEnd(high), 'the highpass passes the top');
});

test('a notch cuts at the corner and a peak lifts there', () => {
  const notch = curveFor('notch', { resonance: 0.8 });
  const peak = curveFor('peak', { resonance: 0.8 });
  const nearCorner = (c) => c.points.reduce((best, p) => (Math.abs(p.hz - 2000) < Math.abs(best.hz - 2000) ? p : best)).db;
  assert.ok(nearCorner(notch) < -12, `a notch is a hole at the cutoff: ${nearCorner(notch).toFixed(1)} dB`);
  assert.ok(nearCorner(peak) > 3, `a peak is a lift at the cutoff: ${nearCorner(peak).toFixed(1)} dB`);
});

test('the comb is drawn with teeth, and they move with the cutoff', () => {
  const dips = (c) => c.points.filter((p, i, all) => i > 0 && i < all.length - 1 && p.db < all[i - 1].db && p.db < all[i + 1].db).length;
  assert.ok(dips(curveFor('comb', { cutoff: 400 })) >= 3, 'a comb has more than one tooth');
  const low = curveFor('comb', { cutoff: 200 }).corner;
  const high = curveFor('comb', { cutoff: 800 }).corner;
  assert.ok(high > low * 2, `the teeth follow the pitch: ${low.toFixed(0)} Hz then ${high.toFixed(0)} Hz`);
});

test('the bandpass is drawn at unity however narrow it is, as the device plays it', () => {
  // The device normalizes its bandpass by the damping so the resonance narrows the band without
  // making it thirty decibels louder. A curve that left that out drew a mountain nobody hears.
  const peakOf = (res) => Math.max(...curveFor('bandpass', { resonance: res }).points.map((p) => p.db));
  assert.ok(Math.abs(peakOf(0.2)) < 3, `a gentle band sits near unity: ${peakOf(0.2).toFixed(1)} dB`);
  assert.ok(Math.abs(peakOf(0.95)) < 3, `and so does a narrow one: ${peakOf(0.95).toFixed(1)} dB`);
});

test('the drawn corner is where the filter put it, not where the knob was set', () => {
  // Asked for more than Nyquist, the filter clamps; the line has to follow it there.
  const clamped = curveFor('lowpass', { cutoff: 30000 });
  assert.ok(clamped.corner < SR / 2, `the corner cannot be past Nyquist: ${clamped.corner.toFixed(0)} Hz`);
  const ordinary = curveFor('lowpass', { cutoff: 2000 });
  assert.ok(Math.abs(ordinary.corner - 2000) < 60, `and is where it was asked otherwise: ${ordinary.corner.toFixed(0)} Hz`);
});
