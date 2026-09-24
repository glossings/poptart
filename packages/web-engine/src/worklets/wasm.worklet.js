// The ported devices, as AudioWorkletProcessors around a compiled module.
//
// One processor class serves every one of them, because they all speak the same tiny ABI (see
// build/devices/build-devices.mjs, which generates the C that gives a plugin that ABI):
//
//   pd_init(sampleRate)   set up, once
//   pd_max_block()        how many frames the shared buffers hold
//   pd_param_count()      how many controls
//   pd_in() pd_out() pd_params()   offsets into the module's own memory
//   pd_process(frames)    read the input and the params, write the output
//
// Audio crosses into the module through its linear memory rather than through calls: the worklet
// copies a block in, calls process once, copies a block out. Copying sounds wasteful and is not -
// it is 128 floats each way, and the alternative is a call per sample across a boundary the
// engine cannot inline through.
//
// WHY A CLASS PER DEVICE RATHER THAN ONE GENERIC PROCESSOR. `parameterDescriptors` is a static
// read once when a name is registered, so a processor name and a parameter list are welded
// together. One generic name could not declare Galactic's five controls and Clouds' eleven, so
// each device registers its own name around the same implementation.
//
// The module arrives already compiled. A WebAssembly.Module is structured-cloneable, so the page
// compiles each binary once and posts it in with the node's options, and this side instantiates
// synchronously - which matters because a processor's constructor cannot await anything.
//
// A device with a sidechain - Warps, whose carrier is another track - finds it as its second
// input, and its wrapper says which of the module's two channels the sidechain feeds.

import { AIRWINDOWS_DEVICES } from '../devices/airwindows.mjs';
import { CLOUDSEED_DEVICES } from '../devices/cloudseed.mjs';
import { STRETCH_DEVICES } from '../devices/stretch.mjs';
import { MUTABLE_DEVICES } from '../devices/mutable.mjs';
import { denormalize } from '../descriptor.mjs';
import { Reporter, blockValue, isDispose, offsetInBlock, parameterDescriptorsFor } from './shared.mjs';

/**
 * Everything a compiled device is allowed to ask of its host, which is very little.
 *
 * `__cxa_rethrow` can never happen: the Airwindows plugins end their parameter switch with a
 * bare `throw` for an index that cannot be passed, and that alone makes the compiler emit the
 * import. It is answered rather than removed so the pinned source stays exactly as it was.
 *
 * `random_get` is real, and it is answered DETERMINISTICALLY on purpose. A device that seeds
 * itself from the clock renders differently every time it is built, which would make a saved
 * song a different performance on every load - the same reason the pattern language seeds its
 * own random. Every instance starts from the same state, so a phase randomizer is a fixed
 * choice rather than a fresh one.
 *
 * The memory is not known until the instance exists, so it is filled in after.
 */
function importsFor(held) {
  // xorshift32: small, fast enough to fill a buffer in a constructor, and identical everywhere.
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  return {
    env: {
      __cxa_rethrow() { /* unreachable: no device throws */ },
    },
    wasi_snapshot_preview1: {
      random_get(ptr, len) {
        if (!held.memory) return 8;                // EBADF-ish: nothing to write into yet
        const bytes = new Uint8Array(held.memory.buffer, ptr, len);
        for (let i = 0; i < len; i++) bytes[i] = next() & 0xff;
        return 0;
      },
      // A device that decides to exit has failed; there is no process to end, so it is marked
      // finished and rendered as silence rather than left half-running.
      proc_exit() { held.dead = true; },
    },
  };
}

class WasmDeviceProcessor extends AudioWorkletProcessor {
  constructor(options, descriptor) {
    super(options);
    this.descriptor = descriptor;
    this.alive = true;
    this.ready = false;
    // Note edges wait here until the block they belong in, so a part does not walk against the
    // grid by up to a block every time it plays - the same rule the synth worklet follows.
    this.pending = [];
    this.reporter = new Reporter(this.port, descriptor);
    this.port.onmessage = (event) => this.receive(event.data);

    const module = options?.processorOptions?.module;
    if (!module) return;                       // built without its binary; stays silent, see below
    const held = { memory: null, dead: false };
    const instance = new WebAssembly.Instance(module, importsFor(held));
    const e = instance.exports;
    held.memory = e.memory;
    this.held = held;
    e._initialize?.();
    e.pd_init(sampleRate);

    this.exports = e;
    this.maxBlock = e.pd_max_block();
    this.paramCount = e.pd_param_count();
    // Views are rebuilt on use rather than held: a module that grew its memory would leave a
    // detached view behind, and a detached view is silence with no error.
    this.inPtr = e.pd_in();
    this.outPtr = e.pd_out();
    this.paramPtr = e.pd_params();
    this.memory = e.memory;
    this.ready = true;
  }

  receive(message) {
    if (!message) return;
    // A bend is timestamped like a note, so it is applied at its sample in the block.
    if (message.kind === 'noteOn' || message.kind === 'noteOff' || message.kind === 'bend') {
      this.pending.push(message);
      return;
    }
    if (message.kind === 'allNotesOff') {
      this.pending.length = 0;
      this.exports?.pd_note_off?.(-1);
      return;
    }
    if (isDispose(message)) {
      this.pending.length = 0;
      this.alive = false;
      return;
    }
    this.reporter.receive(message);
  }

