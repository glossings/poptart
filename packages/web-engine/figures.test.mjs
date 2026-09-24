import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultValues, defineDevice } from './src/descriptor.mjs';
import { buildFigures, figuresFor, subsumedParams } from './src/figures.mjs';
import { buildPanel } from './src/panel.mjs';
import { WAVETABLE } from './src/devices/wavetable.mjs';
import { FILTER } from './src/devices/filter.mjs';
import { EQ } from './src/devices/eq.mjs';
import { COMPRESSOR } from './src/devices/compressor.mjs';
import { MULTIBAND } from './src/devices/multiband.mjs';
import { GRANULAR, grainWindow } from './src/devices/granular.mjs';
import { sharedBuiltInTables } from './src/dsp/tables.mjs';
import { WavetableOscillator } from './src/dsp/oscillator.mjs';
import { curveShape } from './src/dsp/adsr.mjs';
import { FILTER_MODES } from './src/dsp/filters.mjs';
import { DISTORT } from './src/devices/distort.mjs';
import { DELAY } from './src/devices/delay.mjs';
import { STUTTER } from './src/devices/stutter.mjs';
import { REVERB } from './src/devices/reverb.mjs';
import { CHORUS } from './src/devices/chorus.mjs';
import { PHASER } from './src/devices/phaser.mjs';
import { DUCKER } from './src/devices/ducker.mjs';
import { shape, autoGainFor } from './src/dsp/shapers.mjs';
import { SYNC_OPTIONS } from './src/dsp/sync.mjs';

const tables = sharedBuiltInTables();
const opts = { tables, sampleRate: 48000 };
const defaults = defaultValues(WAVETABLE);

/** The Wavetable's figures, against its defaults with `over` applied on top. */
const figures = (over = {}) => buildFigures(WAVETABLE, { ...defaults, ...over }, opts);
const figureOf = (kind, over = {}, nth = 0) => figures(over).filter((f) => f.kind === kind)[nth];

// --- the specs -------------------------------------------------------------------------------

const spec = (figure, params = [{ id: 'a', name: 'A', min: 0, max: 1, default: 0 }]) => () =>
  defineDevice({ id: 'T', kind: 'fx', license: 'AGPL-3.0-only', params, figures: [figure] });

test('a figure naming a parameter the device does not have is refused at load', () => {
  assert.throws(spec({
    id: 'f', kind: 'adsr',
    params: { attack: 'nope', decay: 'a', sustain: 'a', release: 'a' },
  }), /names parameter "nope"/);
});

test('a figure missing a role its kind cannot be drawn without is refused', () => {
  assert.throws(spec({ id: 'f', kind: 'adsr', params: { attack: 'a', decay: 'a', sustain: 'a' } }),
    /needs a parameter for "release"/);
});

test('an unknown figure kind is refused, and says what is known', () => {
  assert.throws(spec({ id: 'f', kind: 'spectrogram', params: {} }), /unknown kind "spectrogram"/);
  assert.throws(spec({ id: 'f', kind: 'spectrogram', params: {} }), /wavetable, unison, response, adsr, eq, band, matrix/);
});

test('a figure cannot subsume or drag a role it has no parameter for', () => {
  const roles = { attack: 'a', decay: 'a', sustain: 'a', release: 'a' };
  assert.throws(spec({ id: 'f', kind: 'adsr', params: roles, subsumes: ['curve'] }),
    /subsumes "curve"/);
  assert.throws(spec({ id: 'f', kind: 'adsr', params: roles, drag: { x: 'curve' } }),
    /drags "curve"/);
});

test('two figures cannot share an id', () => {
  const one = { id: 'f', kind: 'adsr', params: { attack: 'a', decay: 'a', sustain: 'a', release: 'a' } };
  assert.throws(() => defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'a', name: 'A', min: 0, max: 1, default: 0 }],
    figures: [one, { ...one }],
  }), /duplicate figure id "f"/);
});

test('a device that declares no figures has none, and is not broken by asking', () => {
  const d = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'a', name: 'A', min: 0, max: 1, default: 0 }],
  });
  assert.deepEqual(d.figures, []);
  assert.deepEqual(buildFigures(d, {}), []);
  assert.deepEqual([...subsumedParams(d)], []);
});

// --- what the panel does with them -----------------------------------------------------------

test('the Wavetable draws a figure for each oscillator and its envelope', () => {
  assert.deepEqual(figures().map((f) => `${f.group}:${f.kind}`), [
    'Osc 1:wavetable', 'Osc 1 Unison:unison',
    'Osc 2:wavetable', 'Osc 2 Unison:unison',
    'Amp Env:adsr',
  ]);
});

