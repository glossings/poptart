// One track's audio graph.
//
// The shape mirrors what the SuperCollider side builds, because the scheduler addresses both the
// same way: a source feeding a numbered chain of effect slots, then a channel strip, then the
// master and any bus sends. Slot 0 is the instrument and slots 1..n are effects, exactly as
// `.synth()` and `.fx()` number them, and a slot can be emptied and refilled without the track
// around it being rebuilt - which is what lets a re-evaluation change one effect without cutting
// the sound.
//
// The per-slot wet/dry pair is the `wetN` channel control. It is built even when it sits at one
// because adding it later would mean re-wiring the chain, and re-wiring cuts the signal.
//
// A PARAMETER IS KEPT IN TWO FORMS. The slot remembers each control's REAL value - Hz, seconds,
// a mode index - because that is what a panel prints, what a saved state records and what the
// pictures are drawn from. The AudioParam under it carries a 0..1 POSITION, because that is what
// `.param()` writes and what every modulator sweeps. `normalize` is the bridge, and it is crossed
// exactly here, so nothing downstream has to know which form it was handed.

import { argToValue, clampParam, defaultValues, findParam, normalize } from '../descriptor.mjs';

/** Channel-strip controls this engine implements. The rest warn once - see the engine. */
export const SUPPORTED_CHANNELS = Object.freeze(['gain', 'postgain', 'pan', 'dry']);

/**
 * How long a set-by-value takes to reach its target. Long enough not to click, short enough to
 * feel instant.
 *
 * A caller can ask for a different one, and the device panel does. The reason is worth knowing:
 * a worklet reads each parameter ONCE PER BLOCK, so a value in motion is heard as a staircase at
 * the block rate - around 375 steps a second - and what decides whether that is audible is how
 * far the value moves per step. A note's worth of parameter changes lands in one jump and ten
 * milliseconds is plenty to take the click off it. A knob somebody is dragging moves for as long
 * as the gesture lasts, so the same ten milliseconds would put the whole of each frame's change
 * into three or four steps, which is a buzz on top of the sound rather than a click.
 */
const PARAM_GLIDE_SEC = 0.01;

/**
 * Moves an AudioParam to a value at a time.
 *
 * `setValueAtTime` would step and click; a ramp from wherever the parameter currently is gives
 * the same behavior the SuperCollider side gets from its ramp synth, which is what makes a
 * polled control sound like a sweep rather than a staircase.
 */
export function rampParam(param, value, atTime, now, glide = PARAM_GLIDE_SEC) {
  const when = Math.max(now, atTime ?? now);
  try {
    // Firefox has no cancelAndHoldAtTime, and the obvious stand-in is worse than nothing:
    // cancelScheduledValues drops the parameter back to the last value SET rather than to where
    // its ramp had reached, and pinning `param.value` first pins the value NOW rather than the
    // value at `when`, which is a lookahead ahead. So there the cancel is simply skipped. The
    // scheduler's times only ever move forward and each ramp is shorter than its poll interval,
    // so consecutive ramps chain end to end and the result is the same line - the cancel earns
    // its keep only against something scheduled further ahead, which is a modulator's business
    // and a modulator owns its parameter outright.
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(when);
    // A glide of zero is a step, which is what a mode switch wants: ramping through an enum
    // sweeps every setting between the old one and the new one on the way past.
    if (glide > 0) param.linearRampToValueAtTime(value, when + glide);
    else param.setValueAtTime(value, when);
  } catch {
    // A context that has not started, or a parameter already scheduled past this point. Setting
    // the value outright is a worse sound than a ramp but a better one than throwing out of the
    // scheduler's tick and stopping the music.
    param.value = value;
  }
}

/**
 * Unpicks one `.param(name, audio(…))` connection: the gain the source feeds and the constant
 * that carried its offset.
 *
 * Written once and shared by the engine's disconnect and the track's teardown. A connection that
 * is only half removed leaves another track wired into a parameter that no longer exists and a
 * constant source running for the life of the page, and neither makes a sound to give itself
 * away.
 */
export function teardownParamConnection(conn) {
  if (!conn) return;
  try { conn.from?.disconnect?.(conn.scale); } catch { /* already detached */ }
  try { conn.scale?.disconnect?.(); } catch { /* already detached */ }
  if (conn.bias) {
    try { conn.bias.stop(); } catch { /* never started */ }
    try { conn.bias.disconnect(); } catch { /* already detached */ }
  }
}

/** One filled slot: the device, its node graph and how its parameters are reached. */
export class Slot {
  constructor(descriptor, built, wetGain, dryGain) {
    this.descriptor = descriptor;
    this.built = built;
    this.wetGain = wetGain;
    this.dryGain = dryGain;
    this.values = defaultValues(descriptor);
    // Option labels a device filled in at run time, past its descriptor's list - the wavetables
    // and impulse responses somebody loaded - by parameter id, then by index.
    this.extras = {};
    // What the processor last read of each control, by id, while a panel is watching it. Where
    // a modulator owns a control this is the only place its current value can be found.
    this.live = null;
  }

