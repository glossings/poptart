// The Acid synth: one voice of the classic acid bassline machine, modeled from its circuit.
//
// Translated from web-engine/src/devices/acid.mjs, which has the account of each part of the
// circuit: the saw and the square its shaper makes, the diode ladder with its feedback
// highpass, the two envelopes, the accent sweep, the slide and the output coupling. The same
// state, the same arithmetic in the same order, in double; the parity test holds the two
// together. The continuous controls are read per sample (see own/pd-own.h); Decay, Slide and
// Sweep once a call, where it ends.

#include "own/pd-own.h"
#include "own/dsp/adsr.h"
#include "own/dsp/blep.h"
#include "own/dsp/analog.h"
#include "pd-own-ids.h"

#include <cmath>
#include <cstring>

namespace pd_Acid {

namespace ids = pd_ids::Acid;
using namespace pd_own;

constexpr double kCutoffMin = 314;
constexpr double kCutoffMax = 2394;
constexpr double kAccentFrom = 0.9;
/** Compared as a MIDI velocity, as acid.mjs's ACID_ACCENT_STEP. */
const double kAccentStep = jsRound(kAccentFrom * 127);
constexpr double kAccentDecay = 0.2;
constexpr double kDecaySpans = 3;

constexpr double kShaperGain = 69.98;
constexpr double kShaperOffset = 4.37;
constexpr double kShaperHp = 54;
constexpr double kSquareLevel = 0.5;
constexpr double kTop = 0.45;

constexpr double kFeedback = 17;
constexpr double kSkew = 3;
constexpr double kFeedbackHp = 150;
constexpr double kTune = 1.4132;
// Character at one: buffered equal stages, a loop gain of one round them outside the highpass,
// tuned so the corner lands on the cutoff (acid.mjs's ACID_SHARP_TUNE).
constexpr double kSharpTune = 1.0225978666301174;
constexpr double kSharpBase = 1;
constexpr double kSharpFeedback = 4;
constexpr double kLowest = 20;
constexpr double kHighest = 0.45;
constexpr double kAccentOctaves = 2.5;
constexpr double kFlush = 1e-20;

constexpr double kAmpAttack = 0.003;
constexpr double kAmpDecay = 1.23;
constexpr double kGateHold = 0.008;
constexpr double kGateFall = 0.008;
constexpr double kEnvToAmp = 0.45;
constexpr double kAccentToAmp = 1;

constexpr double kSweepFeed = 47;
constexpr double kSweepPot = 100;
constexpr double kSweepLoad = 100;
constexpr double kSweepCap = 1;
constexpr double kSweepPotMin = 0.5;
constexpr double kSweepFull = (1 / kSweepFeed) / (1 / kSweepFeed + 1 / kSweepLoad);

constexpr double kInputHp = 44;
constexpr double kOutputAp = 14;
constexpr double kOutputHp = 24;
constexpr double kNotch = 7.5;
constexpr double kNotchQ = 0.3;

constexpr double kDriveGain = 15;
constexpr double kOutputGain = 0.34;
constexpr double kTail = 0.25;

constexpr double kPi = 3.141592653589793;

// --- the filter -------------------------------------------------------------------------------

/** The diode ladder with its feedback highpass, at four times the rate (acid.mjs's AcidLadder). */
struct Ladder {
  double sampleRate = 48000.0;
  double rate = 192000.0;
  double s[4] = {};
  double v[5] = {};
  double hp = 0;
  double g = 0;
  double k = 0;
  double base = 0;
  double load = 1;
  double end = 2;
  double gh = 0;
  AnalogHalfband<8> upA, downA;
  AnalogHalfband<4> upB, downB;

  void init(double sr) {
    sampleRate = sr;
    rate = sr * 4;
    gh = std::tan((kPi * kFeedbackHp) / rate);
    upA.init(kAnalogHalfbandA);
    downA.init(kAnalogHalfbandA);
    upB.init(kAnalogHalfbandB);
    downB.init(kAnalogHalfbandB);
    reset();
  }

  void reset() {
    for (double& x : s) x = 0;
    for (double& x : v) x = 0;
    hp = 0;
    upA.reset();
    downA.reset();
    upB.reset();
    downB.reset();
  }

