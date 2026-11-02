// The circuit-modeled filters (src/dsp/analog.mjs), one model at a time: that each is stable
// anywhere on its controls and under a cutoff moved at audio rate, that the ones whose circuit
// sings do so at the cutoff and the ones whose circuit does not only ring, that each has the
// response shape its circuit has, that drive makes harmonics, that the folded products of a
// driven model stay far under what it means to make, and that the picture's small-signal answer
// is what the filter actually does to a quiet signal.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ANALOG_MODELS, ANALOG_MORPHING, AnalogFilter } from './src/dsp/analog.mjs';

const SR = 48000;

const make = (name, { cutoff = 1000, resonance = 0, drive = 1, morph = 0 } = {}) => {
  const f = new AnalogFilter(SR, ANALOG_MODELS.indexOf(name));
  f.setCutoff(cutoff);
  f.setResonance(resonance);
  f.setDrive(drive);
  f.setMorph(morph);
  return f;
};

/** The gain at `hz` for a quiet sine, in dB, once the filter has settled. */
function gainDb(name, settings, hz, amp = 0.01) {
  const f = make(name, settings);
  const n = Math.round(SR * 0.2);
  const from = Math.round(SR * 0.1);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * hz * i) / SR;
    const y = f.process(amp * Math.sin(w));
    if (i >= from) { re += y * Math.cos(w); im += y * Math.sin(w); }
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (n - from) / amp);
}

/** Pitch and level of what the filter does on its own after one kick, over its second half-second. */
function ringing(name, settings) {
  const f = make(name, settings);
  const n = SR;
  let last = 0;
  const crossings = [];
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const y = f.process(i < 8 ? 0.5 : 0);
    if (i > n / 2) {
      peak = Math.max(peak, Math.abs(y));
      if (last < 0 && y >= 0) crossings.push(i - last / (y - last));
    }
    last = y;
  }
  const hz = crossings.length > 2 ? ((crossings.length - 1) * SR) / (crossings.at(-1) - crossings[0]) : 0;
  return { hz, peak };
}

/** A Hann-windowed DFT magnitude at `hz`. */
function bin(signal, hz) {
  let re = 0;
  let im = 0;
  const n = signal.length;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    const p = (2 * Math.PI * hz * i) / SR;
    re += w * signal[i] * Math.cos(p);
    im += w * signal[i] * Math.sin(p);
  }
  return (4 * Math.hypot(re, im)) / n;
}

/** The settled output for a sine. */
function playSine(name, settings, hz, amp, seconds = 0.5) {
  const f = make(name, settings);
  const n = Math.round(SR * seconds);
  const out = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) {
    const y = f.process(amp * Math.sin((2 * Math.PI * hz * i) / SR));
    if (i >= n / 2) out[i - n / 2] = y;
  }
  return out;
}

const SINGS = ['ladder', 'sallen', 'cmos', 'ota', 'polar', 'diodepair'];
const RINGS = ['diode', 'statevar'];

test('every circuit is either one that sings or one that only rings', () => {
  assert.deepEqual([...SINGS, ...RINGS].sort(), [...ANALOG_MODELS].sort());
});

