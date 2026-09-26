// The pictures a device window draws, as data.
//
// panel.mjs turns a descriptor into knobs. That is the right answer for a ported module, whose
// controls are a list and nothing more, and the wrong one for a synth we wrote: a wavetable's
// position knob says "0.42" where the thing somebody wants to see is which waveform that is,
// and four envelope knobs say four numbers where one curve says all of it.
//
// So a descriptor may also declare FIGURES - named pictures, each bound to a few of the
// device's own parameters. This module computes what they show and none of the drawing, the
// same split panel.mjs makes, so every figure is asserted on without a DOM. The client keeps a
// renderer per `kind` and skips a kind it does not know, which is what lets a device ship a
// figure without the editor being taught about that device.
//
// EVERY NUMBER HERE COMES OUT OF THE DSP THAT PLAYS IT. The response curve is drawn from
// coefficients read off a real filter, the spread from the function the oscillator spreads with,
// the waveform through the real warp, the envelope through the real curve, the equalizer from
// the coefficients its bands filter with. A picture computed from a second copy of the maths is
// a picture that goes quietly stale the first time somebody tunes the original, and a wrong
// picture is worse than a knob - the knob at least does not lie about what you are hearing.

import { normalize } from './descriptor.mjs';
import { curveShape } from './dsp/adsr.mjs';
import { gainComputer } from './devices/compressor.mjs';
import { drawnWindow, grainWindow } from './devices/granular.mjs';
import { BIQUAD_TYPES, biquadCoefficients, biquadMagnitude } from './dsp/biquad.mjs';
import { FILTER_MODES, MultiFilter } from './dsp/filters.mjs';
import { fillUnison } from './dsp/oscillator.mjs';
import { WARP_MODES, crossModOf, warpPhase } from './dsp/warp.mjs';
import { SHAPER_MODES, autoGainFor, harmonicsOf, shape } from './dsp/shapers.mjs';
import { dbToGain } from './dsp/control.mjs';
import { SYNC_OPTIONS, isFree, syncedHz, syncedSeconds } from './dsp/sync.mjs';
import { lfoValue } from './dsp/moddelay.mjs';

/** Points across one cycle of a drawn waveform. Half a frame is past what a panel can show. */
const WAVE_POINTS = 256;

/** Points across a frame in the stack behind it, which is drawn small. */
const STACK_POINTS = 96;

/** Points across the response curve, log-spaced over the audible band. */
const RESPONSE_POINTS = 160;

/**
 * The band a response curve is drawn over, and the decibel window it is drawn in.
 *
 * The window is fixed rather than fitted to the curve, so that two settings can be compared by
 * eye. It reaches high enough for the resonant peak of an ordinary setting; wound all the way up,
 * a filter peaks past thirty decibels and the curve runs off the top of the box, which is a truer
 * thing for it to do than to be flattened against the ceiling.
 */
export const RESPONSE_RANGE = Object.freeze({ lowHz: 20, highHz: 20000, topDb: 24, bottomDb: -48 });

/** The window an equalizer curve is drawn in: symmetric, since a band cuts as far as it boosts. */
export const EQ_RANGE = Object.freeze({ lowHz: 20, highHz: 20000, topDb: 24, bottomDb: -24 });

/** The widest a unison figure lays its axis out to, in cents either side. */
export const UNISON_AXIS_CENTS = 100;

/** The sample rate a response curve is computed at when nobody says otherwise. */
const NOMINAL_RATE = 48000;

/** The tempo a picture on the beat grid is drawn at when no engine says otherwise. */
const NOMINAL_BPM = 120;

/** Points along an envelope. */
const ENV_POINTS = 192;

/**
 * How much of an envelope figure the sustain plateau takes, as a fraction of the moving stages.
 *
 * A synth envelope has no note length to draw against - the sampler's does, which is why its
 * panel can lay the sustain out over the real audio - so the plateau is given a share of the
 * width instead. It has to be wide enough to grab the sustain level on and narrow enough that
 * the attack does not vanish when the release is long.
 */
const ENV_HOLD_SHARE = 0.25;

/** The shortest envelope the figure will draw across its full width: 50 ms, all stages at zero. */
const ENV_MIN_SPAN_SEC = 0.05;

/** The value of a figure's role, falling back to the parameter's default. */
function roleValue(descriptor, figure, values, role) {
  const paramId = figure.params[role];
  if (!paramId) return null;
  const v = values?.[paramId];
  if (v !== undefined && Number.isFinite(Number(v))) return Number(v);
  return descriptor.params.find((p) => p.id === paramId)?.default ?? null;
}

/**
 * Every figure a device draws, computed against the values it is currently set to.
 *
 * `tables` is the wavetable list a `wavetable` figure reads its frames out of - the synth's own,
 * so the panel draws the table that is loaded rather than a fresh copy of the shipped one.
 */
export function buildFigures(descriptor, values = {}, opts = {}) {
  return (descriptor.figures ?? []).map((f) => figureData(descriptor, f, values, opts));
}

/**
 * The figures one parameter appears in - what to recompute when a single knob moves.
 *
 * A drag sends a parameter per frame and the answer carries the pictures back, so answering with
 * all of them would redraw the wavetable stack to move the filter cutoff. Every figure names its
 * parameters, so which ones care is already known.
 */
export function figuresFor(descriptor, paramId, values = {}, opts = {}) {
  const touched = (descriptor.figures ?? []).filter((f) => Object.values(f.params).includes(paramId));
  return touched.map((f) => figureData(descriptor, f, values, opts));
}

/** What is driving a figure's parameters, by parameter id - the same map buildPanel is given. */
function drivenParams(figure, modulated) {
  const get = (id) => (modulated instanceof Map ? modulated.get(id) : modulated?.[id]) ?? null;
  const out = {};
  for (const paramId of Object.values(figure.params)) {
    const by = get(paramId);
    if (by) out[paramId] = by;
  }
  return out;
}

/** Parameter ids no knob is drawn for, because a figure has taken them over. */
export function subsumedParams(descriptor) {
  const out = new Set();
  for (const f of descriptor.figures ?? []) {
    for (const role of f.subsumes) out.add(f.params[role]);
  }
  return out;
}

