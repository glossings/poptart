'use strict';

// What a native device holds and is handed, through a real scsynth rendered offline
// (test-support/nrt.js) with the installed PoptartDevices.scx. The parity test holds each device's
// DSP to the browser's; what only a server can say is that the UGen's half works:
//
//   - a device keeps every file it is handed until that control and slot are loaded again, and gets
//     them back when an evaluation reopens it; any number of notes for a block land on their sample;
//   - a wavetable is cut from a file at the frame length the file declares, a drawn curve sent as
//     its points shapes the signal, a stereo impulse response stays stereo, and a note scheduled
//     inside a block starts on its own sample (the offset a timestamped unit command carries).
//
// Skipped, not failed, where scsynth or the device extension cannot run.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderNRT, ugen, G } = require('./test-support/nrt');
const synthdef = require('./synthdef');
const U = require('./synthdef/ugens');
const { writeWav, encodeWav } = require('./wav.js');
const { nativeDevice, paramPosition, deviceParam } = require('./native-devices');
const { locateServer } = require('./server/locate');
const { extensionFlags } = require('./server/defs');

const SR = 48000;
const BLOCK = 64;
const { SynthDef, mul, sub, add, ge } = G;
const { Out, K2A, Line, PoptartDevice } = U;
const SinOsc = ugen('SinOsc', [440, 0]);
const f = (v) => ({ type: 'f', value: v });
const flags = extensionFlags(locateServer().extensionsDir);

const index = (id, param) => nativeDevice(id).params.findIndex((p) => p.id === param);
const position = (id, param, value) => paramPosition(nativeDevice(id), param, value);
const firstSpare = (id, param) => deviceParam(nativeDevice(id), param).options.length;

const synthDef = (name) => new SynthDef(name, { out: 0 }, (c) => { Out.ar(c.out, PoptartDevice.ar([], 2, 0, null, 'slot0')); });
// Four samples of full scale at `when`, into an effect slot.
const clickDef = (name, when) => new SynthDef(name, { out: 0 }, (c) => {
  const click = sub(ge(Line.ar(0, 1, when), 1), ge(Line.ar(0, 1, when + 4 / SR), 1));
  const sig = add(K2A.ar(0), click);
  Out.ar(c.out, PoptartDevice.ar([sig, sig], 2, 0, null, 'slot1'));
});
const ixOf = (def, id) => synthdef.defMeta(def).poptartDevices[id];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poptart-dev-nrt-'));

// Response k is a tap at once and a second one (k + 1) * 5 ms later, which tells them apart.
const delayOf = (k) => Math.round(SR * 0.005 * (k + 1));

