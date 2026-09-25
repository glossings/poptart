// The filters: measured, not asserted. A filter test that checks a function returns a number
// says nothing about where the corner sits, and the ladder's corner was in the wrong place for
// as long as nothing measured it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FILTER_MODES, Ladder, MultiFilter, SVF_MODES, Svf } from './src/dsp/filters.mjs';

const SR = 48000;

/** The gain of a filter at one frequency, in decibels: a sine in, its level out once settled. */
function gainDb(makeFilter, hz, { settle = 4096, measure = 8192 } = {}) {
  const f = makeFilter();
  let inEnergy = 0;
  let outEnergy = 0;
  for (let i = 0; i < settle + measure; i++) {
    const x = Math.sin((2 * Math.PI * hz * i) / SR) * 0.1;
    const y = f(x);
    if (i >= settle) { inEnergy += x * x; outEnergy += y * y; }
  }
  return 10 * Math.log10(outEnergy / inEnergy);
}

const lowpass = (cutoff, resonance) => () => {
  const svf = new Svf(SR);
  svf.setCutoff(cutoff, resonance);
  return (x) => svf.next(x, SVF_MODES.indexOf('lowpass'));
};

/** One of the device's modes, through the filter a device actually runs. */
const mode = (name, cutoff, resonance = 0) => () => {
  const f = new MultiFilter(SR);
  const m = FILTER_MODES.indexOf(name);
  f.setCutoff(cutoff, resonance, m);
  return (x) => f.next(x, m);
};

const ladder = (cutoff, resonance, drive = 1) => () => {
  const l = new Ladder(SR);
  l.drive = drive;
  l.setCutoff(cutoff, resonance);
  return (x) => l.next(x);
};

test('the clean lowpass sits six decibels down at its cutoff, wherever the cutoff is', () => {
  for (const cutoff of [200, 1000, 5000, 12000]) {
    const at = gainDb(lowpass(cutoff, 0), cutoff);
    assert.ok(Math.abs(at + 6) < 1, `at ${cutoff} Hz the corner measured ${at.toFixed(2)} dB`);
  }
  // The slope, an octave up, where an octave up is still well inside the band.
  for (const cutoff of [200, 1000, 5000]) {
    const at = gainDb(lowpass(cutoff, 0), cutoff);
    const octaveUp = gainDb(lowpass(cutoff, 0), cutoff * 2);
    assert.ok(octaveUp < at - 7, `an octave above ${cutoff} Hz it should fall off: ${octaveUp.toFixed(2)} dB`);
  }
});

test('the ladder sits twelve decibels down at its cutoff, wherever the cutoff is', () => {
  // This is the calibration the naive cascade lost above five kilohertz: its per-stage pole
  // drifted, the corner rose and the slope collapsed. Four poles at the cutoff is minus twelve.
  for (const cutoff of [200, 1000, 5000, 10000]) {
    const at = gainDb(ladder(cutoff, 0), cutoff);
    assert.ok(Math.abs(at + 12) < 1.5, `at ${cutoff} Hz the ladder's corner measured ${at.toFixed(2)} dB`);
    const octaveUp = gainDb(ladder(cutoff, 0), cutoff * 2);
    assert.ok(octaveUp < at - 15, `an octave above ${cutoff} Hz a four-pole should fall fast: ${octaveUp.toFixed(2)} dB`);
  }
});

test('the ladder\'s resonance peaks at the cutoff, high and low alike', () => {
  for (const cutoff of [500, 5000]) {
    let best = -Infinity;
    let bestHz = 0;
    for (let ratio = 0.5; ratio <= 2; ratio *= 1.05) {
      const hz = cutoff * ratio;
      const g = gainDb(ladder(cutoff, 0.85), hz);
      if (g > best) { best = g; bestHz = hz; }
    }
    assert.ok(Math.abs(bestHz / cutoff - 1) < 0.12, `resonance at ${cutoff} Hz peaked at ${bestHz.toFixed(0)} Hz`);
  }
});

