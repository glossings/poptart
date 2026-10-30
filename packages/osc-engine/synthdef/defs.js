'use strict';

// Every SynthDef sc/poptart.scd builds, written against graph.js/ugens.js in the order sclang
// evaluates the source, so the bytes come out as sclang's. The comments in poptart.scd explain
// what each def is for; this file only says how it is built. Keep the two in step:
// synthdef-sclang.test.js compares them byte for byte.

const G = require('./graph.js');
const U = require('./ugens.js');

const {
  SynthDef, add, sub, mul, div, mod, min, max, pow, round, absdif, gt, ge, lt, le, neg, abs, sign,
  squared, sqrt, exp, sin, cos, reciprocal, midiratio, sum, dup,
} = G;
const {
  Impulse, Sweep, Phasor, LFDNoise0, LFDNoise3, Latch, Gate, Trig1, PulseCount, ToggleFF, Peak,
  RunningMax, RunningSum, OnePole, LPF, HPF, RLPF, RHPF, BPF, Line, K2A, A2K, Convolution2,
  Delay1, DelayN, VarLag, Select, SampleRate, SampleDur, ControlRate, ControlDur, BlockSize,
  BufFrames, BufRateScale, BufSampleRate, PlayBuf, BufRd, Warp1, GrainBuf, DC, Silent, In,
  InFeedback, LocalIn, Out, ReplaceOut, OffsetOut, LocalOut, BufWr, DiskOut, LocalBuf, EnvGen, Env,
  LinXFade2, Balance2, SendReply, SendPeakRMS, SoundIn, Mix, VSTPlugin, PoptartDevice,
  PoptartPitchShift, PoptartSpectrum, FFT, lag, clip, wrap, Ref,
} = U;

const TWO_PI = 2 * Math.PI;
const SQRT2 = Math.sqrt(2);

/** The engine facts the defs depend on, with poptart.scd's values as defaults. */
function resolveOptions(o = {}) {
  return {
    numOutputBusChannels: o.numOutputBusChannels ?? 2,
    cueOffset: o.cueOffset ?? null,
    // The PoptartDevice extension (native/devices) - PoptartDevice and PoptartSpectrum.
    nativeDevices: o.nativeDevices ?? true,
    spectrum: o.spectrum ?? o.nativeDevices ?? true,
    // The PoptartPitchShift extension (native/rubberband).
    pitchShift: o.pitchShift ?? true,
    bendPollHz: o.bendPollHz ?? 100,
    grainMaxOverlap: o.grainMaxOverlap ?? 128,
  };
}

// --- a track's defs (sharedTrackDef) ----------------------------------------------------------

function djIsolator(input, lo, mid, hi) {
  const xo = (sig, f) => [LPF.ar(LPF.ar(sig, f), f), HPF.ar(HPF.ar(sig, f), f)];
  const split = xo(input, 250);
  const upper = xo(split[1], 2500);
  const low = sum(xo(split[0], 2500));
  const wet = add(add(mul(low, lo), mul(upper[0], mid)), mul(upper[1], hi));
  const on = gt(add(add(abs(sub(lo, 1)), abs(sub(mid, 1))), abs(sub(hi, 1))), 0.001);
  return LinXFade2.ar(input, wet, lag(sub(mul(on, 2), 1), 0.05));
}

// poptart.scd's chanIn: a channel control read at the sample rate - its control (lagged) or,
// while an audio-rate driver is on it, that driver's audio bus `<name>Ar`. A set value is held
// to setLo..setHi, a driven one to drivenLo..drivenHi (null: not held). With `both`, [audio, control].
function chanIn(def, name, value, lagTime = 0, setLo = null, setHi = null, drivenLo = null, drivenHi = null, both = false) {
  const k = def.namedKr(name, value);
  const bus = def.namedKr(`${name}Ar`, -1);
  const on = ge(bus, 0);
  let set = lagTime > 0 ? lag(k, lagTime) : k;
  let driven = In.ar(max(bus, 0), 1);
  if (setLo != null) set = clip(set, setLo, setHi);
  if (drivenLo != null) driven = clip(driven, drivenLo, drivenHi);
  const ar = Select.ar(on, [K2A.ar(set), driven]);
  if (!both) return ar;
  return [ar, Select.kr(on, [set, A2K.kr(driven)])];
}

function headDef(o) {
  return new SynthDef('poptart_head', {
    inBus: 0, out: 0, bendrange: 2, bendOut: 0,
    grainpos: 0, grainsize: 0.08, grainrate: 20, grainpan: 0, grainOut: 0,
  }, (c, def) => {
    const [bendV, bendKr] = chanIn(def, 'bend', 0, 0.01, -48, 48, null, null, true);
    ReplaceOut.kr(c.bendOut, bendKr);
    const bendOn = gt(abs(bendKr), 1e-4);
    SendReply.kr(
      mul(Impulse.kr(o.bendPollHz), min(add(bendOn, Trig1.kr(sub(1, bendOn), 0.1)), 1)),
      '/poptart/bendOut', [bendKr, c.bendrange]);
    ReplaceOut.kr(c.grainOut, [c.grainpos, c.grainsize, c.grainrate, c.grainpan]);
    const sig = add(add(VSTPlugin.ar([], 2, { id: 'slot0' }),
      o.nativeDevices ? PoptartDevice.ar([], 2, bendV, null, 'nslot0') : Silent.ar(2)),
    In.ar(c.inBus, 2));
    Out.ar(c.out, mul(sig, chanIn(def, 'gain', 1, 0.02)));
  });
}