test('a device keeps every file it is handed, and every note in a block lands on its sample', (t) => {
  if (!flags.nativeDevices) { t.skip("poptart's own devices are not installed"); return; }
  const FILES = 10;
  const NOTES = 100;
  const NOTE_AT = 0.2 + 37 / SR; // 37 samples into a block
  const CLICK_AT = 0.3;
  const dir = tmp();
  try {
    const syn = synthDef('t_g_synth');
    const click = clickDef('t_g_click', CLICK_AT);
    const ix = { synth: ixOf(syn, 'slot0'), fx: ixOf(click, 'slot1') };
    const first = firstSpare('Convolver', 'ir');
    const loads = [];
    for (let k = 0; k < FILES; k++) {
      const file = path.join(dir, `ir${k}.wav`);
      const data = new Float32Array(Math.round(SR * 0.1));
      data[0] = 1;
      data[delayOf(k)] = 0.8;
      writeWav(file, { sampleRate: SR, channels: 1, data });
      loads.push([0, ['/b_allocRead', k, file, 0, 0]]);
      loads.push([0.05, ['/u_cmd', 1001, ix.fx, '/sample', index('Convolver', 'ir'), first + k, k]]);
    }
    const convSets = [
      [index('Convolver', 'ir'), position('Convolver', 'ir', first)], // the FIRST file loaded
      [index('Convolver', 'predelay'), position('Convolver', 'predelay', 0)],
      [index('Convolver', 'lowcut'), position('Convolver', 'lowcut', 10)],
      [index('Convolver', 'damping'), position('Convolver', 'damping', 20000)],
      [index('Convolver', 'mix'), position('Convolver', 'mix', 1)],
    ].flatMap(([i, p]) => [i, f(p)]);
    const r = renderNRT([
      [0, ['/d_recv', syn]],
      [0, ['/d_recv', click]],
      [0, ['/s_new', 't_g_synth', 1000, 0, 0, 'out', 0]],
      [0, ['/s_new', 't_g_click', 1001, 0, 0, 'out', 2]],
      [0, ['/u_cmd', 1000, ix.synth, '/open', 'Wavetable']],
      [0, ['/u_cmd', 1001, ix.fx, '/open', 'Convolver']],
      ...loads,
      // An evaluation reopens every slot in the chain: the device is handed back what it holds.
      [0.08, ['/u_cmd', 1001, ix.fx, '/open', 'Convolver']],
      [0.1, ['/u_cmd', 1001, ix.fx, '/set', ...convSets]],
      ...Array.from({ length: NOTES }, (_, i) => [NOTE_AT, ['/u_cmd', 1000, ix.synth, '/noteOn', f(40 + (i % 40)), f(1)]]),
    ], { duration: 0.5, outChannels: 4 });
    if (!r.data) { t.skip(r.why); return; }
    const onsetSample = Math.round(NOTE_AT * SR);
    let early = 0;
    for (let i = onsetSample - 37; i < onsetSample; i++) early = Math.max(early, Math.abs(r.at(0, i)));
    let after = 0;
    for (let i = onsetSample; i < onsetSample + 2400; i++) after = Math.max(after, Math.abs(r.at(0, i)));
    assert.ok(after > 1e-3, `the notes never sounded (peak ${after.toExponential(2)})`);
    assert.strictEqual(early, 0, `a note sounded before its sample (peak ${early.toExponential(2)})`);
    // Ten responses loaded, the first one chosen: its tap is the one that answers the click.
    const clickAt = Math.round(CLICK_AT * SR);
    let peakAt = -1;
    let peak = 0;
    for (let i = clickAt + 48; i < clickAt + Math.round(SR * 0.08); i++) {
      const v = Math.abs(r.at(2, i));
      if (v > peak) { peak = v; peakAt = i; }
    }
    assert.ok(peak > 1e-3, `the convolver never answered (peak ${peak.toExponential(2)})`);
    const late = peakAt - clickAt;
    assert.ok(Math.abs(late - delayOf(0)) <= 8, `the first file's second tap is ${delayOf(0)} samples late; the answer came ${late} late - an earlier file was let go`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A WAV with a `clm ` chunk declaring its frame length, the way wavetable editors write one. */
function writeTableWav(file, frames, length) {
  const data = new Float32Array(frames * length);
  for (let fr = 0; fr < frames; fr++) {
    for (let i = 0; i < length; i++) {
      let v = 0;
      for (let k = 1; k <= 1 + fr * 2; k++) v += Math.sin((2 * Math.PI * k * i) / length) / k;
      data[fr * length + i] = v * 0.5;
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
  data[0] = 1;
  data[Math.round(SR * 0.1) * 2 + 1] = 1;
  writeWav(file, { sampleRate: SR, channels: 2, data });
}

test('a device is handed tables, curves and stereo files, and plays notes on their own sample', (t) => {
  if (!flags.nativeDevices) { t.skip("poptart's own devices are not installed"); return; }
  const NOTE_AT = 0.2 + 37 / SR;
  const FM_NOTE_AT = 0.2 + 91 / SR;
  const dir = tmp();
  try {
    const table = path.join(dir, 'table.wav');
    const ir = path.join(dir, 'ir.wav');
    writeTableWav(table, 8, 256);
    writeStereoIr(ir);
    const syn = synthDef('t_h_synth');
    const sine = new SynthDef('t_h_sine', { out: 0 }, (c) => {
      const s = mul(SinOsc.ar(220), 0.4);
      Out.ar(c.out, PoptartDevice.ar([s, s], 2, 0, null, 'slot1'));
    });
    const click = clickDef('t_h_click', 0.2);
    const ix = { synth: ixOf(syn, 'slot0'), fx: ixOf(sine, 'slot1'), click: ixOf(click, 'slot1') };
    const shapePoints = Array.from({ length: 256 }, (_, i) => f(Number((1 - i / 255).toFixed(6))));
    const wt = { table: index('Wavetable', 'osc1.table'), slot: firstSpare('Wavetable', 'osc1.table') };
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
    ].flatMap(([i, p]) => [i, f(p)]);
    const r = renderNRT([
      [0, ['/d_recv', syn]],
      [0, ['/d_recv', sine]],
      [0, ['/d_recv', click]],
      [0, ['/b_allocRead', 0, table, 0, 0]],
      [0, ['/b_allocRead', 1, ir, 0, 0]],
      // 0/1 the Wavetable cut at the 256 the file declares; 2/3 the same file with no frame length.
      [0, ['/s_new', 't_h_synth', 1000, 0, 0, 'out', 0]],
      [0, ['/s_new', 't_h_synth', 1001, 0, 0, 'out', 2]],
      // 4/5 a drawn curve that turns the signal upside down; 6/7 the same mode with no curve.
      [0, ['/s_new', 't_h_sine', 1002, 0, 0, 'out', 4]],
      [0, ['/s_new', 't_h_sine', 1003, 0, 0, 'out', 6]],
      // 8/9 a stereo response; 10/11 a note off the block edge on the Wavetable, 12/13 on the FM synth.
      [0, ['/s_new', 't_h_click', 1004, 0, 0, 'out', 8]],
      [0, ['/s_new', 't_h_synth', 1005, 0, 0, 'out', 10]],
      [0, ['/s_new', 't_h_synth', 1006, 0, 0, 'out', 12]],
      [0, ['/u_cmd', 1000, ix.synth, '/open', 'Wavetable']],
      [0, ['/u_cmd', 1001, ix.synth, '/open', 'Wavetable']],
      [0, ['/u_cmd', 1002, ix.fx, '/open', 'Distort']],
      [0, ['/u_cmd', 1003, ix.fx, '/open', 'Distort']],
      [0, ['/u_cmd', 1004, ix.click, '/open', 'Convolver']],
      [0, ['/u_cmd', 1005, ix.synth, '/open', 'Wavetable']],
      [0, ['/u_cmd', 1006, ix.synth, '/open', 'FM']],
      [0.05, ['/u_cmd', 1000, ix.synth, '/sample', wt.table, wt.slot, 0, 256]],
      [0.05, ['/u_cmd', 1001, ix.synth, '/sample', wt.table, wt.slot, 0, 0]],
      [0.05, ['/u_cmd', 1002, ix.fx, '/shape', dist.mode, dist.slot, ...shapePoints]],
      [0.05, ['/u_cmd', 1004, ix.click, '/sample', conv.ir, conv.slot, 1]],
      [0.1, ['/u_cmd', 1000, ix.synth, '/set', wt.table, f(wt.position)]],
      [0.1, ['/u_cmd', 1001, ix.synth, '/set', wt.table, f(wt.position)]],
      [0.1, ['/u_cmd', 1002, ix.fx, '/set', dist.mode, f(dist.position)]],
      [0.1, ['/u_cmd', 1003, ix.fx, '/set', dist.mode, f(dist.position)]],
      [0.1, ['/u_cmd', 1004, ix.click, '/set', ...convSets]],
      [0.15, ['/u_cmd', 1000, ix.synth, '/noteOn', f(45), f(1)]],
      [0.15, ['/u_cmd', 1001, ix.synth, '/noteOn', f(45), f(1)]],
      [NOTE_AT, ['/u_cmd', 1005, ix.synth, '/noteOn', f(60), f(1)]],
      [FM_NOTE_AT, ['/u_cmd', 1006, ix.synth, '/noteOn', f(60), f(1)]],
    ], { duration: 0.6, outChannels: 14 });
    if (!r.data) { t.skip(r.why); return; }
    const at = (second) => Math.floor(second * SR);
    const sample = (ch, i) => r.at(ch, i);
    const rms = (ch, from, to) => {
      let sum = 0;
      for (let i = at(from); i < at(to); i++) sum += sample(ch, i) ** 2;
      return Math.sqrt(sum / (at(to) - at(from)));
    };
    const crossings = (ch, from, to) => {
      let n = 0;
      for (let i = at(from) + 1; i < at(to); i++) if ((sample(ch, i - 1) < 0) !== (sample(ch, i) < 0)) n++;
      return n;
    };
    // A table from a file, cut at its declared length; cut at 2048 instead it plays three octaves up.
    const declared = crossings(0, 0.25, 0.55);
    const undeclared = crossings(2, 0.25, 0.55);
    assert.ok(rms(0, 0.25, 0.55) > 5e-3, `the Wavetable played nothing from its file (rms ${rms(0, 0.25, 0.55).toExponential(2)})`);
    assert.ok(undeclared > declared * 4, `the file's declared frame length did not reach the table: ${declared} at 256, ${undeclared} at 2048`);
    // A drawn curve turns the signal upside down; with no curve the mode is a straight clip.
    const correlation = (ch) => {
      let xy = 0; let xx = 0; let yy = 0;
      for (let i = at(0.3); i < at(0.5); i++) {
        const x = Math.sin((2 * Math.PI * 220 * i) / SR);
        const y = sample(ch, i);
        xy += x * y; xx += x * x; yy += y * y;
      }
      return xy / Math.sqrt(xx * yy || 1);
    };
    assert.ok(correlation(4) < -0.8, `the drawn curve did not shape the signal (correlation ${correlation(4).toFixed(3)})`);
    assert.ok(correlation(6) > 0.8, `a drawn mode with no curve was not a straight clip (correlation ${correlation(6).toFixed(3)})`);
    // A stereo response kept stereo: the click comes back on the right 100 ms later, not on the left.
    const lateLeft = rms(8, 0.295, 0.31);
    const lateRight = rms(9, 0.295, 0.31);
    assert.ok(lateRight > 1e-3, `the right side of the response never answered (rms ${lateRight.toExponential(2)})`);
    assert.ok(lateLeft < lateRight * 0.05, `the response was summed to mono (${lateLeft.toExponential(2)} against ${lateRight.toExponential(2)})`);
    // A note on its own sample, for the Wavetable and the FM synth (which takes the offset itself).
    const onset = (ch) => {
      for (let i = at(0.1); i < at(0.3); i++) if (Math.abs(sample(ch, i)) > 1e-7) return i;
      return -1;
    };
    for (const [ch, when, what] of [[10, NOTE_AT, 'Wavetable'], [12, FM_NOTE_AT, 'FM']]) {
      const want = Math.round(when * SR);
      const got = onset(ch);
      assert.ok(got >= want && got <= want + 2,
        `the ${what} note started at sample ${got}, not at ${want} (block edge ${want - (want % BLOCK)})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