test('a figure takes a control over only where the control has nothing to add', () => {
  // The table control MOVES onto its picture: the name of the table belongs on the picture of
  // the table, and a second copy of it in a row of knobs says nothing twice. The envelope's
  // four TIMES do NOT move - a curve is the right way to see an envelope and the wrong way to
  // set one to exactly a hundred and twenty milliseconds, so the knobs stay and the two mirror
  // each other. Its three CURVES do move, because a curve has no number worth typing and every
  // one of them is set by the wheel over the stage it bends - as knobs they were three more
  // controls in a group of eight, which wrapped and broke the four times across two lines.
  assert.deepEqual(
    [...subsumedParams(WAVETABLE)].sort(),
    ['env.acurve', 'env.dcurve', 'env.rcurve', 'osc1.table', 'osc2.table'],
  );
  const panel = buildPanel(WAVETABLE, defaults, new Map(), opts);
  const section = (title) => panel.sections.find((s) => s.title === title);
  const wave = section('Osc 1').figures.find((f) => f.kind === 'wavetable');
  assert.deepEqual(wave.widgets.map((w) => w.id), ['osc1.table'], 'drawn on the picture of the table');
  assert.ok(!section('Osc 1').widgets.some((w) => w.id === 'osc1.table'), 'and not under it as well');
  assert.equal(section('Amp Env').figures.length, 1);
  assert.deepEqual(section('Amp Env').widgets.map((w) => w.id), [
    'ampenv.attack', 'ampenv.decay', 'ampenv.sustain', 'ampenv.release', 'env.scale',
  ], 'the four times together, then the scale - the curves are the picture\'s');
  // The Filter effect's response curve JOINS its knobs rather than replacing them: a cutoff is
  // worth both a picture and a number.
  const filter = buildPanel(FILTER, defaultValues(FILTER), new Map(), opts);
  assert.equal(filter.sections[0].figures.length, 1);
  assert.equal(filter.sections[0].widgets.length, 6);
  assert.deepEqual(filter.sections[0].figures[0].widgets, [], 'and takes no control onto its heading');
});

test('a figure is handed to the section it named, and one with no group goes above the lot', () => {
  const d = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'a', name: 'A', min: 0, max: 1, default: 0.5 }],
    figures: [{ id: 'f', kind: 'unison', params: { count: 'a', detune: 'a', spread: 'a' } }],
  });
  // No group, and the device's parameters have no group either - so it belongs to that section,
  // which is a section like any other, and is not ALSO drawn above the panel.
  const panel = buildPanel(d, {});
  assert.equal(panel.sections[0].figures.length, 1);
  assert.deepEqual(panel.figures, []);

  // A figure naming a group that holds no parameters has no section to be handed to, and is drawn
  // above the lot rather than dropped.
  const orphan = defineDevice({
    id: 'T', kind: 'fx', license: 'AGPL-3.0-only',
    params: [{ id: 'a', name: 'A', min: 0, max: 1, default: 0.5, group: 'Knobs' }],
    figures: [{ id: 'f', kind: 'unison', group: 'Scope', params: { count: 'a', detune: 'a', spread: 'a' } }],
  });
  const orphanPanel = buildPanel(orphan, {});
  assert.equal(orphanPanel.figures.length, 1);
  assert.deepEqual(orphanPanel.sections.map((x) => x.figures.length), [0]);
});

test('only the figures naming a parameter are recomputed when it moves', () => {
  assert.deepEqual(figuresFor(FILTER, 'cutoff', defaultValues(FILTER), opts).map((f) => f.id), ['response']);
  assert.deepEqual(figuresFor(WAVETABLE, 'osc2.position', defaults, opts).map((f) => f.id), ['osc2.wave']);
  assert.deepEqual(figuresFor(WAVETABLE, 'env.dcurve', defaults, opts).map((f) => f.id), ['ampenv']);
  assert.deepEqual(figuresFor(WAVETABLE, 'level', defaults, opts), []);
});

test('a figure reports which of its parameters something else is driving', () => {
  const panel = buildPanel(FILTER, defaultValues(FILTER), new Map([['cutoff', 'lfo']]), opts);
  const response = panel.sections[0].figures[0];
  assert.deepEqual(response.driven, { cutoff: 'lfo' });
  // Passed on as parameter ids, not roles: the client sends these to the route a knob sends to.
  assert.deepEqual(response.drag, { x: 'cutoff', y: 'resonance' });
});

test('a value outside a parameter is the parameter default, not a hole in the picture', () => {
  const f = buildFigures(WAVETABLE, {}, opts).find((x) => x.kind === 'adsr');
  assert.equal(f.attack, 0.005);
  assert.equal(f.sustain, 0.8);
});

// --- the wavetable --------------------------------------------------------------------------

test('the drawn waveform is the frame pair the position lands between', () => {
  const f = figureOf('wavetable', { 'osc1.position': 0.42 });
  assert.equal(f.table, 'Basic');
  assert.equal(f.frameCount, 7);
  assert.deepEqual(f.between, [2, 3]);
  assert.deepEqual(f.frameNames.slice(2, 4), ['saw', 'square']);
  assert.ok(Math.abs(f.mix - 0.52) < 0.01);
  assert.equal(f.stack.length, 7, 'every frame is drawn behind the live one');

  // At either end the position sits ON a frame, and the blend has nowhere to go.
  assert.deepEqual(figureOf('wavetable', { 'osc1.position': 0 }).between, [0, 1]);
  assert.equal(figureOf('wavetable', { 'osc1.position': 0 }).mix, 0);
  assert.deepEqual(figureOf('wavetable', { 'osc1.position': 1 }).between, [6, 6]);
});

test('a position on the first frame draws that frame - the shipped table opens on a sine', () => {
  const f = figureOf('wavetable', { 'osc1.position': 0 });
  // One cycle of a sine, checked at the quarter points rather than sample by sample.
  const at = (turn) => f.wave[Math.round(turn * f.wave.length) % f.wave.length];
  assert.ok(Math.abs(at(0)) < 0.02, 'starts at zero');
  assert.ok(Math.abs(at(0.25) - 1) < 0.02, 'peaks a quarter in');
  assert.ok(Math.abs(at(0.75) + 1) < 0.02, 'troughs three quarters in');
});

