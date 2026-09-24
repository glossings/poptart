// The shipped catalog, the reverb behind its descriptor, and the stock-node devices.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEVICES, buildCatalog, catalog, licenseReport } from './src/catalog.mjs';
import { defaultValues, findParam, signalDestinations } from './src/descriptor.mjs';
import { buildPanel } from './src/panel.mjs';
import { IR_NAMES, NODE_DEVICES, buildNodeDevice, positionParam } from './src/devices/builtins.mjs';
import { REVERB, ReverbProcessor } from './src/devices/reverb.mjs';

const SR = 48000;
const rms = (buf) => Math.sqrt(buf.reduce((a, b) => a + b * b, 0) / Math.max(1, buf.length));

test('the catalog resolves every device it ships, by the name userland would type', () => {
  for (const d of DEVICES) {
    assert.equal(catalog.get(d.id)?.id, d.id);
    assert.equal(catalog.get(d.id.toLowerCase())?.id, d.id, 'lookup should ignore case');
  }
  assert.ok(catalog.get('Wavetable'));
  assert.ok(catalog.get('Distort'));
  assert.ok(catalog.get('Reverb'));
  assert.equal(catalog.get('Nonesuch'), null);
});

test('the synths and the effects land on the right side of synth() and fx()', () => {
  assert.deepEqual(catalog.list('synth').map((d) => d.id).sort(), ['Braids', 'Elements', 'FM', 'Granular', 'Peaks', 'Plaits', 'Rings', 'Wavetable']);
  assert.deepEqual(
    catalog.list('fx').map((d) => d.id).sort(),
    [
      'Chorus', 'CloudSeed', 'Clouds', 'Compressor', 'Convolver', 'Crush', 'Delay', 'Distort',
      'Ducker', 'EQ', 'Filter', 'Flanger', 'Galactic', 'GrainEcho', 'Limiter', 'Multiband',
      'Overdrive', 'Phaser', 'Reverb', 'Shift', 'Stutter', 'Vocoder',
    ],
  );
});

test('every shipped device can have a panel generated from it, with no empty sections', () => {
  for (const d of DEVICES) {
    const panel = buildPanel(d, defaultValues(d));
    assert.ok(panel.sections.length > 0, `${d.id} has no controls at all`);
    for (const section of panel.sections) {
      // A section earns its heading with knobs OR with a figure: an envelope whose curve has taken
      // its four knobs over has nothing in `widgets` and is not empty.
      assert.ok(section.widgets.length > 0 || section.figures.length > 0, `${d.id} has an empty section`);
      for (const w of section.widgets) {
        assert.ok(w.name && w.widget, `${d.id} has a widget with nothing to draw`);
        assert.ok(Number.isFinite(w.position) && w.position >= 0 && w.position <= 1, `${d.id}.${w.id} has no knob position`);
        assert.ok(w.text.length > 0, `${d.id}.${w.id} has no readout`);
      }
    }
  }
});

test('every device carries a license, and the report names each one', () => {
  for (const d of DEVICES) assert.ok(d.license, `${d.id} has no license`);
  const report = licenseReport();
  for (const d of DEVICES) assert.ok(report.includes(d.id), `${d.id} is missing from the credits`);
});

test('a second registry is independent of the shipped one', () => {
  const mine = buildCatalog([DEVICES[0]]);
  assert.equal(mine.list().length, 1);
  assert.ok(catalog.list().length > 1, 'building one must not empty the other');
});

test('every device has something a signal can be patched into', () => {
  for (const d of DEVICES) {
    assert.ok(signalDestinations(d).length > 0, `${d.id} has nothing modulatable`);
  }
});