function figureData(descriptor, figure, values, opts) {
  const { sampleRate = NOMINAL_RATE, tables = null, modulated = new Map(), extras = null, waves = null, shapes = null, report = null } = opts;
  // The tempo the device is running at, for a picture on the beat grid. A panel built with no
  // engine behind it draws at the engine's own default.
  const bpm = Number.isFinite(opts.bpm) && opts.bpm > 0 ? opts.bpm : NOMINAL_BPM;
  const read = (role) => roleValue(descriptor, figure, values, role);
  const common = {
    id: figure.id,
    kind: figure.kind,
    group: figure.group,
    title: figure.title,
    description: figure.description,
    // Which of the figure's parameters something else is already moving, and what. An axis whose
    // parameter is driven does not drag - the value would be overwritten on the next block, the
    // same reason a driven knob does not turn - and the picture says what is moving it instead.
    driven: drivenParams(figure, modulated),
    // The drag map is passed through as parameter IDS rather than roles: the client sends a
    // parameter to the same route a knob does, and has no business knowing what a role is.
    drag: figure.drag
      ? Object.fromEntries(Object.entries(figure.drag).map(([axis, role]) => [axis, figure.params[role]]))
      : null,
    // Where each dragged parameter sits on its own 0..1 curve, by parameter id, so a drag on the
    // picture starts from where the knob is rather than from zero. The figures that predate this
    // carry their own values and the client reads those; everything since reads this.
    positions: figure.drag
      ? Object.fromEntries(Object.values(figure.drag).map((role) => {
        const param = descriptor.params.find((p) => p.id === figure.params[role]);
        return [figure.params[role], param ? normalize(param, read(role) ?? param.default) : 0];
      }))
      : null,
  };
  switch (figure.kind) {
    case 'wavetable': return { ...common, ...wavetableFigure(descriptor, figure, read, { tables, extras }) };
    case 'unison': return { ...common, ...unisonFigure(read) };
    case 'response': return { ...common, ...responseFigure(read, sampleRate) };
    case 'adsr': return { ...common, ...adsrFigure(figure, read, descriptor) };
    case 'eq': return { ...common, ...eqFigure(figure, read, sampleRate, descriptor, report) };
    case 'band': return { ...common, ...bandFigure(figure, read) };
    case 'matrix': return { ...common, ...matrixFigure(figure, read) };
    case 'sample': return { ...common, ...sampleFigure(figure, read, { waves, extras, report, shapes }) };
    case 'grain': return { ...common, ...grainFigure(descriptor, figure, read, { shapes, extras }) };
    case 'meter': return { ...common, ...meterFigure(figure, read, report) };
    case 'transfer': return { ...common, ...transferFigure(figure, read, report) };
    case 'shaper': return { ...common, ...shaperFigure(descriptor, figure, read, { report, shapes, extras }) };
    case 'echoes': return { ...common, ...echoesFigure(read, bpm) };
    case 'repeats': return { ...common, ...repeatsFigure(read, bpm) };
    case 'decay': return { ...common, ...decayFigure(read) };
    case 'sweep': return { ...common, ...sweepFigure(figure, read, descriptor, bpm, report) };
    case 'duck': return { ...common, ...duckFigure(read, bpm, report) };
    default: return common;
  }
}

// --- the wavetable ---------------------------------------------------------------------------

/**
 * One cycle as the oscillator will read it, over the stack it was read from.
 *
 * `wave` is the frame pair at the current position, blended the way the oscillator blends them,
 * and then read through the real warp - so a sync or a fold shows up as the shape it makes
 * rather than as a number on a knob. It is sampled off the BRIGHTEST mip level, because this is
 * a picture of the waveform and not of what a particular note does to it; the band limiting is
 * per-note and would draw a different curve for every pitch. A cross-modulation mode bends the
 * cycle with another source the picture cannot see, so it draws the cycle unbent and says so.
 *
 * `stack` is every frame small, for the position to be seen moving through.
 */
function wavetableFigure(descriptor, figure, read, { tables, extras }) {
  const index = Math.round(read('table') ?? 0);
  const table = tables?.[index] ?? null;
  const position = Math.min(1, Math.max(0, read('position') ?? 0));
  const warp = Math.min(1, Math.max(0, read('warp') ?? 0));
  const warpMode = Math.round(read('warpmode') ?? 0);
  const cross = crossModOf(warpMode);
  const loadedName = extras?.[figure.params.table]?.[index] ?? null;

  if (!table) {
    return { table: loadedName ?? (tables?.length ? 'empty' : null), frameCount: 0, position, stack: [], wave: [], frame: 0, warp, warpMode,
      warpModeName: WARP_MODES[warpMode] ?? WARP_MODES[0], cross: !!cross, frameNames: null, between: [0, 0], mix: 0, loading: !!loadedName };
  }

  // Where the position lands in the stack, and the two frames on either side of it - the same
  // reading the oscillator makes, so the drawn shape is the one that sounds.
  const span = table.frameCount - 1;
  const at = position * span;
  const lo = Math.floor(at);
  const hi = Math.min(span, lo + 1);
  const mix = at - lo;

  const frames = table.mips.map((m) => m[0]);
  const blend = (t) => {
    const x = t * frames[0].length;
    const a = sampleFrame(frames[lo], x);
    const b = sampleFrame(frames[hi], x);
    return a + (b - a) * mix;
  };

  const wave = new Array(WAVE_POINTS);
  for (let i = 0; i < WAVE_POINTS; i++) {
    const phase = i / WAVE_POINTS;
    wave[i] = blend(warp > 0 && !cross ? warpPhase(phase, warp, warpMode) : phase);
  }

  return {
    table: table.name,
    frameCount: table.frameCount,
    // What the frames are called, where the table knows - the readout says "saw → square".
    frameNames: table.names ? [...table.names] : null,
    position,
    // The fractional frame, for a readout that says "saw → square" rather than "0.42".
    frame: at,
    between: [lo, hi],
    mix,
    warp,
    warpMode,
    warpModeName: WARP_MODES[warpMode] ?? WARP_MODES[0],
    cross: !!cross,
    loading: false,
    wave,
    stack: frames.map((f) => resample(f, STACK_POINTS)),
  };
}

/** A frame read at a fractional sample, wrapping - linear, which is what the oscillator uses. */
function sampleFrame(frame, x) {
  const n = frame.length;
  const i = Math.floor(x);
  const f = x - i;
  const a = frame[((i % n) + n) % n];
  const b = frame[((i + 1) % n + n) % n];
  return a + (b - a) * f;
}

/** A frame at a lower point count, by reading it at even fractional positions. */
function resample(frame, points) {
  const out = new Array(points);
  const step = frame.length / points;
  for (let i = 0; i < points; i++) out[i] = sampleFrame(frame, i * step);
  return out;
}

// --- the unison spread ----------------------------------------------------------------------

/**
 * Where the unison copies sit: how far each is detuned, and how far it is panned.
 *
 * Computed with the oscillator's own spread function rather than a copy of it, so the picture
 * cannot disagree with the sound about where the copies are or how loud each one is. The axis
 * is FIXED at the detune control's full range: laid out against the detune itself, the outer
 * copies sat at the edges of the box at every setting and the knob appeared to do nothing.
 * The axis is square-rooted so a few cents is still a visible spread.
 */
function unisonFigure(read) {
  const count = Math.max(1, Math.round(read('count') ?? 1));
  const detune = read('detune') ?? 0;
  const spread = read('spread') ?? 0;

  const ratios = new Float64Array(count);
  const gainsL = new Float64Array(count);
  const gainsR = new Float64Array(count);
  fillUnison(count, detune, spread, ratios, gainsL, gainsR);

  const copies = [];
  for (let i = 0; i < count; i++) {
    const gL = gainsL[i];
    const gR = gainsR[i];
    // Back out of the ratio rather than recomputing the offset: cents are what the picture is
    // laid out on, and this way they are the cents the oscillator is actually playing.
    const cents = 1200 * Math.log2(ratios[i]);
    copies.push({
      cents,
      // Where the copy sits across the box, -1..1, on the square-rooted axis.
      x: Math.sign(cents) * Math.sqrt(Math.min(1, Math.abs(cents) / UNISON_AXIS_CENTS)),
      // -1..1, from the pair of gains, which is where the panning really lives.
      pan: gL + gR > 0 ? (gR - gL) / (gR + gL) : 0,
      gainL: gL,
      gainR: gR,
    });
  }
  return { count, detune, spread, copies, maxCents: count > 1 ? detune : 0, axisCents: UNISON_AXIS_CENTS };
}

