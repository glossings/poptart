// Devices built from stock Web Audio nodes.
//
// Only one is left: the convolution reverb, because the browser's convolver is native, fast and
// partitioned, and a JavaScript one in a worklet would be none of those over a four-second
// impulse. Everything else poptart writes itself in a worklet, where a control can be read per
// sample and every device speaks the same parameter contract.
//
// That contract is the one thing a stock node does not speak: its parameters are in seconds
// and Hz, and every poptart parameter is a 0..1 position. So each continuous control here is a
// constant source carrying the position, shaped onto the node's own units by a wave shaper whose
// curve is the descriptor's own mapping - which is what lets a position be ramped, patched and
// modulated on a stock node exactly as on a worklet.

import { defineDevice, denormalize } from '../descriptor.mjs';
import { dbToGain } from '../dsp/control.mjs';
import { outlineOf } from '../dsp/outline.mjs';

/** The built-in impulse responses, synthesized when the device is built. */
export const IR_NAMES = Object.freeze(['room', 'hall', 'plate', 'chamber', 'cathedral']);

/** How many impulse slots the device has: the synthesized ones and room for loaded files. */
const IR_SLOTS = 32;

export const CONVOLVER = defineDevice({
  id: 'Convolver',
  kind: 'fx',
  version: 1,
  license: 'AGPL-3.0-only',
  build: 'nodes',
  description: 'A convolution reverb: five synthesized spaces, or any sample as the impulse response.',
  params: [
    { id: 'ir', name: 'Impulse', default: 1, options: [...IR_NAMES], capacity: IR_SLOTS, takes: 'sample', rate: 'k', group: 'Space',
      description: 'The space. Name a sample to convolve with that file instead.' },
    { id: 'size', name: 'Size', min: 0.3, max: 6, default: 2, unit: 's', curve: 'exp', rate: 'k', group: 'Space',
      description: 'The decay of a synthesized space. A loaded file has its own length and ignores this.' },
    { id: 'predelay', name: 'Predelay', min: 0, max: 0.25, default: 0.01, unit: 's', group: 'Space' },
    { id: 'damping', name: 'Damping', min: 500, max: 20000, default: 6000, unit: 'Hz', curve: 'exp', group: 'Tone',
      description: 'A lowpass on the wet signal.' },
    { id: 'lowcut', name: 'Low Cut', min: 10, max: 2000, default: 100, unit: 'Hz', curve: 'exp', group: 'Tone' },
    { id: 'mix', name: 'Mix', min: 0, max: 1, default: 0.3, group: 'Tone' },
    { id: 'output', name: 'Output', min: -24, max: 24, default: 0, unit: 'dB', group: 'Tone' },
  ],
  figures: [
    {
      id: 'impulse',
      kind: 'sample',
      group: 'Space',
      title: 'impulse',
      description: 'The impulse response being convolved with - a synthesized space, or the file you pointed it at.',
      params: { sample: 'ir', position: 'predelay' },
      subsumes: ['sample'],
    },
  ],
});

export const NODE_DEVICES = Object.freeze([CONVOLVER]);

/** Points on a shaping curve: enough that a log sweep is smooth between them. */
const CURVE_POINTS = 4097;

/**
 * A 0..1 position as an AudioParam on a stock node: a constant source whose offset is the
 * position, through a shaper whose curve is the descriptor's mapping, into the node's own param.
 * The node's own value is zeroed so the shaped signal is the whole value. Returns the offset,
 * which is what the engine ramps, patches into and modulates.
 */
export function positionParam(ctx, param, nativeParam, scale = 1) {
  const source = ctx.createConstantSource();
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(CURVE_POINTS);
  for (let k = 0; k < CURVE_POINTS; k++) {
    const x = (k / (CURVE_POINTS - 1)) * 2 - 1;
    curve[k] = denormalize(param, Math.max(0, x)) * scale;
  }
  shaper.curve = curve;
  source.offset.value = 0;
  source.connect(shaper);
  shaper.connect(nativeParam);
  try { nativeParam.value = 0; } catch { /* a param that refuses a direct set */ }
  source.start();
  return source.offset;
}

/**
 * A synthesized impulse response: noise falling away exponentially, its top rolling off as it
 * goes, with an early cluster of reflections in front. Each space is a set of those numbers.
 */
