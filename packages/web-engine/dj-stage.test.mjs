// The DJ desk's half of the engine: every track's DJ stage, the headphone cue and its routes,
// the deck meters, and the FX unit's insert - wired against the stand-in graph (see
// fake-context.mjs). What it sounds like is checked in a browser; what is connected to what, and
// what a control lands on, is checked here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeAudioContext, fakeWorkletFor } from './fake-context.mjs';
import { catalog } from './src/catalog.mjs';
import { WebAudioEngine } from './src/engine/web-audio-engine.mjs';
import { DJ_NEUTRAL, DJ_RES_DEFAULT, SUPPORTED_CHANNELS, djEqGain, djFilterCoefs } from './src/engine/track.mjs';
import { bandShare } from './src/engine/desk-audio.mjs';

function makeEngine({ channels = 2 } = {}) {
  const ctx = new FakeAudioContext();
  ctx.destination.maxChannelCount = channels;
  const warnings = [];
  const engine = new WebAudioEngine(ctx, {
    registry: catalog,
    routeWaitMs: 1,
    warn: (line) => warnings.push(line),
    AudioWorkletNode: fakeWorkletFor(catalog),
  });
  return { ctx, engine, warnings };
}

test('every control of the DJ stage is a channel control here, as it is on the desktop', () => {
  for (const name of [...Object.keys(DJ_NEUTRAL), 'mdeck']) assert.ok(SUPPORTED_CHANNELS.includes(name), name);
  const { engine, warnings } = makeEngine();
  engine.createTrack('t');
  for (const [name, value] of Object.entries(DJ_NEUTRAL)) engine.setParam('t', -1, name, value, 0);
  assert.deepEqual(warnings, []);
});

test('a track nobody mixes carries no EQ or filter at all, and plays straight through', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  assert.equal(track.djEq, null);
  assert.equal(track.djFilter, null);
  assert.ok(track.panner.reaches(engine.master), 'the strip still reaches the master');
  // Setting the neutral values explicitly builds nothing either.
  engine.setParam('t', -1, 'eqlo', 1, 0);
  engine.setParam('t', -1, 'djf', 0, 0);
  assert.equal(track.djEq, null);
  assert.equal(track.djFilter, null);
});

test('moving a band builds the isolator and crossfades it in; back at neutral it crossfades out', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'eqlo', 1, 0); // the first value of a control steps; this one is neutral
  engine.setParam('t', -1, 'eqlo', 0, 0);
  const eq = track.djEq;
  assert.ok(eq, 'built on the first move away from neutral');
  // Twelve Butterworths: a Linkwitz-Riley pair on each side of each crossover, and the low band's
  // all-pass pair.
  const biquads = eq.nodes.filter((n) => n.kind === 'biquad');
  assert.equal(biquads.length, 12);
  assert.ok(biquads.every((b) => Math.abs(b.Q.value - 20 * Math.log10(Math.SQRT1_2)) < 1e-9), 'Butterworth Q, in decibels');
  assert.deepEqual([...new Set(biquads.map((b) => b.frequency.value))].sort((a, b) => a - b), [280, 4600]);
  assert.ok(eq.lo.gain.landedOn(0), 'the low band is killed');
  assert.ok(eq.wet.gain.landedOn(1) && eq.dry.gain.landedOn(0), 'the isolator is in the path');
  assert.ok(track.djTrim.reaches(eq.lo) && eq.wet.reaches(track.djLive));
  engine.setParam('t', -1, 'eqlo', 1, 0);
  assert.ok(eq.wet.gain.rampedTo(0) && eq.dry.gain.rampedTo(1), 'neutral again: out of the path');
});

test('an EQ band follows the knob law: a squared bottom, linear amplitude, a flat center, +6 dB at the top', () => {
  const at = (step) => djEqGain(step / 127.5); // a 0..255 knob step
  assert.equal(at(0), 0);
  assert.ok(Math.abs(at(5) - 25 / 1240) < 1e-12, 'squared over the bottom 10 steps');
  assert.ok(Math.abs(at(10) - 10 / 124) < 1e-12, 'meets the line at 10');
  assert.ok(Math.abs(at(62) - 0.5) < 1e-12, 'linear amplitude from there');
  for (const step of [124, 125, 127.5, 129, 130]) assert.equal(at(step), 1, `exactly unity at ${step}`);
  assert.ok(at(123) < 1 && at(131) > 1, 'the flat zone ends at 124 and 130');
  assert.ok(Math.abs(at(255) - 10 ** 0.3) < 1e-12, '+6 dB at the top');
  assert.equal(djEqGain(3), 10 ** 0.3, 'held to the knob');
  assert.equal(djEqGain(-1), 0);
});