for (const name of ANALOG_MODELS) {
  test(`${name}: finite, bounded and silent on silence anywhere on its controls`, () => {
    const morphs = ANALOG_MORPHING.includes(name) ? [0, 0.5, 1] : [0];
    for (const cutoff of [20, 200, 2000, 19000]) {
      for (const resonance of [0, 0.5, 1]) {
        for (const drive of [1, 8]) {
          for (const morph of morphs) {
            const f = make(name, { cutoff, resonance, drive, morph });
            let seed = 1;
            let loudest = 0;
            for (let i = 0; i < 4096; i++) {
              seed = (seed * 1664525 + 1013904223) >>> 0;
              const x = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7 + (seed / 4294967296 - 0.5) * 0.6;
              const y = f.process(x);
              assert.ok(Number.isFinite(y), `${name} ${cutoff} Hz res ${resonance} drive ${drive} morph ${morph}: sample ${i} was ${y}`);
              loudest = Math.max(loudest, Math.abs(y));
            }
            assert.ok(loudest < 12, `${name} ${cutoff} Hz res ${resonance} drive ${drive} morph ${morph} reached ${loudest.toFixed(2)}`);
            const quiet = make(name, { cutoff, resonance, drive, morph });
            for (let i = 0; i < 2048; i++) assert.equal(quiet.process(0), 0, `${name} sounds on silence`);
          }
        }
      }
    }
  });

  test(`${name}: a cutoff moved at audio rate stays stable and does not click`, () => {
    const chord = (i) => 0.3 * (Math.sin((2 * Math.PI * 110 * i) / SR) + Math.sin((2 * Math.PI * 165 * i) / SR) + Math.sin((2 * Math.PI * 247 * i) / SR));
    // A filter envelope at its most violent: snapping from 20 Hz to the top and falling back
    // every 25 ms, at full drive and high resonance. It has to stay a signal.
    const wild = make(name, { resonance: 0.9, drive: 8 });
    for (let i = 0; i < SR; i++) {
      wild.setCutoff(20 * Math.pow(900, Math.exp(-((i % 1200) / 1200) * 6)));
      const y = wild.process(chord(i));
      assert.ok(Number.isFinite(y) && Math.abs(y) < 12, `${name}: ${y} at ${i} under the snapping sweep`);
    }
    // Swept by a 100 Hz sine across four octaves under that chord: everything that comes out is
    // the chord, its harmonics and the resonance riding the sweep, all under 5 kHz. A click is
    // broadband, so what lands above 14 kHz is the measure of how much the sweep sprays.
    const f = make(name, { resonance: 0.85, drive: 2 });
    const n = SR / 2;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      f.setCutoff(200 * Math.pow(20, 0.5 + 0.5 * Math.sin((2 * Math.PI * 100 * i) / SR)));
      out[i] = f.process(chord(i));
    }
    let total = 0;
    let top = 0;
    for (let hz = 100; hz < 23900; hz += 200) {
      const e = bin(out, hz) ** 2;
      total += e;
      if (hz > 14000) top += e;
    }
    const db = 10 * Math.log10(top / total);
    assert.ok(db < -80, `${name}: the sweep puts ${db.toFixed(1)} dB above 14 kHz`);
    // And a cutoff that jumps is a corner in the output, not a step: the capacitors keep their
    // charge, so the sample after the jump moves no further than the ring that follows it.
    const g = make(name, { cutoff: 200, resonance: 0.85, drive: 2 });
    const moves = [];
    let last = 0;
    for (let i = 0; i < 4800; i++) {
      if (i === 2400) g.setCutoff(4000);
      const y = g.process(chord(i));
      moves.push(Math.abs(y - last));
      last = y;
    }
    const jump = Math.max(moves[2400], moves[2401]);
    const after = Math.max(...moves.slice(2402, 2600));
    assert.ok(jump < after * 2, `${name}: the jump moves ${jump.toFixed(4)}, the ring after it ${after.toFixed(4)}`);
  });
}

for (const name of SINGS) {
  test(`${name}: at full resonance it sings at the cutoff, at a level it holds`, () => {
    for (const cutoff of [200, 1000, 5000]) {
      const { hz, peak } = ringing(name, { cutoff, resonance: 1 });
      assert.ok(peak > 0.05 && peak < 1.5, `${name} at ${cutoff} Hz sings at ${peak.toFixed(3)}`);
      assert.ok(Math.abs(Math.log2(hz / cutoff)) < 0.15, `${name} at ${cutoff} Hz sings at ${hz.toFixed(1)} Hz`);
    }
    // And short of the onset it only rings.
    assert.ok(ringing(name, { cutoff: 1000, resonance: 0.7 }).peak < 1e-3, `${name} sings at 0.7`);
  });
}

