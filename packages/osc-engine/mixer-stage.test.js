'use strict';

// The track's DJ stage (poptart_dj, synthdef/defs.js) and the engine pieces around it, on the Node
// engine: trim -> 3-band isolator -> one-knob filter (cutoff + its own resonance) -> fader x deck.
//
// What this guards: the strip and the DJ stage build with and without a cue pair; channelDefault's
// neutrals (what the modulator-clear path snaps a control back to - a DJ control whose neutral
// became 0 would mute every track on clearing an LFO); createTrack's birth values; the note hold
// around a program load (warm swaps flush, cold loads drop the missed notes); the filter knob's
// ends; and where the deck meter and the headphone cue TAP the channel - after trim, before the
// fader, which is what makes the meter one you can gain-stage with. The last two are rendered
// offline through scsynth (skipped without it).

const { test } = require('node:test');
const assert = require('node:assert');
const synthdef = require('./synthdef');
const { decodeScgf } = require('./synthdef/decode');
const { renderNRT, ugen, G } = require('./test-support/nrt');
const U = require('./synthdef/ugens');
const { fakeEngine } = require('./test-support/fake-engine');

const SinOsc = ugen('SinOsc', [440, 0]);

const DEFAULT_CASES = [
  ['trim', 1], ['eqlo', 1], ['eqmid', 1], ['eqhi', 1],
  ['fader', 1], ['deck', 1], ['djf', 0], ['cue', 0],
  // The resonance AMOUNT: clearing a modulator off it lands on the filter's default (Q 2), never
  // a whistle.
  ['djres', require('./synthdef/defs').DJ_RES_DEFAULT],
  ['gain', 1], ['postgain', 1], ['out', 1], ['dry', 1], ['width', 1], ['pan', 0], ['bassmono', 0],
  // Per-slot dry/wet: neutral is the effect's own output, never a silent bypass.
  ['wet1', 1], ['wet7', 1],
  // The bend range divides the bend encoding, so its neutral is the 2 a synth powers up on.
  ['bend', 0], ['bendrange', 2],
];

const byName = (opts) => new Map(synthdef.defsFor(opts).map((e) => [e.name, decodeScgf(e.bytes)[0]]));

