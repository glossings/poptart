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

import { TRACK_BEND_PARAM, argToValue, clampParam, defaultValues, findParam, normalize } from '../descriptor.mjs';

/** Channel-strip controls this engine implements. The rest warn once - see the engine. */
export const SUPPORTED_CHANNELS = Object.freeze(['gain', 'postgain', 'pan', 'dry', 'width', 'bassmono', 'bend', 'bendrange', 'out', 'grainsize', 'grainrate', 'grainpan', 'grainpos']);

/**
 * The strip's constant-power pan, the desktop's law: a sine/cosine pair referenced to the CENTER,
 * so a track at pan 0 leaves at the level it came in at and one panned all the way out is +3 dB
 * on the side it went to (see poptart.scd's Balance2 x sqrt(2)). Each side is scaled, never
 * summed across - panning a stereo track hard right plays its right channel, as the desktop does,
 * where the browser's own StereoPannerNode folds the left into it and gains up to 6 dB.
 */
export function panGains(pan) {
  const p = Math.min(1, Math.max(-1, Number(pan) || 0));
  const angle = ((p + 1) * Math.PI) / 4;
  return [Math.cos(angle) * Math.SQRT2, Math.sin(angle) * Math.SQRT2];
}

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
/**
 * How far ahead of "now" a change asked for now is placed.
 *
 * `now` is the main thread's reading of the clock, and the audio thread has already rendered
 * past it by the time this call is heard. A hold and a ramp scheduled at a time already rendered
 * are computed from the value the curve had THEN, so each one lands a step away from where the
 * parameter has actually got to - a small click sixty times a second under a dragged knob,
 * heard as noise riding the sound. A few milliseconds of lookahead puts every hold in the audio
 * thread's future, where a ramp joins the curve it interrupts. Below anybody's threshold for a
 * knob feeling late, and not applied to anything already scheduled ahead.
 */
const PARAM_LOOKAHEAD_SEC = 0.005;