test('a band moved inside the flat zone keeps the isolator out of the path; past it, in', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'eqlo', 1, 0);
  engine.setParam('t', -1, 'eqlo', 125 / 127.5, 0);
  engine.setParam('t', -1, 'eqhi', 129 / 127.5, 0);
  assert.equal(track.djEq, null, 'flat: nothing built');
  engine.setParam('t', -1, 'eqlo', 0.5, 0);
  assert.ok(track.djEq.lo.gain.landedOn(djEqGain(0.5)), 'the band lands on the law\'s gain, not the knob');
  assert.ok(track.djEq.hi.gain.landedOn(1));
});

// A Web Audio lowpass's or highpass's gain at `hz`, from the specification's biquad (its Q in
// decibels) - the same cookbook filter the desktop's BLowPass/BHiPass are.
function biquadGain(type, hz, fc, qDb, sr = 48000) {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const cw = Math.cos(w0);
  const b = type === 'lowpass' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
  const a = [1 + alpha, -2 * cw, 1 - alpha];
  const w = (2 * Math.PI * hz) / sr;
  const resp = (c) => [c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w), -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w))];
  const [nr, ni] = resp(b);
  const [dr, di] = resp(a);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}
const db = (g) => 20 * Math.log10(g);
// The cutoff an analog fc lands on through the bilinear transform without prewarping, at 48 kHz.
const unwarped = (fc, sr = 48000) => (sr / Math.PI) * Math.atan((Math.PI * fc) / sr);

test('the filter knob: 100 Hz full left, 8.2 kHz full right, cubic between, a flat center', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  const lastValue = (param) => param.calls.filter((c) => c.kind !== 'hold' && c.kind !== 'cancel').at(-1)?.value;
  const at = (djf) => {
    engine.setParam('t', -1, 'djf', djf, 0);
    const f = track.djFilter;
    return { lp: lastValue(f.lp.frequency), hp: lastValue(f.hp.frequency), q: lastValue(f.lp.Q), hq: lastValue(f.hp.Q), f };
  };
  engine.setParam('t', -1, 'djres', 0, 0); // a plain two-pole, so the corners read cleanly
  engine.setParam('t', -1, 'djf', 0, 0);
  engine.setParam('t', -1, 'djf', 0.015, 0);
  assert.equal(track.djFilter, null, 'inside the flat center nothing is built');
  const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
  // [knob, lowpass Hz, highpass Hz], from 100 + 25000(1 - x)^3 and 20 + 8200x^3,
  // x = (|djf| - 0.016) / 0.984.
  for (const [djf, lp, hp] of [[-1, 100, 20], [-0.5, 100 + 25000 * (1 - 0.484 / 0.984) ** 3, 20],
    [-0.017, 100 + 25000 * (1 - 0.001 / 0.984) ** 3, 20], [0.5, 25100, 20 + 8200 * (0.484 / 0.984) ** 3], [1, 25100, 8220]]) {
    const got = at(djf);
    near(got.lp, unwarped(lp), 1e-6, `lowpass at ${djf}`);
    near(got.hp, unwarped(hp), 1e-6, `highpass at ${djf}`);
  }
  // Measured off the filter itself: full left, the 100 Hz lowpass passes 50 Hz and takes 1 kHz
  // down by its 12 dB an octave; full right, the highpass (~7.5 kHz here) the same the other way.
  let got = at(-1);
  near(db(biquadGain('lowpass', 100, got.lp, got.q)), 0, 0.05, 'a res-0 lowpass is unity at its corner');
  near(db(biquadGain('lowpass', 1000, got.lp, got.q)), -40, 0.5, 'full left, 1 kHz is ~3.3 octaves past the corner');
  got = at(1);
  near(got.hp, 7540, 5, 'full right, the highpass lands at ~7.5 kHz at 48 kHz');
  near(db(biquadGain('highpass', 1000, got.hp, got.hq)), -36.5, 0.5, 'full right, 1 kHz is ~2.9 octaves below the corner');
  near(got.hq, 0, 1e-5, 'resonance 0 is a plain two-pole, Q 1 (0 dB)');
  engine.setParam('t', -1, 'djf', 0, 0);
  assert.ok(track.djFilter.wet.gain.rampedTo(0) && track.djFilter.dry.gain.rampedTo(1), 'the center takes it out');
});