test('the warp is drawn into the waveform, because it is what the oscillator reads', () => {
  const dry = figureOf('wavetable', { 'osc1.position': 0 });
  const wet = figureOf('wavetable', { 'osc1.position': 0, 'osc1.warp': 0.8, 'osc1.warpmode': 5 });
  assert.equal(wet.warpModeName, 'sync');
  assert.notDeepEqual(dry.wave, wet.wave);
  // Zero is neutral in every warp mode, so a mode with no amount changes nothing.
  const neutral = figureOf('wavetable', { 'osc1.position': 0, 'osc1.warp': 0, 'osc1.warpmode': 5 });
  assert.deepEqual(neutral.wave, dry.wave);
});

test('each oscillator draws its own table, from its own parameters', () => {
  const both = figures({ 'osc1.table': 0, 'osc2.table': 2 }).filter((f) => f.kind === 'wavetable');
  assert.deepEqual(both.map((f) => f.table), ['Basic', 'Odd']);
});

// --- the unison spread -----------------------------------------------------------------------

test('the spread picture is the spread the oscillator plays, not a second copy of the maths', () => {
  const count = 5;
  const detune = 40;
  const spread = 0.75;
  const f = figureOf('unison', { 'osc1.unison': count, 'osc1.detune': detune, 'osc1.spread': spread });

  const osc = new WavetableOscillator(48000);
  osc.unison = count;
  osc.detuneCents = detune;
  osc.panSpread = spread;
  assert.equal(osc.prepare(), count);

  assert.equal(f.copies.length, count);
  for (let i = 0; i < count; i++) {
    // The figure reports cents, which is the ratio the oscillator is playing read back as a musical
    // distance - so comparing them compares the picture against the sound.
    assert.ok(Math.abs(Math.pow(2, f.copies[i].cents / 1200) - osc.ratios[i]) < 1e-12, `copy ${i} detune`);
    assert.ok(Math.abs(f.copies[i].gainL - osc.gainsL[i]) < 1e-12, `copy ${i} left gain`);
    assert.ok(Math.abs(f.copies[i].gainR - osc.gainsR[i]) < 1e-12, `copy ${i} right gain`);
  }
  // Evenly spaced and centered: the copies at either end sit the WHOLE detune out, not half of it,
  // so the spread the picture is laid out against is plus and minus the parameter.
  assert.ok(Math.abs(f.copies[0].cents + detune) < 1e-9, `outermost copy at ${f.copies[0].cents} ct`);
  assert.ok(Math.abs(f.copies[count - 1].cents - detune) < 1e-9);
  assert.equal(f.maxCents, detune);
  assert.ok(Math.abs(f.copies[(count - 1) / 2].cents) < 1e-9, 'the middle copy is in tune');
  // The axis is fixed at the control's full range, not at the detune: laid out against the
  // detune, the outer copies sat at the edges of the box whatever the knob said.
  assert.equal(f.axisCents, 100);
  const wider = figureOf('unison', { 'osc1.unison': count, 'osc1.detune': 80, 'osc1.spread': spread });
  assert.ok(Math.abs(wider.copies[0].x) > Math.abs(f.copies[0].x), 'a wider detune draws wider');
  assert.ok(Math.abs(f.copies[0].x) < 1, 'and forty cents does not reach the edge');
  const narrow = figureOf('unison', { 'osc1.unison': count, 'osc1.detune': 4, 'osc1.spread': spread });
  assert.ok(Math.abs(narrow.copies[0].x) > 0.1, 'while four cents is still a visible spread');
});

test('one copy sits in the middle however wide the detune is set', () => {
  const f = figureOf('unison', { 'osc1.unison': 1, 'osc1.detune': 100, 'osc1.spread': 1 });
  assert.equal(f.copies.length, 1);
  assert.equal(f.copies[0].cents, 0);
  assert.ok(Math.abs(f.copies[0].pan) < 1e-9, 'dead center, whatever the spread is set to');
  assert.equal(f.maxCents, 0, 'and no axis to lay out, since there is nothing to spread');
});

// --- the filter response ---------------------------------------------------------------------

/** The drawn level nearest the corner - what the curve says the filter does at its cutoff. */
function atCorner(f) {
  let best = f.points[0];
  for (const p of f.points) {
    if (Math.abs(Math.log(p.hz / f.corner)) < Math.abs(Math.log(best.hz / f.corner))) best = p;
  }
  return best.db;
}

/** The Filter effect's response, against its defaults with `over` applied on top. */
const response = (over) => buildFigures(FILTER, { ...defaultValues(FILTER), cutoff: 1000, resonance: 0, ...over }, opts).find((f) => f.kind === 'response');

test('the response curve puts the ladder six decibels below the lowpass at the corner', () => {
  // Both the descriptor and filters.mjs claim exactly this, and the curve is drawn from the
  // filters' own coefficients - so if the claim ever stops being true, this fails rather than the
  // picture quietly disagreeing with the sound.
  const lowpass = atCorner(response({ 'mode': FILTER_MODES.indexOf('lowpass') }));
  const ladder = atCorner(response({ 'mode': FILTER_MODES.indexOf('ladder') }));
  assert.ok(Math.abs(lowpass + 6) < 0.1, `lowpass sits at ${lowpass} dB`);
  assert.ok(Math.abs(ladder + 12) < 0.1, `ladder sits at ${ladder} dB`);
  assert.ok(Math.abs((lowpass - ladder) - 6) < 0.1, 'and the gap between them is the six');
});