function fxDef(o) {
  return new SynthDef('poptart_fx', { in: 0, out: 0, scBus: 0, active: 0, native: 0, ret: 0, loop: 0 }, (c, def) => {
    const jin = In.ar(c.in, 2);
    const scIn = In.ar(c.scBus, 2);
    const plugin = VSTPlugin.ar(new Ref([[jin[0], jin[1]], [scIn[0], scIn[1]]]), 2, { id: 'slot' });
    // A looped Delay's return rides on the key, the block before (InFeedback); its repeats leave
    // on the device's second pair (see poptart.scd's buildFxDef).
    let device;
    if (o.nativeDevices) {
      const back = InFeedback.ar(c.ret, 2);
      device = PoptartDevice.ar([jin[0], jin[1]], 4, 0, [add(scIn[0], back[0]), add(scIn[1], back[1])], 'nslot');
    } else {
      device = Silent.ar(4);
    }
    const pick = add(mul(plugin, sub(1, c.native)), mul(device.slice(0, 2), c.native));
    const mix = mul(lag(c.active, 0.02), chanIn(def, 'wet', 1, 0.02, 0, 1));
    Out.ar(c.out, add(mul(jin, sub(1, mix)), mul(pick, mix)));
    Out.ar(c.loop, device.slice(2, 4));
  });
}

function xoverDef(o) {
  return new SynthDef('poptart_xover', { in: 0, out: 0, key: 0, rest: 0, ap: 0 }, (c) => {
    let device;
    if (o.nativeDevices) {
      const k = In.ar(c.key, 2);
      const x = In.ar(c.in, 2);
      device = PoptartDevice.ar([x[0], x[1]], 6, 0, [k[0], k[1]], 'nslot');
    } else {
      device = Silent.ar(6);
    }
    Out.ar(c.out, device.slice(0, 2));
    Out.ar(c.rest, device.slice(2, 4));
    Out.ar(c.ap, device.slice(4, 6));
  });
}

// The direct output bus: (out.round - 1).mod(pairs.max(1)) * 2
const directBus = (out, pairs) => mul(mod(sub(round(out), 1), max(pairs, 1)), 2);

function stripDef() {
  return new SynthDef('poptart_track_shared', {
    in: 0, post: 0, ctl: 0, out: 1, pairs: 1,
    fader: 1, deck: 1, mon: 0, direct: 1,
  }, (c, def) => {
    const faderAmt = clip(lag(c.fader, 0.08), 0, 1);
    const mainAmt = sub(1, clip(lag(c.mon, 0.05), 0, 1));
    const deckAmt = clip(lag(c.deck, 0.08), 0, 1);
    let sig = In.ar(c.in, 2);
    const mid = mul(add(sig[0], sig[1]), 0.5);
    const side = mul(mul(sub(sig[0], sig[1]), 0.5), chanIn(def, 'width', 1, 0.02, 0, 4, 0, 4));
    // The pan law's gains once a block off the control, or per sample off panAr (poptart_panlaw).
    const panBus = def.namedKr('panAr', -1);
    const panGains = Select.ar(ge(panBus, 0), [K2A.ar(Balance2.kr(1, 1, clip(lag(def.namedKr('pan', 0), 0.02), -1, 1), 1)),
      In.ar(max(panBus, 0), 2)]);
    const panned = [mul(add(mid, side), panGains[0]), mul(sub(mid, side), panGains[1])];
    sig = mul(panned, mul(chanIn(def, 'postgain', 1, 0.02), SQRT2));
    const [dryAmt, dryKr] = chanIn(def, 'dry', 1, 0.02, null, null, null, null, true);
    ReplaceOut.kr(c.ctl, [faderAmt, mainAmt, deckAmt, dryKr, c.out, c.pairs]);
    Out.ar(c.post, sig);
    Out.ar(directBus(c.out, c.pairs), mul(sig, mul(mul(mul(mul(faderAmt, deckAmt), mainAmt), dryAmt), c.direct)));
  });
}

function djDef() {
  return new SynthDef('poptart_dj', {
    in: 0, ctl: 0, trim: 1, eqlo: 1, eqmid: 1, eqhi: 1, djf: 0, djres: 0,
    cue: 0, cueBus: 0, mdeck: -1, meterBus: 0, fxOut: 0, fxSend: 0,
  }, (c, def) => {
    const k = In.kr(c.ctl, 6);
    const [faderAmt, mainAmt, deckAmt, , out, pairs] = k;
    const dryBus = def.namedKr('dryAr', -1);
    const dryAmt = Select.ar(ge(dryBus, 0), [K2A.ar(k[3]), In.ar(max(dryBus, 0), 1)]);
    let live = djIsolator(mul(In.ar(c.in, 2), clip(lag(c.trim, 0.08), 0, 4)),
      clip(lag(c.eqlo, 0.08), 0, 2), clip(lag(c.eqmid, 0.08), 0, 2), clip(lag(c.eqhi, 0.08), 0, 2));
    const djv = clip(lag(c.djf, 0.15), -1, 1);
    const djLpf = clip(mul(18000, pow(900, min(djv, 0))), 20, 18000);
    const djHpf = clip(mul(20, pow(900, max(djv, 0))), 20, 18000);
    const djq = sub(1, mul(0.62, clip(lag(c.djres, 0.08), 0, 1)));
    const djWet = RHPF.ar(RLPF.ar(live, djLpf, djq), djHpf, djq);
    const fxAmt = clip(lag(c.fxSend, 0.08), 0, 1);
    live = LinXFade2.ar(live, djWet, lag(sub(mul(gt(abs(djv), 0.005), 2), 1), 0.05));
    Out.ar(c.cueBus, mul(live, clip(lag(max(c.cue, sub(1, mainAmt)), 0.05), 0, 1)));
    Out.ar(add(c.meterBus, mul(max(c.mdeck, 0), 2)), mul(live, gt(c.mdeck, -0.5)));
    Out.ar(c.fxOut, mul(mul(mul(live, fxAmt), faderAmt), mainAmt));
    Out.ar(directBus(out, pairs), mul(live, mul(mul(mul(mul(sub(1, fxAmt), faderAmt), deckAmt), mainAmt), dryAmt)));
  });
}

