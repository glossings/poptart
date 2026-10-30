'use strict';

// A track's channel controls under an audio-rate driver (sc/poptart.scd, chanIn and setChanAr).
//
// The browser hands an lfo(), env() or expression on a channel control the AudioParam itself
// (web-engine's Track#driveChannel), so it is read every sample: `.gain(sine("300hz").range(-1, 1))`
// multiplies the track by a 300 Hz sine, a ring modulator. The desktop used to map the same
// modulator onto the control through a control bus, read once a block (256 samples), so the sine
// came out as a staircase at the block rate - noise, not sidebands. Each control the browser drives
// per sample now reads its driver's audio bus per sample, and keeps its control for set and polled
// values.
//
// What this pins, offline (the real defs lifted out of poptart.scd, rendered by scsynth -N):
//   - the ring modulator: a 1 kHz tone times a bipolar 300 Hz sine on gain has its sidebands at
//     700 Hz and 1300 Hz and no carrier;
//   - every per-sample control (gain, postgain, pan, width, dry, wetN, a branch level, the DJ
//     stage's dry, bass mono, bend's republished value) follows its driver sample for sample;
//   - set values keep the browser's ranges: a negative gain turns the signal over, width stops at 4.
// Skipped (not failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');
const { liftedSource } = require('./synthdef/reference.js');

const SR = 48000;
const PORT = '57615'; // its own, like every sclang harness: only ten are tried from 57120 up
const SEC = 1;
const VSTPLUGIN_DIR = path.join(userExtensionsDir(), 'VSTPlugin', 'plugins');

// Each scenario writes four output channels: the result's pair, then its carrier and its driver.
const SCENARIOS = ['gainRing', 'postgainRing', 'pan', 'width', 'dry', 'wet', 'branch', 'djDry', 'bassmono', 'gainSet', 'widthSet', 'bend',
  'gainBig', 'widthDriven', 'wetWide', 'bassmonoZero', 'grainRate'];
const CH = SCENARIOS.length * 4;
const at = (name) => SCENARIOS.indexOf(name) * 4;

