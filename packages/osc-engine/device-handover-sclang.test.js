'use strict';

// What a native device can be HANDED besides its controls, through a real scsynth: a wavetable
// cut from a file at the frame length the file declares, a drawn curve sent as its points, a
// stereo impulse response kept stereo - and a note that lands on its own sample rather than on
// the block edge before it.
//
// The parity test (native-device-parity.test.mjs) holds the DSP of each of these to the
// browser's; what only a server can say is that the UGen's half works - the asynchronous sample
// stages with both layouts, the /shape command, the work round that builds a table or a response
// off the audio thread, and the offset a timestamped unit command is performed at (World's
// mSampleOffset). Rendered offline, as native-device-sclang.test.js is; skipped where sclang or
// scsynth cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { resolveSclangPath } = require('./index.js');
const { readWavRaw, writeWav, encodeWav } = require('./wav.js');
const { userExtensionsDir } = require('./extensions.js');
const { nativeDevice, paramPosition, deviceParam } = require('./native-devices');

const SR = 48000;
const BLOCK = 64; // scsynth's default block, which Score.recordNRT renders with
const NATIVE_DIR = path.join(__dirname, 'native', 'devices');
const SCX = path.join(NATIVE_DIR, 'bin', 'PoptartDevices.scx');
const LANG_PORT = '57301';

const index = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);
const position = (id, param, value) => paramPosition(nativeDevice(id), param, value);
const firstSpare = (id, param) => deviceParam(nativeDevice(id), param).options.length;

/** A WAV with a `clm ` chunk declaring its frame length, the way wavetable editors write one. */
function writeTableWav(file, frames, length) {
  const data = new Float32Array(frames * length);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < length; i++) {
      let v = 0;
      for (let k = 1; k <= 1 + f * 2; k++) v += Math.sin((2 * Math.PI * k * i) / length) / k;
      data[f * length + i] = v * 0.5;
    }
  }
  const wav = encodeWav({ sampleRate: SR, channels: 1, data });
  const text = Buffer.from(`<!>${length} 10000000 wavetable`, 'latin1');
  const body = Buffer.concat([text, Buffer.alloc(text.length & 1)]);
  const head = Buffer.alloc(8);
  head.write('clm ', 0, 'latin1');
  head.writeUInt32LE(text.length, 4);
  const out = Buffer.concat([wav.subarray(0, 12), head, body, wav.subarray(12)]);
  out.writeUInt32LE(out.length - 8, 4);
  fs.writeFileSync(file, out);
}

/** A stereo response with its two sides apart in time: a tap at once on the left, late on the right. */
function writeStereoIr(file) {
  const frames = Math.round(SR * 0.15);
  const data = new Float32Array(frames * 2);
  data[0] = 1;                               // left, tap 0
  data[Math.round(SR * 0.1) * 2 + 1] = 1;    // right, tap at 100 ms
  writeWav(file, { sampleRate: SR, channels: 2, data });
}

function sclangConf(dir) {
  const installed = path.join(userExtensionsDir(), 'PoptartDevice.sc');
  const file = path.join(dir, 'sclang_conf.yaml');
  fs.writeFileSync(file, `includePaths:\n  - ${NATIVE_DIR}\nexcludePaths:\n  - ${installed}\n`);
  return file;
}

// Where in the render each thing is played, in seconds and in samples.
const NOTE_AT = 0.2 + 37 / SR;              // 37 samples into a block: 9600 is a block edge
const FM_NOTE_AT = 0.2 + 91 / SR;