function tapDef() {
  return new SynthDef('poptart_tap', { in: 0, out: 0, ctl: 0, amp: 1, post: 0 }, (c) => {
    const k = In.kr(c.ctl, 2);
    Out.ar(c.out, mul(In.ar(c.in, 2), mul(lag(c.amp, 0.02), Select.kr(c.post, [1, mul(k[0], k[1])]))));
  });
}

function bassMonoDef() {
  return new SynthDef('poptart_bassmono', { in: 0, out: 0 }, (c, def) => {
    const sig = In.ar(c.in, 2);
    const mid = mul(add(sig[0], sig[1]), 0.5);
    let side = mul(sub(sig[0], sig[1]), 0.5);
    const k = def.namedKr('bassmono', 0);
    const bus = def.namedKr('bassmonoAr', -1);
    const driven = In.ar(max(bus, 0), 1);
    const freq = clip(Select.ar(ge(bus, 0), [K2A.ar(lag(k, 0.05)), driven]), 20, 2000);
    const on = Select.ar(ge(bus, 0), [K2A.ar(gt(k, 0)), DC.ar(1)]);
    side = LinXFade2.ar(side, HPF.ar(side, freq), lag(sub(mul(on, 2), 1), 0.05));
    Out.ar(c.out, [add(mid, side), sub(mid, side)]);
  });
}

/** The defs every track runs (sharedTrackDef), in the order poptart.scd adds them. */
function trackDefs(options) {
  const o = resolveOptions(options);
  return [headDef(o), fxDef(o), xoverDef(o), stripDef(), djDef(), tapDef(), bassMonoDef()];
}

// --- modulators -------------------------------------------------------------------------------

const LFO_SHAPES = ['sine', 'tri', 'saw', 'isaw', 'square', 'rand', 'perlin'];
const lfoDefName = (shape, audio) => `poptart_lfo_${shape}${audio ? '_ar' : ''}`;

function lfoDef(shape, at) {
  return new SynthDef(lfoDefName(shape, at === 'ar'), { out: 0, freq: 1, phase: 0, lo: 0, hi: 1, t_trig: 0 }, (c) => {
    const ph = wrap(add(Sweep[at](c.t_trig, c.freq), c.phase), 0, 1);
    let uni;
    switch (shape) {
      case 'sine': uni = add(mul(sin(mul(ph, TWO_PI)), 0.5), 0.5); break;
      case 'tri': uni = sub(1, abs(sub(mul(ph, 2), 1))); break;
      case 'saw': uni = ph; break;
      case 'isaw': uni = sub(1, ph); break;
      case 'square': uni = lt(ph, 0.5); break;
      case 'rand': uni = add(mul(LFDNoise0[at](c.freq), 0.5), 0.5); break;
      case 'perlin':
        uni = add(mul(mul(add(add(add(
          mul(LFDNoise3[at](c.freq), 0.5),
          mul(LFDNoise3[at](mul(c.freq, 2)), 0.25)),
          mul(LFDNoise3[at](mul(c.freq, 4)), 0.125)),
          mul(LFDNoise3[at](mul(c.freq, 8)), 0.0625)), 1 / 0.9375), 0.5), 0.5);
        break;
      default: throw new Error(`unknown lfo shape ${shape}`);
    }
    const v = add(c.lo, mul(uni, sub(c.hi, c.lo)));
    if (at === 'ar') Out.ar(c.out, [v, v]);
    else Out.kr(c.out, v);
  });
}

function shapeLfoDef(at) {
  return new SynthDef(at === 'ar' ? 'poptart_shape_lfo_ar' : 'poptart_shape_lfo', {
    out: 0, buf: 0, rate: 1, phase: 0, lo: 0, hi: 1, t_trig: 0, envelope: 0, glideSec: 0, glideOn: 0,
  }, (c) => {
    const born = Impulse[at](0);
    const run = add(Sweep[at](c.t_trig, c.rate), mul(c.phase, sub(1, c.envelope)));
    const idx = Select[at](c.envelope, [mod(run, 1), min(run, 1)]);
    const frames = BufFrames.kr(c.buf);
    const shaped = add(c.lo, mul(BufRd[at](1, c.buf, mul(idx, max(sub(frames, 1), 0)), 0, 2), sub(c.hi, c.lo)));
    const before = at === 'ar' ? InFeedback.ar(c.out, 1) : In.kr(c.out);
    const offset = mul(sub(Latch[at](before, born), Latch[at](shaped, born)), c.glideOn);
    const v = add(shaped, mul(offset, EnvGen[at](new Env([1, 0], [max(c.glideSec, 0.001)], -4))));
    if (at === 'ar') Out.ar(c.out, [v, v]);
    else Out.kr(c.out, v);
  });
}