test('the strip and the DJ stage build, with and without a cue pair, and the neutrals are neutral', () => {
  for (const cueOffset of [null, 2]) {
    const defs = byName({ numOutputBusChannels: 4, cueOffset });
    const strip = defs.get('poptart_track_shared');
    const dj = defs.get('poptart_dj');
    assert.ok(strip && dj, `missing defs with cueOffset ${cueOffset}`);
    assert.deepStrictEqual(dj.paramNames.map((p) => p.name),
      ['in', 'ctl', 'trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'cue', 'cueBus', 'mdeck', 'meterBus', 'fxOut', 'fxSend', 'dryAr', 'djres']);
    const djres = dj.paramNames.find((p) => p.name === 'djres');
    assert.ok(dj.params[djres.index] === 0.25, 'the resonance defaults to Q 2');
  }
  const { E } = fakeEngine();
  for (const [name, expected] of DEFAULT_CASES) assert.strictEqual(E.channelDefault(name), expected, `channelDefault("${name}")`);
});

test('createTrack carries trailing name/value pairs into the track as birth values', async () => {
  const { E, sent } = fakeEngine();
  E.dispatch('/poptart/createTrack', ['probe', 'deck', 0, 'fader', 0.5]);
  E.dispatch('/poptart/createTrack', ['bare']);
  for (let i = 0; i < 50 && !(E.isTrack(E.tracks.get('probe')) && E.isTrack(E.tracks.get('bare'))); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const strips = sent.filter((m) => m[0] === '/s_new' && m[1] === 'poptart_track_shared');
  assert.strictEqual(strips.length, 2);
  const args = (m) => {
    const out = {};
    for (let i = 5; i + 1 < m.length; i += 2) out[m[i]] = m[i + 1];
    return out;
  };
  const born = strips.map(args);
  assert.ok(born.some((a) => a.deck === 0 && Math.abs(a.fader - 0.5) < 1e-6), 'the birth values did not reach the strip');
  assert.ok(born.some((a) => !('fader' in a) && !('deck' in a)), 'a bare createTrack must carry no birth values');
});

test('the note hold: a warm swap flushes what it held, a cold load drops the missed notes', () => {
  const { E } = fakeEngine();
  const now = E.elapsed();
  let fired = [];
  E.statePending.set(E.slotKey('t', 0), { seq: 1, at: now });
  assert.strictEqual(E.waitForLoad('t', 0, now + 0.01, () => fired.push('a')), true, 'a note at a warm swap onset must wait');
  assert.strictEqual(E.waitForLoad('t', 0, now + 1.0, () => fired.push('x')), false, 'a note far past a warm swap passes through');
  E.clearPending(E.slotKey('t', 0), 1);
  assert.deepStrictEqual(fired, ['a'], 'releasing a warm swap must flush its held note');
  fired = [];
  E.statePending.set(E.slotKey('t', 0), { seq: 2, at: now - 0.2, cold: true });
  assert.strictEqual(E.waitForLoad('t', 0, now - 0.1, () => fired.push('stale')), true, 'a cold load claims late notes');
  assert.strictEqual(E.waitForLoad('t', 0, now + 5, () => fired.push('future')), true, "a cold load's window does not expire while it opens");
  E.clearPending(E.slotKey('t', 0), 2);
  assert.deepStrictEqual(fired, ['future'], 'a cold release drops the missed note and keeps the future one');
});

// One render of the DJ stage per case: a 1kHz tone in, the direct out on 0-1, the deck meter
// (mdeck 0) on 2-3 and the cue on 4-5. The strip's published controls ride control bus 0.
function renderDj(set) {
  const dj = synthdef.defsFor().find((e) => e.name === 'poptart_dj').def;
  const src = new G.SynthDef('dj_src', { bus: 0, hz: 1000 }, (c) => {
    const s = G.mul(SinOsc.ar(c.hz, 0), 0.5);
    U.Out.ar(c.bus, [s, s]);
  });
  const fader = set.fader ?? 1;
  return renderNRT([
    [0, ['/d_recv', dj]],
    [0, ['/d_recv', src]],
    // [fader, main, deck, dry, out, pairs], as the strip publishes them.
    [0, ['/c_setn', 0, 6, fader, 1, 1, 1, 1, 1]],
    [0.001, ['/s_new', 'dj_src', 1000, 0, 0, 'bus', 16, 'hz', set.hz ?? 1000]],
    [0.001, ['/s_new', 'poptart_dj', 1001, 1, 0, 'in', 16, 'ctl', 0, 'cueBus', 4, 'meterBus', 2, 'mdeck', 0,
      'fxOut', 1000000, ...Object.entries(set).filter(([k]) => k !== 'fader' && k !== 'hz').flat()]],
  ], { duration: set.duration ?? 0.6, outChannels: 6 });
}

const rms = (r, ch, from = 0.4, to = 0.6) => {
  let s = 0;
  let n = 0;
  for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) { s += r.at(ch, i) ** 2; n++; }
  return Math.sqrt(s / n);
};

test('the filter knob: centered is untouched, full left closes the lowpass, full right the highpass', (t) => {
  const open = renderDj({ djf: 0, cue: 1 });
  if (!open.data) { t.skip(open.why); return; }
  const ref = rms(open, 0);
  assert.ok(ref > 0.3, `the centered filter should pass the tone (rms ${ref})`);
  const low = renderDj({ djf: -1 });
  const high = renderDj({ djf: 1 });
  assert.ok(rms(low, 0) < ref * 0.05, `full left should close the lowpass to 100 Hz (rms ${rms(low, 0)} of ${ref})`);
  assert.ok(rms(high, 0) < ref * 0.05, `full right should close the highpass to 8.2 kHz (rms ${rms(high, 0)} of ${ref})`);
});

// The filter's expected gain at `hz` for a knob and a resonance: the cookbook lowpass and highpass
// (what BLowPass/BHiPass and Web Audio's biquads are) at the cutoffs and damping the mapping
// gives, times its compensation. Written out from the mapping itself, not from the def.
function expectedDb(djf, res, hz, sr = 48000) {
  const x = Math.min(1, Math.max(0, (Math.abs(djf) - 0.016) / 0.984));
  const lpNom = djf < 0 ? 100 + 25000 * (1 - x) ** 3 : 25100;
  const hpNom = djf > 0 ? 20 + 8200 * x ** 3 : 20;
  const d0 = res <= 0.25 ? 0.5 + 0.5 * (1 - res / 0.25) ** 2 : 0.5 - (0.46 * (res - 0.25)) / 0.75;
  // The highpass held at Q 0.5 at 70 Hz and below, resting or not, easing off to nothing at 250 Hz; the resting lowpass a Butterworth.
  const dHp = Math.max(d0, 2 * Math.min(1, Math.max(0, (250 - hpNom) / 180)) ** 3);
  const dLp = djf > 0 ? Math.SQRT2 : d0;
  const unwarp = (fc) => (sr / Math.PI) * Math.atan((Math.PI * fc) / sr);
  const gain = (type, fc) => {
    const d = type === 'lp' ? dLp : dHp;
    const w0 = (2 * Math.PI * unwarp(fc)) / sr;
    const alpha = (Math.sin(w0) * d) / 2;
    const cw = Math.cos(w0);
    const b = type === 'lp' ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    const a = [1 + alpha, -2 * cw, 1 - alpha];
    const w = (2 * Math.PI * hz) / sr;
    const at = (c) => Math.hypot(c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w), c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
    return at(b) / at(a);
  };
  return 20 * Math.log10(gain('lp', lpNom) * gain('hp', hpNom) * Math.min(1, 2 * Math.min(dLp, dHp)));
}

test('the filter knob measured: cubic cutoffs to 100 Hz and 8.2 kHz, the resonance peak held near +6 dB', (t) => {
  const probe = renderDj({ djf: 0 });
  if (!probe.data) { t.skip(probe.why); return; }
  const inRms = 0.5 / Math.SQRT2;
  // The corners as heard at 48 kHz: the analog cutoffs through the unwarped bilinear transform.
  const unwarp = (fc) => (48000 / Math.PI) * Math.atan((Math.PI * fc) / 48000);
  const lp = (djf) => unwarp(100 + 25000 * (1 - (Math.abs(djf) - 0.016) / 0.984) ** 3);
  const hp = (djf) => unwarp(20 + 8200 * ((djf - 0.016) / 0.984) ** 3);
  const cases = [
    // [what, settings] - tones at, above and below a few cutoffs, with and without resonance.
    ['full left, at the 100 Hz corner', { djf: -1, djres: 0, hz: 100, duration: 1 }],
    ['full left, an octave above', { djf: -1, djres: 0, hz: 200, duration: 1 }],
    ['half left, at the corner', { djf: -0.5, djres: 0, hz: lp(-0.5) }],
    ['half left, two octaves above', { djf: -0.5, djres: 0, hz: lp(-0.5) * 4 }],
    ['half right, at the corner', { djf: 0.5, djres: 0, hz: hp(0.5) }],
    ['full right, 1 kHz', { djf: 1, djres: 0, hz: 1000 }],
    ['half left, mid resonance, at the corner', { djf: -0.5, djres: 0.5, hz: lp(-0.5) }],
    ['half left, full resonance, at the corner', { djf: -0.5, djres: 1, hz: lp(-0.5) }],
    ['half left, full resonance, in the passband', { djf: -0.5, djres: 1, hz: 200 }],
    ['a 40 Hz highpass, full resonance, held at Q 0.5', { djf: 0.016 + 0.984 * 0.1346, djres: 1, hz: 40, duration: 1.5 }],
    // The partner at rest adds nothing: no 20 Hz boom under a resonant lowpass, no peak at the
    // top under a resonant highpass.
    ['half left, full resonance, 20 Hz', { djf: -0.5, djres: 1, hz: 20, duration: 1.5 }],
    ['half right, full resonance, near the top', { djf: 0.5, djres: 1, hz: 15600 }],
    ['a 1 kHz highpass, full resonance, at the corner', { djf: 0.016 + 0.984 * ((1000 - 20) / 8200) ** (1 / 3), djres: 1, hz: unwarp(1000) }],
  ];
  for (const [what, set] of cases) {
    const r = renderDj(set);
    const from = (set.duration ?? 0.6) - 0.3;
    const got = 20 * Math.log10(rms(r, 0, from, from + 0.3) / inRms);
    const want = expectedDb(set.djf, set.djres, set.hz);
    assert.ok(Math.abs(got - want) < 0.5, `${what}: ${got.toFixed(2)} dB, expected ${want.toFixed(2)} dB`);
  }
  // The cap itself, measured: full resonance at the corner is +6 dB, not the +28 dB Q 25 gives.
  const peak = renderDj({ djf: -0.5, djres: 1, hz: lp(-0.5) });
  const peakDb = 20 * Math.log10(rms(peak, 0, 0.3, 0.6) / inRms);
  assert.ok(peakDb > 5 && peakDb < 7, `the resonant peak should sit near +6 dB (${peakDb.toFixed(2)})`);
  const sub = renderDj({ djf: -0.5, djres: 1, hz: 20, duration: 1.5 });
  const pass = renderDj({ djf: -0.5, djres: 1, hz: 200 });
  const subDb = 20 * Math.log10(rms(sub, 0, 1.2, 1.5) / rms(pass, 0, 0.3, 0.6));
  assert.ok(subDb < 0, `the resting highpass must not boom at 20 Hz (${subDb.toFixed(2)} dB over the passband)`);
});

test('the deck meter and the cue read the channel after trim and before the fader', (t) => {
  const base = renderDj({ cue: 1 });
  if (!base.data) { t.skip(base.why); return; }
  const meter = rms(base, 2);
  const cue = rms(base, 4);
  assert.ok(meter > 0.3 && cue > 0.3, `the meter (${meter}) and the cue (${cue}) should hear the channel`);
  // Trim down: the taps go quiet with it - a meter that ignored trim could not set it.
  const trimmed = renderDj({ cue: 1, trim: 0 });
  assert.ok(rms(trimmed, 2) < 1e-4, 'the deck meter is read before trim - it shows level on a dead channel');
  assert.ok(rms(trimmed, 4) < 1e-4, 'the headphone cue is taken before trim');
  // Fader down: the direct path goes, the meter and the cue stay - a faded deck still cues.
  const faded = renderDj({ cue: 1, fader: 0 });
  assert.ok(rms(faded, 0) < 1e-4, 'the fader did not close the direct output');
  assert.ok(rms(faded, 2) > meter * 0.9, 'the meter follows the fader, so a cued deck reads as silent');
  assert.ok(rms(faded, 4) > cue * 0.9, 'the cue follows the fader');
});