for (const name of RINGS) {
  test(`${name}: at full resonance it rings long but dies away`, () => {
    assert.ok(ringing(name, { cutoff: 1000, resonance: 1 }).peak < 1e-3, `${name} sings`);
    // Rings: twenty milliseconds after the kick - twenty periods - there is still a tone.
    const f = make(name, { cutoff: 1000, resonance: 1 });
    let late = 0;
    for (let i = 0; i < SR * 0.03; i++) {
      const y = f.process(i < 8 ? 0.5 : 0);
      if (i > SR * 0.02) late = Math.max(late, Math.abs(y));
    }
    assert.ok(late > 1e-4, `${name} stops ringing at once (${late})`);
  });
}

test('ladder: twelve down at the corner, 24 dB an octave, and the bass goes as the resonance rises', () => {
  assert.ok(Math.abs(gainDb('ladder', { cutoff: 1000 }, 1000) + 12) < 0.5);
  const slope = gainDb('ladder', { cutoff: 1000 }, 4000) - gainDb('ladder', { cutoff: 1000 }, 8000);
  assert.ok(slope > 22 && slope < 25, `slope ${slope}`);
  const loss = gainDb('ladder', { cutoff: 1000, resonance: 0.9 }, 40);
  assert.ok(loss < -10, `the bass at high resonance is ${loss} dB`);
});

test('ota: four poles like the ladder, but it keeps far more of the bass', () => {
  const slope = gainDb('ota', { cutoff: 1000 }, 4000) - gainDb('ota', { cutoff: 1000 }, 8000);
  assert.ok(slope > 22 && slope < 25, `slope ${slope}`);
  const ota = gainDb('ota', { cutoff: 1000, resonance: 0.9 }, 40);
  const ladder = gainDb('ladder', { cutoff: 1000, resonance: 0.9 }, 40);
  assert.ok(ota > -6 && ota > ladder + 6, `ota keeps ${ota} dB of bass, the ladder ${ladder}`);
});

test('diode: about 18 dB an octave past the peak, and the peak moves with the resonance', () => {
  // The octave just above the corner, where the spread poles have not all arrived yet.
  const near = gainDb('diode', { cutoff: 1000 }, 1000) - gainDb('diode', { cutoff: 1000 }, 2000);
  assert.ok(near > 12 && near < 20, `the first octave past the corner falls ${near} dB`);
  const peakAt = (resonance) => {
    let best = -Infinity;
    let at = 0;
    for (let hz = 300; hz <= 2000; hz *= 1.02) {
      const g = gainDb('diode', { cutoff: 1000, resonance }, hz);
      if (g > best) { best = g; at = hz; }
    }
    return at;
  };
  const low = peakAt(0.5);
  const high = peakAt(0.95);
  assert.ok(high > low * 1.1, `the peak moves up with the resonance: ${low.toFixed(0)} Hz, then ${high.toFixed(0)} Hz`);
  assert.ok(Math.abs(Math.log2(high / 1000)) < 0.1, `and at the top it is on the cutoff, at ${high.toFixed(0)} Hz`);
  const loss = gainDb('diode', { cutoff: 1000, resonance: 0.9 }, 80);
  assert.ok(loss < -4 && loss > -12, `some of the bass goes, not all: ${loss} dB`);
});

for (const name of ['sallen', 'statevar', 'cmos', 'polar', 'diodepair']) {
  test(`${name}: a two-pole, whose morph runs from lowpass to highpass`, () => {
    const lp = { cutoff: 1000, morph: 0 };
    const slope = gainDb(name, lp, 4000) - gainDb(name, lp, 8000);
    assert.ok(slope > 10.5 && slope < 13.5, `slope ${slope}`);
    assert.ok(gainDb(name, lp, 50) > -1, 'the lowpass passes the bass');
    const hp = { cutoff: 1000, morph: 1 };
    assert.ok(gainDb(name, hp, 50) < -40, 'the highpass stops it');
    assert.ok(Math.abs(gainDb(name, hp, 12000)) < 1, 'and passes the top');
    const mid = { cutoff: 1000, morph: 0.5, resonance: 0.5 };
    if (name === 'statevar') {
      assert.ok(gainDb(name, mid, 1000) < -20, 'halfway, a notch at the cutoff');
      assert.ok(gainDb(name, mid, 50) > -1 && gainDb(name, mid, 12000) > -1, 'and both ends passed');
    } else {
      assert.ok(gainDb(name, mid, 1000) > gainDb(name, mid, 50) + 20, 'halfway, a band at the cutoff');
      assert.ok(gainDb(name, mid, 1000) > gainDb(name, mid, 12000) + 15, 'falling away on both sides');
    }
  });
}