const envParams = () => ({ out: 0, atk: 0.01, dec: 0.1, sus: 0.7, rel: 0.2, curve: -4, gate: 0, lo: 0, hi: 1, retrig: 0, t_retrig: 0 });

function envDef() {
  return new SynthDef('poptart_env', envParams(), (c) => {
    const again = mul(mul(c.t_retrig, c.retrig), gt(Delay1.kr(c.gate), 0));
    const envSig = EnvGen.kr(Env.adsr(c.atk, c.dec, c.sus, c.rel, 1.0, c.curve), sub(c.gate, again));
    Out.kr(c.out, add(c.lo, mul(envSig, sub(c.hi, c.lo))));
  });
}

function envArDef() {
  return new SynthDef('poptart_env_ar', envParams(), (c) => {
    const again = Trig1.ar(mul(mul(c.t_retrig, c.retrig), gt(Delay1.kr(c.gate), 0)), SampleDur.ir());
    const envSig = EnvGen.ar(Env.adsr(c.atk, c.dec, c.sus, c.rel, 1.0, c.curve), sub(c.gate, again));
    const v = add(c.lo, mul(envSig, sub(c.hi, c.lo)));
    Out.ar(c.out, [v, v]);
  });
}

function rampDef() {
  return new SynthDef('poptart_ramp', { out: 0, target: 0, time: 0.03 }, (c) => {
    // VarLag, not Ramp: Ramp re-reads its target only once per `time`, so a new value could wait
    // up to that long before moving; VarLag sets off toward it in the block it arrives.
    Out.kr(c.out, VarLag.kr(c.target, c.time));
  });
}

// --- sampler voices ---------------------------------------------------------------------------

const voiceParams = () => ({ out: 0, buf: 0, begin: 0, end: 1, rate: 1, dur: 1, gate: 1, amp: 1, atk: 0, dec: 0, sus: 1, rel: 0 });
const loopParams = () => ({ loopLo: 0, loopHi: 1, entry: 0, pingpong: 0 });
const DONE_FREE = 2;
const releaseEnv = (atkS, decS, sus, relS) => Env.adsr(atkS, decS, sus, relS);