  /**
   * The note edges landing in this block, as offsets into it, soonest first.
   *
   * Anything further ahead stays queued. A device that takes no notes never has any, so this
   * costs an empty array and the block is rendered in one piece.
   */
  edgesIn(blockSize) {
    if (this.pending.length === 0) return [];
    const due = [];
    const keep = [];
    for (const event of this.pending) {
      const offset = offsetInBlock(event.time, currentFrame, sampleRate, blockSize);
      if (offset >= blockSize) keep.push(event);
      else due.push({ offset, event });
    }
    this.pending = keep;
    return due.sort((a, b) => a.offset - b.offset);
  }

  /** A float view of the module's memory, rebuilt if the buffer was ever replaced. */
  floats() {
    if (!this.view || this.view.buffer !== this.memory.buffer) {
      this.view = new Float32Array(this.memory.buffer);
    }
    return this.view;
  }

  process(inputs, outputs, parameters) {
    if (!this.alive) return false;
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const frames = Math.min(out[0].length, this.maxBlock ?? 0);
    // No binary, or a module that has trapped: the device gets out of the way and passes its
    // input through. It must not write silence. A slot's dry path sits at zero and its wet at
    // one, so an effect that outputs nothing does not cost one effect - it takes the whole
    // track with it, and a chain ending in a device whose binary failed to download would go
    // silent with one line in the console to explain a track that simply stopped. An
    // instrument has no input to pass, so for one of those this is silence either way.
    // Returning false is not an option: the node would be torn down and never come back.
    if (!this.ready || this.held?.dead || frames === 0) {
      const passing = inputs[0] ?? [];
      for (let ch = 0; ch < out.length; ch++) {
        const from = passing[Math.min(ch, passing.length - 1)];
        if (from) out[ch].set(from.subarray(0, out[ch].length));
        else out[ch].fill(0);
      }
      return true;
    }

    const inL = this.inPtr / 4;
    const inR = inL + this.maxBlock;
    const outL = this.outPtr / 4;
    const outR = outL + this.maxBlock;
    const base = this.paramPtr / 4;
    const input = inputs[0] ?? [];
    const left = input[0];
    let right = input[1] ?? input[0];
    // A device with a sidechain hears the track on its first channel and the other signal on
    // its second, summed to mono either way: the modules that take two signals take one each.
    const side = this.descriptor.sidechain ? (inputs[1]?.[0] ?? null) : null;
    if (this.descriptor.sidechain) right = side ?? this.silence(frames);

    // Controls are read once a block, as a position, and reach the module in its own units.
    // Written once even where the block is rendered in pieces: a control did not move inside a
    // block. The ramps a host glides them with are followed by the module's own interpolation
    // (Mutable) or the wrapper's (see build-devices.mjs).
    const mem = this.floats();
    for (let i = 0; i < this.paramCount; i++) {
      const p = this.descriptor.params[i];
      mem[base + i] = p ? denormalize(p, blockValue(parameters[p.id], 0)) : 0;
    }

    // The block is cut at every note edge in it and rendered a piece at a time, so a note starts
    // on the sample it was scheduled for rather than at the next block boundary. With no notes
    // due - which is every effect, always - there is one piece and this is a straight render.
    const edges = this.edgesIn(frames);
    let at = 0;
    let edge = 0;
    while (at < frames) {
      while (edge < edges.length && edges[edge].offset <= at) {
        const { event } = edges[edge];
        if (event.kind === 'noteOn') this.exports.pd_note_on?.(event.note, event.velocity ?? 1);
        else if (event.kind === 'bend') this.exports.pd_bend?.(event.semitones ?? 0);
        else this.exports.pd_note_off?.(event.note);
        edge += 1;
      }
      const until = edge < edges.length ? Math.min(edges[edge].offset, frames) : frames;
      const span = until - at;
      if (span <= 0) break;

      const before = this.floats();
      if (left) {
        before.set(left.subarray(at, at + span), inL);
        before.set((right ?? left).subarray(at, at + span), inR);
      } else {
        before.fill(0, inL, inL + span);
        before.fill(0, inR, inR + span);
      }

      this.exports.pd_process(span);

      const after = this.floats();
      out[0].set(after.subarray(outL, outL + span), at);
      if (out[1]) out[1].set(after.subarray(outR, outR + span), at);
      at = until;
    }
    this.reporter.tick(parameters);
    return true;
  }

  /** A block of zeros, kept rather than made, for a sidechain nobody has patched. */
  silence(frames) {
    if (!this._silence || this._silence.length < frames) this._silence = new Float32Array(frames);
    return this._silence;
  }
}

for (const descriptor of [...AIRWINDOWS_DEVICES, ...CLOUDSEED_DEVICES, ...STRETCH_DEVICES, ...MUTABLE_DEVICES]) {
  registerProcessor(descriptor.processor, class extends WasmDeviceProcessor {
    static get parameterDescriptors() { return parameterDescriptorsFor(descriptor); }
    constructor(options) { super(options, descriptor); }
  });
}