  /** The AudioParam a name reaches, if it is one. Worklet params and node params look the same here. */
  paramFor(name) {
    const param = findParam(this.descriptor, name);
    if (!param) return null;
    const audioParam = this.built.params?.[param.id] ?? this.built.node?.parameters?.get?.(param.id);
    return audioParam ? { param, audioParam } : { param, audioParam: null };
  }

  /** The names the panel prints for one enum's loaded slots, if any. */
  extrasFor(paramId) {
    return this.extras[paramId] ?? null;
  }
}

export class Track {
  constructor(ctx, id, master, registry) {
    this.ctx = ctx;
    this.id = id;
    this.registry = registry;

    // The chain, built empty. Every node here exists for the track's whole life so that changing
    // what is in a slot never means rebuilding the path around it.
    this.input = ctx.createGain();          // where a source (synth, sampler, bus read) arrives
    this.chainIn = ctx.createGain();        // the `gain` control: level INTO the chain
    this.postGain = ctx.createGain();       // the `postgain` control: level out of it
    this.panner = ctx.createStereoPanner(); // the `pan` control
    this.dryGain = ctx.createGain();        // the `dry` control: level to the master

    this.input.connect(this.chainIn);
    this.chainIn.connect(this.postGain);    // replaced as soon as a slot is filled
    this.postGain.connect(this.panner);
    this.panner.connect(this.dryGain);
    this.dryGain.connect(master);

    this.slots = new Map();                 // slot index -> Slot
    this.sends = new Map();                 // bus name -> GainNode
    this.source = null;                     // the instrument node, when there is one
    this.paramConnections = new Map();      // "slot:name" -> { scale, bias, from, source, gain, offset }
    this.sidechains = new Map();            // slot index -> { from, source } feeding the slot's second input
  }

  /**
   * Unpicks every signal patched onto one slot's parameters and says what they were, so the
   * engine can patch them onto whatever takes the slot next.
   *
   * A device swapped out from under a connection would otherwise leave that connection running
   * into a parameter of a processor that has been told to stop - a source feeding nothing, a
   * constant carrying an offset to nobody, and a parameter of the NEW device that reads as
   * driven and so refuses to be set, for as long as the page is open.
   */
  takeConnections(index) {
    const prefix = `${index}:`;
    const taken = [];
    for (const [key, conn] of [...this.paramConnections]) {
      if (!key.startsWith(prefix)) continue;
      teardownParamConnection(conn);
      this.paramConnections.delete(key);
      taken.push({ name: key.slice(prefix.length), source: conn.source, gain: conn.gain, offset: conn.offset });
    }
    return taken;
  }

  /**
   * Rebuilds the chain's wiring from whatever slots are filled, in slot order.
   *
   * Slot 0 is left strictly alone. The instrument is not a link in this chain - it feeds the
   * track's input, upstream of everything here - so disconnecting its output while rebuilding
   * the effects would take the whole track silent the first time anybody added an effect to it.
   */
  rewire() {
    this.chainIn.disconnect();
    for (const [index, slot] of this.slots) {
      if (index === 0) continue;
      slot.wetGain.disconnect();
      slot.dryGain.disconnect();
      slot.built.output?.disconnect?.();
    }
    const order = [...this.slots.keys()].filter((i) => i > 0).sort((a, b) => a - b);
    let cursor = this.chainIn;
    for (const index of order) {
      const slot = this.slots.get(index);
      cursor.connect(slot.built.input);
      cursor.connect(slot.dryGain);
      slot.built.output.connect(slot.wetGain);
      const join = this.ctx.createGain();
      slot.wetGain.connect(join);
      slot.dryGain.connect(join);
      cursor = join;
    }
    cursor.connect(this.postGain);
  }

  /**
   * Puts a device in a slot, replacing whatever was there.
   *
   * `build` is handed in rather than looked up here so the engine can decide between a stock
   * node graph and a worklet without this file knowing about either.
   */
  setSlot(index, descriptor, built) {
    this.clearSlot(index, { rewire: false });
    const wetGain = this.ctx.createGain();
    const dryGain = this.ctx.createGain();
    wetGain.gain.value = 1;
    dryGain.gain.value = 0;
    const slot = new Slot(descriptor, built, wetGain, dryGain);
    this.slots.set(index, slot);
    if (index === 0) {
      // The instrument is the source, not a link in the chain: it feeds the track's input.
      this.source = built;
      built.output.connect(this.input);
    } else {
      this.rewire();
    }
    return slot;
  }