function samplerDefs(nc, o) {
  const toStereo = (sig) => (nc === 1 ? dup(sig) : sig);
  const defs = [];

  defs.push(new SynthDef(`poptart_sample_${nc}`, { ...voiceParams(), bend: 0 }, (c) => {
    const frames = BufFrames.ir(c.buf);
    const bendRatio = midiratio(c.bend);
    const startF = mul(c.begin, frames);
    const endF = max(mul(c.begin, frames), sub(mul(c.end, frames), 1));
    const from = Select.kr(lt(c.rate, 0), [startF, endF]);
    const step = mul(mul(div(div(max(mul(sub(c.end, c.begin), frames), 1), max(c.dur, 1e-6)), SampleRate.ir()),
      Select.kr(lt(c.rate, 0), [1, -1])), bendRatio);
    const sig = PlayBuf.ar(nc, c.buf, step, 1, from, 0);
    const atEdge = min(add(lt(from, 1), gt(from, sub(frames, 2))), 1);
    const atkS = max(mul(sub(1, atEdge), 0.0005), c.atk);
    const decS = max(0, c.dec);
    const relS = max(0.015, c.rel);
    const noteGate = mul(c.gate, lt(Line.kr(0, 1, c.dur), 1));
    const env = EnvGen.ar(releaseEnv(atkS, decS, c.sus, relS), noteGate, 1, 0, 1, DONE_FREE);
    OffsetOut.ar(c.out, mul(mul(toStereo(sig), env), c.amp));
  }));

  defs.push(new SynthDef(`poptart_sample_loop_${nc}`, { ...voiceParams(), ...loopParams(), bend: 0 }, (c) => {
    const frames = BufFrames.ir(c.buf);
    const startF = mul(c.loopLo, frames);
    const endF = max(add(mul(c.loopLo, frames), 1), sub(mul(c.loopHi, frames), 1));
    const span = sub(endF, startF);
    const from = clip(mul(c.entry, frames), startF, endF);
    const step = mul(mul(c.rate, BufRateScale.ir(c.buf)), midiratio(c.bend));
    const walk = mod(add(Phasor.ar(0, step, 0, span, 0), sub(from, startF)), span);
    const bounceFrom = Select.kr(lt(c.rate, 0), [sub(from, startF), sub(mul(2, span), sub(from, startF))]);
    const bouncePh = mod(add(Phasor.ar(0, abs(step), 0, mul(2, span), 0), bounceFrom), mul(2, span));
    const bounced = sub(span, absdif(bouncePh, span));
    const mirror = Select.ar(c.pingpong, [walk, bounced]);
    const pos = add(startF, mirror);
    const dirPing = sub(mul(lt(bouncePh, span), 2), 1);
    const dir = add(mul(c.pingpong, dirPing), mul(sub(1, c.pingpong), sign(step)));
    const corner = add(mul(sub(1, c.pingpong), gt(absdif(walk, Delay1.ar(walk)), mul(span, 0.5))),
      mul(c.pingpong, gt(absdif(dirPing, Delay1.ar(dirPing)), 0.5)));
    const hold = Trig1.ar(corner, ControlDur.ir());
    const reAim = mul(hold, Impulse.ar(ControlRate.ir()));
    const play = PlayBuf.ar(nc, c.buf, mul(abs(step), dir), reAim, pos, 1);
    const patch = BufRd.ar(nc, c.buf, pos, 1, 4);
    const sig = add(mul(play, sub(1, hold)), mul(patch, hold));
    const atEdge = min(add(lt(from, 1), gt(from, sub(frames, 2))), 1);
    const atkS = max(mul(sub(1, atEdge), 0.0005), c.atk);
    const decS = max(0, c.dec);
    const relS = max(0.015, c.rel);
    const env = EnvGen.ar(releaseEnv(atkS, decS, c.sus, relS), c.gate, 1, 0, 1, DONE_FREE);
    OffsetOut.ar(c.out, mul(mul(toStereo(sig), env), c.amp));
  }));

  defs.push(new SynthDef(`poptart_sample_warp_${nc}`, { ...voiceParams(), bend: 0 }, (c) => {
    const overlaps = 8;
    const from = Select.kr(lt(c.rate, 0), [c.begin, c.end]);
    const to = Select.kr(lt(c.rate, 0), [c.end, c.begin]);
    const sig = mul(Warp1.ar(nc, c.buf, Line.kr(from, to, c.dur), mul(abs(c.rate), midiratio(c.bend)), 0.1, -1, overlaps, 0.1, 2),
      2 / overlaps);
    const atkS = max(0.0005, c.atk);
    const decS = max(0, c.dec);
    const relS = max(0.015, c.rel);
    const noteGate = mul(c.gate, lt(Line.kr(0, 1, c.dur), 1));
    const env = EnvGen.ar(releaseEnv(atkS, decS, c.sus, relS), noteGate, 1, 0, 1, DONE_FREE);
    OffsetOut.ar(c.out, mul(mul(toStereo(sig), env), c.amp));
  }));

  defs.push(new SynthDef(`poptart_sample_warp_loop_${nc}`, { ...voiceParams(), ...loopParams(), bend: 0 }, (c) => {
    const overlaps = 8;
    const span = max(0.001, sub(c.end, c.begin));
    const step = div(mul(div(span, max(0.001, c.dur)), sign(c.rate)), ControlRate.ir());
    const lo = c.loopLo;
    const hi = max(add(c.loopLo, 0.001), c.loopHi);
    const loopSpan = sub(hi, lo);
    const from = clip(c.entry, lo, hi);
    const walk = mod(add(Phasor.kr(0, step, 0, loopSpan, 0), sub(from, lo)), loopSpan);
    const bounceFrom = Select.kr(lt(c.rate, 0), [sub(from, lo), sub(mul(2, loopSpan), sub(from, lo))]);
    const bouncePh = mod(add(Phasor.kr(0, abs(step), 0, mul(2, loopSpan), 0), bounceFrom), mul(2, loopSpan));
    const bounced = sub(add(lo, loopSpan), absdif(bouncePh, loopSpan));
    const ptr = Select.kr(c.pingpong, [add(lo, walk), bounced]);
    const sig = mul(Warp1.ar(nc, c.buf, ptr, mul(abs(c.rate), midiratio(c.bend)), 0.1, -1, overlaps, 0.1, 2), 2 / overlaps);
    const atkS = max(0.0005, c.atk);
    const decS = max(0, c.dec);
    const relS = max(0.015, c.rel);
    const env = EnvGen.ar(releaseEnv(atkS, decS, c.sus, relS), c.gate, 1, 0, 1, DONE_FREE);
    OffsetOut.ar(c.out, mul(mul(toStereo(sig), env), c.amp));
  }));

  defs.push(new SynthDef(`poptart_sample_grain_${nc}`, {
    out: 0, bufL: 0, bufR: 0, begin: 0, rate: 1, gate: 1, amp: 1,
    atk: 0, dec: 0, sus: 1, rel: 0, bend: 0,
    grainpos: 0, grainsize: 0.08, grainrate: 20, grainpan: 0, posLive: 0, win: -1,
  }, (c, def) => {
    // Per sample off a driver's bus `<name>Ar` while one is on (see poptart.scd).
    const perSample = (k, name) => {
      const bus = def.namedKr(name, -1);
      return Select.ar(ge(bus, 0), [K2A.ar(k), In.ar(max(bus, 0), 1)]);
    };
    const size = clip(perSample(c.grainsize, 'grainsizeAr'), 0.002, 4);
    const density = clip(perSample(c.grainrate, 'grainrateAr'), 0.1, 1000);
    const trig = Impulse.ar(density);
    const begin = K2A.ar(c.begin);
    const pos = clip(Select.ar(c.posLive, [begin, perSample(c.grainpos, 'grainposAr')]), 0, 1);
    const pitch = mul(c.rate, midiratio(perSample(c.bend, 'bendAr')));
    const pan = clip(perSample(c.grainpan, 'grainpanAr'), -1, 1);
    const sig = nc === 1
      ? mul(GrainBuf.ar(2, trig, size, c.bufL, pitch, pos, 4, pan, c.win, o.grainMaxOverlap), SQRT2)
      : add(GrainBuf.ar(2, trig, size, c.bufL, pitch, pos, 4, clip(sub(mul(2, pan), 1), -1, 1), c.win, o.grainMaxOverlap),
        GrainBuf.ar(2, trig, size, c.bufR, pitch, pos, 4, clip(add(mul(2, pan), 1), -1, 1), c.win, o.grainMaxOverlap));
    const level = lag(reciprocal(sqrt(max(mul(mul(size, density), 0.5), 1))), 0.05);
    const atkS = max(0.0005, c.atk);
    const decS = max(0, c.dec);
    const relS = max(0.015, c.rel);
    const env = EnvGen.ar(releaseEnv(atkS, decS, c.sus, relS), c.gate, 1, 0, 1, DONE_FREE);
    OffsetOut.ar(c.out, mul(mul(mul(sig, level), env), c.amp));
  }));

  defs.push(new SynthDef(`poptart_song_${nc}`, { out: 0, buf: 0, rate: 1, run: 1, amp: 1, gate: 1, t_seek: 0, seekFrame: 0 }, (c) => {
    const step = mul(mul(lag(c.rate, 0.05), BufRateScale.ir(c.buf)), lag(c.run, 0.02));
    const sig = PlayBuf.ar(nc, c.buf, step, c.t_seek, c.seekFrame, 0);
    const idx = Phasor.ar(c.t_seek, step, 0, BufFrames.ir(c.buf), c.seekFrame);
    const env = EnvGen.kr(Env.asr(0.005, 1, 0.05), c.gate, 1, 0, 1, DONE_FREE);
    SendReply.kr(Impulse.kr(2), '/poptart/songPos', div(A2K.kr(idx), BufSampleRate.ir(c.buf)));
    Out.ar(c.out, mul(mul(toStereo(sig), env), lag(c.amp, 0.02)));
  }));

  defs.push(o.pitchShift ? songWarpDef(nc, toStereo) : songWarpFallbackDef(nc, toStereo));
  return defs;
}