export function synthesizeImpulse(ctx, name, seconds) {
  const sr = ctx.sampleRate;
  const shapes = {
    room: { early: 0.02, tail: 0.6, bright: 0.5, diffuse: 0.9 },
    hall: { early: 0.05, tail: 1.6, bright: 0.35, diffuse: 1 },
    plate: { early: 0.002, tail: 1, bright: 0.8, diffuse: 1 },
    chamber: { early: 0.03, tail: 0.9, bright: 0.45, diffuse: 0.7 },
    cathedral: { early: 0.09, tail: 2.6, bright: 0.25, diffuse: 1 },
  };
  const shape = shapes[name] ?? shapes.hall;
  const length = Math.max(1, Math.round(sr * Math.max(0.1, seconds * shape.tail)));
  const buffer = ctx.createBuffer(2, length, sr);
  let seed = 0x1234567 + IR_NAMES.indexOf(name) * 977;
  const random = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 2147483648 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    const earlyEnd = Math.round(shape.early * sr);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // The tail's brightness falls with time: the lowpass tightens as the decay goes on.
      const cutoff = shape.bright * (1 - 0.8 * t) + 0.02;
      lp += (random() - lp) * cutoff;
      const env = Math.exp(-6.9 * t);
      let v = lp * env * shape.diffuse;
      // A few discrete early reflections, denser in a small room.
      if (i < earlyEnd && (i % Math.max(1, Math.round(earlyEnd / 12))) === 0) v += random() * 0.5 * (1 - i / earlyEnd);
      data[i] = v;
    }
  }
  return buffer;
}

/** The channels of a loaded file as a buffer at the context's rate, resampled if it must be. */
function bufferFromChannels(ctx, { sampleRate, channels }) {
  const ratio = sampleRate / ctx.sampleRate;
  const length = Math.max(1, Math.round(channels[0].length / ratio));
  const buffer = ctx.createBuffer(Math.min(2, channels.length), length, ctx.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = channels[ch];
    const dst = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const x = i * ratio;
      const j = Math.min(src.length - 1, Math.floor(x));
      const k = Math.min(src.length - 1, j + 1);
      dst[i] = src[j] + (src[k] - src[j]) * (x - j);
    }
  }
  return buffer;
}

/**
 * Builds the node graph for one of the devices above.
 *
 * Returns `{ input, output, params, set, loadSample }`. `params` maps a descriptor parameter
 * id to the AudioParam that carries its position; the ones that are not continuous (an enum, a
 * dB value the browser wants as a linear gain) go through `set`, which is called with real
 * values at block rate.
 */
export function buildNodeDevice(descriptor, ctx) {
  switch (descriptor.id) {
    case 'Convolver': {
      const byId = Object.fromEntries(descriptor.params.map((p) => [p.id, p]));
      const input = ctx.createGain();
      const output = ctx.createGain();
      const predelay = ctx.createDelay(0.3);
      const convolver = ctx.createConvolver();
      const lowcut = ctx.createBiquadFilter();
      const damping = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      const dry = ctx.createGain();
      lowcut.type = 'highpass';
      damping.type = 'lowpass';
      convolver.normalize = true;
      input.connect(dry).connect(output);
      input.connect(predelay).connect(convolver).connect(lowcut).connect(damping).connect(wet).connect(output);
      wet.gain.value = 0;
      dry.gain.value = 1;
      const loaded = new Map();      // option index -> AudioBuffer
      // What the panel draws the impulse as. A loaded file's outline is kept by the engine; a
      // SYNTHESIZED one exists nowhere else, so it is taken here as it is built - otherwise the
      // one control this device is about would be the one with no picture.
      const outlines = {};
      let current = { index: byId.ir.default, size: byId.size.default };
      const choose = () => {
        const held = loaded.get(current.index);
        const buffer = held ?? synthesizeImpulse(ctx, IR_NAMES[current.index] ?? 'hall', current.size);
        convolver.buffer = buffer;
        if (!held) {
          outlines[current.index] = {
            name: IR_NAMES[current.index] ?? 'hall',
            ...outlineOf(buffer.getChannelData ? buffer.getChannelData(0) : null, buffer.sampleRate),
          };
        }
      };
      choose();
      return {
        input,
        output,
        node: null,
        outlines,
        params: {
          predelay: positionParam(ctx, byId.predelay, predelay.delayTime),
          damping: positionParam(ctx, byId.damping, damping.frequency),
          lowcut: positionParam(ctx, byId.lowcut, lowcut.frequency),
          mix: positionParam(ctx, byId.mix, wet.gain),
        },
        set(id, value) {
          if (id === 'ir') { current.index = Math.round(value); choose(); }
          if (id === 'size') { current.size = value; if (!loaded.has(current.index)) choose(); }
          if (id === 'output') output.gain.value = dbToGain(value);
        },
        loadSample(id, index, payload) {
          if (id !== 'ir' || !payload?.channels?.length) return;
          loaded.set(index, bufferFromChannels(ctx, payload));
          if (current.index === index) choose();
        },
        dispose() {
          try { input.disconnect(); output.disconnect(); } catch { /* already detached */ }
        },
      };
    }

    default:
      throw new Error(`[web-engine] "${descriptor.id}" is not a device built from stock nodes`);
  }
}
