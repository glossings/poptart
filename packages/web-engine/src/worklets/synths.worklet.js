// The synths poptart wrote, as AudioWorkletProcessors.
//
// A thin wrapper on purpose: everything that makes a sound lives in src/dsp and src/devices and
// is unit-tested in plain node, and what is left here is the part that can only be tested in a
// browser - the parameter plumbing and the note timing. Keeping that part small is the whole
// strategy, and it is the same for every synth, so one class serves them all and each registers
// its own name around it.
//
// The parameters arrive as positions and go to the synth as real units - a one-sample array for
// a control that is still, a block-long one for a control a signal is moving, converted through
// the descriptor's own curve either way (see shared.mjs). The synth reads the moving ones per
// sample, which is what makes an lfo() on a position a sweep rather than a staircase.

import { WAVETABLE, WavetableSynth } from '../devices/wavetable.mjs';
import { FMSYNTH, FmSynth } from '../devices/fmsynth.mjs';
import { GRANULAR, GranularSynth } from '../devices/granular.mjs';
import { sharedBuiltInTables } from '../dsp/tables.mjs';
import { Reporter, bendOf, isDispose, offsetInBlock, parameterDescriptorsFor, realParams } from './shared.mjs';

// The tables are built here, as the script loads, rather than in the first processor's
// constructor: a hundred milliseconds of harmonic sums is an audible dropout on the rendering
// thread once a context is running, and nothing at all before it is.
sharedBuiltInTables();

class SynthProcessor extends AudioWorkletProcessor {
  constructor(options, descriptor, synth) {
    super(options);
    this.descriptor = descriptor;
    this.synth = synth;
    // Notes arrive with an absolute time on the context's clock and are held here until the
    // block they belong in - which is what stops a part walking against the grid by up to a
    // block, nearly three milliseconds, every time it plays.
    this.pending = [];
    this.alive = true;
    this.real = {};
    this.scratch = {};
    this.reporter = new Reporter(this.port, descriptor);
    if (typeof synth.setTempo === 'function') synth.setTempo(options?.processorOptions?.bpm ?? 120, options?.processorOptions?.anchorSec ?? 0);
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (!message) return;
    if (message.kind === 'noteOn' || message.kind === 'noteOff') {
      this.pending.push(message);
      return;
    }
    if (message.kind === 'allNotesOff') {
      this.pending.length = 0;
      this.synth.allNotesOff();
      return;
    }
    if (isDispose(message)) {
      this.pending.length = 0;
      this.alive = false;
      return;
    }
    if (this.reporter.receive(message)) return;
    if (message.kind === 'tempo' && typeof this.synth.setTempo === 'function') { this.synth.setTempo(message.bpm, message.anchorSec); return; }
    if (message.kind === 'sample' && typeof this.synth.loadSample === 'function') {
      this.synth.loadSample(message.param, message.index, message);
      return;
    }
    // A curve somebody drew, already sampled into a table by the engine - see _loadShapeParam.
    if (message.kind === 'shape' && typeof this.synth.loadShape === 'function') {
      this.synth.loadShape(message.param, message.index, message.table);
    }
  }

  /** Moves every note edge that lands in this block into the synth, with its sample offset. */
  drain(blockSize) {
    if (this.pending.length === 0) return;
    const keep = [];
    for (const event of this.pending) {
      const offset = offsetInBlock(event.time, currentFrame, sampleRate, blockSize);
      if (offset >= blockSize) { keep.push(event); continue; }
      if (event.kind === 'noteOn') this.synth.queueNoteOn(event.note, event.velocity, offset);
      else this.synth.queueNoteOff(event.note, offset);
    }
    this.pending = keep;
  }

  process(inputs, outputs, parameters) {
    if (!this.alive) return false;
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const blockSize = out[0].length;

    this.synth.setParams(realParams(this.descriptor, parameters, this.real, this.scratch));
    // The track's bend, which the track keeps connected: per sample while it moves.
    this.synth.setBend(bendOf(parameters));
    this.drain(blockSize);

    out[0].fill(0);
    if (out[1]) out[1].fill(0);
    this.synth.process(out[0], out[1] ?? out[0], blockSize);
    this.reporter.tick(parameters, () => this.synth.report?.());

    // A synth with nothing sounding and nothing queued still has to stay alive: the next note is
    // a message away, and a processor that returned false would have been torn down by then.
    // Which is why the engine has to say when a device is finished with - see the dispose
    // message above, and _buildDevice's dispose on the other end of it.
    return true;
  }
}

const SYNTHS = [
  [WAVETABLE, () => new WavetableSynth(sampleRate)],
  [FMSYNTH, () => new FmSynth(sampleRate)],
  [GRANULAR, () => new GranularSynth(sampleRate)],
];

for (const [descriptor, make] of SYNTHS) {
  registerProcessor(descriptor.processor, class extends SynthProcessor {
    static get parameterDescriptors() { return parameterDescriptorsFor(descriptor); }
    constructor(options) { super(options, descriptor, make()); }
  });
}