test('the resonance is its own control, and its peak is held near +6 dB', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  const lastValue = (param) => param.calls.filter((c) => c.kind !== 'hold' && c.kind !== 'cancel').at(-1)?.value;
  assert.equal(track.dj.djres, DJ_RES_DEFAULT, 'an untouched resonance is the default');
  engine.setParam('t', -1, 'djf', 0, 0);
  engine.setParam('t', -1, 'djf', -0.5, 0);
  const f = track.djFilter;
  assert.ok(Math.abs(lastValue(f.lp.Q) - db(2)) < 1e-6, `the default is res 0.25, Q 2 (${lastValue(f.lp.Q)} dB)`);
  engine.setParam('t', -1, 'djres', 0, 0);
  assert.ok(Math.abs(lastValue(f.lp.Q)) < 1e-5, `none is a plain two-pole (Q ${lastValue(f.lp.Q)} dB)`);
  assert.equal(lastValue(f.peak.gain), 1, 'and needs no compensation');
  // [res, damping]: 0.5 + 0.5(1 - res/0.25)^2 up to 0.25, then 0.5 - 0.46(res - 0.25)/0.75.
  for (const [res, damping] of [[0, 1], [0.125, 0.5 + 0.5 * 0.25], [0.25, 0.5],
    [0.5, 0.5 - (0.46 * 0.25) / 0.75], [1, 0.04]]) {
    engine.setParam('t', -1, 'djres', res, 0);
    assert.ok(Math.abs(lastValue(f.lp.Q) - db(1 / damping)) < 1e-3, `res ${res}: Q ${lastValue(f.lp.Q)} dB`);
    assert.ok(Math.abs(lastValue(f.hp.Q) - db(0.5)) < 1e-9, 'the highpass resting at 20 Hz stays at Q 0.5');
  }
  // At full resonance (Q 25): the corner alone would be +29 dB; with the compensation, +6.
  const lp = lastValue(f.lp.frequency);
  const peak = db(biquadGain('lowpass', lp, lp, lastValue(f.lp.Q)) * lastValue(f.peak.gain));
  assert.ok(Math.abs(peak - 6.02) < 0.05, `the resonant peak is held at +6 dB (${peak})`);
  // A low highpass with the resonance up holds a damping of 2 (Q 0.5): no boom.
  const fc = 20 + 8200 * 0.1346 ** 3; // ~40 Hz
  engine.setParam('t', -1, 'djf', 0.016 + 0.984 * 0.1346, 0);
  assert.ok(Math.abs(lastValue(f.hp.frequency) - fc) < 0.1);
  assert.ok(Math.abs(lastValue(f.hp.Q) - db(0.5)) < 1e-9, `a 40 Hz highpass is held at Q 0.5 (${lastValue(f.hp.Q)} dB)`);
  assert.ok(Math.abs(lastValue(f.lp.Q) - db(Math.SQRT1_2)) < 1e-9, 'the lowpass resting open is a Butterworth');
  const top = lastValue(f.lp.frequency);
  assert.ok(db(biquadGain('lowpass', top, top, lastValue(f.lp.Q))) < -2.9, 'with no peak at the top');
  assert.ok(db(biquadGain('highpass', fc, fc, lastValue(f.hp.Q))) < -5.9);
  // ...and lets go by 250 Hz.
  engine.setParam('t', -1, 'djf', 0.016 + 0.984 * ((250 - 20) / 8200) ** (1 / 3) + 0.01, 0);
  assert.ok(Math.abs(lastValue(f.hp.Q) - db(1 / 0.04)) < 1e-3, 'past 250 Hz the resonance is its own');
  assert.ok(f.wet.gain.landedOn(1));
});

test('the filter settings, at the other common sample rate', () => {
  const c = djFilterCoefs(-1, 0, 44100);
  assert.ok(Math.abs(c.lpHz - unwarped(100, 44100)) < 1e-9);
  assert.ok(Math.abs(djFilterCoefs(0.5, 0, 44100).lpHz - unwarped(25100, 44100)) < 1e-9);
  assert.ok(djFilterCoefs(0.5, 0, 44100).lpHz < 22050, 'the parked lowpass is below Nyquist');
});

test('the fader gates the direct path and the sends; the deck gain only the direct path', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'fader', 0, 0);
  engine.setParam('t', -1, 'deck', 0.5, 0);
  assert.ok(track.faderGain.gain.landedOn(0));
  assert.ok(track.sendFader.gain.landedOn(0), 'a gated stem leaves whatever it was feeding too');
  assert.ok(track.deckGain.gain.landedOn(0.5));
  assert.ok(!track.sendFader.reaches(track.deckGain), 'a crossfade is applied once, at the end of a path');
  engine.setBusSends('t', [{ name: 'verb', amount: 1 }]);
  assert.ok(track.sendFader.reaches(engine.buses.get('verb')), 'the sends leave after the fader');
});

test('the cue sends the stage itself, pre-fader; a monitored track goes to it in full and nowhere else', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  assert.ok(track.cueGain.reaches(engine.desk.cueBus));
  engine.setParam('t', -1, 'fader', 0, 0);
  engine.setParam('t', -1, 'cue', 1, 0);
  assert.ok(track.cueGain.gain.landedOn(1), 'heard in the headphones with the fader down');
  engine.setParam('t', -1, 'cue', 0, 0);
  engine.setParam('t', -1, 'mon', 1, 0);
  assert.ok(track.cueGain.gain.landedOn(1), 'a monitored track is cued whatever its cue says');
  assert.ok(track.monGate.gain.landedOn(0) && track.sendMain.gain.landedOn(0), 'and the room hears none of it');
});