test('each mode passes what it is supposed to and stops what it is not', () => {
  const band = (mode, hz) => {
    const f = response({ 'mode': FILTER_MODES.indexOf(mode) });
    let best = f.points[0];
    for (const p of f.points) if (Math.abs(p.hz - hz) < Math.abs(best.hz - hz)) best = p;
    return best.db;
  };
  assert.ok(band('lowpass', 50) > -1, 'a lowpass passes what is under it');
  assert.ok(band('lowpass', 16000) < -40, 'and stops what is over it');
  assert.ok(band('highpass', 16000) > -1);
  assert.ok(band('highpass', 50) < -40);
  assert.ok(band('bandpass', 50) < -20 && band('bandpass', 16000) < -20);
  assert.ok(atCorner(response({ 'mode': FILTER_MODES.indexOf('notch') })) < -40, 'a notch notches');
  assert.ok(band('notch', 50) > -1 && band('notch', 16000) > -1, 'and passes either side of it');
});

test('resonance lifts the corner above the passband, and the curve shows it', () => {
  const peak = (res) => Math.max(...response({ 'resonance': res }).points.map((p) => p.db));
  assert.ok(Math.abs(peak(0)) < 0.2, 'no resonance, no peak above unity');
  assert.ok(peak(0.9) > 10, `a high resonance peaks well above it, got ${peak(0.9)}`);
  assert.ok(peak(0.9) > peak(0.5) && peak(0.5) > peak(0));
});

test('the corner is drawn where the filter put it, not where the knob was set', () => {
  // MultiFilter stops every mode at a QUARTER of the sample rate, so a cutoff asked for above
  // that is not where the filter is running - at 48 kHz the knob's top 8 kHz all tune to 11760.
  // The curve follows the filter there rather than the knob, which is the whole point of reading
  // the coefficients off a real one: a picture that drew 20 kHz would be drawing a filter that is
  // not in the track. (Whether the ceiling itself belongs that low is a question for the DSP, not
  // for this picture - it is pinned here so that moving it is a deliberate edit.)
  const ceiling = (sampleRate) => sampleRate * 0.5 * 0.49;
  const wide = response({ cutoff: 20000 });
  assert.ok(Math.abs(wide.corner - ceiling(48000)) < 100, `at 48k it stops at the ceiling, got ${wide.corner}`);
  assert.equal(wide.cutoff, 20000, 'while the parameter still says what it was asked for');

  // Under the ceiling the corner is exactly where it was asked for.
  const ordinary = response({ cutoff: 4000 });
  assert.ok(Math.abs(ordinary.corner - 4000) < 40, `an ordinary cutoff stands, got ${ordinary.corner}`);

  const narrow = buildFigures(FILTER, { ...defaultValues(FILTER), cutoff: 20000 }, { ...opts, sampleRate: 22050 })
    .find((f) => f.kind === 'response');
  assert.ok(narrow.corner < 11025, `at 22.05k it is pulled under Nyquist, got ${narrow.corner}`);
  assert.equal(narrow.cutoff, 20000, 'and still says what it was asked for');
});

test('the response curve stays inside the window it declares it is drawn in', () => {
  for (const mode of FILTER_MODES) {
    for (const res of [0, 0.5, 1]) {
      const f = response({ 'mode': FILTER_MODES.indexOf(mode), 'resonance': res });
      for (const p of f.points) {
        assert.ok(Number.isFinite(p.db), `${mode} at res ${res} is finite everywhere`);
        // Wound all the way up, a resonant peak goes past the top of the window on purpose - what
        // is checked is that it stays a number, and within a decibel range a picture can hold.
        assert.ok(p.db <= 40, `${mode} at res ${res} peaks at ${p.db} dB`);
      }
    }
  }
});

// --- the envelopes ---------------------------------------------------------------------------

test('the envelope is drawn through the curve the voice shapes it with', () => {
  const f = figureOf('adsr', { 'ampenv.attack': 1, 'ampenv.decay': 1, 'ampenv.sustain': 0.5, 'ampenv.release': 1 });
  const at = (t) => {
    const x = t / f.span;
    let best = f.points[0];
    for (const p of f.points) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return best.y;
  };
  // The point of this test is that the picture is the voice's envelope and not a straight line
  // drawn between the same points. Every stage is shaped by its own curve with the SAME sign
  // reading - negative moves fast and then levels off, rising or falling - so at the default
  // of -4 both the attack and the decay sit above the straight line at their midpoints.
  // Asserting the numbers the generator actually produces is what makes this catch the picture
  // drifting from the sound.
  assert.ok(Math.abs(at(0.5) - curveShape(0.5, -4)) < 0.02, `attack midpoint drew ${at(0.5)}`);
  assert.ok(at(0.5) > 0.8, 'the attack is off the straight line, not on it');
  assert.ok(Math.abs(at(1) - 1) < 0.02, 'the attack reaches the top');
  const decayMid = 1 + (0.5 - 1) * curveShape(0.5, -4);
  assert.ok(Math.abs(at(1.5) - decayMid) < 0.03, `decay midpoint drew ${at(1.5)}`);
  assert.ok(at(1.5) < 0.6, 'the decay falls most of the way early, then levels off');
  assert.ok(Math.abs(at(2) - 0.5) < 0.03, 'and lands on the sustain');
});

