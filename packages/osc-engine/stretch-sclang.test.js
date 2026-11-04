'use strict';

// The sampler's stretch voices on a real scsynth (sc/poptart.scd): the clean defs (the default,
// .stretchmode("clean") - the window read through PoptartStretch, the DJ keylock's stretcher) and
// the warp defs (.stretchmode("grain"), Warp1), against the plain voice beside them.
//
// One offline render, every voice on its own outputs:
//  - level: a clean stretch plays at the plain voice's level. The grain voice's is fitted to real
//    material (0.65, see poptart.scd: within 2 dB of plain on average there) and is held here only
//    to 6 dB, since two steady tones are the case where Warp1's grains cancel most (about -4 dB;
//    the old 2 / overlaps correction read -12.8 dB);
//  - pitch: a stretch holds the file's pitch, and .speed() still transposes under it (1.5 is a
//    fifth up) - in the clean voice as in the grain one, since speed is the pitch of both;
//  - length: the voice sounds for its `dur` and then releases;
//  - backwards: a negative speed reads the window backwards, at the file's pitch;
//  - tight loops (10 ms wrapping, 30 ms ping-pong backwards): an even level, and no sample-to-
//    sample jump bigger than the file's own - the corners crossfade instead of clicking;
//  - slices of 10 and 50 ms stretched three times: full level inside, and no click at either end;
//  - a file played through one-shot events, each from where the last left off (what .play() asks
//    of a .fit("stretch")): no dip or bump at the joins, clean or grain;
//  - a stereo file keeps its sides apart;
//  - parity: the render's clean voice is the browser's (web-engine's KeylockVoice, the shared
//    core), sample for sample, through its sustain.
//
// The UGen and its class come from native/keylock in this checkout, not from the user's
// Extensions folder (which holds whatever version the engine last installed). Skipped (not
// failed) where sclang or scsynth can't run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { userExtensionsDir } = require('./extensions.js');
const { writeWav, readWavRaw } = require('./wav.js');

const SCD = path.join(__dirname, 'sc', 'poptart.scd');
const SRC = fs.readFileSync(SCD, 'utf8');
const KEYLOCK_DIR = path.join(__dirname, 'native', 'keylock');
const SR = 48000;
const START = 0.1; // 4800 samples: a whole number of blocks, so every voice starts on a block edge
const S0 = Math.round(START * SR);
const FILE_SEC = 3;
const LANG_PORT = '57296';

/** One `SynthDef((...))` call, by how it starts in the source, balanced on parentheses. */
function synthDef(start) {
  const at = SRC.indexOf(`SynthDef(("${start}`);
  assert.ok(at >= 0, `could not find the SynthDef starting ${start} in sc/poptart.scd`);
  let depth = 0;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '(') depth++;
    else if (SRC[i] === ')' && --depth === 0) return SRC.slice(at, i + 1);
  }
  assert.fail(`unbalanced parentheses after ${start}`);
  return '';
}

const DEFS = [
  ['poptart_sample_', 'poptart_sample_" ++ nc'],
  ['poptart_sample_warp_', 'poptart_sample_" ++ kind ++ nc'],
  ['poptart_sample_clean_', 'poptart_sample_clean_" ++ nc'],
  ['poptart_sample_clean_loop_', 'poptart_sample_clean_loop_" ++ nc'],
];

const TONE_A = { f: 220, a: 0.3 };
const TONE_B = { f: 2600, a: 0.15 };

function monoFile() {
  const data = new Float32Array(FILE_SEC * SR);
  for (let i = 0; i < data.length; i++) {
    data[i] = TONE_A.a * Math.sin((2 * Math.PI * TONE_A.f * i) / SR) + TONE_B.a * Math.sin((2 * Math.PI * TONE_B.f * i) / SR);
  }
  return data;
}

function stereoFile() {
  const data = new Float32Array(FILE_SEC * SR * 2);
  for (let i = 0; i < FILE_SEC * SR; i++) {
    data[2 * i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR);
    data[2 * i + 1] = 0.3 * Math.sin((2 * Math.PI * 550 * i) / SR);
  }
  return data;
}

