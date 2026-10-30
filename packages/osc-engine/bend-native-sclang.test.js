'use strict';

// A native instrument following a moving bend (sc/poptart.scd's head def and chanIn, and
// PoptartDevice.cpp's bend input).
//
// The head hands its instrument the bend at the sample rate. Under an audio-rate driver (a native
// lfo() on .bend()) the device follows it in short pieces, as the browser's host does; a bend that
// holds still for the block is handed over as a number and the device renders the block whole.
// Rendered offline with the real head def and the committed PoptartDevices.scx: the Wavetable synth on a
// held note, its pitch measured window by window against the driver recorded beside it.
// Skipped (not failed) where sclang, scsynth, the device binary or VSTPlugin is missing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw } = require('./wav.js');
const { userExtensionsDir, DEVICE_BINARY } = require('./extensions.js');

const SR = 48000;
const SEC = 2;
const PORT = '57617';
const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = DEVICE_BINARY; // this platform's build (extensions.js)
const VSTPLUGIN_DIR = path.join(userExtensionsDir(), 'VSTPlugin', 'plugins');

function lift(name) {
  const m = fs.readFileSync(SCD, 'utf8').match(new RegExp(`^${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
  assert.ok(m, `could not find ${name} in sc/poptart.scd`);
  return m[0];
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = [path.join(path.dirname(sclang), '..', 'Resources', 'scsynth'), path.join(path.dirname(sclang), 'scsynth')]
    .find((p) => fs.existsSync(p));
  if (!scsynth) return { skip: 'no scsynth next to sclang' };
  const osc = path.join(dir, 'score.osc');
  const wav = path.join(dir, 'out.wav');
  const conf = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(conf, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'PoptartDevice.sc')}\n  - ${path.join(userExtensionsDir(), 'poptart')}\n`);
  const q = (s) => JSON.stringify(s);
  // Output channels: 0 the plain note, 1 the note under a driven +12, 2 under a moving bend, 3 that
  // bend (the driver, recorded).
  const script = `(
var bendPollHz = 100, chanIn, buildHeadDef, head, ix, lfo, tap, dc;
${lift('chanIn')}
${lift('buildHeadDef')}
("HAS-CLASS<" ++ (\\PoptartDevice.asClass.notNil) ++ ">").postln;
head = buildHeadDef.();
ix = head.metadata[\\poptartDevices][\\nslot0][\\index];
lfo = SynthDef(\\t_vib, { |out| Out.ar(out, SinOsc.ar(2) * 12) });
dc = SynthDef(\\t_dc, { |out, v = 0| Out.ar(out, DC.ar(v)) });
tap = SynthDef(\\t_tap, { |in, out| Out.ar(out, In.ar(in, 1)) });
[head, lfo, dc, tap].do { |d| d.writeDefFile(${q(dir)}) };
Score([
    [0.0, ['/d_loadDir', ${q(dir)}]],
    [0.0, ['/s_new', 't_dc', 900, 1, 0, 'out', 100, 'v', 12]],
    [0.0, ['/s_new', 't_vib', 901, 1, 0, 'out', 102]],
    [0.0, ['/s_new', 'poptart_head', 1000, 1, 0, 'inBus', 200, 'out', 110, 'bendOut', 10, 'grainOut', 20]],
    [0.0, ['/s_new', 'poptart_head', 1001, 1, 0, 'inBus', 200, 'out', 112, 'bendOut', 11, 'grainOut', 24, 'bendAr', 100]],
    [0.0, ['/s_new', 'poptart_head', 1002, 1, 0, 'inBus', 200, 'out', 114, 'bendOut', 12, 'grainOut', 28, 'bendAr', 102]],
    [0.0, ['/s_new', 't_tap', 1003, 1, 0, 'in', 110, 'out', 0]],
    [0.0, ['/s_new', 't_tap', 1004, 1, 0, 'in', 112, 'out', 1]],
    [0.0, ['/s_new', 't_tap', 1005, 1, 0, 'in', 114, 'out', 2]],
    [0.0, ['/s_new', 't_tap', 1006, 1, 0, 'in', 102, 'out', 3]],
    [0.0, ['/u_cmd', 1000, ix, '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1001, ix, '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1002, ix, '/open', 'Wavetable']],
    [0.1, ['/u_cmd', 1000, ix, '/noteOn', 60.0, 1.0]],
    [0.1, ['/u_cmd', 1001, ix, '/noteOn', 60.0, 1.0]],
    [0.1, ['/u_cmd', 1002, ix, '/noteOn', 60.0, 1.0]],
    // VSTPlugin's UGen crashes scsynth's NRT teardown unless everything is freed first.
    [${SEC} - 0.01, ['/g_freeAll', 0]],
    [${SEC}, ['/c_set', 0, 0]]
]).writeOSCFile(${q(osc)});
"SCORE-OK".postln;
0.exit;
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(sclang, ['-l', conf, '-u', PORT, file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  if (!out.includes('Welcome to SuperCollider')) return { skip: `sclang did not start here: ${out.trim().split('\n').pop()}` };
  if (!/HAS-CLASS<true>/.test(out)) return { skip: 'sclang could not compile PoptartDevice.sc here' };
  assert.match(out, /SCORE-OK/, `the head def did not build:\n${out.split('\n').slice(-25).join('\n')}`);
  const plugins = [path.join(path.dirname(scsynth), 'plugins'), path.dirname(SCX), VSTPLUGIN_DIR].join(':');
  try {
    execFileSync(scsynth, ['-N', osc, '_', wav, String(SR), 'WAV', 'float', '-o', '4', '-i', '0', '-z', '256',
      '-a', '512', '-c', '64', '-U', plugins], { stdio: 'ignore', timeout: 60000 });
  } catch (err) {
    if (!fs.existsSync(wav)) return { skip: `scsynth did not render here: ${err.message}` };
  }
  const r = readWavRaw(wav);
  assert.ok(r && r.channels === 4, 'unreadable render');
  return { ch: (c, n) => r.data[n * 4 + c], frames: r.data.length / 4 };
}

/**
 * How periodic channel c is over [from, from + len) near `want` Hz: the best normalized
 * autocorrelation within two semitones of that period, interpolated - as {hz, r}. A rich tone's
 * harmonics fool a free search into an octave; a search held near the expected pitch cannot pass a
 * wrong one, because a signal not periodic there correlates poorly with itself (r).
 */
function periodNear(w, c, from, want, len = 2048) {
  const x = Float64Array.from({ length: len }, (_, i) => w.ch(c, from + i));
  const lo = Math.floor(SR / (want * 2 ** (2 / 12))), hi = Math.ceil(SR / (want * 2 ** (-2 / 12)));
  const corr = (lag) => {
    let s = 0, a = 0, b = 0;
    for (let i = 0; i + lag < len; i++) { s += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; }
    return s / Math.sqrt(a * b || 1);
  };
  let best = lo;
  for (let lag = lo; lag <= hi; lag++) if (corr(lag) > corr(best)) best = lag;
  const [y0, y1, y2] = [corr(best - 1), corr(best), corr(best + 1)];
  const shift = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  return { hz: SR / (best + shift), r: y1 };
}

// Note 60 is c3 here (130.8 Hz), poptart's convention.
const C4 = 440 * 2 ** (-21 / 12);

test('a native instrument follows a moving bend, and a held driven one is a plain transposition', (t) => {
  if (!fs.existsSync(SCX)) { t.skip('no PoptartDevices.scx in this checkout'); return; }
  if (!fs.existsSync(VSTPLUGIN_DIR)) { t.skip(`no VSTPlugin installed at ${VSTPLUGIN_DIR}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-bend-native-'));
  try {
    const w = render(dir);
    if (w.skip) { t.skip(w.skip); return; }
    const base = periodNear(w, 0, Math.round(0.5 * SR), C4);
    assert.ok(base.r > 0.9 && Math.abs(Math.log2(base.hz / C4)) * 1200 < 10, `the plain note: ${base.hz} Hz (r ${base.r})`);
    const octave = periodNear(w, 1, Math.round(0.5 * SR), 2 * base.hz);
    assert.ok(octave.r > 0.9 && Math.abs(octave.hz / base.hz - 2) < 0.005, `a driven +12 gave ${octave.hz} Hz (r ${octave.r}) over ${base.hz} Hz`);
    // The moving bend: 2 Hz, +-12 semitones. Each 1024-frame window (21 ms) against the bend at
    // its middle, as recorded; the window spans up to +-1.6 semitones of the sweep around it.
    let worst = 0, weakest = 1;
    for (let at = Math.round(0.3 * SR); at + 1024 < Math.round(1.9 * SR); at += 2400) {
      const want = base.hz * 2 ** (w.ch(3, at + 512) / 12);
      const got = periodNear(w, 2, at, want, 1024);
      worst = Math.max(worst, Math.abs(Math.log2(got.hz / want)) * 1200);
      weakest = Math.min(weakest, got.r);
    }
    t.diagnostic(`base ${base.hz.toFixed(2)} Hz, octave ${octave.hz.toFixed(2)} Hz, vibrato worst ${worst.toFixed(1)} cents, weakest r ${weakest.toFixed(3)}`);
    assert.ok(worst < 40 && weakest > 0.8, `the instrument does not follow its bend: ${worst.toFixed(1)} cents off, r ${weakest.toFixed(3)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