test('a straight curve draws a straight line', () => {
  const f = figureOf('adsr', { 'ampenv.attack': 1, 'env.acurve': 0 });
  const x = 0.5 * (1 / f.span);
  let best = f.points[0];
  for (const p of f.points) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  assert.ok(Math.abs(best.y - 0.5) < 0.02, `halfway up at halfway through, got ${best.y}`);
});

test('the handles sit at the ends of the stages they move', () => {
  const f = figureOf('adsr', {
    'ampenv.attack': 0.1, 'ampenv.decay': 0.2, 'ampenv.sustain': 0.4, 'ampenv.release': 0.3,
  });
  const h = (role) => f.handles.find((x) => x.role === role);
  assert.ok(Math.abs(h('attack').x - 0.1 / f.span) < 1e-9);
  assert.ok(Math.abs(h('decay').x - 0.3 / f.span) < 1e-9);
  assert.equal(h('attack').y, 1, 'the attack handle is at the top, where the attack ends');
  assert.equal(h('decay').y, 0.4, 'the decay handle is at the sustain level');
  assert.equal(h('release').y, 0);
  // The decay point moves two controls, as it does in the sampler's panel; the plateau moves one.
  assert.equal(h('decay').movesX, 'ampenv.decay');
  assert.equal(h('decay').movesY, 'ampenv.sustain');
  assert.equal(h('attack').movesY, null);
  assert.equal(f.plateau.movesY, 'ampenv.sustain');
  assert.equal(f.plateau.movesX, null);
  assert.ok(f.plateau.x1 > f.plateau.x0, 'and there is a plateau wide enough to grab');
});

test('the whole envelope fits the figure, whatever it is set to', () => {
  for (const over of [
    {},
    { 'ampenv.attack': 0, 'ampenv.decay': 0, 'ampenv.sustain': 0, 'ampenv.release': 0 },
    { 'ampenv.attack': 10, 'ampenv.decay': 10, 'ampenv.release': 10 },
    { 'ampenv.attack': 0.001, 'ampenv.release': 10 },
  ]) {
    const f = figureOf('adsr', over);
    assert.ok(f.span > 0, 'a span it can be drawn against');
    for (const p of f.points) {
      assert.ok(p.x >= 0 && p.x <= 1, `x ${p.x} is on the figure`);
      assert.ok(p.y >= -0.001 && p.y <= 1.001, `y ${p.y} is on the figure`);
    }
    for (const hd of [...f.handles, f.plateau]) {
      assert.ok(hd.x === undefined || (hd.x >= 0 && hd.x <= 1), `${hd.role} handle is on the figure`);
    }
  }
});

test('envscale moves the drawn envelope, because it moves the one that plays', () => {
  const plain = figureOf('adsr', { 'ampenv.attack': 0.1 });
  const scaled = figureOf('adsr', { 'ampenv.attack': 0.1, 'env.scale': 4 });
  assert.equal(plain.attack, 0.1);
  assert.equal(scaled.attack, 0.4, 'drawn in scaled seconds, the way the generator runs them');
  assert.equal(scaled.scale, 4, 'and the scale is reported, so a drag can write the time back');
});

test('each stage is drawn with a curve of its own, and says which control bends it', () => {
  // One curve for all three was the shortcut here, and it is wrong in a way you can hear: the
  // shape an attack wants and the shape a release wants are opposite ends of the same control.
  const [env] = figures({ 'ampenv.attack': 0.25, 'env.acurve': 0, 'env.dcurve': -8, 'env.rcurve': 2 })
    .filter((f) => f.kind === 'adsr');
  assert.equal(env.id, 'ampenv');
  assert.equal(env.attack, 0.25);
  assert.equal(env.acurve, 0);
  assert.equal(env.dcurve, -8);
  assert.equal(env.rcurve, 2);

  // A curve has no handle to drag, so the panel puts it on the wheel over the stage - which
  // needs to know where each stage runs and where its control currently sits.
  assert.deepEqual(env.stages.map((s) => s.moves), ['env.acurve', 'env.dcurve', 'env.rcurve']);
  assert.ok(env.stages[0].x1 > env.stages[0].x0);
  assert.ok(env.stages[1].x0 >= env.stages[0].x1, 'the stages run in order and do not overlap');
  assert.ok(env.stages[2].x0 >= env.stages[1].x1);
  for (const s of env.stages) assert.ok(s.position >= 0 && s.position <= 1);

  // The steepest stage really is the steeply drawn one.
  const yAt = (x) => env.points.reduce((b, p) => (Math.abs(p.x - x) < Math.abs(b.x - x) ? p : b)).y;
  const decayMid = (env.stages[1].x0 + env.stages[1].x1) / 2;
  assert.ok(yAt(decayMid) < 0.5 + env.sustain / 2, 'a hard decay curve is most of the way down by its midpoint');
});

// --- the equalizer ---------------------------------------------------------------------------

