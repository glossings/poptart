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
import { DUCKER, DuckerProcessor } from '../devices/ducker.mjs';
import { OVERDRIVE, OverdriveProcessor } from '../devices/overdrive.mjs';
import { MULTIBAND, MultibandProcessor } from '../devices/multiband.mjs';
import { STUTTER, StutterProcessor } from '../devices/stutter.mjs';
import { GRAINECHO, GrainEchoProcessor } from '../devices/grainecho.mjs';
import { VOCODER, VocoderProcessor } from '../devices/vocoder.mjs';
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
    // The clock rides along for the devices on the grid: a ducker, a beat repeat.
    this.fx.process(input, out, out[0].length, params, inputs[1] ?? null, currentTime);
    this.reporter.tick(parameters, this.fx.report?.() ?? null);
    // A quiet input is a rest, not a reason to stop: see the same note on the synth.
    return true;
  }
}

const EFFECTS = [
  [DISTORT, DistortProcessor], [CRUSH, CrushProcessor], [REVERB, ReverbProcessor], [FILTER, FilterProcessor],
  [DELAY, DelayProcessor], [COMPRESSOR, CompressorProcessor], [LIMITER, LimiterProcessor],
  [EQ, EqProcessor], [CHORUS, ChorusProcessor], [FLANGER, FlangerProcessor], [PHASER, PhaserProcessor],
  [DUCKER, DuckerProcessor], [OVERDRIVE, OverdriveProcessor], [MULTIBAND, MultibandProcessor],
  [STUTTER, StutterProcessor], [GRAINECHO, GrainEchoProcessor], [VOCODER, VocoderProcessor],
];

for (const [descriptor, Impl] of EFFECTS) {
  registerProcessor(descriptor.processor, class extends EffectProcessor {
    static get parameterDescriptors() { return parameterDescriptorsFor(descriptor); }
    constructor(options) { super(options, descriptor, new Impl(sampleRate, 128)); }
  });
}
