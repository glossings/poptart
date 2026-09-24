// An ADSR envelope in SECONDS.
//
// Seconds, not a normalized 0..1 depth, because that is the decision poptart already made
// everywhere else: `.attack(0.01)` is ten milliseconds whatever the tempo is doing, and a
// pattern that changes tempo does not change its own attack times. `envscale` multiplies all
// four stages at once for the cases where somebody does want the envelope to follow the tempo.
//
// A `curve` of 0 is a straight line, negative values move fast and then level off (what an
// amplitude envelope usually wants), positive values hold back and then rush. That reading is
// the same on every stage, rising or falling - see the note in the attack.
//
// EACH STAGE HAS ITS OWN. One curve for all three is the usual shortcut and it is wrong in a
// specific, audible way: the shape an attack wants and the shape a release wants are opposite
// ends of the same control. A plucked sound is an instant attack and a long exponential decay,
// which is a hard curve on the decay and none on the attack; a swell is the reverse. With one
// control you pick which of the two to get right. `set({ curve })` still sets all three at
// once, which is what a device with one knob passes.

/** Below this, a stage is instant rather than a ramp nobody can hear. */
const MIN_STAGE_SEC = 1e-5;

/** Where the curve formula stops being worth its exponentials and a line will do. */
const CURVE_EPSILON = 1e-3;

/**
 * Shapes a 0..1 ramp. `curve` 0 is linear; the sign says which end the movement bunches at.
 * The formula is continuous through 0 - the guard is there because the exact expression divides
 * by zero, not because the shape jumps.
 */
export function curveShape(t, curve) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (Math.abs(curve) < CURVE_EPSILON) return t;
  return (1 - Math.exp(t * curve)) / (1 - Math.exp(curve));
}

export const STAGE = Object.freeze({ IDLE: 0, ATTACK: 1, DECAY: 2, SUSTAIN: 3, RELEASE: 4 });

/**
 * One envelope generator.
 *
 * Deliberately allocation-free after construction and driven one sample at a time: it lives in
 * the audio thread, and it is written the way it would have to be written to port to a
 * SuperCollider UGen later.
 *
 * The release always starts from wherever the envelope actually is, so a note released during
 * its attack fades from the level it reached rather than jumping to the sustain level first.
 */
export class Adsr {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.attack = 0.01;
    this.decay = 0.1;
    this.sustain = 0.7;
    this.release = 0.2;
    this.attackCurve = -4;
    this.decayCurve = -4;
    this.releaseCurve = -4;
    this.stage = STAGE.IDLE;
    this.value = 0;
    this.stagePos = 0;      // 0..1 through the current stage
    this.stageFrom = 0;     // the level the current stage started at
  }

  /**
   * `curve` sets all three stages, for a device that offers one control; `attackCurve`,
   * `decayCurve` and `releaseCurve` set them one at a time and win over it.
   */
  set({ attack, decay, sustain, release, curve, attackCurve, decayCurve, releaseCurve, scale = 1 }) {
    if (attack !== undefined) this.attack = Math.max(0, attack) * scale;
    if (decay !== undefined) this.decay = Math.max(0, decay) * scale;
    if (sustain !== undefined) this.sustain = Math.min(1, Math.max(0, sustain));
    if (release !== undefined) this.release = Math.max(0, release) * scale;
    if (curve !== undefined) {
      this.attackCurve = curve;
      this.decayCurve = curve;
      this.releaseCurve = curve;
    }
    if (attackCurve !== undefined) this.attackCurve = attackCurve;
    if (decayCurve !== undefined) this.decayCurve = decayCurve;
    if (releaseCurve !== undefined) this.releaseCurve = releaseCurve;
  }

  /** Starts a note. `retrigger` keeps the current level so a restart does not click to zero. */
  gateOn(retrigger = true) {
    this.stageFrom = retrigger ? this.value : 0;
    if (!retrigger) this.value = 0;
    this.stage = STAGE.ATTACK;
    this.stagePos = 0;
  }

  /** Releases a note from wherever the envelope currently is. */
  gateOff() {
    if (this.stage === STAGE.IDLE) return;
    this.stageFrom = this.value;
    this.stage = STAGE.RELEASE;
    this.stagePos = 0;
  }

  /** Silences the envelope outright - a voice being stolen, not a note ending. */
  reset() {
    this.stage = STAGE.IDLE;
    this.value = 0;
    this.stagePos = 0;
    this.stageFrom = 0;
  }

  get active() {
    return this.stage !== STAGE.IDLE;
  }

  /** One sample. Returns the envelope's level, 0..1. */
  next() {
    switch (this.stage) {
      case STAGE.ATTACK: {
        if (this.attack < MIN_STAGE_SEC) {
          this.value = 1;
          this.stage = STAGE.DECAY;
          this.stagePos = 0;
          this.stageFrom = 1;
          break;
        }
        this.stagePos += 1 / (this.attack * this.sampleRate);
        if (this.stagePos >= 1) {
          this.value = 1;
          this.stage = STAGE.DECAY;
          this.stagePos = 0;
          this.stageFrom = 1;
        } else {
          // An attack rises toward 1 from wherever it started, so a retrigger mid-note does not
          // drop the level first.
          //
          // The curve is NOT negated here, though it used to be. The negation made a negative
          // curve mean "fast then level off" on the decay and "hold back then rush" on the
          // attack - opposite readings of one number, which was survivable while a single knob
          // set all three and is not now that each stage has its own. One sign, one meaning.
          this.value = this.stageFrom + (1 - this.stageFrom) * curveShape(this.stagePos, this.attackCurve);
        }
        break;
      }
      case STAGE.DECAY: {
        if (this.decay < MIN_STAGE_SEC) {
          this.value = this.sustain;
          this.stage = STAGE.SUSTAIN;
          break;
        }
        this.stagePos += 1 / (this.decay * this.sampleRate);
        if (this.stagePos >= 1) {
          this.value = this.sustain;
          this.stage = STAGE.SUSTAIN;
        } else {
          this.value = this.stageFrom + (this.sustain - this.stageFrom) * curveShape(this.stagePos, this.decayCurve);
        }
        break;
      }
      case STAGE.SUSTAIN:
        this.value = this.sustain;
        break;
      case STAGE.RELEASE: {
        if (this.release < MIN_STAGE_SEC) {
          this.value = 0;
          this.stage = STAGE.IDLE;
          break;
        }
        this.stagePos += 1 / (this.release * this.sampleRate);
        if (this.stagePos >= 1) {
          this.value = 0;
          this.stage = STAGE.IDLE;
        } else {
          this.value = this.stageFrom * (1 - curveShape(this.stagePos, this.releaseCurve));
        }
        break;
      }
      default:
        this.value = 0;
    }
    return this.value;
  }
}
