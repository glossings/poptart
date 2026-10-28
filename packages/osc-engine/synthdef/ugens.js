'use strict';

// The UGen classes poptart's defs use, each with sclang's argument order, defaults and input
// layout (SCClassLibrary/Common/Audio of SuperCollider 3.14, plus the VSTPlugin and poptart
// extension classes).

const G = require('./graph.js');
const {
  UGen, PureUGen, MultiOutUGen, PureMultiOutUGen, WidthFirstUGen, NoOutUGen, OutputProxy, Ref,
  rateOf, isNum, mul, building,
} = G;

const sel = (rate) => (rate === 'audio' ? 'ar' : rate === 'control' ? 'kr' : rate === 'scalar' ? 'ir' : 'new');

// A plain UGen class with .ar/.kr(/.ir) taking `names` with their defaults.
function simple(name, base, defaults, rates = ['ar', 'kr']) {
  const C = { [name]: class extends base {} }[name];
  for (const r of rates) {
    const rate = r === 'ar' ? 'audio' : r === 'kr' ? 'control' : 'scalar';
    C[r] = (...args) => C.multiNew(rate, ...defaults.map((d, i) => (args[i] === undefined ? d : args[i])));
  }
  return C;
}

// A MultiOutUGen whose first argument is its channel count.
function channelsFirst(name, base, defaults, rates = ['ar', 'kr']) {
  const C = {
    [name]: class extends base {
      init(n, ...inputs) {
        this.inputs = inputs;
        return this.initOutputs(n, this.rate);
      }
    },
  }[name];
  for (const r of rates) {
    const rate = r === 'ar' ? 'audio' : 'control';
    C[r] = (n, ...args) => C.multiNew(rate, n, ...defaults.map((d, i) => (args[i] === undefined ? d : args[i])));
  }
  return C;
}

class Filter extends PureUGen {}

const Impulse = simple('Impulse', PureUGen, [440, 0]);
const Sweep = simple('Sweep', UGen, [0, 1]);
const Phasor = simple('Phasor', UGen, [0, 1, 0, 1, 0]);
const LFDNoise0 = simple('LFDNoise0', UGen, [500]);
const LFDNoise3 = simple('LFDNoise3', UGen, [500]);
const Latch = simple('Latch', UGen, [0, 0]);
const Gate = simple('Gate', UGen, [0, 0]);
const Trig1 = simple('Trig1', UGen, [0, 0.1]);
const PulseCount = simple('PulseCount', UGen, [0, 0]);
const ToggleFF = simple('ToggleFF', UGen, [0]);
const Peak = simple('Peak', UGen, [0, 0]);
const RunningMax = simple('RunningMax', UGen, [0, 0]);
const RunningSum = simple('RunningSum', UGen, [undefined, 40]);
const OnePole = simple('OnePole', Filter, [0, 0.5]);
const LPF = simple('LPF', Filter, [0, 440]);
const HPF = simple('HPF', Filter, [0, 440]);
const RLPF = simple('RLPF', Filter, [0, 440, 1]);
const RHPF = simple('RHPF', Filter, [0, 440, 1]);
const BPF = simple('BPF', Filter, [0, 440, 1]);
const Line = simple('Line', UGen, [0, 1, 1, 0]); // start, end, dur, doneAction
const K2A = simple('K2A', PureUGen, [0], ['ar']);
const A2K = simple('A2K', PureUGen, [0], ['kr']);
const Convolution2 = simple('Convolution2', UGen, [undefined, undefined, 0, 2048], ['ar']);
const Clip = simple('Clip', UGen, [0, 0, 1], ['ar', 'kr', 'ir']);
const Wrap = simple('Wrap', UGen, [0, 0, 1], ['ar', 'kr', 'ir']);

const Delay1 = { [Symbol.toStringTag]: 'Delay1' };
class Delay1U extends Filter {
  static get scName() { return 'Delay1'; }
}
Delay1.ar = (input = 0, x1 = 0) => Delay1U.multiNew('audio', input, x1);
Delay1.kr = (input = 0, x1 = input) => Delay1U.multiNew('control', input, x1);