// --- the filter response --------------------------------------------------------------------

/**
 * The filter's magnitude response, in decibels, over the audible band.
 *
 * The coefficients are READ OFF A REAL FILTER that has been told the cutoff and resonance the
 * panel is showing: `g` carries the prewarping and the cutoff clamps, `k` carries the resonance
 * mapping. So the corner is drawn where the filter actually put it, including the clamp that
 * stops it short of Nyquist, and a change to either mapping moves this curve with it.
 *
 * The magnitudes themselves are the analog prototypes the two topologies implement, evaluated at
 * the prewarped frequency. That is exact for the clean modes and the small-signal answer for the
 * ladder, whose feedback path is saturated: at the top of the resonance the real thing is a few
 * decibels below this peak, because the saturation is what keeps it bounded. Drive is left out
 * of the curve entirely for the same reason - it is a nonlinearity, and a magnitude response is
 * not where it can be honestly drawn.
 */
function responseFigure(read, sampleRate) {
  const mode = Math.round(read('mode') ?? 0);
  const cutoff = read('cutoff') ?? 1000;
  const resonance = Math.min(1, Math.max(0, read('resonance') ?? 0));
  const modeName = FILTER_MODES[mode] ?? FILTER_MODES[0];

  // ONE REAL FILTER, TUNED. Every coefficient below is read off it rather than recomputed here:
  // the prewarp, the resonance mapping, the cutoff clamps, the comb's delay length, the vowel
  // the formant bank blended to. A mode this does not know how to evaluate would draw the wrong
  // picture, which is why `transfer` covers all of them and the test walks the whole list.
  const filter = new MultiFilter(sampleRate);
  filter.setCutoff(cutoff, resonance, mode);

  const { lowHz, highHz } = RESPONSE_RANGE;
  const top = Math.min(highHz, sampleRate * 0.5);
  const points = new Array(RESPONSE_POINTS);
  for (let i = 0; i < RESPONSE_POINTS; i++) {
    const hz = lowHz * Math.pow(top / lowHz, i / (RESPONSE_POINTS - 1));
    points[i] = { hz, db: toDb(cAbs(transfer(filter, modeName, hz, sampleRate)), RESPONSE_RANGE) };
  }

  // Where the corner is, for the line the panel draws through it: the frequency the filter took,
  // not the one it was asked for. For the modes whose cutoff is not a corner at all - the comb's
  // pitch, the vowel the formant bank is on - it is still where the control is pointing, which is
  // what the line is for.
  return {
    mode, modeName, cutoff, resonance, sampleRate, points, range: RESPONSE_RANGE,
    corner: cornerOf(filter, modeName, cutoff, sampleRate),
  };
}

// Complex arithmetic, because half of these responses are a filtered copy summed back with the
// signal - a peak, a comb, an allpass pair, a formant bank - and summing MAGNITUDES there gives
// an answer that is wrong wherever it matters, which is at the notches.
const cAdd = (a, b) => ({ re: a.re + b.re, im: a.im + b.im });
const cMul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cScale = (a, s) => ({ re: a.re * s, im: a.im * s });
const cDiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const cAbs = (a) => Math.hypot(a.re, a.im);
const ONE = { re: 1, im: 0 };

/**
 * The state-variable filter's four outputs as their analog prototypes at `jw`, complex.
 *
 * These are the prototypes the implementation's outputs reduce to: its `v1` is the bandpass and
 * its `v2` the lowpass, and the other two are formed from them the way the code forms them -
 * highpass as `in - k·v1 - v2`, notch as `in - k·v1` - which is why a single denominator serves
 * all four. `w` is measured in cutoffs, so w = 1 is the corner whatever the sample rate is doing.
 */
function svfResponse(w, k, which) {
  const den = { re: 1 - w * w, im: k * w };
  switch (which) {
    case 'highpass': return cDiv({ re: -w * w, im: 0 }, den);
    case 'bandpass': return cDiv({ re: 0, im: w }, den);
    case 'notch': return cDiv({ re: 1 - w * w, im: 0 }, den);
    default: return cDiv(ONE, den);
  }
}

/**
 * The ladder: four one-poles inside a feedback loop, so `1 / ((1 + jw)^4 + k)`.
 *
 * At the corner with no resonance that is 1/4 - twelve decibels down, where the clean lowpass is
 * six. That is the difference the descriptor claims and the comment in filters.mjs explains, and
 * it falls out of this expression rather than being applied to it.
 */
function ladderResponse(w, k) {
  const re = 1 - 6 * w * w + w * w * w * w;
  const im = 4 * w - 4 * w * w * w;
  return cDiv(ONE, { re: re + k, im });
}

/** `z^-n` on the unit circle at this frequency - for the structures evaluated as digital ones. */
const zPow = (omega, n) => ({ re: Math.cos(omega * n), im: -Math.sin(omega * n) });

/**
 * What the filter does to this frequency, as a complex gain.
 *
 * The classical shapes and the ladder are evaluated as their analog prototypes, which is exact
 * for the bilinear form they are written in. The comb, the allpass chain and the one-pole slopes
 * are evaluated as the DIGITAL structures they are - a delay line has no analog prototype worth
 * pretending about, and its teeth land on the sample rate.
 */
