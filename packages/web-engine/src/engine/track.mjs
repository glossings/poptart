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
import { buildRouting, loopLatencies } from './routing.mjs';

/** Channel-strip controls this engine implements. The rest warn once - see the engine. */
export const SUPPORTED_CHANNELS = Object.freeze(['gain', 'postgain', 'pan', 'dry', 'mon', 'width', 'bassmono', 'bend', 'bendrange', 'out', 'grainsize', 'grainrate', 'grainpan', 'grainpos',
  'trim', 'eqlo', 'eqmid', 'eqhi', 'djf', 'djres', 'fader', 'deck', 'cue', 'mdeck']);

/**
 * The DJ stage's controls at rest (see the stage in Track): unity trim, bands, fader and deck
 * gain, the filter at its center detent with no resonance, no cue send. A track sounds exactly as
 * it would without the stage until a mix session touches one - the desktop's DJ_NEUTRAL.
 */
export const DJ_NEUTRAL = Object.freeze({ trim: 1, eqlo: 1, eqmid: 1, eqhi: 1, djf: 0, djres: 0, fader: 1, deck: 1, cue: 0 });

/** The isolator's crossovers, the desktop's djIsolator: Linkwitz-Riley at 250 Hz and 2.5 kHz. */
const DJ_XO_LOW = 250;
const DJ_XO_HIGH = 2500;
/**
 * A second-order Butterworth's Q, as a Web Audio lowpass or highpass takes it - in decibels,
 * not as the linear 1/sqrt(2) a cookbook writes, so -3.01 dB. Two in a row are the fourth-order
 * Linkwitz-Riley the isolator is built from.
 */
const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/**
 * How long the stage's controls take to reach a value. They stream from the desk at ~20 values a
 * second, and a glide shorter than the gap between them reproduces the steps (a stepped resonant
 * cutoff reads as tremolo) - the desktop lags these by 80 ms, and the filter's cutoff by 150.
 */
const DJ_GLIDE_SEC = 0.08;
const DJ_FILTER_GLIDE_SEC = 0.15;
/** How long the EQ and the filter take to cross in and out of the path at exact neutral. */
const DJ_XFADE_SEC = 0.05;

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

/** How finely the pan law is tabled for the shapers that read it. Odd, so pan 0 is a point of its own. */
const PAN_CURVE_POINTS = 1025;

/**
 * One side of the pan law as a waveshaper curve: the input, -1..1, is the pan, and the output is
 * that side's gain. A shaper clamps what is past its ends, which is the clamp a set pan gets.
 */
export function panCurve(side) {
  const curve = new Float32Array(PAN_CURVE_POINTS);
  for (let i = 0; i < PAN_CURVE_POINTS; i++) curve[i] = panGains(-1 + (2 * i) / (PAN_CURVE_POINTS - 1))[side];
  return curve;
}

/** The grain controls, which each grain reads as it starts rather than a node reading them. */
export const GRAIN_CHANNEL_FIELDS = Object.freeze({ grainsize: 'size', grainrate: 'rate', grainpan: 'pan', grainpos: 'pos' });

/** A branch level or pan (rl/rp) or a crossover's frequency (xo) - the controls a routing plan adds. */
const ROUTE_CONTROL = /^(rl|rp|xo)\d+$/;

/** Where a crossover's Frequency control rests until something sets it: 1 kHz, as a position. */
const CROSSOVER_REST = (1000 - 20) / (20000 - 20);

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
 * A frequency moved to a value along an exponential curve, which is how a sweep is heard: equal
 * times for equal musical intervals. A glide of zero steps.
 */