test('a track reports to the deck meter it is told to, and a group member to none', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setParam('t', -1, 'mdeck', 1, 0);
  assert.ok(track.djLive.reaches(engine.desk.deckMeters[1]));
  assert.ok(!track.djLive.reaches(engine.desk.deckMeters[0]));
  engine.setParam('t', -1, 'mdeck', -1, 0);
  assert.ok(!track.djLive.reaches(engine.desk.deckMeters[1]));
});

test('the FX unit is an insert: what the send opens, the direct path closes', () => {
  const { engine } = makeEngine();
  const track = engine.createTrack('t');
  engine.setFxSend('t', '#fxa', 1);
  assert.ok(track.fx.send.gain.rampedTo(1));
  assert.ok(track.fxDirect.gain.rampedTo(0));
  assert.ok(track.fx.fader.reaches(engine.buses.get('#fxa')));
  assert.ok(!track.fx.fader.reaches(track.deckGain), 'the return wears the crossfader, not the send');
  engine.setParam('t', -1, 'fader', 0, 0);
  assert.ok(track.fx.fader.gain.landedOn(0), 'a gated stem leaves the FX feed with the mix');
  engine.setFxSend('t', '', 0);
  assert.ok(track.fxDirect.gain.rampedTo(1));
});

test('the headphone knobs: mix crosses from the cue to the main mix, level is squared', () => {
  const { engine } = makeEngine();
  const d = engine.desk;
  engine.setHeadphones(1, 0);
  assert.ok(d.cueAmt.gain.rampedTo(1) && d.mainAmt.gain.rampedTo(0), 'mix 0: the cue only');
  engine.setHeadphones(0.5, 0.5);
  assert.ok(d.cueAmt.gain.rampedTo(1) && d.mainAmt.gain.rampedTo(1), 'centered: both at full');
  assert.ok(d.hpLevel.gain.rampedTo(0.25));
  engine.setHeadphones(1, 1);
  assert.ok(d.cueAmt.gain.rampedTo(0) && d.mainAmt.gain.rampedTo(1), 'mix 1: the main mix only');
});

test('a cue on a pair of this output plays there, and no pattern can reach that pair', () => {
  const { engine, ctx } = makeEngine({ channels: 4 });
  engine.createTrack('t');
  engine.setParam('t', -1, 'out', 2, 0); // .o(2) asks for channels 3/4
  engine.setCueRoute({ pair: 1 });
  assert.equal(engine.outputChannels, 4, 'the output is widened to the pair');
  assert.deepEqual(engine.cueRoute(), { pair: 1 });
  const merge = engine.desk._routeNodes.find((n) => n.kind === 'merger');
  assert.ok(merge.reaches(ctx.destination));
  assert.deepEqual(engine.desk._routeNodes.find((n) => n.kind === 'splitter').links.map((l) => l.input), [2, 3]);
  // With the cue on 3/4 there is one pair left for the room, and `.o(2)` wraps onto it.
  assert.equal(engine.tracks.get('t')._outPair, 0);
  engine.setCueRoute(null);
  assert.equal(engine.cueRoute(), null);
  assert.equal(engine.tracks.get('t')._outPair, 1, 'the pair is the room\'s again');
});

test('a cue to another device is a node the host carries away', () => {
  const { engine, ctx } = makeEngine();
  const away = ctx.createGain();
  engine.setCueRoute({ node: away });
  assert.ok(engine.desk.out.reaches(away));
  assert.deepEqual(engine.cueRoute(), { device: true });
});

test('a pair the output does not have is refused, not silently dropped', () => {
  const { engine } = makeEngine({ channels: 2 });
  assert.throws(() => engine.setCueRoute({ pair: 1 }), /no channels 3\/4/);
});

test('the deck meters exist only while somebody is looking, and read level and band balance', () => {
  const { engine, ctx } = makeEngine();
  assert.equal(engine.deckLevels(), null);
  engine.deckMeters(true);
  for (const a of ctx.created.filter((n) => n.kind === 'analyser')) a.feed(0.5, -20);
  const read = engine.deckLevels();
  assert.equal(read.a.p, 0.5);
  assert.equal(read.a.r, 0.5);
  assert.equal(read.a.b.length, 3);
  assert.ok(read.m);
  engine.deckMeters(false);
  assert.equal(engine.deckLevels(), null);
  assert.deepEqual(bandShare([0, 0, 0]), [0, 1, 0], 'silence reads as a neutral balance');
  assert.deepEqual(bandShare([1, 1, 2]), [0.25, 0.25, 0.5]);
});