test('the ladder is stable at full resonance and full drive, and never produces a NaN', () => {
  const l = new Ladder(SR);
  l.drive = 8;
  l.setCutoff(15000, 1);
  let peak = 0;
  for (let i = 0; i < 48000; i++) {
    const y = l.next(Math.sin(i * 0.3));
    assert.ok(Number.isFinite(y), `sample ${i} was ${y}`);
    peak = Math.max(peak, Math.abs(y));
  }
  assert.ok(peak < 4, `the saturation should keep it bounded, peak was ${peak}`);
});

test('a filter that follows another is tuned identically, which is what a stereo pair needs', () => {
  const a = new Svf(SR);
  a.setCutoff(3210, 0.4);
  const b = new Svf(SR);
  b.follow(a);
  assert.deepEqual([b.g, b.k, b.a1, b.a2, b.a3], [a.g, a.k, a.a1, a.a2, a.a3]);
  const la = new Ladder(SR);
  la.drive = 3;
  la.setCutoff(777, 0.6);
  const lb = new Ladder(SR);
  lb.follow(la);
  assert.deepEqual([lb.G, lb.G4, lb.k, lb.drive], [la.G, la.G4, la.k, la.drive]);
});

// --- the slopes, and the modes that are not a slope ---------------------------------------------

test('each slope falls off at the rate its name claims', () => {
  // Measured BETWEEN TWO POINTS IN THE STOPBAND, not from the corner: every one of these has a
  // different gain at its own corner (a one-pole is three decibels down there and a resonant
  // two-pole is six), so a fall measured from it is the corner's offset plus the slope. Two
  // octaves apart, well past the corner and well short of Nyquist, is the asymptote - which is
  // what the name claims. (Near Nyquist these fall faster than their slope: a lowpass in this
  // form is exactly zero there, so a measurement taken up against it flatters every mode.)
  for (const [name, perOctave] of [['lowpass 6', 6], ['lowpass', 12], ['lowpass 24', 24]]) {
    const near = gainDb(mode(name, 1000), 2000);
    const far = gainDb(mode(name, 1000), 8000);
    const fall = near - far;
    assert.ok(Math.abs(fall - perOctave * 2) < perOctave * 0.35, `${name} fell ${fall.toFixed(1)} dB over two octaves`);
  }
  // And the highpasses, the same way round.
  for (const [name, perOctave] of [['highpass 6', 6], ['highpass', 12], ['highpass 24', 24]]) {
    const near = gainDb(mode(name, 1000), 250);
    const far = gainDb(mode(name, 1000), 62.5);
    const fall = near - far;
    assert.ok(Math.abs(fall - perOctave * 2) < perOctave * 0.35, `${name} fell ${fall.toFixed(1)} dB over two octaves`);
  }
});

test('resonance sharpens a band rather than making it louder', () => {
  // The bug this pins: the core's bandpass output has a gain of one over the damping at its
  // center, so turning the resonance up used to add thirty decibels as well as narrowing the
  // band - a volume control nobody asked for, and a clipped track at the top of the knob.
  for (const name of ['bandpass', 'bandpass 24']) {
    for (const resonance of [0, 0.5, 1]) {
      const center = gainDb(mode(name, 1000, resonance), 1000);
      assert.ok(Math.abs(center) < 3, `${name} at resonance ${resonance} measured ${center.toFixed(1)} dB at its center`);
    }
    // ...and it does narrow.
    const wide = gainDb(mode(name, 1000, 0), 400);
    const tight = gainDb(mode(name, 1000, 1), 400);
    assert.ok(tight < wide - 6, `${name} should be tighter at high resonance: ${tight.toFixed(1)} against ${wide.toFixed(1)}`);
  }
});

test('a bandpass passes its center and stops both sides, at either slope', () => {
  for (const name of ['bandpass', 'bandpass 24']) {
    const center = gainDb(mode(name, 1000), 1000);
    assert.ok(gainDb(mode(name, 1000), 100) < center - 12, `${name} stops below`);
    assert.ok(gainDb(mode(name, 1000), 10000) < center - 12, `${name} stops above`);
  }
});