function songWarpDef(nc, toStereo) {
  return new SynthDef(`poptart_songwarp_${nc}`, {
    out: 0, buf: 0, rate: 1, run: 1, amp: 1, gate: 1, t_seek: 0, seekFrame: 0, delay: 0, window: 0,
  }, (c) => {
    const brs = BufRateScale.ir(c.buf);
    const frames = BufFrames.ir(c.buf);
    const bufSr = BufSampleRate.ir(c.buf);
    const rateL = lag(c.rate, 0.05);
    const runL = lag(c.run, 0.02);
    const step = mul(mul(rateL, brs), runL);
    const start = add(c.seekFrame, mul(mul(c.delay, c.rate), brs));
    const dry = PlayBuf.ar(nc, c.buf, step, c.t_seek, start, 0);
    const idx = Phasor.ar(c.t_seek, step, 0, frames, start);
    const sh = PoptartPitchShift.ar(dry, div(1, max(rateL, 0.01)), c.window);
    const sig = sh.slice(0, nc);
    const heard = sub(idx, mul(mul(c.delay, rateL), brs));
    const runOut = lag(DelayN.kr(c.run, 0.5, div(c.delay, SampleRate.ir())), 0.02);
    const env = EnvGen.kr(Env.asr(0.005, 1, 0.05), c.gate, 1, 0, 1, DONE_FREE);
    SendReply.kr(Impulse.kr(2), '/poptart/songPos', div(A2K.kr(heard), bufSr));
    Out.ar(c.out, mul(mul(mul(toStereo(sig), env), lag(c.amp, 0.02)), runOut));
  });
}