for (const name of ANALOG_MODELS) {
  test(`${name}: the picture's response is what it does to a quiet signal`, () => {
    for (const settings of [{ resonance: 0 }, { resonance: 0.6 }, { resonance: 0.6, morph: 0.7 }]) {
      const f = make(name, { cutoff: 1000, ...settings });
      for (const hz of [100, 700, 1000, 1400, 3000]) {
        const t = f.transfer(hz);
        const drawn = 20 * Math.log10(Math.hypot(t.re, t.im));
        const heard = gainDb(name, { cutoff: 1000, ...settings }, hz, 0.001);
        // The half-bands roll the very top off a little; everything here is far under it.
        assert.ok(Math.abs(drawn - heard) < 1, `${name} ${JSON.stringify(settings)} at ${hz} Hz: drawn ${drawn.toFixed(2)}, heard ${heard.toFixed(2)}`);
      }
    }
  });

  test(`${name}: drive makes harmonics, and the folded ones stay far under them`, () => {
    const harmonicsOf = (drive) => {
      const out = playSine(name, { cutoff: 500, resonance: 0.5, drive }, 110, 0.5);
      const h = [1, 2, 3, 4, 5, 6, 7].map((k) => bin(out, 110 * k));
      return { thd: Math.hypot(...h.slice(1)) / h[0], even: h[1] / h[0] };
    };
    const clean = harmonicsOf(1);
    const driven = harmonicsOf(8);
    if (name === 'sallen' || name === 'diodepair') {
      // The clipped feedback growls at any level; driven harder it clips the resonance itself,
      // so the harmonics stop growing rather than climbing with the drive.
      assert.ok(clean.thd > 0.02 && driven.thd > 0.02, `${name}: ${(clean.thd * 100).toFixed(2)}% then ${(driven.thd * 100).toFixed(2)}%`);
    } else {
      assert.ok(driven.thd > clean.thd * 2 && driven.thd > 0.01, `${name}: ${(clean.thd * 100).toFixed(2)}% then ${(driven.thd * 100).toFixed(2)}%`);
    }
    // Only the lopsided circuit makes even harmonics; the rest are symmetric.
    if (name === 'cmos') assert.ok(driven.even > 0.05, `cmos: second harmonic ${driven.even}`);
    else assert.ok(driven.even < 1e-3, `${name}: second harmonic ${driven.even}`);

    // A 3.1 kHz tone driven hard, under a cutoff high enough to pass its harmonics: whatever is
    // not one of them is folded, and it has to be far under them.
    const hot = playSine(name, { cutoff: 12000, resonance: 0.5, drive: 8 }, 3100, 0.8);
    let harm = 0;
    let folded = 0;
    for (let hz = 100; hz < 20000; hz += 100) {
      if (hz % 3100 === 0) harm += bin(hot, hz) ** 2;
      else if (hz % 3100 > 200 && hz % 3100 < 2900) folded += bin(hot, hz) ** 2;
    }
    const db = 10 * Math.log10(folded / harm);
    assert.ok(db < -45, `${name}: folded products at ${db.toFixed(1)} dB`);
  });

  test(`${name}: a channel that follows another plays the same`, () => {
    const a = make(name, { cutoff: 700, resonance: 0.8, drive: 3, morph: 0.3 });
    const b = new AnalogFilter(SR, 0);
    b.follow(a);
    for (let i = 0; i < 2000; i++) {
      const x = Math.sin(i * 0.07) * 0.6;
      assert.equal(b.process(x), a.process(x));
    }
  });
}