function transfer(filter, modeName, hz, sampleRate) {
  const omega = (2 * Math.PI * hz) / sampleRate;
  const t = Math.tan((Math.PI * hz) / sampleRate);
  const svf = filter.svf[0];
  const w = t / svf.g;
  const k = svf.k;
  // The second section of a cascade takes no resonance, so it runs at the undamped k - read off
  // the section itself rather than assumed.
  const k2 = filter.svf[1].k;
  const w2 = t / filter.svf[1].g;

  switch (modeName) {
    case 'lowpass 6': {
      // y += a(x - y): one pole at (1 - a), digital.
      const a = filter.oneA;
      return cDiv({ re: a, im: 0 }, cAdd(ONE, cScale(zPow(omega, 1), -(1 - a))));
    }
    case 'highpass 6': {
      const a = filter.oneA;
      const lp = cDiv({ re: a, im: 0 }, cAdd(ONE, cScale(zPow(omega, 1), -(1 - a))));
      return cAdd(ONE, cScale(lp, -1)); // x - one
    }
    case 'lowpass 24':
      return cMul(svfResponse(w, k, 'lowpass'), svfResponse(w2, k2, 'lowpass'));
    case 'highpass 24':
      return cMul(svfResponse(w, k, 'highpass'), svfResponse(w2, k2, 'highpass'));
    case 'bandpass':
      // Normalized by the damping, exactly as the device normalizes it, so the band stays at
      // unity as the resonance narrows it rather than growing thirty decibels.
      return cScale(svfResponse(w, k, 'bandpass'), k);
    case 'bandpass 24':
      return cMul(cScale(svfResponse(w, k, 'bandpass'), k), cScale(svfResponse(w2, k2, 'bandpass'), k2));
    case 'highpass':
      return svfResponse(w, k, 'highpass');
    case 'notch':
      return svfResponse(w, k, 'notch');
    case 'peak':
      // The normalized band added back to the signal: 1 + 4k(2 - k)·bp.
      return cAdd(ONE, cScale(svfResponse(w, k, 'bandpass'), 4 * k * (2 - k)));
    case 'ladder': {
      const g = filter.ladder.G / (1 - filter.ladder.G);
      return ladderResponse(t / g, filter.ladder.k);
    }
    case 'comb': {
      // w[n] = x[n] + fb·w[n-L] and the output is (x + w[n-L])/2.
      const zL = zPow(omega, filter.combLen);
      const den = cAdd(ONE, cScale(zL, -filter.combFb));
      return cScale(cAdd(ONE, cDiv(zL, den)), 0.5);
    }
    case 'allpass': {
      // Four first-order sections, then the chain against the original. The feedback round the
      // chain is taken a sample late, which is the z^-1 in the loop.
      const a = filter.allpass[0].a;
      const z1 = zPow(omega, 1);
      const one = cDiv(cAdd({ re: a, im: 0 }, z1), cAdd(ONE, cScale(z1, a)));
      const chain = cMul(cMul(one, one), cMul(one, one));
      const loop = cAdd(ONE, cScale(cMul(z1, chain), -filter.apGain));
      return cScale(cAdd(ONE, cDiv(chain, loop)), 0.5);
    }
    case 'formant': {
      let sum = { re: 0, im: 0 };
      for (let i = 0; i < 3; i++) {
        const band = filter.formant[i];
        sum = cAdd(sum, cScale(svfResponse(t / band.g, band.k, 'bandpass'), filter.formantGain[i]));
      }
      return cScale(sum, 1.4);
    }
    default:
      return svfResponse(w, k, 'lowpass');
  }
}

/** The frequency the tuned filter is actually pointing at, for the line drawn through it. */
function cornerOf(filter, modeName, cutoff, sampleRate) {
  switch (modeName) {
    case 'lowpass 6':
    case 'highpass 6':
      // From the one-pole's own coefficient: -ln(1 - a)·sr/2π is the corner it took.
      return (-Math.log(Math.max(1e-9, 1 - filter.oneA)) * sampleRate) / (2 * Math.PI);
    case 'comb':
      // The comb's pitch is its delay length, which is where its first tooth lands.
      return sampleRate / filter.combLen;
    case 'allpass': {
      const a = filter.allpass[0].a;
      return (Math.atan((1 + a) / (1 - a)) * sampleRate) / Math.PI;
    }
    case 'formant':
      // The bank has three; the line marks the one that carries the vowel.
      return (Math.atan(filter.formant[0].g) * sampleRate) / Math.PI;
    case 'ladder': {
      const g = filter.ladder.G / (1 - filter.ladder.G);
      return (Math.atan(g) * sampleRate) / Math.PI;
    }
    default:
      return (Math.atan(filter.svf[0].g) * sampleRate) / Math.PI;
  }
}

/**
 * A magnitude as decibels, floored so a notch does not run off to negative infinity.
 *
 * Floored FAR below the window, not just under it: a steep mode falls past the bottom of the
 * picture within an octave or two of its corner, and a floor six decibels under the window put
 * the rest of the curve on a flat line across the picture's bottom padding - which read as a
 * filter that stopped filtering. The panel clips the curve at the window's edge instead, so the
 * value here only has to be finite.
 */
function toDb(mag, range) {
  const db = 20 * Math.log10(Math.max(1e-10, mag));
  return Math.max(range.bottomDb - 150, db);
}

// --- the equalizer ---------------------------------------------------------------------------

/**
 * The summed response of every band, from the same coefficients the bands filter with, and a
 * handle per band at its frequency and gain. A band whose type has no gain - a cut or a pass -
 * has its handle on the unity line, and moves only sideways.
 */
function eqFigure(figure, read, sampleRate, descriptor, report = null) {
  const bands = [];
  const coeffs = [];
  const scratch = new Float64Array(5);
  for (let b = 1; b <= figure.bands; b++) {
    const type = Math.round(read(`type${b}`) ?? 0);
    const hz = read(`freq${b}`) ?? 1000;
    const gainDb = read(`gain${b}`) ?? 0;
    const q = read(`q${b}`) ?? 1;
    const typeName = BIQUAD_TYPES[type] ?? BIQUAD_TYPES[0];
    const hasGain = typeName === 'peak' || typeName === 'lowshelf' || typeName === 'highshelf';
    coeffs.push(Float64Array.from(biquadCoefficients(type, hz, gainDb, q, sampleRate, scratch)));
    // The Q is the one control of a band that is not a place on the curve, so it has no axis to
    // be dragged along - the panel puts it on the wheel instead, and needs to know where it
    // sits on its own knob to move it from there.
    const qParam = descriptor?.params.find((p) => p.id === figure.params[`q${b}`]) ?? null;
    bands.push({
      band: b, type, typeName, hz, gainDb: hasGain ? gainDb : 0, q, hasGain,
      movesX: figure.params[`freq${b}`], movesY: hasGain ? figure.params[`gain${b}`] : null,
      movesQ: figure.params[`q${b}`] ?? null,
      qPosition: qParam ? normalize(qParam, q) : 0,
    });
  }
  const { lowHz, highHz } = EQ_RANGE;
  const top = Math.min(highHz, sampleRate * 0.5);
  const points = new Array(RESPONSE_POINTS);
  for (let i = 0; i < RESPONSE_POINTS; i++) {
    const hz = lowHz * Math.pow(top / lowHz, i / (RESPONSE_POINTS - 1));
    let mag = 1;
    for (const c of coeffs) mag *= biquadMagnitude(c, hz, sampleRate);
    points[i] = { hz, db: toDb(mag, EQ_RANGE) };
  }
  // What the signal actually is, behind the curve: decibels below full scale per band, from an
  // analyser the engine puts on the device's output while its window is open. Null when nothing
  // is reporting - a stopped track draws its curve over nothing, which is what it is doing.
  const spectrum = Array.isArray(report?.spectrum) ? report.spectrum : null;
  return { bands, points, range: EQ_RANGE, sampleRate, spectrum };
}

// --- a region of the spectrum ----------------------------------------------------------------

/** Two corners on a log axis, and the region between them. */
function bandFigure(figure, read) {
  const low = read('low') ?? 100;
  const high = Math.max(low, read('high') ?? 1000);
  return { low, high, range: RESPONSE_RANGE, movesLow: figure.params.low, movesHigh: figure.params.high };
}

// --- a modulation matrix ---------------------------------------------------------------------