test('a notch removes its center and a peak lifts it, leaving the rest alone', () => {
  const notch = gainDb(mode('notch', 1000, 0.9), 1000);
  assert.ok(notch < -12, `a notch should take the center out, measured ${notch.toFixed(1)} dB`);
  assert.ok(Math.abs(gainDb(mode('notch', 1000, 0.9), 60)) < 1.5, 'and leave what is well below it');

  const peak = gainDb(mode('peak', 1000, 0.9), 1000);
  assert.ok(peak > 6, `a peak should lift the center, measured ${peak.toFixed(1)} dB`);
  assert.ok(Math.abs(gainDb(mode('peak', 1000, 0.9), 60)) < 1.5, 'and leave what is well below it');
});

test('a comb cancels at the odd multiples of the note it is tuned to', () => {
  // The definition of a comb: a signal against a copy of itself one period late. At the tuning
  // the two are in phase, and half an octave-ish away - the odd half-multiples - they cancel.
  const tuned = gainDb(mode('comb', 500, 0), 500);
  const between = gainDb(mode('comb', 500, 0), 750);
  assert.ok(tuned - between > 12, `the teeth should be deep: ${tuned.toFixed(1)} against ${between.toFixed(1)}`);
  // And it rings when it is fed back.
  assert.ok(gainDb(mode('comb', 500, 0.9), 500) > tuned + 3, 'resonance rings the tuned note');
});

test('an allpass cascade notches without changing what it passes overall', () => {
  // Every section has unity gain, so what comes out is the phase turn - and summed back with
  // the input that is a set of notches rather than a filter with a corner.
  const deep = gainDb(mode('allpass', 800, 0), 800);
  const away = gainDb(mode('allpass', 800, 0), 60);
  assert.ok(away > deep, `the notch is at the tuning, not at the bottom: ${deep.toFixed(1)} vs ${away.toFixed(1)}`);
  assert.ok(Math.abs(away) < 2, 'and what is well away from it comes through');
});

test('the formant bank sits on the vowel resonances rather than on the cutoff', () => {
  // The cutoff sweeps THROUGH the vowels here, so what the filter passes is not the number on
  // the knob: at the bottom of the sweep the first resonance sits near 270 Hz whatever the
  // cutoff says, and the gap above it is stopped.
  const low = mode('formant', 25, 0.9);
  assert.ok(gainDb(low, 270) > gainDb(low, 1200) + 6, 'the first resonance is passed and the gap is not');

  // And the sweep really does move through different vowels: the second resonance of the first
  // one is an octave and a half away from the second resonance of the last.
  const loudestNear = (f, from, to) => {
    let best = -Infinity;
    let at = from;
    for (let hz = from; hz <= to; hz *= 1.06) {
      const db = gainDb(f, hz);
      if (db > best) { best = db; at = hz; }
    }
    return at;
  };
  const first = loudestNear(mode('formant', 25, 0.95), 700, 3200);
  const last = loudestNear(mode('formant', 18000, 0.95), 700, 3200);
  assert.ok(Math.abs(Math.log2(first / last)) > 0.7, `the vowels differ across the sweep: ${Math.round(first)} Hz against ${Math.round(last)} Hz`);
});

test('every mode is finite, bounded and silent on silence, at any setting', () => {
  // The guard the whole device rests on: a mode that blows up takes the track with it, and a
  // mode that sounds on a rest is an effect that cannot be left in a chain.
  for (const name of FILTER_MODES) {
    for (const cutoff of [20, 200, 2000, 19000]) {
      for (const resonance of [0, 0.5, 1]) {
        const m = FILTER_MODES.indexOf(name);
        const f = new MultiFilter(SR);
        f.drive = 8;
        f.setCutoff(cutoff, resonance, m);
        let loudest = 0;
        for (let i = 0; i < 8192; i++) {
          const y = f.next(Math.sin((2 * Math.PI * 220 * i) / SR), m);
          assert.ok(Number.isFinite(y), `${name} at ${cutoff} Hz, resonance ${resonance}: sample ${i} was ${y}`);
          loudest = Math.max(loudest, Math.abs(y));
        }
        assert.ok(loudest < 12, `${name} at ${cutoff} Hz, resonance ${resonance} reached ${loudest.toFixed(1)}`);

        const quiet = new MultiFilter(SR);
        quiet.setCutoff(cutoff, resonance, m);
        for (let i = 0; i < 4096; i++) assert.equal(quiet.next(0, m), 0, `${name} sounds on silence`);
      }
    }
  }
});