export function rampParam(param, value, atTime, now, glide = PARAM_GLIDE_SEC) {
  const when = Math.max(now + PARAM_LOOKAHEAD_SEC, atTime ?? now);
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
    this.dryGain = ctx.createGain();        // the `dry` control: level to the master

    // THE STRIP, the desktop's order: width, then bass mono, then pan (see poptart.scd's track
    // synth). Width is mid/side - the sum left alone, the difference scaled, 0 mono and 4 four
    // times as wide - and it comes before the pan because narrowing then placing is a move and
    // placing then widening only smears it back. Bass mono high-passes the SIDE only, so below
    // the cutoff both channels are the mid; crossfaded in and out rather than switched.
    // `panner` is the strip's output - what every send, tap and analyser reads - and keeps the
    // name it had when it was one node.
    this.postGain.channelCount = 2;          // a mono source is heard in both sides, as before
    this.postGain.channelCountMode = 'explicit';
    this.postGain.channelInterpretation = 'speakers';
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.split = ctx.createChannelSplitter(2);
    this.mid = gain(1);
    this.width = gain(1);                    // the `width` control scales the side
    this.sideDry = gain(1);                  // bass mono off: the side as it is
    this.sideHigh = gain(0);                 // bass mono on: the side above the cutoff
    this.bassHp = ctx.createBiquadFilter();
    this.bassHp.type = 'highpass';
    this.bassHp.frequency.value = 120;
    this.sideOut = gain(1);
    this.sideInv = gain(-1);
    this.panL = gain(1);
    this.panR = gain(1);
    this.merge = ctx.createChannelMerger(2);
    this.panner = gain(1);
    this.panValue = 0;
    this.bassmonoHz = 0;
    this.grain = { size: 0.08, rate: 20, pan: 0, pos: 0 };

    this.input.connect(this.chainIn);
    this.chainIn.connect(this.postGain);    // replaced as soon as a slot is filled
    this.postGain.connect(this.split);
    // mid = (L + R) / 2 and side = (L - R) / 2, each built from the two channels with a gain.
    const half = (from, v, into) => { const g = gain(v); this.split.connect(g, from); g.connect(into); return g; };
    this._halves = [half(0, 0.5, this.mid), half(1, 0.5, this.mid), half(0, 0.5, this.width), half(1, -0.5, this.width)];
    this.width.connect(this.sideDry);
    this.width.connect(this.bassHp);
    this.bassHp.connect(this.sideHigh);
    this.sideDry.connect(this.sideOut);
    this.sideHigh.connect(this.sideOut);
    this.sideOut.connect(this.sideInv);
    // left = mid + side, right = mid - side, each scaled by its side of the pan.
    this.mid.connect(this.panL);
    this.sideOut.connect(this.panL);
    this.mid.connect(this.panR);
    this.sideInv.connect(this.panR);
    this.panL.connect(this.merge, 0, 0);
    this.panR.connect(this.merge, 0, 1);
    this.merge.connect(this.panner);
    this.panner.connect(this.dryGain);
    this.master = master;
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
      // And it plays the track's bend, as a signal into its own bend input.
      const bendIn = built.node?.parameters?.get?.(TRACK_BEND_PARAM);
      if (bendIn) {
        this.bendSource().connect(bendIn);
        this.bendInto = bendIn;
      }
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
    if (index === 0 && this.bendInto) {
      try { this.bendNode?.disconnect(this.bendInto); } catch { /* already detached */ }
      this.bendInto = null;
    }
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
      case 'pan': {
        this.panValue = Math.min(1, Math.max(-1, value));
        const [l, r] = panGains(this.panValue);
        rampParam(this.panL.gain, l, atTime, now);
        rampParam(this.panR.gain, r, atTime, now);
        return true;
      }
      // Pitch bend, in semitones, on one constant per track that everything playing reads
      // continuously - the instrument through its bend input, each sample voice through its
      // detune in cents (see bendCents) - so a bend moves the notes already sounding, as the
      // desktop's voices reading the track's bend bus do. An lfo() or env() on bend drives the
      // same constant (see the engine's _targetParam).
      case 'bend': {
        const semis = Math.min(48, Math.max(-48, Number(value) || 0));
        this.bendSemis = semis;
        rampParam(this.bendSource().offset, semis, atTime, now);
        return true;
      }
      // How far a plugin's pitch-bend message reaches: a MIDI matter, and the browser's
      // instruments take the bend in semitones directly, so there is nothing to set.
      case 'bendrange': return true;
      // Which output pair the track plays to, from 1 - where it goes is the engine's to wire,
      // since only it knows how many pairs there are (see WebAudioEngine#_routeOut).
      case 'out': this.outValue = Number(value) || 1; return true;
      // The granular voice's live controls, read by each grain as it starts (see the engine's
      // _playGrains). Held here because a grain belongs to a voice, and the voice to the track.
      case 'grainsize': this.grain.size = Number(value); return true;
      case 'grainrate': this.grain.rate = Number(value); return true;
      case 'grainpan': this.grain.pan = Number(value); return true;
      case 'grainpos': this.grain.pos = Number(value); return true;
      case 'width': rampParam(this.width.gain, Math.min(4, Math.max(0, value)), atTime, now); return true;
      case 'bassmono': {
        // 0 is off; anything else is the cutoff in Hz, held to the desktop's 20 Hz - 2 kHz.
        const on = value > 0;
        this.bassmonoHz = on ? Math.min(2000, Math.max(20, value)) : 0;
        if (on) rampParam(this.bassHp.frequency, this.bassmonoHz, atTime, now);
        rampParam(this.sideDry.gain, on ? 0 : 1, atTime, now);
        rampParam(this.sideHigh.gain, on ? 1 : 0, atTime, now);
        return true;
      }
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
   * The track's bend as a signal in semitones, started on first use - with `bendCents` beside it,
   * the same signal in cents, which is what a sample voice's detune takes.
   */
  bendSource() {
    if (!this.bendNode) {
      this.bendNode = this.ctx.createConstantSource();
      this.bendNode.offset.value = this.bendSemis ?? 0;
      this.bendNode.start();
      this.bendCents = this.ctx.createGain();
      this.bendCents.gain.value = 100;
      this.bendNode.connect(this.bendCents);
    }
    return this.bendNode;
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
    for (const index of [...this.sidechains.keys()]) this.clearSidechain(index);
    // The bend constant is a started source: unplugged but not stopped, it runs for the life of
    // the page.
    if (this.bendNode) {
      try { this.bendNode.stop(); } catch { /* already stopped */ }
      try { this.bendNode.disconnect(); } catch { /* already detached */ }
      try { this.bendCents.disconnect(); } catch { /* already detached */ }
      this.bendNode = null;
      this.bendCents = null;
    }
    try {
      this.input.disconnect();
      this.chainIn.disconnect();
      this.postGain.disconnect();
      this.panner.disconnect();
      this.merge.disconnect();
      this.split.disconnect();
      this.dryGain.disconnect();
    } catch { /* already detached */ }
  }
}