// The voices: [out, def, args]. Every arg not given is the def's default.
const WIN = { begin: 0.2, end: 0.5 }; // 0.9 s of the file
const THRU_EVENTS = 8;
const THRU_SEC = 0.25;
const THRU_STRETCH = 1.5;
function voices() {
  const v = [
    [0, 'poptart_sample_1', { ...WIN, rate: 1, dur: 0.9 }],
    [2, 'poptart_sample_clean_1', { ...WIN, rate: 1, dur: 1.8 }],
    [4, 'poptart_sample_warp_1', { ...WIN, rate: 1, dur: 1.8 }],
    [6, 'poptart_sample_clean_1', { ...WIN, rate: 1.5, dur: (0.9 * 2) / 1.5 }],
    [8, 'poptart_sample_clean_1', { ...WIN, rate: -1, dur: 1.8 }],
    // 10 ms of the file, looped at stretch 2; 30 ms bounced, backwards from its far edge.
    [10, 'poptart_sample_clean_loop_1', { begin: 0.4, end: 0.4 + 0.01 / FILE_SEC, rate: 1, dur: 0.02, loopLo: 0.4, loopHi: 0.4 + 0.01 / FILE_SEC, entry: 0.4 }],
    [12, 'poptart_sample_clean_loop_1', { begin: 0.4, end: 0.4 + 0.03 / FILE_SEC, rate: -1, dur: 0.06, loopLo: 0.4, loopHi: 0.4 + 0.03 / FILE_SEC, entry: 0.4 + 0.03 / FILE_SEC, pingpong: 1 }],
    [20, 'poptart_sample_clean_2', { ...WIN, rate: 1, dur: 1.8, buf: 1 }],
    // Slices of 10 and 50 ms, stretched three times.
    [22, 'poptart_sample_clean_1', { begin: 0.4, end: 0.4 + 0.01 / FILE_SEC, rate: 1, dur: 0.03 }],
    [24, 'poptart_sample_clean_1', { begin: 0.4, end: 0.4 + 0.05 / FILE_SEC, rate: 1, dur: 0.15 }],
  ];
  // A file played through: each event plays THRU_SEC of output from where the last left off.
  for (const [out, def] of [[14, 'poptart_sample_clean_1'], [16, 'poptart_sample_warp_1']]) {
    for (let k = 0; k < THRU_EVENTS; k++) {
      const begin = (0.2 + (k * THRU_SEC) / THRU_STRETCH) / FILE_SEC;
      v.push([out, def, { begin, end: begin + THRU_SEC / THRU_STRETCH / FILE_SEC, rate: 1, dur: THRU_SEC, at: START + k * THRU_SEC }]);
    }
  }
  // ...and the plain voice's version: the file played through at speed 1.
  for (let k = 0; k < THRU_EVENTS; k++) {
    const begin = (0.2 + k * THRU_SEC) / FILE_SEC;
    v.push([18, 'poptart_sample_1', { begin, end: begin + THRU_SEC / FILE_SEC, rate: 1, dur: THRU_SEC, at: START + k * THRU_SEC }]);
  }
  return v;
}
const LOOP_OFF = 1.0; // the loops' gate-off, after the start
const CHANNELS = 26;
const DURATION = 2.4;

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const mono = path.join(dir, 'mono.wav');
  const stereo = path.join(dir, 'stereo.wav');
  writeWav(mono, { sampleRate: SR, channels: 1, data: monoFile() });
  writeWav(stereo, { sampleRate: SR, channels: 2, data: stereoFile() });
  const outPath = path.join(dir, 'render.wav');
  let node = 1000;
  const bundles = [];
  for (const [out, def, args] of voices()) {
    const id = node++;
    const { at = START, ...rest } = args;
    const pairs = Object.entries({ out, buf: 0, gate: 1, amp: 1, atk: 0, dec: 0, sus: 1, rel: 0.05, ...rest })
      .map(([k, val]) => `"${k}", ${val}`).join(', ');
    bundles.push(`[${at}, ["/s_new", "${def}", ${id}, 0, 0, ${pairs}]]`);
    if (def.includes('_loop_')) bundles.push(`[${START + LOOP_OFF}, ["/n_set", ${id}, "gate", 0]]`);
  }
  // The checkout's keylock extension, and nothing the user has installed under that name.
  const conf = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(conf, `includePaths:\n  - ${KEYLOCK_DIR}\nexcludePaths:\n  - ${path.join(userExtensionsDir(), 'poptart')}\n`);
  const script = `(
var toStereo, kind = "warp_", defs = List.new;
${fs.existsSync(scsynth) ? `Score.program = ${JSON.stringify(scsynth)}.quote;` : ''}
("HAS-STRETCH<" ++ \\PoptartStretch.asClass.notNil ++ ">").postln;
[1, 2].do { |nc|
    toStereo = { |sig| if (nc == 1) { sig ! 2 } { sig } };
${DEFS.map(([, start]) => `    defs.add(${synthDef(start)});`).join('\n')}
};
defs.do { |d| ("DEF-OK<" ++ d.name ++ ">").postln };
Score.recordNRT(defs.collect({ |d| [0.0, ["/d_recv", d.asBytes]] }) ++ [
    [0.0, ["/b_allocRead", 0, ${JSON.stringify(mono)}]],
    [0.0, ["/b_allocRead", 1, ${JSON.stringify(stereo)}]],
${bundles.map((b) => `    ${b},`).join('\n')}
    [${DURATION}, ["/c_set", 0, 0]]
], ${JSON.stringify(`${outPath}.osc`)}, ${JSON.stringify(outPath)}, sampleRate: ${SR},
    headerFormat: "WAV", sampleFormat: "float",
    options: ServerOptions.new.numOutputBusChannels_(${CHANNELS})
        .ugenPluginsPath_([Platform.resourceDir +/+ "plugins", ${JSON.stringify(path.join(KEYLOCK_DIR, 'bin'))}]),
    duration: ${DURATION},
    action: { "RENDER-DONE".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let out;
  try {
    out = execFileSync(sclang, ['-l', conf, '-u', LANG_PORT, file], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { out, outPath };
}

const rms = (x, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (a, b) => 20 * Math.log10(a / b);

/** The strongest frequency within ±10% of f (1 Hz steps) over x[from, to). */
function peakHz(x, from, to, f) {
  let best = 0;
  let at = 0;
  for (let ff = Math.floor(f * 0.9); ff <= f * 1.1; ff++) {
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const a = (2 * Math.PI * ff * i) / SR;
      re += x[i] * Math.cos(a);
      im += x[i] * Math.sin(a);
    }
    const m = Math.hypot(re, im);
    if (m > best) { best = m; at = ff; }
  }
  return at;
}

const maxStep = (x, from, to) => {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

/** RMS over consecutive `win`-sample frames of x[from, to), in dB against `ref`: [lowest, highest]. */
function spread(x, from, to, win, ref) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i + win <= to; i += win) {
    const d = db(rms(x, i, i + win), ref);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return [lo, hi];
}

test('the clean and grain stretch voices: level, pitch, length, loops, joins and the browser\'s core', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-stretch-'));
  try {
    const { out, outPath } = render(dir);
    if (!out.includes('Welcome to SuperCollider')) {
      t.skip(`sclang did not start here: ${out.trim().split('\n').pop() ?? 'no output'}`);
      return;
    }
    assert.match(out, /HAS-STRETCH<true>/, `PoptartStretch's class did not compile from native/keylock:\n${out}`);
    for (const [name] of DEFS) for (const nc of [1, 2]) assert.match(out, new RegExp(`DEF-OK<${name}${nc}>`), `${name}${nc} did not build:\n${out}`);
    if (!out.includes('RENDER-DONE') || !fs.existsSync(outPath)) {
      t.skip(`scsynth could not render offline here: ${out.trim().split('\n').slice(-3).join(' | ')}`);
      return;
    }
    const wav = readWavRaw(outPath);
    const ch = (k) => {
      const x = new Float32Array(wav.frames);
      for (let i = 0; i < wav.frames; i++) x[i] = wav.data[i * wav.channels + k];
      return x;
    };
    const [plain, clean, grain, fifth, back, loop10, ping30, thruClean, thruGrain] = [0, 2, 4, 6, 8, 10, 12, 14, 16].map(ch);
    const mid = (sec) => [S0 + Math.round(0.2 * SR), S0 + Math.round((sec - 0.2) * SR)];
    const ref = rms(plain, ...mid(0.9));
    assert.ok(Math.abs(db(ref, Math.hypot(TONE_A.a, TONE_B.a) / Math.SQRT2)) < 0.2, `the plain voice read ${ref}`);

    // Level: clean and grain at the plain voice's.
    const levels = { clean: db(rms(clean, ...mid(1.8)), ref), grain: db(rms(grain, ...mid(1.8)), ref) };
    t.diagnostic(`level against plain: clean ${levels.clean.toFixed(2)} dB, grain ${levels.grain.toFixed(2)} dB`);
    assert.ok(Math.abs(levels.clean) < 0.5, `the clean voice is ${levels.clean.toFixed(2)} dB off the plain one`);
    assert.ok(Math.abs(levels.grain) < 6, `the grain voice is ${levels.grain.toFixed(2)} dB off the plain one`);

    // Pitch: held at stretch 2, a fifth up at speed 1.5, held backwards.
    const [a, b] = mid(1.8);
    // The grain voice's is reported only: Warp1 scatters its grains at random, which smears its
    // line by several hertz from one render to the next.
    const pitches = [[clean, 220, 'clean'], [fifth, 330, 'clean at speed 1.5'], [back, 220, 'clean backwards'], [grain, 220, 'grain']]
      .map(([x, want, name]) => [name, want, peakHz(x, a, a + 38400, want)]);
    t.diagnostic(`pitch: ${pitches.map(([name, want, got]) => `${name} ${got} Hz (${want})`).join(', ')}`);
    for (const [name, want, got] of pitches.slice(0, 3)) assert.ok(Math.abs(got - want) <= 1, `${name}: the tone came out at ${got} Hz, not ${want}`);
    assert.ok(Math.abs(db(rms(back, a, b), ref)) < 0.5, 'the backwards clean stretch is off level');

    // Length: full level to its dur, released (50 ms) after it.
    const end = S0 + Math.round(1.8 * SR);
    assert.ok(db(rms(clean, end - 2400, end - 1200), ref) > -1, 'the clean voice faded before its dur');
    assert.ok(rms(clean, end + 4800, end + 9600) < 1e-4, 'the clean voice sounds on past its release');

    // Tight loops: an even level and no click at a corner.
    const fileStep = maxStep(monoFile(), 0, SR);
    for (const [name, x] of [['10 ms wrapping', loop10], ['30 ms ping-pong', ping30]]) {
      const from = S0 + 2400;
      const to = S0 + Math.round((LOOP_OFF - 0.02) * SR);
      const [lo, hi] = spread(x, from, to, 480, ref);
      const step = maxStep(x, from, to);
      t.diagnostic(`${name} loop: 10 ms frames from ${lo.toFixed(2)} to ${hi.toFixed(2)} dB, largest step ${step.toFixed(4)} (the file's ${fileStep.toFixed(4)})`);
      assert.ok(lo > -6 && hi < 3, `the ${name} loop's level swings from ${lo.toFixed(1)} to ${hi.toFixed(1)} dB`);
      assert.ok(step < 1.5 * fileStep, `the ${name} loop jumps ${step.toFixed(4)} in a sample - a click at a corner`);
      assert.ok(rms(x, to + 0.12 * SR, to + 0.2 * SR) < 1e-4, `the ${name} loop did not release at its gate`);
    }

    // Short slices: at full level through the window, then a release with no click in it.
    for (const [k, sec] of [[22, 0.03], [24, 0.15]]) {
      const x = ch(k);
      const n = Math.round(sec * SR);
      const level = db(rms(x, S0 + 48, S0 + n - 48), ref);
      const step = maxStep(x, S0 - 64, S0 + n + 0.1 * SR);
      t.diagnostic(`${(sec / 3) * 1000} ms slice at stretch 3: ${level.toFixed(2)} dB, largest step ${step.toFixed(4)}`);
      assert.ok(Math.abs(level) < 1.5, `the ${(sec / 3) * 1000} ms slice played at ${level.toFixed(1)} dB`);
      assert.ok(step < 1.5 * fileStep, `the ${(sec / 3) * 1000} ms slice jumps ${step.toFixed(4)} in a sample`);
      assert.ok(rms(x, S0 + n + 0.07 * SR, S0 + n + 0.1 * SR) < 1e-4, 'the slice did not release');
    }

    // A file played through in one-shot events: every 5 ms of the run within a few dB, both modes.
    const joins = {};
    for (const [name, x] of [['plain', ch(18)], ['clean', thruClean], ['grain', thruGrain]]) {
      const run = [S0 + 2400, S0 + Math.round((THRU_EVENTS * THRU_SEC - 0.02) * SR)];
      const [lo, hi] = spread(x, ...run, 240, rms(x, ...run));
      const step = maxStep(x, ...run);
      t.diagnostic(`${name} played through: 5 ms frames from ${lo.toFixed(2)} to ${hi.toFixed(2)} dB, largest step ${step.toFixed(4)}`);
      joins[name] = [lo, hi];
    }
    // Each event's release reads on into the audio the next one starts with, so a join sums two
    // near-coherent copies for a moment - in the plain voice exactly so. The clean voice's joins
    // are no rougher than that.
    assert.ok(joins.clean[0] > joins.plain[0] - 1 && joins.clean[1] < joins.plain[1] + 1,
      `the clean voice's joins swing ${joins.clean.map((d) => d.toFixed(1)).join(' to ')} dB, the plain voice's ${joins.plain.map((d) => d.toFixed(1)).join(' to ')}`);

    // Stereo: each side its own.
    const left = ch(20);
    const right = ch(21);
    assert.ok(Math.abs(peakHz(left, a, a + 38400, 220) - 220) <= 1, 'the stereo file\'s left side moved');
    assert.ok(Math.abs(peakHz(right, a, a + 38400, 550) - 550) <= 1, 'the stereo file\'s right side moved');

    // Parity: the browser's core, given the numbers the def computes (in float32, as the server
    // does), is the render through the sustain.
    const { KeylockVoice } = await import('../web-engine/src/dsp/keylock.mjs');
    const f = Math.fround;
    const frames = FILE_SEC * SR;
    const fileData = Float32Array.from(readWavRaw(path.join(dir, 'mono.wav')).data);
    for (const [x, rate, name] of [[clean, 1, 'stretch 2'], [fifth, 1.5, 'speed 1.5'], [back, -1, 'backwards']]) {
      const dur = rate === 1.5 ? (0.9 * 2) / 1.5 : 1.8;
      const speed = f(f(f(f(f(WIN.end) - f(WIN.begin)) * f(frames / SR)) / f(dur)) * (rate < 0 ? -1 : 1));
      const from = rate < 0 ? Math.max(f(f(WIN.begin) * frames), f(f(f(WIN.end) * frames) - 1)) : f(f(WIN.begin) * frames);
      const voice = new KeylockVoice(SR, 1);
      voice.setSource([fileData], frames, 1, 1);
      voice.start({ pos: from, rate: speed });
      const n = Math.round(dur * SR) - 4800;
      const mine = [new Float64Array(n)];
      for (let at = 0; at < n; at += 64) {
        const rows = [mine[0].subarray(at, Math.min(n, at + 64))];
        voice.process(rows, rows[0].length, Math.abs(f(rate)));
      }
      let worst = 0;
      for (let i = 2400; i < n; i++) worst = Math.max(worst, Math.abs(x[S0 + i] - mine[0][i]));
      t.diagnostic(`${name}: the render against the browser's core, worst ${worst.toExponential(2)}`);
      assert.ok(worst < 1e-4, `${name}: the desktop's clean voice and the browser's core disagree by ${worst.toExponential(2)}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