/** Every cell of the matrix and every operator's output level, as a grid the panel draws. */
function matrixFigure(figure, read) {
  const ops = figure.ops;
  const cells = [];
  for (let from = 1; from <= ops; from++) {
    const row = [];
    for (let to = 1; to <= ops; to++) {
      row.push({ from, to, amount: read(`m${from}.${to}`) ?? 0, param: figure.params[`m${from}.${to}`] });
    }
    cells.push(row);
  }
  const levels = [];
  for (let n = 1; n <= ops; n++) levels.push({ op: n, level: read(`level${n}`) ?? 0, param: figure.params[`level${n}`] });
  return { ops, cells, levels };
}

// --- the envelopes --------------------------------------------------------------------------

/**
 * An ADSR as the voice will play it: the curve, and a handle for each stage.
 *
 * Levels come through the envelope's OWN curve function, and through it the same way round -
 * the attack is shaped by `-curve` and the decay and release by `curve`, which is what makes the
 * default sound like an amplitude envelope rather than looking like one. `scale` is folded in
 * because that is what the generator does with it, so the curve moves when envscale does.
 *
 * `x` is 0..1 across the figure and `span` says what that is in seconds, which is all a drag
 * needs: a handle moved by a fraction of the width moved the value by that fraction of the span.
 * The span is in SCALED seconds, so a drag divides by `scale` before writing the time back -
 * `.param("Amp Attack", …)` is the unscaled time, and scaling it twice would leave the handle
 * running away from the pointer on any patch whose envscale is not one.
 */
function adsrFigure(figure, read, descriptor) {
  const scale = read('scale') ?? 1;
  // One curve per stage, falling back to the single `curve` a device with one knob names. The
  // drawing reads each stage's own, so the picture is the envelope the generator runs.
  const curve = read('curve') ?? -4;
  const acurve = read('acurve') ?? curve;
  const dcurve = read('dcurve') ?? curve;
  const rcurve = read('rcurve') ?? curve;
  const attack = Math.max(0, read('attack') ?? 0) * scale;
  const decay = Math.max(0, read('decay') ?? 0) * scale;
  const release = Math.max(0, read('release') ?? 0) * scale;
  const sustain = Math.min(1, Math.max(0, read('sustain') ?? 0));

  const moving = attack + decay + release;
  const hold = Math.max(moving * ENV_HOLD_SHARE, ENV_MIN_SPAN_SEC * ENV_HOLD_SHARE);
  const span = Math.max(moving + hold, ENV_MIN_SPAN_SEC);

  const gate = attack + decay + hold;
  const level = (t) => {
    if (t <= 0) return 0;
    if (t < attack) return curveShape(t / attack, acurve);
    if (t < attack + decay) return 1 + (sustain - 1) * curveShape((t - attack) / decay, dcurve);
    if (t <= gate) return sustain;
    if (release <= 0) return 0;
    return sustain * (1 - curveShape((t - gate) / release, rcurve));
  };

  const points = new Array(ENV_POINTS);
  for (let i = 0; i < ENV_POINTS; i++) {
    const t = (i / (ENV_POINTS - 1)) * span;
    points[i] = { x: t / span, y: level(t) };
  }

  // Which parameter each axis of a handle moves, as ids, for the same reason `drag` is passed
  // through as ids: the client sends a parameter to the route a knob sends one to, and a role is
  // this module's business. A null axis does not move - an attack handle has no height to drag.
  const p = (role) => figure.params[role] ?? null;

  // Where each stage runs, and which parameter bends it. A curve is not a place on the picture -
  // there is no handle to drag for it - so the panel puts it on the wheel over the stage, the
  // same way an equalizer band's Q goes on the wheel over the band.
  const paramOf = (role) => descriptor?.params.find((x) => x.id === figure.params[role]) ?? null;
  const span_ = (role, from, to, value) => {
    const param = paramOf(role);
    return { role, x0: from / span, x1: to / span, moves: p(role), position: param ? normalize(param, value) : 0 };
  };
  const stages = [
    span_('acurve', 0, attack, acurve),
    span_('dcurve', attack, attack + decay, dcurve),
    span_('rcurve', gate, gate + release, rcurve),
  ].filter((x) => x.moves);

  return {
    attack, decay, sustain, release, curve, acurve, dcurve, rcurve, scale, span, stages,
    // The plateau's width, and where the gate closes - what a drag needs to turn a pointer on the
    // release handle back into a release time.
    hold, gate,
    points,
    handles: [
      { role: 'attack', label: 'A', x: attack / span, y: 1, movesX: p('attack'), movesY: null },
      { role: 'decay', label: 'D', x: (attack + decay) / span, y: sustain, movesX: p('decay'), movesY: p('sustain') },
      { role: 'release', label: 'R', x: (gate + release) / span, y: 0, movesX: p('release'), movesY: null },
    ],
    // The sustain plateau, grabbed along its length to set the level: the one handle that is a
    // line rather than a point, exactly as it is in the sampler's envelope panel.
    plateau: { role: 'sustain', x0: (attack + decay) / span, x1: gate / span, y: sustain, movesX: null, movesY: p('sustain') },
  };
}

// --- a sample, and the cloud of grains being read out of it -----------------------------------

/**
 * The file a granulator is reading, with where it is reading from drawn on it.
 *
 * The waveform is the outline the engine kept when the file was loaded, so this is a picture of
 * the bytes the synth has rather than of a second decode of the same file. The `grains` are the
 * processor's own report - where each sounding grain starts, how far through its life it is,
 * its pan and the stretch it plays - because there is nothing to infer them from: a grain's
 * start is a random draw inside the spray, and a drawing of the spray band alone would be a
 * picture of the settings rather than of the cloud they are making. The `window` is the shape
 * each grain is drawn as, so the picture can show how loud a grain is from how far along it is.
 */
function sampleFigure(figure, read, { waves, extras, report, shapes }) {
  const index = Math.round(read('sample') ?? 0);
  const held = waves?.[index] ?? null;
  const position = Math.min(1, Math.max(0, read('position') ?? 0));
  const spray = Math.min(1, Math.max(0, read('spray') ?? 0));
  return {
    name: held?.name ?? extras?.[figure.params.sample]?.[index] ?? null,
    peaks: held?.peaks ?? [],
    seconds: held?.seconds ?? 0,
    position,
    spray,
    // Milliseconds, so a grain can be drawn the width it really is against the file's length.
    size: read('size') ?? 0,
    scan: read('scan') ?? 0,
    // Null where the device has no grains AT ALL - a convolver draws its impulse with this same
    // figure and has none to report, and "0 grains" under it was an answer to a question nobody
    // asked. An empty list is a granulator with nothing sounding, which is a different thing.
    grains: figure.params.spray ? (report?.grains ?? []) : null,
    window: figure.params.window ? windowCurve(Math.round(read('window') ?? 0), shapes, LENS_POINTS) : null,
  };
}

/** How finely a grain's window is sampled for the lens each grain is drawn as. */
const LENS_POINTS = 24;