test('the equalizer curve is flat at unity gain and lifts where a band boosts', () => {
  const flat = buildFigures(EQ, defaultValues(EQ), opts).find((f) => f.kind === 'eq');
  assert.equal(flat.bands.length, 4);
  for (const p of flat.points) assert.ok(Math.abs(p.db) < 0.2, `flat at ${p.hz} Hz, got ${p.db}`);
  const boosted = buildFigures(EQ, { ...defaultValues(EQ), 'band2.gain': 12 }, opts).find((f) => f.kind === 'eq');
  const nearest = (f, hz) => f.points.reduce((b, p) => (Math.abs(Math.log(p.hz / hz)) < Math.abs(Math.log(b.hz / hz)) ? p : b));
  assert.ok(nearest(boosted, 500).db > 10, 'twelve decibels at the band\'s frequency');
  assert.ok(Math.abs(nearest(boosted, 30).db) < 1, 'and nothing two octaves away from a peak');
  // A band's handle moves its frequency sideways and its gain up, unless it has no gain.
  assert.equal(boosted.bands[1].movesX, 'band2.freq');
  assert.equal(boosted.bands[1].movesY, 'band2.gain');
  const cut = buildFigures(EQ, { ...defaultValues(EQ), 'band1.type': 4 }, opts).find((f) => f.kind === 'eq');
  assert.equal(cut.bands[0].movesY, null, 'a highpass has no gain to drag');
});

// --- the granulator's sample, and the cloud coming out of it -----------------------------------

const granular = (over = {}, more = {}) =>
  buildFigures(GRANULAR, { ...defaultValues(GRANULAR), ...over }, { ...opts, ...more });

test('a sample figure says what a granulator is reading and where from', () => {
  // Nothing loaded: the picture is empty rather than absent, so the window still has the box
  // that says a file goes here.
  const bare = granular().find((f) => f.kind === 'sample');
  assert.deepEqual(bare.peaks, []);
  assert.equal(bare.name, null);
  assert.deepEqual(bare.grains, []);

  // The outline the engine kept when the file was loaded, which is what the synth has.
  const waves = { 0: { name: 'files:voice.wav', peaks: [[-1, 1], [-0.5, 0.5]], seconds: 2.5 } };
  const drawn = granular({ position: 0.4, spray: 0.1 }, { waves }).find((f) => f.kind === 'sample');
  assert.equal(drawn.name, 'files:voice.wav');
  assert.equal(drawn.seconds, 2.5);
  assert.equal(drawn.position, 0.4);
  assert.equal(drawn.spray, 0.1);
  // A drag across it moves the position, and up and down the spray.
  assert.deepEqual(drawn.drag, { x: 'position', y: 'spray' });
});

test('the grains are the processor\'s own report, because nothing else knows where they are', () => {
  // A grain starts at a random draw inside the spray, so there is nothing to compute from the
  // settings: what is drawn is what the synth says it is playing, or nothing.
  const report = { grains: [[0.25, 1], [0.6, 0.3]] };
  const live = granular({}, { waves: { 0: { peaks: [[-1, 1]], seconds: 1 } }, report }).find((f) => f.kind === 'sample');
  assert.deepEqual(live.grains, [[0.25, 1], [0.6, 0.3]]);
});

test('the grain window is drawn from the shape the synth applies, not a second copy of it', () => {
  const window = (mode) => granular({ window: mode }).find((f) => f.kind === 'grain');
  for (const mode of [0, 1, 2]) {
    const f = window(mode);
    assert.equal(f.shape, mode);
    for (const pt of f.points) {
      assert.ok(Math.abs(pt.y - grainWindow(mode, pt.x)) < 1e-12, `${mode} at ${pt.x}`);
    }
    assert.ok(Math.abs(f.points[0].y) < 1e-6, 'every window starts at silence');
  }
  // A grain's own length, which is what the picture is of.
  assert.equal(window(0).size, GRANULAR.params.find((p) => p.id === 'size').default);
});

// --- a compressor's transfer curve -------------------------------------------------------------

test('a transfer curve bends where the threshold is and at the ratio it was given', () => {
  const curve = (over = {}) =>
    buildFigures(COMPRESSOR, { ...defaultValues(COMPRESSOR), ...over }, opts).find((f) => f.kind === 'transfer');
  const outAt = (f, inDb) => f.points.reduce((b, p) => (Math.abs(p.inDb - inDb) < Math.abs(b.inDb - inDb) ? p : b)).outDb;

  // Well below the threshold and outside the knee, nothing happens: out equals in.
  const f = curve({ threshold: -20, ratio: 4, knee: 0, makeup: 0 });
  assert.ok(Math.abs(outAt(f, -40) - -40) < 0.5, `below the threshold it is unchanged, drew ${outAt(f, -40)}`);
  // Twenty decibels over at four to one comes out five over: -20 + 5.
  assert.ok(Math.abs(outAt(f, 0) - -15) < 0.5, `four to one over the threshold, drew ${outAt(f, 0)}`);

  // The knee is the whole reason the curve is worth drawing: it rounds the corner, so a signal
  // a little under the threshold is already being touched.
  const soft = curve({ threshold: -20, ratio: 4, knee: 20, makeup: 0 });
  assert.ok(outAt(soft, -25) < -25 + 0.01 && outAt(soft, -25) > -26, 'inside the knee, a little under, a little compressed');
  assert.ok(Math.abs(outAt(soft, -40) - -40) < 0.5, 'and outside it, nothing');

  // Makeup lifts the whole curve.
  const lifted = curve({ threshold: -20, ratio: 4, knee: 0, makeup: 6 });
  assert.ok(Math.abs(outAt(lifted, -40) - -34) < 0.5);
});