function glideFrequency(param, hz, atTime, now, glide) {
  const when = Math.max(now + PARAM_LOOKAHEAD_SEC, atTime ?? now);
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(when);
    if (glide > 0) param.exponentialRampToValueAtTime(hz, when + glide);
    else param.setValueAtTime(hz, when);
  } catch {
    param.value = hz;
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
    // The value each parameter the pattern is driving had before the pattern took it, by id -
    // where releaseParam puts it back (see Track#holdParam).
    this.resting = new Map();
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
  constructor(ctx, id, master, registry, desk = null) {
    this.ctx = ctx;
    this.id = id;
    this.registry = registry;
    // Where the DJ stage's taps go: the engine's headphone cue bus and its two deck meters.
    this.desk = desk;

    // The chain, built empty. Every node here exists for the track's whole life so that changing
    // what is in a slot never means rebuilding the path around it.
    this.input = ctx.createGain();          // where a source (synth, sampler, bus read) arrives
    this.chainIn = ctx.createGain();        // the `gain` control: level INTO the chain
    this.stripSeen = new Set(); // the strip controls set so far (see setChannel)
    this.postGain = ctx.createGain();       // the `postgain` control: level out of it
    this.dryGain = ctx.createGain();        // the `dry` control: level to the master
    // The `mon` control (a label's `M` marker): the desktop sends a monitored track to the
    // headphone cue pair and nothing to the room. There is no cue pair here, so it is a gate on
    // everything the room hears - the direct output and the bus sends - with the taps and
    // analysers still reading the panner.
    this.monGate = ctx.createGain();

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
    // Bass mono's highpass on the side, made the first time bass mono is asked for (see _bassMono):
    // a filter nobody uses costs the same as one somebody does.
    this.bassHp = null;
    this.sideOut = gain(1);
    this.sideInv = gain(-1);
    // The pan is ONE control - a constant from -1 to 1 - and each side's gain is read off it
    // through the pan law, so an lfo() on pan moves both sides together at audio rate, which two
    // gains set one at a time could not. The gains themselves rest at zero: the law is all of them.
    this.panL = gain(0);
    this.panR = gain(0);
    this.panCtl = ctx.createConstantSource();
    this.panCtl.offset.value = 0;
    const law = (side, into) => {
      const shaper = ctx.createWaveShaper();
      shaper.curve = panCurve(side);
      this.panCtl.connect(shaper);
      shaper.connect(into.gain);
      return shaper;
    };
    this.panLaw = [law(0, this.panL), law(1, this.panR)];
    this.panCtl.start();
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

    // THE DJ STAGE, the desktop's order: trim, the three-band isolator, the one-knob filter, and
    // then - on the direct path only - the stem's fader and its deck's crossfader gain. The cue
    // and the deck meter read the stage's output before either of those, so a deck that is out of
    // the mix is still heard in the headphones and still metered. The sends leave from before the
    // stage but after the fader, as the desktop's do: a crossfade applies each deck's gain exactly
    // once (a bus ends at some track's own output, which wears it), and a gated stem goes quiet
    // including whatever it was feeding.
    //
    // The EQ and the filter are not in the path at all until they leave neutral, which is the
    // desktop's crossfade at exact neutral with the nodes built only when they are first wanted:
    // a track nobody mixes costs nothing for having a stage.
    this.djTrim = gain(1);
    this.djMid = gain(1);                    // between the EQ and the filter
    this.djLive = gain(1);                   // the stage's output: what cue, meter and fader read
    this.djTrim.connect(this.djMid);
    this.djMid.connect(this.djLive);
    this.djEq = null;                        // the isolator, once a band has moved
    this.djFilter = null;                    // the filter, once it has left its center
    this.dj = { ...DJ_NEUTRAL, mdeck: -1, mon: 0 };
    this.cueGain = gain(0);                  // cue (or mon), into the headphone cue bus
    this.meterGain = null;                   // into the deck meter the track reports to
    this.meterDeck = -1;
    this.fxDirect = gain(1);                 // the direct path's share while the FX unit is in
    this.faderGain = gain(1);
    this.deckGain = gain(1);
    this.fx = null;                          // the FX unit's send, once one is set (see setFxSend)
    this.sendMain = gain(1);                 // the sends' own copy of mon's gate...
    this.sendFader = gain(1);                // ...and of the fader
    this.panner.connect(this.djTrim);
    this.djLive.connect(this.cueGain);
    if (desk?.cueBus) this.cueGain.connect(desk.cueBus);
    this.djLive.connect(this.monGate);
    this.monGate.connect(this.fxDirect);
    this.fxDirect.connect(this.faderGain);
    this.faderGain.connect(this.deckGain);
    this.deckGain.connect(this.dryGain);
    this.panner.connect(this.sendMain);
    this.sendMain.connect(this.sendFader);
    this.master = master;
    this.dryGain.connect(master);

    this.slots = new Map();                 // slot index -> Slot
    this.sends = new Map();                 // bus name -> GainNode
    this.sendPoints = new Map();            // send index -> { mon, fader }: the gates a send written inside the chain leaves through (see sendFrom)
    this.source = null;                     // the instrument node, when there is one
    this.sidechains = new Map();            // slot index -> { from, source } feeding the slot's second input
    this.wetControls = new Map();           // slot index -> the constant its wet level is (see wetControl)
    // Branches (Sig#split, Sig#bands): the plan the chain is wired by, or null for the plain line;
    // what the last wiring built, to take down before the next; and the route controls - branch
    // levels and pans (rl/rp), crossover frequencies (xo) - kept for the track's life like the wet
    // ones. A .bands() crossover is not one of the track's slots: it is a Crossover device the
    // track keeps for the wiring, by crossover id ('x1'), made with makeCrossover (the engine's
    // device builder, handed in by the engine).
    this.routing = null;
    this.crossovers = new Map();            // crossover id -> its built device
    this.makeCrossover = null;
    this.routeBuild = null;
    this.routeControls = new Map();         // control name -> constant source
    this.routePanLaws = new Map();          // gain index -> [left, right] pan-law shapers off rp<k>
    this.slotJoins = [];                    // the per-slot nodes the last wiring made
    this.grainControls = new Map();         // grain control name -> the constant its value is (see grainControl)
    this.heldDrives = new Map();            // 'width' / 'bassmono' -> the clamped constant they move through (see _heldControl)
  }

  /**
   * The constant a grain control's value is: what each .grain() voice reads as a grain starts,
   * and what a modulator on the control drives. Made the first time anything asks.
   */
  grainControl(name) {
    let ctl = this.grainControls.get(name);
    if (!ctl) {
      ctl = this.ctx.createConstantSource();
      ctl.offset.value = this.grain[GRAIN_CHANNEL_FIELDS[name]];
      ctl.start();
      this.grainControls.set(name, ctl);
    }
    return ctl;
  }

  /**
   * The wet level of the slot at `index`, as one constant from 0 to 1: the slot's wet gain is it
   * and its dry gain is one minus it. It belongs to the POSITION, not the device, as the desktop's
   * wetN is a control of the track synth - a level or an lfo() set on it carries across whatever
   * device is put in that slot next.
   */
  wetControl(index) {
    let ctl = this.wetControls.get(index);
    if (!ctl) {
      ctl = this.ctx.createConstantSource();
      ctl.offset.value = 1;
      ctl.start();
      this.wetControls.set(index, ctl);
    }
    return ctl;
  }

  /**
   * The AudioParam an lfo(), env(), midicc() or osc() on a channel control drives, or null for a
   * control that has no single value to drive (out, bendrange). Driving bass mono turns it on: the
   * modulator is its cutoff in Hz, as a set value is. A grain control's is the constant every
   * grain voice on the track reads (see grainControl).
   */
  driveChannel(name, now) {
    switch (name) {
      case 'gain': return this.chainIn.gain;
      case 'postgain': return this.postGain.gain;
      case 'dry': return this.dryGain.gain;
      case 'width': return this._heldControl('width', this.width.gain, 0, 4, 8, 5);
      case 'pan': return this.panCtl.offset;
      case 'bend': return this.bendSource().offset;
      case 'bassmono':
        this.bassmonoHz = this.bassmonoHz || 120;
        rampParam(this.sideDry.gain, 0, now, now);
        rampParam(this.sideHigh.gain, 1, now, now);
        return this._heldControl('bassmono', this._bassMono().frequency, 20, 2000, 4000, 401);
      default: {
        if (name in GRAIN_CHANNEL_FIELDS) return this.grainControl(name).offset;
        if (ROUTE_CONTROL.test(name)) return this.routeControl(name).offset;
        const index = Number(/^wet(\d+)$/.exec(name)?.[1]);
        return index > 0 ? this.wetControl(index).offset : null;
      }
    }
  }

  /**
   * The constant a driven control moves through where a bare AudioParam would not hold it to the
   * range a set value is held to: width to 0..4, bass mono's cutoff to 20 Hz - 2 kHz (a filter at
   * 0 Hz or below breaks) - the desktop's ranges for both, set and driven. The constant goes
   * through a shaper whose curve is that clamp into the real parameter, which rests at 0 from then
   * on, and set values move the constant too (see _stripParam), so a set value and a driven one
   * are one value. The curve's points fall on the clamp's corners, so the shaper's linear
   * interpolation IS the clamp; past `reach` either way the shaper holds its end, which is too.
   */
  _heldControl(name, param, lo, hi, reach, points) {
    let held = this.heldDrives.get(name);
    if (!held) {
      const ctl = this.ctx.createConstantSource();
      ctl.offset.value = param.value;
      const scale = this.ctx.createGain();
      scale.gain.value = 1 / reach;
      const shaper = this.ctx.createWaveShaper();
      const curve = new Float32Array(points);
      for (let i = 0; i < points; i++) curve[i] = Math.min(hi, Math.max(lo, -reach + (2 * reach * i) / (points - 1)));
      shaper.curve = curve;
      ctl.connect(scale);
      scale.connect(shaper);
      shaper.connect(param);
      try { param.cancelScheduledValues(0); } catch { /* nothing scheduled */ }
      try { param.value = 0; } catch { /* a param that refuses a direct set */ }
      ctl.start();
      held = { ctl, scale, shaper };
      this.heldDrives.set(name, held);
    }
    return held.ctl.offset;
  }

  /** Where a strip control's value goes: its held constant once it has been driven, else the parameter. */
  _stripParam(name, param) {
    return this.heldDrives.get(name)?.ctl.offset ?? param;
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
    this.routeBuild?.teardown();
    this.routeBuild = null;
    for (const node of this.slotJoins.splice(0)) { try { node.disconnect(); } catch { /* already detached */ } }
    for (const built of this.crossovers.values()) { try { built.node.disconnect(); } catch { /* already detached */ } }
    this._keepCrossovers(this.routing?.order ?? []);
    this._keepSendPoints();
    if (this.routing) {
      this.routeBuild = buildRouting(this.ctx, this.routing, {
        input: this.chainIn,
        output: this.postGain,
        slotIO: (index) => this._slotIO(index),
        gainStage: (k) => this.routeGain(k),
        sendPoint: (i) => this.sendPoint(i).mon,
      });
      this._tellLoops();
      return;
    }
    this._tellLoops();
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
   * Wires the chain by a routing plan (pattern-core's route.mjs) - branches summed, bands split by
   * crossovers - or, with null, back to the plain line. Rebuilds only the wiring: the devices, the
   * strip and every route control stay as they are, so a modulator on a branch level carries on.
   */
  setRouting(plan) {
    this.routing = plan ?? null;
    this.rewire();
  }

  /**
   * What .bus() send `i` (its index among the pattern's sends) leaves from: the post-fader send
   * output, or - for a send the plan places inside the chain - the gates of its own point, fed by
   * the wiring with what the send taps. Those gates are the monitor's and the fader's, as the
   * post-fader send's are: a tapped send still wears the fader, so a deck's crossfade applies to
   * what a track feeds and a monitored track feeds no bus.
   */
  sendFrom(i) {
    return this.routing?.sends?.[i] ? this.sendPoint(i).fader : this.sendFader;
  }

  // The point for send `i`, made on first use, with the gates at the track's current values.
  sendPoint(i) {
    let point = this.sendPoints.get(i);
    if (!point) {
      const gain = (v) => { const g = this.ctx.createGain(); g.gain.value = v; return g; };
      point = { mon: gain(1 - this.dj.mon), fader: gain(this.dj.fader) };
      point.mon.connect(point.fader);
      this.sendPoints.set(i, point);
    }
    return point;
  }

  // The points the wiring still feeds are kept; the rest are let go (the engine moves any send
  // leaving from one back to the post-fader output, see WebAudioEngine#setRouting).
  _keepSendPoints() {
    const sends = this.routing?.sends ?? {};
    for (const [i, point] of this.sendPoints) {
      if (sends[i]) continue;
      for (const node of [point.mon, point.fader]) { try { node.disconnect(); } catch { /* already detached */ } }
      this.sendPoints.delete(i);
    }
  }

  // One slot's ends for a routed chain: its device's input and dry path in, the wet/dry join out -
  // or, for a slot with nothing in it (a device not loaded yet), a wire. A crossover ('x1') is the
  // track's own Crossover device, with two more outputs and a key input, which the plan reads and
  // feeds (see routing.mjs).
  _slotIO(index) {
    if (typeof index === 'string') return this._crossoverIO(index);
    const slot = index > 0 ? this.slots.get(index) : null;
    const join = this.ctx.createGain();
    this.slotJoins.push(join);
    if (!slot) return { input: [join], output: join };
    slot.built.output.connect(slot.wetGain);
    slot.wetGain.connect(join);
    slot.dryGain.connect(join);
    const io = { input: [slot.built.input, slot.dryGain], output: join };
    const node = slot.built.node;
    if (node && (slot.descriptor.channels?.outputs ?? 1) >= 3) {
      [io.rest, io.ap] = [1, 2].map((output) => {
        const tap = this.ctx.createGain();
        this.slotJoins.push(tap);
        node.connect(tap, output);
        return tap;
      });
    }
    if (node && slot.descriptor.channels?.key) io.key = { node, input: 1 };
    // A feedback loop's way out (the second output) and back in (the key).
    if (node && slot.descriptor.loop) {
      const tap = this.ctx.createGain();
      this.slotJoins.push(tap);
      node.connect(tap, 1);
      io.loop = tap;
      io.ret = { node, input: 1 };
    }
    return io;
  }

  /**
   * Tells each device with a feedback loop how late its loop's chain comes back - the render
   * quantum the return is held to, and the delay of the devices in the chain - or that it has none
   * (-1), whenever that changes. Every wiring passes through here, so a device opening into a slot
   * of the chain, or the chain going, is told.
   */
  _tellLoops() {
    const returns = this.routing?.returns ?? {};
    const quantum = (this.ctx.renderQuantumSize ?? 128) / this.ctx.sampleRate;
    const chain = loopLatencies(this.routing, (p) => this.slots.get(p)?.descriptor.latencySec ?? 0);
    for (const [index, slot] of this.slots) {
      if (!slot.descriptor.loop) continue;
      const sec = returns[index] ? quantum + (chain[index] ?? 0) : -1;
      if (slot.loopSec === sec) continue;
      slot.loopSec = sec;
      try { slot.built.node?.port?.postMessage({ kind: 'loop', sec }); } catch { /* a node already torn down */ }
    }
  }

  // A crossover's three outputs and its key, off the device the track keeps for it.
  _crossoverIO(id) {
    let built = this.crossovers.get(id);
    if (!built && this.makeCrossover) {
      built = this.makeCrossover();
      // Its Frequency is the plan's xo<k> control, a position, for its whole life - so a modulator
      // on the control stays connected however often the wiring is rebuilt.
      const freq = built.node?.parameters?.get?.('frequency');
      if (freq) {
        try { freq.value = 0; } catch { /* a param that refuses a direct set */ }
        this.routeControl(`xo${id.slice(1)}`).connect(freq);
      }
      this.crossovers.set(id, built);
    }
    if (!built?.node) {
      const join = this.ctx.createGain();
      this.slotJoins.push(join);
      return { input: [join], output: join };
    }
    const [output, rest, ap] = [0, 1, 2].map((k) => {
      const tap = this.ctx.createGain();
      this.slotJoins.push(tap);
      built.node.connect(tap, k);
      return tap;
    });
    return { input: [built.node], output, rest, ap, key: { node: built.node, input: 1 } };
  }

  // The crossovers the wiring still uses are kept; the rest are let go.
  _keepCrossovers(order) {
    const used = new Set(order.filter((p) => typeof p === 'string'));
    for (const [id, built] of this.crossovers) {
      if (used.has(id)) continue;
      const freq = built.node?.parameters?.get?.('frequency');
      try { if (freq) this.routeControls.get(`xo${id.slice(1)}`)?.disconnect(freq); } catch { /* already detached */ }
      try { built.node?.disconnect(); } catch { /* already detached */ }
      built.dispose?.();
      this.crossovers.delete(id);
    }
  }

  /** Bass mono's highpass on the side, made on first use. */
  _bassMono() {
    if (!this.bassHp) {
      this.bassHp = this.ctx.createBiquadFilter();
      this.bassHp.type = 'highpass';
      this.bassHp.frequency.value = 120;
      this.width.connect(this.bassHp);
      this.bassHp.connect(this.sideHigh);
    }
    return this.bassHp;
  }

  /** A route control's constant (rl/rp/xo), made at its neutral value on first use. */
  routeControl(name) {
    let ctl = this.routeControls.get(name);
    if (!ctl) {
      ctl = this.ctx.createConstantSource();
      ctl.offset.value = name.startsWith('rl') ? 1 : name.startsWith('xo') ? CROSSOVER_REST : 0;
      ctl.start();
      this.routeControls.set(name, ctl);
    }
    return ctl;
  }

  /** Gain k's level and its two sides of the pan law, which the wiring connects into each use. */
  routeGain(k) {
    let laws = this.routePanLaws.get(k);
    if (!laws) {
      const pan = this.routeControl(`rp${k}`);
      laws = [0, 1].map((side) => {
        const shaper = this.ctx.createWaveShaper();
        shaper.curve = panCurve(side);
        pan.connect(shaper);
        return shaper;
      });
      this.routePanLaws.set(k, laws);
    }
    return { level: this.routeControl(`rl${k}`), panL: laws[0], panR: laws[1] };
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
    const slot = new Slot(descriptor, built, wetGain, dryGain);
    if (index > 0) {
      // The mix is the position's wet control: wet = control, dry = 1 - control.
      wetGain.gain.value = 0;
      dryGain.gain.value = 1;
      const ctl = this.wetControl(index);
      slot.wetInvert = this.ctx.createGain();
      slot.wetInvert.gain.value = -1;
      ctl.connect(wetGain.gain);
      ctl.connect(slot.wetInvert);
      slot.wetInvert.connect(dryGain.gain);
    }
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
    if (slot.wetInvert) {
      const ctl = this.wetControls.get(index);
      try { ctl?.disconnect(slot.wetGain.gain); } catch { /* already detached */ }
      try { ctl?.disconnect(slot.wetInvert); } catch { /* already detached */ }
      try { slot.wetInvert.disconnect(); } catch { /* already detached */ }
    }
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
  setSidechain(index, from, source, gain = 1, link = null) {
    this.clearSidechain(index);
    const slot = this.slots.get(index);
    const node = slot?.built.node;
    if (!slot?.descriptor.sidechain || !node) return false;
    const level = this.ctx.createGain();
    level.gain.value = gain;
    let edge = null;
    try {
      // `link` wires a route from another track or bus, so a loop through it can be delayed.
      if (link) edge = link(from, level);
      else from.connect(level);
      level.connect(node, 0, 1);
    } catch {
      if (edge) edge.unlink();
      else { try { from.disconnect(level); } catch { /* never connected */ } }
      return false;
    }
    this.sidechains.set(index, { from, level, source, gain, edge });
    return true;
  }

  clearSidechain(index) {
    const held = this.sidechains.get(index);
    if (!held) return;
    if (held.edge) held.edge.unlink();
    else { try { held.from.disconnect(held.level); } catch { /* already detached */ } }
    try { held.level.disconnect(); } catch { /* already detached */ }
    this.sidechains.delete(index);
  }

  /** Sets a channel-strip control. Returns false for one this engine does not implement yet. */
  setChannel(name, value, atTime, now) {
    // A control's first value is where the track STARTS, so it is stepped to at once rather than
    // glided to from the node's own default (1, for the gains): gliding, a new track's first hit
    // played louder than its .postgain() said - by 1.7x at postgain 0.25.
    const g = this.stripSeen.has(name) ? undefined : 0;
    if (g === 0) atTime = now;
    this.stripSeen.add(name);
    switch (name) {
      case 'gain': rampParam(this.chainIn.gain, value, atTime, now, g); return true;
      case 'postgain': rampParam(this.postGain.gain, value, atTime, now, g); return true;
      case 'pan': {
        this.panValue = Math.min(1, Math.max(-1, value));
        rampParam(this.panCtl.offset, this.panValue, atTime, now, g);
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
        rampParam(this.bendSource().offset, semis, atTime, now, g);
        return true;
      }
      // How far a plugin's pitch-bend message reaches: a MIDI matter, and the browser's
      // instruments take the bend in semitones directly, so there is nothing to set.
      case 'bendrange': return true;
      // Which output pair the track plays to, from 1 - where it goes is the engine's to wire,
      // since only it knows how many pairs there are (see WebAudioEngine#_routeOut).
      case 'out': this.outValue = Number(value) || 1; return true;
      // The granular voice's live controls, read by each grain as it starts (see the engine's
      // _playGrains). Stepped, not glided, as on the desktop: a grain takes one value and keeps it.
      case 'grainsize': case 'grainrate': case 'grainpan': case 'grainpos': {
        const v = Number(value);
        this.grain[GRAIN_CHANNEL_FIELDS[name]] = v;
        const ctl = this.grainControls.get(name);
        if (ctl && Number.isFinite(v)) {
          try { ctl.offset.setValueAtTime(v, Math.max(now, atTime ?? now)); } catch { ctl.offset.value = v; }
        }
        return true;
      }
      case 'width': rampParam(this._stripParam('width', this.width.gain), Math.min(4, Math.max(0, value)), atTime, now, g); return true;
      case 'bassmono': {
        // 0 is off; anything else is the cutoff in Hz, held to the desktop's 20 Hz - 2 kHz.
        const on = value > 0;
        this.bassmonoHz = on ? Math.min(2000, Math.max(20, value)) : 0;
        if (on) rampParam(this._stripParam('bassmono', this._bassMono().frequency), this.bassmonoHz, atTime, now, g);
        rampParam(this.sideDry.gain, on ? 0 : 1, atTime, now, g);
        rampParam(this.sideHigh.gain, on ? 1 : 0, atTime, now, g);
        return true;
      }
      case 'dry': rampParam(this.dryGain.gain, value, atTime, now, g); return true;
      // Monitor (a label's `M`): the track plays to the headphone cue in full and to nothing the
      // room hears - not the direct output and not its sends. The taps keep reading it.
      case 'mon': {
        this.dj.mon = value > 0 ? 1 : 0;
        rampParam(this.monGate.gain, 1 - this.dj.mon, atTime, now, g);
        rampParam(this.sendMain.gain, 1 - this.dj.mon, atTime, now, g);
        for (const point of this.sendPoints.values()) rampParam(point.mon.gain, 1 - this.dj.mon, atTime, now, g);
        this._djCue(atTime, now, g);
        return true;
      }
      case 'trim': case 'eqlo': case 'eqmid': case 'eqhi': case 'djf': case 'djres':
      case 'fader': case 'deck': case 'cue': case 'mdeck':
        this._djSet(name, Number(value), atTime, now, g);
        return true;
      default:
        if (ROUTE_CONTROL.test(name)) {
          // A crossover frequency is a position on the Crossover's control, held to its range.
          const v = name.startsWith('xo') ? Math.min(1, Math.max(0, value)) : value;
          rampParam(this.routeControl(name).offset, v, atTime, now, g);
          return true;
        }
        if (name.startsWith('wet')) {
          // Kept for an empty slot too: the level waits for whatever device is put there.
          const index = Number(name.slice(3));
          if (!(index > 0)) return false;
          rampParam(this.wetControl(index).offset, Math.min(1, Math.max(0, value)), atTime, now, g);
          return true;
        }
        return false;
    }
  }

  // -- the DJ stage ----------------------------------------------------------------------------

  /** One stage control, clamped to the desktop's ranges. `g` is the first-value step (see setChannel). */
  _djSet(name, value, atTime, now, g) {
    const v = Number.isFinite(value) ? value : DJ_NEUTRAL[name] ?? 0;
    const clamp = (lo, hi) => Math.min(hi, Math.max(lo, v));
    switch (name) {
      case 'trim':
        this.dj.trim = clamp(0, 4);
        rampParam(this.djTrim.gain, this.dj.trim, atTime, now, g ?? DJ_GLIDE_SEC);
        break;
      case 'eqlo': case 'eqmid': case 'eqhi':
        this.dj[name] = clamp(0, 2);
        this._djEq(atTime, now, g);
        break;
      case 'djf': case 'djres':
        this.dj[name] = name === 'djf' ? clamp(-1, 1) : clamp(0, 1);
        this._djFilter(atTime, now, g);
        break;
      case 'fader':
        this.dj.fader = clamp(0, 1);
        rampParam(this.faderGain.gain, this.dj.fader, atTime, now, g ?? DJ_GLIDE_SEC);
        rampParam(this.sendFader.gain, this.dj.fader, atTime, now, g ?? DJ_GLIDE_SEC);
        for (const point of this.sendPoints.values()) rampParam(point.fader.gain, this.dj.fader, atTime, now, g ?? DJ_GLIDE_SEC);
        if (this.fx) rampParam(this.fx.fader.gain, this.dj.fader, atTime, now, g ?? DJ_GLIDE_SEC);
        break;
      case 'deck':
        this.dj.deck = clamp(0, 1);
        rampParam(this.deckGain.gain, this.dj.deck, atTime, now, g ?? DJ_GLIDE_SEC);
        break;
      case 'cue':
        this.dj.cue = clamp(0, 1);
        this._djCue(atTime, now, g);
        break;
      case 'mdeck':
        this._djMeter(Math.round(v));
        break;
      default:
        break;
    }
  }

  /**
   * The DJ FX unit's send: the finished stage (post trim, EQ and filter), gated like the direct
   * path by the fader and by monitor, but NOT by the crossfader - the unit's return is a track of
   * this deck and wears that gain itself, so a crossfade applies it exactly once. An INSERT, not an
   * aux: the direct path closes by as much as the send opens, on the same glide, so switching the
   * unit in is a crossfade between two paths carrying the same signal. `into` is the bus the
   * deck's return reads; null parks the send.
   */
  setFxSend(into, level, now, link = null) {
    const amt = into ? Math.min(1, Math.max(0, Number(level) || 0)) : 0;
    if (!this.fx && amt === 0) return;
    if (!this.fx) {
      const send = this.ctx.createGain();
      send.gain.value = 0;
      const fader = this.ctx.createGain();
      fader.gain.value = this.dj.fader;
      this.monGate.connect(send);
      send.connect(fader);
      this.fx = { send, fader, into: null };
    }
    if (this.fx.into !== into) {
      if (this.fx.edge) this.fx.edge.unlink();
      else { try { this.fx.fader.disconnect(); } catch { /* not connected */ } }
      this.fx.edge = null;
      if (into && link) this.fx.edge = link(this.fx.fader, into);
      else if (into) this.fx.fader.connect(into);
      this.fx.into = into;
    }
    rampParam(this.fx.send.gain, amt, now, now, DJ_GLIDE_SEC);
    rampParam(this.fxDirect.gain, 1 - amt, now, now, DJ_GLIDE_SEC);
  }

  /** The headphone send: the cue level, or all of it for a monitored track. */
  _djCue(atTime, now, g) {
    rampParam(this.cueGain.gain, Math.max(this.dj.cue, this.dj.mon), atTime, now, g ?? DJ_XFADE_SEC);
  }

  /** Which deck meter the track reports to: 0 is A, 1 is B, anything else none. */
  _djMeter(deck) {
    const want = deck === 0 || deck === 1 ? deck : -1;
    if (want === this.meterDeck) return;
    if (this.meterGain) {
      try { this.meterGain.disconnect(); } catch { /* already detached */ }
      try { this.djLive.disconnect(this.meterGain); } catch { /* already detached */ }
      this.meterGain = null;
    }
    this.meterDeck = want;
    this.dj.mdeck = want;
    const into = want >= 0 ? this.desk?.deckMeters?.[want] : null;
    if (!into) return;
    this.meterGain = this.ctx.createGain();
    this.djLive.connect(this.meterGain);
    this.meterGain.connect(into);
  }

  /**
   * The three-band isolator, the desktop's djIsolator: a Linkwitz-Riley tree (250 Hz, then
   * 2.5 kHz on the upper half, with the low band through the 2.5 kHz pair's all-pass so the three
   * carry the same phase and sum flat). 0 on a band is a true kill and nothing boosts its
   * neighbors. Flat but phase-shifted, so at exact neutral it is crossfaded out of the path.
   */
  _djEq(atTime, now, g) {
    const { eqlo, eqmid, eqhi } = this.dj;
    const on = (Math.abs(eqlo - 1) + Math.abs(eqmid - 1) + Math.abs(eqhi - 1)) > 0.001;
    if (!this.djEq && !on) return;
    if (!this.djEq) this.djEq = this._djEqBuild();
    const eq = this.djEq;
    rampParam(eq.lo.gain, eqlo, atTime, now, g ?? DJ_GLIDE_SEC);
    rampParam(eq.mid.gain, eqmid, atTime, now, g ?? DJ_GLIDE_SEC);
    rampParam(eq.hi.gain, eqhi, atTime, now, g ?? DJ_GLIDE_SEC);
    rampParam(eq.wet.gain, on ? 1 : 0, atTime, now, DJ_XFADE_SEC);
    rampParam(eq.dry.gain, on ? 0 : 1, atTime, now, DJ_XFADE_SEC);
  }

  _djEqBuild() {
    const ctx = this.ctx;
    const nodes = [];
    const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; nodes.push(n); return n; };
    const bq = (type, hz) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = hz;
      b.Q.value = BUTTERWORTH_Q_DB;
      nodes.push(b);
      return b;
    };
    // Two Butterworths in a row: one side of a Linkwitz-Riley crossover.
    const lr4 = (from, type, hz) => {
      const a = bq(type, hz);
      const b = bq(type, hz);
      from.connect(a);
      a.connect(b);
      return b;
    };
    const lo = gain(1);
    const mid = gain(1);
    const hi = gain(1);
    const wet = gain(0);
    const dry = gain(1);
    const low = lr4(this.djTrim, 'lowpass', DJ_XO_LOW);
    const upper = lr4(this.djTrim, 'highpass', DJ_XO_LOW);
    lr4(upper, 'lowpass', DJ_XO_HIGH).connect(mid);
    lr4(upper, 'highpass', DJ_XO_HIGH).connect(hi);
    lr4(low, 'lowpass', DJ_XO_HIGH).connect(lo);
    lr4(low, 'highpass', DJ_XO_HIGH).connect(lo);
    for (const band of [lo, mid, hi]) band.connect(wet);
    try { this.djTrim.disconnect(this.djMid); } catch { /* not connected */ }
    this.djTrim.connect(dry);
    dry.connect(this.djMid);
    wet.connect(this.djMid);
    return { lo, mid, hi, wet, dry, nodes };
  }

  /**
   * The one-knob filter: `djf` 0 is untouched, negative sweeps a low-pass down from 18 kHz toward
   * 20 Hz, positive a high-pass up from 20 Hz toward 18 kHz, both exponential. `djres` is its
   * resonance, a control of its own (neutral 0, a plain two-pole). Crossfaded out at the center.
   */
  _djFilter(atTime, now, g) {
    const v = this.dj.djf;
    const on = Math.abs(v) > 0.005;
    if (!this.djFilter && !on) return;
    if (!this.djFilter) this.djFilter = this._djFilterBuild();
    const f = this.djFilter;
    const lpHz = Math.min(18000, Math.max(20, 18000 * 900 ** Math.min(0, v)));
    const hpHz = Math.min(18000, Math.max(20, 20 * 900 ** Math.max(0, v)));
    // rq is 1/Q: 1 is a flat two-pole, 0.38 about +8 dB at the corner. In decibels for Web Audio.
    const rq = 1 - 0.62 * this.dj.djres;
    const qDb = Math.max(0, -20 * Math.log10(rq));
    glideFrequency(f.lp.frequency, lpHz, atTime, now, g ?? DJ_FILTER_GLIDE_SEC);
    glideFrequency(f.hp.frequency, hpHz, atTime, now, g ?? DJ_FILTER_GLIDE_SEC);
    rampParam(f.lp.Q, qDb, atTime, now, g ?? DJ_GLIDE_SEC);
    rampParam(f.hp.Q, qDb, atTime, now, g ?? DJ_GLIDE_SEC);
    rampParam(f.wet.gain, on ? 1 : 0, atTime, now, DJ_XFADE_SEC);
    rampParam(f.dry.gain, on ? 0 : 1, atTime, now, DJ_XFADE_SEC);
  }

  _djFilterBuild() {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 18000;
    lp.Q.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 20;
    hp.Q.value = 0;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const dry = ctx.createGain();
    dry.gain.value = 1;
    try { this.djMid.disconnect(this.djLive); } catch { /* not connected */ }
    this.djMid.connect(lp);
    lp.connect(hp);
    hp.connect(wet);
    wet.connect(this.djLive);
    this.djMid.connect(dry);
    dry.connect(this.djLive);
    return { lp, hp, wet, dry, nodes: [lp, hp, wet, dry] };
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

  /**
   * The pattern is about to drive this parameter: keeps what it reads now, so that releaseParam
   * can put it back when the pattern stops. A parameter already held keeps its first reading -
   * a second hold is a fresh Scheduler on the same track, not a new starting point.
   */
  holdParam(slotIndex, name) {
    const slot = this.slots.get(slotIndex);
    const found = slot?.paramFor(name);
    if (!found) return false;
    if (!slot.resting.has(found.param.id)) slot.resting.set(found.param.id, slot.values[found.param.id]);
    return true;
  }

  /** The pattern is done with this parameter: back to what it was when the pattern took it. */
  releaseParam(slotIndex, name, atTime, now, glide) {
    const slot = this.slots.get(slotIndex);
    const found = slot?.paramFor(name);
    if (!found || !slot.resting.has(found.param.id)) return false;
    const value = slot.resting.get(found.param.id);
    slot.resting.delete(found.param.id);
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
    // A choice, a stepped control or a switch STEPS, whoever sets it. The pattern's poll and a
    // named curve being loaded pass no glide, and the default one ramped a mode control from slot
    // 19 to slot 1 through every setting between - each played for a block, empty drawn slots as a
    // hard clip, which was the crack heard on every curve change.
    const stepped = !!(param.options || param.step || param.ui === 'toggle');
    if (audioParam) rampParam(audioParam, normalize(param, value), atTime, now, stepped ? 0 : glide);
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
    for (const point of this.sendPoints.values()) for (const node of [point.mon, point.fader]) { try { node.disconnect(); } catch { /* already detached */ } }
    this.sendPoints.clear();
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
    // So are the pan and the wet controls, and the crossovers.
    this.routeBuild?.teardown();
    this._keepCrossovers([]);
    for (const law of [...this.routePanLaws.values()].flat()) { try { law.disconnect(); } catch { /* already detached */ } }
    for (const { ctl, scale, shaper } of this.heldDrives.values()) {
      try { ctl.stop(); } catch { /* already stopped */ }
      for (const n of [ctl, scale, shaper]) { try { n.disconnect(); } catch { /* already detached */ } }
    }
    this.heldDrives.clear();
    for (const ctl of [this.panCtl, ...this.wetControls.values(), ...this.routeControls.values(), ...this.grainControls.values()]) {
      try { ctl.stop(); } catch { /* already stopped */ }
      try { ctl.disconnect(); } catch { /* already detached */ }
    }
    this.wetControls.clear();
    this.routeControls.clear();
    this.grainControls.clear();
    for (const node of [...(this.djEq?.nodes ?? []), ...(this.djFilter?.nodes ?? [])]) {
      try { node.disconnect(); } catch { /* already detached */ }
    }
    for (const node of [this.djTrim, this.djMid, this.djLive, this.cueGain, this.meterGain, this.fxDirect, this.faderGain, this.deckGain, this.sendMain, this.sendFader, this.fx?.send, this.fx?.fader]) {
      try { node?.disconnect(); } catch { /* already detached */ }
    }
    try {
      this.input.disconnect();
      this.chainIn.disconnect();
      this.postGain.disconnect();
      this.panner.disconnect();
      this.monGate.disconnect();
      this.merge.disconnect();
      this.split.disconnect();
      this.dryGain.disconnect();
    } catch { /* already detached */ }
  }
}