  void set(double hz, double feedback, double character, double r) {
    const double f = std::fmin(sampleRate * kHighest, std::fmax(kLowest, hz));
    const double w = std::tan((kPi * f) / rate);
    if (character > 0) {
      const double sharp = std::log(kSharpTune) * (1 - r);
      g = w * std::exp(-std::log(kTune) * (1 - character) + sharp * character);
    } else {
      g = w / kTune;
    }
    k = feedback;
    base = kSharpBase * character;
    load = 1 - character;
    end = 2 - character;
  }

  double process(double x) {
    const double a = upA.path(x, 0);
    const double b = upA.path(x, 1);
    const double a0 = upB.path(a, 0);
    const double a1 = upB.path(a, 1);
    const double b0 = upB.path(b, 0);
    const double b1 = upB.path(b, 1);
    const double ya0 = step(a0);
    const double ya1 = step(a1);
    const double yb0 = step(b0);
    const double yb1 = step(b1);
    const double ya = 0.5 * (downB.path(ya1, 0) + downB.path(ya0, 1));
    const double yb = 0.5 * (downB.path(yb1, 0) + downB.path(yb0, 1));
    const double y = 0.5 * (downA.path(yb, 0) + downA.path(ya, 1));
    for (int i = 0; i < 4; ++i) if (s[i] > -kFlush && s[i] < kFlush) s[i] = 0;
    if (hp > -kFlush && hp < kFlush) hp = 0;
    return y;
  }

  double step(double x) {
    const double lg = load * g;
    const double e1 = analogClipGain(v[0] - v[1]);
    const double e2 = analogClipGain(v[1] - v[2]);
    const double e3 = analogClipGain(v[2] - v[3]);
    const double e4 = analogClipGain(v[3] - v[4]);
    const double g4 = end * g * e4;
    const double a4 = g4 / (1 + g4);
    const double b4 = s[3] / (1 + g4);
    const double d3 = 1 + g * e3 + lg * e4 - lg * e4 * a4;
    const double a3 = (g * e3) / d3;
    const double b3 = (s[2] + lg * e4 * b4) / d3;
    const double d2 = 1 + g * e2 + lg * e3 - lg * e3 * a3;
    const double a2 = (g * e2) / d2;
    const double b2 = (s[1] + lg * e3 * b3) / d2;
    const double d1 = 1 + g * e1 + lg * e2 - lg * e2 * a2;
    const double a1 = (g * e1) / d1;
    const double b1 = (s[0] + lg * e2 * b2) / d1;
    const double A = a4 * a3 * a2 * a1;
    const double B = a4 * (a3 * (a2 * b1 + b2) + b3) + b4;
    const double h = 1 / (1 + gh);
    const double k0 = base;
    const double u = (x - k0 * B - k * h * (B - hp)) / (1 + k0 * A + k * h * A);
    const double y1 = a1 * u + b1;
    const double y2 = a2 * y1 + b2;
    const double y3 = a3 * y2 + b3;
    const double y4 = a4 * y3 + b4;
    s[0] = 2 * y1 - s[0];
    s[1] = 2 * y2 - s[1];
    s[2] = 2 * y3 - s[2];
    s[3] = 2 * y4 - s[3];
    const double low = y4 - h * (y4 - hp);
    hp = 2 * low - hp;
    v[0] = u; v[1] = y1; v[2] = y2; v[3] = y3; v[4] = y4;
    return y4 * (1 + k0);
  }
};

/** The loop gain through the highpass at the top of Resonance (acid.mjs's acidFeedback). */
inline double feedbackFor(double character) {
  if (!(character > 0)) return kFeedback;
  return std::exp(std::log(kFeedback) * (1 - character) + std::log(kSharpFeedback) * character)
    - kSharpBase * character;
}

/** The output's makeup (acid.mjs's acidMakeup). */
constexpr double kMakeup = 0.255;
constexpr double kMakeupOctave = 0.1;
constexpr double kMakeupHz = 730;
constexpr double kMakeupLeast = 0.05;
constexpr double kMakeupMost = 0.45;
constexpr double kMakeupSharp = 0.27;
constexpr double kMakeupTop = 0.09;
inline double makeupFor(double r, double character, double k, double hz) {
  const double low = std::fmin(kMakeupMost, std::fmax(kMakeupLeast, kMakeup + kMakeupOctave * std::log2(hz / kMakeupHz)));
  const double a = (1 - character) * low + character * kMakeupSharp - kMakeupTop * r * character * character;
  return 1 + a * k;
}

inline double skew(double resonance) {
  const double r = std::fmin(1.0, std::fmax(0.0, resonance));
  return (1 - std::exp(-kSkew * r)) / (1 - std::exp(-kSkew));
}

// --- the coupling -----------------------------------------------------------------------------

struct Highpass {
  double b = 1, a = 0, x1 = 0, y1 = 0;
  void init(double hz, double sr) {
    const double t = std::tan((kPi * hz) / sr);
    b = 1 / (1 + t);
    a = (1 - t) / (1 + t);
    reset();
  }
  void reset() { x1 = 0; y1 = 0; }
  double next(double x) {
    const double y = b * (x - x1) + a * y1;
    x1 = x;
    y1 = y > -kFlush && y < kFlush ? 0 : y;
    return y;
  }
};

struct Allpass {
  double c = 0, x1 = 0, y1 = 0;
  void init(double hz, double sr) {
    const double t = std::tan((kPi * hz) / sr);
    c = (t - 1) / (t + 1);
    reset();
  }
  void reset() { x1 = 0; y1 = 0; }
  double next(double x) {
    const double y = c * x + x1 - c * y1;
    x1 = x;
    y1 = y > -kFlush && y < kFlush ? 0 : y;
    return y;
  }
};

struct Notch {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  void init(double hz, double q, double sr) {
    const double w = (2 * kPi * hz) / sr;
    const double alpha = std::sin(w) / (2 * q);
    const double cs = std::cos(w);
    const double a0 = 1 + alpha;
    b0 = 1 / a0;
    b1 = (-2 * cs) / a0;
    b2 = 1 / a0;
    a1 = (-2 * cs) / a0;
    a2 = (1 - alpha) / a0;
    reset();
  }
  void reset() { x1 = 0; x2 = 0; y1 = 0; y2 = 0; }
  double next(double x) {
    const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y > -kFlush && y < kFlush ? 0 : y;
    return y;
  }
};

inline double square(double h, double offset) { return analogClip(kShaperGain * h + offset); }

// --- the synth --------------------------------------------------------------------------------

using Base = pd_own::Device<ids::kCount, 2>;

struct Device : Base {
  BlepLine line;
  Ladder ladder;
  Highpass shaperHp, inputHp, outputHp;
  Allpass outputAp;
  Notch notch;

