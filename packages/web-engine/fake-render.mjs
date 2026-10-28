// Renders a fake audio graph (fake-context.mjs) offline, for the stock nodes a track's wiring is
// built from: gains, constants, wave shapers, biquads, channel splitters and mergers.
//
// The fake context records which node feeds which; this reads that record back and computes what
// the browser would, by the Web Audio spec's own formulas - a biquad's coefficients from its
// frequency and its Q in decibels, a shaper's curve read by linear interpolation, an AudioParam as
// its value plus everything connected into it. It is how the branches and the crossovers of a
// routing plan are checked for what they SOUND like, here and against the desktop's renders,
// without a browser. A worklet node is rendered by the processor a test hands in for it
// (`devices`, by processor name), block by block as a browser would run it.

import { FakeNode, FakeParam } from './fake-context.mjs';
import { denormalize } from './src/descriptor.mjs';

const QUANTUM = 128;

const upmix = (sig, channels) => {
  if (sig.length === channels) return sig;
  if (sig.length === 1) return Array.from({ length: channels }, () => sig[0]);
  // Stereo into a mono input is (L + R) / 2, the spec's speaker down-mix.
  const mono = new Float64Array(sig[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = (sig[0][i] + sig[1][i]) / 2;
  return [mono];
};

/**
 * Renders `frames` samples out of `node`. `inject` maps a node to the signal it outputs instead of
 * computing one - an array of channels - which is how a test feeds the chain.
 */
export function renderFake(ctx, node, { frames, inject = new Map(), output = 0, devices = {} }) {
  const sr = ctx.sampleRate;
  // Who feeds each node's inputs: target -> [{ from, output, input }].
  const inbound = new Map();
  for (const from of ctx.created) {
    // `links` keeps every connect ever made and `outputs` what a disconnect left standing, so the
    // newest links are the live ones, as many of each as `outputs` still holds.
    const standing = new Map();
    for (const t of from.outputs) standing.set(t, (standing.get(t) ?? 0) + 1);
    for (const link of [...(from.links ?? [])].reverse()) {
      if (!(link.target instanceof FakeNode)) continue;
      const left = standing.get(link.target) ?? 0;
      if (!left) continue;
      standing.set(link.target, left - 1);
      if (!inbound.has(link.target)) inbound.set(link.target, []);
      inbound.get(link.target).push({ from, output: link.output, input: link.input });
    }
  }
  const memo = new Map();
  const zeros = () => new Float64Array(frames);

  const outOf = (n, index = 0) => {
    const key = `${n.id}:${index}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, [zeros()]); // a cycle reads silence rather than recursing for ever
    const v = compute(n, index);
    memo.set(key, v);
    return v;
  };

  // What arrives at input `which` of a node, mixed to the widest channel count among its sources.
  const inputOf = (n, which = 0, explicit = null) => {
    const links = (inbound.get(n) ?? []).filter((l) => l.input === which);
    const parts = links.map((l) => outOf(l.from, l.output));
    const width = explicit ?? Math.max(1, ...parts.map((p) => p.length));
    const mixed = Array.from({ length: width }, zeros);
    for (const p of parts) {
      const up = upmix(p, width);
      for (let c = 0; c < width; c++) for (let i = 0; i < frames; i++) mixed[c][i] += up[c][i];
    }
    return mixed;
  };

  // An AudioParam over time: its value plus every node connected into it (as mono).
  const paramOf = (param) => {
    const v = new Float64Array(frames).fill(param.value);
    for (const from of param.connectedFrom) {
      const sig = upmix(outOf(from), 1)[0];
      for (let i = 0; i < frames; i++) v[i] += sig[i];
    }
    return v;
  };

  const compute = (n, index) => {
    if (inject.has(n)) return inject.get(n).map((ch) => Float64Array.from(ch));
    switch (n.kind) {
      case 'gain': {
        const explicit = n.channelCountMode === 'explicit' ? n.channelCount : null;
        const x = inputOf(n, 0, explicit);
        const g = paramOf(n.gain);
        return x.map((ch) => ch.map((s, i) => s * g[i]));
      }
      case 'constant': return [paramOf(n.offset)];
      case 'shaper': {
        const x = inputOf(n);
        const curve = n.curve;
        return x.map((ch) => ch.map((s) => {
          const pos = ((curve.length - 1) * (Math.max(-1, Math.min(1, s)) + 1)) / 2;
          const k = Math.min(curve.length - 2, Math.floor(pos));
          const f = pos - k;
          return curve[k] * (1 - f) + curve[k + 1] * f;
        }));
      }
      case 'splitter': {
        const x = inputOf(n, 0);
        return [x[index] ?? zeros()];
      }
      case 'merger': {
        return Array.from({ length: n.channels }, (_, c) => upmix(inputOf(n, c), 1)[0]);
      }
      case 'biquad': return biquad(n, inputOf(n), paramOf(n.frequency), paramOf(n.Q), sr);
      case 'worklet': return worklet(n)[index] ?? [zeros(), zeros()];
      default:
        throw new Error(`renderFake cannot render a ${n.kind} node`);
    }
  };

  // A worklet's every output at once, by its processor: the inputs and the controls (positions,
  // turned into real units by the descriptor, one value for a block nothing moves in) a quantum at
  // a time.
  const rendered = new Map();
  const worklet = (n) => {
    if (rendered.has(n)) return rendered.get(n);
    const device = devices[n.processorName];
    if (!device) throw new Error(`renderFake has no processor for ${n.processorName}`);
    const impl = device.make(sr);
    const ins = Array.from({ length: n.options.numberOfInputs ?? 1 }, (_, k) => inputOf(n, k, 2));
    const keyed = (inbound.get(n) ?? []).some((l) => l.input === 1);
    const outs = Array.from({ length: n.options.numberOfOutputs ?? 1 }, () => [zeros(), zeros()]);
    const params = Object.fromEntries(device.descriptor.params.map((p) => [p.id, n.parameters.get(p.id) ? paramOf(n.parameters.get(p.id)) : null]));
    for (let at = 0; at < frames; at += QUANTUM) {
      const count = Math.min(QUANTUM, frames - at);
      const piece = (ch) => ch.subarray(at, at + count);
      const real = {};
      for (const p of device.descriptor.params) {
        const pos = params[p.id];
        if (!pos) { real[p.id] = p.default; continue; }
        const block = Array.from(pos.subarray(at, at + count), (v) => denormalize(p, Math.min(1, Math.max(0, v))));
        real[p.id] = block.every((v) => v === block[0]) ? [block[0]] : Float64Array.from(block);
      }
      const block = outs.map((o) => o.map((ch) => new Float64Array(count)));
      impl.process(ins[0].map(piece), block[0], count, real, keyed ? ins[1].map(piece) : null, at / sr, block.length > 1 ? block.slice(1) : null);
      block.forEach((o, k) => o.forEach((ch, c) => outs[k][c].set(ch, at)));
    }
    rendered.set(n, outs);
    return outs;
  };

  return outOf(node, output);
}

// The spec's lowpass and highpass (Audio EQ Cookbook, Q in dB), coefficients per sample.
function biquad(n, x, freq, qDb, sr) {
  if (n.type !== 'lowpass' && n.type !== 'highpass') throw new Error(`renderFake has no ${n.type} biquad`);
  return x.map((ch) => {
    const y = new Float64Array(ch.length);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let i = 0; i < ch.length; i++) {
      const f0 = Math.min(sr / 2, Math.max(0, freq[i]));
      const w0 = (2 * Math.PI * f0) / sr;
      const alpha = Math.sin(w0) / (2 * 10 ** (qDb[i] / 20));
      const cos = Math.cos(w0);
      const a0 = 1 + alpha;
      const [b0, b1, b2] = n.type === 'lowpass'
        ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
        : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      const out = (b0 * ch[i] + b1 * x1 + b2 * x2 - (-2 * cos) * y1 - (1 - alpha) * y2) / a0;
      x2 = x1; x1 = ch[i]; y2 = y1; y1 = out;
      y[i] = out;
    }
    return y;
  });
}

export { FakeParam };