class DelayNU extends PureUGen {
  static get scName() { return 'DelayN'; }
}
function asAudioRateInput(x) {
  if (Array.isArray(x)) return x.map(asAudioRateInput);
  if (isNum(x)) return x === 0 ? Silent.ar() : DC.ar(x);
  return rateOf(x) !== 'audio' ? K2A.ar(x) : x;
}
const DelayN = {
  ar: (input = 0, maxdelay = 0.2, delay = 0.2) => DelayNU.multiNew('audio', asAudioRateInput(input), maxdelay, delay),
  kr: (input = 0, maxdelay = 0.2, delay = 0.2) => DelayNU.multiNew('control', input, maxdelay, delay),
};

// Lag/Ramp: the class methods skip a scalar or zero-time lag; UGen:lag does not.
function lagClass(name) {
  const C = { [name]: class extends Filter {} }[name];
  const make = (rate) => (input = 0, time = 0.1) => {
    if (rateOf(input) === 'scalar' || time === 0) return input;
    return C.multiNew(rate, input, time);
  };
  C.ar = make('audio');
  C.kr = make('control');
  return C;
}
const Lag = lagClass('Lag');
const Ramp = lagClass('Ramp');

class Select extends PureUGen {
  static ar(which, array) { return this.multiNewList(['audio', which, ...array]); }
  static kr(which, array) { return this.multiNewList(['control', which, ...array]); }
}

class InfoUGenBase extends UGen {
  static ir() { return this.multiNew('scalar'); }
}
const info = (name) => ({ [name]: class extends InfoUGenBase {} })[name];
const SampleRate = info('SampleRate');
const SampleDur = info('SampleDur');
const ControlRate = info('ControlRate');
const ControlDur = info('ControlDur');
const BlockSize = info('BlockSize');
const NumOutputBuses = info('NumOutputBuses');

class BufInfoUGenBase extends UGen {
  static kr(buf) { return this.multiNew('control', buf); }
  static ir(buf) { return this.multiNew('scalar', buf); }
}
const bufInfo = (name) => ({ [name]: class extends BufInfoUGenBase {} })[name];
const BufFrames = bufInfo('BufFrames');
const BufRateScale = bufInfo('BufRateScale');
const BufSampleRate = bufInfo('BufSampleRate');

const PlayBuf = channelsFirst('PlayBuf', MultiOutUGen, [0, 1, 1, 0, 0, 0]);
const BufRd = channelsFirst('BufRd', MultiOutUGen, [0, 0, 1, 2]);
const Warp1 = channelsFirst('Warp1', MultiOutUGen, [0, 0, 1, 0.2, -1, 8, 0, 1], ['ar']);
const GrainBuf = channelsFirst('GrainBuf', MultiOutUGen, [0, 1, undefined, 1, 0, 2, 0, -1, 512], ['ar']);

class DC extends PureMultiOutUGen {
  static ar(x = 0) { return this.multiNew('audio', x); }
  static kr(x = 0) { return this.multiNew('control', x); }
  init(...inputs) {
    this.inputs = inputs;
    return this.initOutputs(inputs.length, this.rate);
  }
}

const Silent = {
  ar(n = 1) {
    const sig = DC.ar(0);
    return n === 1 ? sig : Array.from({ length: n }, () => sig);
  },
};

class In extends MultiOutUGen {
  static ar(bus = 0, n = 1) { return this.multiNew('audio', n, bus); }
  static kr(bus = 0, n = 1) { return this.multiNew('control', n, bus); }
  init(n, ...bus) {
    this.inputs = bus;
    return this.initOutputs(n, this.rate);
  }
}
class InFeedback extends In {
  static kr() { throw new Error('InFeedback.kr does not exist'); }
}
class LocalIn extends MultiOutUGen {
  static ar(n = 1, def = 0) { return this.multiNew('audio', n, ...(Array.isArray(def) ? def : [def])); }
  init(n, ...def) {
    this.inputs = Array.from({ length: n }, (_, i) => def[i % def.length]);
    return this.initOutputs(n, this.rate);
  }
}

// UGen:replaceZeroesWithSilence
function replaceZeroesWithSilence(array) {
  const zeros = array.filter((x) => x === 0).length;
  if (zeros === 0) return array;
  const silent = [].concat(Silent.ar(zeros));
  let pos = 0;
  array.forEach((item, i) => {
    if (item === 0) array[i] = silent[pos++];
    else if (Array.isArray(item)) array[i] = replaceZeroesWithSilence(item);
  });
  return array;
}
const asArray = (x) => (Array.isArray(x) ? x : [x]);