  double decayK = 1, accentK = 1, ampK = 1;
  double attackStep = 0, gateUp = 0, gateDown = 0;
  int holdFor = 0, tailFor = 0;
  double slideK = 1, capacitor = kSweepCap, dtMs = 0;
  double bend = 0;

  double note = -1;
  double pitch = 60, target = 60;
  bool sliding = false;
  double phase = 0;
  bool gate = false;
  double gain = 0;
  int hold = 0, tail = 0;
  bool awake = false, attacking = false;
  double amp = 0, env = 0;
  bool accented = false;
  double accentLevel = 0;
  double cap = 0, sweep = 0;

  struct Event { int at; int kind; double note; double velocity; bool slide; };
  Event events[64];
  int eventCount = 0;

  void pd_init(double sr) {
    sampleRate = sr;
    line.reset();
    ladder.init(sr);
    shaperHp.init(kShaperHp, sr);
    inputHp.init(kInputHp, sr);
    outputAp.init(kOutputAp, sr);
    outputHp.init(kOutputHp, sr);
    notch.init(kNotch, kNotchQ, sr);
    decayK = 1;
    accentK = std::exp(-kDecaySpans / (kAccentDecay * sr));
    ampK = std::exp(-1 / (kAmpDecay * sr));
    attackStep = 1 / (kAmpAttack * sr);
    gateUp = 1 / (kAmpAttack * sr);
    gateDown = 1 / (kGateFall * sr);
    holdFor = jsRoundInt(kGateHold * sr);
    tailFor = jsRoundInt(kTail * sr);
    slideK = 1;
    capacitor = kSweepCap;
    dtMs = 1000 / sr;
    bend = 0;
    note = -1; pitch = 60; target = 60; sliding = false; phase = 0;
    gate = false; gain = 0; hold = 0; tail = 0; awake = false; attacking = false;
    amp = 0; env = 0; accented = false; accentLevel = 0; cap = 0; sweep = 0;
    eventCount = 0;
  }