// The keylock player built from stock UGens, for an engine without PoptartPitchShift.
function songWarpFallbackDef(nc, toStereo) {
  return new SynthDef(`poptart_songwarp_${nc}`, {
    out: 0, buf: 0, rate: 1, run: 1, amp: 1, gate: 1, t_seek: 0, seekFrame: 0,
  }, (c) => {
    const kLen = 512;
    const half = 512;
    const hop = 4 * kLen;
    const win = 2 * hop;
    const brs = BufRateScale.ir(c.buf);
    const frames = BufFrames.ir(c.buf);
    const bufSr = BufSampleRate.ir(c.buf);
    const sr = SampleRate.ir();
    const winSec = div(win, sr);
    const mono = (sig) => (nc === 1 ? sig : mul(sum(sig), 0.5));
    const lpCoef = exp(div(-TWO_PI * 1500, sr));
    const runL = lag(c.run, 0.02);
    const rateL = lag(c.rate, 0.05);
    const step = mul(mul(rateL, brs), runL);
    const idx = Phasor.ar(c.t_seek, step, 0, frames, c.seekFrame);
    const count = Phasor.ar(0, 1, 0, hop, 0);
    const at = (n) => lt(abs(sub(count, n)), 0.5);
    const wrapT = at(0);
    const inScan = ge(count, 2 * kLen);
    const ring = LocalBuf(hop).clear();
    const lagS = sub(kLen, BlockSize.ir());
    const r0 = Latch.ar(add(Latch.ar(idx, wrapT),
      mul(brs, sub(sub(sub(mul(hop, sub(rateL, 1)), 2 * kLen), 1), BlockSize.ir()))), wrapT);
    const rPos = add(r0, mul(brs, Sweep.ar(wrapT, sr)));
    const s = OnePole.ar(mono(PlayBuf.ar(nc, c.buf, brs, wrapT, r0, 1)), lpCoef);
    const corr = Convolution2.ar(s, ring, wrapT, kLen);
    const sNorm = add(sqrt(DelayN.ar(RunningSum.ar(mul(s, s), kLen), div(lagS, sr), div(lagS, sr))), 1e-6);
    const fb = LocalIn.ar(1);
    const kNorm = add(sqrt(Latch.ar(RunningSum.ar(mul(fb, fb), kLen), wrapT)), 1e-6);
    const scanT = sub(count, 2 * kLen);
    const score = sub(div(corr, mul(sNorm, kNorm)), div(mul(0.1, abs(sub(scanT, half))), half));
    const isNew = mul(ge(score, RunningMax.ar(score, at(2 * kLen))), inScan);
    const bestR = Gate.ar(sub(rPos, mul(brs, lagS)), isNew);
    const nth = PulseCount.ar(wrapT);
    const seed = Select.ar(gt(nth, 1), [idx, add(Delay1.ar(Latch.ar(idx, wrapT)), mul(brs, hop))]);
    const startPos = Latch.ar(Select.ar(gt(nth, 2), [seed, add(bestR, mul(brs, hop + 1))]), wrapT);
    const first = le(nth, 1);
    const selT = ToggleFF.ar(wrapT);
    const reader = (trig, isA) => {
      const early = Latch.ar(mul(first, isA), trig);
      const age = add(Sweep.ar(trig, 1), mul(early, div(hop, sr)));
      const w = mul(mul(lt(age, winSec), sub(0.5, mul(0.5, cos(div(mul(TWO_PI, age), winSec))))), gt(PulseCount.ar(trig), 0));
      return mul(PlayBuf.ar(nc, c.buf, brs, trig, startPos, 1), w);
    };
    const sig = add(reader(mul(wrapT, add(sub(1, selT), first)), 1), reader(mul(wrapT, selT), 0));
    const lpOut = OnePole.ar(mono(sig), lpCoef);
    const env = EnvGen.kr(Env.asr(0.005, 1, 0.05), c.gate, 1, 0, 1, DONE_FREE);
    BufWr.ar(lpOut, ring, sub(hop - 1, count), 1);
    LocalOut.ar(lpOut);
    SendReply.kr(Impulse.kr(2), '/poptart/songPos', div(A2K.kr(idx), bufSr));
    Out.ar(c.out, mul(mul(mul(toStereo(sig), env), lag(c.amp, 0.02)), runL));
  });
}

// --- inputs, meters, master -------------------------------------------------------------------

// The output channels outside the cue pair, summed to [left, right].
function mainSum(o) {
  const chans = [];
  for (let ch = 0; ch < o.numOutputBusChannels; ch++) {
    if (o.cueOffset != null && (ch === o.cueOffset || ch === o.cueOffset + 1)) continue;
    chans.push(ch);
  }
  return [chans.filter((ch) => ch % 2 === 0), chans.filter((ch) => ch % 2 !== 0)].map((side) =>
    (side.length === 0 ? DC.ar(0) : Mix(side.map((ch) => In.ar(ch, 1)))));
}

function ioDefs(o) {
  const defs = [];
  defs.push(new SynthDef('poptart_soundin', { out: 0, inA: 0, inB: 1, gain: 1 }, (c) => {
    Out.ar(c.out, mul([SoundIn.ar(c.inA), SoundIn.ar(c.inB)], c.gain));
  }));
  defs.push(new SynthDef('poptart_soundin_mono', { out: 0, inA: 0, gain: 1 }, (c) => {
    Out.ar(c.out, mul(dup(SoundIn.ar(c.inA)), c.gain));
  }));
  defs.push(new SynthDef('poptart_busread', { out: 0, in: 0, gain: 1, fb: 0 }, (c) => {
    Out.ar(c.out, mul(Select.ar(c.fb, [In.ar(c.in, 2), InFeedback.ar(c.in, 2)]), c.gain));
  }));
  defs.push(new SynthDef('poptart_rec_meter', { bus: 0 }, (c) => {
    SendPeakRMS.kr(In.ar(c.bus, 2), 20, 3, '/poptart/recLevel');
  }));
  defs.push(new SynthDef('poptart_deck_meter', { bus: 0, id: 0 }, (c) => {
    const frame = Impulse.kr(20);
    const sig = In.ar(c.bus, 2);
    const mono = mul(add(sig[0], sig[1]), 0.5);
    const lp = [200, 2000].map((f) => OnePole.ar(mono, exp(div(-TWO_PI * f, SampleRate.ir()))));
    const bands = [lp[0], sub(lp[1], lp[0]), sub(mono, lp[1])];
    const energy = bands.map((b) => A2K.kr(LPF.ar(squared(b), 10)));
    SendPeakRMS.kr(sig, 20, 3, '/poptart/deckLevel', c.id);
    SendReply.kr(frame, '/poptart/deckBands', energy, c.id);
  }));
  defs.push(new SynthDef('poptart_master', {}, () => {
    SendPeakRMS.kr(mainSum(o), 20, 3, '/poptart/masterLevel');
  }));
  if (o.cueOffset != null) {
    defs.push(new SynthDef('poptart_headphones', { level: 1, mix: 0 }, (c) => {
      const main = mainSum(o);
      const m = clip(lag(c.mix, 0.05), 0, 1);
      const cueAmt = min(mul(sub(1, m), 2), 1);
      const mainAmt = min(mul(m, 2), 1);
      const amp = squared(clip(lag(c.level, 0.05), 0, 1));
      ReplaceOut.ar(o.cueOffset, mul(add(mul(In.ar(o.cueOffset, 2), cueAmt), mul(main, mainAmt)), amp));
    }));
  }
  defs.push(new SynthDef('poptart_rec_disk', { bus: 0, buf: 0 }, (c) => {
    DiskOut.ar(c.buf, In.ar(c.bus, 2));
  }));
  defs.push(new SynthDef('poptart_term', { in: 0, out: 0, gain: -1 }, (c) => {
    const sig = In.ar(c.in, 2);
    const g = In.ar(max(c.gain, 0), 2);
    const on = ge(c.gain, 0);
    const level = Select.ar(on, [DC.ar(1), g[0]]);
    const pos = Select.ar(on, [DC.ar(0), g[1]]);
    Out.ar(c.out, mul(Balance2.ar(sig[0], sig[1], pos, 1), mul(level, SQRT2)));
  }));
  defs.push(new SynthDef('poptart_gainkr', { out: 0 }, (c, def) => {
    Out.ar(c.out, [chanIn(def, 'level', 1), chanIn(def, 'pan', 0)]);
  }));
  defs.push(new SynthDef('poptart_panlaw', { in: 0, out: 0 }, (c) => {
    Out.ar(c.out, Balance2.ar(DC.ar(1), DC.ar(1), clip(In.ar(c.in, 1), -1, 1), 1));
  }));
  defs.push(new SynthDef('poptart_xokr', { out: 0, value: 0 }, (c) => {
    ReplaceOut.kr(c.out, c.value);
  }));
  return defs;
}