function outClass(name) {
  const C = { [name]: class extends NoOutUGen {} }[name];
  C.ar = (bus, chans) => {
    C.multiNewList(['audio', bus, ...replaceZeroesWithSilence(asArray(chans).slice())]);
    return 0;
  };
  C.kr = (bus, chans) => {
    C.multiNewList(['control', bus, ...asArray(chans)]);
    return 0;
  };
  return C;
}
const Out = outClass('Out');
const ReplaceOut = outClass('ReplaceOut');
const OffsetOut = outClass('OffsetOut');
class LocalOutU extends NoOutUGen {
  static get scName() { return 'LocalOut'; }
}
const LocalOut = {
  ar(chans) {
    LocalOutU.multiNewList(['audio', ...replaceZeroesWithSilence(asArray(chans).slice())]);
    return 0;
  },
};

class BufWr extends UGen {
  static ar(chans, buf = 0, phase = 0, loop = 1) { return this.multiNewList(['audio', buf, phase, loop, ...asArray(chans)]); }
}
class DiskOut extends UGen {
  static ar(buf, chans) { return this.multiNewList(['audio', buf, ...asArray(chans)]); }
}

class MaxLocalBufs extends UGen {
  static new() { return this.multiNew('scalar', 0); }
  increment() { this.inputs[0] = this.inputs[0] + 1; }
}
class LocalBufU extends WidthFirstUGen {
  static get scName() { return 'LocalBuf'; }
  static new1(rate, ...args) {
    const def = building();
    let m = def.maxLocalBufs;
    if (m == null) {
      m = MaxLocalBufs.new();
      def.maxLocalBufs = m;
    }
    m.increment();
    const u = new this();
    u.rate = rate;
    u.addToSynth();
    return u.init(...args, m);
  }
  clear() {
    ClearBuf.multiNew('scalar', this);
    return this;
  }
}
class ClearBuf extends WidthFirstUGen {}
const LocalBuf = (frames = 1, channels = 1) => LocalBufU.multiNew('scalar', channels, frames);

class EnvGenU extends UGen {
  static get scName() { return 'EnvGen'; }
  static new1(rate, gate, ls, lb, ts, da, env) {
    const u = new this();
    u.rate = rate;
    u.addToSynth();
    u.inputs = [gate, ls, lb, ts, da, ...env.value];
    return u;
  }
}
const EnvGen = {};
for (const [r, rate] of [['ar', 'audio'], ['kr', 'control']]) {
  EnvGen[r] = (env, gate = 1, levelScale = 1, levelBias = 0, timeScale = 1, doneAction = 0) =>
    EnvGenU.multiNewList([rate, gate, levelScale, levelBias, timeScale, doneAction, new Ref(env.asArray())]);
}

// Env, as far as poptart uses it: one channel, a single curve.
class Env {
  constructor(levels = [0, 1, 0], times = [1, 1], curve = 'lin', releaseNode = null, loopNode = null) {
    this.levels = levels;
    this.times = Array.from({ length: levels.length - 1 }, (_, i) => times[i % times.length]);
    this.curve = curve ?? 'lin';
    this.releaseNode = releaseNode;
    this.loopNode = loopNode;
  }
  static adsr(atk = 0.01, dec = 0.3, sus = 0.5, rel = 1, peak = 1, curve = -4, bias = 0) {
    return new Env(G.add([0, peak, mul(peak, sus), 0], bias), [atk, dec, rel], curve, 2);
  }
  static asr(atk = 0.01, sus = 1, rel = 1, curve = -4) {
    return new Env([0, sus, 0], [atk, rel], curve, 1);
  }
  asArray() {
    const SHAPES = { step: 0, lin: 1, linear: 1, exp: 2, exponential: 2, sin: 3, sine: 3, wel: 4, welch: 4, sqr: 6, squared: 6, cub: 7, cubed: 7, hold: 8 };
    const curves = asArray(this.curve);
    const out = [this.levels[0], this.times.length, this.releaseNode ?? -99, this.loopNode ?? -99];
    this.times.forEach((t, i) => {
      const c = curves[i % curves.length];
      const named = typeof c === 'string';
      if (named && SHAPES[c] === undefined) throw new Error('Env shape not defined.');
      out.push(this.levels[i + 1], t, named ? SHAPES[c] : 5, named ? 0 : c);
    });
    return out;
  }
}

