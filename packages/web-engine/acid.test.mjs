import test from 'node:test';
import assert from 'node:assert/strict';

import { ACID, ACID_ACCENT_DECAY, ACID_FEEDBACK, AcidLadder, AcidSynth, acidFeedback, acidMakeup, acidSkew } from './src/devices/acid.mjs';
import { fft } from './src/dsp/fft.mjs';
import { midiToHz } from './src/dsp/voice.mjs';

const SR = 48000;
const BLOCK = 128;

const defaults = () => Object.fromEntries(ACID.params.map((p) => [p.id, p.default]));

/** A synth at `settings` over the defaults, with a player that runs it a block at a time. */
function setup(settings = {}) {
  const synth = new AcidSynth(SR);
  const values = { ...defaults(), ...settings };
  synth.setParams(values);
  synth.setBend(0);
  const out = [];
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  /** `blocks` blocks; `each(b)` may queue notes before block b; `probe()` is read after each. */
  const run = (blocks, each = null, probe = null) => {
    const seen = [];
    for (let b = 0; b < blocks; b++) {
      each?.(b);
      synth.setParams(values);
      l.fill(0);
      r.fill(0);
      synth.process(l, r, BLOCK);
      out.push(...l);
      if (probe) seen.push(probe());
    }
    return seen;
  };
  return { synth, values, run, out };
}