  void pd_note_on(float n, float velocity) { pd_note_on_at(n, velocity, 0); }
  void pd_note_off(float n) { pd_note_off_at(n, 0); }
  void pd_note_on_at(float n, float velocity, int offset) {
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 1, n, velocity, false };
  }
  void pd_note_slide(float n, float velocity) { pd_note_slide_at(n, velocity, 0); }
  void pd_note_slide_at(float n, float velocity, int offset) {
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 1, n, velocity, true };
  }
  void pd_note_off_at(float n, int offset) {
    if (n < 0) {
      // Every note off at once.
      eventCount = 0;
      gateOff();
      return;
    }
    if (eventCount < 64) events[eventCount++] = { offset > 0 ? offset : 0, 0, n, 0, false };
  }

  void pd_bend(float semitones) { bend = isPlayable(semitones) ? semitones : 0.0; }

  bool sounding() const { return gain > 0 || gate; }

  void startNote(double n, double velocity, bool slide) {
    const bool acc = jsRound(velocity * 127) >= kAccentStep;
    accented = acc;
    accentLevel = acc ? velocity : 0;
    target = n;
    note = n;
    if (slide && sounding()) {
      sliding = true;
      gate = true;
      hold = 0;
      return;
    }
    if (!awake) wake();
    sliding = false;
    pitch = n;
    amp *= gain;
    gain = 1;
    gate = true;
    hold = 0;
    attacking = true;
    env = 1;
  }

  void stopNote(double n) { if (n == note) gateOff(); }

  void gateOff() {
    if (!gate) return;
    gate = false;
    hold = holdFor;
  }

  void wake() {
    awake = true;
    line.reset();
    ladder.reset();
    shaperHp.reset();
    inputHp.reset();
    outputAp.reset();
    outputHp.reset();
    notch.reset();
    phase = 0;
    amp = 0;
    gain = 0;
  }

  /** A control's value at the END of the call, as the browser's `endOf`. */
  double last(int id, int frames) const {
    return isMoving(id) && frames > 0 ? static_cast<double>(pb[id][frames - 1]) : static_cast<double>(p[id]);
  }

  void prepare(int frames) {
    const double sr = sampleRate;
    decayK = std::exp(-kDecaySpans / (std::fmax(0.01, last(ids::decay, frames)) * sr));
    slideK = 1 - std::exp(-3 / (std::fmax(0.001, last(ids::slide, frames)) * sr));
    capacitor = kSweepCap * std::fmax(0.01, last(ids::sweep, frames));
  }

  void control(double resonance, double accentKnob) {
    env *= accented ? accentK : decayK;
    if (env < kFlush) env = 0;
    if (attacking) {
      amp += attackStep;
      if (amp >= 1) { amp = 1; attacking = false; }
    } else {
      amp *= ampK;
      if (amp < kFlush) amp = 0;
    }
    if (gate) {
      gain = std::fmin(1.0, gain + gateUp);
    } else if (hold > 0) {
      hold--;
    } else if (gain > 0) {
      gain = std::fmax(0.0, gain - gateDown);
      if (gain == 0) tail = tailFor;
    }
    const double vin = accented ? accentKnob * accentLevel * env : 0;
    const double pot = std::fmax(kSweepPotMin, kSweepPot * std::fmin(1.0, std::fmax(0.0, resonance)));
    const double beta = dtMs / (capacitor * pot);
    const double gp = 1 / (pot * (1 + beta));
    const double gs = 1 / kSweepFeed;
    const double gl = 1 / kSweepLoad;
    double va = (gs * vin + gp * cap) / (gs + gl + gp);
    if (va > vin) va = (gp * cap) / (gl + gp);
    cap = (cap + beta * va) / (1 + beta);
    if (cap < kFlush) cap = 0;
    sweep = cap / kSweepFull;
  }

  void render(float* outl, float* outr, int count, int offset) {
    const double sr = sampleRate;
    double y = 0;
    for (int i = 0; i < count; ++i) {
      const int j = offset + i;
      const double resonance = ctl(ids::resonance, j);
      control(resonance, ctl(ids::accent, j));
      if (!awake) continue;

      if (sliding && pitch != target) {
        pitch += (target - pitch) * slideK;
        if (std::fabs(target - pitch) < 1e-6) pitch = target;
      }
      const double dt = std::fmin(kTop, midiToHz(pitch + ctl(ids::tuning, j) + bend) / sr);

      const double w = std::fmin(1.0, std::fmax(0.0, ctl(ids::waveform, j)));
      const double offsetV = kShaperOffset * (1 + 2 * std::fmin(1.0, std::fmax(-1.0, ctl(ids::shape, j))));
      double ph = phase + dt;
      bool wrapped = false;
      if (ph >= 1) { ph -= 1; wrapped = true; }
      phase = ph;
      const double saw = 2 * ph - 1;
      const double h = shaperHp.next(saw);
      const double sq = square(h, offsetV);
      if (wrapped) {
        const double before = square(h + 2 * shaperHp.b, offsetV);
        line.jump(ph / dt, (1 - w) * -2 + w * kSquareLevel * (sq - before));
      }
      const double x = inputHp.next(line.push((1 - w) * saw + w * kSquareLevel * sq));

      const double cutoff = ctl(ids::cutoff, j);
      const double c = std::log(std::fmin(kCutoffMax, std::fmax(kCutoffMin, cutoff)) / kCutoffMin)
        / std::log(kCutoffMax / kCutoffMin);
      const double e = std::fmin(1.0, std::fmax(0.0, ctl(ids::envmod, j)));
      const double scale = (1 - c) * (3.774 * e + 0.737) + c * (4.195 * e + 0.864);
      const double floor = 0.0483 * c + 0.2944;
      const double octaves = scale * (env - floor) + kAccentOctaves * sweep;
      const double r = skew(resonance);
      const double character = std::fmin(1.0, std::fmax(0.0, ctl(ids::character, j)));
      const double k = feedbackFor(character) * r;
      const double hz = cutoff * std::pow(2.0, octaves);
      ladder.set(hz, k, character, r);
      const double makeup = makeupFor(r, character, k, hz);
      const double filtered = ladder.process(x) * makeup;

      const double level = gain * amp * (1 + kEnvToAmp * env + kAccentToAmp * sweep);
      double amped = filtered * level;
      const double drive = ctl(ids::drive, j);
      if (drive > 0) {
        const double push = 1 + kDriveGain * drive;
        amped = analogClip(amped * push) / std::sqrt(push);
      }
      y = notch.next(outputHp.next(outputAp.next(amped)));
      const double out = y * ctl(ids::volume, j) * kOutputGain;
      // Summed in double and rounded once, as `outL[i] += out` on a Float32Array is.
      outl[i] = static_cast<float>(static_cast<double>(outl[i]) + out);
      outr[i] = static_cast<float>(static_cast<double>(outr[i]) + out);

      if (tail > 0 && --tail == 0 && !gate && gain == 0) awake = false;
    }
    if (!isPlayable(y)) {
      line.reset();
      ladder.reset();
    }
  }

  void pd_process(int frames) {
    prepare(frames);
    // In time order, ties in arrival order - a stable sort, as the browser's Array.sort is.
    for (int i = 1; i < eventCount; ++i) {
      const Event e = events[i];
      int j = i - 1;
      while (j >= 0 && events[j].at > e.at) { events[j + 1] = events[j]; --j; }
      events[j + 1] = e;
    }
    float* outl = outL();
    float* outr = outR();
    std::memset(outl, 0, sizeof(float) * static_cast<size_t>(frames));
    std::memset(outr, 0, sizeof(float) * static_cast<size_t>(frames));
    int at = 0;
    int next = 0;
    while (at < frames) {
      while (next < eventCount && events[next].at <= at) {
        const Event& ev = events[next++];
        if (ev.kind == 1) startNote(ev.note, ev.velocity, ev.slide);
        else stopNote(ev.note);
      }
      const int until = next < eventCount && events[next].at < frames ? events[next].at : frames;
      const int n = until - at;
      if (n > 0) render(outl + at, outr + at, n, at);
      at = until;
    }
    int kept = 0;
    for (int i = next; i < eventCount; ++i) {
      Event ev = events[i];
      ev.at = ev.at - frames > 0 ? ev.at - frames : 0;
      events[kept++] = ev;
    }
    eventCount = kept;
  }
};

}  // namespace pd_Acid

extern "C" PdAny* pd_make_Acid() { return new PdAdapter<pd_Acid::Device>(); }
