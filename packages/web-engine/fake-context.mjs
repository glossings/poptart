// A stand-in for the browser's audio graph, for testing the engine's WIRING.
//
// There is no Web Audio outside a browser, and this package's testing posture is the same as the
// rest of poptart's: unit-test the logic, and check the things that need real audio by hand
// against a written checklist. What can be tested here is everything about the graph that is a
// decision rather than a sound - which node feeds which, whether a re-evaluation rebuilt a path
// it should have left alone, whether a modulator was cleared when the pattern dropped it - and
// those are exactly the bugs that are invisible by ear until a track goes silent mid-set.
//
// Every node records what it is connected to. Every AudioParam records the calls made on it, so
// a test can tell a ramp from a step, and a scheduled value from an immediate one.

import { parameterDescriptorsFor } from './src/worklets/shared.mjs';

export class FakeParam {
  constructor(value = 0, name = '') {
    this.value = value;
    this.name = name;
    this.calls = [];
    this.connectedFrom = [];
    this._isParam = true;
  }

  setValueAtTime(v, t) { this.calls.push({ kind: 'set', value: v, time: t }); this.value = v; return this; }
  linearRampToValueAtTime(v, t) { this.calls.push({ kind: 'ramp', value: v, time: t }); this.value = v; return this; }
  exponentialRampToValueAtTime(v, t) { this.calls.push({ kind: 'expramp', value: v, time: t }); this.value = v; return this; }
  cancelScheduledValues(t) { this.calls.push({ kind: 'cancel', time: t }); return this; }
  cancelAndHoldAtTime(t) { this.calls.push({ kind: 'hold', time: t }); return this; }

  /** Was this parameter ever ramped to the given value? */
  rampedTo(v, epsilon = 1e-9) {
    return this.calls.some((c) => c.kind === 'ramp' && Math.abs(c.value - v) <= epsilon);
  }
}

let nodeSerial = 0;

export class FakeNode {
  constructor(kind, extra = {}) {
    this.kind = kind;
    this.id = ++nodeSerial;
    this.outputs = [];
    this.started = null;
    this.stopped = null;
    Object.assign(this, extra);
  }

  connect(target, output = 0, input = 0) {
    this.outputs.push(target);
    // Which output went to which input, for the nodes where that is the point: a splitter's
    // channel N into a merger's side.
    (this.links ??= []).push({ target, output, input });
    if (target instanceof FakeParam) target.connectedFrom.push(this);
    return target instanceof FakeParam ? undefined : target;
  }

  disconnect(target) {
    if (target === undefined) {
      for (const out of this.outputs) {
        if (out instanceof FakeParam) out.connectedFrom = out.connectedFrom.filter((n) => n !== this);
      }
      this.outputs.length = 0;
      return;
    }
    this.outputs = this.outputs.filter((n) => n !== target);
    if (target instanceof FakeParam) target.connectedFrom = target.connectedFrom.filter((n) => n !== this);
  }

  start(when = 0, offset = 0, duration = undefined) { this.started = { when, offset, duration }; }
  stop(when = 0) { this.stopped = { when }; }

  /** Everything reachable downstream, for asking whether a signal gets anywhere. */
  reaches(target, seen = new Set()) {
    if (this === target) return true;
    if (seen.has(this)) return false;
    seen.add(this);
    return this.outputs.some((n) => (n instanceof FakeNode ? n.reaches(target, seen) : n === target));
  }
}

export class FakeWorkletNode extends FakeNode {
  constructor(ctx, name, options = {}) {
    super('worklet');
    this.processorName = name;
    this.options = options;
    this.messages = [];
    this.port = { postMessage: (m) => this.messages.push(m) };
    this.parameters = new Map();
    // A worklet declares its parameters up front; the fake takes them from the descriptor the
    // engine passed in, which is how the real one would learn them from parameterDescriptors.
    for (const id of options.paramIds ?? []) this.parameters.set(id, new FakeParam(0, id));
  }
}

export class FakeAudioContext {
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.created = [];
    this.destination = new FakeNode('destination');
  }

  advance(seconds) { this.currentTime += seconds; }

  _make(node) { this.created.push(node); return node; }

  createGain() { return this._make(new FakeNode('gain', { gain: new FakeParam(1, 'gain') })); }
  createStereoPanner() { return this._make(new FakeNode('panner', { pan: new FakeParam(0, 'pan') })); }
  createConstantSource() { return this._make(new FakeNode('constant', { offset: new FakeParam(0, 'offset') })); }
  createBufferSource() {
    return this._make(new FakeNode('bufferSource', {
      buffer: null, loop: false, loopStart: 0, loopEnd: 0,
      playbackRate: new FakeParam(1, 'playbackRate'),
      detune: new FakeParam(0, 'detune'),
    }));
  }

  createBiquadFilter() {
    return this._make(new FakeNode('biquad', {
      type: 'lowpass',
      frequency: new FakeParam(350, 'frequency'),
      Q: new FakeParam(1, 'Q'),
      gain: new FakeParam(0, 'gain'),
      detune: new FakeParam(0, 'detune'),
    }));
  }

  createDelay(maxDelay = 1) {
    return this._make(new FakeNode('delay', { maxDelay, delayTime: new FakeParam(0, 'delayTime') }));
  }

  createDynamicsCompressor() {
    return this._make(new FakeNode('compressor', {
      threshold: new FakeParam(-24, 'threshold'),
      ratio: new FakeParam(12, 'ratio'),
      knee: new FakeParam(30, 'knee'),
      attack: new FakeParam(0.003, 'attack'),
      release: new FakeParam(0.25, 'release'),
    }));
  }

  /**
   * The mixer's taps. An analyser reports whatever `feed()` was given, so a test can say what a
   * track is playing without there being any audio: the wiring and the budget are what is worth
   * checking here, and the numbers themselves come from the browser.
   */
  createAnalyser() {
    const node = new FakeNode('analyser', {
      fftSize: 2048,
      smoothingTimeConstant: 0,
      _time: 0,
      _db: -120,
      feed(peak, db = -60) { node._time = peak; node._db = db; },
      getFloatTimeDomainData(into) { into.fill(node._time); },
      getFloatFrequencyData(into) { into.fill(node._db); },
    });
    return this._make(node);
  }

  createChannelSplitter(count = 2) {
    return this._make(new FakeNode('splitter', { channels: count }));
  }

  createChannelMerger(count = 2) {
    return this._make(new FakeNode('merger', { channels: count }));
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }
}

/**
 * A worklet constructor the engine can be handed in place of the browser's. It reads the
 * device's own descriptor to decide which parameters the node exposes, which is what the real
 * AudioWorkletProcessor does through its static parameterDescriptors.
 */
export function fakeWorkletFor(registry) {
  return class extends FakeWorkletNode {
    constructor(ctx, name, options = {}) {
      const descriptor = registry.list().find((d) => d.processor === name);
      // Every parameter, k-rate ones included, because that is what the real processors declare
      // (see parameterDescriptorsFor). A rig that left the k-rate ones out would send them by
      // message here and by AudioParam in a browser, which is the wrong half to be testing.
      const paramIds = descriptor ? parameterDescriptorsFor(descriptor).map((p) => p.name) : [];
      super(ctx, name, { ...options, paramIds });
      ctx.created.push(this);
    }
  };
}
