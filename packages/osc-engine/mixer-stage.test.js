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
  // The resonance AMOUNT: clearing a modulator off it must land on a plain sweep, never a whistle.
  ['djres', 0],
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
      ['in', 'ctl', 'trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'cue', 'cueBus', 'mdeck', 'meterBus', 'fxOut', 'fxSend', 'dryAr']);
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
  const src = new G.SynthDef('dj_src', { bus: 0 }, (c) => {
    const s = G.mul(SinOsc.ar(1000, 0), 0.5);
    U.Out.ar(c.bus, [s, s]);
  });
  const fader = set.fader ?? 1;
  return renderNRT([
    [0, ['/d_recv', dj]],
    [0, ['/d_recv', src]],
    // [fader, main, deck, dry, out, pairs], as the strip publishes them.
    [0, ['/c_setn', 0, 6, fader, 1, 1, 1, 1, 1]],
    [0.001, ['/s_new', 'dj_src', 1000, 0, 0, 'bus', 16]],
    [0.001, ['/s_new', 'poptart_dj', 1001, 1, 0, 'in', 16, 'ctl', 0, 'cueBus', 4, 'meterBus', 2, 'mdeck', 0,
      'fxOut', 1000000, ...Object.entries(set).filter(([k]) => k !== 'fader').flat()]],
  ], { duration: 0.6, outChannels: 6 });
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
  assert.ok(rms(low, 0) < ref * 0.05, `full left should close the lowpass to 20 Hz (rms ${rms(low, 0)} of ${ref})`);
  assert.ok(rms(high, 0) < ref * 0.2, `full right should close the highpass to 18 kHz (rms ${rms(high, 0)} of ${ref})`);
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