/** A grain window - a shipped one, or the table of a drawn one - as `n` levels across its length. */
function windowCurve(mode, shapes, n) {
  const drawn = shapes?.[mode] ?? null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out[i] = drawn ? drawnWindow(drawn.points, t) : grainWindow(mode, t);
  }
  return out;
}

/**
 * One grain's amplitude across its length, drawn from the window the synth applies.
 *
 * A window past the shipped shapes is one somebody DREW, which is not a formula - it is the
 * table the engine sampled and handed to the device, and the picture reads the same table.
 */
function grainFigure(descriptor, figure, read, { shapes, extras }) {
  const mode = Math.round(read('shape') ?? 0);
  const drawn = shapes?.[mode] ?? null;
  const points = windowCurve(mode, shapes, ENV_POINTS).map((y, i) => ({ x: i / (ENV_POINTS - 1), y }));
  const names = descriptor.params.find((p) => p.id === figure.params.shape)?.options ?? [];
  return {
    shape: mode,
    size: read('size') ?? 0,
    // The breakpoints, where this is a drawn one - what the editor opens on.
    data: drawn?.data ?? drawn?.name ?? extras?.[figure.params.shape]?.[mode] ?? null,
    shapeParam: figure.params.shape,
    curveName: curveNameOf(names, mode, drawn),
    shapeAxes: { x: 'grain', y: 'level' },
    // Every shipped window as breakpoints, for a copy of one to start from (see the panel's picker).
    builtIns: Object.fromEntries(names.map((name, i) => [name, breakpointsOf((t) => grainWindow(i, t))])),
    points,
  };
}

/** What a curve control's current setting is called: see the shaper figure's `curveName`. */
function curveNameOf(builtIns, index, drawn) {
  if (index < builtIns.length) return builtIns[index] ?? null;
  return drawn && drawn.name !== 'drawn' ? drawn.name : null;
}

/** A curve on 0..1 as five breakpoints: enough to hold its shape, and room to draw between. */
function breakpointsOf(curve) {
  const n = 5;
  const round = (v) => Math.round(v * 1000) / 1000;
  return Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return `${round(x)},${round(Math.min(1, Math.max(0, curve(x))))}`;
  }).join(' ');
}

// --- what a device is doing to the level -------------------------------------------------------

/**
 * A meter, read from the device's own report rather than from any control.
 *
 * Some of what a device does to a signal is not on a knob at all - an auto gain works out its
 * own correction, a compressor works out its own reduction - and a control that silently
 * changes the level is indistinguishable, from the outside, from a broken one. So the device
 * says how much, and this draws it.
 */
function meterFigure(figure, read, report) {
  const db = Number(report?.meters?.[figure.id] ?? 0);
  return {
    db: Number.isFinite(db) ? db : 0,
    range: figure.range ?? [-24, 24],
    // Whether the thing being metered is switched on at all: a meter sitting at zero because
    // nothing is running is not the same as one sitting at zero because nothing is needed.
    on: (read('amount') ?? 0) >= 0.5,
  };
}

// --- a compressor's transfer curve -------------------------------------------------------------

/** The decibel range a transfer curve is drawn over - quiet enough to see a low threshold. */
const TRANSFER_RANGE = Object.freeze({ lowDb: -60, highDb: 0 });
const TRANSFER_POINTS = 120;

/**
 * What comes out for what goes in, in decibels, drawn through the device's OWN gain computer.
 *
 * A compressor's controls are four numbers that only mean something together: a ratio says
 * nothing without a threshold, and a knee is invisible in both. The curve is the one picture
 * that says what they add up to - and it is computed with gainComputer rather than a second
 * copy of the law, so it cannot drift from what is being heard.
 *
 * `inDb` and `grDb` come from the device's report: where the signal actually is on that curve
 * right now, which is the other half of what somebody setting a compressor wants to see.
 */
function transferFigure(figure, read, report) {
  const threshold = read('threshold') ?? -18;
  // No ratio control means no ratio: a limiter is a compressor at infinity, and its curve is a
  // wall at the ceiling rather than a bend.
  const ratio = figure.params.ratio ? Math.max(1, read('ratio') ?? 4) : Infinity;
  const knee = read('knee') ?? 0;
  const makeup = read('makeup') ?? 0;
  // Gain applied BEFORE the detector, for the devices that have one. It slides the input along
  // the axis before the curve is read, which is a different picture from a makeup added after:
  // a limiter's gain is what drives the signal into the ceiling.
  const pregain = read('pregain') ?? 0;
  // How far a quiet signal is lifted toward the threshold, for the devices that do that. Zero
  // for the ones that do not, which is then an ordinary downward curve.
  const upward = read('upward') ?? 0;
  const reach = read('reach') ?? 40;

  const { lowDb, highDb } = TRANSFER_RANGE;
  const outAt = (inDb) => {
    const x = inDb + pregain;
    let change = gainComputer(x, threshold, ratio, knee);
    if (upward > 0 && x < threshold) {
      const below = Math.min(reach, threshold - x);
      const taper = below >= reach ? 0 : 1 - below / reach;
      change += below * (1 - 1 / ratio) * upward * taper;
    }
    return x + change + makeup;
  };
  const points = new Array(TRANSFER_POINTS);
  for (let i = 0; i < TRANSFER_POINTS; i++) {
    const inDb = lowDb + ((highDb - lowDb) * i) / (TRANSFER_POINTS - 1);
    points[i] = { inDb, outDb: outAt(inDb) };
  }
  const live = report?.meters?.[figure.id];
  // The last second of the level and the reduction, one entry a block, oldest first - the lane
  // beside the curve that shows the attack and the release as they happen. Null when the device
  // is not reporting, and the picture is the curve alone.
  const history = live?.history && Array.isArray(live.history.inDb) && Array.isArray(live.history.grDb)
    ? { inDb: live.history.inDb, grDb: live.history.grDb, end: historyEnd(live.history), blockSec: Number(live.history.blockSec) || 128 / NOMINAL_RATE }
    : null;
  return {
    threshold, ratio, knee, makeup, upward, pregain, history,
    // A wall rather than a bend, which the panel names differently: a ceiling, not a threshold.
    limiting: !Number.isFinite(ratio),
    range: TRANSFER_RANGE,
    points,
    // Null when the device is not reporting - a still picture of the settings, which is what an
    // effect on a stopped track has to say.
    inDb: Number.isFinite(live?.inDb) ? live.inDb : null,
    grDb: Number.isFinite(live?.grDb) ? live.grDb : 0,
  };
}

// --- a waveshaper's curve ------------------------------------------------------------------

/** Points across the input range of a shaper curve, -1..1. */
const SHAPER_POINTS = 129;

/**
 * What comes out for what goes in, through the curve the device shapes with, at the drive and
 * the bias it is set to - and scaled by the auto gain's correction where that is on, so the
 * picture is of the level being heard and the heading can say what the correction is.
 *
 * The correction is read from the device's report while it is running, which is the ramped
 * value the block is actually being multiplied by; a stopped device gets the same number from
 * the same function the processor calls, so the still picture and the live one agree.
 */
