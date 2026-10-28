// The effects poptart wrote, as AudioWorkletProcessors.
//
// One file and one implementation for all of them, on the same reasoning as the ported
// devices' worklet: the processors differ only in which DSP they hold and which controls they
// declare, and `parameterDescriptors` is a static read once per registered name - so each
// effect registers its own name around a class that does the same thing for every one of them.
// Adding an effect is one line in the list at the bottom.
//
// The controls arrive as positions and reach the DSP as real units: see realParams() in
// shared.mjs. An effect that syncs to the tempo hears it over the port, and one that takes a
// sidechain finds it as its second input.

import { DISTORT, DistortProcessor } from '../devices/distort.mjs';
import { CRUSH, CrushProcessor } from '../devices/crush.mjs';
import { REVERB, ReverbProcessor } from '../devices/reverb.mjs';
import { FILTER, FilterProcessor } from '../devices/filter.mjs';
import { DELAY, DelayProcessor } from '../devices/delay.mjs';
import { COMPRESSOR, CompressorProcessor } from '../devices/compressor.mjs';
import { LIMITER, LimiterProcessor } from '../devices/limiter.mjs';
import { EQ, EqProcessor } from '../devices/eq.mjs';
import { CHORUS, ChorusProcessor } from '../devices/chorus.mjs';
import { FLANGER, FlangerProcessor } from '../devices/flanger.mjs';
import { PHASER, PhaserProcessor } from '../devices/phaser.mjs';
import { FREQSHIFT, FreqShiftProcessor } from '../devices/freqshift.mjs';
import { VOICE, VoiceProcessor } from '../devices/voice.mjs';
import { DUCKER, DuckerProcessor } from '../devices/ducker.mjs';
import { OVERDRIVE, OverdriveProcessor } from '../devices/overdrive.mjs';
import { MULTIBAND, MultibandProcessor } from '../devices/multiband.mjs';
import { STUTTER, StutterProcessor } from '../devices/stutter.mjs';
import { GRAINECHO, GrainEchoProcessor } from '../devices/grainecho.mjs';
import { LPG, LpgProcessor } from '../devices/lpg.mjs';
import { CROSSOVER, CrossoverProcessor } from '../devices/crossover.mjs';
import { RecorderTap } from '../devices/recorder.mjs';
import { compileExpr, exprConsts, exprInputCount, renderExpr } from '../dsp/expr.mjs';
import { SongReader } from '../devices/song-reader.mjs';
import { GrainCloud, WarpCloud, grainFiles } from '../devices/grain-cloud.mjs';
import { Reporter, isDispose, parameterDescriptorsFor, realParams } from './shared.mjs';

class EffectProcessor extends AudioWorkletProcessor {
  constructor(options, descriptor, fx) {
    super(options);
    this.descriptor = descriptor;
    this.fx = fx;
    this.alive = true;
    this.real = {};
    this.scratch = {};
    this.reporter = new Reporter(this.port, descriptor);
    if (typeof fx.setTempo === 'function') fx.setTempo(options?.processorOptions?.bpm ?? 120, options?.processorOptions?.anchorSec ?? 0);
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (!message) return;
    if (isDispose(message)) { this.alive = false; return; }
    if (this.reporter.receive(message)) return;
    if (message.kind === 'tempo' && typeof this.fx.setTempo === 'function') { this.fx.setTempo(message.bpm, message.anchorSec); return; }
    // Notes, for an effect that is played by them (see the descriptor's `notes`). Timestamped on
    // the context's clock like a synth's, and placed inside the block by the effect itself.
    if (message.kind === 'noteOn') { this.fx.noteOn?.(message.note, message.velocity, message.time); return; }
    if (message.kind === 'noteOff') { this.fx.noteOff?.(message.note, message.time); return; }
    if (message.kind === 'noteRoute') { this.fx.setNoteRoute?.(!!message.on); return; }
    // A curve somebody drew, already sampled into a table by the engine - see _loadShapeParam.
    if (message.kind === 'shape' && typeof this.fx.loadShape === 'function') {
      this.fx.loadShape(message.param, message.index, message.table);
      return;
    }
    if (message.kind === 'sample' && typeof this.fx.loadSample === 'function') {
      this.fx.loadSample(message.param, message.index, message);
    }
  }

  process(inputs, outputs, parameters) {
    if (!this.alive) return false;
    const input = inputs[0] ?? [];
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const params = realParams(this.descriptor, parameters, this.real, this.scratch);
    // The clock rides along for the devices on the grid: a ducker, a beat repeat. A device with
    // more than one output (the Crossover) finds the others after it.
    this.fx.process(input, out, out[0].length, params, inputs[1] ?? null, currentTime, outputs.length > 1 ? outputs.slice(1) : null);
    this.reporter.tick(parameters, () => this.fx.report?.());
    // A quiet input is a rest, not a reason to stop: see the same note on the synth.
    return true;
  }
}