function render(dir) {
  const sclang = resolveSclangPath();
  const scsynth = path.join(path.dirname(sclang), 'scsynth');
  const out = path.join(dir, 'handover.wav');
  const table = path.join(dir, 'table.wav');
  const ir = path.join(dir, 'ir.wav');
  writeTableWav(table, 8, 256);
  writeStereoIr(ir);
  const q = (s) => JSON.stringify(s);
  const shapePoints = Array.from({ length: 256 }, (_, i) => (1 - i / 255).toFixed(6)).join(', ');
  const wt = {
    table: index('Wavetable', 'osc1.table'),
    slot: firstSpare('Wavetable', 'osc1.table'),
  };
  wt.position = position('Wavetable', 'osc1.table', wt.slot);
  const dist = { mode: index('Distort', 'mode'), slot: firstSpare('Distort', 'mode') };
  dist.position = position('Distort', 'mode', dist.slot);
  const conv = { ir: index('Convolver', 'ir'), slot: firstSpare('Convolver', 'ir') };
  conv.position = position('Convolver', 'ir', conv.slot);
  const convSets = [
    [index('Convolver', 'ir'), conv.position],
    [index('Convolver', 'predelay'), position('Convolver', 'predelay', 0)],
    [index('Convolver', 'lowcut'), position('Convolver', 'lowcut', 10)],
    [index('Convolver', 'damping'), position('Convolver', 'damping', 20000)],
    [index('Convolver', 'mix'), position('Convolver', 'mix', 1)],
  ].flat().join(', ');
  const script = `(
var defs, score, options, ix;
${fs.existsSync(scsynth) ? `Score.program = ${q(scsynth)}.quote;` : ''}
defs = ();
defs[\\synth] = SynthDef(\\pd_h_synth, { |out = 0| Out.ar(out, PoptartDevice.ar([], 2, 0, nil, \\slot0)) });
// A sine for the curve to shape, and a click at 0.2 s for the response to answer.
defs[\\sine] = SynthDef(\\pd_h_sine, { |out = 0|
    Out.ar(out, PoptartDevice.ar(SinOsc.ar(220) * 0.4 ! 2, 2, 0, nil, \\slot1));
});
defs[\\click] = SynthDef(\\pd_h_click, { |out = 0|
    // Four samples of full scale, at 0.2 s.
    var click = (Line.ar(0, 1, 0.2) >= 1) - (Line.ar(0, 1, 0.2 + (4 / ${SR})) >= 1);
    Out.ar(out, PoptartDevice.ar((K2A.ar(0) + click) ! 2, 2, 0, nil, \\slot1));
});
ix = ();
ix[\\synth] = defs[\\synth].metadata[\\poptartDevices][\\slot0][\\index];
ix[\\fx] = defs[\\sine].metadata[\\poptartDevices][\\slot1][\\index];
ix[\\click] = defs[\\click].metadata[\\poptartDevices][\\slot1][\\index];
score = Score([
    [0.0, ['/d_recv', defs[\\synth].asBytes]],
    [0.0, ['/d_recv', defs[\\sine].asBytes]],
    [0.0, ['/d_recv', defs[\\click].asBytes]],
    [0.0, ['/b_allocRead', 0, ${q(table)}, 0, 0]],
    [0.0, ['/b_allocRead', 1, ${q(ir)}, 0, 0]],
    // 0/1 the Wavetable on the file, cut at the 256 the file declares; 2/3 the same file with no
    // frame length, so cut at 2048 - eight cycles in one frame, three octaves up.
    [0.0, ['/s_new', 'pd_h_synth', 1000, 0, 0, 'out', 0]],
    [0.0, ['/s_new', 'pd_h_synth', 1001, 0, 0, 'out', 2]],
    // 4/5 a drawn curve that turns the signal upside down; 6/7 the same mode with no curve.
    [0.0, ['/s_new', 'pd_h_sine', 1002, 0, 0, 'out', 4]],
    [0.0, ['/s_new', 'pd_h_sine', 1003, 0, 0, 'out', 6]],
    // 8/9 a stereo response, its right side 100 ms late; 10/11 a note off the block edge on the
    // Wavetable, 12/13 one on the FM synth (which places notes inside its own block).
    [0.0, ['/s_new', 'pd_h_click', 1004, 0, 0, 'out', 8]],
    [0.0, ['/s_new', 'pd_h_synth', 1005, 0, 0, 'out', 10]],
    [0.0, ['/s_new', 'pd_h_synth', 1006, 0, 0, 'out', 12]],
    [0.0, ['/u_cmd', 1000, ix[\\synth], '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1001, ix[\\synth], '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1002, ix[\\fx], '/open', 'Distort']],
    [0.0, ['/u_cmd', 1003, ix[\\fx], '/open', 'Distort']],
    [0.0, ['/u_cmd', 1004, ix[\\click], '/open', 'Convolver']],
    [0.0, ['/u_cmd', 1005, ix[\\synth], '/open', 'Wavetable']],
    [0.0, ['/u_cmd', 1006, ix[\\synth], '/open', 'FM']],
    [0.05, ['/u_cmd', 1000, ix[\\synth], '/sample', ${wt.table}, ${wt.slot}, 0, 256]],
    [0.05, ['/u_cmd', 1001, ix[\\synth], '/sample', ${wt.table}, ${wt.slot}, 0, 0]],
    [0.05, ['/u_cmd', 1002, ix[\\fx], '/shape', ${dist.mode}, ${dist.slot}, ${shapePoints}]],
    [0.05, ['/u_cmd', 1004, ix[\\click], '/sample', ${conv.ir}, ${conv.slot}, 1]],
    [0.1, ['/u_cmd', 1000, ix[\\synth], '/set', ${wt.table}, ${wt.position}]],
    [0.1, ['/u_cmd', 1001, ix[\\synth], '/set', ${wt.table}, ${wt.position}]],
    [0.1, ['/u_cmd', 1002, ix[\\fx], '/set', ${dist.mode}, ${dist.position}]],
    [0.1, ['/u_cmd', 1003, ix[\\fx], '/set', ${dist.mode}, ${dist.position}]],
    [0.1, ['/u_cmd', 1004, ix[\\click], '/set', ${convSets}]],
    [0.15, ['/u_cmd', 1000, ix[\\synth], '/noteOn', 45.0, 1.0]],
    [0.15, ['/u_cmd', 1001, ix[\\synth], '/noteOn', 45.0, 1.0]],
    [${NOTE_AT}, ['/u_cmd', 1005, ix[\\synth], '/noteOn', 60.0, 1.0]],
    [${FM_NOTE_AT}, ['/u_cmd', 1006, ix[\\synth], '/noteOn', 60.0, 1.0]],
    [0.6, ['/c_set', 0, 0]],
]);
options = ServerOptions.new.numOutputBusChannels_(14);
options.sampleRate = ${SR};
options.ugenPluginsPath = [Platform.resourceDir +/+ "plugins", ${q(path.dirname(SCX))}];
score.recordNRT(
    ${q(path.join(dir, 'handover.osc'))}, ${q(out)}, nil,
    sampleRate: ${SR}, headerFormat: "WAV", sampleFormat: "float",
    options: options, duration: 0.6,
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

test('a device is handed tables, curves and stereo files, and plays notes on their own sample', (t) => {
  if (!fs.existsSync(SCX)) {
    t.skip('no PoptartDevices.scx in this checkout - run build/devices/native.mjs');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-handover-'));
  const { text, out } = render(dir);
  if (!text.includes('Welcome to SuperCollider')) {
    t.skip(`sclang did not start here: ${text.trim().split('\n').pop() ?? 'no output'}`);
    return;
  }
  if (!text.includes('RENDER-DONE') || !fs.existsSync(out)) {
    t.skip(`scsynth could not render here:\n${text.trim().split('\n').slice(-6).join('\n')}`);
    return;
  }
  const wav = readWavRaw(out);
  assert.ok(wav && wav.channels === 14, `unreadable render: ${JSON.stringify(wav && wav.channels)}`);
  const at = (second) => Math.floor(second * SR);
  const sample = (channel, i) => wav.data[i * wav.channels + channel];
  const rms = (channel, from, to) => {
    let sum = 0;
    for (let i = at(from); i < at(to); i++) sum += sample(channel, i) ** 2;
    return Math.sqrt(sum / (at(to) - at(from)));
  };
  const crossings = (channel, from, to) => {
    let n = 0;
    for (let i = at(from) + 1; i < at(to); i++) if ((sample(channel, i - 1) < 0) !== (sample(channel, i) < 0)) n++;
    return n;
  };

  // A TABLE FROM A FILE, cut at the frame length the file declares. Cut at 2048 instead, one
  // frame is eight of the file's cycles, so the same note comes out three octaves up - which is
  // what the zero crossings count.
  const declared = crossings(0, 0.25, 0.55);
  const undeclared = crossings(2, 0.25, 0.55);
  assert.ok(rms(0, 0.25, 0.55) > 5e-3, `the Wavetable played nothing from its file (rms ${rms(0, 0.25, 0.55).toExponential(2)})`);
  assert.ok(undeclared > declared * 4,
    `the file's declared frame length did not reach the table: ${declared} crossings cut at 256, ${undeclared} at 2048`);

  // A DRAWN CURVE, sent as its points: this one turns the signal upside down, so what comes out
  // runs against the sine that went in. With no curve the mode is a straight clip, which runs with it.
  const correlation = (channel) => {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = at(0.3); i < at(0.5); i++) {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR);
      const y = sample(channel, i);
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xy / Math.sqrt(xx * yy || 1);
  };
  assert.ok(correlation(4) < -0.8, `the drawn curve did not shape the signal (correlation ${correlation(4).toFixed(3)})`);
  assert.ok(correlation(6) > 0.8, `a drawn mode with no curve was not a straight clip (correlation ${correlation(6).toFixed(3)})`);

  // A STEREO RESPONSE, kept stereo: the right side's tap is 100 ms late and the left's is at
  // once, so the click comes back on the right a tenth of a second later and not on the left.
  const lateLeft = rms(8, 0.295, 0.31);
  const lateRight = rms(9, 0.295, 0.31);
  assert.ok(lateRight > 1e-3, `the right side of the response never answered (rms ${lateRight.toExponential(2)})`);
  assert.ok(lateLeft < lateRight * 0.05,
    `the response was summed to mono: the late tap is on the left too (${lateLeft.toExponential(2)} against ${lateRight.toExponential(2)})`);

  // A NOTE ON ITS OWN SAMPLE: scheduled 37 samples into a block, it starts there and not at the
  // block edge before it. The same for the FM synth, which takes the offset itself.
  const onset = (channel) => {
    for (let i = at(0.1); i < at(0.3); i++) if (Math.abs(sample(channel, i)) > 1e-7) return i;
    return -1;
  };
  for (const [channel, when, what] of [[10, NOTE_AT, 'Wavetable'], [12, FM_NOTE_AT, 'FM']]) {
    const want = Math.round(when * SR);
    const got = onset(channel);
    assert.ok(got >= want && got <= want + 2,
      `the ${what} note started at sample ${got}, not at ${want} where it was scheduled (block edge ${want - (want % BLOCK)})`);
  }
});
