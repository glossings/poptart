'use strict';

// What a device holds has no length of its own (PoptartDevice.cpp): every file it is handed stays
// until that control and slot are loaded again - and comes back with the device when an evaluation
// reopens it - and every note for the coming block lands on its
// own sample however many there are. Rendered offline through a real scsynth with the committed
// PoptartDevices.scx.
//
// Skipped (not failed) where sclang or scsynth can't run, like the other *-sclang tests.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw, writeWav } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');
const { nativeDevice, paramPosition, deviceParam } = require('./native-devices');

const SR = 48000;
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = path.join(NATIVE_DIR, 'bin', 'PoptartDevices.scx');
const LANG_PORT = '57303';
const FILES = 10;                 // more than the 8 a device used to keep
const NOTES = 100;                // more than the 64 a block used to take
const NOTE_AT = 0.2 + 37 / SR;    // 37 samples into a block
const CLICK_AT = 0.3;

const index = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);
const position = (id, param, value) => paramPosition(nativeDevice(id), param, value);
// Response k is a tap at once and a second one (k + 1) * 5 ms later, which tells them apart.
const delayOf = (k) => Math.round(SR * 0.005 * (k + 1));

function sclangConf(dir) {
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'growth.wav');
  const q = (s) => JSON.stringify(s);
  const first = deviceParam(nativeDevice('Convolver'), 'ir').options.length;
  const loads = [];
  for (let k = 0; k < FILES; k++) {
    const file = path.join(dir, `ir${k}.wav`);
    const data = new Float32Array(Math.round(SR * 0.1));
    data[0] = 1;
    data[delayOf(k)] = 0.8;
    writeWav(file, { sampleRate: SR, channels: 1, data });
    loads.push(`[0.0, ['/b_allocRead', ${k}, ${q(file)}, 0, 0]]`);
    loads.push(`[0.05, ['/u_cmd', 1001, ix[\\fx], '/sample', ${index('Convolver', 'ir')}, ${first + k}, ${k}]]`);
  }
  const convSets = [
    [index('Convolver', 'ir'), position('Convolver', 'ir', first)], // the FIRST file loaded
    [index('Convolver', 'predelay'), position('Convolver', 'predelay', 0)],
    [index('Convolver', 'lowcut'), position('Convolver', 'lowcut', 10)],
    [index('Convolver', 'damping'), position('Convolver', 'damping', 20000)],
    [index('Convolver', 'mix'), position('Convolver', 'mix', 1)],
  ].flat().join(', ');
  const notes = Array.from({ length: NOTES }, (_, i) => `[${NOTE_AT}, ['/u_cmd', 1000, ix[\\synth], '/noteOn', ${40 + (i % 40)}.0, 1.0]]`).join(',\n    ');
  const script = `(
var defs, score, options, ix;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
defs = ();
defs[\\synth] = SynthDef(\\pd_g_synth, { |out = 0| Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\slot0)) });
defs[\\click] = SynthDef(\\pd_g_click, { |out = 0|
    var click = (Line.ar(0, 1, ${CLICK_AT}) >= 1) - (Line.ar(0, 1, ${CLICK_AT} + (4 / ${SR})) >= 1);
    Out.ar(out, PoptartDevice.ar((K2A.ar(0) + click) ! 2, 2, 0, nil, \\slot1));
});
ix = ();
ix[\\synth] = defs[\\synth].metadata[\\poptartDevices][\\slot0][\\index];
ix[\\fx] = defs[\\click].metadata[\\poptartDevices][\\slot1][\\index];
score = Score([
    [0.0, ['/d_recv', defs[\\synth].asBytes]],
    [0.0, ['/d_recv', defs[\\click].asBytes]],
    [0.0, ['/s_new', 'pd_g_synth', 1000, 0, 0, 'out', 0]],
    [0.0, ['/s_new', 'pd_g_click', 1001, 0, 0, 'out', 2]],
    [0.0, ['/u_cmd', 1000, ix[\\synth], '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1001, ix[\\fx], '/open', 'Convolver']],
    ${loads.join(',\n    ')},
    // An evaluation reopens every slot in the chain: the device is handed back what it holds.
    [0.08, ['/u_cmd', 1001, ix[\\fx], '/open', 'Convolver']],
    [0.1, ['/u_cmd', 1001, ix[\\fx], '/set', ${convSets}]],
    ${notes},
    [0.5, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(4);
options.sampleRate = ${SR};
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
score.recordNRT(
    ${q(path.join(dir, 'growth.osc'))}, ${q(out)}, nil,
    sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
    options: options, duration: 0.5,
    action: { "RENDER-DONE".postln; 0.exit });
SystemClock.sched(90, { "RENDER-TIMEOUT".postln; 0.exit });
)
`;
  const file = path.join(dir, 'harness.scd');
  fs.writeFileSync(file, script);
  let text;
  try {
    text = execFileSync(sclang, ['-l', sclangConf(dir), '-u', LANG_PORT, file], {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { text, out };
}

test('a device keeps every file it is handed, and every note in a block lands on its sample', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  let sclang;
  try { sclang = resolveSclangPath(); } catch { sclang = null; }
  if (!sclang || !fs.existsSync(sclang)) {
    t.skip('sclang is not installed here');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-growth-'));
  try {
    const { text, out } = render(dir);
    if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
      if (/Welcome to SuperCollider/.test(text) && !/RENDER-TIMEOUT/.test(text)) assert.fail(`render failed:\n${text.slice(-2000)}`);
      t.skip(`scsynth could not render here: ${text.trim().split('\n').pop() ?? ''}`);
      return;
    }
    const wav = readWavRaw(out);
    const sample = (channel, i) => wav.data[i * wav.channels + channel];
    // A hundred notes in one block, none of them sounding before its own sample.
    const onsetSample = Math.round(NOTE_AT * SR);
    const blockStart = onsetSample - 37;
    let early = 0;
    for (let i = blockStart; i < onsetSample; i++) early = Math.max(early, Math.abs(sample(0, i)));
    let after = 0;
    for (let i = onsetSample; i < onsetSample + 2400; i++) after = Math.max(after, Math.abs(sample(0, i)));
    assert.ok(after > 1e-3, `the notes never sounded (peak ${after.toExponential(2)})`);
    assert.strictEqual(early, 0, `a note sounded before its sample, at the start of its block (peak ${early.toExponential(2)})`);
    // Ten responses loaded, the first one chosen: its tap is the one that answers the click.
    const clickAt = Math.round(CLICK_AT * SR);
    let peakAt = -1;
    let peak = 0;
    for (let i = clickAt + 48; i < clickAt + Math.round(SR * 0.08); i++) {
      const v = Math.abs(sample(2, i));
      if (v > peak) { peak = v; peakAt = i; }
    }
    assert.ok(peak > 1e-3, `the convolver never answered (peak ${peak.toExponential(2)})`);
    const late = peakAt - clickAt;
    assert.ok(Math.abs(late - delayOf(0)) <= 8, `the first file's second tap is ${delayOf(0)} samples late; the answer's came ${late} late - an earlier file was let go`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