class LinXFade2U extends UGen {
  static get scName() { return 'LinXFade2'; }
}
const LinXFade2 = {
  ar: (a, b = 0, pan = 0, level = 1) => mul(LinXFade2U.multiNew('audio', a, b, pan), level),
  kr: (a, b = 0, pan = 0, level = 1) => mul(LinXFade2U.multiNew('control', a, b, pan), level),
};

class Balance2 extends MultiOutUGen {
  static ar(l, r, pos = 0, level = 1) { return this.multiNew('audio', l, r, pos, level); }
  init(...inputs) {
    this.inputs = inputs;
    this.channels = [OutputProxy.new(this.rate, this, 0), OutputProxy.new(this.rate, this, 1)];
    return this.channels;
  }
}

const ascii = (s) => [...Buffer.from(String(s), 'latin1')];

class SendReplyU extends NoOutUGen {
  static get scName() { return 'SendReply'; }
}
// SendReply.kr(trig, cmd, values, replyID): values not nested -> one SendReply.
const SendReply = {};
for (const [r, rate] of [['ar', 'audio'], ['kr', 'control']]) {
  SendReply[r] = (trig = 0, cmd = '/reply', values, replyID = -1) => {
    const nested = Array.isArray(values) && values.some(Array.isArray);
    if (nested || Array.isArray(trig) || Array.isArray(replyID)) throw new Error('SendReply: multichannel expansion is not supported here');
    const a = ascii(cmd);
    G.UGen.new1.call(SendReplyU, rate, trig, replyID, a.length, ...a, ...asArray(values));
    return 0;
  };
}

class SendPeakRMSU extends NoOutUGen {
  static get scName() { return 'SendPeakRMS'; }
}
const SendPeakRMS = {
  kr(sig, replyRate = 20, peakLag = 3, cmd = '/reply', replyID = -1) {
    const s = asArray(sig);
    const a = ascii(cmd);
    G.UGen.new1.call(SendPeakRMSU, 'control', replyRate, peakLag, replyID, s.length, ...s.flat(Infinity), a.length, ...a);
    return 0;
  },
};

const SoundIn = {
  ar(bus = 0) {
    if (Array.isArray(bus)) throw new Error('SoundIn: arrays of buses are not supported here');
    return In.ar(G.add(NumOutputBuses.ir(), bus), 1);
  },
};

// Mix(array)
function Mix(array) {
  const arr = asArray(array);
  const clumps = [];
  for (let i = 0; i < arr.length; i += 4) clumps.push(arr.slice(i, i + 4));
  const mixed = clumps.map((a) => (a.length === 4 ? G.Sum4.new(...a) : a.length === 3 ? G.Sum3.new(...a) : G.sum(a)));
  if (mixed.length < 3) return G.sum(mixed);
  if (mixed.length === 3) return G.Sum3.new(...mixed);
  return Mix(mixed);
}

// --- extension classes --------------------------------------------------------------------------

// VSTPlugin.ar(input, numOut, bypass, params, id): input a flat signal array, or a Ref of buses.
class VSTPlugin extends MultiOutUGen {
  static ar(input = [], numOut = 1, { bypass = 0, id = null, blockSize = null } = {}) {
    return this.multiNewList(['audio', id, null, blockSize, bypass, input instanceof Ref ? 1 : asArray(input).length, numOut, 0, ...(input instanceof Ref ? [input] : asArray(input))]);
  }
  init(id, _info, blockSize, bypass, numIn, numOut, numParams, ...args) {
    this.id = id;
    let inputArray = [];
    let numInputs = 0;
    if (numIn > 0) {
      const ins = args.slice(0, numIn);
      if (ins[0] instanceof Ref) {
        for (const bus of ins[0].value) {
          const b = asArray(bus);
          inputArray.push(b.length, ...b);
          numInputs++;
        }
      } else {
        inputArray = [ins.length, ...ins];
        numInputs = 1;
      }
    }
    const outs = asArray(numOut);
    this.inputs = [0, blockSize ?? 0, bypass, numInputs, ...inputArray, outs.length, ...outs, numParams];
    const total = Math.max(1, outs.reduce((s, x) => s + x, 0));
    const r = this.initOutputs(total, this.rate);
    if (id != null) this.synthDef.slots.vstplugins[id] = this;
    return r;
  }
}