test('the reverb makes a tail that outlives its input and then dies away', () => {
  const fx = new ReverbProcessor(SR, 256);
  const params = { ...defaultValues(REVERB), decay: 2, mix: 1 };
  const block = 128;
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);

  // One block of noise in, then silence.
  for (let i = 0; i < block; i++) { inL[i] = Math.sin(i * 0.3) * 0.5; inR[i] = inL[i]; }
  fx.process([inL, inR], [outL, outR], block, params);

  inL.fill(0);
  inR.fill(0);
  const levels = [];
  for (let b = 0; b < 200; b++) {
    fx.process([inL, inR], [outL, outR], block, params);
    levels.push(rms(outL));
  }
  // The first echo cannot arrive before the predelay plus the shortest delay line has gone by -
  // about two thousand samples, or fifteen blocks - so looking for it immediately finds silence
  // and proves nothing.
  const peakBlock = levels.indexOf(Math.max(...levels));
  assert.ok(peakBlock >= 5, `the tail should build rather than appear at once (peaked at block ${peakBlock})`);
  assert.ok(Math.max(...levels) > 1e-4, 'there should be a tail after the input stops');
  assert.ok(levels[199] < Math.max(...levels) * 0.5, 'and it should decay');
  for (const v of levels) assert.ok(Number.isFinite(v) && v < 4, `the tail ran away: ${v}`);
});

test('a longer decay really does last longer', () => {
  const tail = (decay) => {
    const fx = new ReverbProcessor(SR, 256);
    const params = { ...defaultValues(REVERB), decay, mix: 1 };
    const block = 128;
    const inL = new Float32Array(block).fill(0);
    const outL = new Float32Array(block);
    const outR = new Float32Array(block);
    const hit = new Float32Array(block);
    for (let i = 0; i < block; i++) hit[i] = Math.sin(i * 0.3) * 0.5;
    fx.process([hit, hit], [outL, outR], block, params);
    let energy = 0;
    for (let b = 0; b < 300; b++) {
      fx.process([inL, inL], [outL, outR], block, params);
      energy += rms(outL);
    }
    return energy;
  };
  assert.ok(tail(6) > tail(0.5) * 1.5, 'six seconds of decay should hold far more energy than half a second');
});

test('the reverb is stereo, not one channel played twice', () => {
  const fx = new ReverbProcessor(SR, 256);
  const params = { ...defaultValues(REVERB), mix: 1 };
  const block = 128;
  const hit = new Float32Array(block);
  for (let i = 0; i < block; i++) hit[i] = Math.sin(i * 0.3) * 0.5;
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  fx.process([hit, hit], [outL, outR], block, params);
  const silence = new Float32Array(block);
  let differs = 0;
  for (let b = 0; b < 40; b++) {
    fx.process([silence, silence], [outL, outR], block, params);
    for (let i = 0; i < block; i++) if (Math.abs(outL[i] - outR[i]) > 1e-6) differs++;
  }
  assert.ok(differs > 100, 'the two channels should decorrelate');
});

test('the reverb passes the dry signal through untouched at mix zero', () => {
  const fx = new ReverbProcessor(SR, 256);
  const params = { ...defaultValues(REVERB), mix: 0, output: 0 };
  const block = 128;
  const hit = new Float32Array(block);
  for (let i = 0; i < block; i++) hit[i] = Math.sin(i * 0.3) * 0.5;
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  fx.process([hit, hit], [outL, outR], block, params);
  for (let i = 0; i < block; i++) assert.ok(Math.abs(outL[i] - hit[i]) < 1e-6, `sample ${i} was changed`);
});

test('a mono input is handled rather than read as a missing channel', () => {
  const fx = new ReverbProcessor(SR, 256);
  const block = 128;
  const hit = new Float32Array(block).fill(0.2);
  const out = new Float32Array(block);
  fx.process([hit], [out], block, { ...defaultValues(REVERB), mix: 1 });
  for (const v of out) assert.ok(Number.isFinite(v));
});