function shaperFigure(descriptor, figure, read, { report, shapes, extras }) {
  const modes = SHAPER_MODES;
  const mode = Math.round(read('mode') ?? 0);
  const driveDb = read('drive') ?? 0;
  const bias = read('bias') ?? 0;
  const character = read('character') ?? 0.5;
  const autogain = (read('autogain') ?? 1) >= 0.5;
  const drive = dbToGain(driveDb);
  // A mode past the named ones is a curve somebody drew: the table the engine sampled, which the
  // processor reads too, so the picture is the curve being played.
  const drawn = mode >= modes.length ? (shapes?.[mode] ?? null) : null;
  const table = drawn?.points ?? null;
  const reported = Number(report?.meters?.autogain);
  const comp = !autogain ? 1 : Number.isFinite(reported) && report?.meters?.autogain != null
    ? dbToGain(reported)
    : autoGainFor(mode, drive, bias, character, table);
  const points = new Array(SHAPER_POINTS);
  for (let i = 0; i < SHAPER_POINTS; i++) {
    const x = -1 + (2 * i) / (SHAPER_POINTS - 1);
    points[i] = { x, y: shape(x, mode, drive, bias, character, table) * comp };
  }
  // How loud the input is right now, 0..1 on the curve's own axis, or null when the device is not
  // reporting: the stretch of the curve between minus and plus this is where the signal lives.
  const level = Number(report?.meters?.level);
  return {
    mode, modeName: modes[mode] ?? drawn?.name ?? 'drawn', drive: driveDb, bias, character, autogain,
    // The name of the curve the device is on - a built-in's, a shape's - or null for breakpoints
    // written straight into the code. The panel's picker shows this, so it follows the device.
    curveName: curveNameOf(modes, mode, drawn),
    comp, compDb: 20 * Math.log10(Math.max(1e-6, comp)),
    level: report?.meters?.level != null && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : null,
    points,
    harmonics: harmonicsOf(mode, drive, bias, character, table),
    // What the draw button opens on (see the panel's figureShapeData): the drawn breakpoints
    // where there are some, and otherwise the curve as it stands at no drive, so drawing starts
    // from the sound you have rather than from nothing.
    shapeParam: figure.params.mode,
    shapeAxes: { x: 'level in', y: 'level out' },
    // Every shipped curve as breakpoints, for a copy of one to start from (see the panel's picker).
    builtIns: Object.fromEntries(modes.map((name, i) => [name, curveBreakpoints(i, character)])),
    data: drawn?.data ?? drawn?.name ?? extras?.[figure.params.mode]?.[mode] ?? curveBreakpoints(mode, character),
  };
}

/**
 * A named curve at no drive and no bias, as breakpoints on 0..1 both ways -
 * five of them, enough to hold the shape and few enough to leave room to draw between.
 */
function curveBreakpoints(mode, harmonic) {
  return breakpointsOf((x) => (shape(x * 2 - 1, mode, 1, 0, harmonic) + 1) / 2);
}

// --- a delay's repeats -----------------------------------------------------------------------

/** The most repeats an echoes figure draws, however high the feedback is. */
const ECHO_MAX = 24;

/** A repeat quieter than this is not drawn, and the picture ends where the last drawn one is. */
const ECHO_FLOOR = 0.02;

/**
 * The repeats one hit makes: when each lands and how loud, per side.
 *
 * Walked the way the delay's own feedback path walks: a plain delay repeats each side down its
 * own line, the right one later by the spread; a ping-pong sends each repeat into the other
 * line, so it lands on the far side after that side's time. The level of each is the feedback
 * raised to the number of times round - the tone in the loop is left out, being a color and not
 * a level. The time is the synced one where sync is on, which is why the tempo comes in.
 */
function echoesFigure(read, bpm) {
  const sync = Math.round(read('sync') ?? 0);
  const time = read('time') ?? 0.375;
  const seconds = syncedSeconds(sync, bpm, time);
  const feedback = Math.max(0, read('feedback') ?? 0);
  const pingpong = (read('pingpong') ?? 0) >= 0.5;
  const spread = Math.min(1, Math.max(0, read('spread') ?? 0));
  const timeL = seconds;
  const timeR = seconds * (1 + 0.5 * spread);
  const taps = [];
  if (pingpong) {
    let t = 0;
    for (let n = 0; n < ECHO_MAX; n++) {
      const level = Math.min(1, Math.pow(feedback, n));
      if (n > 0 && level < ECHO_FLOOR) break;
      t += n % 2 === 0 ? timeL : timeR;
      taps.push({ t, level, side: n % 2 === 0 ? -1 : 1 });
    }
  } else {
    for (let n = 0; n < ECHO_MAX; n++) {
      const level = Math.min(1, Math.pow(feedback, n));
      if (n > 0 && level < ECHO_FLOOR) break;
      if (spread > 0) {
        taps.push({ t: (n + 1) * timeL, level, side: -1 });
        taps.push({ t: (n + 1) * timeR, level, side: 1 });
      } else {
        taps.push({ t: (n + 1) * timeL, level, side: 0 });
      }
    }
  }
  taps.sort((a, b) => a.t - b.t);
  // Wide enough for the repeats that are drawn and for a few beats of grid, whichever is more.
  const beatSec = 60 / bpm;
  const span = Math.max(taps[taps.length - 1]?.t ?? 0, 4 * timeR, 2 * beatSec) * 1.05;
  return {
    time: seconds, feedback, pingpong, spread, sync, synced: !isFree(sync), syncName: SYNC_OPTIONS[sync] ?? null,
    beatSec, span, taps,
  };
}

// --- a beat repeat's catch -------------------------------------------------------------------

/**
 * One catch and the repeats it plays: each one as long as it lasts at its pitch, as loud as its
 * decay leaves it, against the interval on which the next catch may start.
 *
 * A repeat dropped in pitch plays its slice slower, so it is longer - which is why each is drawn
 * as a span rather than a tick, and why they stop lining up with the grid as the pitch falls.
 */
function repeatsFigure(read, bpm) {
  const interval = syncedSeconds(Math.round(read('interval') ?? 0), bpm, 2);
  const grid = syncedSeconds(Math.round(read('grid') ?? 0), bpm, 0.125);
  const repeats = Math.max(1, Math.round(read('repeats') ?? 1));
  const decay = Math.min(1, Math.max(0, read('decay') ?? 0));
  const pitch = read('pitch') ?? 0;
  const taps = [];
  let t = 0;
  for (let k = 0; k < repeats; k++) {
    const rate = Math.pow(2, (pitch * k) / 12);
    const length = grid / rate;
    taps.push({ t, length, level: Math.pow(1 - decay, k), semitones: pitch * k });
    t += length;
  }
  const span = Math.max(t, interval) * 1.05;
  return { interval, grid, repeats, decay, pitch, span, taps, end: t };
}

// --- a reverb's tail -------------------------------------------------------------------------

/** The decibel window a tail is drawn in: down to where the reverb's decay time is measured. */
const DECAY_RANGE = Object.freeze({ topDb: 0, bottomDb: -60 });
const DECAY_POINTS = 96;