// PoptartDevice.ar(input, numChannels, bend, sidechain, id) - native/devices/PoptartDevice.sc
class PoptartDevice extends MultiOutUGen {
  static ar(input = [], numChannels = 2, bend = 0, sidechain = [], id = null) {
    const ins = asArray(input);
    const scs = asArray(sidechain ?? []);
    return this.multiNewList(['audio', id, numChannels, bend, ins.length, ...ins, scs.length, ...scs]);
  }
  init(id, numChannels, bend, numIn, ...rest) {
    this.id = id;
    this.inputs = [bend, numIn, ...rest];
    if (id == null) throw new Error('every PoptartDevice needs an id');
    const r = this.initOutputs(numChannels, this.rate);
    this.synthDef.slots.poptartDevices[id] = this;
    return r;
  }
}

// PoptartPitchShift.ar(input, ratio, window) -> input.size channels and the delay.
class PoptartPitchShift extends MultiOutUGen {
  static ar(input, ratio = 1, window = 0) {
    const ins = asArray(input);
    return this.multiNewList(['audio', ins.length, ratio, window, ...ins]);
  }
  init(n, ...inputs) {
    this.inputs = inputs;
    return this.initOutputs(n + 1, this.rate);
  }
}

// FFT(buffer, in, hop, wintype, active, winsize) - a PV_ChainUGen, so width-first.
class FFTU extends WidthFirstUGen {
  static get scName() { return 'FFT'; }
}
const FFT = (buffer, input = 0, hop = 0.5, wintype = 0, active = 1, winsize = 0) => FFTU.multiNew('control', buffer, input, hop, wintype, active, winsize);

// PoptartSpectrum.ar(in, rate, freqs) - no outputs.
class PoptartSpectrumU extends NoOutUGen {
  static get scName() { return 'PoptartSpectrum'; }
}
const PoptartSpectrum = {
  ar(input, rate = 20, freqs = []) {
    const s = asArray(input);
    PoptartSpectrumU.multiNewList(['audio', s[0], s[1] ?? s[0], rate, ...asArray(freqs)]);
    return 0;
  },
};

// --- UGen methods (x.lag, x.clip, x.wrap) -----------------------------------------------------

function lag(x, t = 0.1) {
  if (Array.isArray(x)) return x.map((e) => lag(e, t));
  if (isNum(x)) return x;
  return Lag.multiNew(x.rate, x, t);
}
function clip(x, lo = 0, hi = 1) {
  if (Array.isArray(x)) return x.map((e) => clip(e, lo, hi));
  if (isNum(x)) return Math.min(Math.max(x, lo), hi);
  return Clip[sel(x.rate)](x, lo, hi);
}
function wrap(x, lo = 0, hi = 1) {
  if (Array.isArray(x)) return x.map((e) => wrap(e, lo, hi));
  if (isNum(x)) throw new Error('wrap on a number is not supported here');
  return Wrap[sel(x.rate)](x, lo, hi);
}

module.exports = {
  Impulse, Sweep, Phasor, LFDNoise0, LFDNoise3, Latch, Gate, Trig1, PulseCount, ToggleFF, Peak,
  RunningMax, RunningSum, OnePole, LPF, HPF, RLPF, RHPF, BPF, Line, K2A, A2K, Convolution2, Clip,
  Wrap, Delay1, DelayN, Lag, Ramp, Select, SampleRate, SampleDur, ControlRate, ControlDur,
  BlockSize, NumOutputBuses, BufFrames, BufRateScale, BufSampleRate, PlayBuf, BufRd, Warp1,
  GrainBuf, DC, Silent, In, InFeedback, LocalIn, Out, ReplaceOut, OffsetOut, LocalOut, BufWr,
  DiskOut, LocalBuf, EnvGen, Env, LinXFade2, Balance2, SendReply, SendPeakRMS, SoundIn, Mix,
  VSTPlugin, PoptartDevice, PoptartPitchShift, PoptartSpectrum, FFT, lag, clip, wrap, Ref,
};