const EFFECTS = [
  [DISTORT, DistortProcessor], [CRUSH, CrushProcessor], [REVERB, ReverbProcessor], [FILTER, FilterProcessor],
  [DELAY, DelayProcessor], [COMPRESSOR, CompressorProcessor], [LIMITER, LimiterProcessor],
  [EQ, EqProcessor], [CHORUS, ChorusProcessor], [FLANGER, FlangerProcessor], [PHASER, PhaserProcessor],
  [DUCKER, DuckerProcessor], [OVERDRIVE, OverdriveProcessor], [MULTIBAND, MultibandProcessor],
  [STUTTER, StutterProcessor], [GRAINECHO, GrainEchoProcessor], [FREQSHIFT, FreqShiftProcessor],
  [VOICE, VoiceProcessor], [LPG, LpgProcessor], [CROSSOVER, CrossoverProcessor],
];

for (const [descriptor, Impl] of EFFECTS) {
  registerProcessor(descriptor.processor, class extends EffectProcessor {
    static get parameterDescriptors() { return parameterDescriptorsFor(descriptor); }
    constructor(options) { super(options, descriptor, new Impl(sampleRate, 128)); }
  });
}

// A parameter expression (see dsp/expr.mjs): one per expression the engine installs, reading its
// inputs as mono signals and writing the parameter's value every sample. New constants arrive
// over the port and are taken in place; a new shape is a new node.
registerProcessor('poptart-expr', class extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const tree = options?.processorOptions?.tree;
    this.alive = true;
    this.consts = exprConsts(tree);
    try {
      this.fn = compileExpr(tree, this.consts);
    } catch {
      this.fn = () => 0; // the engine compiled this tree before building the node, so it is known good
    }
    this.x = new Float64Array(exprInputCount(tree));
    this.port.onmessage = (event) => {
      if (isDispose(event.data)) { this.alive = false; return; }
      const next = event.data?.consts;
      if (!Array.isArray(next)) return;
      for (let j = 0; j < next.length && j < this.consts.length; j++) this.consts[j] = Number(next[j]) || 0;
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const out = outputs[0]?.[0];
    if (out) renderExpr(this.fn, inputs, out, this.x);
    return true;
  }
});

// The recorder tap (see devices/recorder.mjs): not an effect, so no descriptor and no parameters,
// but it lives in this file so that loading the effects loads it too.
registerProcessor('poptart-recorder', class extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.alive = true;
    this.tap = new RecorderTap(sampleRate, (m, transfer) => this.port.postMessage(m, transfer ?? []));
    this.port.onmessage = (event) => {
      if (isDispose(event.data)) { this.alive = false; return; }
      this.tap.receive(event.data);
    };
  }

  process(inputs) {
    if (!this.alive) return false;
    const input = inputs[0] ?? [];
    this.tap.process(input[0] ?? null, input[1] ?? null, input[0]?.length ?? 128, currentFrame);
    return true;
  }
});

// The song player (see devices/song-reader.mjs): a DJ deck's decoded song under a playhead. Not an
// effect either, and here for the same reason the recorder is. Output 0 is the song as heard;
// output 1, only while keylock wants it, is the same song read a lead ahead, for the shifter.
registerProcessor('poptart-song', class extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.alive = true;
    this.reader = new SongReader(sampleRate, (m) => this.port.postMessage(m));
    this.ahead = null;
    this.wantAhead = null;    // frames of lead to start the ahead read with, or 0 to end it
    this.port.onmessage = (event) => {
      const m = event.data;
      if (isDispose(m)) { this.alive = false; return; }
      if (m?.kind === 'ahead') { this.wantAhead = m.on ? Math.max(1, Math.round(m.lead * sampleRate)) : 0; return; }
      this.reader.receive(m);
      if (m?.kind !== 'query') this.ahead?.receive(m);
    };
  }

  process(_inputs, outputs) {
    if (!this.alive) return false;
    if (this.wantAhead != null) {
      if (this.wantAhead > 0 && !this.ahead) this.ahead = this.reader.aheadBy(this.wantAhead, currentFrame);
      else if (this.wantAhead === 0) this.ahead = null;
      this.wantAhead = null;
    }
    const out = outputs[0] ?? [];
    if (out[0]) this.reader.process(out[0], out[1] ?? null, out[0].length, currentFrame);
    const keyed = outputs[1] ?? [];
    if (this.ahead && keyed[0]) this.ahead.process(keyed[0], keyed[1] ?? null, keyed[0].length, currentFrame);
    return true;
  }
});

// The granular sample voices (see devices/grain-cloud.mjs): one per .grain() or .stretch()
// event. The first voice of a file brings its samples in its options; later ones name it.
registerProcessor('poptart-grains', class extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['size', 'density', 'pan', 'pos', 'detune'].map((name) => ({ name, defaultValue: 0, automationRate: 'a-rate' }));
  }

  constructor(options) {
    super(options);
    const o = options?.processorOptions ?? {};
    grainFiles(o);
    this.cloud = o.mode === 'warp' ? new WarpCloud(sampleRate, o) : new GrainCloud(sampleRate, o);
    this.ended = false;
    this.port.onmessage = (event) => {
      const m = event.data;
      if (isDispose(m)) { this.cloud.done = true; return; }
      if (m?.kind === 'end') this.cloud.end(m.time);
      grainFiles(m);
    };
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0] ?? [];
    if (!out[0]) return !this.cloud.done;
    const live = this.cloud.process(out[0], out[1] ?? new Float32Array(out[0].length), out[0].length, currentFrame, parameters);
    if (!live && !this.ended) {
      this.ended = true;
      this.port.postMessage({ kind: 'ended' });
    }
    return live;
  }
});