  clearSlot(index, { rewire = true } = {}) {
    const slot = this.slots.get(index);
    if (!slot) return;
    this.takeConnections(index);
    this.clearSidechain(index);
    try {
      slot.built.output?.disconnect?.();
      slot.built.input?.disconnect?.();
      slot.built.dispose?.();
      slot.wetGain.disconnect();
      slot.dryGain.disconnect();
    } catch { /* a node already detached; nothing to undo */ }
    this.slots.delete(index);
    if (index === 0) this.source = null;
    else if (rewire) this.rewire();
  }

  /**
   * Feeds another node into a slot's second input - the carrier of a cross-modulator, the key of
   * a ducker, the modulator of a vocoder.
   *
   * Through a gain of its own rather than straight in, because `.audio("kick", { gain: 0.5 })`
   * carries one and because a level in the middle is how a key signal is usually set.
   */
  setSidechain(index, from, source, gain = 1) {
    this.clearSidechain(index);
    const slot = this.slots.get(index);
    const node = slot?.built.node;
    if (!slot?.descriptor.sidechain || !node) return false;
    const level = this.ctx.createGain();
    level.gain.value = gain;
    try {
      from.connect(level);
      level.connect(node, 0, 1);
    } catch {
      try { from.disconnect(level); } catch { /* never connected */ }
      return false;
    }
    this.sidechains.set(index, { from, level, source, gain });
    return true;
  }

  clearSidechain(index) {
    const held = this.sidechains.get(index);
    if (!held) return;
    try { held.from.disconnect(held.level); } catch { /* already detached */ }
    try { held.level.disconnect(); } catch { /* already detached */ }
    this.sidechains.delete(index);
  }

  /** Sets a channel-strip control. Returns false for one this engine does not implement yet. */
  setChannel(name, value, atTime, now) {
    switch (name) {
      case 'gain': rampParam(this.chainIn.gain, value, atTime, now); return true;
      case 'postgain': rampParam(this.postGain.gain, value, atTime, now); return true;
      case 'pan': rampParam(this.panner.pan, Math.min(1, Math.max(-1, value)), atTime, now); return true;
      case 'dry': rampParam(this.dryGain.gain, value, atTime, now); return true;
      default:
        if (name.startsWith('wet')) {
          const index = Number(name.slice(3));
          const slot = this.slots.get(index);
          if (!slot) return true;   // a wet level for a slot with nothing in it is not an error
          const m = Math.min(1, Math.max(0, value));
          rampParam(slot.wetGain.gain, m, atTime, now);
          rampParam(slot.dryGain.gain, 1 - m, atTime, now);
          return true;
        }
        return false;
    }
  }

  /**
   * Sets a device parameter from what `.param()` was given: a 0..1 position, an enum's label or
   * index, a toggle's 0 or 1. Returns false for a name the device does not have and null for an
   * argument the parameter cannot take - which for one that takes a sample is the engine's cue to
   * go and load it.
   */
  setParam(slotIndex, name, arg, atTime, now, glide) {
    const slot = this.slots.get(slotIndex);
    if (!slot) return false;
    const found = slot.paramFor(name);
    if (!found) return false;
    const value = argToValue(found.param, arg);
    if (value === null) return null;
    this._apply(slot, found, value, atTime, now, glide);
    return true;
  }

  /** Sets a device parameter to a REAL value - what a preset, a panel or a default hands over. */
  setParamValue(slotIndex, paramId, value, atTime, now, glide) {
    const slot = this.slots.get(slotIndex);
    if (!slot) return false;
    const found = slot.paramFor(paramId);
    if (!found) return false;
    this._apply(slot, found, clampParam(found.param, value), atTime, now, glide);
    return true;
  }

  _apply(slot, { param, audioParam }, value, atTime, now, glide) {
    slot.values[param.id] = value;
    if (audioParam) rampParam(audioParam, normalize(param, value), atTime, now, glide);
    else slot.built.set?.(param.id, value);
  }

  /** Every device's current parameter map - the web build's answer to a plugin program. */
  state() {
    const out = {};
    for (const [index, slot] of this.slots) {
      out[index] = { device: slot.descriptor.id, version: slot.descriptor.version, params: { ...slot.values } };
    }
    return out;
  }

  dispose() {
    for (const index of [...this.slots.keys()]) this.clearSlot(index, { rewire: false });
    for (const g of this.sends.values()) g.disconnect();
    this.sends.clear();
    for (const conn of this.paramConnections.values()) teardownParamConnection(conn);
    this.paramConnections.clear();
    try {
      this.input.disconnect();
      this.chainIn.disconnect();
      this.postGain.disconnect();
      this.panner.disconnect();
      this.dryGain.disconnect();
    } catch { /* already detached */ }
  }
}