test('the transfer curve says where the signal is on it, and nothing when nobody is reporting', () => {
  const still = buildFigures(COMPRESSOR, defaultValues(COMPRESSOR), opts).find((f) => f.kind === 'transfer');
  assert.equal(still.inDb, null, 'a stopped effect draws its settings and no dot');
  assert.equal(still.grDb, 0);

  const live = buildFigures(COMPRESSOR, defaultValues(COMPRESSOR), {
    ...opts, report: { meters: { curve: { inDb: -6, grDb: -4.5 } } },
  }).find((f) => f.kind === 'transfer');
  assert.equal(live.inDb, -6);
  assert.equal(live.grDb, -4.5);
});

test('an upward band lifts what is below the threshold, which a downward one leaves alone', () => {
  const band = (over) => buildFigures(MULTIBAND, { ...defaultValues(MULTIBAND), ...over }, opts)
    .find((f) => f.id === 'low.curve');
  const outAt = (f, inDb) => f.points.reduce((b, p) => (Math.abs(p.inDb - inDb) < Math.abs(b.inDb - inDb) ? p : b)).outDb;

  const down = band({ 'low.threshold': -20, 'low.ratio': 4, 'low.upward': 0, 'low.gain': 0 });
  assert.ok(Math.abs(outAt(down, -40) - -40) < 0.5, 'with no upward it is an ordinary compressor');

  const up = band({ 'low.threshold': -20, 'low.ratio': 4, 'low.upward': 1, 'low.gain': 0 });
  assert.ok(outAt(up, -40) > -40 + 2, `a quiet signal is lifted toward the threshold, drew ${outAt(up, -40)}`);
  assert.ok(outAt(up, -40) < -20, 'but never up to it');
});

// --- the pictures of the effects: a shaper's curve, echoes, repeats, a tail, a sweep, a dip ----


const only = (device, kind, over = {}, o = {}) => buildFigures(device, { ...defaultValues(device), ...over }, { sampleRate: 48000, ...o }).find((f) => f.kind === kind);

test('a figure carries the position of every parameter it drags, so a drag starts where the knob is', () => {
  const f = only(DELAY, 'echoes', { feedback: 0.55 });
  assert.deepEqual(Object.keys(f.positions), ['feedback']);
  assert.ok(Math.abs(f.positions.feedback - 0.55 / 1.1) < 1e-9, 'on the parameter\'s own 0..1 curve');
  assert.equal(only(WAVETABLE, 'adsr').positions, null, 'a figure with no drag has none');
});

test('the shaper figure is the device\'s own curve with the auto gain on it', () => {
  const f = only(DISTORT, 'shaper', { mode: 1, drive: 12, autogain: 1 });
  assert.equal(f.modeName, 'hard');
  const drive = Math.pow(10, 12 / 20);
  const comp = autoGainFor(1, drive, 0, 2);
  assert.ok(Math.abs(f.comp - comp) < 1e-12, 'stopped, the correction is what the processor would compute');
  const mid = f.points[Math.floor(f.points.length / 2)];
  assert.equal(mid.x, 0);
  assert.equal(f.points[0].x, -1);
  assert.equal(f.points[f.points.length - 1].x, 1);
  assert.ok(Math.abs(f.points[f.points.length - 1].y - shape(1, 1, drive, 0, 2) * comp) < 1e-12);
  // Running, the correction is the one being applied - the ramped value the device reports.
  const live = only(DISTORT, 'shaper', { mode: 1, drive: 12, autogain: 1 }, { report: { meters: { autogain: -6 } } });
  assert.ok(Math.abs(live.compDb + 6) < 1e-9);
  assert.equal(only(DISTORT, 'shaper', { autogain: 0 }).comp, 1, 'off, nothing is corrected');
  assert.equal(subsumedParams(DISTORT).size, 0, 'the curve joins the knobs rather than replacing any');
});

test('the echoes figure walks the delay\'s own feedback path', () => {
  const plain = only(DELAY, 'echoes', { time: 0.25, feedback: 0.5, sync: 0 });
  assert.equal(plain.synced, false);
  assert.ok(Math.abs(plain.taps[0].t - 0.25) < 1e-12);
  assert.equal(plain.taps[0].level, 1);
  assert.equal(plain.taps[0].side, 0, 'no spread: both sides at once');
  assert.ok(Math.abs(plain.taps[1].level - 0.5) < 1e-12);
  assert.ok(plain.taps.every((t) => t.level >= 0.02));
  // Synced, the time is the beat's at the tempo handed in.
  const synced = only(DELAY, 'echoes', { sync: SYNC_OPTIONS.indexOf('1/8'), feedback: 0.5 }, { bpm: 60 });
  assert.equal(synced.synced, true);
  assert.equal(synced.syncName, '1/8');
  assert.ok(Math.abs(synced.time - 0.5) < 1e-12, 'an eighth at sixty is half a second');
  // A ping-pong alternates sides, each repeat after the far side's own time.
  const pp = only(DELAY, 'echoes', { time: 0.25, feedback: 0.5, sync: 0, pingpong: 1, spread: 1 });
  assert.deepEqual(pp.taps.slice(0, 3).map((t) => t.side), [-1, 1, -1]);
  assert.ok(Math.abs(pp.taps[1].t - (0.25 + 0.375)) < 1e-12, 'the second lands after the right side\'s longer time');
  assert.ok(pp.span >= pp.taps[pp.taps.length - 1].t);
});