function harness(dir, osc) {
  const lifted = liftedSource();
  let text = `${lifted.functions}\n${lifted.boot}\n`.replaceAll('\\PoptartDevice.asClass', 'nil')
    .replaceAll('\\PoptartSpectrum.asClass', 'nil').replaceAll('\\PoptartPitchShift.asClass', 'nil');
  text = text.replace(/\}\)\.add;/g, '}) !? { |d| defs.add(d) };');
  let node = 2000;
  let abus = 512;
  let kbus = 0;
  const score = [];
  const s = (def, args) => { const id = node++; score.push(`[0.0, ["/s_new", "${def}", ${id}, 1, 0, ${args.map((a) => (typeof a === 'string' ? `"${a}"` : a)).join(', ')}]]`); return id; };
  const audio = (n = 2) => { const b = abus; abus += n; return b; };
  const control = (n = 1) => { const b = kbus; kbus += n; return b; };
  const tap = (from, to) => s('t_tap', ['in', from, 'out', to]);
  // A 1 kHz tone at 0.5 on both sides of a bus, and a 300 Hz bipolar sine from the engine's own
  // audio-rate LFO def (the one setParamLFO runs for a control with an audio path) - lo..hi.
  const tone = (bus, right = 1) => s('t_sine', ['out', bus, 'freq', 1000, 'amp', 0.5, 'right', right]);
  const lfo = (bus, lo, hi) => s('poptart_lfo_sine_ar', ['out', bus, 'freq', 300, 'lo', lo, 'hi', hi]);
  const strip = (inBus, base, extra = []) => s('poptart_track_shared', ['in', inBus, 'post', 4000, 'ctl', control(6), 'out', base / 2 + 1, 'pairs', CH / 2, ...extra]);
  const head = (inBus, out, extra = []) => s('poptart_head', ['inBus', inBus, 'out', out, 'bendOut', control(1), 'grainOut', control(4), ...extra]);

  { // gain: the ring modulator
    const b = at('gainRing'), src = audio(), chain = audio(), mod = audio();
    tone(src); lfo(mod, -1, 1);
    head(src, chain, ['gainAr', mod]); strip(chain, b);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // postgain, at the strip
    const b = at('postgainRing'), src = audio(), mod = audio();
    tone(src); lfo(mod, -1, 1);
    strip(src, b, ['postgainAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // pan, through the strip's law: the driver's pan-law node works out the two gains per sample
    const b = at('pan'), src = audio(), mod = audio(), gains = audio();
    tone(src); lfo(mod, -1, 1);
    s('poptart_panlaw', ['in', mod, 'out', gains]);
    strip(src, b, ['panAr', gains]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // width, on a left-only tone (mid = side)
    const b = at('width'), src = audio(), mod = audio();
    tone(src, 0); lfo(mod, 0, 4);
    strip(src, b, ['widthAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // dry, on the direct output
    const b = at('dry'), src = audio(), mod = audio();
    tone(src); lfo(mod, -1, 1);
    strip(src, b, ['dryAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // an effect's wet, with nothing in the slot to sound (native 1, no device): out = in * (1 - wet)
    const b = at('wet'), src = audio(), mod = audio();
    tone(src); lfo(mod, 0, 1);
    s('poptart_fx', ['in', src, 'out', b, 'scBus', 4000, 'active', 1, 'native', 1, 'wetAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // a branch level (rl<k>): its publisher and a term reading it
    const b = at('branch'), src = audio(), mod = audio(), pub = audio();
    tone(src); lfo(mod, -1, 1);
    s('poptart_gainkr', ['out', pub, 'levelAr', mod]);
    s('poptart_term', ['in', src, 'out', b, 'gain', pub]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // the DJ stage's direct output reads dry's driver too
    const b = at('djDry'), src = audio(), mod = audio(), post = audio(), ctl = control(6);
    tone(src); lfo(mod, -1, 1);
    s('poptart_track_shared', ['in', src, 'post', post, 'ctl', ctl, 'out', b / 2 + 1, 'pairs', CH / 2, 'direct', 0, 'dryAr', mod]);
    s('poptart_dj', ['in', post, 'ctl', ctl, 'cueBus', 4000, 'meterBus', 4000, 'fxOut', 4000, 'dryAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // bass mono on a pure side tone, its cutoff driven to 2 kHz: the 1 kHz side is mostly gone
    const b = at('bassmono'), src = audio(), mod = audio();
    s('t_side', ['out', src]); s('t_dc', ['out', mod, 'v', 2000]);
    s('poptart_bassmono', ['in', src, 'out', b, 'bassmonoAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // set values: a negative gain turns the signal over
    const b = at('gainSet'), src = audio(), chain = audio();
    s('t_dc', ['out', src, 'v', 1]);
    head(src, chain, ['gain', -0.5]); strip(chain, b);
  }
  { // ...and width stops at 4, as the browser's setChannel holds it
    const b = at('widthSet'), src = audio();
    s('t_dcl', ['out', src]);
    strip(src, b, ['width', 6]);
  }
  { // bend: the head republishes its driver on the control bus the sample voices map
    const b = at('bend'), src = audio(), chain = audio(), mod = audio(), bend = control(1);
    s('t_dc', ['out', mod, 'v', 60]); // past a set bend's 48: a driven one is not held, as in the browser
    s('poptart_head', ['inBus', src, 'out', chain, 'bendOut', bend, 'grainOut', control(4), 'bendAr', mod]);
    s('t_ktap', ['in', bend, 'out', b]);
  }
  { // no ceiling on gain: 10 is 10, as a browser gain node takes it
    const b = at('gainBig'), src = audio(), chain = audio();
    s('t_dc', ['out', src, 'v', 1]);
    head(src, chain, ['gain', 10]); strip(chain, b);
  }
  { // a driven width is held to 0..4 like a set one, on both engines
    const b = at('widthDriven'), src = audio(), mod = audio();
    s('t_dcl', ['out', src]); s('t_dc', ['out', mod, 'v', 6]);
    strip(src, b, ['widthAr', mod]);
  }
  { // a driven wet is not held to 0..1: the browser's wet and dry gains are the driver and 1 - it
    const b = at('wetWide'), src = audio(), mod = audio();
    tone(src); lfo(mod, -1, 2);
    s('poptart_fx', ['in', src, 'out', b, 'scBus', 4000, 'active', 1, 'native', 1, 'wetAr', mod]);
    tap(src, b + 2); tap(mod, b + 3);
  }
  { // a granular voice reads a driven grain rate per sample: 5 ms grains of a file of ones,
    // its rate control at 20 and its driver at 100 a second
    const b = at('grainRate'), rateBus = audio();
    score.push('[0.0, ["/b_alloc", 0, 4800, 1]]', '[0.0, ["/b_fill", 0, 0, 4800, 1.0]]');
    s('t_dc', ['out', rateBus, 'v', 100]);
    s('poptart_sample_grain_1', ['out', b, 'bufL', 0, 'bufR', 0, 'grainsize', 0.005, 'grainrate', 20, 'grainrateAr', rateBus]);
  }
  { // driven to 0, bass mono is on at its 20 Hz floor (not off): a 15 Hz side is cut by half
    const b = at('bassmonoZero'), src = audio(), mod = audio();
    s('t_side', ['out', src, 'freq', 15]); s('t_dc', ['out', mod, 'v', 0]);
    s('poptart_bassmono', ['in', src, 'out', b, 'bassmonoAr', mod]);
  }

  return `(
var server = (options: (numOutputBusChannels: ${CH}));
var cueOffset = nil;
var lfoDefName = { |shape, audio| ("poptart_lfo_" ++ shape ++ if (audio) { "_ar" } { "" }).asSymbol };
var trackDefName = { |key| ("poptart_track_" ++ key).asSymbol };
var bendPollHz = 100, grainMaxOverlap = 128, mixBandFreqs;
var chanIn, djIsolator, buildHeadDef, buildFxDef, buildXoverDef, buildTrackDef, buildDjDef, buildTapDef, buildBassMonoDef;
var buildMixDef, mixBank, exprSynthDef, viewTap = ();
var defs = List.new, dir = ${JSON.stringify(dir)};
${text}
[buildHeadDef.(), buildFxDef.(), buildTrackDef.(\\shared), buildDjDef.(), buildBassMonoDef.()].do { |d| defs.add(d) };
defs.add(SynthDef(\\t_sine, { |out, freq = 1000, amp = 0.5, right = 1| var x = SinOsc.ar(freq) * amp; Out.ar(out, [x, x * right]) }));
defs.add(SynthDef(\\t_side, { |out, freq = 1000| var x = SinOsc.ar(freq) * 0.5; Out.ar(out, [x, x.neg]) }));
defs.add(SynthDef(\\t_dc, { |out, v = 1| Out.ar(out, DC.ar(v) ! 2) }));
defs.add(SynthDef(\\t_dcl, { |out| Out.ar(out, [DC.ar(1), DC.ar(0)]) }));
defs.add(SynthDef(\\t_tap, { |in, out| Out.ar(out, In.ar(in, 1)) }));
defs.add(SynthDef(\\t_ktap, { |in, out| Out.ar(out, K2A.ar(In.kr(in, 1))) }));
defs.do { |d| if ([\\poptart_head, \\poptart_fx, \\poptart_track_shared, \\poptart_dj, \\poptart_bassmono, \\poptart_term, \\poptart_gainkr, \\poptart_panlaw, \\poptart_sample_grain_1,
    \\poptart_lfo_sine_ar, \\t_sine, \\t_side, \\t_dc, \\t_dcl, \\t_tap, \\t_ktap].includes(d.name.asSymbol)) { d.writeDefFile(dir) } };
Score([
    [0.0, ["/d_loadDir", dir]],
    ${score.join(',\n    ')},
    // Everything is freed before the end: VSTPlugin's UGen crashes scsynth's NRT teardown otherwise.
    [${SEC} - 0.01, ["/g_freeAll", 0]],
    [${SEC}, ["/c_set", 0, 0]]
]).writeOSCFile(${JSON.stringify(osc)});
"SCORE-OK".postln;
0.exit;
)
`;
}

function render(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-chan-audio-'));
  const sclang = resolveSclangPath();
  const scsynth = [path.join(path.dirname(sclang), '..', 'Resources', 'scsynth'), path.join(path.dirname(sclang), 'scsynth')]
    .find((p) => fs.existsSync(p)) ?? '';
  const osc = path.join(dir, 'score.osc');
  const wav = path.join(dir, 'out.wav');
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, harness(dir, osc));
  let out;
  try {
    out = execFileSync(sclang, ['-u', PORT, file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  if (!out.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
    return null;
  }
  if (/Class not defined/.test(out) && !out.includes('SCORE-OK')) {
    t.skip('sclang has no VSTPlugin extension here, so the defs cannot build');
    return null;
  }
  assert.match(out, /SCORE-OK/, `the defs did not build:\n${out.split('\n').slice(-30).join('\n')}`);
  if (!fs.existsSync(scsynth)) { t.skip('no scsynth next to sclang'); return null; }
  const plugins = [path.join(path.dirname(scsynth), 'plugins'), VSTPLUGIN_DIR].join(':');
  try {
    execFileSync(scsynth, ['-N', osc, '_', wav, String(SR), 'WAV', 'float', '-o', String(CH), '-i', '0', '-z', '256',
      '-a', '1024', '-c', '256', '-U', plugins], { stdio: 'ignore', timeout: 60000 });
  } catch (err) {
    if (!fs.existsSync(wav)) { t.skip(`scsynth did not render here: ${err.message}`); return null; }
  }
  const r = readWavRaw(wav);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(r && r.channels === CH, 'unreadable render');
  return { frames: r.data.length / CH, ch: (c, n) => r.data[n * CH + c] };
}

/** Amplitude of the component at `freq` over frames [from, to) of channel c (Goertzel, Hann-free: whole periods). */
function amplitudeAt(w, c, freq, from, to) {
  let re = 0, im = 0;
  for (let n = from; n < to; n++) {
    const ph = (2 * Math.PI * freq * n) / SR;
    re += w.ch(c, n) * Math.cos(ph);
    im += w.ch(c, n) * Math.sin(ph);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

/** The largest |got - want| over the analysis window, `want` computed from the recorded carrier and driver. */
function worst(w, c, want) {
  let max = 0;
  for (let n = Math.round(0.3 * SR); n < Math.round(0.95 * SR); n++) {
    const b = c - (c % 4);
    max = Math.max(max, Math.abs(w.ch(c, n) - want(w.ch(b + 2, n), w.ch(b + 3, n))));
  }
  return max;
}

// One render for every test here; each that has nothing to look at is skipped with the reason.
let rendered, why = null;
const W = (t) => {
  if (rendered === undefined) {
    rendered = render({ skip: (msg) => { why = msg; } });
  }
  if (!rendered) t.skip(why ?? 'no render');
  return rendered;
};

test('a bipolar 300 Hz sine on gain is a ring modulator: sidebands at f +- 300, no carrier', (t) => {
  const w = W(t);
  if (!w) return;
  // 0.3 s .. 0.9 s: 28800 frames, a whole number of periods of 100 Hz and so of every frequency here.
  const from = Math.round(0.3 * SR), to = Math.round(0.9 * SR);
  const b = at('gainRing');
  const lower = amplitudeAt(w, b, 700, from, to), upper = amplitudeAt(w, b, 1300, from, to);
  const carrier = amplitudeAt(w, b, 1000, from, to);
  t.diagnostic(`700 Hz ${lower.toFixed(4)}, 1300 Hz ${upper.toFixed(4)}, 1000 Hz ${carrier.toExponential(2)}`);
  // 0.5 sin(a) sin(b) = 0.25 cos(a - b) - 0.25 cos(a + b)
  assert.ok(Math.abs(lower - 0.25) < 0.005, `lower sideband ${lower}`);
  assert.ok(Math.abs(upper - 0.25) < 0.005, `upper sideband ${upper}`);
  assert.ok(carrier < 0.25 * 1e-3, `carrier still there: ${carrier} (-60 dB is ${0.25e-3})`);
  assert.ok(worst(w, b, (x, m) => x * m) < 1e-4, 'the track is not its input times the sine, sample for sample');
});

test('every per-sample channel control follows its driver sample for sample', (t) => {
  const w = W(t);
  if (!w) return;
  const panL = (p) => Math.SQRT2 * Math.cos(((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4);
  const panR = (p) => Math.SQRT2 * Math.sin(((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4);
  const cases = [
    ['postgainRing', 0, (x, m) => x * m],
    ['pan', 0, (x, m) => x * panL(m)],
    ['pan', 1, (x, m) => x * panR(m)],
    // left-only: mid = side = x / 2; left = mid + side * width
    ['width', 0, (x, m) => (x / 2) * (1 + m)],
    ['width', 1, (x, m) => (x / 2) * (1 - m)],
    ['dry', 0, (x, m) => x * m],
    ['wet', 0, (x, m) => x * (1 - m)],
    ['wetWide', 0, (x, m) => x * (1 - m)],
    ['branch', 0, (x, m) => x * m],
    ['djDry', 0, (x, m) => x * m],
  ];
  for (const [name, side, want] of cases) {
    const err = worst(w, at(name) + side, want);
    t.diagnostic(`${name}[${side}] worst error ${err.toExponential(2)}`);
    // Balance2 reads its law off a table, so the pan is near rather than exact.
    assert.ok(err < (name === 'pan' ? 2e-3 : 1e-4), `${name} side ${side} does not follow its driver (worst ${err})`);
  }
});

test('bass mono takes its cutoff from an audio-rate driver', (t) => {
  const w = W(t);
  if (!w) return;
  const from = Math.round(0.3 * SR), to = Math.round(0.9 * SR);
  const kept = amplitudeAt(w, at('bassmono'), 1000, from, to);
  // A 2 kHz 2-pole highpass passes a 1 kHz side at about a quarter; at the 20 Hz rest it would pass it whole.
  assert.ok(kept < 0.5 * 0.35, `the side at 1 kHz is ${kept}, as if the cutoff never moved`);
});

test('set values keep the browser ranges: gain may be negative, width stops at 4', (t) => {
  const w = W(t);
  if (!w) return;
  const n = Math.round(0.5 * SR);
  assert.ok(Math.abs(w.ch(at('gainSet'), n) + 0.5) < 1e-4, `gain -0.5 gave ${w.ch(at('gainSet'), n)}`);
  // left-only DC 1: left = (1 + width) / 2
  assert.ok(Math.abs(w.ch(at('widthSet'), n) - 2.5) < 1e-4, `width 6 gave ${w.ch(at('widthSet'), n)}, not width 4's 2.5`);
  assert.ok(Math.abs(w.ch(at('gainBig'), n) - 10) < 1e-4, `gain 10 gave ${w.ch(at('gainBig'), n)}`);
  assert.ok(Math.abs(w.ch(at('widthDriven'), n) - 2.5) < 1e-4, `width driven at 6 gave ${w.ch(at('widthDriven'), n)}, not width 4's 2.5`);
});

test('a granular voice takes its grain rate per sample from a driver', (t) => {
  const w = W(t);
  if (!w) return;
  let grains = 0, high = false;
  for (let n = Math.round(0.1 * SR); n < Math.round(0.9 * SR); n++) {
    const v = Math.abs(w.ch(at('grainRate'), n));
    if (!high && v > 0.3) { grains++; high = true; } else if (high && v < 0.05) high = false;
  }
  t.diagnostic(`${grains} grains in 0.8 s`);
  assert.ok(Math.abs(grains - 80) <= 2, `${grains} grains in 0.8 s - the driver says 100 a second, the control 20`);
});

test('bass mono driven to 0 is on, at its 20 Hz floor', (t) => {
  const w = W(t);
  if (!w) return;
  // 15 Hz over 0.2 .. 0.8 s is 9 whole periods. A 2-pole 20 Hz highpass passes 15 Hz at 0.49.
  const kept = amplitudeAt(w, at('bassmonoZero'), 15, Math.round(0.2 * SR), Math.round(0.8 * SR));
  assert.ok(kept > 0.5 * 0.35 && kept < 0.5 * 0.65, `the 15 Hz side is ${kept}: ${kept > 0.4 ? 'bass mono is off' : 'not a 20 Hz highpass'}`);
});

test('a driven bend reaches the control bus the sample voices map', (t) => {
  const w = W(t);
  if (!w) return;
  const v = w.ch(at('bend'), Math.round(0.5 * SR));
  assert.ok(Math.abs(v - 60) < 1e-4, `bend bus read ${v}`);
});