const rms = (x, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

/** The ladder's small-signal gain at `hz`, in dB, from its impulse response. */
function ladderResponse(cutoff, k, { noHighpass = false } = {}) {
  const f = new AcidLadder(SR);
  f.set(cutoff, k);
  if (noHighpass) f.gh = 0;
  const N = 1 << 16;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const amp = 1e-4;
  for (let i = 0; i < N; i++) re[i] = f.process(i === 0 ? amp : 0) / amp;
  fft(re, im);
  return (hz) => {
    const b = Math.round((hz * N) / SR);
    return 20 * Math.log10(Math.hypot(re[b], im[b]));
  };
}

/** How much of an impulse is still ringing a quarter second on, against its start. */
function ringing(cutoff, k, options = {}) {
  const f = new AcidLadder(SR);
  f.set(cutoff, k);
  if (options.noHighpass) f.gh = 0;
  let early = 0;
  let late = 0;
  for (let i = 0; i < SR / 2; i++) {
    const y = Math.abs(f.process(i === 0 ? 1e-3 : 0));
    if (i > 50 && i < SR / 20) early = Math.max(early, y);
    if (i > SR / 4) late = Math.max(late, y);
  }
  return late / early;
}

test('the filter falls at four poles: about 24 dB an octave well past the cutoff', () => {
  const h = ladderResponse(500, 0);
  const slope = h(8000) - h(4000);
  assert.ok(slope < -21 && slope > -27, `slope ${slope.toFixed(1)} dB/oct`);
  // And the knee is soft: already down at half the cutoff, with no resonance at all.
  assert.ok(h(250) < -6, `half the cutoff is at ${h(250).toFixed(1)} dB`);
  assert.ok(Math.abs(h(20)) < 1, 'the bass passes at zero resonance');
});

test('the resonance peaks at the cutoff and is fed back through a highpass that keeps the bottom quiet', () => {
  for (const cutoff of [800, 1600, 3200]) {
    const h = ladderResponse(cutoff, ACID_FEEDBACK);
    let best = 0;
    let bestDb = -Infinity;
    for (let hz = cutoff / 2; hz < cutoff * 2; hz += cutoff / 200) if (h(hz) > bestDb) { bestDb = h(hz); best = hz; }
    assert.ok(Math.abs(best / cutoff - 1) < 0.1, `peak at ${best.toFixed(0)} for ${cutoff}`);
    assert.ok(bestDb - h(cutoff / 2) > 12, `the peak stands ${(bestDb - h(cutoff / 2)).toFixed(1)} dB over the band under it`);
  }
  // The peak grows as the cutoff rises: the highpass takes more of the loop at the bottom.
  assert.ok(ladderResponse(400, ACID_FEEDBACK)(400) < ladderResponse(3200, ACID_FEEDBACK)(3200) - 10);
  // At the top of Resonance the filter does not sing on its own at a low cutoff - it would
  // without the highpass in its loop.
  assert.ok(ringing(300, ACID_FEEDBACK) < 1e-3, 'rings on at 300 Hz');
  assert.ok(ringing(300, ACID_FEEDBACK, { noHighpass: true }) > 0.5, 'without the highpass it would');
  // The resonance thins the band around the cutoff more than the very bottom, which goes round
  // the loop less.
  const h = ladderResponse(1000, ACID_FEEDBACK);
  assert.ok(h(2) > -1, 'what is under the highpass is not fed back');
  assert.ok(h(500) < -15, 'the band under the cutoff is');
});

test('the filter envelope falls over Decay on a plain note and over 0.2 s on an accented one, to about 5%', () => {
  // Decay is the whole fall: three time constants.
  for (const [velocity, decay, seconds] of [[0.7, 2, 2], [0.7, 0.2, 0.2], [0.7, 2, 0.2], [1, 2, 0.2]]) {
    const { synth, run } = setup({ decay });
    run(1, (b) => { if (b === 0) synth.queueNoteOn(36, velocity, 0); });
    const blocks = Math.round((seconds * SR) / BLOCK);
    run(blocks - 1);
    const tau = (velocity >= 0.9 ? ACID_ACCENT_DECAY : decay) / 3;
    const expected = Math.exp(-(blocks * BLOCK) / (tau * SR));
    assert.ok(Math.abs(synth.env / expected - 1) < 0.02, `velocity ${velocity}, Decay ${decay}: ${synth.env} against ${expected} at ${seconds} s`);
    if (seconds === (velocity >= 0.9 ? ACID_ACCENT_DECAY : decay)) assert.ok(Math.abs(synth.env - 0.05) < 0.002, `at Decay it is ${synth.env}`);
  }
  // The accented time constant is 67 ms.
  const { synth, run } = setup({ decay: 2 });
  run(1, (b) => { if (b === 0) synth.queueNoteOn(36, 1, 0); });
  const t = (Math.round((0.0667 * SR) / BLOCK) * BLOCK) / SR;
  run(Math.round((0.0667 * SR) / BLOCK) - 1);
  assert.ok(Math.abs(synth.env - Math.exp(-t / (0.2 / 3))) < 0.01 && Math.abs(synth.env - Math.exp(-1)) < 0.03, `${synth.env}`);
});

test('a run of accents stacks the sweep, and higher resonance stacks it further', () => {
  const step = Math.round(0.12 * SR);
  const climb = (resonance) => {
    const { synth, run } = setup({ resonance, accent: 1 });
    const peaks = [0, 0, 0, 0, 0];
    let at = 0;
    run(Math.ceil((step * 5) / BLOCK), (b) => {
      at = b * BLOCK;
      for (let k = 0; k < 5; k++) {
        const on = k * step;
        const off = on + step / 2;
        if (on >= at && on < at + BLOCK) synth.queueNoteOn(36, 1, on - at);
        if (off >= at && off < at + BLOCK) synth.queueNoteOff(36, off - at);
      }
    }, () => {
      const k = Math.min(4, Math.floor(at / step));
      peaks[k] = Math.max(peaks[k], synth.sweep);
    });
    return peaks;
  };
  const low = climb(0);
  const high = climb(1);
  for (let k = 1; k < 5; k++) assert.ok(high[k] > high[k - 1], `accent ${k + 1} climbs over the one before at full resonance: ${high}`);
  assert.ok(high[4] / high[0] > 1.5, `full resonance climbs ${(high[4] / high[0]).toFixed(2)}x`);
  assert.ok(high[4] / high[0] > (low[4] / low[0]) + 0.3, `more than at none (${(low[4] / low[0]).toFixed(2)}x)`);
  // With the resonance down the sweep is close to the envelope itself: it starts near its top.
  assert.ok(low[0] > high[0], 'the first accent comes through more directly with the resonance down');
  // And a plain note does not charge it at all.
  const { synth, run } = setup({ resonance: 1, accent: 1 });
  run(40, (b) => { if (b === 0) synth.queueNoteOn(36, 0.7, 0); });
  assert.equal(synth.sweep, 0);
});

test('a slide glides in the same time whatever the interval, without starting the envelopes again', () => {
  const settle = (interval) => {
    const { synth, run } = setup({ slide: 0.06 });
    run(1, (b) => { if (b === 0) synth.queueNoteOn(36, 0.7, 0); });
    run(10);
    const envBefore = synth.env;
    const ampBefore = synth.amp;
    run(1, (b) => { if (b === 0) synth.queueNoteOn(36 + interval, 1, 0, true); });
    assert.ok(synth.env < envBefore, 'the filter envelope did not start again');
    assert.ok(synth.amp < ampBefore && !synth.attacking, 'nor the amp envelope');
    assert.equal(synth.accented, true, 'the note slid to takes its own accent');
    let blocks = 1;
    while (Math.abs(synth.pitch - (36 + interval)) > 0.05 * Math.abs(interval) && blocks < 400) { run(1); blocks++; }
    return blocks;
  };
  const near = settle(2);
  const far = settle(12);
  assert.ok(Math.abs(near - far) <= 1, `${near} blocks for a tone, ${far} for an octave`);
  assert.ok(Math.abs((near * BLOCK) / SR - 0.06) < 0.01, `most of the way in Slide (${((near * BLOCK) / SR).toFixed(3)} s)`);
});

test('a plain note jumps to its pitch and starts both envelopes; a slide with nothing sounding is a plain note', () => {
  const { synth, run } = setup();
  run(1, (b) => { if (b === 0) synth.queueNoteOn(36, 0.7, 0); });
  run(20);
  run(1, (b) => { if (b === 0) synth.queueNoteOn(43, 0.7, 0); });
  assert.equal(synth.pitch, 43);
  assert.ok(synth.env > 0.95, 'the filter envelope started again');
  const quiet = setup();
  quiet.run(1, (b) => { if (b === 0) quiet.synth.queueNoteOn(40, 0.7, 0, true); });
  assert.equal(quiet.synth.pitch, 40);
  assert.equal(quiet.synth.sliding, false);
});

test('one voice: a chord plays its last note, and only the sounding note ends the gate', () => {
  const { synth, run } = setup();
  run(1, (b) => { if (b === 0) { synth.queueNoteOn(36, 0.7, 0); synth.queueNoteOn(40, 0.7, 0); synth.queueNoteOn(43, 0.7, 0); } });
  assert.equal(synth.activeVoices, 1);
  assert.equal(synth.pitch, 43);
  run(1, (b) => { if (b === 0) synth.queueNoteOff(36, 0); });
  assert.equal(synth.gate, true, 'an earlier note ending leaves the gate up');
  run(1, (b) => { if (b === 0) synth.queueNoteOff(43, 0); });
  assert.equal(synth.gate, false);
});

test('the gate holds 8 ms and falls over 8 more; a slide into a note letting go takes it back up', () => {
  const { synth, run, out } = setup();
  run(1, (b) => { if (b === 0) synth.queueNoteOn(36, 0.7, 0); });
  run(20);
  const note = rms(out);
  run(1, (b) => { if (b === 0) synth.queueNoteOff(36, 0); });
  run(Math.ceil((0.017 * SR) / BLOCK));
  assert.equal(synth.gain, 0, 'silent 16 ms on');
  const end = out.length;
  run(4);
  // Nothing but the output coupling settling.
  assert.ok(rms(out, end) < 0.1 * note, `${rms(out, end)} after a note at ${note}`);
  // Into a note letting go, in its hold: the gate never drops.
  const again = setup();
  again.run(1, (b) => { if (b === 0) again.synth.queueNoteOn(36, 0.7, 0); });
  again.run(20);
  again.run(1, (b) => { if (b === 0) { again.synth.queueNoteOff(36, 0); again.synth.queueNoteOn(41, 0.7, BLOCK / 2, true); } });
  assert.equal(again.synth.gain, 1);
  assert.equal(again.synth.gate, true);
  assert.equal(again.synth.sliding, true);
});

/** A classic line - 16 steps at 125 bpm with accents and slides - for `bars` bars. */
function playLine(settings, bars = 2) {
  const steps = [[36, 1, 0], [36, 0, 0], [48, 0, 1], [46, 1, 0], [39, 0, 0], [36, 0, 0], [31, 1, 0], [36, 1, 0],
    [34, 0, 1], [36, 0, 0], [48, 1, 0], [36, 0, 0], [41, 0, 1], [39, 1, 1], [36, 0, 0], [43, 1, 0]];
  const step = (60 / 125 / 4) * SR;
  const events = [];
  for (let n = 0; n < bars * 16; n++) {
    const [note, accent, long] = steps[n % 16];
    const slide = n > 0 && steps[(n + 15) % 16][2] === 1;
    events.push({ at: Math.round(n * step), on: true, note, velocity: accent ? 1 : 0.7, slide });
    events.push({ at: Math.round(n * step + (long ? 1 : 0.5) * step - 0.005 * SR), on: false, note });
  }
  events.sort((a, b) => a.at - b.at);
  const { synth, run, out } = setup(settings);
  let next = 0;
  run(Math.ceil((bars * 16 * step) / BLOCK), (b) => {
    while (next < events.length && events[next].at < (b + 1) * BLOCK) {
      const e = events[next++];
      if (e.on) synth.queueNoteOn(e.note, e.velocity, e.at - b * BLOCK, e.slide);
      else synth.queueNoteOff(e.note, e.at - b * BLOCK);
    }
  });
  return Float32Array.from(out);
}

test('a line comes out with no DC, at every preset', () => {
  for (const [name, preset] of Object.entries({ defaults: {}, ...ACID.presets })) {
    const x = playLine(preset);
    let mean = 0;
    for (const v of x) mean += v;
    mean /= x.length;
    const level = rms(x);
    assert.ok(level > 0.005, `${name}: it sounds (${level})`);
    assert.ok(Math.abs(mean) < 0.01 * level, `${name}: DC is ${((100 * Math.abs(mean)) / level).toFixed(2)}% of the level`);
  }
});

test('the ends of every control stay finite and bounded, and decay to silence', () => {
  const extremes = [
    { resonance: 1, accent: 1, envmod: 1, cutoff: 2394, sweep: 4, drive: 1, volume: 1 },
    { resonance: 1, accent: 1, envmod: 1, cutoff: 314, sweep: 4, waveform: 1, shape: 1, tuning: 12, volume: 1 },
    { resonance: 1, accent: 1, envmod: 0, cutoff: 314, waveform: 1, shape: -1, tuning: -12, volume: 1 },
  ];
  for (const settings of extremes) {
    const x = playLine(settings);
    let peak = 0;
    for (const v of x) {
      assert.ok(Number.isFinite(v), `${JSON.stringify(settings)}: ${v}`);
      peak = Math.max(peak, Math.abs(v));
    }
    assert.ok(peak < 4, `${JSON.stringify(settings)}: peak ${peak}`);
  }
  // After the last note the voice settles to nothing and stops running.
  const { synth, run, out } = setup({ resonance: 1, accent: 1 });
  run(1, (b) => { if (b === 0) synth.queueNoteOn(36, 1, 0); });
  run(10, (b) => { if (b === 5) synth.queueNoteOff(36, 0); });
  run(Math.ceil((0.4 * SR) / BLOCK));
  assert.equal(synth.activeVoices, 0);
  assert.ok(Math.abs(out[out.length - 1]) < 1e-6);
  for (const s of synth.ladder.s) assert.ok(s === 0 || Math.abs(s) > 1e-30, 'no subnormal left in the ladder');
});

test('the pitch is the note, moved by Tuning and the bend', () => {
  const { synth, run } = setup({ tuning: 3 });
  synth.setBend(2);
  run(1, (b) => { if (b === 0) synth.queueNoteOn(45, 0.7, 0); });
  // The saw's phase step says the frequency it is playing.
  const before = synth.phase;
  run(1);
  const step = (synth.phase - before + 1) % 1 / BLOCK;
  assert.ok(Math.abs((step * SR) / midiToHz(50) - 1) < 0.01, `${step * SR} Hz`);
});

/** The ladder at a Character and a Resonance knob, as the voice sets it, with the voice's makeup. */
function characterResponse(cutoff, character, resonance) {
  const r = acidSkew(resonance);
  const k = acidFeedback(character) * r;
  const f = new AcidLadder(SR);
  f.set(cutoff, k, character, r);
  const N = 1 << 16;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = f.process(i === 0 ? 1e-4 : 0) / 1e-4;
  fft(re, im);
  const makeup = 20 * Math.log10(acidMakeup(r, character, k, cutoff));
  return (hz) => {
    const b = Math.round((hz * N) / SR);
    return 20 * Math.log10(Math.hypot(re[b], im[b])) + makeup;
  };
}

test('Character 0 is the circuit\'s ladder, unchanged', () => {
  const plain = new AcidLadder(SR);
  const zero = new AcidLadder(SR);
  plain.set(700, 9);
  zero.set(700, 9, 0, 0.7);
  for (let i = 0; i < 4096; i++) {
    const x = Math.sin(i * 0.05) * (i < 2000 ? 1.5 : 0);
    assert.equal(zero.process(x), plain.process(x));
  }
  const h = characterResponse(867, 0, 0);
  assert.ok(Math.abs(h(867) + 24.6) < 0.3 && Math.abs(h(2 * 867) + 38.3) < 0.3 && Math.abs(h(867 / 2) + 15.2) < 0.3);
});

test('Character 1 puts the corner on the cutoff and falls steeply from it', () => {
  for (const cutoff of [314, 867, 2394]) {
    const h = characterResponse(cutoff, 1, 0);
    assert.ok(Math.abs(h(cutoff) + 3) < 0.5, `${cutoff}: ${h(cutoff).toFixed(1)} dB at the cutoff`);
    assert.ok(h(2 * cutoff) < -20, `${cutoff}: ${h(2 * cutoff).toFixed(1)} dB an octave on`);
    assert.ok(h(4 * cutoff) < -40, `${cutoff}: ${h(4 * cutoff).toFixed(1)} dB two octaves on`);
    assert.ok(Math.abs(h(cutoff / 8)) < 0.5, 'the passband is at unity');
  }
  // In between it is in between: an octave over the cutoff is darker than at 1 and brighter than at 0.
  const at = (c) => characterResponse(867, c, 0)(867 / 2);
  assert.ok(at(0) < at(0.5) && at(0.5) < at(1));
});

test('across Character the resonance peaks at the cutoff, and a held note keeps its level across Resonance', () => {
  for (const character of [0.5, 1]) {
    const h = characterResponse(1000, character, 1);
    let best = 0;
    let bestDb = -Infinity;
    for (let hz = 400; hz < 3000; hz += 5) if (h(hz) > bestDb) { bestDb = h(hz); best = hz; }
    assert.ok(Math.abs(best / 1000 - 1) < 0.1, `Character ${character}: peak at ${best}`);
    assert.ok(bestDb - h(300) > 12, `Character ${character}: the peak stands ${(bestDb - h(300)).toFixed(1)} dB over the band under it`);
  }
  // A held note keeps its level as Resonance comes up, at any Character: only the peak stands out.
  const heldLevel = (character, resonance) => {
    let power = 0;
    for (const note of [29, 41, 53]) {
      const { synth, run, out } = setup({ cutoff: 867, character, resonance });
      run(1, (b) => { if (b === 0) synth.queueNoteOn(note, 0.7, 0); });
      run(Math.round((0.6 * SR) / BLOCK));
      const level = rms(out, Math.round(0.1 * SR));
      power += level * level;
    }
    return 10 * Math.log10(power / 3);
  };
  for (const character of [0, 0.5, 1]) {
    const levels = [0, 0.25, 0.5, 0.75, 1].map((resonance) => heldLevel(character, resonance));
    const spread = Math.max(...levels) - Math.min(...levels);
    assert.ok(spread < 3, `Character ${character}: a held note moves ${spread.toFixed(1)} dB across Resonance (${levels.map((l) => l.toFixed(1))})`);
  }
  // The feedback highpass still keeps a low cutoff from singing on its own.
  const f = new AcidLadder(SR);
  const r = acidSkew(1);
  f.set(300, acidFeedback(1) * r, 1, r);
  let early = 0;
  let late = 0;
  for (let i = 0; i < SR / 2; i++) {
    const y = Math.abs(f.process(i === 0 ? 1e-3 : 0));
    if (i > 50 && i < SR / 20) early = Math.max(early, y);
    if (i > SR / 4) late = Math.max(late, y);
  }
  assert.ok(late / early < 1e-3, 'rings on at 300 Hz');
});

test('Character swept at audio rate under the top of Resonance stays finite and bounded', () => {
  const synth = new AcidSynth(SR);
  const values = { ...defaults(), resonance: 1, accent: 1, envmod: 1, cutoff: 2394, sweep: 4, volume: 1 };
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  let peak = 0;
  for (let b = 0; b < 400; b++) {
    const character = Float32Array.from({ length: BLOCK }, (_, i) => 0.5 + 0.5 * Math.sin((2 * Math.PI * 300 * (b * BLOCK + i)) / SR));
    synth.setParams({ ...values, character });
    if (b % 20 === 0) synth.queueNoteOn(36 + (b % 40 === 0 ? 0 : 12), 1, 0, b % 60 === 0);
    if (b % 20 === 10) synth.queueNoteOff(36 + (b % 40 === 10 ? 0 : 12), 0);
    l.fill(0);
    synth.process(l, r, BLOCK);
    for (const v of l) {
      assert.ok(Number.isFinite(v));
      peak = Math.max(peak, Math.abs(v));
    }
  }
  assert.ok(peak > 0.05 && peak < 4, `peak ${peak}`);
});