/**
 * How the tail falls away after a hit: silence for the predelay, then a straight line down in
 * decibels, sixty of them over the decay time - which is what the decay control is, an RT60.
 */
function decayFigure(read) {
  const decay = Math.max(0.05, read('decay') ?? 2);
  const predelay = Math.max(0, read('predelay') ?? 0);
  const span = Math.max(0.3, (predelay + decay) * 1.15);
  const points = new Array(DECAY_POINTS);
  for (let i = 0; i < DECAY_POINTS; i++) {
    const t = (i / (DECAY_POINTS - 1)) * span;
    const db = t < predelay ? 0 : (-60 * (t - predelay)) / decay;
    points[i] = { t, db: Math.max(DECAY_RANGE.bottomDb - 10, db) };
  }
  return { decay, predelay, span, points, range: DECAY_RANGE };
}

// --- a modulated effect's sweep --------------------------------------------------------------

const SWEEP_POINTS = 96;

/**
 * What the LFO is doing to each copy over one of its cycles, read through the same function the
 * delay line reads it with: for a chorus or a flanger the delay in milliseconds per voice and
 * side, for a phaser the frequency the notches are centered on. The playhead is the phase the
 * processor reports, so the line moves with the sound rather than with a guess about it.
 */
function sweepFigure(figure, read, descriptor, bpm, report) {
  const sync = Math.round(read('sync') ?? 0);
  const rateHz = syncedHz(sync, bpm, read('rate') ?? 1);
  const shapeIx = Math.round(read('shape') ?? 0);
  const spread = Math.min(1, Math.max(0, read('spread') ?? 0));
  const depth = Math.max(0, read('depth') ?? 0);
  const traces = [];
  const curve = (label, side, fn) => {
    const points = new Array(SWEEP_POINTS);
    for (let i = 0; i < SWEEP_POINTS; i++) {
      const x = i / (SWEEP_POINTS - 1);
      points[i] = { x, y: fn(x) };
    }
    traces.push({ label, side, points });
  };
  const paramOf = (role) => descriptor?.params.find((p) => p.id === figure.params[role]) ?? null;
  let axis;
  if (figure.params.center) {
    // A phaser: octaves either side of the center, as the processor sweeps it.
    const center = read('center') ?? 1000;
    const octaves = 3 * depth;
    curve('L', -1, (x) => center * Math.pow(2, octaves * (lfoValue(x, 0) * 2 - 1)));
    curve('R', 1, (x) => center * Math.pow(2, octaves * (lfoValue(x + spread * 0.5, 0) * 2 - 1)));
    axis = { unit: 'Hz', log: true, min: RESPONSE_RANGE.lowHz, max: RESPONSE_RANGE.highHz };
  } else {
    // A chorus or a flanger: the delay in milliseconds, a voice per copy, the right side's LFO
    // behind the left's by the spread - the reads ModDelay#next makes.
    const base = read('delay') ?? 0;
    const voices = Math.max(1, Math.round(read('voices') ?? 1));
    for (let v = 0; v < voices; v++) {
      const offset = v / voices;
      const tag = voices > 1 ? String(v + 1) : '';
      curve(`L${tag}`, -1, (x) => base + depth * lfoValue(x + offset, shapeIx));
      curve(`R${tag}`, 1, (x) => base + depth * lfoValue(x + offset + spread * 0.5, shapeIx));
    }
    // The axis is the delay control's own range, fixed, so the depth knob is seen widening the
    // sweep rather than the picture rescaling around it; a delay at the top of its range with
    // depth on it runs off the top, which is true of it.
    axis = { unit: 'ms', log: false, min: 0, max: paramOf('delay')?.max ?? base + depth };
  }
  const phase = Number(report?.phase);
  return {
    rateHz, periodSec: 1 / Math.max(1e-6, rateHz), sync, synced: !isFree(sync), syncName: SYNC_OPTIONS[sync] ?? null,
    depth, spread, traces, axis,
    // Null when the device is not reporting: a still picture of the sweep.
    phase: Number.isFinite(phase) ? ((phase % 1) + 1) % 1 : null,
  };
}

/**
 * How many entries a device's history has ever written, or null from one that does not say. The
 * panel uses it to keep each entry on the same pixel column while it scrolls (see laneColumns in
 * the client).
 */
function historyEnd(h) {
  const end = Number(h.end);
  return Number.isFinite(end) ? end : null;
}

// --- a ducker's dip ------------------------------------------------------------------------

const DUCK_POINTS = 192;

/**
 * The dip over one beat, as the shape controls draw it: down over the attack, back up along
 * the curve over the length. Stepped through the same recursion the processor runs, at a
 * coarser step, so the attack's rounding and the curve's bend are the ones being heard.
 *
 * While the device reports, the picture also carries the last second of what it did - the gain
 * it applied, the signal it applied it to, and the key that triggered it where one is patched
 * in - which is the picture of a pump that a still curve cannot be.
 */
function duckFigure(read, bpm, report) {
  const sync = Math.round(read('sync') ?? 0);
  const period = syncedSeconds(sync, bpm, 0.5);
  const amount = Math.min(1, Math.max(0, read('amount') ?? 0));
  const length = Math.min(1, Math.max(0.05, read('length') ?? 0.5));
  const attackMs = Math.max(0, read('attack') ?? 0);
  const curve = read('curve') ?? 0;
  // What is triggering the dip: the clock, a track's notes, or a sidechain's audio. Only the
  // audio key measures the recovery in seconds times two rather than a share of the beat, as the
  // processor has it; the picture spans the recovery either way.
  const trigger = report?.trigger ?? (report?.keyed ? 'audio' : 'clock');
  const keyed = trigger === 'audio';
  const recovery = length * (keyed ? 2 : period);
  const span = keyed ? Math.max(0.1, recovery * 1.25) : period;
  const steps = 2048;
  const dt = span / steps;
  const attackK = attackMs > 0 ? 1 - Math.exp(-dt / (attackMs * 0.001)) : 1;
  const points = new Array(DUCK_POINTS);
  let gain = 1;
  let next = 0;
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    // Recorded before the step, so the first point is the level the beat lands on.
    if (i * (DUCK_POINTS - 1) >= next * steps) {
      points[next] = { x: t / span, y: gain };
      next += 1;
    }
    const x = Math.min(1, t / Math.max(0.001, recovery));
    const target = 1 - amount * (1 - curveShape(x, curve));
    gain += (target - gain) * (target < gain ? attackK : 1);
  }
  while (next < DUCK_POINTS) points[next++] = { x: 1, y: gain };
  const h = report?.history;
  const history = h && Array.isArray(h.gain) && Array.isArray(h.out)
    ? { gain: h.gain, out: h.out, key: Array.isArray(h.key) ? h.key : null, end: historyEnd(h), blockSec: Number(h.blockSec) || 128 / NOMINAL_RATE }
    : null;
  return {
    amount, length, attack: attackMs, curve, sync, synced: !isFree(sync), syncName: SYNC_OPTIONS[sync] ?? null,
    period, recovery, span, keyed, trigger, threshold: read('threshold') ?? -24,
    points, history,
  };
}