test('the repeats figure stretches a repeat that has dropped in pitch', () => {
  const f = only(STUTTER, 'repeats', { grid: SYNC_OPTIONS.indexOf('1/16'), repeats: 4, decay: 0.5, pitch: -12 }, { bpm: 120 });
  assert.equal(f.taps.length, 4);
  assert.ok(Math.abs(f.taps[0].length - 0.125) < 1e-12, 'a sixteenth at 120');
  assert.ok(Math.abs(f.taps[1].length - 0.25) < 1e-12, 'an octave down plays it twice as long');
  assert.deepEqual(f.taps.map((t) => t.level), [1, 0.5, 0.25, 0.125]);
  assert.ok(Math.abs(f.taps[1].t - f.taps[0].length) < 1e-12, 'each starts when the last ends');
  assert.ok(f.span >= f.end && f.span >= f.interval);
});

test('the tail figure is silence for the predelay, then sixty decibels down over the decay', () => {
  const f = only(REVERB, 'decay', { decay: 2, predelay: 0.1 });
  assert.equal(f.points[0].db, 0);
  const at = (t) => f.points.reduce((b, p) => (Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b));
  assert.equal(at(0.05).db, 0, 'still nothing inside the predelay');
  assert.ok(Math.abs(at(1.1).db + 30) < 1.5, 'halfway down halfway through');
  assert.ok(f.span > 2.1);
});

test('the sweep figure reads the LFO the delay line reads, per voice and side', () => {
  const f = only(CHORUS, 'sweep', { rate: 2, sync: 0, delay: 10, depth: 4, voices: 2, spread: 0.5, shape: 0 });
  assert.equal(f.rateHz, 2);
  assert.equal(f.periodSec, 0.5);
  assert.deepEqual(f.traces.map((t) => t.label), ['L1', 'R1', 'L2', 'R2']);
  assert.equal(f.axis.unit, 'ms');
  assert.equal(f.axis.log, false);
  const l1 = f.traces[0].points;
  assert.ok(Math.abs(l1[0].y - 12) < 1e-9, 'a sine LFO starts at its middle: base plus half the depth');
  assert.ok(l1.every((p) => p.y >= 10 - 1e-9 && p.y <= 14 + 1e-9), 'and sweeps the depth either side');
  assert.equal(f.phase, null, 'stopped, there is no playhead');
  assert.equal(only(CHORUS, 'sweep', {}, { report: { phase: 0.25 } }).phase, 0.25);
  // A phaser sweeps octaves round its center, on a log axis.
  const ph = only(PHASER, 'sweep', { center: 1000, depth: 1, sync: 0, rate: 1 });
  assert.equal(ph.axis.log, true);
  assert.equal(ph.axis.unit, 'Hz');
  const ys = ph.traces[0].points.map((p) => p.y);
  assert.ok(Math.abs(Math.max(...ys) / 8000 - 1) < 0.03, `three octaves up at full depth, got ${Math.max(...ys)}`);
  assert.ok(Math.abs(Math.min(...ys) / 125 - 1) < 0.03, `and three down, got ${Math.min(...ys)}`);
});

test('the dip figure is the ducker\'s own recursion over one beat', () => {
  const f = only(DUCKER, 'duck', { amount: 0.8, length: 0.5, attack: 2, curve: 3, sync: SYNC_OPTIONS.indexOf('1/4') }, { bpm: 120 });
  assert.equal(f.period, 0.5);
  assert.equal(f.recovery, 0.25);
  assert.equal(f.points[0].y, 1, 'starts at unity, before the attack');
  const lowest = Math.min(...f.points.map((p) => p.y));
  assert.ok(Math.abs(lowest - 0.2) < 0.02, `dips to one minus the amount, got ${lowest}`);
  assert.ok(f.points[f.points.length - 1].y > 0.99, 'and is back by the end of the beat');
  assert.equal(f.history, null);
  const live = only(DUCKER, 'duck', {}, { report: { keyed: true, history: { gain: [1, 0.5], out: [0.1, 0.2], key: [0, 0.3], blockSec: 0.01 } } });
  assert.equal(live.keyed, true);
  assert.deepEqual(live.history.gain, [1, 0.5]);
  assert.deepEqual(live.history.key, [0, 0.3]);
});

test('the transfer figure carries the compressor\'s history when it reports one', () => {
  const still = only(COMPRESSOR, 'transfer');
  assert.equal(still.history, null);
  const live = only(COMPRESSOR, 'transfer', {}, { report: { meters: { curve: { inDb: -12, grDb: -3, history: { inDb: [-20, -12], grDb: [0, -3], blockSec: 0.002 } } } } });
  assert.deepEqual(live.history.inDb, [-20, -12]);
  assert.deepEqual(live.history.grDb, [0, -3]);
  assert.equal(live.inDb, -12);
});

test('the wavetable\'s unison controls sit under the picture of the spread', () => {
  const panel = buildPanel(WAVETABLE, defaults, new Map(), opts);
  const section = (title) => panel.sections.find((s) => s.title === title);
  assert.deepEqual(section('Osc 1 Unison').figures.map((f) => f.kind), ['unison']);
  assert.deepEqual(section('Osc 1 Unison').widgets.map((w) => w.id), ['osc1.unison', 'osc1.detune', 'osc1.spread', 'osc1.phaserand']);
  assert.ok(!section('Osc 1').figures.some((f) => f.kind === 'unison'));
  assert.deepEqual(panel.rows.map((row) => row.map((i) => panel.sections[i].title)),
    [['Osc 1', 'Osc 2'], ['Osc 1 Unison', 'Osc 2 Unison'], ['Sub', 'Amp Env', 'Voice']]);
});
