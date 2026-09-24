// What every poptart worklet needs from the descriptor it is built against.
//
// The parameter list an AudioWorkletProcessor declares and the parameter list the descriptor
// declares must be the same list, or a control exists on one side and not the other - which
// shows up as a knob that does nothing and no error anywhere. So it is generated from the
// descriptor rather than written twice.
//
// EVERY AUDIOPARAM IS A POSITION, 0..1. That is what `.param()` writes, what an LFO or an envelope
// sweeps, and what a patched audio signal adds to - one contract for every control on every
// device, the same as a plugin parameter. The DSP wants real units, so each worklet turns the
// positions it is handed into Hz, seconds, semitones and modes through the descriptor's own
// curve, per sample where a signal is moving the control and once where nothing is. That
// conversion is here, once, so a synth and an effect and a ported module all do it the same way.

import { denormalize } from '../descriptor.mjs';

/**
 * The processor's parameter descriptors, straight from the device's own.
 *
 * Every parameter becomes an AudioParam, k-rate ones included. Declaring the k-rate ones here
 * too rather than passing them over the message port means there is exactly one way a parameter
 * reaches the audio thread - and a mode that arrives a block later than the value it belongs
 * with is a bug nobody will find by reading.
 */
export function parameterDescriptorsFor(descriptor) {
  return descriptor.params.map((p) => ({
    name: p.id,
    defaultValue: positionOfDefault(p),
    minValue: 0,
    maxValue: 1,
    automationRate: p.rate === 'a' ? 'a-rate' : 'k-rate',
  }));
}

/** Where a parameter's default sits, as the position its AudioParam starts at. */
function positionOfDefault(p) {
  if (p.curve === 'exp') return Math.log(p.default / p.min) / Math.log(p.max / p.min);
  if (p.curve === 'pow') return Math.pow((p.default - p.min) / (p.max - p.min), 1 / p.curveExp);
  return (p.default - p.min) / (p.max - p.min);
}

/**
 * Reads a block's worth of one parameter as a plain number.
 *
 * An AudioParam that is not being automated arrives as a single-element array, which is the
 * common case for a control nobody is moving; one that is arrives with a value per sample. A
 * device that wants the whole block keeps the array, and one that only needs a block-rate value
 * takes the first element - this is for the second kind, which is every ported module.
 */
export function blockValue(values, fallback = 0) {
  if (!values || values.length === 0) return fallback;
  return values[0];
}

/**
 * Turns the positions a worklet is handed into the real values its DSP reads, in place.
 *
 * `out` is a plain object the caller keeps for the life of the processor, and `scratch` a map of
 * per-parameter Float32Arrays it also keeps: a moving control is converted into its own scratch
 * array and a still one into a number, so the hot path allocates nothing. The DSP reads the
 * result with `at()` from dsp/control.mjs, which takes either shape.
 */
export function realParams(descriptor, parameters, out, scratch) {
  for (const p of descriptor.params) {
    const values = parameters[p.id];
    if (!values || values.length === 0) { out[p.id] = p.default; continue; }
    if (values.length === 1) { out[p.id] = denormalize(p, values[0]); continue; }
    let buf = scratch[p.id];
    if (!buf || buf.length < values.length) buf = scratch[p.id] = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) buf[i] = denormalize(p, values[i]);
    out[p.id] = buf;
  }
  return out;
}

/** The positions a processor last read, as `{ id: position }` - what it reports to a panel. */
export function lastPositions(descriptor, parameters, out) {
  for (const p of descriptor.params) {
    const values = parameters[p.id];
    if (values && values.length) out[p.id] = values[values.length - 1];
  }
  return out;
}

/**
 * Whether a message tells a processor to shut down.
 *
 * A processor lives for exactly as long as its `process` returns true, and the browser keeps it
 * alive on that answer alone - being disconnected from everything does not end it. So a device
 * that has been replaced or removed has to be TOLD, and the alternative of guessing from a
 * silent input is worse than it looks: an effect whose track is resting between notes sees the
 * same empty input as one that has been unplugged, and a processor that returns false is gone
 * for good. Guessing wrong in that direction is a chain that goes permanently silent partway
 * through a set, which is the one failure this codebase is least willing to ship.
 */
export function isDispose(message) {
  return message?.kind === 'dispose';
}

/**
 * How often a watched processor reports its parameters back, in blocks. Around thirty times a
 * second at the usual block size: enough for a picture to follow a modulator, cheap enough to
 * leave on for as long as a device window is open.
 */
export const REPORT_EVERY_BLOCKS = 5;

/**
 * The part of a processor's port protocol every poptart worklet shares: a `watch` message turns
 * reporting on and off, and while it is on the processor posts the positions it last read, so
 * a panel can draw a control something else is driving where it actually is rather than where
 * it was set.
 */
export class Reporter {
  constructor(port, descriptor) {
    this.port = port;
    this.descriptor = descriptor;
    this.on = false;
    this.blocks = 0;
    this.values = {};
  }

  /** Whether a message was a watch toggle, and applies it if so. */
  receive(message) {
    if (message?.kind !== 'watch') return false;
    this.on = !!message.on;
    this.blocks = 0;
    return true;
  }

  /**
   * Called once per rendered block with the parameters it was handed.
   *
   * `report` is whatever else a device has to say about what it is doing right now - a
   * granulator's grains, a compressor's last second of levels. It rides the same message because
   * it is the same question the panel is asking: what is this device doing, as opposed to what
   * was it set to, and a second channel for it would only be a second thing to turn on and off.
   * Given as a function, so a device that copies a history out to answer does so only on the
   * blocks that post, and not on the four in between.
   */
  tick(parameters, report = null) {
    if (!this.on) return;
    if (++this.blocks < REPORT_EVERY_BLOCKS) return;
    this.blocks = 0;
    const said = typeof report === 'function' ? report() : report;
    this.port.postMessage({ kind: 'values', values: lastPositions(this.descriptor, parameters, this.values), report: said ?? null });
  }
}

/**
 * Turns an absolute time on the context's clock into a sample offset inside the block about to
 * be rendered.
 *
 * `currentFrame` counts samples since the context started, so this is exact rather than being
 * derived from a float second count that has already lost precision by the time a set has been
 * running for an hour. An event in the past lands at the start of the block - late is better
 * than dropped - and one at or past the end of the block comes back as is, which the caller
 * reads as "keep it for a later block".
 */
export function offsetInBlock(time, currentFrame, sampleRate, blockSize) {
  if (!Number.isFinite(time)) return 0;
  const frame = Math.round(time * sampleRate) - currentFrame;
  if (frame <= 0) return 0;
  return frame;
}