/** The defs poptart.scd sends at boot, in its order (without the keylock probe). */
function bootDefs(options) {
  const o = resolveOptions(options);
  const defs = [];
  for (const shape of LFO_SHAPES) for (const at of ['kr', 'ar']) defs.push(lfoDef(shape, at));
  for (const at of ['kr', 'ar']) defs.push(shapeLfoDef(at));
  defs.push(envDef(), envArDef(), rampDef());
  for (const nc of [1, 2]) defs.push(...samplerDefs(nc, o));
  defs.push(...ioDefs(o));
  return defs;
}

/** The one-shot def that reports the keylock shifter's delay (null without PoptartPitchShift). */
function rbProbeDef(options) {
  const o = resolveOptions(options);
  if (!o.pitchShift) return null;
  return new SynthDef('poptart_rbprobe', {}, () => {
    const sh = PoptartPitchShift.ar(Silent.ar(2), 1, 0);
    SendReply.kr(Impulse.kr(0), '/poptart/rbDelay', A2K.kr(sh[2]));
    Line.kr(0, 1, 0.05, DONE_FREE);
  });
}

// --- the mixer's analysis (buildMixDef) -------------------------------------------------------

function mixBank(sig, frame, freqs) {
  const amps = freqs.map((f) => {
    const band = BPF.ar(sig, f, 0.1);
    const l = band[0];
    const r = band[1];
    return [l, r, mul(add(l, r), 0.5), mul(sub(l, r), 0.5)].map((x) => Peak.kr(x, frame));
  });
  SendReply.kr(frame, '/poptart/mixSpec', amps.flat());
}

/** poptart_mix_analysis for these band centers, and poptart_mix_meter. */
function mixDefs(freqs, options) {
  const o = resolveOptions(options);
  const fs = (freqs && freqs.length ? freqs : [200, 2000, 8000]).map(Number);
  const analysis = new SynthDef('poptart_mix_analysis', {}, (_c, def) => {
    const frame = Impulse.kr(20);
    const sig = In.ar(def.namedKr('bus', 0), 2);
    if (o.spectrum) PoptartSpectrum.ar(sig, 20, fs);
    else mixBank(sig, frame, fs);
    SendPeakRMS.kr(sig, 20, 3, '/poptart/mixLevel');
  });
  const meter = new SynthDef('poptart_mix_meter', { bus: 0 }, (c) => {
    SendPeakRMS.kr(In.ar(c.bus, 2), 20, 3, '/poptart/mixLevel');
  });
  return [analysis, meter];
}

// --- the editor's inline displays (viewTap[\buildDefs]) ----------------------------------------

/** poptart_view_tap (the ring writer) and poptart_view_fft (its spectrum sibling). */
function viewTapDefs() {
  const tap = new SynthDef('poptart_view_tap', {}, (_c, def) => {
    const sig = In.ar(def.namedKr('bus', 0), 2);
    const decim = def.namedIr('decim', 2);
    const phase = Phasor.ar(0, reciprocal(decim), 0, def.namedIr('frames', 1024));
    BufWr.ar(sig, def.namedKr('ring', 0), phase, 1);
    Out.kr(def.namedKr('head', 0), add(A2K.kr(phase), div(sub(BlockSize.ir(), 1), decim)));
  });
  const fft = new SynthDef('poptart_view_fft', {}, (_c, def) => {
    const sig = In.ar(def.namedKr('bus', 0), 2);
    FFT(def.namedKr('buf', 0), mul(add(sig[0], sig[1]), 0.5), 0.5, 1);
  });
  return [tap, fft];
}

/** Every def known before anything plays: the track's, the boot set, the keylock probe and the view taps'. */
function fixedDefs(options) {
  const probe = rbProbeDef(options);
  return [...trackDefs(options), ...bootDefs(options), ...(probe ? [probe] : []), ...viewTapDefs()];
}

module.exports = {
  resolveOptions, trackDefs, bootDefs, rbProbeDef, mixDefs, viewTapDefs, fixedDefs, lfoDefName, LFO_SHAPES,
  djIsolator,
};