// The stock-node device is wired against a stand-in for the browser's audio context. There is
// no Web Audio in node, and booting a browser to check that a convolver convolves would prove
// less than reading the wiring does.
function fakeContext() {
  const created = [];
  const param = (value) => ({ value, _isParam: true });
  const node = (kind, extra = {}) => {
    const n = {
      kind, connections: [],
      connect(target) { n.connections.push(target); return target; },
      disconnect() { n.connections.length = 0; },
      start() { n.started = true; },
      ...extra,
    };
    created.push(n);
    return n;
  };
  return {
    created,
    sampleRate: SR,
    createGain: () => node('gain', { gain: param(1) }),
    createBiquadFilter: () => node('biquad', { type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }),
    createDelay: (max) => node('delay', { maxDelay: max, delayTime: param(0) }),
    createConvolver: () => node('convolver', { buffer: null, normalize: true }),
    createConstantSource: () => node('constant', { offset: param(1) }),
    createWaveShaper: () => node('shaper', { curve: null }),
    createBuffer: (channels, length, sampleRate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c) => data[c] };
    },
  };
}

test('every stock-node device builds, with an input, an output and its params exposed', () => {
  for (const d of NODE_DEVICES) {
    const ctx = fakeContext();
    const built = buildNodeDevice(d, ctx);
    assert.ok(built.input && built.output, `${d.id} has no input or output`);
    assert.equal(typeof built.set, 'function', `${d.id} has no block-rate setter`);
    for (const [id, p] of Object.entries(built.params)) {
      assert.ok(findParam(d, id), `${d.id} exposes "${id}", which its descriptor does not declare`);
      assert.ok(p && p._isParam, `${d.id}.${id} is not an AudioParam, so nothing could be patched into it`);
    }
  }
});

test('a position on a stock node is shaped onto the node\'s own units by the descriptor curve', () => {
  const ctx = fakeContext();
  const d = NODE_DEVICES.find((x) => x.id === 'Convolver');
  const damping = findParam(d, 'damping');
  const native = { value: 20000, _isParam: true };
  positionParam(ctx, damping, native);
  const shaper = ctx.created.find((n) => n.kind === 'shaper');
  assert.ok(shaper.curve, 'a curve was written');
  assert.equal(native.value, 0, 'the node\'s own value is zeroed so the shaped signal is the whole value');
  const at = (t) => shaper.curve[Math.round(((t + 1) / 2) * (shaper.curve.length - 1))];
  assert.ok(Math.abs(at(0) - damping.min) < 1, `position 0 is the minimum, got ${at(0)}`);
  assert.ok(Math.abs(at(1) - damping.max) < 1, `position 1 is the maximum, got ${at(1)}`);
  assert.ok(Math.abs(at(0.5) - Math.sqrt(damping.min * damping.max)) < 5, 'and half way is the geometric middle of an exp curve');
  assert.ok(Math.abs(at(-0.5) - damping.min) < 1, 'below zero clamps to the minimum');
});

test('the convolver ships a synthesized space per option, sized by the size control', () => {
  const ctx = fakeContext();
  const d = NODE_DEVICES.find((x) => x.id === 'Convolver');
  const built = buildNodeDevice(d, ctx);
  const convolver = ctx.created.find((n) => n.kind === 'convolver');
  assert.ok(convolver.buffer, 'a space is loaded from the start');
  const hall = convolver.buffer.length;
  built.set('ir', IR_NAMES.indexOf('room'));
  assert.ok(convolver.buffer.length < hall, 'a room is shorter than a hall');
  built.set('size', 4);
  const long = convolver.buffer.length;
  built.set('size', 1);
  assert.ok(convolver.buffer.length < long, 'and the size control shortens it');
  // A loaded file is used as it is, at the context rate, and the size control leaves it alone.
  const channels = [new Float32Array(1000).fill(0.5)];
  built.loadSample('ir', IR_NAMES.length, { sampleRate: SR * 2, channels });
  built.set('ir', IR_NAMES.length);
  assert.equal(convolver.buffer.length, 500, 'a file at twice the rate is resampled to half its length');
  built.set('size', 6);
  assert.equal(convolver.buffer.length, 500, 'the size control does not touch a loaded file');
});

test('a device that is not built from stock nodes is refused by name', () => {
  assert.throws(() => buildNodeDevice(REVERB, fakeContext()), /not a device built from stock nodes/);
});
